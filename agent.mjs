// agent.mjs - a data-analyst agent whose workspace lives on an Archil disk.
// Usage:  node agent.mjs "your task here"         (also opens a live dashboard at http://localhost:4321)
//         node agent.mjs --no-dashboard "task"     (terminal only)
//         node agent.mjs --replay [1|2]            (practice run: fake data, no API calls)
// Needs:  ARCHIL_API_KEY, ARCHIL_REGION, ANTHROPIC_API_KEY, ARCHIL_DISK_ID

import { writeFile } from "node:fs/promises";
import { posix } from "node:path";
import * as archil from "disk";
import { anthropic } from "@ai-sdk/anthropic";
import { ToolLoopAgent } from "ai";
import { createDiskTools } from "@archildata/ai-sdk";
import { startDashboard } from "./dashboard-server.mjs";
import { describeToolCall, addScriptActivity, stepError, listDiskFiles, diffFiles } from "./tool-activity.mjs";

const args = process.argv.slice(2);
if (args[0] === "--replay") {
  const { replay } = await import("./replay.mjs");
  await replay(args[1] === "1" ? 1 : 2);
} else {
  const useDashboard = !args.includes("--no-dashboard");
  await run(args.filter((a) => a !== "--no-dashboard").join(" "), useDashboard);
}

async function run(prompt, useDashboard) {
  const DISK_ID = process.env.ARCHIL_DISK_ID;
  if (!DISK_ID || !prompt) {
    console.error('Usage: node agent.mjs "your task"   (and set $env:ARCHIL_DISK_ID)');
    process.exit(1);
  }

  const disk = await archil.getDisk(DISK_ID);
  const workspace = archil.workspace({ workspace: { disk, conditional: true } });

  const agent = new ToolLoopAgent({
    model: anthropic(process.env.MODEL ?? "claude-sonnet-5-5"),
    instructions: [
      "You are a data analyst agent with a persistent disk.",
      "The disk is mounted at /mnt/archil/workspace; use that path for bash and for the file tools.",
      "Each bash command runs in a fresh container, so anything you want to keep must be saved to the disk.",
      "Python libraries are already installed on the disk: run Python as",
      "PYTHONPATH=/mnt/archil/workspace/pylib MPLBACKEND=Agg python3 <script>.",
      "The dataset is /mnt/archil/workspace/data/taxi.parquet (NYC yellow taxi trips, January 2024).",
      "Before starting, check the disk for earlier work (report.md, *.py scripts) and build on it instead of redoing it.",
      "Save reusable scripts as .py files and write findings to report.md in Markdown.",
      "For analysis tasks, also save one PNG bar chart of the main result with matplotlib,",
      "next to your scripts on the disk (e.g. /mnt/archil/workspace/tips_by_hour.png), with a clear title and axis labels.",
      "Keep the final answer to a few sentences summarizing what you did and what you saved.",
    ].join(" "),
    tools: createDiskTools(workspace),
  });

  const auditPath = `.audit/${Date.now()}.jsonl`;
  console.log(`\nTask: ${prompt}\n`);

  // Count this run on the disk itself, so a fresh sandbox still knows it's run #N.
  const runNumber = await countRun(disk, prompt);

  // Live dashboard: tool calls become steps, and steps become file reads/writes on the disk tree.
  const live = useDashboard ? await startDashboard().catch((err) => console.log(`(dashboard off: ${err.message})`)) : null;
  const emit = (type, data) => live?.emit(type, data);
  const steps = new Map(); // toolCallId -> described step
  const scripts = new Map(); // disk key -> script text the agent wrote this run
  const written = new Set();
  let files = new Map();
  let filesQueue = Promise.resolve();
  if (live) {
    console.log(`Dashboard: ${live.url}\n`);
    [files] = await Promise.all([listDiskFiles(disk).catch(() => new Map()), live.waitForPage(8000)]);
    const existing = [...files].map(([path, f]) => ({ path, size: f.size, pkg: f.pkg }));
    emit("run_start", { runNumber, prompt, diskName: disk.name, existing, startedAt: Date.now() });
  }
  const startedAt = Date.now();
  const markWritten = (id, path) => {
    written.add(path);
    emit("file_write", { id, path });
  };

  let result;
  try {
    result = await agent.generate({
      prompt,
      onToolExecutionStart: async ({ toolCall }) => {
        if (!live) return;
        const step = describeToolCall(toolCall.toolName, toolCall.input);
        step.scripts.forEach((code, key) => scripts.set(key, code));
        await addScriptActivity(step, async (key) => scripts.get(key) ?? new TextDecoder().decode(await disk.getObject(key)));
        steps.set(toolCall.toolCallId, step);
        emit("step_start", { id: toolCall.toolCallId, label: step.label, detail: step.detail, kind: step.kind });
        step.reads.forEach((path) => emit("file_read", { id: toolCall.toolCallId, path }));
      },
      onToolExecutionEnd: async ({ toolCall, toolOutput, toolExecutionMs }) => {
        const entry = {
          tool: toolCall.toolName,
          input: toolCall.input,
          ms: Math.round(toolExecutionMs),
          ok: toolOutput.type === "tool-result",
        };
        console.log(
          `  ${entry.ok ? "✓" : "✗"} ${entry.tool.padEnd(10)} ${String(entry.ms).padStart(6)}ms  ${JSON.stringify(entry.input).slice(0, 80)}`,
        );
        await disk.appendObject(auditPath, `${JSON.stringify(entry)}\n`);
        if (live) await showStepEnd(toolCall, toolOutput, entry.ms);
      },
    });
  } catch (err) {
    emit("run_end", { ok: false, error: "The agent stopped with an error.", totalMs: Date.now() - startedAt, final: true });
    await live?.close();
    throw err;
  }

  async function showStepEnd(toolCall, toolOutput, ms) {
    const id = toolCall.toolCallId;
    const step = steps.get(id) ?? describeToolCall(toolCall.toolName, toolCall.input);
    const error = stepError(toolCall.toolName, toolOutput);
    emit("step_end", { id, label: step.label, detail: step.detail, kind: step.kind, ms, ok: !error, error });
    if (error) return;
    step.writes.forEach((path) => markWritten(id, path));
    step.deletes.forEach((path) => emit("file_delete", { id, path }));
    // Bash can write files we can't see in the command, so compare the disk before and after.
    if (["run_bash", "write_file", "delete_file"].includes(toolCall.toolName)) {
      filesQueue = filesQueue.then(async () => {
        const now = await listDiskFiles(disk);
        const { changed, removed } = diffFiles(files, now);
        changed.filter((p) => !step.writes.has(p)).forEach((path) => markWritten(id, path));
        removed.filter((p) => !step.deletes.has(p)).forEach((path) => emit("file_delete", { id, path }));
        files = now;
      }).catch(() => {});
      await filesQueue;
    }
  }

  console.log(`\n${result.text}\n`);
  console.log(`Audit log saved on the disk at ${auditPath}`);

  // Pull the report down to this computer if the agent wrote one.
  for (const key of ["report.md", "workspace/report.md"]) {
    try {
      if (await disk.objectExists(key)) {
        await writeFile("report.md", await disk.getObject(key));
        console.log(`Downloaded ${key} -> .\\report.md`);
        break;
      }
    } catch {
      // try the next path
    }
  }

  // Pull down the newest chart the agent made this run, and show it on the dashboard.
  // A run that builds on earlier work may not draw a new one, so fall back to the chart
  // report.md points at (or the newest PNG on the disk).
  let chart = null;
  const byTime = (a, b) => (files.get(a)?.lastModified ?? 0) - (files.get(b)?.lastModified ?? 0);
  let newest = [...written].filter((p) => p.endsWith(".png")).sort(byTime).pop();
  const reused = !newest;
  if (reused) {
    const report = await disk.getObject("report.md").then((b) => new TextDecoder().decode(b)).catch(() => "");
    const all = [...files.keys()].filter((p) => p.endsWith(".png")).sort(byTime);
    newest = all.filter((p) => report.includes(posix.basename(p))).pop() ?? all.pop();
  }
  if (newest) {
    try {
      const png = await disk.getObject(newest);
      await writeFile(posix.basename(newest), png);
      console.log(`Downloaded ${newest} -> .\\${posix.basename(newest)}`);
      chart = { name: newest, reused, src: `data:image/png;base64,${Buffer.from(png).toString("base64")}` };
    } catch {
      // no chart, no problem
    }
  }

  if (live) {
    emit("run_end", { ok: true, totalMs: Date.now() - startedAt, steps: steps.size, filesWritten: written.size, chart, answer: result.text, final: true });
    await new Promise((r) => setTimeout(r, 1500)); // let the page receive the last event
    await live.close();
  }
}

async function countRun(disk, prompt) {
  const path = ".demo/runs.jsonl";
  try {
    const previous = (await disk.objectExists(path)) ? new TextDecoder().decode(await disk.getObject(path)).split("\n").filter(Boolean).length : 0;
    await disk.appendObject(path, `${JSON.stringify({ run: previous + 1, at: new Date().toISOString(), prompt })}\n`);
    return previous + 1;
  } catch {
    return 1;
  }
}
