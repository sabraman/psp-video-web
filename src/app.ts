import { ALL_FORMATS, BlobSource, Input } from "mediabunny"
import { cleanPspTitle, type ConvertSettings, type ProgressStats, type Tunables } from "./convert"

type Status = "queued" | "converting" | "done" | "failed" | "cancelled"

interface Job {
  id: number
  file: File
  files?: File[]
  isMerge?: boolean
  customTitle?: string
  status: Status
  progress: number
  note: string
  url?: string
  thmUrl?: string
  outName?: string
  outSize?: number
  profileBadge?: { text: string; cls: string }
  dims?: string
  hasSubtitles?: boolean
  savedDirect?: boolean
  stats?: ProgressStats
  error?: string
  audioTrackIndex?: number
  trimStart?: number
  trimEnd?: number
  duration?: number
  els: Record<string, HTMLElement>
}

let nextId = 1
const jobs: Job[] = []
let destinationDir: FileSystemDirectoryHandle | null = null

interface Slot {
  worker: Worker
  busy: boolean
  jobId: number | null
}
const pool: Slot[] = []
const POOL_SIZE = Math.max(1, Math.min(2, navigator.hardwareConcurrency ?? 2))

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel)
  if (!el) throw new Error(`missing element ${sel}`)
  return el
}

// ---------- settings & tunables ----------

const URL_TUNABLES: Tunables | undefined = (() => {
  if (!location.search) return undefined
  const p = new URLSearchParams(location.search)
  const t: Tunables = {}
  if (p.has("q")) t.queueDepth = Number(p.get("q"))
  const scale = p.get("scale")
  if (scale === "fast" || scale === "default") t.scaleMode = scale
  const lat = p.get("lat")
  if (lat === "quality" || lat === "realtime") t.latencyMode = lat
  const hwdec = p.get("hwdec")
  if (hwdec === "prefer-hardware" || hwdec === "prefer-software") t.decoderHw = hwdec
  if (p.has("latdec")) t.decoderLatency = p.get("latdec") === "1"
  if (p.has("cache")) t.cacheMB = Number(p.get("cache"))
  const diag = p.get("diag")
  if (diag === "decode" || diag === "full") t.diagnostic = diag
  if (p.has("segs")) t.segs = Number(p.get("segs"))
  return Object.keys(t).length > 0 ? t : undefined
})()

function getSettings(): ConvertSettings {
  const lcdBoostSelect = document.querySelector<HTMLSelectElement>("#lcd-boost")
  return {
    preset: ($("#preset") as HTMLSelectElement).value as ConvertSettings["preset"],
    videoBitrate: Number(($("#quality") as HTMLSelectElement).value),
    audioBitrate: Number(($("#audio-bitrate") as HTMLSelectElement).value),
    encoderMode: ($("#encoder") as HTMLSelectElement).value as ConvertSettings["encoderMode"],
    lcdBoost: lcdBoostSelect ? lcdBoostSelect.value === "on" : false,
    tunables: URL_TUNABLES,
  }
}

// ---------- queue UI ----------

function addFiles(files: FileList | File[]): void {
  const list = [...files].filter((f) => f.size > 0)
  for (const file of list) {
    const job: Job = {
      id: nextId++,
      file,
      customTitle: cleanPspTitle(file.name),
      status: "queued",
      progress: 0,
      note: "queued",
      els: {},
    }
    jobs.push(job)
    renderJob(job)
    void probeAudioAndDuration(job)
  }
  updateToolbar()
  pump()
}

async function probeAudioAndDuration(job: Job): Promise<void> {
  if (job.isMerge) return
  try {
    const input = new Input({
      source: new BlobSource(job.file, { maxCacheSize: 8 * 1024 * 1024 }),
      formats: ALL_FORMATS,
    })
    const [aTracks, dur] = await Promise.all([
      input.getAudioTracks().catch(() => []) as Promise<any[]>,
      input.computeDuration().catch(() => 0),
    ])
    job.duration = dur
    if (aTracks.length > 1 && job.els.optRow && job.els.audioSelect) {
      job.els.optRow.hidden = false
      const select = job.els.audioSelect as HTMLSelectElement
      select.innerHTML = ""
      aTracks.forEach((t: any, i: number) => {
        const opt = document.createElement("option")
        opt.value = String(i)
        opt.textContent = `Audio ${i + 1}: ${t.language ? String(t.language).toUpperCase() : "Track"} (${t.codec || "AAC"})`
        select.appendChild(opt)
      })
      select.onchange = () => {
        job.audioTrackIndex = Number(select.value)
      }
    }
  } catch {
    /* ignore probe failures */
  }
}

function renderJob(job: Job): void {
  const queue = $("#queue")
  const div = document.createElement("div")
  div.className = "job"
  div.innerHTML = `
    <div class="job-top">
      <div class="job-title-wrap">
        <input class="job-title-input" type="text" value="${escapeHtml(job.customTitle || job.file.name)}" title="Output title (click to rename)" />
      </div>
      <div class="job-actions">
        <button class="btn ghost cancel" type="button">Cancel</button>
      </div>
    </div>
    <div class="job-options-row" hidden>
      <label>
        <span>Audio:</span>
        <select class="job-opt-select audio-select"></select>
      </label>
      <label class="trim-wrap" hidden>
        <span>Trim:</span>
        <input class="job-opt-input trim-start" type="text" placeholder="0:00" />
        <span>to</span>
        <input class="job-opt-input trim-end" type="text" placeholder="end" />
      </label>
    </div>
    <div class="job-src"></div>
    <div class="bar"><div></div></div>
    <div class="job-meta"></div>
    <div class="err" hidden></div>`
  queue.appendChild(div)

  const q = (sel: string): HTMLElement => {
    const el = div.querySelector<HTMLElement>(sel)
    if (!el) throw new Error(`missing ${sel}`)
    return el
  }
  job.els = {
    root: div,
    titleInput: q(".job-title-input"),
    optRow: q(".job-options-row"),
    audioSelect: q(".audio-select"),
    src: q(".job-src"),
    bar: q(".bar > div"),
    meta: q(".job-meta"),
    err: q(".err"),
    cancel: q(".cancel"),
  }

  const titleInput = job.els.titleInput as HTMLInputElement
  titleInput.oninput = () => {
    job.customTitle = titleInput.value.trim() || cleanPspTitle(job.file.name)
  }

  ;(job.els.cancel as HTMLButtonElement).onclick = () => cancelJob(job.id)
  refresh(job, job.note)
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function refresh(job: Job, note: string): void {
  job.note = note
  let statText = ""
  if (job.status === "converting" && job.stats && job.stats.fps > 0) {
    statText = ` · ${Math.round(job.stats.fps)} fps · ${job.stats.speed.toFixed(1)}× · ETA ${fmtDuration(job.stats.eta)}`
  }
  const sizeInfo =
    job.isMerge && job.files
      ? `${job.files.length} files (${fmtBytes(job.files.reduce((acc, f) => acc + f.size, 0))})`
      : fmtBytes(job.file.size)
  job.els.src.textContent = `${sizeInfo} — ${note}${statText}`
  job.els.bar.style.width = `${Math.round(job.progress * 100)}%`
  const root = job.els.root
  root.classList.toggle("done", job.status === "done")
  root.classList.toggle("failed", job.status === "failed")
  ;(job.els.cancel as HTMLButtonElement).style.display =
    job.status === "converting" || job.status === "queued" ? "" : "none"

  const meta = job.els.meta
  meta.innerHTML = ""
  if (job.dims) meta.append(badge(job.dims, "grey"))
  if (job.profileBadge) meta.append(badge(job.profileBadge.text, job.profileBadge.cls))
  if (job.hasSubtitles) meta.append(badge("subs stripped (PSP safe)", "blue"))
  if (job.savedDirect) meta.append(badge("✓ saved to disk (.mp4 + .thm)", "green"))
  if (job.outSize !== undefined) meta.append(badge(fmtBytes(job.outSize), "grey"))

  if (!job.savedDirect && job.url && job.outName) {
    const group = document.createElement("div")
    group.className = "dl-group"

    const a = document.createElement("a")
    a.href = job.url
    a.download = job.outName
    a.className = "btn"
    a.textContent = "Download MP4"
    group.appendChild(a)

    if (job.thmUrl) {
      const aThm = document.createElement("a")
      aThm.href = job.thmUrl
      aThm.download = job.outName.replace(/\.mp4$/i, ".thm")
      aThm.className = "btn ghost btn-sm"
      aThm.textContent = ".THM Cover"
      aThm.title = "Save next to video on PSP Memory Stick for XMB menu thumbnail"
      group.appendChild(aThm)
    }
    meta.append(group)
  }
  if (job.error) {
    job.els.err.hidden = false
    job.els.err.textContent = job.error
  } else {
    job.els.err.hidden = true
  }
  updateToolbar()
}

function badge(text: string, cls: string): HTMLElement {
  const s = document.createElement("span")
  s.className = `badge ${cls}`
  s.textContent = text
  return s
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fmtDuration(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return "0s"
  const s = Math.round(sec)
  const m = Math.floor(s / 60)
  const rem = s % 60
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`
}

function updateToolbar(): void {
  const queueToolbar = document.querySelector<HTMLElement>("#queue-toolbar")
  const queueCount = document.querySelector<HTMLElement>("#queue-count")
  if (!queueToolbar || !queueCount) return
  if (jobs.length === 0) {
    queueToolbar.hidden = true
    return
  }
  queueToolbar.hidden = false
  const doneCount = jobs.filter((j) => j.status === "done").length
  const convertingCount = jobs.filter((j) => j.status === "converting").length
  const queuedCount = jobs.filter((j) => j.status === "queued").length
  queueCount.textContent = `${doneCount} of ${jobs.length} completed${
    convertingCount > 0 ? ` · ${convertingCount} converting` : ""
  }${queuedCount > 0 ? ` · ${queuedCount} in queue` : ""}`
}

function clearFinishedJobs(): void {
  const finished = jobs.filter(
    (j) => j.status === "done" || j.status === "failed" || j.status === "cancelled"
  )
  for (const job of finished) {
    if (job.url) URL.revokeObjectURL(job.url)
    if (job.thmUrl) URL.revokeObjectURL(job.thmUrl)
    job.els.root?.remove()
    const idx = jobs.indexOf(job)
    if (idx !== -1) jobs.splice(idx, 1)
  }
  updateToolbar()
}

function mergeQueuedJobs(): void {
  const queued = jobs.filter((j) => j.status === "queued")
  if (queued.length < 2) {
    alert("Please add at least 2 videos to queue to merge them into a continuous marathon.")
    return
  }
  const files = queued.map((j) => j.file)
  const firstName = files[0].name
  const mergedTitle = cleanPspTitle(firstName) + " Marathon"

  for (const j of queued) {
    j.els.root?.remove()
    const idx = jobs.indexOf(j)
    if (idx !== -1) jobs.splice(idx, 1)
  }

  const mergedJob: Job = {
    id: nextId++,
    file: files[0],
    files,
    isMerge: true,
    customTitle: mergedTitle,
    status: "queued",
    progress: 0,
    note: `queued (${files.length} episodes to merge)`,
    els: {},
  }
  jobs.push(mergedJob)
  renderJob(mergedJob)
  updateToolbar()
  pump()
}

// ---------- worker pool ----------

function spawnWorker(slot: Slot): void {
  const worker = new Worker("/worker.js", { type: "module" })
  worker.onmessage = (ev: MessageEvent) => onWorkerMessage(slot, ev.data)
  slot.worker = worker
}

function initPool(): void {
  for (let i = 0; i < POOL_SIZE; i++) {
    const slot: Slot = { worker: null as unknown as Worker, busy: false, jobId: null }
    spawnWorker(slot)
    pool.push(slot)
  }
}

function pump(): void {
  while (true) {
    const job = jobs.find((j) => j.status === "queued")
    if (!job) break
    const slot = pool.find((s) => !s.busy)
    if (!slot) break
    job.status = "converting"
    slot.busy = true
    slot.jobId = job.id

    if (job.isMerge && job.files) {
      refresh(job, "starting marathon merge…")
      slot.worker.postMessage({
        type: "convert-merge",
        id: job.id,
        files: job.files,
        settings: {
          ...getSettings(),
          title: job.customTitle,
        },
      })
    } else {
      refresh(job, "starting…")
      slot.worker.postMessage({
        type: "convert",
        id: job.id,
        file: job.file,
        settings: {
          ...getSettings(),
          title: job.customTitle,
          audioTrackIndex: job.audioTrackIndex,
          trim:
            job.trimStart !== undefined && job.trimEnd !== undefined
              ? { start: job.trimStart, end: job.trimEnd }
              : undefined,
        },
      })
    }
  }
  updateToolbar()
}

function freeSlot(slot: Slot): void {
  slot.busy = false
  slot.jobId = null
  pump()
}

function cancelJob(id: number): void {
  const job = jobs.find((j) => j.id === id)
  if (!job || job.status === "done" || job.status === "failed" || job.status === "cancelled") {
    return
  }
  const slot = pool.find((s) => s.jobId === id)
  if (slot) {
    slot.worker.terminate()
    spawnWorker(slot)
    freeSlot(slot)
  }
  job.status = "cancelled"
  refresh(job, "cancelled")
}

interface WorkerResult {
  type: string
  id: number
  frac?: number
  label?: string
  stats?: ProgressStats
  buffer?: ArrayBuffer
  thmBuffer?: ArrayBuffer
  profileText?: string
  profileCls?: string
  doneNote?: string
  dims?: string
  outSize?: number
  hasSubtitles?: boolean
  error?: string
  cancelled?: boolean
}

async function onWorkerMessage(slot: Slot, msg: WorkerResult): Promise<void> {
  const job = jobs.find((j) => j.id === msg.id)
  if (!job) {
    freeSlot(slot)
    return
  }
  if (msg.type === "progress") {
    job.progress = msg.frac ?? 0
    job.stats = msg.stats
    refresh(job, msg.label ?? job.note)
    return
  }
  if (msg.type === "done" && msg.buffer) {
    const rawStem = job.customTitle || job.file.name.replace(/\.[^.]+$/, "") || "video"
    const cleanStem = rawStem
      .replace(/[^\w\s.-]/g, "")
      .trim()
      .replace(/\s+/g, "_")
    job.outName = `${cleanStem}.mp4`
    job.profileBadge = { text: msg.profileText ?? "?", cls: msg.profileCls ?? "grey" }
    job.outSize = msg.outSize
    job.dims = msg.dims
    job.hasSubtitles = msg.hasSubtitles

    if (destinationDir) {
      try {
        refresh(job, "saving to disk…")
        const fileHandle = await destinationDir.getFileHandle(job.outName, { create: true })
        const writable = await (fileHandle as any).createWritable()
        await writable.write(msg.buffer)
        await writable.close()

        if (msg.thmBuffer) {
          const thmName = `${cleanStem}.thm`
          const thmHandle = await destinationDir.getFileHandle(thmName, { create: true })
          const thmWritable = await (thmHandle as any).createWritable()
          await thmWritable.write(msg.thmBuffer)
          await thmWritable.close()
        }
        job.savedDirect = true
      } catch (err) {
        console.warn("Direct save failed, falling back to blob:", err)
        const blob = new Blob([msg.buffer], { type: "video/mp4" })
        job.url = URL.createObjectURL(blob)
        if (msg.thmBuffer) {
          const thmBlob = new Blob([msg.thmBuffer], { type: "image/jpeg" })
          job.thmUrl = URL.createObjectURL(thmBlob)
        }
      }
    } else {
      const blob = new Blob([msg.buffer], { type: "video/mp4" })
      job.url = URL.createObjectURL(blob)
      if (msg.thmBuffer) {
        const thmBlob = new Blob([msg.thmBuffer], { type: "image/jpeg" })
        job.thmUrl = URL.createObjectURL(thmBlob)
      }
    }

    job.status = "done"
    job.progress = 1
    refresh(job, msg.doneNote ?? "done")
    freeSlot(slot)
    return
  }

  if (msg.cancelled || job.status === "cancelled") {
    job.status = "cancelled"
    refresh(job, "cancelled")
  } else {
    job.status = "failed"
    job.error = msg.error ?? "unknown error"
    refresh(job, "failed")
  }
  freeSlot(slot)
}

// ---------- initialization ----------

function init(): void {
  initPool()

  const drop = $("#drop")
  const picker = $("#picker") as HTMLInputElement
  const btnDest = $("#btn-dest")
  const destLabel = $("#dest-label")
  const btnClearDone = $("#btn-clear-done")
  const btnMerge = $("#btn-merge")

  if (btnClearDone) {
    btnClearDone.addEventListener("click", () => clearFinishedJobs())
  }

  if (btnMerge) {
    btnMerge.addEventListener("click", () => mergeQueuedJobs())
  }

  if (btnDest && destLabel) {
    btnDest.addEventListener("click", async () => {
      if ("showDirectoryPicker" in window) {
        try {
          const dir = await (window as any).showDirectoryPicker({
            id: "psp-video-out",
            mode: "readwrite",
          })
          destinationDir = dir
          destLabel.textContent = `Save to: ${dir.name}/`
          btnDest.classList.add("active")
        } catch (err: any) {
          if (err.name !== "AbortError") {
            console.error("Directory picker error:", err)
          }
        }
      } else {
        alert(
          "File System Access API is not supported in this browser. Output files will download via browser."
        )
      }
    })
  }

  drop.addEventListener("click", () => picker.click())
  picker.addEventListener("change", () => {
    if (picker.files?.length) {
      addFiles(picker.files)
      picker.value = ""
    }
  })

  window.addEventListener("dragover", (e) => {
    e.preventDefault()
    drop.classList.add("dragover")
  })
  window.addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null) drop.classList.remove("dragover")
  })
  window.addEventListener("drop", (e) => {
    e.preventDefault()
    drop.classList.remove("dragover")
    if (e.dataTransfer?.files.length) {
      addFiles(e.dataTransfer.files)
    }
  })

  // Test hook: window.__psp
  ;(window as unknown as { __psp: unknown }).__psp = {
    addFiles: (files: File[]) => addFiles(files),
    mergeQueuedJobs: () => mergeQueuedJobs(),
    jobs,
    poolSize: POOL_SIZE,
  }
}

init()
