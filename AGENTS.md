# AGENTS.md

psp-video-web is an in-browser video transcoder and USB storage manager engineered for the Sony PlayStation Portable (PSP 1000, 2000, 3000, PSP Go, and Street). It runs 100% client-side via WebCodecs and MediaBunny, paired with a local development server plugin that acts as a zero-copy USB bridge to connected PSP FAT32 partitions.

When contributing or generating code for this repository, preserve the core constraints and follow the patterns documented below.

---

## Core Pillars

### 1. 100% Client-Side Transcoding

Video files never leave the user's computer. All demuxing, video frame decoding, spatial scaling, canvas composition, subtitle burn-in, audio resynthesis or passthrough, and MP4 muxing happen in browser Web Workers. Never introduce remote API dependencies or backend conversion services for media processing.

### 2. Strict Sony Hardware Compliance

The PSP hardware media engine (Media Engine chip + AVC decoder) is rigid. Files that play on modern desktop players will crash the PSP or display `80020001 / Unsupported Data` if any specification is exceeded:

- **Codec**: H.264 / AVC Constrained Baseline Profile (`avc1.42E01E`). Profile must be Baseline; Level must be `<= 3.0` (`0x1E`). Zero B-frames (`has_b_frames` must be `0`) and a single reference frame — proven on real hardware: Main Profile L2.1 _with_ B-frames fails with `Unsupported Data`, while Main L2.1 _without_ B-frames plays. B-frame presence is invisible to desktop players (preview looks fine) and can't be detected from the `avcC` box alone, so never remux Main Profile sources — always re-encode to Baseline.
- **Resolution**: Native display is strictly `480x272`. TV-out profile allows up to `720x480` (FW >= 3.30).
- **Framerate**: Maximum `29.97 fps` (`30000/1001`). Frame rates above 30 fps crash playback.
- **Audio**: AAC-LC (`mp4a.40.2`), mono or stereo (`<= 2` channels), `44.1 kHz` or `48.0 kHz`.
- **Container**: Non-fragmented MP4 with FastStart (`moov` atom placed before `mdat`).
- **Thumbnail**: 160x120 baseline JPEG saved as `<basename>.thm` in the same directory.

### 3. Memory Lifecycle Discipline

Video transcoding processes gigabytes of raw frame data in memory. A single leaked `VideoFrame` or unclosed `Input` will trigger browser tab crashes (OOM) or GPU pipeline stall.

- Always close every `VideoFrame` immediately after drawing or snapshotting.
- Wrap every MediaBunny `Input` in `try ... finally { input.dispose(); }`.
- In React components, dereference large `ArrayBuffer` payloads from state as soon as jobs finish or write to disk completes.
- Paired `URL.revokeObjectURL()` calls must exist for every `URL.createObjectURL()`.

---

## Glossary

- **you**: The agent reading this guide and modifying psp-video-web.
- **maintainer**: The maintainers of psp-video-web.
- **user**: The person using the application to convert videos and transfer them to a PSP.
- **bridge**: The local Vite development server plugin (`src/server/psp-plugin.ts`) providing `/api/psp/*` filesystem access to mounted `/Volumes` disks.
- **worker**: The Web Worker running inside `public/worker.js` (compiled from `src/worker.ts`), executing isolated conversion pipelines.
- **job**: A single transcoding or remux task representing an input file, conversion options, progress metrics, and output artifacts.
- **partition**: A mounted PSP storage volume (e.g. `NO NAME 1` for PSP Go internal 16 GB eMMC, `NO NAME` for Memory Stick Micro / PRO Duo).

---

## The Three Ways to Hurt Yourself

1. **Emitting Main or High Profile H.264, or any B-frames**:
   WebCodecs encoders default to Main or High profiles unless explicitly configured with `avc1.42E01E`. The output MP4 must always be verified by parsing the `avcC` box in the MP4 header. Never remove the profile check or assume browser defaults are safe. B-frames (`has_b_frames > 0`) are unplayable on real hardware even inside an otherwise-compliant Main L2.1 stream, so the remux/passthrough path must accept Baseline sources only, and every output path (single-pass, segmented, merge) must enforce Baseline before delivery.
2. **Leaking Hardware VideoFrames and Canvas Contexts**:
   Allocating an `OffscreenCanvas` per frame or forgetting to call `frame.close()` will exhaust GPU textures on Apple Silicon / Windows within seconds. Use persistent pooled canvases and enforce synchronous frame closure in decode pump loops.
3. **Leaving Orphan macOS Metadata on FAT32**:
   Writing to FAT32 volumes on macOS creates hidden `._*` dot-underscore resource fork files. When renaming or deleting PSP videos via the bridge, always clean up corresponding `._*` files, or the PSP XMB menu will display corrupted ghost items.

---

## Codebase Map

```
psp-video-web/
├── src/
│   ├── components/
│   │   ├── PspStorageManager.tsx # PSP filesystem browser, capacity gauge, rename/delete modal
│   │   └── ui/                   # Base UI and shadcn components (dialog, select, button, etc.)
│   ├── routes/
│   │   ├── __root.tsx            # TanStack Start root layout and providers
│   │   └── index.tsx             # Main dashboard, conversion queue, partition card
│   ├── server/
│   │   └── psp-plugin.ts         # Vite server plugin with /api/psp/* endpoints
│   ├── convert.ts                # MediaBunny conversion engine, avcC validator, remuxer
│   ├── psp.ts                    # Client-side bridge API client and disk formatting utilities
│   ├── router.tsx                # TanStack Router configuration
│   ├── styles.css                # Tailwind CSS v4 design system
│   └── worker.ts                 # Transcoding Web Worker
├── public/
│   ├── sample.mp4                # Tiny test clip for verification
│   └── worker.js                 # Compiled worker bundle
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## Development Workflow

### Commands

```bash
bun install               # Install dependencies
bun run dev               # Start dev server on port 3005 with USB bridge
bun run build             # Build worker bundle and production SSR/client output
bun run preview           # Preview built production distribution
bun run lint              # Oxlint check
bun run format            # Oxfmt format files
bun run format:check      # Oxfmt check without writing
bun run typecheck         # TypeScript typecheck (tsc --noEmit)
```

### Verification Rules

- Before opening a pull request or finishing a turn:
  1. Run `bun run lint` (must pass with 0 errors and 0 warnings).
  2. Run `bun run format:check` (all files must be formatted cleanly).
  3. Run `bun run typecheck` (must pass cleanly).
- When modifying UI components:
  - Use Base UI primitives and Tailwind CSS v4 utility classes.
  - Do not add arbitrary external UI libraries or heavy icon packs. Use `@hugeicons/react`.
  - Avoid inline CSS styles except where dynamic values (percentages, dimensions) require them.
