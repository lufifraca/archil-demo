// replay.mjs - practice mode. Plays a believable fake run through the live dashboard:
// no Anthropic calls, no Archil calls. Usage: node agent.mjs --replay 1   (or 2)

import { createInterface } from "node:readline";
import { startDashboard } from "./dashboard-server.mjs";

const DISK_NAME = process.env.DEMO_DISK_NAME ?? "taxi-analysis";
const PY = "python3"; // real runs show commands without the PYTHONPATH=... prefix too

// Steps: think = model "thinking" before the tool call, ms = how long the tool runs.
const RUNS = {
  1: {
    prompt: "Profile data/taxi.parquet for data quality problems, clean it, and summarize the key stats in report.md.",
    existing: [{ path: "data/taxi.parquet", size: 49961641 }, { path: "pylib/", pkg: true }],
    steps: [
      { think: 2200, ms: 240, label: "🔍 Listing files", kind: "list" },
      { think: 4100, ms: 190, label: "✏️ Writing explore.py", kind: "write", writes: ["explore.py"] },
      { think: 1500, ms: 8400, label: "▶ Running explore.py", kind: "run", detail: `${PY} explore.py`, reads: ["explore.py", "data/taxi.parquet"] },
      { think: 6200, ms: 210, label: "✏️ Writing clean.py", kind: "write", writes: ["clean.py"] },
      { think: 1400, ms: 6100, label: "▶ Running clean.py", kind: "run", detail: `${PY} clean.py`, reads: ["clean.py", "data/taxi.parquet"], error: "KeyError: 'duration_min'" },
      { think: 3300, ms: 200, label: "✏️ Writing clean.py", kind: "write", writes: ["clean.py"] },
      { think: 1300, ms: 9800, label: "▶ Running clean.py", kind: "run", detail: `${PY} clean.py`, reads: ["clean.py", "data/taxi.parquet"], writes: ["data/taxi_clean.parquet"] },
      { think: 4800, ms: 230, label: "✏️ Writing stats.py", kind: "write", writes: ["stats.py"] },
      { think: 1200, ms: 7300, label: "▶ Running stats.py", kind: "run", detail: `${PY} stats.py`, reads: ["stats.py", "data/taxi_clean.parquet"], writes: ["fare_by_hour.png"] },
      { think: 7400, ms: 260, label: "✏️ Writing report.md", kind: "write", writes: ["report.md"] },
    ],
    answer:
      "Profiled 2,964,624 raw trips and found zero-distance trips, negative fares and impossible timestamps. clean.py keeps 2,839,626 rows (95.8%) in data/taxi_clean.parquet. Key stats, the cleaning rules and a fare-by-hour chart are in report.md and fare_by_hour.png.",
    chart: {
      name: "fare_by_hour.png",
      title: "Average fare by pickup hour (Jan 2024)",
      xlabel: "Pickup hour",
      ylabel: "Average fare ($)",
      values: [19.4, 18.2, 16.6, 18.1, 22.97, 26.58, 19.9, 17.6, 17.3, 17.5, 17.8, 17.9, 17.9, 18.4, 18.9, 18.6, 18.3, 17.4, 16.96, 17.1, 17.6, 18.3, 19.0, 19.6],
    },
  },
  2: {
    prompt: "Which pickup hours get the best tips? Build on the earlier work.",
    existing: [
      { path: "data/taxi.parquet", size: 49961641 },
      { path: "data/taxi_clean.parquet", size: 52418090 },
      { path: "explore.py", size: 1842 },
      { path: "clean.py", size: 2715 },
      { path: "stats.py", size: 2208 },
      { path: "fare_by_hour.png", size: 41387 },
      { path: "report.md", size: 5757 },
      { path: "pylib/", pkg: true },
    ],
    steps: [
      { think: 2000, ms: 230, label: "🔍 Listing files", kind: "list" },
      { think: 1800, ms: 180, label: "📖 Reading report.md", kind: "read", reads: ["report.md"] },
      { think: 2400, ms: 160, label: "📖 Reading clean.py", kind: "read", reads: ["clean.py"] },
      { think: 5600, ms: 210, label: "✏️ Writing tips_by_hour.py", kind: "write", writes: ["tips_by_hour.py"] },
      { think: 1300, ms: 6800, label: "▶ Running tips_by_hour.py", kind: "run", detail: `${PY} tips_by_hour.py`, reads: ["tips_by_hour.py", "data/taxi_clean.parquet"], writes: ["tips_by_hour.csv", "tips_by_hour.png"] },
      { think: 2600, ms: 2100, label: "📖 Reading tips_by_hour.csv", kind: "read", detail: "head -n 25 tips_by_hour.csv", reads: ["tips_by_hour.csv"] },
      { think: 6900, ms: 240, label: "✏️ Writing report.md", kind: "write", writes: ["report.md"] },
    ],
    answer:
      "Reused the cleaned dataset from the earlier run instead of re-cleaning 3M rows. Credit-card tips peak at 27.9% of the fare for 5 a.m. pickups and bottom out around 25.4% mid-afternoon. Saved tips_by_hour.py, tips_by_hour.csv, tips_by_hour.png and a new section in report.md.",
    chart: {
      name: "tips_by_hour.png",
      title: "Average tip % by pickup hour (credit card, Jan 2024)",
      xlabel: "Pickup hour",
      ylabel: "Tip (% of fare)",
      values: [27.1, 27.0, 26.8, 26.9, 27.4, 27.9, 27.2, 26.6, 26.1, 25.8, 25.6, 25.5, 25.4, 25.4, 25.5, 25.7, 26.0, 26.3, 26.7, 27.0, 27.2, 27.3, 27.3, 27.2],
    },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function replay(n) {
  const run = RUNS[n];
  let live;
  try {
    live = await startDashboard();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  console.log(`\nPractice mode (replay ${n}): ${live.url}  · no API calls\n`);
  await live.waitForPage(15000);
  await sleep(1500);

  const play = async () => {
    console.log(`Task: ${run.prompt}\n`);
    const startedAt = Date.now();
    const written = new Set();
    live.emit("run_start", { runNumber: n, prompt: run.prompt, diskName: DISK_NAME, existing: run.existing, startedAt, practice: true });
    for (const [i, s] of run.steps.entries()) {
      const id = `step-${i}`;
      await sleep(s.think);
      live.emit("step_start", { id, label: s.label, detail: s.detail ?? "", kind: s.kind });
      (s.reads ?? []).forEach((path) => live.emit("file_read", { id, path }));
      await sleep(s.ms);
      live.emit("step_end", { id, label: s.label, detail: s.detail ?? "", kind: s.kind, ms: s.ms, ok: !s.error, error: s.error ?? null });
      console.log(`  ${s.error ? "✗" : "✓"} ${s.label}  ${s.ms}ms`);
      if (s.error) continue;
      for (const path of s.writes ?? []) {
        written.add(path);
        live.emit("file_write", { id, path });
      }
    }
    await sleep(3500);
    const chart = { name: run.chart.name, src: `data:image/svg+xml;base64,${Buffer.from(barChartSvg(run.chart)).toString("base64")}` };
    live.emit("run_end", { ok: true, totalMs: Date.now() - startedAt, steps: run.steps.length, filesWritten: written.size, chart, answer: run.answer, final: false });
    console.log(`\n${run.answer}\n`);
  };

  await play();
  console.log("Replay done. Press Enter to play it again, or Ctrl+C to quit.");
  let playing = false;
  createInterface({ input: process.stdin }).on("line", async () => {
    if (playing) return;
    playing = true;
    await play();
    playing = false;
    console.log("Replay done. Press Enter to play it again, or Ctrl+C to quit.");
  });
}

/** A stand-in for the matplotlib PNG the real agent saves: white background, default blue bars. */
function barChartSvg({ title, xlabel, ylabel, values }) {
  const W = 1000, H = 560, L = 90, R = 30, T = 70, B = 80;
  const max = Math.ceil(Math.max(...values) / 5) * 5;
  const min = Math.min(...values) > 15 ? Math.floor((Math.min(...values) - 2) / 5) * 5 : 0;
  const x = (i) => L + ((W - L - R) / values.length) * i;
  const y = (v) => T + (H - T - B) * (1 - (v - min) / (max - min));
  const bw = ((W - L - R) / values.length) * 0.8;
  const ticks = [];
  for (let v = min; v <= max; v += (max - min) / 5) ticks.push(v);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans, Arial, sans-serif">
  <rect width="${W}" height="${H}" fill="#fff"/>
  <text x="${W / 2}" y="40" font-size="22" text-anchor="middle">${title}</text>
  ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#ddd"/><text x="${L - 10}" y="${y(v) + 5}" font-size="15" text-anchor="end">${+v.toFixed(1)}</text>`).join("")}
  ${values.map((v, i) => `<rect x="${x(i) + bw * 0.125}" y="${y(v)}" width="${bw}" height="${H - B - y(v)}" fill="#1f77b4"/>`).join("")}
  ${values.map((_, i) => (i % 2 ? "" : `<text x="${x(i) + bw * 0.625}" y="${H - B + 24}" font-size="15" text-anchor="middle">${i}</text>`)).join("")}
  <line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="#000"/>
  <line x1="${L}" x2="${L}" y1="${T}" y2="${H - B}" stroke="#000"/>
  <text x="${W / 2}" y="${H - 20}" font-size="18" text-anchor="middle">${xlabel}</text>
  <text x="26" y="${H / 2}" font-size="18" text-anchor="middle" transform="rotate(-90 26 ${H / 2})">${ylabel}</text>
</svg>`;
}
