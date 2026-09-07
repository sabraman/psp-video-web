# Sony PSP Go Converter: Apple Silicon Hardware & WebCodecs Optimization

## 1. Goal Specification

- **Target Hardware**: Apple M2 (MacBook Air), 8-core CPU (4P + 4E), 8/10-core GPU, 16 GB Unified Memory Architecture (UMA), VideoToolbox hardware media engines (MVD hardware decoder + MVE hardware encoder).
- **Target Browser**: Google Chrome (v153+ Dev/Canary) with hardware-accelerated WebCodecs.
- **Stack Constraints**: Client-side execution only (Bun + MediaBunny + `@mediabunny/aac-encoder` fallback + WebCodecs). Zero WASM video transcoding, zero server-side FFmpeg.
- **Output Constraints**: Strictly compliant with Sony PSP Go hardware:
  - H.264 Constrained Baseline ≤ Level 3.0 (`avc1.42E01E`).
  - Native Go resolution: ≤ 480×272 (or ≤ 720×480 Main for TV preset).
  - Framerate: strictly ≤ 29.97 fps.
  - Audio: AAC-LC (`mp4a.40.2`), mono or stereo (≤ 2ch), 44.1 kHz or 48.0 kHz.
  - Container: Progressive non-fragmented MP4 with faststart (`moov` before `mdat`).
  - In-app `avcC` badge must remain green (`Baseline L... ✓ PSP-ready`).

---

## 2. Benchmark Progression & Results

| Configuration / Stage | `film60.mp4` (60s 720p30) | `prizrak60.mp4` (60s 720p24) | `prizrak300.mp4` (5 min 720p24) | Speed vs Realtime | PSP Compliance Badge |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Initial Base Pipeline** | 8.40s (214 FPS) | — | — | 7.1× | `Baseline L2.1 ✓ PSP-ready` |
| **Area 1 + Area 2** (64MB Cache + Realtime Latency) | 4.80s (375 FPS) | 2.80s (300 FPS) | 17.50s (411 FPS) | **12.5× – 21.4×** | `Baseline L2.1 ✓ PSP-ready` |
| **Area 3 (Fast Canvas Resizing)** | 4.70s – 4.80s | 2.80s | 17.50s | **17.1× – 21.4×** | `Baseline L2.1 ✓ PSP-ready` |

---

## 3. Investigated Areas & Optimization Insights

### Area 1: Large File Demuxer I/O (`BlobSource` Cache Tuning)
- **Mechanism**: Long videos (e.g. 300MB – 1GB feature movies) trigger thousands of small file chunk reads if the demuxer source window is small. By configuring `BlobSource` with `maxCacheSize: 64 * 1024 * 1024` (64 MiB window) across `probe()`, `remuxOnce()`, and `encodeOnce()`, random read calls are absorbed directly in Unified Memory.
- **Result**: Probe time on full-length movies dropped from multiple seconds down to **0.0s**.

### Area 2: Hardware Rate Control & Latency Mode
- **Mechanism**: Tested `latencyMode: 'realtime'` vs `latencyMode: 'quality'` in Apple VideoToolbox encoder.
- **Finding**: On Apple Silicon M2, `latencyMode: 'realtime'` avoids internal encoder lookahead buffer stalling, yielding **375–411 FPS** compared to **260 FPS** in `quality` mode, while maintaining strict Constrained Baseline Level 2.1 compliance (`avc1.42E01E`).

### Area 3: GPU Canvas Downscaling Overhead
- **Mechanism**: Default MediaBunny `videoSample.transform()` detects > 2× downscaling (e.g. 720p/1080p → 272p) and applies multi-pass manual mipmapping allocating intermediate canvases and running `imageSmoothingQuality = 'high'` bicubic shaders.
- **Solution**: Registered custom `VideoSampleTransformer` with a persistent `OffscreenCanvas` (`{ alpha: false, desynchronized: true }`), single-fill black background initialization, and direct single-pass bilinear GPU blit.
- **Finding**: Multi-canvas ring buffering (allocating 4 separate canvases) was slower (6.80s vs 4.80s) due to Chrome GPU process swapchain context switching. A single persistent desynchronized canvas provided optimal throughput without GPU driver thrashing.

### Area 4: Cross-Thread Worker Event Throttling
- **Mechanism**: The conversion pipeline previously posted progress notifications on every 5 video frames and *every single audio packet* (2,800 postMessages per minute of audio).
- **Solution**: Throttled video progress to every 30 frames and audio progress to every 50 packets.
- **Result**: Eliminated worker message queue congestion and DOM repainting overhead on the main thread during high-speed transcoding.

### Area 5: Bit-for-Bit AAC Remux Passthrough
- **Mechanism**: Real movie downloads often already contain PSP-compliant stereo AAC-LC tracks (`mp4a.40.2` at 44.1/48 kHz).
- **Result**: Demuxer packet copy bypasses audio decoding/encoding entirely, allowing the pipeline to encode 5 minutes of full audio/video in just **17.5 seconds** (411 FPS).

---

## 4. How to Run Continuous Benchmarks

Run automated headless Chrome DevTools benchmarks directly:
```bash
# Benchmark 60s standard test video
bun bench_loop.ts film60.mp4

# Benchmark real movie clip from Downloads (60s)
bun bench_loop.ts prizrak60.mp4

# Benchmark 5-minute continuous movie stream
bun bench_loop.ts prizrak300.mp4
```
