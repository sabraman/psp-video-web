import type { Plugin } from "vite"
import * as fs from "fs"
import * as path from "path"
import { execSync } from "child_process"

export interface DetectedPspDevice {
  id: string
  name: string
  volumeName: string
  mountPath: string
  videoPath: string
  freeBytes: number
  totalBytes: number
  freeFormatted: string
  isInternal: boolean
  isRecommended: boolean
}

export function detectPspDevices(): DetectedPspDevice[] {
  const devices: DetectedPspDevice[] = []
  if (process.platform === "darwin") {
    const volumes = "/Volumes"
    try {
      const list = fs.readdirSync(volumes)
      for (const item of list) {
        const full = path.join(volumes, item)
        try {
          const s = fs.statSync(full)
          if (!s.isDirectory()) continue

          const hasVideo = fs.existsSync(path.join(full, "VIDEO"))
          const hasPsp = fs.existsSync(path.join(full, "PSP"))
          const hasMemstick =
            fs.existsSync(path.join(full, "MEMSTICK.IND")) ||
            fs.existsSync(path.join(full, "MSTK_PRO.IND"))
          const hasMpRoot = fs.existsSync(path.join(full, "MP_ROOT"))

          if (
            hasVideo &&
            (hasPsp ||
              hasMemstick ||
              hasMpRoot ||
              item.toUpperCase().includes("NO NAME") ||
              item.toUpperCase().includes("PSP"))
          ) {
            let freeBytes = 0
            let totalBytes = 0
            try {
              const df = execSync(`df -k "${full}"`, { encoding: "utf8" })
              const l = df.trim().split("\n")
              if (l.length > 1) {
                const parts = l[l.length - 1].split(/\s+/)
                totalBytes = parseInt(parts[1], 10) * 1024
                freeBytes = parseInt(parts[3], 10) * 1024
              }
            } catch {}

            const isInternal = item === "NO NAME 1" || totalBytes > 12 * 1024 * 1024 * 1024
            const isM2 = hasMemstick || item === "NO NAME"

            const freeGb = freeBytes / (1024 * 1024 * 1024)
            const freeFormatted =
              freeGb >= 1
                ? `${freeGb.toFixed(1)} GB`
                : `${Math.round(freeBytes / (1024 * 1024))} MB`

            devices.push({
              id: item,
              name: isInternal
                ? "PSP Go Internal Storage"
                : isM2
                  ? "PSP M2 Memory Stick"
                  : `PSP (${item})`,
              volumeName: item,
              mountPath: full,
              videoPath: path.join(full, "VIDEO"),
              freeBytes,
              totalBytes,
              freeFormatted,
              isInternal,
              isRecommended: isInternal || freeBytes > 500 * 1024 * 1024,
            })
          }
        } catch {}
      }
    } catch {}
  } else if (process.platform === "win32") {
    // Windows drive scanning
    for (let charCode = 68; charCode <= 90; charCode++) {
      const drive = `${String.fromCharCode(charCode)}:\\`
      try {
        if (fs.existsSync(drive) && fs.existsSync(path.join(drive, "VIDEO"))) {
          devices.push({
            id: drive,
            name: `PSP Drive (${drive})`,
            volumeName: drive,
            mountPath: drive,
            videoPath: path.join(drive, "VIDEO"),
            freeBytes: 1024 * 1024 * 1024,
            totalBytes: 16 * 1024 * 1024 * 1024,
            freeFormatted: "Available",
            isInternal: true,
            isRecommended: true,
          })
        }
      } catch {}
    }
  }

  // Sort recommended (e.g. internal with more free space) first
  devices.sort((a, b) => (b.isRecommended ? 1 : 0) - (a.isRecommended ? 1 : 0))
  return devices
}

export function pspPlugin(): Plugin {
  return {
    name: "psp-detector-plugin",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || ""

        if (url.startsWith("/api/psp")) {
          res.setHeader("Access-Control-Allow-Origin", "*")
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
          res.setHeader("Access-Control-Allow-Headers", "*")
          if (req.method === "OPTIONS") {
            res.statusCode = 204
            res.end()
            return
          }
        }

        if (
          url === "/api/psp/status" &&
          (req.method === "GET" ||
            req.method === "HEAD" ||
            req.method === "HEAD" ||
            req.method === "HEAD")
        ) {
          try {
            const devices = detectPspDevices()
            res.setHeader("Content-Type", "application/json")
            res.statusCode = 200
            res.end(JSON.stringify({ connected: devices.length > 0, devices }))
            return
          } catch (err: any) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: err.message }))
            return
          }
        }

        if (url.startsWith("/api/psp/thumb") && req.method === "GET") {
          try {
            const parsedUrl = new URL(url, "http://localhost:3005")
            const dir = parsedUrl.searchParams.get("dir")
            const file = parsedUrl.searchParams.get("file")
            if (!dir || !file) {
              res.statusCode = 400
              res.end("Missing dir or file parameter")
              return
            }
            const thmPath = path.join(dir, file.replace(/\.mp4$/i, ".thm"))
            if (!fs.existsSync(thmPath)) {
              res.statusCode = 404
              res.end("No thumbnail found")
              return
            }
            const buf = fs.readFileSync(thmPath)
            res.setHeader("Content-Type", "image/jpeg")
            res.setHeader("Cache-Control", "public, max-age=3600")
            res.statusCode = 200
            res.end(buf)
            return
          } catch (err: any) {
            res.statusCode = 500
            res.end(err.message)
            return
          }
        }

        if (url.startsWith("/api/psp/files") && req.method === "GET") {
          try {
            const parsedUrl = new URL(url, "http://localhost:3005")
            const dir = parsedUrl.searchParams.get("dir")
            if (!dir || !fs.existsSync(dir)) {
              res.setHeader("Content-Type", "application/json")
              res.statusCode = 200
              res.end(JSON.stringify({ files: [] }))
              return
            }
            const entries = fs.readdirSync(dir, { withFileTypes: true })
            const files = entries
              .filter(
                (e) =>
                  e.isFile() && !e.name.startsWith(".") && e.name.toLowerCase().endsWith(".mp4")
              )
              .map((e) => {
                try {
                  const fullPath = path.join(dir, e.name)
                  const stat = fs.statSync(fullPath)
                  const thmName = e.name.replace(/\.mp4$/i, ".thm")
                  const hasThumbnail = fs.existsSync(path.join(dir, thmName))
                  return {
                    name: e.name,
                    size: stat.size,
                    mtime: stat.mtimeMs,
                    hasThumbnail,
                  }
                } catch {
                  return { name: e.name, size: 0, mtime: 0, hasThumbnail: false }
                }
              })
              .sort((a, b) => b.mtime - a.mtime)

            res.setHeader("Content-Type", "application/json")
            res.statusCode = 200
            res.end(JSON.stringify({ files }))
            return
          } catch (err: any) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: err.message }))
            return
          }
        }

        if (url === "/api/psp/delete" && req.method === "POST") {
          let body = ""
          req.on("data", (chunk) => {
            body += chunk
          })
          req.on("end", () => {
            try {
              const { dir, filename } = JSON.parse(body)
              if (!dir || !filename) {
                res.statusCode = 400
                res.end(JSON.stringify({ error: "Missing dir or filename" }))
                return
              }
              const videoPath = path.join(dir, filename)
              if (fs.existsSync(videoPath)) {
                fs.unlinkSync(videoPath)
              }
              const thmPath = path.join(dir, filename.replace(/\.mp4$/i, ".thm"))
              if (fs.existsSync(thmPath)) {
                fs.unlinkSync(thmPath)
              }
              // Clean up Finder dot-underscore metadata if present
              const dotVideo = path.join(dir, "._" + filename)
              if (fs.existsSync(dotVideo)) {
                try {
                  fs.unlinkSync(dotVideo)
                } catch {}
              }
              const dotThm = path.join(dir, "._" + filename.replace(/\.mp4$/i, ".thm"))
              if (fs.existsSync(dotThm)) {
                try {
                  fs.unlinkSync(dotThm)
                } catch {}
              }
              res.setHeader("Content-Type", "application/json")
              res.statusCode = 200
              res.end(JSON.stringify({ success: true, filename }))
            } catch (err: any) {
              res.statusCode = 500
              res.end(JSON.stringify({ error: err.message || "Delete failed" }))
            }
          })
          return
        }

        if (url === "/api/psp/rename" && req.method === "POST") {
          let body = ""
          req.on("data", (chunk) => {
            body += chunk
          })
          req.on("end", () => {
            try {
              const { dir, oldName, newName } = JSON.parse(body)
              if (!dir || !oldName || !newName) {
                res.statusCode = 400
                res.end(JSON.stringify({ error: "Missing dir, oldName, or newName" }))
                return
              }
              const oldVideo = path.join(dir, oldName)
              const newVideo = path.join(dir, newName)
              if (fs.existsSync(oldVideo)) {
                fs.renameSync(oldVideo, newVideo)
              }
              const oldThm = path.join(dir, oldName.replace(/\.mp4$/i, ".thm"))
              const newThm = path.join(dir, newName.replace(/\.mp4$/i, ".thm"))
              if (fs.existsSync(oldThm)) {
                fs.renameSync(oldThm, newThm)
              }
              res.setHeader("Content-Type", "application/json")
              res.statusCode = 200
              res.end(JSON.stringify({ success: true, oldName, newName }))
            } catch (err: any) {
              res.statusCode = 500
              res.end(JSON.stringify({ error: err.message || "Rename failed" }))
            }
          })
          return
        }

        if (url === "/api/psp/save" && req.method === "POST") {
          try {
            const rawTargetDir = (req.headers["x-psp-target-dir"] as string) || ""
            const targetDir = decodeURIComponent(rawTargetDir)
            const filename = decodeURIComponent((req.headers["x-psp-filename"] as string) || "")
            const oldFilename = decodeURIComponent(
              (req.headers["x-psp-old-filename"] as string) || ""
            )

            if (!targetDir || !filename) {
              res.statusCode = 400
              res.end(
                JSON.stringify({ error: "Missing x-psp-target-dir or x-psp-filename header" })
              )
              return
            }

            // Ensure destination exists
            if (!fs.existsSync(targetDir)) {
              fs.mkdirSync(targetDir, { recursive: true })
            }

            // If renaming an existing file, remove the old one
            if (oldFilename && oldFilename !== filename) {
              const oldPath = path.join(targetDir, oldFilename)
              if (fs.existsSync(oldPath)) {
                try {
                  fs.unlinkSync(oldPath)
                } catch {}
              }
            }

            const conflictMode = (
              (req.headers["x-psp-conflict"] as string) || "overwrite"
            ).toLowerCase()

            let finalFilename = filename
            let targetFilePath = path.join(targetDir, finalFilename)

            // Conflict handling when not renaming an old file
            if (!oldFilename && fs.existsSync(targetFilePath)) {
              if (conflictMode === "skip") {
                res.setHeader("Content-Type", "application/json")
                res.statusCode = 200
                res.end(
                  JSON.stringify({
                    success: true,
                    skipped: true,
                    path: targetFilePath,
                    filename: finalFilename,
                  })
                )
                return
              } else if (conflictMode === "keep_both") {
                const ext = path.extname(filename)
                const stem = path.basename(filename, ext)
                let counter = 1
                while (fs.existsSync(path.join(targetDir, `${stem}_${counter}${ext}`))) {
                  counter++
                }
                finalFilename = `${stem}_${counter}${ext}`
                targetFilePath = path.join(targetDir, finalFilename)
              }
            }

            const chunks: Buffer[] = []
            for await (const chunk of req) {
              chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
            }
            const buffer = Buffer.concat(chunks)
            fs.writeFileSync(targetFilePath, buffer)

            res.setHeader("Content-Type", "application/json")
            res.statusCode = 200
            res.end(
              JSON.stringify({ success: true, path: targetFilePath, filename: finalFilename })
            )
            return
          } catch (err: any) {
            console.error("Failed to save to PSP:", err)
            res.statusCode = 500
            res.end(JSON.stringify({ error: err.message }))
            return
          }
        }

        next()
      })
    },
  }
}
