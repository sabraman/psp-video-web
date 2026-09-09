# PSP Video Web Converter — AI Agent Guide

Comprehensive guide for AI agents and contributors working on the `psp-video-web` codebase.

---

## 📌 Project Overview & Purpose

`psp-video-web` is a zero-server, high-performance in-browser video converter specifically engineered for the **Sony PlayStation Portable (PSP 1000 / 2000 / 3000 / Go / Street)**. It runs 100% client-side using WebCodecs and MediaBunny, paired with a local USB bridge for automatic PSP volume detection, direct file streaming, conflict resolution, and file management.

---

## 🔒 Hard Architectural Constraints (Non-Negotiable)

When writing or modifying any encoding, container, or file-writing code, the following constraints must strictly be preserved:

1. **Video Codec & AVC Level**:
   - **H.264 / AVC Constrained Baseline Profile** (`avc1.42E01E`).
   - Profile/Level MUST NOT exceed **Level 3.0** (`0x1E`). Higher profiles (Main, High) or higher levels (3.1+) fail on PSP hardware with playback error `80020001` or black screens.
   - Native PSP resolution: **480×272**.
   - TV-out resolution (FW ≥ 3.30): **720×480** (Baseline ≤ L3.0).
   - Framerate: strictly **≤ 29.97 fps** (frames downsampled using pre-transform skipping to prevent decoder crash).

2. **Audio Codec**:
   - **AAC-LC** (`mp4a.40.2`).
   - Sample rate: **44.1 kHz** or **48.0 kHz**.
   - Channels: mono or stereo (≤ 2 channels). Multi-channel audio (5.1, 7.1) must be downmixed.
   - Remuxing: If source audio is already AAC-LC stereo/mono at 44.1/48 kHz, pass packets directly without re-encoding (`EncodedAudioPacketSource`).

3. **Container**:
   - Standard ISO Base Media File (`.mp4`), non-fragmented.
   - FastStart MUST be enabled (`fastStart: "in-memory"` in MediaBunny) so that `moov` atom is placed before `mdat`.

4. **Cover Art (`.thm`)**:
   - 160×120 baseline JPEG image placed in `/VIDEO` next to the `.mp4` file with identical basename (`<title>.thm`).

5. **Resource & Memory Management**:
   - Every `Input` from MediaBunny must be wrapped in `try { ... } finally { input.dispose(); }`.
   - On completion of direct-to-PSP transfers, release underlying in-memory `ArrayBuffer` references from React state to allow Garbage Collection.
   - Any created `URL.createObjectURL()` must have a paired `URL.revokeObjectURL()`.

---

## 🗂️ Codebase Architecture

```
psp-video-web/
├── .agents/skills/          # Installed agent skills (deploy-to-vercel, shadcn)
├── src/
│   ├── components/
│   │   ├── PspStorageManager.tsx # Full-featured PSP disk manager dialog
│   │   └── ui/              # Base UI & shadcn primitives (button, dialog, select, etc.)
│   ├── routes/
│   │   ├── __root.tsx       # Root layout & theme provider
│   │   └── index.tsx        # Main converter dashboard & job queue
│   ├── server/
│   │   └── psp-plugin.ts    # Vite plugin providing /api/psp/* endpoints
│   ├── app.ts               # Minimal UI worker controller fallback
│   ├── convert.ts           # MediaBunny transcoding engine, avcC parser, segmented muxer
│   ├── psp.ts               # Client-side PSP API client & auto-detection utilities
│   ├── styles.css           # Tailwind CSS v4 design system
│   └── worker.ts            # Web Worker for isolated transcoding execution
├── public/                  # Public assets, test clips, and compiled worker.js
├── vite.config.ts           # Vite configuration with TanStack Start & PSP plugin
├── package.json
└── tsconfig.json
```

---

## 🛠️ Key APIs (`/api/psp/*`)

- `GET /api/psp/status`: Probes mounted system volumes (`/Volumes`) for PSP directories (`/PSP`, `/VIDEO`, `/ISO`). Returns detected partitions, total space, and free space.
- `GET /api/psp/files?dir=...`: Lists `.mp4` video files on the partition with file sizes, timestamps, and `.thm` thumbnail existence.
- `GET /api/psp/thumb?dir=...&file=...`: Streams raw 160×120 JPEG thumbnail for browser rendering with HTTP caching.
- `POST /api/psp/save`: Streams converted video buffer and thumbnail directly to the PSP volume.
- `POST /api/psp/rename`: Performs instant zero-copy file renaming on disk for both `.mp4` and `.thm`.
- `POST /api/psp/delete`: Deletes `.mp4`, paired `.thm`, and macOS `._*` dot-underscore metadata files.

---

## 🧪 Development & Verification Workflow

1. **Dev Server**:
   ```bash
   bun run dev
   ```
2. **Linting & Formatting**:
   ```bash
   bun run lint          # oxlint
   bun run format        # oxfmt
   bun run format:check  # oxfmt --check
   bun run typecheck     # tsc --noEmit
   ```
3. **Building**:
   ```bash
   bun run build         # Builds worker & Vite SSR + client bundles
   ```
