// dashboard-server.mjs - serves dashboard.html on localhost and streams run events to it
// with Server-Sent Events. Only node:http; no dependencies.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

export async function startDashboard({ port = 4321, open = true } = {}) {
  const url = `http://localhost:${port}`;
  const clients = new Set();
  let history = []; // every event so far, replayed to pages that connect (or reload) late
  let firstClient;
  const connected = new Promise((resolve) => (firstClient = resolve));

  const server = http.createServer(async (req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      history.forEach((event) => res.write(frame(event)));
      clients.add(res);
      req.on("close", () => clients.delete(res));
      firstClient();
    } else if (req.url === "/" || req.url.startsWith("/?")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(await readFile(new URL("./dashboard.html", import.meta.url)));
    } else {
      res.writeHead(404).end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", (err) =>
      reject(err.code === "EADDRINUSE" ? new Error(`Port ${port} is busy. Is another dashboard still running?`) : err),
    );
    server.listen(port, "127.0.0.1", resolve);
  });
  const keepAlive = setInterval(() => clients.forEach((res) => res.write(": ping\n\n")), 15000);
  if (open) openBrowser(url);

  return {
    url,
    emit(type, data = {}) {
      const event = { type, ...data };
      if (type === "run_start") history = [];
      history.push(event);
      clients.forEach((res) => res.write(frame(event)));
    },
    /** Wait for the page to connect (so the recording catches the start), but never forever. */
    waitForPage: (ms) => Promise.race([connected, new Promise((r) => setTimeout(r, ms))]),
    async close() {
      clearInterval(keepAlive);
      clients.forEach((res) => res.end());
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => console.log(`Open ${url} in your browser to watch the run.`));
  child.unref();
}
