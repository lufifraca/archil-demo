// tool-activity.mjs - turns the agent's tool calls into plain-English steps and file activity
// for the live dashboard. File tools map directly; bash commands are pattern-matched (best effort).

import { posix } from "node:path";

const MOUNT = "/mnt/archil"; // run_bash starts here; the disk itself is at /mnt/archil/workspace
const FILE_RE = /[\w.\-\/]*[\w-]\.(?:py|md|csv|parquet|json|png|txt)\b/g;
const WRITE_HINT = /savefig|to_csv|to_parquet|to_json|write_text|write_bytes|\.write\(|open\([^)]*,\s*['"][wa]/;
const HIDDEN = /^(pylib|\.audit|\.demo)\//;

/** Map a path as the agent wrote it to a key on the disk ("data/taxi.parquet"), or null if it isn't on the disk. */
export function diskKey(path, cwd = MOUNT) {
  let p = posix.normalize(path.startsWith("/") ? path : posix.join(cwd, path));
  p = p.replace(/^\/mnt\/archil(?=\/)/, "");
  if (!p.startsWith("/workspace/")) return null;
  const key = p.slice("/workspace/".length);
  return key && !HIDDEN.test(key) ? key : null;
}

function filesIn(text, cwd, loose = false) {
  const keys = new Set();
  for (const [match] of text.matchAll(FILE_RE)) {
    // Inside scripts, f"{OUT_DIR}/chart.png" leaves "/chart.png"; treat it as relative.
    const key = diskKey(match, cwd) ?? (loose ? diskKey(match.replace(/^\/+/, ""), cwd) : null);
    if (key) keys.add(key);
  }
  return [...keys];
}

/** Which disk files a piece of Python reads and writes, judged line by line. */
export function analyzePython(code, cwd = MOUNT) {
  const reads = new Set();
  const writes = new Set();
  const named = []; // OUT = "tips_by_hour.png" -> decide once we see how OUT is used
  const lines = code.split("\n");
  for (const line of lines) {
    const keys = filesIn(line, cwd, true);
    if (!keys.length) continue;
    const constant = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*(?:Path\()?[rfb]?["'][^"']*["']\)?\s*(#.*)?$/);
    if (WRITE_HINT.test(line)) keys.forEach((k) => writes.add(k));
    else if (constant) named.push([constant[1], keys]);
    else keys.forEach((k) => reads.add(k));
  }
  for (const [name, keys] of named) {
    const used = new RegExp(`\\b${name}\\b`);
    const isWrite = lines.some((l) => WRITE_HINT.test(l) && used.test(l));
    keys.forEach((k) => (isWrite ? writes : reads).add(k));
  }
  writes.forEach((k) => reads.delete(k));
  return { reads, writes };
}

/** Pull a bash command apart: shell text, heredoc bodies, working dir, and the files it touches. */
export function analyzeBash(command) {
  // Heredoc bodies are file contents or inline Python, not shell commands, so set them aside first.
  const lines = command.split("\n");
  const shell = [];
  const heredocs = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i];
    shell.push(head);
    const m = head.match(/<<-?\s*(['"]?)(\w+)\1/);
    if (!m) continue;
    const body = [];
    while (++i < lines.length && lines[i].trim() !== m[2]) body.push(lines[i]);
    heredocs.push({ head, body: body.join("\n") });
  }
  const text = shell.join("\n");
  const cd = text.match(/(?:^|[;&|]\s*)cd\s+([^\s;&|]+)/m);
  const cwd = cd ? (cd[1].startsWith("/") ? cd[1] : posix.join(MOUNT, cd[1])) : MOUNT;

  const a = { cwd, text, reads: new Set(), writes: new Set(), deletes: new Set(), runs: [], scripts: new Map(), inlinePython: false };
  const merge = ({ reads, writes }) => {
    reads.forEach((k) => a.reads.add(k));
    writes.forEach((k) => a.writes.add(k));
  };

  // Redirects and tee: > file, >> file, tee [-a] file
  for (const m of text.matchAll(/(?:>>?|\btee\s+(?:-a\s+)?)\s*(['"]?)([^\s'";&|<>]+)\1/g)) {
    const [key] = filesIn(m[2], cwd);
    if (key) a.writes.add(key);
  }
  for (const { head, body } of heredocs) {
    const target = head.match(/>\s*(['"]?)([^\s'";&|<>]+)\1/);
    const key = target && diskKey(target[2], cwd);
    if (key) a.scripts.set(key, body); // e.g. cat > clean.py << 'EOF'
    else if (/\bpython3?\b/.test(head)) {
      a.inlinePython = true;
      merge(analyzePython(body, cwd));
    }
  }
  const inline = text.match(/\bpython3?\s+-c\s+(["'])([\s\S]*?)\1/);
  if (inline) {
    a.inlinePython = true;
    merge(analyzePython(inline[2], cwd));
  }
  for (const m of text.matchAll(/\bpython3?(?:\s+-\w+)*\s+([^\s;&|<>'"]+\.py)\b/g)) {
    const key = diskKey(m[1], cwd);
    if (key) a.runs.push(key); // running a script counts as reading it
  }
  for (const m of text.matchAll(/\brm\s+([^;&|\n]+)/g)) filesIn(m[1], cwd).forEach((k) => a.deletes.add(k));
  // Anything else mentioned (cat, head, python <script>, ...) is a read.
  for (const key of filesIn(text, cwd)) if (!a.writes.has(key) && !a.deletes.has(key)) a.reads.add(key);
  return a;
}

const base = (key) => posix.basename(key);
const names = (keys) => {
  const list = [...keys];
  return list.length > 1 ? `${base(list[0])} and ${list.length - 1} more` : base(list[0]);
};

function bashStep(command) {
  const a = analyzeBash(command);
  const verbs = new Set(
    a.text
      .split(/&&|\|\||[;|\n]/)
      .map((s) => s.trim().replace(/^(\w+=\S*\s+)+/, "").split(/\s+/)[0])
      .filter((v) => v && v !== "cd"),
  );
  const has = (...v) => v.some((x) => verbs.has(x));
  const writes = new Set([...a.writes, ...a.scripts.keys()]);
  let label, kind;
  if (/\bpip3?\s+install\b|-m\s+pip\s+install\b/.test(a.text)) [label, kind] = ["📦 Installing Python packages", "run"];
  else if (a.runs.length && a.scripts.size) [label, kind] = [`▶ Writing & running ${names(a.runs)}`, "run"];
  else if (a.runs.length) [label, kind] = [`▶ Running ${names(a.runs)}`, "run"];
  else if (a.inlinePython) [label, kind] = ["▶ Running a Python snippet", "run"];
  else if (writes.size) [label, kind] = [`✏️ Writing ${names(writes)}`, "write"];
  else if (has("cat", "head", "tail", "less", "more", "wc") && a.reads.size) [label, kind] = [`📖 Reading ${names(a.reads)}`, "read"];
  else if (has("ls", "find", "tree", "du", "stat")) [label, kind] = ["🔍 Listing files", "list"];
  else if (has("grep", "rg")) [label, kind] = ["🔎 Searching files", "list"];
  else if (a.deletes.size) [label, kind] = [`🗑️ Deleting ${names(a.deletes)}`, "write"];
  else if (has("mkdir")) [label, kind] = ["📁 Creating a folder", "write"];
  else [label, kind] = ["⌨️ Running a shell command", "run"];

  // A short, readable version of the command for the card's second line.
  let detail = a.text.split("\n")[0]
    .replace(/^cd\s+\S+\s*&&\s*/, "")
    .replace(/(^|\s)(\w+=\S*\s+)+/g, "$1")
    .replaceAll("/mnt/archil/workspace/", "")
    .replace(/\s+/g, " ")
    .trim();
  if (detail.length > 64) detail = `${detail.slice(0, 63)}…`;

  return { label, kind, detail, cwd: a.cwd, reads: new Set([...a.reads, ...a.runs]), writes, deletes: a.deletes, runs: a.runs, scripts: a.scripts };
}

/** Describe one tool call: a plain-English label plus the disk files it reads/writes/deletes. */
export function describeToolCall(toolName, input = {}) {
  const step = { label: "", kind: "other", detail: "", cwd: MOUNT, reads: new Set(), writes: new Set(), deletes: new Set(), runs: [], scripts: new Map() };
  const key = typeof input.path === "string" ? diskKey(input.path) : null;
  const where = String(input.path ?? "").replace(/^\/mnt\/archil/, "").replace(/^\/?workspace\/?/, "").replace(/^\/+|\/+$/g, "");
  switch (toolName) {
    case "read_file":
      Object.assign(step, { label: `📖 Reading ${base(where)}`, kind: "read" });
      if (key) step.reads.add(key);
      break;
    case "write_file":
      Object.assign(step, { label: `✏️ Writing ${base(where)}`, kind: "write" });
      if (key) {
        step.writes.add(key);
        step.scripts.set(key, String(input.content ?? ""));
      }
      break;
    case "delete_file":
      Object.assign(step, { label: `🗑️ Deleting ${base(where)}`, kind: "write" });
      if (key) step.deletes.add(key);
      break;
    case "list_files":
      Object.assign(step, { label: where ? `🔍 Listing files in ${where}/` : "🔍 Listing files", kind: "list" });
      break;
    case "glob":
      Object.assign(step, { label: `🔍 Finding ${input.pattern}`, kind: "list" });
      break;
    case "grep": {
      const pattern = String(input.pattern ?? "");
      Object.assign(step, { label: `🔎 Searching for “${pattern.length > 30 ? `${pattern.slice(0, 29)}…` : pattern}”`, kind: "list" });
      break;
    }
    case "run_bash":
      return bashStep(String(input.command ?? ""));
    default:
      step.label = `🛠️ ${toolName}`;
  }
  return step;
}

/** For each script a step runs, look inside it to see which data files it reads and writes. */
export async function addScriptActivity(step, readScript) {
  for (const key of step.runs) {
    const code = await readScript(key).catch(() => null);
    if (!code) continue;
    const { reads, writes } = analyzePython(code, step.cwd);
    reads.forEach((k) => step.reads.add(k));
    writes.forEach((k) => step.writes.add(k));
  }
}

/** A short, human-readable error for a failed step, or null if it succeeded. */
export function stepError(toolName, toolOutput) {
  const short = (s) => String(s ?? "").trim().split("\n").filter(Boolean).pop()?.slice(0, 140) || "failed";
  if (toolOutput.type !== "tool-result") return short(toolOutput.error?.message ?? toolOutput.error);
  const out = toolOutput.output;
  if (out?.error) return short(out.error.message);
  if (toolName === "run_bash" && out?.exitCode) return out.stderr?.trim() ? short(out.stderr) : `exit code ${out.exitCode}`;
  return null;
}

/** Files on the disk, without pylib/ internals or hidden folders. pylib/ shows up as a single "pylib/" entry. */
export async function listDiskFiles(disk) {
  const files = new Map();
  const add = (o) => {
    if (!o.key.endsWith("/") && !o.key.startsWith(".")) files.set(o.key, { size: o.size, etag: o.etag, lastModified: o.lastModified });
  };
  const top = await disk.listObjects("");
  top.objects.forEach(add);
  await Promise.all(
    top.commonPrefixes.map(async (raw) => {
      const prefix = `${raw.replace(/\/+$/, "")}/`;
      if (prefix === "pylib/") files.set("pylib/", { pkg: true });
      else if (!prefix.startsWith(".")) (await disk.listObjects(prefix, { recursive: true, limit: 2000 })).objects.forEach(add);
    }),
  );
  return files;
}

/** What changed on the disk between two listings. */
export function diffFiles(before, after) {
  const changed = [];
  for (const [key, f] of after) {
    const old = before.get(key);
    if (!f.pkg && (!old || old.etag !== f.etag || old.size !== f.size)) changed.push(key);
  }
  const removed = [...before.keys()].filter((k) => !after.has(k));
  return { changed, removed };
}
