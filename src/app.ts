import type { ConvertSettings } from "./convert";

type Status = "queued" | "converting" | "done" | "failed" | "cancelled";

interface Job {
  id: number;
  file: File;
  status: Status;
  progress: number;
  note: string;
  url?: string;
  outName?: string;
  outSize?: number;
  profileBadge?: { text: string; cls: string };
  dims?: string;
  error?: string;
  els: Record<string, HTMLElement>;
}

let nextId = 1;
const jobs: Job[] = [];

interface Slot {
  worker: Worker;
  busy: boolean;
  jobId: number | null;
}
const pool: Slot[] = [];
const POOL_SIZE = Math.max(1, Math.min(8, navigator.hardwareConcurrency ?? 4));

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

// ---------- settings ----------

function getSettings(): ConvertSettings {
  return {
    preset: ($("#preset") as HTMLSelectElement).value as ConvertSettings["preset"],
    videoBitrate: Number(($("#quality") as HTMLSelectElement).value),
    audioBitrate: Number(($("#audio-bitrate") as HTMLSelectElement).value),
    encoderMode: ($("#encoder") as HTMLSelectElement).value as ConvertSettings["encoderMode"],
  };
}

// ---------- queue UI ----------

function addFiles(files: FileList | File[]): void {
  const list = [...files].filter((f) => f.size > 0);
  for (const file of list) {
    const job: Job = {
      id: nextId++,
      file,
      status: "queued",
      progress: 0,
      note: "queued",
      els: {},
    };
    jobs.push(job);
    renderJob(job);
  }
  pump();
}

function renderJob(job: Job): void {
  const queue = $("#queue");
  const div = document.createElement("div");
  div.className = "job";
  div.innerHTML = `
    <div class="job-top">
      <span class="job-name"></span>
      <button class="btn ghost cancel" type="button">Cancel</button>
    </div>
    <div class="job-src"></div>
    <div class="bar"><div></div></div>
    <div class="job-meta"></div>
    <div class="err" hidden></div>`;
  queue.appendChild(div);

  const q = (sel: string): HTMLElement => {
    const el = div.querySelector<HTMLElement>(sel);
    if (!el) throw new Error(`missing ${sel}`);
    return el;
  };
  job.els = {
    root: div,
    name: q(".job-name"),
    src: q(".job-src"),
    bar: q(".bar > div"),
    meta: q(".job-meta"),
    err: q(".err"),
    cancel: q(".cancel"),
  };
  job.els.name.textContent = job.file.name;
  job.els.src.textContent = `${fmtBytes(job.file.size)} — ${job.note}`;
  (job.els.cancel as HTMLButtonElement).onclick = () => cancelJob(job.id);
  refresh(job, job.note);
}

function refresh(job: Job, note: string): void {
  job.note = note;
  job.els.src.textContent = `${fmtBytes(job.file.size)} — ${note}`;
  job.els.bar.style.width = `${Math.round(job.progress * 100)}%`;
  const root = job.els.root;
  root.classList.toggle("done", job.status === "done");
  root.classList.toggle("failed", job.status === "failed");
  (job.els.cancel as HTMLButtonElement).style.display =
    job.status === "converting" || job.status === "queued" ? "" : "none";

  const meta = job.els.meta;
  meta.innerHTML = "";
  if (job.dims) meta.append(badge(job.dims, "grey"));
  if (job.profileBadge) meta.append(badge(job.profileBadge.text, job.profileBadge.cls));
  if (job.outSize !== undefined) meta.append(badge(fmtBytes(job.outSize), "grey"));
  if (job.url && job.outName) {
    const a = document.createElement("a");
    a.href = job.url;
    a.download = job.outName;
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = `Download`;
    a.appendChild(btn);
    meta.append(a);
  }
  if (job.error) {
    job.els.err.hidden = false;
    job.els.err.textContent = job.error;
  } else {
    job.els.err.hidden = true;
  }
}

function badge(text: string, cls: string): HTMLElement {
  const s = document.createElement("span");
  s.className = `badge ${cls}`;
  s.textContent = text;
  return s;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function readDims(url: string): Promise<string> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    const done = (s: string): void => {
      v.src = "";
      resolve(s);
    };
    v.onloadedmetadata = () => done(`${v.videoWidth}×${v.videoHeight}`);
    v.onerror = () => done("?");
    v.src = url;
    setTimeout(() => done("?"), 8000);
  });
}

// ---------- worker pool ----------

function spawnWorker(slot: Slot): void {
  const worker = new Worker("/worker.js", { type: "module" });
  worker.onmessage = (ev: MessageEvent) => onWorkerMessage(slot, ev.data);
  slot.worker = worker;
}

function initPool(): void {
  for (let i = 0; i < POOL_SIZE; i++) {
    const slot: Slot = { worker: null as unknown as Worker, busy: false, jobId: null };
    spawnWorker(slot);
    pool.push(slot);
  }
}

function pump(): void {
  for (const slot of pool) {
    if (slot.busy) continue;
    const job = jobs.find((j) => j.status === "queued");
    if (!job) return;
    job.status = "converting";
    slot.busy = true;
    slot.jobId = job.id;
    refresh(job, "starting…");
    slot.worker.postMessage({ type: "convert", id: job.id, file: job.file, settings: getSettings() });
  }
}

function freeSlot(slot: Slot): void {
  slot.busy = false;
  slot.jobId = null;
  pump();
}

function cancelJob(id: number): void {
  const job = jobs.find((j) => j.id === id);
  if (!job || job.status === "done" || job.status === "failed" || job.status === "cancelled") {
    return;
  }
  const slot = pool.find((s) => s.jobId === id);
  if (slot) {
    slot.worker.terminate();
    spawnWorker(slot);
    freeSlot(slot);
  }
  job.status = "cancelled";
  refresh(job, "cancelled");
}

interface WorkerResult {
  type: string;
  id: number;
  frac?: number;
  label?: string;
  buffer?: ArrayBuffer;
  profileText?: string;
  profileCls?: string;
  doneNote?: string;
  outSize?: number;
  error?: string;
  cancelled?: boolean;
}

async function onWorkerMessage(slot: Slot, msg: WorkerResult): Promise<void> {
  const job = jobs.find((j) => j.id === msg.id);
  if (!job) {
    freeSlot(slot);
    return;
  }
  if (msg.type === "progress") {
    job.progress = msg.frac ?? 0;
    refresh(job, msg.label ?? job.note);
    return;
  }
  if (msg.type === "done" && msg.buffer) {
    const blob = new Blob([msg.buffer], { type: "video/mp4" });
    const stem = job.file.name.replace(/\.[^.]+$/, "") || "video";
    job.outName = `${stem}_psp.mp4`;
    job.url = URL.createObjectURL(blob);
    job.profileBadge = { text: msg.profileText ?? "?", cls: msg.profileCls ?? "grey" };
    job.outSize = msg.outSize;
    job.dims = await readDims(job.url);
    job.status = "done";
    job.progress = 1;
    refresh(job, msg.doneNote ?? "done");
    freeSlot(slot);
    return;
  }
  // failed
  if (msg.cancelled || job.status === "cancelled") {
    job.status = "cancelled";
    refresh(job, "cancelled");
  } else {
    job.status = "failed";
    job.error = msg.error ?? "unknown error";
    refresh(job, "failed");
  }
  freeSlot(slot);
}

// ---------- initialization ----------

function init(): void {
  initPool();

  const drop = $("#drop");
  const picker = $("#picker") as HTMLInputElement;

  drop.addEventListener("click", () => picker.click());
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") picker.click();
  });
  picker.addEventListener("change", () => {
    if (picker.files) addFiles(picker.files);
    picker.value = "";
  });
  for (const ev of ["dragenter", "dragover"]) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("over");
    });
  }
  for (const ev of ["dragleave", "drop"]) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove("over");
    });
  }
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) addFiles(files);
  });

  // Test hook (used by automated verification): window.__psp.addFiles([...])
  (window as unknown as { __psp: unknown }).__psp = {
    addFiles: (files: File[]) => addFiles(files),
    jobs,
    poolSize: POOL_SIZE,
  };
}

init();
