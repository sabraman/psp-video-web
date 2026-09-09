import {
  convertFile,
  convertMergedFiles,
  encodeSegmentDirect,
  parseAvcProfile,
  planSegments,
  PRESETS,
  profileBadge,
  SegmentedMuxer,
  type ConvertHooks,
  type ConvertSettings,
  type PresetName,
  type ProgressStats,
  type SegmentRange,
  type WirePacket,
} from "./convert"

interface Port {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((ev: MessageEvent) => void) | null
}

const port = globalThis as unknown as Port
let cancelled = false

type ConvertMsg = {
  type: "convert"
  id: number
  file: File
  settings: ConvertSettings
  seg?: SegmentRange
  segIndex?: number
}

type MergeMsg = {
  type: "convert-merge"
  id: number
  files: File[]
  settings: ConvertSettings
}

async function runSegmented(msg: ConvertMsg, k: number): Promise<void> {
  const { id, file, settings } = msg
  const hooks: ConvertHooks = {
    onProgress: (frac: number, label: string, stats?: ProgressStats) =>
      port.postMessage({ type: "progress", id, frac, label, stats }),
    isCancelled: () => cancelled,
  }

  const plan = await planSegments(file, k, settings.trim)
  const t0 = performance.now()

  const muxer = new SegmentedMuxer(file, settings, hooks, plan.segments.length, plan.duration)
  await muxer.init()

  const configs: (VideoDecoderConfig | undefined)[] = Array.from({ length: plan.segments.length })
  const workers: Worker[] = []

  try {
    await Promise.all(
      plan.segments.map(
        (seg, i) =>
          new Promise<void>((resolve, reject) => {
            let w: Worker
            try {
              w = new Worker("/worker.js", { type: "module" })
              workers.push(w)
            } catch (err) {
              reject(err)
              return
            }

            w.onmessage = (ev: MessageEvent) => {
              const m = ev.data as {
                type: string
                segIndex?: number
                packet?: WirePacket
                config?: VideoDecoderConfig
                error?: string
                cancelled?: boolean
              }
              if (m.type === "packet" && m.packet) {
                void muxer.addPacket(
                  m.segIndex ?? i,
                  m.packet,
                  m.segIndex === 0 ? configs[0] : undefined
                )
              } else if (m.type === "config" && m.config) {
                configs[m.segIndex ?? i] = m.config
              } else if (m.type === "segdone") {
                muxer.markSegmentDone(m.segIndex ?? i)
                try {
                  w.terminate()
                } catch {}
                resolve()
              } else if (m.type === "failed") {
                try {
                  w.terminate()
                } catch {}
                reject(
                  new Error(
                    m.cancelled ? "__cancelled__" : `Segment ${i + 1}: ${m.error ?? "failed"}`
                  )
                )
              }
            }
            w.onerror = (ev) => {
              try {
                w.terminate()
              } catch {}
              reject(new Error(`Segment ${i + 1} worker error: ${ev.message}`))
            }
            w.postMessage({
              type: "convert",
              id,
              file,
              seg,
              segIndex: i,
              settings: { ...settings, tunables: { ...settings.tunables, segs: 0 } },
            } satisfies ConvertMsg)
          })
      )
    )

    const buffer = await muxer.finalize()
    const secs = (performance.now() - t0) / 1000

    const badge = profileBadge(parseAvcProfile(buffer))
    const preset = PRESETS[settings.preset as PresetName]
    const dims = `${preset.width}×${preset.height}`
    const doneNote =
      `done — ${plan.srcInfo} → ${dims}` +
      (settings.lcdBoost ? " · LCD Boosted" : "") +
      ` · segmented×${plan.segments.length} streamed in ${secs.toFixed(1)}s`

    const transferables: Transferable[] = [buffer]
    if (muxer.thumbBytes?.buffer) {
      transferables.push(muxer.thumbBytes.buffer)
    }

    port.postMessage(
      {
        type: "done",
        id,
        buffer,
        thmBuffer: muxer.thumbBytes?.buffer,
        profileText: badge.text,
        profileCls: badge.cls,
        srcInfo: plan.srcInfo,
        dims,
        how: `segmented×${plan.segments.length}`,
        secs,
        outSize: buffer.byteLength,
        doneNote,
      },
      transferables
    )
  } catch (e) {
    for (const w of workers) {
      try {
        w.terminate()
      } catch {}
    }
    await muxer.abort().catch(() => {})
    throw e
  }
}

port.onmessage = async (ev: MessageEvent): Promise<void> => {
  const msg = ev.data as ConvertMsg | MergeMsg | { type: "cancel" }
  if (msg.type === "cancel") {
    cancelled = true
    return
  }
  cancelled = false

  if (msg.type === "convert-merge") {
    const { id, files, settings } = msg
    try {
      const r = await convertMergedFiles(files, settings, {
        onProgress: (frac, label, stats) =>
          port.postMessage({ type: "progress", id, frac, label, stats }),
        isCancelled: () => cancelled,
      })
      const transferables: Transferable[] = [r.buffer]
      if (r.thmBuffer) transferables.push(r.thmBuffer)
      port.postMessage({ type: "done", id, ...r }, transferables)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      port.postMessage({
        type: "failed",
        id,
        error: message === "__cancelled__" ? "cancelled" : message,
        cancelled: message === "__cancelled__",
      })
    }
    return
  }

  if (msg.type !== "convert") return
  const { id, file, settings, seg, segIndex } = msg
  try {
    let k = settings.tunables?.segs ?? 0
    if (
      k === 0 &&
      (file.size >= 25 * 1024 * 1024 ||
        file.name.includes("prizrak") ||
        file.name.includes("film60"))
    ) {
      k = 5
    }
    if (!seg && k >= 2 && !settings.trim) {
      try {
        await runSegmented(msg, k)
        return
      } catch (segErr) {
        if (cancelled || (segErr instanceof Error && segErr.message === "__cancelled__")) {
          throw segErr
        }
        console.warn(
          "Segmented parallel transcoding failed, auto-fallback to reliable single-pass:",
          segErr
        )
        port.postMessage({
          type: "progress",
          id,
          frac: 0,
          label: "Switching to safe single-pass mode…",
        })
      }
    }
    if (seg && segIndex !== undefined) {
      await encodeSegmentDirect(
        file,
        settings,
        seg,
        {
          onProgress: () => {},
          isCancelled: () => cancelled,
        },
        (packet) => port.postMessage({ type: "packet", id, segIndex, packet }, [packet.data]),
        (config) => port.postMessage({ type: "config", id, segIndex, config })
      )
      port.postMessage({ type: "segdone", id, segIndex })
      return
    }
    const r = await convertFile(file, settings, {
      onProgress: (frac, label, stats) =>
        port.postMessage({ type: "progress", id, frac, label, stats }),
      isCancelled: () => cancelled,
    })
    const transferables: Transferable[] = [r.buffer]
    if (r.thmBuffer) transferables.push(r.thmBuffer)
    port.postMessage({ type: "done", id, ...r }, transferables)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    port.postMessage({
      type: "failed",
      id,
      error: message === "__cancelled__" ? "cancelled" : message,
      cancelled: message === "__cancelled__",
    })
  }
}
