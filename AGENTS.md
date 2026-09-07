# PSP Video Web Converter — Agent Guide

High-performance, in-browser video converter specifically targeting the Sony PlayStation Portable (PSP 1000 / 2000 / 3000 / Go / Street). Runs 100% client-side using WebCodecs and MediaBunny.

## Key Hard Constraints (Verified & Non-Negotiable)

- **Codec**: H.264 Constrained Baseline ≤ Level 3.0 (`avc1.42E01E`).
  - Native Go / 1000–3000 resolution: ≤ 480×272.
  - TV-out preset (FW ≥ 3.30): ≤ 720×480 (Main or Baseline ≤ L3.0).
  - Framerate: strictly ≤ 29.97 fps (frames downsampled using pre-transform skipping).
- **Audio**: AAC-LC (`mp4a.40.2`), mono or stereo (≤ 2ch), 44.1 kHz or 48 kHz.
- **Container**: Non-fragmented MP4 with faststart (`fastStart: "in-memory"` in MediaBunny).
- **Verification**: In-app `parseAvcProfile()` parses the MP4 `avcC` box directly from Uint8Array. Output badge must be green (`Baseline L... ✓ PSP-ready`).
- **No WASM / No Server**: Transcoding runs exclusively in browser Web Workers via WebCodecs hardware/software pipelines.

## Project Structure

```
psp-video-web/
├── src/
│   ├── convert.ts       # Core transcoding pipeline, avcC parser, audio passthrough, custom resizer
│   ├── worker.ts        # Web Worker entrypoint (concurrency isolation)
│   └── app.ts           # Minimal UI controller, worker pool management, drag-and-drop queue
├── public/
│   ├── index.html       # Clean, minimal UI
│   ├── styles.css       # Fast, minimal dark theme
│   ├── app.js           # Built browser bundle
│   └── worker.js        # Built worker bundle
├── server.ts            # Bun static HTTP dev server (default port 8137)
├── package.json
└── tsconfig.json
```

## Commands

```bash
bun install              # Install dependencies
bun run dev              # Run dev server with hot watch on server.ts
bun run build            # Bundle src/app.ts and src/worker.ts to public/
bun run typecheck        # Typecheck TypeScript (tsc --noEmit)
bun start                # Run production server on port 8137 (or PORT=...)
```

## Performance Architecture

1. **Hardware Acceleration**:
   - `VideoSampleSink` instantiated with `{ hardwareAcceleration: preferHw ? "prefer-hardware" : "prefer-software" }` to leverage Apple Silicon / GPU hardware decoders.
2. **Pre-Transform Frame Skipping**:
   - For high frame rate inputs (`fps > 31`), frames that would be dropped by `frameRate` downsampling are discarded and closed in `pumpVideo` *before* hitting canvas transformations, saving >50% CPU/GPU work on 60fps sources.
3. **1-Pass Fast VideoSample Transformer**:
   - Replaces MediaBunny's default multi-pass downscale mipmapper (`_drawWithFitAndMipmapping`) with `registerVideoSampleTransformer()`.
   - Reuses a persistent `OffscreenCanvas` (`alpha: false`, `willReadFrequently: false`) doing direct 1-pass `drawWithFit()` snapshotted to a hardware `VideoFrame`.
4. **AAC-LC Passthrough (Remuxing)**:
   - When input audio is already compliant AAC-LC (`mp4a.40.2`, ≤ 2ch, 44.1k/48k), re-encoding is bypassed. Packets are piped directly via `EncodedAudioPacketSource("aac")`.
5. **Worker Pool Concurrency**:
   - Concurrency capped to `Math.min(8, navigator.hardwareConcurrency ?? 4)` for parallel batch processing across performance and efficiency cores.

## Testing & Verification

- Test automated conversions using headless Chromium:
  ```bash
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9225 http://localhost:8137 &
  ```
- Trigger conversions programmatically via `window.__psp.addFiles([file])` and inspect `window.__psp.jobs`.
- Verify `avcC` badge text equals `Baseline L... ✓ PSP-ready` with `cls: "green"`.
