#!/usr/bin/env node
/**
 * Minimal static file server for public/ — used both for local dev
 * (`npm run serve`) and by scripts/verify.mjs's automated check. Node-only
 * (no python3 dependency) so it runs the same way locally and in CI.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".gz": "application/gzip",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".png": "image/png",
};

export function startServer(root, port) {
  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const relative = urlPath === "/" ? "/index.html" : urlPath;
    const filePath = normalize(join(root, relative));

    if (!filePath.startsWith(normalize(root))) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    try {
      await stat(filePath);
      const data = await readFile(filePath);
      const type = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
      res.writeHead(200, { "Content-Type": type });
      res.end(data);
    } catch {
      res.writeHead(404).end("Not found");
    }
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

// Run directly (not imported) => start an interactive dev server.
if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL("../public", import.meta.url).pathname;
  const port = Number(process.env.PORT ?? 8080);
  await startServer(root, port);
  console.log(`Serving ${root} at http://127.0.0.1:${port}`);
}
