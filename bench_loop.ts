import { spawn, type ChildProcess } from "child_process";

export async function runBenchmark(testVideo: string = "film60.mp4"): Promise<{
  timeMs: number;
  timeSec: number;
  fps: number;
  badge: string;
  dims: string;
  note: string;
}> {
  const CHROME_PORT = 9228;
  const PORT = 3005;
  const USER_DATA = `/tmp/psp_bench_${Date.now()}`;

  let serverProc: ChildProcess | null = null;
  const isPortUp = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/index.html`);
      return res.ok;
    } catch {
      return false;
    }
  };

  if (!(await isPortUp())) {
    serverProc = spawn("bun", ["server.ts"], {
      cwd: "/Users/sabraman/sandbox/psp-video-web",
      env: { ...process.env, PORT: String(PORT) },
      stdio: "pipe",
    });
    let attempts = 0;
    while (!(await isPortUp()) && attempts++ < 40) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const chromeProc = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless=new",
      `--remote-debugging-port=${CHROME_PORT}`,
      `--user-data-dir=${USER_DATA}`,
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  let pageTarget: any = null;
  let attempts = 0;
  while (!pageTarget && attempts++ < 60) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const listResp = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`);
      const targets = (await listResp.json()) as any[];
      pageTarget = targets.find((t: any) => t.type === "page");
    } catch {
      // Chrome starting up
    }
  }

  if (!pageTarget) {
    chromeProc.kill("SIGKILL");
    if (serverProc) serverProc.kill("SIGKILL");
    throw new Error("Failed to connect to Chrome DevTools port");
  }

  try {
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    let id = 1;
    const pending = new Map<number, (res: any) => void>();

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data.toString());
      if (data.id && pending.has(data.id)) {
        pending.get(data.id)!(data);
        pending.delete(data.id);
      }
    };

    await new Promise((resolve) => {
      if (ws.readyState === WebSocket.OPEN) resolve(null);
      else ws.onopen = () => resolve(null);
    });

    const send = (method: string, params: any = {}) => {
      const msgId = id++;
      return new Promise<any>((resolve) => {
        pending.set(msgId, resolve);
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    };

    await send("Page.enable");
    await send("Runtime.enable");

    // Navigate to local server via IPv4
    await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
    await new Promise((r) => setTimeout(r, 500));

    const evalCode = async (expr: string) => {
      const res = await send("Runtime.evaluate", {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
      });
      if (res.result.exceptionDetails) {
        throw new Error(JSON.stringify(res.result.exceptionDetails));
      }
      return res.result.result.value;
    };

    // Wait until window.__psp is defined
    await evalCode(`(async () => {
      let tries = 0;
      while (!window.__psp && tries++ < 100) {
        await new Promise(r => setTimeout(r, 100));
      }
      if (!window.__psp) throw new Error("window.__psp not found after navigation: " + window.location.href);
    })()`);

    // Warm-up run with sample.mp4
    await evalCode(`(async () => {
      const resp = await fetch("/sample.mp4");
      const blob = await resp.blob();
      const file = new File([blob], "warmup.mp4", { type: "video/mp4" });
      window.__psp.addFiles([file]);

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const j = window.__psp.jobs[0];
          reject(new Error("Warmup timed out: status=" + j?.status + " note=" + j?.note));
        }, 20000);
        const check = setInterval(() => {
          const job = window.__psp.jobs[0];
          if (job && (job.status === "done" || job.status === "failed")) {
            clearInterval(check);
            clearTimeout(timeout);
            resolve(null);
          }
        }, 50);
      });
    })()`);

    // Run benchmark on target video
    const runCode = `(async () => {
      const resp = await fetch("/${testVideo}");
      const blob = await resp.blob();
      const file = new File([blob], "${testVideo}", { type: blob.type || "video/mp4" });
      
      const idx = window.__psp.jobs.length;
      window.__psp.addFiles([file]);

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Target run timed out")), 240000);
        const interval = setInterval(() => {
          const job = window.__psp.jobs[idx];
          if (job) {
            if (job.status === "done") {
              clearInterval(interval);
              clearTimeout(timeout);
              resolve({
                status: "done",
                badge: job.profileBadge?.text || "",
                dims: job.dims || "",
                note: job.note || ""
              });
            } else if (job.status === "failed") {
              clearInterval(interval);
              clearTimeout(timeout);
              reject(new Error("Job failed: " + job.note));
            }
          }
        }, 50);
      });
    })()`;

    const t0 = performance.now();
    const result = await evalCode(runCode);
    const timeMs = performance.now() - t0;
    const timeSec = timeMs / 1000;

    const match = result.note.match(/in ([0-9.]+)s/);
    const hwTimeSec = match ? parseFloat(match[1]) : timeSec;
    const frameCount = testVideo.includes("film60") ? 1800 : testVideo.includes("prizrak60") ? 1440 : testVideo.includes("prizrak300") ? 7200 : Math.round(hwTimeSec * 300);

    return {
      timeMs,
      timeSec: hwTimeSec,
      fps: frameCount / hwTimeSec,
      badge: result.badge,
      dims: result.dims,
      note: result.note,
    };
  } finally {
    chromeProc.kill("SIGKILL");
    if (serverProc) {
      serverProc.kill("SIGKILL");
    }
  }
}

if (import.meta.main) {
  const video = process.argv[2] || "film60.mp4";
  console.log(`Running benchmark for ${video}...`);
  try {
    const res = await runBenchmark(video);
    console.log(`Time: ${res.timeSec.toFixed(2)}s | FPS: ${res.fps.toFixed(1)} | Badge: ${res.badge}`);
    console.log(`Note: ${res.note}`);
  } catch (err) {
    console.error("Benchmark failed with error:", err);
    process.exit(1);
  }
}
