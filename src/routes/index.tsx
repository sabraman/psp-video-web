import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PspStorageManager } from "@/components/PspStorageManager"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { toast } from "sonner"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Download01Icon,
  Folder01Icon,
  Delete02Icon,
  Film01Icon,
  Layers01Icon,
  Image01Icon,
  RefreshIcon,
  Shield01Icon,
  ClosedCaptionIcon,
  Edit02Icon,
  UsbConnected01Icon,
} from "@hugeicons/core-free-icons"
import {
  formatBytes,
  sanitizePspFilename,
  saveBuffersToPspApi,
  listPspFiles,
  type DetectedPspDevice,
  type DuplicateAction,
  type PspFileInfo,
} from "@/psp"
import {
  cleanPspTitle,
  fmtTime,
  type ConvertSettings,
  type ProgressStats,
  type PresetName,
  parseSubtitles,
  type SubtitleCue,
} from "@/convert"

export const Route = createFileRoute("/")({
  component: ConverterPage,
})

export interface JobAudioTrack {
  index: number
  label: string
  language?: string
  codec?: string
}

/**
 * Sanitize a user-facing title into safe FAT32 filenames for PSP Memory Stick (.mp4 and .thm).
 * Preserves unicode characters in all languages (Cyrillic, Japanese, etc.)
 * while stripping strictly illegal FAT32 characters (/ \ : * ? " < > |).
 */

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
  savedOutName?: string
  savedToPspPath?: string
  buffer?: ArrayBuffer
  thmBuffer?: ArrayBuffer
  url?: string
  thmUrl?: string
  savedDirect?: boolean
  audioTracks?: JobAudioTrack[]
  selectedAudioTrack?: number
  duration?: number
  retryCount?: number
  forceSafeMode?: boolean
  subtitleFileName?: string
  subtitleCues?: SubtitleCue[]
  duplicateOnPsp?: boolean
  duplicateAction?: DuplicateAction
  storageWarning?: string
}

interface WorkerSlot {
  worker: Worker
  busy: boolean
  jobId: number | null
}

const SETTINGS_STORAGE_KEY = "psp_converter_settings_v1"
const IDB_NAME = "psp_converter_db"
const IDB_STORE = "settings"

function saveDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
      req.onsuccess = () => {
        const tx = req.result.transaction(IDB_STORE, "readwrite")
        tx.objectStore(IDB_STORE).put(handle, "outDir")
        tx.oncomplete = () => resolve()
      }
      req.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

function loadDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
      req.onsuccess = () => {
        const tx = req.result.transaction(IDB_STORE, "readonly")
        const getReq = tx.objectStore(IDB_STORE).get("outDir")
        getReq.onsuccess = () => resolve(getReq.result || null)
        getReq.onerror = () => resolve(null)
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

// formatBytes imported from ~/psp

function clearSavedDirectoryHandle(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
      req.onsuccess = () => {
        const tx = req.result.transaction(IDB_STORE, "readwrite")
        tx.objectStore(IDB_STORE).delete("outDir")
        tx.oncomplete = () => resolve()
      }
      req.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

function ConverterPage() {
  const [dragActive, setDragActive] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  // Settings with persistent defaults
  const [preset, setPreset] = React.useState<PresetName>("go")
  const [videoBitrate, setVideoBitrate] = React.useState<string>("800000")
  const [audioBitrate, setAudioBitrate] = React.useState<string>("128000")
  const [encoderMode] = React.useState<"turbo" | "auto">("turbo")
  const [lcdBoost, setLcdBoost] = React.useState<string>("off")
  const [pipelineMode, setPipelineMode] = React.useState<string>("segmented")

  // Auto-detected PSP devices via local USB bridge
  const [detectedDevices, setDetectedDevices] = React.useState<DetectedPspDevice[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = React.useState<string>("")
  const [autoSaveToPsp, setAutoSaveToPsp] = React.useState<boolean>(true)
  const [storageManagerOpen, setStorageManagerOpen] = React.useState<boolean>(false)
  const [pspFiles, setPspFiles] = React.useState<PspFileInfo[]>([])
  const pspFilesRef = React.useRef<PspFileInfo[]>([])
  pspFilesRef.current = pspFiles

  const refreshPspFiles = React.useCallback(async (videoPath?: string) => {
    const path = videoPath || selectedPspDeviceRef.current?.videoPath
    if (!path) {
      setPspFiles([])
      return []
    }
    const files = await listPspFiles(path)
    setPspFiles(files)
    return files
  }, [])
  const selectedPspDevice = React.useMemo(() => {
    return detectedDevices.find((d) => d.id === selectedDeviceId) || detectedDevices[0] || null
  }, [detectedDevices, selectedDeviceId])

  // Disk streaming / manual folder
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

  const selectedPspDeviceRef = React.useRef<DetectedPspDevice | null>(null)
  selectedPspDeviceRef.current = selectedPspDevice
  const autoSaveToPspRef = React.useRef<boolean>(true)
  autoSaveToPspRef.current = autoSaveToPsp
  const selectedDeviceIdRef = React.useRef<string>(selectedDeviceId)
  selectedDeviceIdRef.current = selectedDeviceId

  // Poll for connected PSP devices over USB
  const refreshPspStatus = React.useCallback(async () => {
    try {
      const res = await fetch("/api/psp/status")
      if (!res.ok) return
      const data = (await res.json()) as { connected: boolean; devices: DetectedPspDevice[] }
      if (data.connected && data.devices?.length > 0) {
        setDetectedDevices(data.devices)
        let targetDevId = selectedDeviceIdRef.current
        if (!targetDevId || !data.devices.some((d) => d.id === targetDevId)) {
          const rec = data.devices.find((d) => d.isRecommended) || data.devices[0]
          targetDevId = rec.id
          setSelectedDeviceId(rec.id)
        }
        const targetDev = data.devices.find((d) => d.id === targetDevId) || data.devices[0]
        if (targetDev?.videoPath) {
          const files = await listPspFiles(targetDev.videoPath)
          setPspFiles(files)
        }
      } else {
        setDetectedDevices([])
        setSelectedDeviceId("")
        setPspFiles([])
      }
    } catch {}
  }, [])

  React.useEffect(() => {
    void refreshPspStatus()
    const interval = setInterval(refreshPspStatus, 3000)
    const handleFocus = () => void refreshPspStatus()
    window.addEventListener("focus", handleFocus)

    return () => {
      clearInterval(interval)
      window.removeEventListener("focus", handleFocus)
    }
  }, [refreshPspStatus])

  // Restore settings and directory handle from storage on mount
  React.useEffect(() => {
    try {
      const saved = localStorage.getItem(SETTINGS_STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved)
        if (parsed.preset) setPreset(parsed.preset)
        if (parsed.videoBitrate) setVideoBitrate(parsed.videoBitrate)
        if (parsed.audioBitrate) setAudioBitrate(parsed.audioBitrate)
        if (parsed.lcdBoost) setLcdBoost(parsed.lcdBoost)
        if (parsed.pipelineMode) setPipelineMode(parsed.pipelineMode)
      }
    } catch {}

    loadDirectoryHandle().then(async (handle) => {
      if (!handle) return
      try {
        const perm = await (handle as any).queryPermission?.({ mode: "readwrite" })
        if (perm === "granted") {
          setDirHandle(handle)
          setDirName(handle.name)
        }
      } catch {}
    })
  }, [])

  // Save settings on change
  const persistSetting = (key: string, val: string) => {
    try {
      const cur = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}")
      cur[key] = val
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(cur))
    } catch {}
  }

  // Prevent accidental page unload while converting
  React.useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const isConverting = jobsRef.current.some((j) => j.status === "converting")
      if (isConverting) {
        e.preventDefault()
        e.returnValue = ""
      }
    }
    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => window.removeEventListener("beforeunload", handleBeforeUnload)
  }, [])

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
      for (const j of jobsRef.current) {
        cleanupJobUrls(j)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const spawnWorker = (slot: WorkerSlot) => {
    try {
      const worker = new Worker("/worker.js", { type: "module" })
      slot.worker = worker
      worker.onmessage = (e: MessageEvent) => {
        void handleWorkerMessage(slot, e.data)
      }
      worker.onerror = (err) => {
        console.error("Worker error:", err)
        handleJobFailure(slot.jobId, err.message || "Worker crashed")
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

  // Auto-retry & error handling with progressive fallback
  const handleJobFailure = (jobId: number | null, errMsg: string) => {
    if (jobId === null) return
    const job = jobsRef.current.find((j) => j.id === jobId)
    if (!job) return

    const retries = job.retryCount || 0
    if (retries < 2) {
      const nextRetry = retries + 1
      const safeDesc = nextRetry === 1 ? "standard single-pass" : "software decoder"
      toast.warning(`Retrying with ${safeDesc} mode…`)

      setJobs((prev) =>
        prev.map((j) =>
          j.id === jobId
            ? {
                ...j,
                status: "queued",
                progress: 0,
                retryCount: nextRetry,
                forceSafeMode: true,
                note: `Auto-recovering (${safeDesc})…`,
              }
            : j
        )
      )
      setTimeout(pumpQueue, 50)
      return
    }

    // Permanent failure after all retries exhausted
    setJobs((prev) =>
      prev.map((j) =>
        j.id === jobId
          ? {
              ...j,
              status: "failed",
              note: errMsg || "Could not convert video",
            }
          : j
      )
    )
    toast.error(`Could not convert "${job.customTitle || job.file.name}"`)
  }

  const handleWorkerMessage = async (slot: WorkerSlot, msg: any) => {
    const job = jobsRef.current.find((j) => j.id === msg.id)
    if (!job) {
      freeSlot(slot)
      return
    }

    if (msg.type === "progress") {
      let friendlyNote = "Converting…"
      if (msg.label) {
        if (msg.label.includes("muxing")) friendlyNote = "Finalizing video…"
        else if (msg.label.includes("pass")) friendlyNote = "Processing video…"
        else if (msg.label.includes("single-pass")) friendlyNote = "Safe mode processing…"
        else friendlyNote = "Converting…"
      }

      setJobs((prev) =>
        prev.map((j) => {
          if (j.id !== msg.id) return j
          return {
            ...j,
            progress: msg.frac ?? j.progress,
            stats: msg.stats ?? j.stats,
            note: friendlyNote,
          }
        })
      )
      return
    }

    if (msg.type === "done" && msg.buffer) {
      let { outName, thmName } = sanitizePspFilename(job?.customTitle || job?.file.name || "video")

      let savedDirect = false
      let savedToPspPath: string | undefined
      let url: string | undefined
      let thmUrl: string | undefined

      // 1. Auto-detected PSP over USB
      if (autoSaveToPspRef.current && selectedPspDeviceRef.current) {
        const pspDev = selectedPspDeviceRef.current
        const saveRes = await saveBuffersToPspApi(
          pspDev.videoPath,
          outName,
          msg.buffer,
          thmName,
          msg.thmBuffer,
          undefined,
          job?.duplicateAction || "overwrite"
        )
        if (saveRes.success) {
          savedDirect = true
          savedToPspPath = pspDev.videoPath
          if (saveRes.skipped) {
            toast.info(`Skipped saving "${outName}" (already on PSP)`)
          } else {
            if (saveRes.filename && saveRes.filename !== outName) {
              outName = saveRes.filename
            }
            toast.success(`Saved directly to PSP: "${outName}"`)
          }
          void refreshPspFiles(pspDev.videoPath)
        }
      }

      // 2. Manual DirectoryHandle fallback
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
          console.warn("Direct save failed, falling back to download:", err)
        }
      }

      if (!savedDirect) {
        const blob = new Blob([msg.buffer], { type: "video/mp4" })
        url = URL.createObjectURL(blob)
        if (msg.thmBuffer) {
          const thmBlob = new Blob([msg.thmBuffer], { type: "image/jpeg" })
          thmUrl = URL.createObjectURL(thmBlob)
        }
        toast.success(`"${outName}" is ready!`)
      }

      setJobs((prev) =>
        prev.map((j) => {
          if (j.id !== msg.id) return j
          return {
            ...j,
            status: "done",
            progress: 1,
            note: "Ready",
            buffer: savedDirect ? undefined : msg.buffer,
            thmBuffer: savedDirect ? undefined : msg.thmBuffer,
            outName,
            savedOutName: savedDirect ? outName : undefined,
            savedToPspPath,
            url,
            thmUrl,
            savedDirect,
            dims: msg.dims,
            outSize: msg.outSize,
          }
        })
      )
      const rj = jobsRef.current.find((j) => j.id === msg.id)
      if (rj) {
        rj.status = "done"
        rj.progress = 1
        rj.note = "Ready"
        rj.buffer = savedDirect ? undefined : msg.buffer
        rj.thmBuffer = savedDirect ? undefined : msg.thmBuffer
        rj.outName = outName
        rj.savedOutName = savedDirect ? outName : undefined
        rj.savedToPspPath = savedToPspPath
        rj.url = url
        rj.thmUrl = thmUrl
        rj.savedDirect = savedDirect
        rj.dims = msg.dims
        rj.outSize = msg.outSize
      }
      freeSlot(slot)
      return
    }

    if (msg.type === "failed") {
      if (msg.cancelled) {
        setJobs((prev) =>
          prev.map((j) => (j.id === msg.id ? { ...j, status: "cancelled", note: "Cancelled" } : j))
        )
        toast.info("Conversion cancelled")
        freeSlot(slot)
        return
      }

      handleJobFailure(msg.id, msg.error || "Could not convert video")
      freeSlot(slot)
    }
  }

  const pumpQueue = React.useCallback(() => {
    const pool = poolRef.current
    if (!pool || pool.length === 0) return

    while (true) {
      const nextJob = jobsRef.current.find((j) => j.status === "queued")
      if (!nextJob) break

      if (nextJob.duplicateOnPsp && nextJob.duplicateAction === "skip") {
        nextJob.status = "done"
        nextJob.progress = 1
        nextJob.note = "Skipped (already on PSP)"
        nextJob.savedDirect = true
        setJobs((prev) =>
          prev.map((j) =>
            j.id === nextJob.id
              ? {
                  ...j,
                  status: "done",
                  progress: 1,
                  note: "Skipped (already on PSP)",
                  savedDirect: true,
                }
              : j
          )
        )
        toast.info(`"${nextJob.customTitle || nextJob.file.name}" skipped (already on PSP)`)
        continue
      }

      const slot = pool.find((s) => !s.busy)
      if (!slot) break

      nextJob.status = "converting"
      slot.busy = true
      slot.jobId = nextJob.id

      setJobs((prev) =>
        prev.map((j) =>
          j.id === nextJob.id ? { ...j, status: "converting", note: "Starting…" } : j
        )
      )

      const baseSettings = getSettingsRef.current()
      const effectiveSettings: ConvertSettings = {
        ...baseSettings,
        title: nextJob.customTitle,
        audioTrackIndex: nextJob.selectedAudioTrack,
        subtitleCues: nextJob.subtitleCues,
        ...(nextJob.forceSafeMode
          ? {
              encoderMode: nextJob.retryCount && nextJob.retryCount >= 2 ? "software" : "auto",
              tunables: { segs: 0 },
            }
          : {}),
      }

      if (nextJob.isMerge && nextJob.files) {
        slot.worker.postMessage({
          type: "convert-merge",
          id: nextJob.id,
          files: nextJob.files,
          settings: effectiveSettings,
        })
      } else {
        slot.worker.postMessage({
          type: "convert",
          id: nextJob.id,
          file: nextJob.file,
          settings: effectiveSettings,
        })
      }
    }
  }, [])

  // Probe audio tracks and duration on file drop
  const probeJob = React.useCallback(
    async (jobId: number, file: File) => {
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
          label:
            t.name || (t.language ? `Audio ${idx + 1} (${t.language})` : `Audio Track ${idx + 1}`),
          language: t.language,
          codec: t.codec,
        }))

        let storageWarning: string | undefined
        const pspDev = selectedPspDeviceRef.current
        if (pspDev && dur > 0) {
          const estBytes = (dur * (Number(videoBitrate) + Number(audioBitrate))) / 8
          if (estBytes > pspDev.freeBytes) {
            storageWarning = `Low PSP storage (~ ${formatBytes(estBytes)} needed, ${pspDev.freeFormatted} free)`
          }
        }

        setJobs((prev) =>
          prev.map((j) =>
            j.id === jobId ? { ...j, duration: dur, audioTracks, storageWarning } : j
          )
        )
      } catch {
        // Probing is best-effort
      }
    },
    [videoBitrate, audioBitrate]
  )

  const addFiles = React.useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files).filter((f) => f.size > 0)
      if (list.length === 0) return

      const subFiles = list.filter((f) => f.name.endsWith(".srt") || f.name.endsWith(".vtt"))
      const videoFiles = list.filter((f) => !f.name.endsWith(".srt") && !f.name.endsWith(".vtt"))

      // If user dropped only subtitle file(s) while videos are already queued, attach to queued jobs
      if (videoFiles.length === 0 && subFiles.length > 0) {
        try {
          const text = await subFiles[0].text()
          const cues = parseSubtitles(text)
          setJobs((prev) => {
            const target = prev.find((j) => j.status === "queued" && !j.subtitleCues)
            if (!target) return prev
            return prev.map((j) =>
              j.id === target.id
                ? { ...j, subtitleFileName: subFiles[0].name, subtitleCues: cues }
                : j
            )
          })
          toast.success(`Subtitles attached from ${subFiles[0].name}`)
        } catch {
          toast.error("Could not parse subtitle file.")
        }
        return
      }

      // Pre-parse dropped subtitles to map them by base name
      const subMap = new Map<string, { name: string; cues: SubtitleCue[] }>()
      for (const sf of subFiles) {
        const stem = sf.name.replace(/\.[^/.]+$/, "").toLowerCase()
        try {
          const text = await sf.text()
          const cues = parseSubtitles(text)
          subMap.set(stem, { name: sf.name, cues })
        } catch {}
      }

      // 1. IN-QUEUE ANTI-DUPLICATION: Filter out files with same name and size that are already in jobs
      const existingJobKeys = new Set(jobsRef.current.map((j) => `${j.file.name}_${j.file.size}`))
      const nonDuplicateFiles: File[] = []
      let skippedInQueue = 0
      for (const vf of videoFiles) {
        const key = `${vf.name}_${vf.size}`
        if (existingJobKeys.has(key)) {
          skippedInQueue++
        } else {
          existingJobKeys.add(key)
          nonDuplicateFiles.push(vf)
        }
      }

      if (skippedInQueue > 0) {
        toast.info(
          skippedInQueue === 1
            ? "Duplicate video skipped (already in queue)"
            : `${skippedInQueue} duplicate videos skipped (already in queue)`
        )
      }

      if (nonDuplicateFiles.length === 0) return

      // 2. PSP STORAGE ANTI-DUPLICATION: Check against files already on the connected PSP device
      let currentPspFiles = pspFilesRef.current
      const pspDev = selectedPspDeviceRef.current
      if (pspDev?.videoPath) {
        const fresh = await listPspFiles(pspDev.videoPath)
        if (fresh.length > 0) {
          currentPspFiles = fresh
          setPspFiles(fresh)
        }
      }
      const existingPspNames = new Set(currentPspFiles.map((pf) => pf.name.toLowerCase()))

      let pspDuplicateCount = 0
      const newJobs: JobItem[] = nonDuplicateFiles.map((file) => {
        const id = nextIdRef.current++
        const cleanTitle = cleanPspTitle(file.name)
        void probeJob(id, file)
        const stem = file.name.replace(/\.[^/.]+$/, "").toLowerCase()
        const matchedSub = subMap.get(stem)
        const { outName } = sanitizePspFilename(cleanTitle)
        const alreadyOnPsp = existingPspNames.has(outName.toLowerCase())
        if (alreadyOnPsp) pspDuplicateCount++

        return {
          id,
          file,
          customTitle: cleanTitle,
          outName,
          status: "queued",
          progress: 0,
          note: alreadyOnPsp ? "Already on PSP" : "In queue",
          duplicateOnPsp: alreadyOnPsp,
          duplicateAction: (alreadyOnPsp ? "skip" : "overwrite") as DuplicateAction,
          subtitleFileName: matchedSub?.name,
          subtitleCues: matchedSub?.cues,
        }
      })

      jobsRef.current = [...jobsRef.current, ...newJobs]
      setJobs((prev) => [...prev, ...newJobs])
      setTimeout(pumpQueue, 50)
      if (pspDuplicateCount > 0) {
        toast.warning(
          pspDuplicateCount === 1
            ? "1 video already exists on your PSP (will skip unless changed)"
            : `${pspDuplicateCount} videos already exist on your PSP (will skip unless changed)`
        )
      } else {
        toast.info(`Added ${newJobs.length} video${newJobs.length > 1 ? "s" : ""}`)
      }
    },
    [probeJob, pumpQueue]
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

  // Choose direct-to-disk directory and persist in IndexedDB
  const chooseDirectory = async () => {
    if (typeof window === "undefined" || !("showDirectoryPicker" in window)) {
      toast.error("Saving directly to a folder is not supported in this browser.")
      return
    }
    try {
      const handle = await (window as any).showDirectoryPicker({ mode: "readwrite" })
      let targetHandle = handle
      let displayName = handle.name

      // If user selected the root of the PSP drive (e.g. "NO NAME", "NO NAME 1"),
      // automatically target the VIDEO directory so files show up in the PSP XMB video menu
      if (handle.name.toUpperCase() !== "VIDEO") {
        try {
          targetHandle = await handle.getDirectoryHandle("VIDEO", { create: true })
          displayName = `${handle.name}/VIDEO`
        } catch {
          // If VIDEO subfolder cannot be accessed or created, use handle as-is
        }
      }

      setDirHandle(targetHandle)
      setDirName(displayName)
      await saveDirectoryHandle(targetHandle)
      toast.success(`Connected to PSP: saving to "${displayName}"`)
    } catch (err: any) {
      if (err.name !== "AbortError") {
        console.error("Directory pick failed:", err)
      }
    }
  }

  const clearDirectory = async () => {
    setDirHandle(null)
    setDirName(null)
    await clearSavedDirectoryHandle()
    toast.info("Switched to browser downloads")
  }

  // Merge queued files into a single video
  const mergeQueuedJobs = React.useCallback(() => {
    const queued = jobsRef.current.filter((j) => j.status === "queued" && !j.isMerge)
    if (queued.length < 2) {
      toast.error("Select at least 2 videos to combine.")
      return
    }

    const files = queued.map((j) => j.file)
    const firstTitle = queued[0].customTitle
    const marathonTitle = `${firstTitle} (Combined ${files.length} parts)`

    const id = nextIdRef.current++
    const marathonJob: JobItem = {
      id,
      file: files[0],
      files,
      isMerge: true,
      customTitle: marathonTitle,
      status: "queued",
      progress: 0,
      note: `Combined video (${files.length} parts)`,
    }

    const queuedIds = new Set(queued.map((j) => j.id))
    setJobs((prev) => [...prev.filter((j) => !queuedIds.has(j.id)), marathonJob])
    setTimeout(pumpQueue, 50)
    toast.success(`Combined ${files.length} videos into one!`)
  }, [pumpQueue])

  const cleanupJobUrls = (j: JobItem) => {
    if (j.url) URL.revokeObjectURL(j.url)
    if (j.thmUrl) URL.revokeObjectURL(j.thmUrl)
  }

  const handleTitleChange = React.useCallback((jobId: number, newTitle: string) => {
    const { outName } = sanitizePspFilename(newTitle)
    setJobs((prev) =>
      prev.map((j) =>
        j.id === jobId
          ? {
              ...j,
              customTitle: newTitle,
              outName,
            }
          : j
      )
    )
    const j = jobsRef.current.find((item) => item.id === jobId)
    if (j) {
      j.customTitle = newTitle
      j.outName = outName
    }
  }, [])

  const handleTitleBlurOrEnter = React.useCallback(
    async (jobId: number) => {
      const job = jobsRef.current.find((item) => item.id === jobId)
      if (!job || job.status !== "done" || !job.buffer) return

      const { outName, thmName } = sanitizePspFilename(job.customTitle)

      // Handle rename on auto-detected PSP device
      if (job.savedToPspPath && job.savedOutName && job.savedOutName !== outName) {
        const saveRes = await saveBuffersToPspApi(
          job.savedToPspPath,
          outName,
          job.buffer,
          thmName,
          job.thmBuffer,
          job.savedOutName,
          "overwrite"
        )
        if (saveRes.success) {
          const finalName = saveRes.filename || outName
          job.savedOutName = finalName
          job.outName = finalName
          setJobs((prev) =>
            prev.map((j) =>
              j.id === jobId ? { ...j, savedOutName: finalName, outName: finalName } : j
            )
          )
          toast.success(`Renamed file to "${finalName}" on PSP`)
          void refreshPspFiles(job.savedToPspPath)
          return
        }
      }

      if (!dirHandleRef.current) return
      const currentDir = dirHandleRef.current

      if (job.savedOutName && job.savedOutName !== outName) {
        try {
          const newFileHandle = await currentDir.getFileHandle(outName, { create: true })
          const writable = await (newFileHandle as any).createWritable()
          await writable.write(job.buffer)
          await writable.close()

          if (job.thmBuffer) {
            const newThmHandle = await currentDir.getFileHandle(thmName, { create: true })
            const thmWritable = await (newThmHandle as any).createWritable()
            await thmWritable.write(job.thmBuffer)
            await thmWritable.close()
          }

          try {
            await (currentDir as any).removeEntry(job.savedOutName)
            const oldThmName = job.savedOutName.replace(/\.mp4$/i, ".thm")
            await (currentDir as any).removeEntry(oldThmName)
          } catch {}

          job.savedOutName = outName
          setJobs((prev) =>
            prev.map((j) => (j.id === jobId ? { ...j, savedOutName: outName, outName } : j))
          )
          toast.success(`Renamed file to "${outName}" in PSP folder`)
        } catch (err) {
          console.warn("Failed to rename file in PSP folder:", err)
          toast.error("Could not update file name in PSP folder")
        }
      }
    },
    [refreshPspFiles]
  )

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
    const job = jobsRef.current.find((j) => j.id === id)
    if (job) cleanupJobUrls(job)
    cancelJob(id)
    setJobs((prev) => prev.filter((j) => j.id !== id))
  }

  const clearAllJobs = () => {
    for (const j of jobsRef.current) {
      cleanupJobUrls(j)
      if (j.status === "converting") {
        cancelJob(j.id)
      }
    }
    setJobs([])
    toast.info("Queue cleared")
  }

  const retryJob = (id: number, safeMode = false) => {
    setJobs((prev) =>
      prev.map((j) =>
        j.id === id
          ? {
              ...j,
              status: "queued",
              progress: 0,
              retryCount: safeMode ? 2 : 0,
              forceSafeMode: safeMode,
              note: safeMode ? "Queued (Safe Mode)…" : "In queue",
            }
          : j
      )
    )
    setTimeout(pumpQueue, 50)
  }

  // Expose global window test API for automated bench loops
  React.useEffect(() => {
    if (typeof window !== "undefined") {
      ;(window as any).__psp = {
        addFiles,
        get jobs() {
          return jobsRef.current
        },
        renameJob: handleTitleChange,
        mergeQueuedJobs,
        clearAllJobs,
        retryJob,
        getSettings: () => getSettingsRef.current(),
      }
    }
  })

  const queuedCount = jobs.filter((j) => j.status === "queued").length
  const convertingCount = jobs.filter((j) => j.status === "converting").length

  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
        {/* Main Content Area */}
        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-4 py-6 sm:p-8 lg:flex-row">
          {/* Options Column */}
          <section className="w-full lg:w-80 shrink-0 flex flex-col gap-4">
            <Card className="rounded-2xl border-border bg-card p-4 shadow-sm">
              <div className="flex flex-col gap-3 text-xs">
                {/* Screen Size */}
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground font-medium">Screen Size</Label>
                  <Select
                    value={preset}
                    onValueChange={(v) => {
                      if (v) {
                        setPreset(v as PresetName)
                        persistSetting("preset", v)
                      }
                    }}
                  >
                    <SelectTrigger className="w-full h-8 text-xs">
                      <SelectValue placeholder="Screen size" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="go">PSP Screen (480 × 272)</SelectItem>
                        <SelectItem value="tv">Full Resolution (720 × 480)</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>

                {/* Video Quality */}
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground font-medium">Video Quality</Label>
                  <Select
                    value={videoBitrate}
                    onValueChange={(v) => {
                      if (v) {
                        setVideoBitrate(v)
                        persistSetting("videoBitrate", v)
                      }
                    }}
                  >
                    <SelectTrigger className="w-full h-8 text-xs">
                      <SelectValue placeholder="Video quality" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="800000">Balanced</SelectItem>
                        <SelectItem value="1200000">High Quality</SelectItem>
                        <SelectItem value="1600000">Maximum Quality</SelectItem>
                        <SelectItem value="550000">Smallest File</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>

                {/* Audio Quality */}
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground font-medium">Audio Quality</Label>
                  <Select
                    value={audioBitrate}
                    onValueChange={(v) => {
                      if (v) {
                        setAudioBitrate(v)
                        persistSetting("audioBitrate", v)
                      }
                    }}
                  >
                    <SelectTrigger className="w-full h-8 text-xs">
                      <SelectValue placeholder="Audio quality" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="128000">Standard Audio (128 kbps)</SelectItem>
                        <SelectItem value="96000">Voice & Speech (96 kbps)</SelectItem>
                        <SelectItem value="160000">High Fidelity (160 kbps)</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>

                {/* Display Colors */}
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground font-medium">
                    Display Colors
                  </Label>
                  <Select
                    value={lcdBoost}
                    onValueChange={(v) => {
                      if (v) {
                        setLcdBoost(v)
                        persistSetting("lcdBoost", v)
                      }
                    }}
                  >
                    <SelectTrigger className="w-full h-8 text-xs">
                      <SelectValue placeholder="Display colors" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="off">Natural</SelectItem>
                        <SelectItem value="on">Vibrant Colors</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>

                {/* Conversion Speed */}
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground font-medium">
                    Conversion Speed
                  </Label>
                  <Select
                    value={pipelineMode}
                    onValueChange={(v) => {
                      if (v) {
                        setPipelineMode(v)
                        persistSetting("pipelineMode", v)
                      }
                    }}
                  >
                    <SelectTrigger className="w-full h-8 text-xs">
                      <SelectValue placeholder="Conversion speed" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="segmented">Fast (Multi-core)</SelectItem>
                        <SelectItem value="single">Standard (Low memory)</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>

                <Separator className="my-1 bg-border/60" />

                {/* Save Location / Auto-detected PSP */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground font-medium">
                      Save Location
                    </Label>
                    {selectedPspDevice ? (
                      <span className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-500">
                        <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
                        PSP Connected
                      </span>
                    ) : null}
                  </div>

                  {selectedPspDevice ? (
                    <div className="flex flex-col gap-2 rounded-xl bg-muted/30 border border-border/80 p-2.5">
                      <div className="flex items-center gap-2">
                        <HugeiconsIcon
                          icon={UsbConnected01Icon}
                          className="size-4 text-emerald-500 shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          {detectedDevices.length > 1 ? (
                            <Select
                              value={selectedPspDevice.id}
                              onValueChange={(v) => {
                                if (v) setSelectedDeviceId(v)
                              }}
                            >
                              <SelectTrigger className="w-full h-8 text-xs">
                                <SelectValue>
                                  {selectedPspDevice.name} ({selectedPspDevice.freeFormatted} free)
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  {detectedDevices.map((d) => (
                                    <SelectItem key={d.id} value={d.id}>
                                      {d.name} ({d.freeFormatted} free)
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          ) : (
                            <span className="text-xs font-medium text-foreground truncate block">
                              {selectedPspDevice.name} ({selectedPspDevice.freeFormatted} free)
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center justify-between pt-1 border-t border-border/40 text-[11px] text-muted-foreground">
                        <span>Target: /VIDEO</span>
                        <button
                          type="button"
                          onClick={() => setAutoSaveToPsp(!autoSaveToPsp)}
                          className={`text-[10px] font-medium px-2 py-0.5 rounded cursor-pointer transition-colors ${
                            autoSaveToPsp
                              ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                              : "bg-muted text-muted-foreground border border-border"
                          }`}
                        >
                          {autoSaveToPsp ? "Direct Save Active" : "Direct Save Paused"}
                        </button>
                      </div>

                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setStorageManagerOpen(true)}
                        className="w-full h-8 text-xs gap-2 justify-between rounded-lg"
                      >
                        <div className="flex items-center gap-1.5 truncate">
                          <HugeiconsIcon
                            icon={Film01Icon}
                            className="size-3.5 text-muted-foreground"
                          />
                          <span>Manage PSP Videos</span>
                        </div>
                        <Badge
                          variant="secondary"
                          className="text-[10px] px-1.5 py-0 h-4 font-normal"
                        >
                          {pspFiles.length}
                        </Badge>
                      </Button>
                    </div>
                  ) : dirName ? (
                    <div className="flex items-center justify-between rounded-xl bg-muted/40 p-2 border border-border">
                      <div className="flex items-center gap-2 truncate">
                        <HugeiconsIcon
                          icon={Folder01Icon}
                          className="size-4 text-emerald-500 shrink-0"
                        />
                        <span className="truncate font-mono text-[11px] text-foreground">
                          {dirName}
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={clearDirectory}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        Reset
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={chooseDirectory}
                      className="w-full text-xs gap-1.5 border-dashed"
                    >
                      <HugeiconsIcon icon={Folder01Icon} className="size-3.5 text-primary" />
                      Choose PSP folder
                    </Button>
                  )}

                  <span className="text-[11px] text-muted-foreground leading-snug">
                    {selectedPspDevice && autoSaveToPsp
                      ? "Videos will save straight to your PSP Go over USB."
                      : dirName
                        ? "Videos will save directly into this folder."
                        : "Connect PSP via USB or choose a folder to save directly."}
                  </span>
                </div>
              </div>
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
              <h3 className="font-heading text-sm font-medium">
                Drop video files here or click to browse
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Supports MP4, MKV, AVI, MOV, WEBM. Includes cover art for your PSP.
              </p>
            </div>

            {/* Queue Header & Actions */}
            {jobs.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    <strong className="text-foreground">{jobs.length}</strong>{" "}
                    {jobs.length === 1 ? "video" : "videos"}
                  </span>
                  {convertingCount > 0 && (
                    <Badge variant="secondary" className="text-[10px] animate-pulse">
                      Converting ({convertingCount})
                    </Badge>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {queuedCount >= 2 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={mergeQueuedJobs}
                      className="text-xs gap-1.5"
                    >
                      <HugeiconsIcon icon={Layers01Icon} className="size-3.5 text-primary" />
                      Combine into one video ({queuedCount} parts)
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearAllJobs}
                    className="text-xs text-muted-foreground hover:text-destructive gap-1.5"
                  >
                    <HugeiconsIcon icon={Delete02Icon} className="size-3.5" />
                    Clear list
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
                        <div className="relative flex flex-1 items-center max-w-sm min-w-0">
                          <Input
                            value={job.customTitle}
                            onChange={(e) => handleTitleChange(job.id, e.target.value)}
                            onBlur={() => void handleTitleBlurOrEnter(job.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.currentTarget.blur()
                              }
                            }}
                            className="h-7 pr-7 text-xs font-medium font-sans focus-visible:ring-1"
                            placeholder="Video title"
                            title="Click to rename video and output file"
                          />
                          <HugeiconsIcon
                            icon={Edit02Icon}
                            className="absolute right-2 size-3 text-muted-foreground/50 pointer-events-none"
                          />
                        </div>
                        {job.isMerge && (
                          <Badge variant="secondary" className="text-[10px] shrink-0">
                            Combined
                          </Badge>
                        )}
                        {job.forceSafeMode && (
                          <Badge
                            variant="outline"
                            className="text-[10px] shrink-0 border-amber-500/40 text-amber-400"
                          >
                            Safe Mode
                          </Badge>
                        )}
                        {job.duplicateOnPsp && (
                          <Badge
                            variant="outline"
                            className="text-[10px] shrink-0 border-amber-500/40 text-amber-500 bg-amber-500/10"
                          >
                            Already on PSP
                          </Badge>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
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
                          className="text-[10px] capitalize font-medium"
                        >
                          {job.status === "converting"
                            ? "Converting…"
                            : job.status === "done"
                              ? "Ready"
                              : job.status}
                        </Badge>
                      </div>
                    </div>

                    {/* Controls & Badges Row */}
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {job.outName ? (
                        <span
                          className="font-mono text-[11px] text-muted-foreground/70"
                          title="Output filename"
                        >
                          {job.outName}
                        </span>
                      ) : null}
                      {job.duration ? (
                        <span className="font-mono text-[11px]">{fmtTime(job.duration)}</span>
                      ) : null}

                      {/* Duplicate on PSP control */}
                      {job.duplicateOnPsp && job.status === "queued" && (
                        <div className="flex items-center gap-1.5 rounded-md bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 text-xs text-amber-500">
                          <span className="font-medium text-[11px]">Already on PSP:</span>
                          <Select
                            value={job.duplicateAction || "skip"}
                            onValueChange={(val) => {
                              if (!val) return
                              setJobs((prev) =>
                                prev.map((j) =>
                                  j.id === job.id
                                    ? {
                                        ...j,
                                        duplicateAction: val as DuplicateAction,
                                        note:
                                          val === "skip"
                                            ? "Already on PSP (Will skip)"
                                            : val === "keep_both"
                                              ? "Save as new copy"
                                              : "Will replace file on PSP",
                                      }
                                    : j
                                )
                              )
                            }}
                          >
                            <SelectTrigger className="h-5 text-[10px] px-1.5 py-0 bg-background/60 border-amber-500/30">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="skip">Skip</SelectItem>
                              <SelectItem value="overwrite">Replace existing</SelectItem>
                              <SelectItem value="keep_both">Keep both</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      {/* Storage warning badge */}
                      {job.storageWarning && (
                        <Badge
                          variant="outline"
                          className="text-[10px] text-destructive border-destructive/30 shrink-0"
                        >
                          {job.storageWarning}
                        </Badge>
                      )}

                      {/* Audio track selector if multiple tracks */}
                      {job.audioTracks && job.audioTracks.length > 1 && job.status === "queued" && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px]">Audio:</span>
                          <Select
                            value={String(job.selectedAudioTrack ?? 0)}
                            onValueChange={(v) => {
                              if (v !== undefined) {
                                const trackIdx = Number(v)
                                setJobs((prev) =>
                                  prev.map((j) =>
                                    j.id === job.id ? { ...j, selectedAudioTrack: trackIdx } : j
                                  )
                                )
                              }
                            }}
                          >
                            <SelectTrigger className="h-6 text-[11px] px-2 py-0 min-w-[100px]">
                              <SelectValue placeholder="Audio track" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {job.audioTracks.map((tr) => (
                                  <SelectItem key={tr.index} value={String(tr.index)}>
                                    {tr.label}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      {/* Subtitles control */}
                      {job.status === "queued" &&
                        (job.subtitleFileName ? (
                          <div className="flex items-center gap-1 rounded-md bg-muted/80 px-2 py-0.5 border border-border/60 text-[11px]">
                            <HugeiconsIcon
                              icon={ClosedCaptionIcon}
                              className="size-3 text-primary"
                            />
                            <span className="max-w-[130px] truncate">{job.subtitleFileName}</span>
                            <button
                              type="button"
                              title="Remove subtitles"
                              onClick={() => {
                                setJobs((prev) =>
                                  prev.map((j) =>
                                    j.id === job.id
                                      ? {
                                          ...j,
                                          subtitleFileName: undefined,
                                          subtitleCues: undefined,
                                        }
                                      : j
                                  )
                                )
                              }}
                              className="ml-0.5 text-muted-foreground hover:text-destructive text-xs font-bold leading-none"
                            >
                              ×
                            </button>
                          </div>
                        ) : (
                          <label className="cursor-pointer inline-flex items-center gap-1 rounded-md bg-muted/40 hover:bg-muted px-2 py-0.5 border border-dashed border-border text-[11px] text-muted-foreground hover:text-foreground transition-colors">
                            <HugeiconsIcon
                              icon={ClosedCaptionIcon}
                              className="size-3 text-muted-foreground"
                            />
                            <span>+ Subtitles (.srt)</span>
                            <input
                              type="file"
                              accept=".srt,.vtt"
                              className="hidden"
                              onChange={async (e) => {
                                const file = e.target.files?.[0]
                                if (!file) return
                                try {
                                  const text = await file.text()
                                  const cues = parseSubtitles(text)
                                  setJobs((prev) =>
                                    prev.map((j) =>
                                      j.id === job.id
                                        ? { ...j, subtitleFileName: file.name, subtitleCues: cues }
                                        : j
                                    )
                                  )
                                  toast.success(`Subtitles attached: ${file.name}`)
                                } catch {
                                  toast.error("Failed to parse subtitle file.")
                                }
                              }}
                            />
                          </label>
                        ))}
                      {job.subtitleFileName && job.status !== "queued" && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-primary">
                          <HugeiconsIcon icon={ClosedCaptionIcon} className="size-3" />
                          <span>Subtitles baked</span>
                        </span>
                      )}

                      {job.dims && <span className="font-mono text-[11px]">{job.dims}</span>}
                      {job.outSize ? (
                        <span className="font-mono text-[11px]">
                          {(job.outSize / (1024 * 1024)).toFixed(1)} MB
                        </span>
                      ) : null}
                    </div>

                    {/* Progress Bar & Note */}
                    <div className="flex flex-col gap-1.5">
                      <Progress value={Math.round(job.progress * 100)} className="h-1.5 w-full" />
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span className="truncate">{job.note}</span>
                        {job.stats?.fps ? (
                          <span className="font-mono">{job.stats.fps.toFixed(0)} FPS</span>
                        ) : null}
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
                            Download Video
                          </a>
                        )}

                        {job.thmUrl && (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <a
                                  href={job.thmUrl}
                                  download={(job.outName || "video.mp4").replace(/\.mp4$/i, ".thm")}
                                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium hover:bg-muted transition-colors"
                                >
                                  <HugeiconsIcon
                                    icon={Image01Icon}
                                    className="size-3.5 text-muted-foreground"
                                  />
                                  Cover Art (.THM)
                                </a>
                              }
                            />
                            <TooltipContent>
                              Put this file in the same folder as the video on your PSP to see the
                              thumbnail
                            </TooltipContent>
                          </Tooltip>
                        )}

                        {job.duplicateOnPsp &&
                          job.status === "done" &&
                          job.note?.includes("Skipped") && (
                            <div className="flex items-center gap-2">
                              <Button
                                variant="outline"
                                size="xs"
                                onClick={() => {
                                  setJobs((prev) =>
                                    prev.map((j) =>
                                      j.id === job.id
                                        ? {
                                            ...j,
                                            status: "queued",
                                            progress: 0,
                                            duplicateAction: "overwrite" as DuplicateAction,
                                            note: "Will replace file on PSP",
                                          }
                                        : j
                                    )
                                  )
                                  setTimeout(pumpQueue, 50)
                                }}
                                className="text-xs gap-1"
                              >
                                <HugeiconsIcon icon={RefreshIcon} className="size-3" />
                                Replace on PSP
                              </Button>
                              <Button
                                variant="outline"
                                size="xs"
                                onClick={() => {
                                  setJobs((prev) =>
                                    prev.map((j) =>
                                      j.id === job.id
                                        ? {
                                            ...j,
                                            status: "queued",
                                            progress: 0,
                                            duplicateAction: "keep_both" as DuplicateAction,
                                            note: "Save as new copy",
                                          }
                                        : j
                                    )
                                  )
                                  setTimeout(pumpQueue, 50)
                                }}
                                className="text-xs gap-1"
                              >
                                Save as copy
                              </Button>
                            </div>
                          )}

                        {job.status === "failed" && (
                          <div className="flex items-center gap-2">
                            <Button
                              variant="outline"
                              size="xs"
                              onClick={() => retryJob(job.id, false)}
                              className="text-xs gap-1"
                            >
                              <HugeiconsIcon icon={RefreshIcon} className="size-3" />
                              Retry
                            </Button>
                            <Button
                              variant="outline"
                              size="xs"
                              onClick={() => retryJob(job.id, true)}
                              className="text-xs gap-1 border-amber-500/50 text-amber-400 hover:text-amber-300"
                            >
                              <HugeiconsIcon icon={Shield01Icon} className="size-3" />
                              Retry in Safe Mode
                            </Button>
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-1">
                        {job.status === "converting" && (
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => cancelJob(job.id)}
                            className="text-xs text-destructive"
                          >
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

        <PspStorageManager
          open={storageManagerOpen}
          onOpenChange={setStorageManagerOpen}
          pspDevices={detectedDevices}
          selectedDevice={selectedPspDevice}
          onSelectDevice={(dev) => setSelectedDeviceId(dev.id)}
          onRefreshStorage={async () => {
            await refreshPspStatus()
            if (selectedPspDevice) {
              await refreshPspFiles(selectedPspDevice.videoPath)
            }
          }}
        />
      </div>
    </TooltipProvider>
  )
}
