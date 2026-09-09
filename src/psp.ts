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

export interface PspFileInfo {
  name: string
  size: number
  mtime: number
  hasThumbnail?: boolean
}

export type DuplicateAction = "skip" | "overwrite" | "keep_both"

export function sanitizePspFilename(title: string): {
  cleanStem: string
  outName: string
  thmName: string
} {
  let clean = (title || "").trim()
  clean = clean.replace(/\.(mp4|thm)$/i, "").trim()
  // Strip strictly forbidden FAT32 characters: / \ : * ? " < > | and control chars
  // eslint-disable-next-line no-control-regex
  clean = clean.replace(/[/\\:*?"<>|\x00-\x1F]/g, "").trim()
  // Replace consecutive spaces with clean underscores
  clean = clean.replace(/\s+/g, "_")
  if (!clean) clean = "video"

  return {
    cleanStem: clean,
    outName: `${clean}.mp4`,
    thmName: `${clean}.thm`,
  }
}

export async function listPspFiles(videoPath: string): Promise<PspFileInfo[]> {
  try {
    const res = await fetch(`/api/psp/files?dir=${encodeURIComponent(videoPath)}`)
    if (!res.ok) return []
    const data = await res.json()
    return data.files || []
  } catch {
    return []
  }
}

export interface SavePspResult {
  success: boolean
  skipped?: boolean
  filename?: string
  path?: string
}

export async function saveBuffersToPspApi(
  videoPath: string,
  outName: string,
  videoBuffer: ArrayBuffer,
  thmName?: string,
  thmBuffer?: ArrayBuffer,
  oldOutName?: string,
  conflictAction: DuplicateAction = "overwrite"
): Promise<SavePspResult> {
  try {
    const res = await fetch("/api/psp/save", {
      method: "POST",
      headers: {
        "x-psp-target-dir": encodeURIComponent(videoPath),
        "x-psp-filename": encodeURIComponent(outName),
        "x-psp-conflict": conflictAction,
        ...(oldOutName ? { "x-psp-old-filename": encodeURIComponent(oldOutName) } : {}),
      },
      body: videoBuffer,
    })
    if (!res.ok) return { success: false }
    const resJson = await res.json()

    if (resJson.skipped) {
      return { success: true, skipped: true, filename: outName }
    }

    const finalVideoName = resJson.filename || outName

    if (thmName && thmBuffer) {
      const finalThmName = finalVideoName.replace(/\.mp4$/i, ".thm")
      const oldThm = oldOutName ? oldOutName.replace(/\.mp4$/i, ".thm") : undefined
      await fetch("/api/psp/save", {
        method: "POST",
        headers: {
          "x-psp-target-dir": encodeURIComponent(videoPath),
          "x-psp-filename": encodeURIComponent(finalThmName),
          "x-psp-conflict": conflictAction,
          ...(oldThm ? { "x-psp-old-filename": encodeURIComponent(oldThm) } : {}),
        },
        body: thmBuffer,
      })
    }

    return {
      success: true,
      filename: finalVideoName,
      path: resJson.path,
    }
  } catch (err) {
    console.error("saveBuffersToPspApi failed:", err)
    return { success: false }
  }
}

export async function renamePspFileApi(
  videoPath: string,
  oldName: string,
  newName: string
): Promise<boolean> {
  try {
    const res = await fetch("/api/psp/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: videoPath, oldName, newName }),
    })
    if (!res.ok) return false
    const data = await res.json()
    return !!data.success
  } catch {
    return false
  }
}

export async function deletePspFileApi(videoPath: string, filename: string): Promise<boolean> {
  try {
    const res = await fetch("/api/psp/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: videoPath, filename }),
    })
    if (!res.ok) return false
    const data = await res.json()
    return !!data.success
  } catch {
    return false
  }
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}
