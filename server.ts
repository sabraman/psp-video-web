// Dev/prod server: bundles src/app.ts -> public/app.js on startup, serves ./public.
export {};
const result = await Bun.build({
  entrypoints: ["./src/app.ts", "./src/worker.ts"],
  outdir: "./public",
  target: "browser",
  sourcemap: "external",
  minify: process.env.NODE_ENV === "production",
});

if (!result.success) {
  console.error("Bundle failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log("Bundled src/app.ts + src/worker.ts -> public/");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".css": "text/css; charset=utf-8",
  ".mp4": "video/mp4",
  ".svg": "image/svg+xml",
};

const port = Number(process.env.PORT ?? 3000);

Bun.serve({
  port,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/index.html";
    const file = Bun.file("./public" + path);
    if (await file.exists()) {
      const ext = path.slice(path.lastIndexOf("."));
      return new Response(file, {
        headers: { "Content-Type": MIME[ext] ?? "application/octet-stream" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`psp-video-web on http://127.0.0.1:${port}`);
