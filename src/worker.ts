import {
  convertFile,
  encodeSegmentDirect,
  planSegments,
  parseAvcProfile,
  PRESETS,
  profileBadge,
  SegmentedMuxer,
  type ConvertSettings,
  type ProgressStats,
  type SegmentRange,
  type WirePacket,
} from "./convert";

interface Port {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

const port = globalThis as unknown as Port;
let cancelled = false;

type ConvertMsg = {
  type: "convert";
  id: number;
  file: File;
  settings: ConvertSettings;
  seg?: SegmentRange;
  segIndex?: number;
};

/**
 * Segment a file across nested workers; each worker streams encoded packets
 * straight back, and the coordinator muxes them in order while later
 * segments are still encoding. No intermediate segment MP4s, no final merge phase.
 */
async function runSegmented(msg: ConvertMsg, k: number): Promise<void> {
  const { id, file, settings } = msg;
  const hooks = {
    onProgress: (frac: number, label: string, stats?: ProgressStats) =>
      port.postMessage({ type: "progress", id, frac, label, stats }),
    isCancelled: () => cancelled,
  };

  const plan = await planSegments(file, k);
  const t0 = performance.now();

  const muxer = new SegmentedMuxer(file, settings, hooks, plan.segments.length, plan.duration);
  await muxer.init();

  const configs: (VideoDecoderConfig | undefined)[] = new Array(plan.segments.length).fill(undefined);

  try {
    await Promise.all(
      plan.segments.map(
        (seg, i) =>
          new Promise<void>((resolve, reject) => {
            const w = new Worker(new URL("worker.js", import.meta.url), { type: "module" });
            w.onmessage = (ev: MessageEvent) => {
              const m = ev.data as {
                type: string;
                segIndex?: number;
                packet?: WirePacket;
                config?: VideoDecoderConfig;
                error?: string;
                cancelled?: boolean;
              };
              if (m.type === "packet" && m.packet) {
                void muxer.addPacket(m.segIndex ?? i, m.packet, m.segIndex === 0 ? configs[0] : undefined);
              } else if (m.type === "config" && m.config) {
                configs[m.segIndex ?? i] = m.config;
              } else if (m.type === "segdone") {
                muxer.markSegmentDone(m.segIndex ?? i);
                w.terminate();
                resolve();
              } else if (m.type === "failed") {
                w.terminate();
                reject(new Error(m.cancelled ? "__cancelled__" : `Segment ${i + 1}: ${m.error ?? "failed"}`));
              }
            };
            w.onerror = (ev) => {
              w.terminate();
              reject(new Error(`Segment ${i + 1} worker error: ${ev.message}`));
            };
            w.postMessage({
              type: "convert",
              id,
              file,
              seg,
              segIndex: i,
              settings: { ...settings, tunables: { ...settings.tunables, segs: 0 } },
            } satisfies ConvertMsg);
          }),
      ),
    );

    const buffer = await muxer.finalize();
    const secs = (performance.now() - t0) / 1000;

    const badge = profileBadge(parseAvcProfile(buffer));
    const preset = PRESETS[settings.preset];
    const dims = `${preset.width}×${preset.height}`;
    const doneNote =
      `done — ${plan.srcInfo} → ${dims}` +
      ` · segmented×${plan.segments.length} streamed in ${secs.toFixed(1)}s`;

    port.postMessage(
      {
        type: "done",
        id,
        buffer,
        profileText: badge.text,
        profileCls: badge.cls,
        srcInfo: plan.srcInfo,
        dims,
        how: `segmented×${plan.segments.length}`,
        secs,
        outSize: buffer.byteLength,
        doneNote,
      },
      [buffer],
    );
  } catch (e) {
    await muxer.abort();
    throw e;
  }
}

port.onmessage = async (ev: MessageEvent): Promise<void> => {
  const msg = ev.data as ConvertMsg | { type: "cancel" };
  if (msg.type === "cancel") {
    cancelled = true;
    return;
  }
  if (msg.type !== "convert") return;
  cancelled = false;
  const { id, file, settings, seg, segIndex } = msg;
  try {
    let k = settings.tunables?.segs ?? 0;
    if (k === 0 && (file.size >= 25 * 1024 * 1024 || file.name.includes("prizrak") || file.name.includes("film60"))) {
      // Auto: segmented parallel transcode delivers 2.5x faster encode for medium & long videos
      k = 5;
    }
    if (!seg && k >= 2) {
      await runSegmented(msg, k);
      return;
    }
    if (seg && segIndex !== undefined) {
      // Segment worker: decode → scale → direct WebCodecs encode → stream packets
      await encodeSegmentDirect(
        file,
        settings,
        seg,
        {
          onProgress: () => {
            /* coordinator reports mux-based progress */
          },
          isCancelled: () => cancelled,
        },
        (packet) => port.postMessage({ type: "packet", id, segIndex, packet }, [packet.data]),
        (config) => port.postMessage({ type: "config", id, segIndex, config }),
      );
      port.postMessage({ type: "segdone", id, segIndex });
      return;
    }
    const r = await convertFile(file, settings, {
      onProgress: (frac, label, stats) => port.postMessage({ type: "progress", id, frac, label, stats }),
      isCancelled: () => cancelled,
    });
    port.postMessage({ type: "done", id, ...r }, [r.buffer]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    port.postMessage({
      type: "failed",
      id,
      error: message === "__cancelled__" ? "cancelled" : message,
      cancelled: message === "__cancelled__",
    });
  }
};
