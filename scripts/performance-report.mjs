import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = process.env.MONOCODE_PERF_OUTPUT_DIR ?? join(tmpdir(), "monocode-performance");
mkdirSync(directory, { recursive: true });
const metricFiles = ["perf-shell-publication.json", "perf-markdown-blocks.json", "perf-host-persistence.json",
  "perf-host-projection.json", "perf-inbox-routing.json"];
for (const name of ["performance-results.json", "performance-report.md", "transcript-resources.json", "web-tests.json", "host-tests.json", ...metricFiles]) {
  const path = join(directory, name);
  if (existsSync(path)) unlinkSync(path);
}
const nodeOptions = Number(process.versions.node.split(".")[0]) >= 22
  ? `${process.env.NODE_OPTIONS ?? ""} --no-experimental-webstorage` : process.env.NODE_OPTIONS;
const env = { ...process.env, NODE_OPTIONS: nodeOptions, MONOCODE_PERF_OUTPUT_DIR: directory };
const groups = [
  ["web", [
    "src/app/model/sessionPublication.test.ts",
    "src/features/sessions/ui/AgentTranscript.resources.test.ts",
    "src/features/sessions/ui/incrementalMarkdownBlocks.test.ts",
    "src/features/files/editor/codeHighlightPlugin.test.ts",
    "src/features/files/model/fileTree.test.ts",
    "src/features/connections/model/remoteSubscriptions.test.ts",
    "src/platform/tauri/ptyFlow.test.ts",
    "src/features/inbox/model/githubTasks.repositories.test.ts",
  ]],
  ["host", ["--config", "host/vitest.config.ts", "host/store.test.ts", "host/large-sync.test.ts"]],
];
let failed = false;
const suites = [];
for (const [name, args] of groups) {
  const path = join(directory, `${name}-tests.json`);
  const run = spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run",
    ...args, "--reporter=default", "--reporter=json", `--outputFile=${path}`],
  { cwd: root, env, stdio: "inherit" });
  failed ||= run.status !== 0;
  suites.push({ name, exitCode: run.status, results: existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null });
}
const baseline = JSON.parse(readFileSync(join(root, "docs/performance-baseline-188da0a.json"), "utf8"));
const measurementsPath = join(directory, "transcript-resources.json");
const transcript = existsSync(measurementsPath) ? JSON.parse(readFileSync(measurementsPath, "utf8")) : [];
const sourceCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const dirty = !!spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim();
const metrics = Object.fromEntries(metricFiles.filter((name) => existsSync(join(directory, name)))
  .map((name) => [name.slice(5, -5), JSON.parse(readFileSync(join(directory, name), "utf8"))]));
const nativePath = process.env.MONOCODE_PERF_NATIVE_METRICS_PATH;
if (nativePath) metrics["native-git"] = JSON.parse(readFileSync(nativePath, "utf8"));
const result = { sourceCommit, dirty, runtime: process.version, status: failed ? "failed" : "passed", baseline,
  measurements: { transcript, ...metrics }, suites };
writeFileSync(join(directory, "performance-results.json"), JSON.stringify(result, null, 2) + "\n");
const rows = transcript.map((row) => {
  const before = baseline.transcript.find((entry) => entry.turns === row.turns);
  return `| ${row.turns} | ${before?.mountedMessages ?? "—"} | ${row.mountedMessages} | ${before?.nodes ?? "—"} | ${row.nodes} |`;
});
writeFileSync(join(directory, "performance-report.md"), [
  "# MonoCode performance regression fixtures", "", `Source: ${sourceCommit}${dirty ? " (working tree modified)" : ""}; ${process.version}; ${result.status}.`, "",
  "| Loaded turns | Baseline mounted rows | Current mounted rows | Baseline DOM nodes | Current DOM nodes |",
  "|---|---|---|---|---|", ...rows, "",
  "## Current measured work", "", ...Object.entries(metrics).map(([name, values]) => `- ${name}: ${JSON.stringify(values)}`), "",
  "These are deterministic resource-work fixtures. Test durations are diagnostic, not whole-app latency or CPU/energy benchmarks.",
  "The JSON artifact includes every regression assertion result. Native PTY/Git budgets are checked by the existing Rust CI job.", "",
].join("\n"));
console.log(`Performance artifacts: ${directory}`);
process.exitCode = failed ? 1 : 0;
