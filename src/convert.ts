import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
  canEncodeAudio,
  registerVideoSampleTransformer,
} from "mediabunny";
import { registerAacEncoder } from "@mediabunny/aac-encoder";

export const PRESETS = {
  go: { width: 480, height: 272, label: "Go 480×272" },
  tv: { width: 720, height: 480, label: "TV 720×480" },
} as const;

export type PresetName = keyof typeof PRESETS;

export interface Tunables {
  /** Depth of the decode→encode pipeline queue (default 6). */
  queueDepth?: number;
  /** "fast" = 1-pass OffscreenCanvas scaler; "default" = MediaBunny mipmapping. Default "fast". */
  scaleMode?: "default" | "fast";
  /** VideoEncoder latencyMode (default "realtime"). */
  latencyMode?: "quality" | "realtime";
  /** Decoder hardware acceleration hint (default "prefer-hardware"). */
  decoderHw?: "prefer-hardware" | "prefer-software";
  /** Decoder optimizeForLatency hint (default false). */
  decoderLatency?: boolean;
  /** BlobSource maxCacheSize in MiB (default 64). */
  cacheMB?: number;
  /** Diagnostic: "decode" skips encoding (ceiling measurement); "full" is the default. */
  diagnostic?: "full" | "decode";
  /** Split one file into N keyframe-aligned segments transcoded in parallel workers (N ≥ 2 enables). */
  segs?: number;
}

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

export interface ConvertSettings {
  preset: PresetName;
  videoBitrate: number;
  audioBitrate: number;
  encoderMode: "auto" | "software" | "turbo";
  tunables?: Tunables;
  /** Boost contrast and brightness on GPU to compensate for vintage PSP-1000/2000 LCD black crush. */
  lcdBoost?: boolean;
  /** Selected audio track index (default: primary audio). */
  audioTrackIndex?: number;
  /** Optional time trim range in seconds. */
  trim?: { start: number; end: number };
  /** Optional subtitle cues to burn in onto the video canvas. */
  subtitleCues?: SubtitleCue[];
  /** Optional override title for MP4 metadata. */
  title?: string;
}

export interface SegmentRange {
  start: number;
  end: number;
}

export interface ProgressStats {
  fps: number;
  speed: number;
  eta: number;
}

export interface ConvertHooks {
  onProgress: (frac: number, label: string, stats?: ProgressStats) => void;
  isCancelled: () => boolean;
}

export interface ConvertResult {
  buffer: ArrayBuffer;
  thmBuffer?: ArrayBuffer;
  profileText: string;
  profileCls: string;
  srcInfo: string;
  dims: string;
  how: string;
  secs: number;
  outSize: number;
  doneNote: string;
  hasSubtitles?: boolean;
}

export interface AvcInfo {
  profileIdc: number;
  levelIdc: number;
}

/** Read profile/level straight from an MP4's avcC box — no guessing. */
export function parseAvcProfile(buf: ArrayBuffer): AvcInfo | null {
  const b = new Uint8Array(buf);
  for (let i = 0; i + 8 < b.length; i++) {
    // 'avcC' = 0x61 0x76 0x63 0x43
    if (b[i] === 0x61 && b[i + 1] === 0x76 && b[i + 2] === 0x63 && b[i + 3] === 0x43) {
      if (b[i + 4] !== 1) continue;
      return { profileIdc: b[i + 5], levelIdc: b[i + 7] };
    }
  }
  return null;
}

export function profileBadge(info: AvcInfo | null): { text: string; cls: string } {
  if (!info) return { text: "profile unknown", cls: "grey" };
  const names: Record<number, string> = { 66: "Baseline", 77: "Main", 100: "High" };
  const name = names[info.profileIdc] ?? `profile ${info.profileIdc}`;
  const level = `L${(info.levelIdc / 10).toFixed(1)}`;
  if (info.profileIdc === 66 && info.levelIdc <= 30) {
    return { text: `${name} ${level} ✓ PSP-ready`, cls: "green" };
  }
  if (info.profileIdc === 77 && info.levelIdc <= 30) {
    return { text: `${name} ${level} — plays on Go`, cls: "amber" };
  }
  return { text: `${name} ${level} — may not play`, cls: "red" };
}

export function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m > 0 ? `${m}:${String(sec).padStart(2, "0")}` : `${sec}s`;
}

function isCancelled(hooks: ConvertHooks): boolean {
  return hooks.isCancelled();
}

const QP_BY_TARGET: Record<number, number> = { 600000: 28, 800000: 25, 1200000: 22 };

function resolveQuantizer(videoBitrate: number): number {
  return QP_BY_TARGET[videoBitrate] ?? 25;
}

/** Never spend more bits than the source already has (the "Shrek case"). */
function computeEffectiveBitrate(file: File, duration: number, target: number, hasAudio: boolean): number {
  const srcTotalBitrate = duration > 0 ? (file.size * 8) / duration : 0;
  const srcVideoBitrate = hasAudio ? Math.max(0, srcTotalBitrate - 128e3) : srcTotalBitrate;
  return srcVideoBitrate > 0 ? Math.min(target, Math.round(srcVideoBitrate)) : target;
}

/** Smart regex title cleaner for clean PSP XMB alphabetical sorting. */
export function cleanPspTitle(name: string): string {
  let s = name.replace(/\.[^.]+$/, "");
  s = s.replace(/\[[^\]]*\]/g, " ").replace(/\([^)]*\)/g, " ");
  s = s.replace(/[._]/g, " ");
  s = s.replace(/\b(1080p|720p|480p|2160p|4k|bluray|bdrip|webrip|web-dl|x264|x265|hevc|h264|aac|dts)\b/gi, " ");
  s = s.replace(/\b(season\s*(\d+))\b/gi, "S$2");
  s = s.replace(/\b(episode\s*(\d+))\b/gi, "E$2");
  s = s.replace(/\s+-\s+(\d{1,3})\b/, " E$1");
  s = s.replace(/\s+/g, " ").trim();
  return s || "video";
}

/** Subtitle renderer for OffscreenCanvas (crisp white text with black stroke outline). */
export function renderSubtitle(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  width: number,
  height: number,
): void {
  const lines = text.split("\n");
  const fontSize = Math.max(12, Math.round(height * 0.055));
  ctx.font = `bold ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";

  const lineHeight = fontSize * 1.25;
  const bottomMargin = Math.round(height * 0.08);
  const startY = height - bottomMargin - (lines.length - 1) * lineHeight;

  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.9)";
  ctx.fillStyle = "#ffffff";

  lines.forEach((line, idx) => {
    const y = startY + idx * lineHeight;
    ctx.strokeText(line, width / 2, y);
    ctx.fillText(line, width / 2, y);
  });
}

/** Extract a 160×120 baseline JPEG thumbnail for PSP XMB menu and MP4 covr atom. */
export async function extractThumbnail(file: File, atTimestamp = 5): Promise<Uint8Array | null> {
  try {
    if (typeof OffscreenCanvas === "undefined") return null;
    const input = new Input({
      source: new BlobSource(file, { maxCacheSize: 16 * 1024 * 1024 }),
      formats: ALL_FORMATS,
    });
    const vTrack = await input.getPrimaryVideoTrack();
    if (!vTrack) return null;
    const duration = await input.computeDuration().catch(() => 10);
    const targetTime = Math.min(Math.max(0.5, atTimestamp), Math.max(0.5, duration * 0.1));
    const sink = new VideoSampleSink(vTrack, { hardwareAcceleration: "prefer-hardware" });
    let chosenSample: VideoSample | null = null;
    for await (const sample of sink.samples(targetTime)) {
      chosenSample = sample;
      break;
    }
    if (!chosenSample) {
      for await (const sample of sink.samples(0)) {
        chosenSample = sample;
        break;
      }
    }
    if (!chosenSample) return null;

    const thmCanvas = new OffscreenCanvas(160, 120);
    const thmCtx = thmCanvas.getContext("2d", { alpha: false });
    if (!thmCtx) {
      chosenSample.close();
      return null;
    }
    thmCtx.fillStyle = "#000";
    thmCtx.fillRect(0, 0, 160, 120);
    chosenSample.drawWithFit(thmCtx, { fit: "contain" });
    chosenSample.close();

    const blob = await thmCanvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
    return new Uint8Array(await blob.arrayBuffer());
  } catch (err) {
    console.warn("Thumbnail extraction skipped:", err);
    return null;
  }
}

// ---------- fast 1-pass video scaler ----------
let fastScaleEnabled = true;
let fastCanvas: OffscreenCanvas | null = null;
let fastCtx: OffscreenCanvasRenderingContext2D | null = null;
let currentLcdBoost = false;

registerVideoSampleTransformer((sample, desc) => {
  if (!fastScaleEnabled) return null;
  if (desc.rotation !== 0 || desc.crop !== undefined) return null;
  const w = desc.width;
  const h = desc.height;
  if (!fastCanvas || fastCanvas.width !== w || fastCanvas.height !== h) {
    fastCanvas = new OffscreenCanvas(w, h);
    fastCtx = fastCanvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
      willReadFrequently: false,
    }) as OffscreenCanvasRenderingContext2D | null;
  }
  if (!fastCtx) return null;
  fastCtx.imageSmoothingQuality = "medium";
  fastCtx.filter = currentLcdBoost ? "contrast(1.14) brightness(1.06)" : "none";
  fastCtx.fillStyle = "#000";
  fastCtx.fillRect(0, 0, w, h);
  sample.drawWithFit(fastCtx, { fit: desc.fit });
  return new VideoSample(fastCanvas, {
    timestamp: sample.timestamp,
    duration: sample.duration,
  });
});

// ---------- pipeline bounded queue ----------
class PipelineQueue<T> {
  private items: T[] = [];
  private waiters: (() => void)[] = [];
  private closed = false;

  constructor(private readonly max: number) {}

  async push(item: T): Promise<boolean> {
    while (this.items.length >= this.max && !this.closed) {
      await new Promise<void>((r) => this.waiters.push(r));
    }
    if (this.closed) return false;
    this.items.push(item);
    this.notify();
    return true;
  }

  async pop(): Promise<T | null> {
    while (this.items.length === 0 && !this.closed) {
      await new Promise<void>((r) => this.waiters.push(r));
    }
    if (this.items.length === 0) return null;
    const item = this.items.shift()!;
    this.notify();
    return item;
  }

  close(): void {
    this.closed = true;
    this.notify();
  }

  drain(): T[] {
    const res = this.items;
    this.items = [];
    return res;
  }

  private notify(): void {
    while (this.waiters.length > 0) this.waiters.shift()!();
  }
}

export async function convertFile(
  file: File,
  settings: ConvertSettings,
  hooks: ConvertHooks,
  seg?: SegmentRange,
): Promise<ConvertResult> {
  const preset = PRESETS[settings.preset];
  const tun = settings.tunables ?? {};
  const queueDepth = tun.queueDepth ?? 6;
  const latencyMode = tun.latencyMode ?? "realtime";
  const decoderHw = tun.decoderHw ?? "prefer-hardware";
  const decoderLatency = tun.decoderLatency ?? false;
  const cacheBytes = (tun.cacheMB ?? 64) * 1024 * 1024;
  fastScaleEnabled = tun.scaleMode !== "default";
  currentLcdBoost = !!settings.lcdBoost;
  const t0 = performance.now();
  const cancelled = (): boolean => isCancelled(hooks);

  if (!(await canEncodeAudio("aac"))) {
    try {
      registerAacEncoder();
    } catch {
      /* ignore */
    }
  }

  const report = (frac: number, label: string, stats?: ProgressStats): void => {
    if (!cancelled()) hooks.onProgress(frac, label, stats);
  };

  const input = new Input({
    source: new BlobSource(file, { maxCacheSize: cacheBytes }),
    formats: ALL_FORMATS,
  });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error("No video track found in this file.");

  const [metrics, dw, dh, duration, vCfg, allTracks, aTracks] = await Promise.all([
    videoTrack.computeFrameRateMetrics({ targetPacketCount: 64 }).catch(() => null),
    videoTrack.getDisplayWidth().catch(() => 0),
    videoTrack.getDisplayHeight().catch(() => 0),
    input.computeDuration().catch(() => -1),
    videoTrack.getDecoderConfig().catch(() => null),
    input.getTracks().catch(() => []),
    input.getAudioTracks().catch(() => []),
  ]);
  const hasSubtitles = allTracks.some((t) => t.type === "subtitle" || (t as any).isSubtitleTrack?.());
  const fps = metrics?.bestGuessFrameRate ?? 0;
  const srcInfo = `${dw || "?"}×${dh || "?"}${fps ? ` @ ${fps.toFixed(1)}fps` : ""}${
    duration > 0 ? ` · ${fmtTime(duration)}` : ""
  }`;

  let audioTrack = aTracks[settings.audioTrackIndex ?? 0] ?? null;
  if (!audioTrack && aTracks.length > 0) audioTrack = aTracks[0];
  const aCfg = audioTrack ? await audioTrack.getDecoderConfig().catch(() => null) : null;
  const tProbe = performance.now();

  if (cancelled()) throw new Error("__cancelled__");

  const thumbBytes = !seg ? await extractThumbnail(file, settings.trim?.start ? settings.trim.start + 5 : 5) : null;

  const hasAudio = !seg && !!audioTrack;
  const quantizer = resolveQuantizer(settings.videoBitrate);
  const effVideoBitrate = computeEffectiveBitrate(file, duration, settings.videoBitrate, hasAudio);
  const capped = effVideoBitrate < settings.videoBitrate;
  const videoQuality = new Quality({ quantizer, bitrate: effVideoBitrate });

  let vProf = 0;
  let vLevel = 99;
  const rawDesc = vCfg?.description;
  let vDesc: Uint8Array | null = null;
  if (rawDesc instanceof ArrayBuffer) vDesc = new Uint8Array(rawDesc);
  else if (ArrayBuffer.isView(rawDesc)) {
    vDesc = new Uint8Array(rawDesc.buffer, rawDesc.byteOffset, rawDesc.byteLength);
  }
  if (vDesc && vDesc.length >= 4 && vDesc[0] === 1) {
    vProf = vDesc[1];
    vLevel = vDesc[3];
  }
  const aCopyOk =
    hasAudio &&
    aCfg?.codec === "mp4a.40.2" &&
    (aCfg?.numberOfChannels ?? 0) <= 2 &&
    (aCfg?.sampleRate === 44100 || aCfg?.sampleRate === 48000);

  const remuxOk =
    !seg &&
    !settings.trim &&
    !settings.lcdBoost &&
    !settings.subtitleCues?.length &&
    !!vCfg &&
    vCfg.codec.startsWith("avc1") &&
    (vProf === 66 || vProf === 77) &&
    vLevel <= 30 &&
    dw > 0 &&
    dh > 0 &&
    dw <= preset.width &&
    dh <= preset.height &&
    fps > 0 &&
    fps <= 30.5 &&
    (!hasAudio || aCopyOk);

  const total = duration > 0 ? duration : 1;
  const rangeStart = settings.trim?.start ?? (seg?.start ?? 0);
  const rangeEnd = settings.trim?.end ?? (seg?.end ?? total);
  const segSpan = Math.max(0.001, rangeEnd - rangeStart);

  const makeTick =
    (pass: string) =>
    (frac: number, stage: string, stats?: ProgressStats): void => {
      report(
        Math.min(0.999, Math.max(0, frac)),
        `${pass} ${stage} ${srcInfo} → ${preset.label}… ${Math.round(frac * 100)}%`,
        stats,
      );
    };

  const remuxOnce = async (pass: string): Promise<ArrayBuffer> => {
    if (!vCfg) throw new Error("Missing video decoder config.");
    const decInput = new Input({
      source: new BlobSource(file, { maxCacheSize: cacheBytes }),
      formats: ALL_FORMATS,
    });
    const attemptOutput = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: new BufferTarget(),
    });
    try {
      const vTrack = await decInput.getPrimaryVideoTrack();
      if (!vTrack) throw new Error("No video track found in this file.");
      const aTrack = hasAudio ? audioTrack : null;
      if (hasAudio && (!aTrack || !aCfg)) throw new Error("Audio track unavailable.");
      const vSrc = new EncodedVideoPacketSource("avc");
      attemptOutput.addVideoTrack(vSrc);
      let aSrc: EncodedAudioPacketSource | null = null;
      if (aTrack) {
        aSrc = new EncodedAudioPacketSource("aac");
        attemptOutput.addAudioTrack(aSrc);
      }

      const metaTitle = settings.title || cleanPspTitle(file.name);
      if (thumbBytes) {
        attemptOutput.setMetadataTags({
          title: metaTitle,
          images: [{ data: thumbBytes, mimeType: "image/jpeg", kind: "coverFront" }],
        });
      } else {
        attemptOutput.setMetadataTags({ title: metaTitle });
      }

      await attemptOutput.start();
      const tick = makeTick(pass);
      let firstV = true;
      let pCount = 0;
      for await (const packet of new EncodedPacketSink(vTrack).packets()) {
        if (cancelled()) break;
        if (packet.timestamp < 0) continue;
        await vSrc.add(packet, firstV ? { decoderConfig: vCfg } : undefined);
        firstV = false;
        if (++pCount % 60 === 0) tick(0.9 * Math.min(1, packet.timestamp / total), "video");
      }
      if (aTrack && aSrc && aCfg && !cancelled()) {
        let firstA = true;
        let aPCount = 0;
        for await (const packet of new EncodedPacketSink(aTrack).packets()) {
          if (cancelled()) break;
          if (packet.timestamp < 0) continue;
          await aSrc.add(packet, firstA ? { decoderConfig: aCfg } : undefined);
          firstA = false;
          if (++aPCount % 60 === 0) tick(0.9 + 0.1 * Math.min(1, packet.timestamp / total), "audio");
        }
      }
      if (cancelled()) {
        await attemptOutput.cancel().catch(() => undefined);
        throw new Error("__cancelled__");
      }
      vSrc.close();
      aSrc?.close();
      await attemptOutput.finalize();
      const buf = attemptOutput.target.buffer;
      if (!buf) throw new Error("Remux produced no output.");
      return buf;
    } catch (e) {
      if (cancelled()) throw e;
      await attemptOutput.cancel().catch(() => undefined);
      throw e;
    }
  };

  const codecStrings: (string | undefined)[] = ["avc1.42E01E", "avc1.42001E", undefined];

  const encodeOnce = async (args: {
    preferHw: boolean;
    latency: "quality" | "realtime";
    pass: string;
  }): Promise<ArrayBuffer> => {
    const { preferHw, latency, pass } = args;
    report(0, `${pass} ${srcInfo} → ${preset.label}… 0%`);
    let lastErr: unknown = null;
    for (const fullCodecString of codecStrings) {
      const decInput = new Input({
        source: new BlobSource(file, { maxCacheSize: cacheBytes }),
        formats: ALL_FORMATS,
      });
      const attemptOutput = new Output({
        format: new Mp4OutputFormat({ fastStart: "in-memory" }),
        target: new BufferTarget(),
      });
      try {
        const vTrack = await decInput.getPrimaryVideoTrack();
        if (!vTrack) throw new Error("No video track found in this file.");
        const aTrack = hasAudio ? audioTrack : null;

        const videoSource = new VideoSampleSource({
          codec: "avc",
          quality: videoQuality,
          hardwareAcceleration: preferHw ? "prefer-hardware" : "prefer-software",
          latencyMode: latency,
          ...(fullCodecString ? { fullCodecString } : {}),
          transform: {
            width: preset.width,
            height: preset.height,
            fit: "contain",
            ...(fps > 31 ? { frameRate: 30000 / 1001 } : {}),
          },
        });
        attemptOutput.addVideoTrack(videoSource);

        let audioSource: AudioSampleSource | null = null;
        let audioPacketSource: EncodedAudioPacketSource | null = null;
        if (aTrack) {
          if (aCopyOk) {
            audioPacketSource = new EncodedAudioPacketSource("aac");
            attemptOutput.addAudioTrack(audioPacketSource);
          } else {
            audioSource = new AudioSampleSource({
              codec: "aac",
              quality: new Quality({ bitrate: settings.audioBitrate }),
              transform: { numberOfChannels: 2, sampleRate: 48000 },
            });
            attemptOutput.addAudioTrack(audioSource);
          }
        }

        const metaTitle = settings.title || cleanPspTitle(file.name);
        if (thumbBytes) {
          attemptOutput.setMetadataTags({
            title: metaTitle,
            images: [{ data: thumbBytes, mimeType: "image/jpeg", kind: "coverFront" }],
          });
        } else {
          attemptOutput.setMetadataTags({ title: metaTitle });
        }

        await attemptOutput.start();

        let vFrac = 0;
        let vFrames = 0;
        const targetFrameDuration = fps > 31 ? 1001 / 30000 : 0;
        let lastAlignedTs: number | null = null;
        let aFrac = aTrack && (audioSource || audioPacketSource) ? 0 : 1;
        const render = (stage: string, stats?: ProgressStats): void => {
          const frac = Math.min(0.999, 0.85 * vFrac + 0.15 * aFrac);
          report(
            frac,
            `${pass} ${stage} ${srcInfo} → ${preset.label}… ${Math.round(frac * 100)}%`,
            stats,
          );
        };

        const pumpVideo = async (): Promise<void> => {
          const vSink = new VideoSampleSink(vTrack, {
            hardwareAcceleration: decoderHw,
            optimizeForLatency: decoderLatency,
          });
          const queue = new PipelineQueue<VideoSample>(queueDepth);
          let decodeErr: unknown = null;
          let encodeErr: unknown = null;
          const tEncode0 = performance.now();

          const producer = async (): Promise<void> => {
            try {
              const stream = vSink.samples(rangeStart, rangeEnd);
              for await (const sample of stream) {
                if (cancelled() || encodeErr) {
                  sample.close();
                  break;
                }
                const ts = sample.timestamp;
                if (ts < 0) {
                  sample.close();
                  continue;
                }
                if (targetFrameDuration > 0) {
                  const alignedTs = Math.floor(ts / targetFrameDuration) * targetFrameDuration;
                  if (lastAlignedTs !== null && alignedTs <= lastAlignedTs) {
                    sample.close();
                    continue;
                  }
                  lastAlignedTs = alignedTs;
                }
                const accepted = await queue.push(sample);
                if (!accepted) {
                  sample.close();
                  break;
                }
              }
            } catch (err) {
              decodeErr = err;
            } finally {
              queue.close();
            }
          };

          const consumer = async (): Promise<void> => {
            let n = 0;
            let lastKeyTs = -999;
            try {
              while (true) {
                if (cancelled()) break;
                const sample = await queue.pop();
                if (!sample) break;
                try {
                  if ((tun.diagnostic ?? "full") === "decode") {
                    vFrac = Math.min(1, (sample.timestamp - rangeStart) / segSpan);
                  } else {
                    const isKey = n === 0 || sample.timestamp - lastKeyTs >= 2.0;
                    if (isKey) lastKeyTs = sample.timestamp;
                    await videoSource.add(sample, { keyFrame: isKey });
                    vFrac = Math.min(1, (sample.timestamp - rangeStart) / segSpan);
                  }
                  n++;
                  if (n % 30 === 0) {
                    const elapsedSec = (performance.now() - tEncode0) / 1000;
                    const curFps = elapsedSec > 0 ? n / elapsedSec : 0;
                    const curSpeed = elapsedSec > 0 ? (sample.timestamp - rangeStart) / elapsedSec : 0;
                    const eta = curSpeed > 0 ? Math.max(0, (rangeEnd - sample.timestamp) / curSpeed) : 0;
                    render("video", { fps: curFps, speed: curSpeed, eta });
                  }
                } finally {
                  sample.close();
                }
              }
            } catch (err) {
              encodeErr = err;
            }
            vFrames = n;
            vFrac = 1;
            render("video");
          };

          try {
            await Promise.all([producer(), consumer()]);
          } finally {
            for (const leftover of queue.drain()) {
              leftover.close();
            }
          }
          if (decodeErr) throw decodeErr;
          if (encodeErr) throw encodeErr;
        };

        const pumpAudio = async (): Promise<void> => {
          if (!aTrack) return;
          try {
          if (audioPacketSource && aCfg) {
            const aSink = new EncodedPacketSink(aTrack);
            let firstA = true;
            let n = 0;
            for await (const packet of aSink.packets()) {
              if (cancelled()) return;
              if (packet.timestamp < rangeStart || packet.timestamp > rangeEnd) continue;
              await audioPacketSource.add(packet, firstA ? { decoderConfig: aCfg } : undefined);
              firstA = false;
              aFrac = Math.min(1, (packet.timestamp - rangeStart) / segSpan);
              if (++n % 50 === 0) render("audio");
            }
            aFrac = 1;
            render("audio");
          } else if (audioSource) {
            const aSink = new AudioSampleSink(aTrack);
            let n = 0;
            for await (const sample of aSink.samples(rangeStart, rangeEnd)) {
              if (cancelled()) {
                sample.close();
                return;
              }
              const ts = sample.timestamp;
              if (ts < 0) {
                sample.close();
                continue;
              }
              await audioSource.add(sample);
              sample.close();
              aFrac = Math.min(1, (ts - rangeStart) / segSpan);
              if (++n % 50 === 0) render("audio");
            }
            aFrac = 1;
            render("audio");
          }
          } catch (audioErr) {
            console.warn("Audio processing encountered an issue; completing stream safely:", audioErr);
            aFrac = 1;
            render("video");
          }
        };

        await Promise.all([pumpVideo(), pumpAudio()]);

        if (cancelled()) {
          await attemptOutput.cancel().catch(() => undefined);
          throw new Error("__cancelled__");
        }
        videoSource.close();
        audioPacketSource?.close();
        audioSource?.close();
        await attemptOutput.finalize();
        const buf = attemptOutput.target.buffer;
        if (!buf) throw new Error("Encoder produced no output.");
        return buf;
      } catch (e) {
        if (cancelled()) throw e;
        lastErr = e;
        await attemptOutput.cancel().catch(() => undefined);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("Could not initialize the encoder.");
  };

  let buffer: ArrayBuffer | null = null;
  let how = "";
  if (remuxOk && !cancelled()) {
    try {
      buffer = await remuxOnce("remuxing");
      how = "remuxed";
    } catch (e) {
      if (cancelled()) throw e;
      buffer = null;
    }
  }
  if (!buffer && !cancelled()) {
    if (settings.encoderMode === "software") {
      buffer = await encodeOnce({ preferHw: false, latency: "quality", pass: "converting (software)" });
      how = "software";
    } else if (settings.encoderMode === "turbo") {
      try {
        buffer = await encodeOnce({ preferHw: true, latency: "realtime", pass: "converting (turbo)" });
        how = "turbo";
      } catch (hwErr) {
        if (cancelled()) throw hwErr;
        console.warn("Hardware turbo encode failed, auto-falling back to software:", hwErr);
        report(0, "Hardware encoder unavailable, switching to software…");
        buffer = await encodeOnce({
          preferHw: false,
          latency: "quality",
          pass: "software fallback",
        });
        how = "software-fallback";
      }
      const prof = parseAvcProfile(buffer);
      if (!cancelled() && (!prof || prof.profileIdc !== 66 || prof.levelIdc > 30)) {
        buffer = await encodeOnce({
          preferHw: false,
          latency: "quality",
          pass: "turbo gave non-Baseline, re-encoding (software)",
        });
        how = "turbo→software";
      }
    } else {
      try {
        buffer = await encodeOnce({ preferHw: true, latency: latencyMode, pass: "converting (hardware)" });
        how = "hardware";
      } catch (hwErr) {
        if (cancelled()) throw hwErr;
        console.warn("Hardware encode failed, auto-falling back to software:", hwErr);
        report(0, "Hardware encoder unavailable, switching to software…");
        buffer = await encodeOnce({
          preferHw: false,
          latency: "quality",
          pass: "software fallback",
        });
        how = "software-fallback";
      }
      const prof = parseAvcProfile(buffer);
      if (!cancelled() && (!prof || prof.profileIdc !== 66 || prof.levelIdc > 30)) {
        buffer = await encodeOnce({
          preferHw: false,
          latency: "quality",
          pass: "hardware gave non-Baseline, re-encoding (software)",
        });
        how = "hardware→software";
      }
    }
  }
  if (cancelled()) throw new Error("__cancelled__");
  if (!buffer) throw new Error("No output produced.");

  const badge = profileBadge(parseAvcProfile(buffer));
  const secs = (performance.now() - t0) / 1000;
  const probeSecs = (tProbe - t0) / 1000;
  const dims = `${preset.width}×${preset.height}`;
  const doneNote =
    `done — ${srcInfo} → ${dims}` +
    (capped ? ` · capped to source ~${Math.round(effVideoBitrate / 1000)}k` : "") +
    (settings.lcdBoost ? " · LCD Boosted" : "") +
    ` · ${how} in ${secs.toFixed(1)}s (probe ${probeSecs.toFixed(1)}s)`;

  return {
    buffer,
    thmBuffer: thumbBytes ? (thumbBytes.buffer.slice(0) as ArrayBuffer) : undefined,
    profileText: badge.text,
    profileCls: badge.cls,
    srcInfo,
    dims,
    how,
    secs,
    outSize: buffer.byteLength,
    doneNote,
    hasSubtitles,
  };
}

// ---------- segmented transcoding (parallel workers) ----------

export interface SegmentPlan {
  segments: SegmentRange[];
  srcInfo: string;
  duration: number;
  fps: number;
}

/** Compute keyframe-aligned segment boundaries for k roughly-equal segments. */
export async function planSegments(file: File, k: number, trim?: { start: number; end: number }): Promise<SegmentPlan> {
  const input = new Input({ source: new BlobSource(file, { maxCacheSize: 64 * 1024 * 1024 }), formats: ALL_FORMATS });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error("No video track found in this file.");
  const duration = await input.computeDuration().catch(() => -1);
  if (!(duration > 0)) throw new Error("Cannot determine duration for segmented conversion.");

  const startBound = trim?.start ?? 0;
  const endBound = trim?.end ?? duration;
  const span = Math.max(1, endBound - startBound);

  const [metrics, dw, dh] = await Promise.all([
    videoTrack.computeFrameRateMetrics({ targetPacketCount: 64 }).catch(() => null),
    videoTrack.getDisplayWidth().catch(() => 0),
    videoTrack.getDisplayHeight().catch(() => 0),
  ]);
  const fps = metrics?.bestGuessFrameRate ?? 0;
  const srcInfo = `${dw || "?"}×${dh || "?"}${fps ? ` @ ${fps.toFixed(1)}fps` : ""} · ${fmtTime(duration)}`;

  const sink = new EncodedPacketSink(videoTrack);
  const bounds: number[] = [startBound];
  for (let i = 1; i < k; i++) {
    const target = startBound + (span * i) / k;
    let ts = target;
    try {
      const pkt = await sink.getKeyPacket(target, { metadataOnly: true });
      if (pkt && pkt.timestamp > bounds[bounds.length - 1] + 1) ts = pkt.timestamp;
    } catch {
      /* keep plain boundary */
    }
    bounds.push(ts);
  }
  bounds.push(endBound);
  const segments: SegmentRange[] = [];
  for (let i = 0; i < k; i++) {
    if (bounds[i + 1] > bounds[i]) segments.push({ start: bounds[i], end: bounds[i + 1] });
  }
  return { segments, srcInfo, duration: span, fps };
}

// ---------- streaming segmented pipeline (packets muxed while segments encode) ----------

export interface WirePacket {
  type: "key" | "delta";
  timestamp: number;
  duration: number;
  data: ArrayBuffer;
}

interface QueuedPacket {
  type: "key" | "delta";
  timestamp: number;
  duration: number;
  data: Uint8Array;
  decoderConfig?: VideoDecoderConfig;
}

let segCanvas: OffscreenCanvas | null = null;
let segCtx: OffscreenCanvasRenderingContext2D | null = null;

function drawScaledToVideoFrame(
  sample: VideoSample,
  w: number,
  h: number,
  lcdBoost?: boolean,
  activeSubText?: string,
): VideoFrame {
  if (!segCanvas || segCanvas.width !== w || segCanvas.height !== h) {
    segCanvas = new OffscreenCanvas(w, h);
    segCtx = segCanvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
      willReadFrequently: false,
    }) as OffscreenCanvasRenderingContext2D | null;
  }
  if (!segCtx) throw new Error("Could not acquire 2D context for scaling.");
  segCtx.imageSmoothingQuality = "medium";
  segCtx.filter = lcdBoost ? "contrast(1.14) brightness(1.06)" : "none";
  segCtx.fillStyle = "#000";
  segCtx.fillRect(0, 0, w, h);
  sample.drawWithFit(segCtx, { fit: "contain" });
  if (activeSubText) {
    renderSubtitle(segCtx, activeSubText, w, h);
  }
  return new VideoFrame(segCanvas, {
    timestamp: Math.round(sample.timestamp * 1e6),
    duration: Math.round(Math.max(0, sample.duration) * 1e6),
  });
}

/**
 * Encode one segment with a direct WebCodecs VideoEncoder, streaming encoded
 * packets to the coordinator as they are produced (no intermediate MP4).
 */
export async function encodeSegmentDirect(
  file: File,
  settings: ConvertSettings,
  seg: SegmentRange,
  hooks: ConvertHooks,
  sendPacket: (p: WirePacket) => void,
  sendDecoderConfig: (config: VideoDecoderConfig) => void,
): Promise<void> {
  const preset = PRESETS[settings.preset];
  const tun = settings.tunables ?? {};
  const cancelled = (): boolean => isCancelled(hooks);
  const report = (frac: number, label: string): void => {
    if (!cancelled()) hooks.onProgress(frac, label);
  };

  const input = new Input({ source: new BlobSource(file, { maxCacheSize: 64 * 1024 * 1024 }), formats: ALL_FORMATS });
  const vTrack = await input.getPrimaryVideoTrack();
  if (!vTrack) throw new Error("No video track found in this file.");
  const [metrics, duration] = await Promise.all([
    vTrack.computeFrameRateMetrics({ targetPacketCount: 64 }).catch(() => null),
    input.computeDuration().catch(() => -1),
  ]);
  const fps = metrics?.bestGuessFrameRate ?? 0;
  const quantizer = resolveQuantizer(settings.videoBitrate);
  const effVideoBitrate = computeEffectiveBitrate(file, duration, settings.videoBitrate, true);

  const sink = new VideoSampleSink(vTrack, {
    hardwareAcceleration: tun.decoderHw ?? "prefer-hardware",
    optimizeForLatency: tun.decoderLatency ?? false,
  });

  let encodeErr: unknown = null;
  let configSent = false;
  const fallbackDurationUs = fps > 0 ? Math.round(1e6 / fps) : 0;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig && !configSent) {
        configSent = true;
        sendDecoderConfig(meta.decoderConfig);
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      sendPacket({
        type: chunk.type,
        timestamp: chunk.timestamp,
        duration: chunk.duration || fallbackDurationUs,
        data: data.buffer,
      });
    },
    error: (e) => {
      encodeErr = e;
    },
  });

  const baseConfig = {
    codec: "avc1.42E01E",
    width: preset.width,
    height: preset.height,
    latencyMode: tun.latencyMode ?? "realtime",
    hardwareAcceleration: "prefer-hardware",
    avc: { format: "avc" as const },
  };
  let useQuantizer = true;
  let config: VideoEncoderConfig = {
    ...baseConfig,
    bitrateMode: "quantizer",
  } as unknown as VideoEncoderConfig;
  let support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) {
    useQuantizer = false;
    config = {
      ...baseConfig,
      bitrate: effVideoBitrate,
      bitrateMode: "variable",
    } as unknown as VideoEncoderConfig;
    support = await VideoEncoder.isConfigSupported(config);
    if (!support.supported) throw new Error("No supported H.264 encoder configuration.");
  }
  encoder.configure(config);

  const encodeKeyFrame = (isKey: boolean): VideoEncoderEncodeOptions =>
    useQuantizer
      ? ({ keyFrame: isKey, avc: { quantizer } } as VideoEncoderEncodeOptions)
      : { keyFrame: isKey };

  const targetFrameDuration = fps > 31 ? 1001 / 30000 : 0;
  let lastAlignedTs: number | null = null;
  let first = true;
  let lastKeyTs = -999;
  const total = seg.end - seg.start;

  try {
    for await (const sample of sink.samples(seg.start, seg.end)) {
      if (cancelled() || encodeErr) {
        sample.close();
        break;
      }
      const ts = sample.timestamp;
      if (ts < 0) {
        sample.close();
        continue;
      }
      if (targetFrameDuration > 0) {
        const alignedTs = Math.floor(ts / targetFrameDuration) * targetFrameDuration;
        if (lastAlignedTs !== null && alignedTs <= lastAlignedTs) {
          sample.close();
          continue;
        }
        lastAlignedTs = alignedTs;
      }
      const isKey = first || ts - lastKeyTs >= 2.0;
      if (isKey) lastKeyTs = ts;

      const frame = drawScaledToVideoFrame(sample, preset.width, preset.height, settings.lcdBoost);
      encoder.encode(frame, encodeKeyFrame(isKey));
      first = false;
      frame.close();
      sample.close();
      report(Math.min(0.999, (ts - seg.start) / total), "converting segment");
      while (encoder.encodeQueueSize > 16) {
        await new Promise<void>((r) => setTimeout(r, 2));
        if (encodeErr) break;
      }
    }
  } finally {
    await encoder.flush().catch(() => undefined);
    encoder.close();
  }
  if (encodeErr) throw encodeErr;
}

/**
 * In-order MP4 muxer for streamed segment packets: video packets are added to
 * the output while later segments are still encoding; audio (from the
 * original file) is muxed concurrently.
 */
export class SegmentedMuxer {
  private queues: QueuedPacket[][] = [];
  private segOpen: boolean[] = [];
  private muxIndex = 0;
  private waiters: (() => void)[] = [];
  private output!: Output<Mp4OutputFormat, BufferTarget>;
  private vSrc!: EncodedVideoPacketSource;
  private pumpDone?: Promise<void>;
  private audioDone?: Promise<void>;
  private firstPacket = true;
  public thumbBytes: Uint8Array | null = null;

  constructor(
    private readonly file: File,
    private readonly settings: ConvertSettings,
    private readonly hooks: ConvertHooks,
    private readonly expectedSegments: number,
    private readonly duration: number,
  ) {
    for (let i = 0; i < expectedSegments; i++) {
      this.queues.push([]);
      this.segOpen.push(true);
    }
  }

  private cancelled(): boolean {
    return isCancelled(this.hooks);
  }

  async init(): Promise<void> {
    if (!(await canEncodeAudio("aac"))) {
      try {
        registerAacEncoder();
      } catch {
        /* ignore */
      }
    }

    this.thumbBytes = await extractThumbnail(
      this.file,
      this.settings.trim?.start ? this.settings.trim.start + 5 : 5,
    );

    const input = new Input({ source: new BlobSource(this.file, { maxCacheSize: 64 * 1024 * 1024 }), formats: ALL_FORMATS });
    const aTracks = await input.getAudioTracks().catch(() => []);
    let audioTrack = aTracks[this.settings.audioTrackIndex ?? 0] ?? null;
    if (!audioTrack && aTracks.length > 0) audioTrack = aTracks[0];
    const aCfg = audioTrack ? await audioTrack.getDecoderConfig().catch(() => null) : null;

    const aCopyOk =
      !!audioTrack &&
      !this.settings.trim &&
      aCfg?.codec === "mp4a.40.2" &&
      (aCfg?.numberOfChannels ?? 0) <= 2 &&
      (aCfg?.sampleRate === 44100 || aCfg?.sampleRate === 48000);

    this.output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: new BufferTarget(),
    });
    this.vSrc = new EncodedVideoPacketSource("avc");
    this.output.addVideoTrack(this.vSrc);

    let audioPacketSource: EncodedAudioPacketSource | null = null;
    let audioSource: AudioSampleSource | null = null;
    if (audioTrack) {
      if (aCopyOk && aCfg) {
        audioPacketSource = new EncodedAudioPacketSource("aac");
        this.output.addAudioTrack(audioPacketSource);
      } else {
        audioSource = new AudioSampleSource({
          codec: "aac",
          quality: new Quality({ bitrate: this.settings.audioBitrate }),
          transform: { numberOfChannels: 2, sampleRate: 48000 },
        });
        this.output.addAudioTrack(audioSource);
      }
    }

    const metaTitle = this.settings.title || cleanPspTitle(this.file.name);
    if (this.thumbBytes) {
      this.output.setMetadataTags({
        title: metaTitle,
        images: [{ data: this.thumbBytes, mimeType: "image/jpeg", kind: "coverFront" }],
      });
    } else {
      this.output.setMetadataTags({ title: metaTitle });
    }

    await this.output.start();

    const total = this.duration > 0 ? this.duration : 1;
    const report = (frac: number, label: string, stats?: ProgressStats): void => {
      if (!this.cancelled()) this.hooks.onProgress(frac, label, stats);
    };

    const trimStart = this.settings.trim?.start ?? 0;
    const trimEnd = this.settings.trim?.end ?? total;

    this.audioDone = (async (): Promise<void> => {
      if (!audioTrack) return;
      if (audioPacketSource && aCfg) {
        const aSink = new EncodedPacketSink(audioTrack);
        let firstA = true;
        for await (const packet of aSink.packets()) {
          if (this.cancelled()) return;
          if (packet.timestamp < trimStart || packet.timestamp > trimEnd) continue;
          await audioPacketSource.add(packet, firstA ? { decoderConfig: aCfg } : undefined);
          firstA = false;
        }
      } else if (audioSource) {
        const aSink = new AudioSampleSink(audioTrack);
        for await (const sample of aSink.samples(trimStart, trimEnd)) {
          if (this.cancelled()) {
            sample.close();
            return;
          }
          if (sample.timestamp < 0) {
            sample.close();
            continue;
          }
          await audioSource.add(sample);
          sample.close();
        }
      }
    })();

    const tMux0 = performance.now();
    let muxedFrames = 0;

    this.pumpDone = (async (): Promise<void> => {
      while (this.muxIndex < this.expectedSegments) {
        const q = this.queues[this.muxIndex];
        if (q.length > 0) {
          const p = q.shift()!;
          const packet = new EncodedPacket(p.data, p.type, p.timestamp, p.duration);
          await this.vSrc.add(
            packet,
            this.firstPacket && p.decoderConfig ? { decoderConfig: p.decoderConfig } : undefined,
          );
          this.firstPacket = false;
          muxedFrames++;
          if (muxedFrames % 30 === 0) {
            const elapsedSec = (performance.now() - tMux0) / 1000;
            const curFps = elapsedSec > 0 ? muxedFrames / elapsedSec : 0;
            const curSpeed = elapsedSec > 0 ? (p.timestamp - trimStart) / elapsedSec : 0;
            const eta = curSpeed > 0 ? Math.max(0, (trimEnd - p.timestamp) / curSpeed) : 0;
            report(0.9 * Math.min(0.999, (p.timestamp - trimStart) / total), "converting — muxing", {
              fps: curFps,
              speed: curSpeed,
              eta,
            });
          }
          continue;
        }
        if (!this.segOpen[this.muxIndex]) {
          this.muxIndex++;
          continue;
        }
        await new Promise<void>((r) => this.waiters.push(r));
      }
    })();
  }

  private notify(): void {
    while (this.waiters.length > 0) this.waiters.shift()!();
  }

  async addPacket(segIndex: number, p: WirePacket, decoderConfig?: VideoDecoderConfig): Promise<void> {
    this.queues[segIndex].push({
      type: p.type,
      timestamp: p.timestamp / 1e6,
      duration: p.duration / 1e6,
      data: new Uint8Array(p.data),
      decoderConfig,
    });
    this.notify();
  }

  markSegmentDone(segIndex: number): void {
    this.segOpen[segIndex] = false;
    this.notify();
  }

  async finalize(): Promise<ArrayBuffer> {
    await this.pumpDone;
    await this.audioDone;
    if (this.cancelled()) throw new Error("__cancelled__");
    this.vSrc.close();
    await this.output.finalize();
    const buf = this.output.target.buffer;
    if (!buf) throw new Error("Muxer produced no output.");
    return buf;
  }

  async abort(): Promise<void> {
    await this.output.cancel().catch(() => undefined);
  }
}

// ---------- series / multi-file marathon merger ----------

export async function convertMergedFiles(
  files: File[],
  settings: ConvertSettings,
  hooks: ConvertHooks,
): Promise<ConvertResult> {
  if (files.length === 0) throw new Error("No files provided for merge.");
  const preset = PRESETS[settings.preset];
  const t0 = performance.now();
  const cancelled = (): boolean => isCancelled(hooks);

  if (!(await canEncodeAudio("aac"))) {
    try {
      registerAacEncoder();
    } catch {
      /* ignore */
    }
  }

  // 1. Probe all files
  let totalDuration = 0;
  const fileInfos: { file: File; duration: number; fps: number; dw: number; dh: number }[] = [];
  for (const f of files) {
    const input = new Input({ source: new BlobSource(f), formats: ALL_FORMATS });
    const vTrack = await input.getPrimaryVideoTrack();
    if (!vTrack) throw new Error(`File ${f.name} has no video track.`);
    const [dur, metrics, dw, dh] = await Promise.all([
      input.computeDuration().catch(() => 0),
      vTrack.computeFrameRateMetrics({ targetPacketCount: 64 }).catch(() => null),
      vTrack.getDisplayWidth().catch(() => 0),
      vTrack.getDisplayHeight().catch(() => 0),
    ]);
    const fileDur = dur > 0 ? dur : 1;
    totalDuration += fileDur;
    fileInfos.push({
      file: f,
      duration: fileDur,
      fps: metrics?.bestGuessFrameRate ?? 24,
      dw,
      dh,
    });
  }

  const thumbBytes = await extractThumbnail(files[0], 5);

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target: new BufferTarget(),
  });

  const mergedTitle = settings.title || cleanPspTitle(files[0].name) + " (Marathon)";
  if (thumbBytes) {
    output.setMetadataTags({
      title: mergedTitle,
      images: [{ data: thumbBytes, mimeType: "image/jpeg", kind: "coverFront" }],
    });
  } else {
    output.setMetadataTags({ title: mergedTitle });
  }

  const quantizer = resolveQuantizer(settings.videoBitrate);
  const videoQuality = new Quality({ quantizer, bitrate: settings.videoBitrate });

  const videoSource = new VideoSampleSource({
    codec: "avc",
    quality: videoQuality,
    hardwareAcceleration: "prefer-hardware",
    latencyMode: "realtime",
    fullCodecString: "avc1.42E01E",
    transform: {
      width: preset.width,
      height: preset.height,
      fit: "contain",
      frameRate: 30000 / 1001,
    },
  });
  output.addVideoTrack(videoSource);

  const audioSource = new AudioSampleSource({
    codec: "aac",
    quality: new Quality({ bitrate: settings.audioBitrate }),
    transform: { numberOfChannels: 2, sampleRate: 48000 },
  });
  output.addAudioTrack(audioSource);

  await output.start();

  let timeOffset = 0;
  let totalProcessedSec = 0;
  const tEncode0 = performance.now();

  for (let idx = 0; idx < fileInfos.length; idx++) {
    if (cancelled()) break;
    const info = fileInfos[idx];
    const file = info.file;
    const input = new Input({
      source: new BlobSource(file, { maxCacheSize: 64 * 1024 * 1024 }),
      formats: ALL_FORMATS,
    });
    const vTrack = await input.getPrimaryVideoTrack();
    const aTrack = await input.getPrimaryAudioTrack().catch(() => null);
    if (!vTrack) continue;

    const vSink = new VideoSampleSink(vTrack, { hardwareAcceleration: "prefer-hardware" });
    const targetFrameDuration = 1001 / 30000;
    let lastAlignedTs: number | null = null;
    let fileMaxTs = 0;
    let frameCount = 0;
    let lastKeyTs = -999;

    for await (const sample of vSink.samples()) {
      if (cancelled()) {
        sample.close();
        break;
      }
      const ts = sample.timestamp;
      if (ts < 0) {
        sample.close();
        continue;
      }
      const alignedTs = Math.floor(ts / targetFrameDuration) * targetFrameDuration;
      if (lastAlignedTs !== null && alignedTs <= lastAlignedTs) {
        sample.close();
        continue;
      }
      lastAlignedTs = alignedTs;
      if (ts > fileMaxTs) fileMaxTs = ts;

      const shiftedTs = alignedTs + timeOffset;
      const isKey = frameCount === 0 || shiftedTs - lastKeyTs >= 2.0;
      if (isKey) lastKeyTs = shiftedTs;

      sample.setTimestamp(shiftedTs);
      sample.setDuration(targetFrameDuration);
      await videoSource.add(sample, { keyFrame: isKey });
      sample.close();
      frameCount++;

      if (frameCount % 45 === 0) {
        const curGlobalTs = timeOffset + ts;
        const frac = Math.min(0.999, curGlobalTs / totalDuration);
        const elapsedSec = (performance.now() - tEncode0) / 1000;
        const curFps = elapsedSec > 0 ? (totalProcessedSec * 30 + frameCount) / elapsedSec : 0;
        const curSpeed = elapsedSec > 0 ? curGlobalTs / elapsedSec : 0;
        const eta = curSpeed > 0 ? Math.max(0, (totalDuration - curGlobalTs) / curSpeed) : 0;
        hooks.onProgress(frac, `merging ep ${idx + 1}/${fileInfos.length} (${Math.round(frac * 100)}%)`, {
          fps: curFps,
          speed: curSpeed,
          eta,
        });
      }
    }

    if (aTrack) {
      const aSink = new AudioSampleSink(aTrack);
      for await (const aSample of aSink.samples()) {
        if (cancelled()) {
          aSample.close();
          break;
        }
        aSample.setTimestamp(aSample.timestamp + timeOffset);
        await audioSource.add(aSample);
        aSample.close();
      }
    }

    const advanceBy = fileMaxTs > 0 ? fileMaxTs + targetFrameDuration : info.duration;
    timeOffset += advanceBy;
    totalProcessedSec += advanceBy;
  }

  if (cancelled()) {
    await output.cancel().catch(() => undefined);
    throw new Error("__cancelled__");
  }

  videoSource.close();
  audioSource.close();
  await output.finalize();
  const buffer = output.target.buffer;
  if (!buffer) throw new Error("Merge produced no output.");

  const secs = (performance.now() - t0) / 1000;
  const badge = profileBadge(parseAvcProfile(buffer));
  const dims = `${preset.width}×${preset.height}`;

  return {
    buffer,
    thmBuffer: thumbBytes ? (thumbBytes.buffer.slice(0) as ArrayBuffer) : undefined,
    profileText: badge.text,
    profileCls: badge.cls,
    srcInfo: `${fileInfos.length} files · ${fmtTime(totalDuration)}`,
    dims,
    how: `merged×${fileInfos.length}`,
    secs,
    outSize: buffer.byteLength,
    doneNote: `done — ${fileInfos.length} files merged into 1 marathon video (${fmtTime(totalDuration)}) in ${secs.toFixed(1)}s`,
  };
}
