import * as React from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Delete02Icon,
  Edit02Icon,
  Film01Icon,
  RefreshIcon,
  Search01Icon,
  Tick02Icon,
  Cancel01Icon,
  HardDriveIcon,
  UsbConnected01Icon,
} from "@hugeicons/core-free-icons"
import {
  deletePspFileApi,
  formatBytes,
  listPspFiles,
  renamePspFileApi,
  sanitizePspFilename,
  type DetectedPspDevice,
  type PspFileInfo,
} from "@/psp"
import { toast } from "sonner"

interface PspStorageManagerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  pspDevices: DetectedPspDevice[]
  selectedDevice: DetectedPspDevice | null
  onSelectDevice: (device: DetectedPspDevice) => void
  onRefreshStorage: () => Promise<void>
}

export function PspStorageManager({
  open,
  onOpenChange,
  pspDevices,
  selectedDevice,
  onSelectDevice,
  onRefreshStorage,
}: PspStorageManagerProps) {
  const [files, setFiles] = React.useState<PspFileInfo[]>([])
  const [loading, setLoading] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState("")
  const [sortBy, setSortBy] = React.useState<"newest" | "oldest" | "largest" | "smallest" | "name">(
    "newest"
  )
  const [editingFile, setEditingFile] = React.useState<string | null>(null)
  const [editName, setEditName] = React.useState("")
  const [confirmDeleteFile, setConfirmDeleteFile] = React.useState<string | null>(null)
  const [isDeleting, setIsDeleting] = React.useState(false)

  const activeDevice = selectedDevice || pspDevices[0] || null

  const loadFiles = React.useCallback(async (videoPath: string) => {
    setLoading(true)
    try {
      const fileList = await listPspFiles(videoPath)
      setFiles(fileList)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (open && activeDevice) {
      void loadFiles(activeDevice.videoPath)
      setConfirmDeleteFile(null)
      setEditingFile(null)
    }
  }, [open, activeDevice, loadFiles])

  // Capacity calculations
  const totalBytes = activeDevice?.totalBytes ?? 0
  const freeBytes = activeDevice?.freeBytes ?? 0
  const usedBytes = Math.max(0, totalBytes - freeBytes)
  const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0
  const totalVideoBytes = files.reduce((acc, f) => acc + f.size, 0)

  // Filter and sort files
  const filteredFiles = React.useMemo(() => {
    let result = files.filter((f) =>
      f.name.toLowerCase().includes(searchQuery.trim().toLowerCase())
    )

    result = [...result].sort((a, b) => {
      switch (sortBy) {
        case "newest":
          return b.mtime - a.mtime
        case "oldest":
          return a.mtime - b.mtime
        case "largest":
          return b.size - a.size
        case "smallest":
          return a.size - b.size
        case "name":
          return a.name.localeCompare(b.name)
        default:
          return 0
      }
    })

    return result
  }, [files, searchQuery, sortBy])

  const handleStartRename = (file: PspFileInfo) => {
    setEditingFile(file.name)
    setEditName(file.name.replace(/\.mp4$/i, ""))
    setConfirmDeleteFile(null)
  }

  const handleCancelRename = () => {
    setEditingFile(null)
    setEditName("")
  }

  const handleSaveRename = async (oldName: string) => {
    if (!activeDevice || !editName.trim()) return
    const { outName } = sanitizePspFilename(editName)
    if (outName === oldName) {
      setEditingFile(null)
      return
    }

    const success = await renamePspFileApi(activeDevice.videoPath, oldName, outName)
    if (success) {
      toast.success(`Renamed video to "${outName}"`)
      setEditingFile(null)
      void loadFiles(activeDevice.videoPath)
      void onRefreshStorage()
    } else {
      toast.error("Could not rename video on PSP")
    }
  }

  const handleDelete = async (filename: string) => {
    if (!activeDevice) return
    setIsDeleting(true)
    try {
      const success = await deletePspFileApi(activeDevice.videoPath, filename)
      if (success) {
        toast.success(`Deleted "${filename}" from PSP`)
        setConfirmDeleteFile(null)
        setFiles((prev) => prev.filter((f) => f.name !== filename))
        void onRefreshStorage()
      } else {
        toast.error("Could not delete video from PSP")
      }
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col p-6 overflow-hidden gap-5">
        <DialogHeader className="gap-1.5 shrink-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500">
                <HugeiconsIcon icon={UsbConnected01Icon} className="size-4" />
              </div>
              <div>
                <DialogTitle className="text-base font-semibold">PSP Storage Manager</DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground">
                  Browse and manage videos stored directly on your PSP
                </DialogDescription>
              </div>
            </div>

            {/* Partition selector if multiple volumes exist */}
            {pspDevices.length > 1 && (
              <Select
                value={activeDevice?.id}
                onValueChange={(val) => {
                  const dev = pspDevices.find((d) => d.id === val)
                  if (dev) onSelectDevice(dev)
                }}
              >
                <SelectTrigger className="h-8 text-xs w-48">
                  <SelectValue>
                    {activeDevice
                      ? `${activeDevice.isInternal ? "Internal Flash" : "Memory Stick"} (${activeDevice.freeFormatted} free)`
                      : "Select partition"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {pspDevices.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.isInternal ? "Internal Flash" : "Memory Stick"} ({d.freeFormatted} free)
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}
          </div>
        </DialogHeader>

        {/* Capacity summary bar */}
        {activeDevice && (
          <div className="rounded-xl border bg-card/60 p-3.5 flex flex-col gap-2.5 shrink-0">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <HugeiconsIcon icon={HardDriveIcon} className="size-3.5 text-muted-foreground" />
                <span className="font-medium">{activeDevice.name}</span>
                <span className="text-muted-foreground">({activeDevice.volumeName})</span>
              </div>
              <div className="text-right font-medium">
                <span>{formatBytes(usedBytes)} used</span>
                <span className="text-muted-foreground font-normal">
                  {" "}
                  / {formatBytes(totalBytes)} ({activeDevice.freeFormatted} free)
                </span>
              </div>
            </div>

            <Progress value={usedPercent} className="h-2" />

            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>
                {files.length} videos taking {formatBytes(totalVideoBytes)}
              </span>
              <span>{100 - usedPercent}% space remaining</span>
            </div>
          </div>
        )}

        {/* Search & Sort controls */}
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="relative flex-1">
            <HugeiconsIcon
              icon={Search01Icon}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground"
            />
            <Input
              placeholder="Search videos on PSP..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>

          <Select value={sortBy} onValueChange={(val: any) => setSortBy(val)}>
            <SelectTrigger className="h-8 text-xs w-36 shrink-0">
              <SelectValue>
                {sortBy === "newest"
                  ? "Newest first"
                  : sortBy === "oldest"
                    ? "Oldest first"
                    : sortBy === "largest"
                      ? "Largest first"
                      : sortBy === "smallest"
                        ? "Smallest first"
                        : "Name (A–Z)"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="newest">Newest first</SelectItem>
                <SelectItem value="oldest">Oldest first</SelectItem>
                <SelectItem value="largest">Largest first</SelectItem>
                <SelectItem value="smallest">Smallest first</SelectItem>
                <SelectItem value="name">Name (A–Z)</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8 shrink-0"
                    onClick={() => activeDevice && void loadFiles(activeDevice.videoPath)}
                    disabled={loading}
                  >
                    <HugeiconsIcon
                      icon={RefreshIcon}
                      className={`size-3.5 ${loading ? "animate-spin" : ""}`}
                    />
                  </Button>
                }
              />
              <TooltipContent>Refresh videos</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        <Separator />

        {/* Video files scrollable list */}
        <div className="flex-1 overflow-y-auto min-h-60 pr-1 flex flex-col gap-2">
          {filteredFiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center flex-1 py-12 text-center text-muted-foreground gap-2">
              <HugeiconsIcon icon={Film01Icon} className="size-8 opacity-40" />
              <div className="text-xs font-medium">
                {searchQuery
                  ? "No matching videos found"
                  : "No videos on this PSP storage partition"}
              </div>
              <p className="text-[11px] opacity-70">
                {searchQuery
                  ? "Try a different search keyword"
                  : "Convert and save a video above to populate your PSP"}
              </p>
            </div>
          ) : (
            filteredFiles.map((file) => {
              const isEditing = editingFile === file.name
              const isConfirming = confirmDeleteFile === file.name
              const thumbUrl = activeDevice
                ? `/api/psp/thumb?dir=${encodeURIComponent(activeDevice.videoPath)}&file=${encodeURIComponent(file.name)}`
                : null

              return (
                <div
                  key={file.name}
                  className="flex items-center justify-between gap-3 p-2.5 rounded-xl border bg-card/40 hover:bg-card transition-colors text-xs"
                >
                  {/* Thumbnail / Icon */}
                  <div className="relative size-14 shrink-0 rounded-lg overflow-hidden border bg-muted/60 flex items-center justify-center">
                    {thumbUrl ? (
                      <img
                        src={thumbUrl}
                        alt={file.name}
                        className="size-full object-cover"
                        onError={(e) => {
                          // Hide broken thumbnail image and show fallback icon
                          ;(e.target as HTMLElement).style.display = "none"
                        }}
                      />
                    ) : null}
                    <div className="absolute inset-0 -z-10 flex items-center justify-center">
                      <HugeiconsIcon
                        icon={Film01Icon}
                        className="size-5 text-muted-foreground/50"
                      />
                    </div>
                  </div>

                  {/* Title & metadata */}
                  <div className="flex-1 min-w-0 flex flex-col gap-1">
                    {isEditing ? (
                      <div className="flex items-center gap-1.5">
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void handleSaveRename(file.name)
                            if (e.key === "Escape") handleCancelRename()
                          }}
                          autoFocus
                          className="h-7 text-xs font-mono"
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7 shrink-0 text-emerald-500 hover:text-emerald-400"
                          onClick={() => void handleSaveRename(file.name)}
                        >
                          <HugeiconsIcon icon={Tick02Icon} className="size-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7 shrink-0 text-muted-foreground"
                          onClick={handleCancelRename}
                        >
                          <HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <span
                          className="font-semibold text-foreground truncate font-mono text-xs"
                          title={file.name}
                        >
                          {file.name}
                        </span>
                        {file.hasThumbnail && (
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1 py-0 h-4 border-muted-foreground/30 text-muted-foreground"
                          >
                            THM
                          </Badge>
                        )}
                      </div>
                    )}

                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{formatBytes(file.size)}</span>
                      <span>•</span>
                      <span>
                        {new Date(file.mtime).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </span>
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="flex items-center gap-1 shrink-0">
                    {isConfirming ? (
                      <div className="flex items-center gap-1.5 bg-destructive/10 border border-destructive/30 rounded-lg p-1">
                        <span className="text-[11px] text-destructive font-medium pl-1">
                          Delete?
                        </span>
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-6 px-2 text-[11px]"
                          disabled={isDeleting}
                          onClick={() => void handleDelete(file.name)}
                        >
                          {isDeleting ? "..." : "Yes"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px]"
                          onClick={() => setConfirmDeleteFile(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="size-7 text-muted-foreground hover:text-foreground"
                                  onClick={() => handleStartRename(file)}
                                >
                                  <HugeiconsIcon icon={Edit02Icon} className="size-3.5" />
                                </Button>
                              }
                            />
                            <TooltipContent>Rename file</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>

                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="size-7 text-muted-foreground hover:text-destructive"
                                  onClick={() => {
                                    setConfirmDeleteFile(file.name)
                                    setEditingFile(null)
                                  }}
                                >
                                  <HugeiconsIcon icon={Delete02Icon} className="size-3.5" />
                                </Button>
                              }
                            />
                            <TooltipContent>Delete from PSP</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Dialog footer */}
        <div className="flex items-center justify-between pt-2 border-t text-xs text-muted-foreground shrink-0">
          <span>
            Target directory:{" "}
            <code className="font-mono text-foreground text-[11px]">{activeDevice?.videoPath}</code>
          </span>
          <DialogClose
            render={
              <Button variant="outline" size="sm" className="h-7 text-xs">
                Done
              </Button>
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
