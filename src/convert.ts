import {
  ALL_FORMATS,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSampleSink,
  VideoSampleSource,
  VideoSample,
  registerVideoSampleTransformer,
  canEncodeAudio,
} from "mediabunny";
import { registerAacEncoder } from "@mediabunny/aac-encoder";

let fastCanvas: OffscreenCanvas | null = null;
let fastCtx: OffscreenCanvasRenderingContext2D | null = null;

if (typeof OffscreenCanvas !== "undefined") {
  registerVideoSampleTransformer((sample, desc) => {
    if (desc.rotation !== 0 || desc.crop !== undefined) return null;
    const w = desc.width;
    const h = desc.height;
    if (!fastCanvas || fastCanvas.width !== w || fastCanvas.height !== h) {
      fastCanvas = new OffscreenCanvas(w, h);
      fastCtx = fastCanvas.getContext("2d", { alpha: false, willReadFrequently: false }) as OffscreenCanvasRenderingContext2D | null;
    }
    if (!fastCtx) return null;
    fastCtx.imageSmoothingQuality = "medium";
    fastCtx.fillStyle = "#000";
    fastCtx.fillRect(0, 0, w, h);
    sample.drawWithFit(fastCtx, { fit: desc.fit });
    return new VideoSample(fastCanvas, {
      timestamp: sample.timestamp,
      duration: sample.duration,
    });
  });
}


export const PRESETS = {
  go: { width: 480, height: 272, label: "Go 480×272" },
  tv: { width: 720, height: 480, label: "TV 720×480" },
} as const;

export type PresetName = keyof typeof PRESETS;

export interface ConvertSettings {
  preset: PresetName;
  videoBitrate: number;
  audioBitrate: number;
  encoderMode: "auto" | "software" | "turbo";
}

export interface ConvertHooks {
  onProgress: (frac: number, label: string) => void;
  isCancelled: () => boolean;
}

export interface ConvertResult {
  buffer: ArrayBuffer;
  profileText: string;
  profileCls: string;
  srcInfo: string;
  dims: string;
  how: string;
  secs: number;
  outSize: number;
  doneNote: string;
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
      // avcC content: version(1) profile(1) compatibility(1) level(1) …
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

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m > 0 ? `${m}:${String(sec).padStart(2, "0")}` : `${sec}s`;
}

function isCancelled(hooks: ConvertHooks): boolean {
  return hooks.isCancelled();
}

export async function convertFile(
  file: File,
  settings: ConvertSettings,
  hooks: ConvertHooks,
): Promise<ConvertResult> {
  const preset = PRESETS[settings.preset];
  const t0 = performance.now();
  const cancelled = (): boolean => isCancelled(hooks);

  if (!(await canEncodeAudio("aac"))) {
    try {
      registerAacEncoder(); // software AAC fallback (e.g. Firefox)
    } catch {
      /* ignore */
    }
  }

  const report = (frac: number, label: string): void => {
    if (!cancelled()) hooks.onProgress(frac, label);
  };

  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error("No video track found in this file.");

  const [metrics, dw, dh, duration, vCfg] = await Promise.all([
    // 64 packets is plenty for an fps estimate; 256 (default) just burns decode time.
    videoTrack.computeFrameRateMetrics({ targetPacketCount: 64 }).catch(() => null),
    videoTrack.getDisplayWidth().catch(() => 0),
    videoTrack.getDisplayHeight().catch(() => 0),
    input.computeDuration().catch(() => -1),
    videoTrack.getDecoderConfig().catch(() => null),
  ]);
  const fps = metrics?.bestGuessFrameRate ?? 0;
  const srcInfo = `${dw || "?"}×${dh || "?"}${fps ? ` @ ${fps.toFixed(1)}fps` : ""}${
    duration > 0 ? ` · ${fmtTime(duration)}` : ""
  }`;

  const audioTrack = await input.getPrimaryAudioTrack().catch(() => null);
  const aCfg = audioTrack ? await audioTrack.getDecoderConfig().catch(() => null) : null;
  const tProbe = performance.now();

  if (cancelled()) throw new Error("__cancelled__");

  // Never spend more bits than the source already has: a squeezed 90-min
  // movie can sit below our bitrate target, and re-encoding higher only
  // grows the file with no quality gain (the Shrek case).
  const hasAudio = !!audioTrack;
  const srcTotalBitrate = duration > 0 ? (file.size * 8) / duration : 0;
  const srcVideoBitrate = hasAudio ? Math.max(0, srcTotalBitrate - 128e3) : srcTotalBitrate;
  // Constant-quality (quantizer, like ffmpeg CRF) instead of pure bitrate
  // targeting: easy content collapses to tiny files automatically, hard
  // content gets the bits it needs. `bitrate` stays as the fallback for
  // encoders without quantizer support.
  const QP_BY_TARGET: Record<number, number> = { 600000: 28, 800000: 25, 1200000: 22 };
  const quantizer = QP_BY_TARGET[settings.videoBitrate] ?? 25;
  const effVideoBitrate =
    srcVideoBitrate > 0 ? Math.min(settings.videoBitrate, Math.round(srcVideoBitrate)) : settings.videoBitrate;
  const capped = effVideoBitrate < settings.videoBitrate;
  const videoQuality = new Quality({ quantizer, bitrate: effVideoBitrate });

  // Remux fast path: if the source is already PSP-native (right codec,
  // profile, level, size, fps, audio), just repackage the packets — ~100x
  // realtime with zero quality loss instead of re-encoding.
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
    (!hasAudio ||
      (aCfg?.codec === "mp4a.40.2" &&
        (aCfg?.numberOfChannels ?? 0) <= 2 &&
        (aCfg?.sampleRate === 44100 || aCfg?.sampleRate === 48000)));

  const total = duration > 0 ? duration : 1;
  const makeTick =
    (pass: string) =>
    (frac: number, stage: string): void => {
      report(
        Math.min(0.999, Math.max(0, frac)),
        `${pass} ${stage} ${srcInfo} → ${preset.label}… ${Math.round(frac * 100)}%`,
      );
    };

  // Packet-copy remux for already-compliant sources (see remuxOk above).
  const remuxOnce = async (pass: string): Promise<ArrayBuffer> => {
    if (!vCfg) throw new Error("Missing video decoder config.");
    const decInput = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const attemptOutput = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: new BufferTarget(),
    });
    try {
      const vTrack = await decInput.getPrimaryVideoTrack();
      if (!vTrack) throw new Error("No video track found in this file.");
      const aTrack = hasAudio ? await decInput.getPrimaryAudioTrack().catch(() => null) : null;
      if (hasAudio && (!aTrack || !aCfg)) throw new Error("Audio track unavailable.");
      const vSrc = new EncodedVideoPacketSource("avc");
      attemptOutput.addVideoTrack(vSrc);
      let aSrc: EncodedAudioPacketSource | null = null;
      if (aTrack) {
        aSrc = new EncodedAudioPacketSource("aac");
        attemptOutput.addAudioTrack(aSrc);
      }
      await attemptOutput.start();
      const tick = makeTick(pass);
      let firstV = true;
      for await (const packet of new EncodedPacketSink(vTrack).packets()) {
        if (cancelled()) break;
        if (packet.timestamp < 0) continue;
        await vSrc.add(packet, firstV ? { decoderConfig: vCfg } : undefined);
        firstV = false;
        tick(0.9 * Math.min(1, packet.timestamp / total), "video");
      }
      if (aTrack && aSrc && aCfg && !cancelled()) {
        let firstA = true;
        for await (const packet of new EncodedPacketSink(aTrack).packets()) {
          if (cancelled()) break;
          if (packet.timestamp < 0) continue;
          await aSrc.add(packet, firstA ? { decoderConfig: aCfg } : undefined);
          firstA = false;
          tick(0.9 + 0.1 * Math.min(1, packet.timestamp / total), "audio");
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

  // Candidate codec strings, most PSP-compatible first. WebCodecs encoders
  // pick their own profile unless asked: 'avc1.42E01E' demands Constrained
  // Baseline L3.0. (Note: Conversion.init has no fullCodecString option, so
  // we drive VideoSampleSource directly — its VideoEncodingConfig honors it.)
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
      const decInput = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
      const attemptOutput = new Output({
        format: new Mp4OutputFormat({ fastStart: "in-memory" }),
        target: new BufferTarget(),
      });
      try {
        const vTrack = await decInput.getPrimaryVideoTrack();
        if (!vTrack) throw new Error("No video track found in this file.");
        const aTrack = hasAudio ? await decInput.getPrimaryAudioTrack().catch(() => null) : null;

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
            // PSP hardware tops out ~29.97fps; only downsample high-fps sources.
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

        await attemptOutput.start();

        const tick = makeTick(pass);
        // Pump audio + video concurrently: decode/encode of the two tracks
        // overlap instead of running back-to-back.
        let vFrac = 0;
        let vFrames = 0;
        const targetFrameDuration = fps > 31 ? 1001 / 30000 : 0;
        let lastAlignedTs: number | null = null;
        let tVideoAddTotal = 0;
        let tVideoIterTotal = 0;
        let aFrac = aTrack && (audioSource || audioPacketSource) ? 0 : 1;
          const render = (stage: string): void => {
            const frac = Math.min(0.999, 0.85 * vFrac + 0.15 * aFrac);
            report(
              frac,
              `${pass} ${stage} ${srcInfo} → ${preset.label}… ${Math.round(frac * 100)}%`,
            );
          };
        const pumpVideo = async (): Promise<void> => {
          const vSink = new VideoSampleSink(vTrack, { hardwareAcceleration: preferHw ? "prefer-hardware" : "prefer-software" });
          let n = 0;
          let tIter0 = performance.now();
          for await (const sample of vSink.samples()) {
            tVideoIterTotal += performance.now() - tIter0;
            if (cancelled()) {
              sample.close();
              return;
            }
            const ts = sample.timestamp;
            if (ts < 0) {
              sample.close(); // pre-roll frames (edit lists) — encoder wants t >= 0
              tIter0 = performance.now();
              continue;
            }
            if (targetFrameDuration > 0) {
              const alignedTs = Math.floor(ts / targetFrameDuration) * targetFrameDuration;
              if (lastAlignedTs !== null && alignedTs <= lastAlignedTs) {
                sample.close();
                tIter0 = performance.now();
                continue;
              }
              lastAlignedTs = alignedTs;
            }
            const tAdd0 = performance.now();
            await videoSource.add(sample);
            tVideoAddTotal += performance.now() - tAdd0;
            sample.close();
            vFrac = Math.min(1, ts / total);
            n++;
            if (n % 5 === 0) render("video");
            tIter0 = performance.now();
          }
          vFrames = n;
          vFrac = 1;
          render("video");
        };
        const pumpAudio = async (): Promise<void> => {
          if (!aTrack) return;
          if (audioPacketSource && aCfg) {
            const aSink = new EncodedPacketSink(aTrack);
            let firstA = true;
            let n = 0;
            for await (const packet of aSink.packets()) {
              if (cancelled()) return;
              if (packet.timestamp < 0) continue;
              await audioPacketSource.add(packet, firstA ? { decoderConfig: aCfg } : undefined);
              firstA = false;
              aFrac = Math.min(1, packet.timestamp / total);
              if (++n % 50 === 0) render("audio");
            }
            aFrac = 1;
            render("audio");
          } else if (audioSource) {
            const aSink = new AudioSampleSink(aTrack);
            let n = 0;
            for await (const sample of aSink.samples()) {
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
              aFrac = Math.min(1, ts / total);
              if (++n % 25 === 0) render("audio");
            }
            aFrac = 1;
            render("audio");
          }
        };
        const tPumps0 = performance.now();
        await Promise.all([pumpVideo(), pumpAudio()]);
        const tPumps = performance.now() - tPumps0;
        

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
      buffer = null; // remux failed (odd packets?) — fall through to transcode
    }
  }
  if (!buffer && !cancelled()) {
    if (settings.encoderMode === "software") {
      buffer = await encodeOnce({ preferHw: false, latency: "quality", pass: "converting (software)" });
      how = "software";
    } else if (settings.encoderMode === "turbo") {
      buffer = await encodeOnce({ preferHw: true, latency: "realtime", pass: "converting (turbo)" });
      how = "turbo";
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
      // Fast path first (hardware VideoEncoder, e.g. VideoToolbox on Apple
      // Silicon), then verify the file is really PSP-safe. If the hardware
      // encoder didn't honor Baseline, redo in software for compatibility.
      buffer = await encodeOnce({ preferHw: true, latency: "quality", pass: "converting (hardware)" });
      how = "hardware";
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
    ` · ${how} in ${secs.toFixed(1)}s (probe ${probeSecs.toFixed(1)}s)`;

  return {
    buffer,
    profileText: badge.text,
    profileCls: badge.cls,
    srcInfo,
    dims,
    how,
    secs,
    outSize: buffer.byteLength,
    doneNote,
  };
}
