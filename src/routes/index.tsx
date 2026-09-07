import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { TooltipProvider } from "@/components/ui/tooltip"
import { toast } from "sonner"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Video01Icon,
  PlayIcon,
  Download01Icon,
  Folder01Icon,
  Delete02Icon,
  SparklesIcon,
  Film01Icon,
  Settings01Icon,
  CheckmarkCircle02Icon,
  Layers01Icon,
  Alert02Icon,
  Image01Icon,
} from "@hugeicons/core-free-icons"
import { cleanPspTitle, fmtTime, type ConvertSettings, type ProgressStats, type PresetName } from "@/convert"

export const Route = createFileRoute("/")({
  component: ConverterPage,
})

export interface JobAudioTrack {
  index: number
  label: string
  language?: string
  codec?: string
}

export interface JobItem {
  id: number
  file: File
  files?: File[]
  isMerge?: boolean
  customTitle: string
  status: "queued" | "converting" | "done" | "failed" | "cancelled"
  progress: number
  note: string
  stats?: ProgressStats
  dims?: string
  outSize?: number
  outName?: string
  profileBadge?: { text: string; cls: string }
  buffer?: ArrayBuffer
  thmBuffer?: ArrayBuffer
  url?: string
  thmUrl?: string
  savedDirect?: boolean
  audioTracks?: JobAudioTrack[]
  selectedAudioTrack?: number
  duration?: number
}

interface WorkerSlot {
  worker: Worker
  busy: boolean
  jobId: number | null
}

function ConverterPage() {
  const [dragActive, setDragActive] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  // Settings
  const [preset, setPreset] = React.useState<PresetName>("go")
  const [videoBitrate, setVideoBitrate] = React.useState<string>("800000")
  const [audioBitrate, setAudioBitrate] = React.useState<string>("128000")
  const [encoderMode] = React.useState<"turbo" | "auto">("turbo")
  const [lcdBoost, setLcdBoost] = React.useState<string>("off")
  const [pipelineMode, setPipelineMode] = React.useState<string>("segmented")

  // Disk streaming / PSP memory stick folder
  const [dirHandle, setDirHandle] = React.useState<FileSystemDirectoryHandle | null>(null)
  const [dirName, setDirName] = React.useState<string | null>(null)

  // Jobs queue
  const [jobs, setJobs] = React.useState<JobItem[]>([])
  const jobsRef = React.useRef<JobItem[]>([])
  jobsRef.current = jobs

  const nextIdRef = React.useRef(1)
  const poolRef = React.useRef<WorkerSlot[]>([])
  const dirHandleRef = React.useRef<FileSystemDirectoryHandle | null>(null)
  dirHandleRef.current = dirHandle

  // Current settings getter
  const getSettings = React.useCallback((): ConvertSettings => {
    return {
      preset,
      videoBitrate: Number(videoBitrate),
      audioBitrate: Number(audioBitrate),
      encoderMode,
      lcdBoost: lcdBoost === "on",
      tunables: pipelineMode === "segmented" ? { segs: 5 } : undefined,
    }
  }, [preset, videoBitrate, audioBitrate, encoderMode, lcdBoost, pipelineMode])

  const getSettingsRef = React.useRef(getSettings)
  getSettingsRef.current = getSettings

  // Initialize client worker pool
  React.useEffect(() => {
    const POOL_SIZE = Math.min(2, Math.max(1, (navigator.hardwareConcurrency || 4) >> 2))
    const pool: WorkerSlot[] = []

    for (let i = 0; i < POOL_SIZE; i++) {
      const slot: WorkerSlot = {
        worker: null as unknown as Worker,
        busy: false,
        jobId: null,
      }
      spawnWorker(slot)
      pool.push(slot)
    }
    poolRef.current = pool

    return () => {
      for (const slot of pool) {
        slot.worker?.terminate()
      }
    }
  }, [])

  const spawnWorker = (slot: WorkerSlot) => {
    try {
      const worker = new Worker(new URL("../worker.ts", import.meta.url), { type: "module" })
      slot.worker = worker
      worker.onmessage = (e: MessageEvent) => {
        void handleWorkerMessage(slot, e.data)
      }
      worker.onerror = (err) => {
        console.error("Worker error:", err)
        handleJobError(slot.jobId, err.message || "Worker crashed")
        freeSlot(slot)
      }
    } catch (err) {
      console.error("Failed to spawn worker:", err)
    }
  }

  const freeSlot = (slot: WorkerSlot) => {
    slot.busy = false
    slot.jobId = null
    pumpQueue()
  }

  const handleJobError = (jobId: number | null, errMsg: string) => {
    if (jobId === null) return
    setJobs((prev) =>
      prev.map((j) => (j.id === jobId ? { ...j, status: "failed", note: errMsg } : j))
    )
    toast.error(`Job failed: ${errMsg}`)
  }

  const handleWorkerMessage = async (slot: WorkerSlot, msg: any) => {
    const job = jobsRef.current.find((j) => j.id === msg.id)
    if (!job) {
      freeSlot(slot)
      return
    }

    if (msg.type === "progress") {
      setJobs((prev) =>
        prev.map((j) => {
          if (j.id !== msg.id) return j
          return {
            ...j,
            progress: msg.frac ?? j.progress,
            stats: msg.stats ?? j.stats,
            note: msg.label ?? j.note,
          }
        })
      )
      return
    }

    if (msg.type === "done" && msg.buffer) {
      const rawStem = job.customTitle || job.file.name.replace(/\.[^.]+$/, "") || "video"
      const cleanStem = rawStem.replace(/[^\w\s.-]/g, "").trim().replace(/\s+/g, "_")
      const outName = `${cleanStem}.mp4`
      const thmName = `${cleanStem}.thm`

      let savedDirect = false
      let url: string | undefined
      let thmUrl: string | undefined

      const currentDir = dirHandleRef.current
      if (currentDir) {
        try {
          const fileHandle = await currentDir.getFileHandle(outName, { create: true })
          const writable = await (fileHandle as any).createWritable()
          await writable.write(msg.buffer)
          await writable.close()

          if (msg.thmBuffer) {
            const thmHandle = await currentDir.getFileHandle(thmName, { create: true })
            const thmWritable = await (thmHandle as any).createWritable()
            await thmWritable.write(msg.thmBuffer)
            await thmWritable.close()
          }
          savedDirect = true
          toast.success(`Saved directly to ${outName}`)
        } catch (err) {
          console.warn("Direct save failed, falling back to blob:", err)
        }
      }

      if (!savedDirect) {
        const blob = new Blob([msg.buffer], { type: "video/mp4" })
        url = URL.createObjectURL(blob)
        if (msg.thmBuffer) {
          const thmBlob = new Blob([msg.thmBuffer], { type: "image/jpeg" })
          thmUrl = URL.createObjectURL(thmBlob)
        }
        toast.success(`Converted ${outName} ready!`)
      }

      setJobs((prev) =>
        prev.map((j) => {
          if (j.id !== msg.id) return j
          return {
            ...j,
            status: "done",
            progress: 1,
            note: msg.doneNote ?? "Complete",
            buffer: msg.buffer,
            thmBuffer: msg.thmBuffer,
            outName,
            url,
            thmUrl,
            savedDirect,
            dims: msg.dims,
            outSize: msg.outSize,
            profileBadge: {
              text: msg.profileText ?? "Baseline L2.1 ✓ PSP-ready",
              cls: msg.profileCls ?? "green",
            },
          }
        })
      )
      freeSlot(slot)
      return
    }

    if (msg.type === "failed") {
      setJobs((prev) =>
        prev.map((j) => {
          if (j.id !== msg.id) return j
          return {
            ...j,
            status: msg.cancelled ? "cancelled" : "failed",
            note: msg.error || "Failed",
          }
        })
      )
      if (msg.cancelled) {
        toast.info("Conversion cancelled")
      } else {
        toast.error(`Error: ${msg.error}`)
      }
      freeSlot(slot)
    }
  }

  const pumpQueue = React.useCallback(() => {
    const pool = poolRef.current
    if (!pool || pool.length === 0) return

    while (true) {
      const nextJob = jobsRef.current.find((j) => j.status === "queued")
      if (!nextJob) break
      const slot = pool.find((s) => !s.busy)
      if (!slot) break

      nextJob.status = "converting"
      slot.busy = true
      slot.jobId = nextJob.id

      setJobs((prev) =>
        prev.map((j) => (j.id === nextJob.id ? { ...j, status: "converting", note: "Starting…" } : j))
      )

      const settings = getSettingsRef.current()
      if (nextJob.isMerge && nextJob.files) {
        slot.worker.postMessage({
          type: "convert-merge",
          id: nextJob.id,
          files: nextJob.files,
          settings: {
            ...settings,
            title: nextJob.customTitle,
          },
        })
      } else {
        slot.worker.postMessage({
          type: "convert",
          id: nextJob.id,
          file: nextJob.file,
          settings: {
            ...settings,
            title: nextJob.customTitle,
            audioTrackIndex: nextJob.selectedAudioTrack,
          },
        })
      }
    }
  }, [])

  // Probe audio tracks and duration on file drop
  const probeJob = async (jobId: number, file: File) => {
    try {
      const { Input, BlobSource, ALL_FORMATS } = await import("mediabunny")
      const input = new Input({
        source: new BlobSource(file, { maxCacheSize: 8 * 1024 * 1024 }),
        formats: ALL_FORMATS,
      })
      const [aTracks, dur] = await Promise.all([
        input.getAudioTracks().catch(() => []) as Promise<any[]>,
        input.computeDuration().catch(() => 0),
      ])

      const audioTracks: JobAudioTrack[] = aTracks.map((t, idx) => ({
        index: idx,
        label: t.name || (t.language ? `Audio ${idx + 1} (${t.language})` : `Audio Track ${idx + 1}`),
        language: t.language,
        codec: t.codec,
      }))

      setJobs((prev) =>
        prev.map((j) => (j.id === jobId ? { ...j, duration: dur, audioTracks } : j))
      )
    } catch {
      // Probing is best-effort
    }
  }

  const addFiles = React.useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files).filter((f) => f.size > 0)
      if (list.length === 0) return

      const newJobs: JobItem[] = list.map((file) => {
        const id = nextIdRef.current++
        const cleanTitle = cleanPspTitle(file.name)
        void probeJob(id, file)
        return {
          id,
          file,
          customTitle: cleanTitle,
          status: "queued",
          progress: 0,
          note: "Queued",
        }
      })

      setJobs((prev) => [...prev, ...newJobs])
      setTimeout(pumpQueue, 50)
      toast.info(`Added ${newJobs.length} video${newJobs.length > 1 ? "s" : ""} to queue`)
    },
    [pumpQueue]
  )

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragActive(false)
    if (e.dataTransfer.files?.length) {
      addFiles(e.dataTransfer.files)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setDragActive(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setDragActive(false)
  }

  // Choose direct-to-disk directory
  const chooseDirectory = async () => {
    if (typeof window === "undefined" || !("showDirectoryPicker" in window)) {
      toast.error("File System Access API not supported in this browser.")
      return
    }
    try {
      const handle = await (window as any).showDirectoryPicker({ mode: "readwrite" })
      setDirHandle(handle)
      setDirName(handle.name)
      toast.success(`Disk streaming active: ${handle.name}`)
    } catch (err: any) {
      if (err.name !== "AbortError") {
        console.error("Directory pick failed:", err)
      }
    }
  }

  const clearDirectory = () => {
    setDirHandle(null)
    setDirName(null)
    toast.info("Switched to browser downloads")
  }

  // Merge queued files into a marathon video
  const mergeQueuedJobs = React.useCallback(() => {
    const queued = jobsRef.current.filter((j) => j.status === "queued" && !j.isMerge)
    if (queued.length < 2) {
      toast.error("Need at least 2 queued videos to merge into a Marathon.")
      return
    }

    const files = queued.map((j) => j.file)
    const firstTitle = queued[0].customTitle
    const marathonTitle = `${firstTitle} Marathon (${files.length} eps)`

    const id = nextIdRef.current++
    const marathonJob: JobItem = {
      id,
      file: files[0],
      files,
      isMerge: true,
      customTitle: marathonTitle,
      status: "queued",
      progress: 0,
      note: `Merged Marathon (${files.length} files)`,
    }

    const queuedIds = new Set(queued.map((j) => j.id))
    setJobs((prev) => [...prev.filter((j) => !queuedIds.has(j.id)), marathonJob])
    setTimeout(pumpQueue, 50)
    toast.success(`Merged ${files.length} episodes into single marathon!`)
  }, [pumpQueue])

  const cancelJob = (id: number) => {
    const slot = poolRef.current.find((s) => s.jobId === id)
    if (slot) {
      slot.worker.terminate()
      spawnWorker(slot)
      freeSlot(slot)
    }
    setJobs((prev) =>
      prev.map((j) => (j.id === id ? { ...j, status: "cancelled", note: "Cancelled" } : j))
    )
  }

  const removeJob = (id: number) => {
    cancelJob(id)
    setJobs((prev) => prev.filter((j) => j.id !== id))
  }

  const clearAllJobs = () => {
    for (const j of jobsRef.current) {
      if (j.status === "converting") {
        cancelJob(j.id)
      }
    }
    setJobs([])
    toast.info("Queue cleared")
  }

  // Expose global window test API for automated bench loops
  React.useEffect(() => {
    if (typeof window !== "undefined") {
      ;(window as any).__psp = {
        addFiles,
        jobs: jobsRef.current,
        mergeQueuedJobs,
        clearAllJobs,
        getSettings: () => getSettingsRef.current(),
      }
    }
  })

  const queuedCount = jobs.filter((j) => j.status === "queued").length
  const convertingCount = jobs.filter((j) => j.status === "converting").length

  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
        {/* Top Navigation */}
        <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
            <div className="flex items-center gap-3">
              <div className="flex size-8 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                <HugeiconsIcon icon={Video01Icon} className="size-5" />
              </div>
              <div>
                <span className="font-heading text-base font-semibold tracking-tight">PSP Video</span>
                <span className="ml-2 text-xs text-muted-foreground font-mono">WebCodecs + MediaBunny</span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Badge variant="outline" className="font-mono text-[11px] gap-1 border-border">
                <HugeiconsIcon icon={SparklesIcon} className="size-3 text-primary" />
                H.264 Baseline L2.1
              </Badge>
              {dirName ? (
                <Badge variant="default" className="font-mono text-[11px] gap-1 bg-emerald-600 text-white">
                  <HugeiconsIcon icon={Folder01Icon} className="size-3" />
                  ms0:/{dirName}
                </Badge>
              ) : null}
            </div>
          </div>
        </header>

        {/* Main Content Area */}
        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-4 sm:p-6 lg:flex-row">
          {/* Settings Column */}
          <section className="w-full lg:w-80 shrink-0 flex flex-col gap-4">
            <Card className="rounded-2xl border-border bg-card shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <HugeiconsIcon icon={Settings01Icon} className="size-4 text-primary" />
                  <CardTitle className="text-sm font-semibold">Encode Settings</CardTitle>
                </div>
                <CardDescription className="text-xs">Optimized for Sony PSP hardware decoder</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3.5 text-xs">
                {/* Resolution */}
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Target Resolution</Label>
                  <Select value={preset} onValueChange={(v) => { if (v) setPreset(v as PresetName) }}>
                    <SelectTrigger className="w-full h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="go">480×272 Standard (PSP-1000/2000/3000/Go)</SelectItem>
                        <SelectItem value="tv">720×480 High-Res (Ark-4 / TV-Out)</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>

                {/* Video Bitrate */}
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Video Bitrate</Label>
                  <Select value={videoBitrate} onValueChange={(v) => { if (v) setVideoBitrate(v) }}>
                    <SelectTrigger className="w-full h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="800000">800 kbps (Standard Balanced)</SelectItem>
                        <SelectItem value="1200000">1200 kbps (High Quality)</SelectItem>
                        <SelectItem value="1600000">1600 kbps (Max Ark-4)</SelectItem>
                        <SelectItem value="550000">550 kbps (Anime / Compact)</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>

                {/* Audio Bitrate */}
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Audio Bitrate (AAC-LC)</Label>
                  <Select value={audioBitrate} onValueChange={(v) => { if (v) setAudioBitrate(v) }}>
                    <SelectTrigger className="w-full h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="128000">128 kbps (Standard)</SelectItem>
                        <SelectItem value="96000">96 kbps (Voice / Compact)</SelectItem>
                        <SelectItem value="160000">160 kbps (High Fidelity)</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>

                {/* LCD Shadow Boost */}
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Screen Tuning (Shadow Lift)</Label>
                  <Select value={lcdBoost} onValueChange={(v) => { if (v) setLcdBoost(v) }}>
                    <SelectTrigger className="w-full h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="off">Standard (Go / IPS Mod / Modern)</SelectItem>
                        <SelectItem value="on">PSP-1000/2000 LCD Boost (+14% contrast)</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>

                {/* Parallel Pipeline */}
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Pipeline Mode</Label>
                  <Select value={pipelineMode} onValueChange={(v) => { if (v) setPipelineMode(v) }}>
                    <SelectTrigger className="w-full h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="segmented">Turbo Segmented (5 Workers — 1000+ FPS)</SelectItem>
                        <SelectItem value="single">Single Worker Direct</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>

                <Separator className="my-1 bg-border/60" />

                {/* Destination / Disk Stream */}
                <div className="flex flex-col gap-2">
                  <Label className="text-xs text-muted-foreground">Output Destination</Label>
                  {dirName ? (
                    <div className="flex items-center justify-between rounded-xl bg-muted/40 p-2 border border-border">
                      <div className="flex items-center gap-2 truncate">
                        <HugeiconsIcon icon={Folder01Icon} className="size-4 text-emerald-500 shrink-0" />
                        <span className="truncate font-mono text-[11px] text-foreground">{dirName}</span>
                      </div>
                      <Button variant="ghost" size="xs" onClick={clearDirectory} className="text-muted-foreground hover:text-destructive">
                        Reset
                      </Button>
                    </div>
                  ) : (
                    <Button variant="outline" size="sm" onClick={chooseDirectory} className="w-full text-xs gap-1.5 border-dashed">
                      <HugeiconsIcon icon={Folder01Icon} className="size-3.5 text-primary" />
                      Stream to Disk / Memory Stick
                    </Button>
                  )}
                  <span className="text-[11px] text-muted-foreground leading-snug">
                    {dirName ? "Zero-RAM footprint: videos write directly to stick." : "Outputs will download through browser."}
                  </span>
                </div>
              </CardContent>
            </Card>
          </section>

          {/* Queue & Dropzone Column */}
          <section className="flex flex-1 flex-col gap-4">
            {/* Drop Zone */}
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
              className={`relative flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-8 text-center transition-all cursor-pointer ${
                dragActive
                  ? "border-primary bg-primary/5 scale-[0.99]"
                  : "border-border/80 bg-card/40 hover:border-primary/50 hover:bg-card/70"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="video/*,.mkv,.mp4,.mov,.avi,.webm,.flv"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files)
                  e.target.value = ""
                }}
              />
              <div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground mb-3">
                <HugeiconsIcon icon={Film01Icon} className="size-6 text-primary" />
              </div>
              <h3 className="font-heading text-sm font-medium">Drop video files here or click to browse</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                MP4, MKV, AVI, MOV, WEBM. Fast hardware transcode with dual .THM covers.
              </p>
            </div>

            {/* Queue Header & Actions */}
            {jobs.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    Queue: <strong className="text-foreground">{jobs.length}</strong> {jobs.length === 1 ? "video" : "videos"}
                  </span>
                  {convertingCount > 0 && (
                    <Badge variant="secondary" className="text-[10px] animate-pulse">
                      Converting ({convertingCount})
                    </Badge>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {queuedCount >= 2 && (
                    <Button variant="outline" size="sm" onClick={mergeQueuedJobs} className="text-xs gap-1.5">
                      <HugeiconsIcon icon={Layers01Icon} className="size-3.5 text-primary" />
                      Merge into Marathon ({queuedCount} eps)
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={clearAllJobs} className="text-xs text-muted-foreground hover:text-destructive gap-1.5">
                    <HugeiconsIcon icon={Delete02Icon} className="size-3.5" />
                    Clear
                  </Button>
                </div>
              </div>
            )}

            {/* Jobs List */}
            <div className="flex flex-col gap-3">
              {jobs.map((job) => (
                <Card key={job.id} className="rounded-xl border-border bg-card/70 p-4 shadow-sm">
                  <div className="flex flex-col gap-3">
                    {/* Header Row */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div className="flex flex-1 items-center gap-2 min-w-0">
                        <Input
                          value={job.customTitle}
                          onChange={(e) => {
                            const newTitle = e.target.value
                            setJobs((prev) =>
                              prev.map((j) => (j.id === job.id ? { ...j, customTitle: newTitle } : j))
                            )
                          }}
                          disabled={job.status === "converting" || job.status === "done"}
                          className="h-7 text-xs font-medium font-sans max-w-sm"
                          placeholder="PSP Title"
                        />
                        {job.isMerge && (
                          <Badge variant="secondary" className="text-[10px] shrink-0">
                            Marathon
                          </Badge>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {job.profileBadge && (
                          <Badge variant="default" className="text-[10px] font-mono bg-emerald-600/90 text-white">
                            {job.profileBadge.text}
                          </Badge>
                        )}
                        <Badge
                          variant={
                            job.status === "done"
                              ? "default"
                              : job.status === "converting"
                                ? "secondary"
                                : job.status === "failed"
                                  ? "destructive"
                                  : "outline"
                          }
                          className="text-[10px] uppercase font-mono"
                        >
                          {job.status}
                        </Badge>
                      </div>
                    </div>

                    {/* Controls & Badges Row */}
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {job.duration ? (
                        <span className="font-mono text-[11px]">{fmtTime(job.duration)}</span>
                      ) : null}

                      {/* Audio track selector if multiple tracks */}
                      {job.audioTracks && job.audioTracks.length > 1 && job.status === "queued" && (
                        <div className="flex items-center gap-1">
                          <span className="text-[11px]">Audio:</span>
                          <select
                            value={job.selectedAudioTrack ?? 0}
                            onChange={(e) => {
                              const trackIdx = Number(e.target.value)
                              setJobs((prev) =>
                                prev.map((j) => (j.id === job.id ? { ...j, selectedAudioTrack: trackIdx } : j))
                              )
                            }}
                            className="h-6 rounded-md bg-muted px-1.5 text-[11px] border border-border"
                          >
                            {job.audioTracks.map((tr) => (
                              <option key={tr.index} value={tr.index}>
                                {tr.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      {job.dims && <span className="font-mono text-[11px]">{job.dims}</span>}
                      {job.outSize ? (
                        <span className="font-mono text-[11px]">{(job.outSize / (1024 * 1024)).toFixed(1)} MB</span>
                      ) : null}
                    </div>

                    {/* Progress Bar & Note */}
                    <div className="flex flex-col gap-1.5">
                      <Progress value={Math.round(job.progress * 100)} className="h-1.5 w-full" />
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground font-mono">
                        <span className="truncate">{job.note}</span>
                        {job.stats?.fps ? <span>{job.stats.fps.toFixed(0)} FPS</span> : null}
                      </div>
                    </div>

                    {/* Actions Row */}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <div className="flex items-center gap-2">
                        {job.url && (
                          <a
                            href={job.url}
                            download={job.outName || "video.mp4"}
                            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                          >
                            <HugeiconsIcon icon={Download01Icon} className="size-3.5" />
                            Download MP4
                          </a>
                        )}

                        {job.thmUrl && (
                          <a
                            href={job.thmUrl}
                            download={(job.outName || "video.mp4").replace(/\.mp4$/i, ".thm")}
                            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium hover:bg-muted transition-colors"
                          >
                            <HugeiconsIcon icon={Image01Icon} className="size-3.5 text-muted-foreground" />
                            .THM Cover
                          </a>
                        )}

                        {job.savedDirect && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-500 font-mono">
                            <HugeiconsIcon icon={CheckmarkCircle02Icon} className="size-3.5" />
                            Saved to Memory Stick
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1">
                        {job.status === "converting" && (
                          <Button variant="outline" size="xs" onClick={() => cancelJob(job.id)} className="text-xs text-destructive">
                            Cancel
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => removeJob(job.id)}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <HugeiconsIcon icon={Delete02Icon} className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </section>
        </main>
      </div>
    </TooltipProvider>
  )
}
