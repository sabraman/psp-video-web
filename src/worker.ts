import { convertFile, type ConvertSettings } from "./convert";

interface Port {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

const port = globalThis as unknown as Port;
let cancelled = false;

port.onmessage = async (ev: MessageEvent): Promise<void> => {
  const msg = ev.data as
    | { type: "cancel" }
    | { type: "convert"; id: number; file: File; settings: ConvertSettings };
  if (msg.type === "cancel") {
    cancelled = true;
    return;
  }
  if (msg.type !== "convert") return;
  cancelled = false;
  const { id, file, settings } = msg;
  try {
    const r = await convertFile(file, settings, {
      onProgress: (frac, label) => port.postMessage({ type: "progress", id, frac, label }),
      isCancelled: () => cancelled,
    });
    port.postMessage({ type: "done", id, ...r }, [r.buffer]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    port.postMessage({
      type: "failed",
      id,
      error: message === "__cancelled__" ? "cancelled" : message,
      cancelled: message === "__cancelled__",
    });
  }
};
