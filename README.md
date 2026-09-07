# psp-video-web

In-browser PSP Go video converter. Drag in videos, get PSP-ready MP4s — **100% client-side**, files never leave the device.

Built with **Bun** (runtime, bundler, static server) + **MediaBunny** (WebCodecs-powered decode/encode, no ffmpeg needed).

Architecture: `src/convert.ts` holds all conversion logic, `src/worker.ts` runs
it in a **Web Worker pool** (up to 4, one file per worker — true multi-core
batch encodes, zero main-thread jank, measured 0 ms event-loop lag mid-encode),
`src/app.ts` is UI only. Quality is constant-quality quantizer (CRF-like:
Q28/Q25/Q22) with a source-capped bitrate fallback.

## Run it

```bash
bun install
bun dev        # http://localhost:3000 (PORT=8137 bun dev for a custom port)
```

`bun dev` watches `server.ts` and re-bundles `src/app.ts → public/app.js` on every start.

## What it produces

Same recipe as the CLI (`../psp-video-optimise-cli`): MP4 + faststart, **H.264 Constrained Baseline ≤ L3.0**, 480×272 (or 720×480 TV preset), ≤29.97fps, AAC-LC stereo.

Three things the web version does that most converters don't:

1. **Forces Baseline via codec string** (`avc1.42E01E`) through a manual
   `VideoSampleSink → VideoSampleSource` pipeline — `Conversion.init` has no
   `fullCodecString` option and browsers otherwise emit Main/High (verified:
   headless Chrome defaulted to High L2.1, unplayable on PSP).
2. **Verifies every output** by parsing the MP4's `avcC` box and badging the
   real profile/level: green Baseline, amber Main, red High.
3. **Auto encoder strategy**: hardware first (VideoToolbox on Apple Silicon),
   re-encode in software if the profile isn't PSP-safe. Plus Software-only
   and Turbo (`realtime` latency) modes.
4. **Never upscales bitrate**: target is capped at the source's own bitrate,
   so a squeezed 378 MB movie can't come out as 449 MB.

## Speed (fastest → slowest)

- **Remux**: already-PSP-native input (Baseline/Main ≤ L3.0, ≤480×272,
  ≤30fps, AAC-LC) is packet-copied, not re-encoded — instant, zero loss.
- **Hardware** (Auto default): VideoToolbox on Apple Silicon.
- **Turbo**: hardware + `realtime` latency, slightly bigger files.
- **Software**: slowest, always max-compatible fallback.

Every job reports its method and phase timing
(`remuxed in 0.0s`, `hardware in 0.5s (probe 0.0s)`), so you can see where
time actually goes on your machine instead of guessing.

`public/sample.mp4` is a tiny generated test clip for trying it out.
