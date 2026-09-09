# psp-video-web

In-browser PlayStation Portable video converter and USB storage manager.

Converts modern video formats (MP4, MKV, AVI, MOV, WEBM) into Sony PSP-compliant MP4 files with generated `.thm` thumbnail art. When connected via USB in USB Mode, videos can be written directly to the PSP without intermediate downloads or command-line tools.

Live site: [https://psp.sabraman.art](https://psp.sabraman.art)

---

## Technical Specifications

Every output file strictly follows Sony PSP hardware playback limits:

| Property          | Value                                | Notes                                                       |
| :---------------- | :----------------------------------- | :---------------------------------------------------------- |
| Container         | MP4 (ISO Base Media File)            | FastStart (`moov` atom placed before `mdat`)                |
| Video Codec       | H.264 / AVC                          | Constrained Baseline Profile (`avc1.42E01E`)                |
| AVC Level         | Level 3.0 or lower                   | Verified via direct parsing of the MP4 `avcC` box           |
| Resolution        | 480x272 (Native) or 720x480 (TV Out) | Configurable aspect ratio fit / letterboxing                |
| Frame Rate        | 29.97 fps (30000/1001) maximum       | Automatic pre-transform frame skipping for 60 fps sources   |
| Audio Codec       | AAC-LC (`mp4a.40.2`)                 | Mono or stereo, 44.1 kHz or 48.0 kHz                        |
| Audio Passthrough | Bit-exact remuxing                   | Bypasses re-encoding when source audio is already compliant |
| Thumbnail         | 160x120 JPEG (`.thm`)                | Placed alongside `.mp4` for the PSP XMB video browser       |

---

## Features

- **Client-Side Transcoding**: Video decoding, scaling, subtitle rendering, and encoding run entirely in the browser using WebCodecs and MediaBunny. Media files are never uploaded to any remote server.
- **Hardware Acceleration & Worker Concurrency**: Uses GPU hardware encoders (Apple Silicon VideoToolbox, Intel QuickSync, NVIDIA NVENC) via WebCodecs. Multi-threaded segmented encoding divides long videos into parallel chunks across CPU cores.
- **Direct USB Transfer & Auto-Detection**: When run locally, the built-in storage bridge detects mounted PSP volumes (including dual partitions on the PSP Go: 16 GB internal flash and M2 Memory Stick) and writes directly to `/VIDEO`.
- **PSP Storage Manager**: Browse videos currently stored on the PSP, view partition capacity and remaining free space, preview existing `.thm` thumbnails, perform zero-copy in-place renames, and delete files.
- **Anti-Duplication**: Checks existing files on the PSP before conversion starts and offers conflict options: Skip, Overwrite, or Keep Both (auto-versioned naming).
- **Subtitle Burn-in**: Renders `.srt` and `.vtt` subtitle tracks directly onto video frames with responsive scaling.

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) (v1.1+) or Node.js (v20+)
- Chromium-based browser (Chrome, Edge, Brave, Arc, Opera) with WebCodecs support

### Installation

```bash
git clone https://github.com/sabraman/psp-video-web.git
cd psp-video-web
bun install
```

### Local Development

```bash
bun run dev
```

Starts the local Vite development server with the USB detection bridge at `http://localhost:3005`.

Connect your PSP via USB cable, toggle **USB Connection** in the PSP settings menu, and the application will detect the device and show available storage.

### Production Build

```bash
bun run build
bun run preview
```

### Verification & Code Style

The project uses [Oxlint](https://oxc.rs) for linting, [Oxfmt](https://oxc.rs) for formatting, and TypeScript for static checking:

```bash
bun run lint
bun run format:check
bun run typecheck
```

---

## License

MIT
