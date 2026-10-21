/**
 * Reproducible measurements behind the numbers in the README: `npm run bench` (add `-- --write` to update
 * BENCHMARK.md). No model and no network: everything is measured from the real code, a real Git repository and real
 * processes. Token counts are estimates (about 3.5 characters per token for English text and JSON); no tokenizer
 * is bundled, so treat them as approximate. The fixture repository is this project's own src/ and test/.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { HandoffStore } from "../src/storage.js";
import { hasInstructionsBlock, runHook } from "../src/hooks.js";
import { renderBrief } from "../src/handoff.js";
import { getRepoState } from "../src/git.js";
import { tokenSettings } from "../src/tokens.js";
import { INSTRUCTIONS } from "../src/init.js";
import { analyzePrompt } from "../src/prompt-gate.js";
import { estimateTokens } from "../src/tokens.js";
import { CORPUS } from "../test/prompt-corpus.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "dist", "src", "index.js");
const write = process.argv.includes("--write");
const tok = (text: string) => estimateTokens(text);
const fmt = (n: number) => n.toLocaleString("en-US");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Bench", "-c", "user.email=bench@example.com", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
}

async function copyDir(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(source, target);
    else await fs.copyFile(source, target);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)]);
}

function time(runs: number, run: () => void): { median: number; p90: number } {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    run();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { median: median(times), p90: Math.round(times[Math.min(times.length - 1, Math.floor(times.length * 0.9))]) };
}

const lines: string[] = [];
const out = (line = "") => lines.push(line);

async function main() {
  const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ai-handoff-bench-")));
  const project = path.join(work, "project");
  const store = new HandoffStore(path.join(work, "data"));

  // A real codebase: this project's own source and tests, committed.
  await copyDir(path.join(ROOT, "src"), path.join(project, "src"));
  await copyDir(path.join(ROOT, "test"), path.join(project, "test"));
  git(project, "init", "-q", "-b", "main");
  git(project, "add", ".");
  git(project, "commit", "-q", "-m", "baseline");
  const tracked = git(project, "ls-files").trim().split("\n");
  let repoChars = 0;
  for (const file of tracked) repoChars += (await fs.readFile(path.join(project, file), "utf8")).length;

  // A task in progress: a checkpoint, then three files edited before the session ends at a usage limit.
  const client = new Client({ name: "bench", version: "1" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([createServer(store).connect(serverSide), client.connect(clientSide)]);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  await runHook("session-start", "claude", JSON.stringify({ cwd: project, session_id: "a", source: "startup" }), { store, env: {} });
  await call("save_handoff", {
    projectPath: project,
    agent: "claude",
    task: "Add a per-project token budget to the brief and expose it in the CLI",
    currentStep: "Wiring maxChars from .ai-handoff.json into renderBrief in src/handoff.ts",
    completed: ["Read src/handoff.ts and src/hooks.ts", "Added the tokens setting to ProjectConfig"],
    nextSteps: ["Pass maxChars from the session-start hook", "Add a tokens command to src/cli.ts", "Write tests in test/tokens.test.ts", "Run npm test"],
    decisions: ["Keep tool descriptions unchanged: they are what makes checkpoints useful", "Minimum brief of 1,500 characters"],
    keyFiles: ["src/handoff.ts", "src/hooks.ts", "src/cli.ts"],
    tests: ["npm test: all passed before the change"]
  });
  const edits: [string, string][] = [
    ["src/handoff.ts", "\n// bench: wiring maxChars\nexport const BENCH_MAX = 3000;\n"],
    ["src/hooks.ts", "\n// bench: read tokens config\nexport const BENCH_HOOK = true;\n"],
    ["src/cli.ts", "\n// bench: tokens command\nexport const BENCH_CLI = true;\n"]
  ];
  for (const [i, [file, text]] of edits.entries()) {
    await fs.appendFile(path.join(project, file), text);
    await runHook(
      "post-tool",
      "claude",
      JSON.stringify({ cwd: project, session_id: "a", hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: `e${i}`, tool_input: { file_path: path.join(project, file) } }),
      { store, env: {} }
    );
  }

  // What the next agent gets with the tool: the brief the session-start hook injects (checked once through the real
  // hook), rendered from one state so the variants are comparable (each injection adds a line to the timeline).
  const record = await store.get(project);
  const { git: gitNow, changes } = await getRepoState(project, record?.git ?? null);
  const render = (maxChars: number, rulesInInstructions: boolean) =>
    renderBrief({ projectPath: project, record, git: gitNow, changes, detail: "compact", maxChars, rulesInInstructions });
  const briefStandard = render(tokenSettings(undefined).briefChars, false);
  const injected = JSON.parse(
    (await runHook("session-start", "claude", JSON.stringify({ cwd: project, session_id: "b", source: "startup" }), { store, env: {} })).stdout
  ).hookSpecificOutput.additionalContext as string;
  if (briefStandard !== injected) throw new Error("the rendered brief differs from the one the hook injected");
  const briefDeduped = render(tokenSettings(undefined).briefChars, true);
  const briefLean = render(tokenSettings({ profile: "lean" }).briefChars, true);
  await fs.writeFile(path.join(project, "CLAUDE.md"), INSTRUCTIONS + "\n");
  if (!(await hasInstructionsBlock(project, "claude"))) throw new Error("instructions block not detected");
  await fs.rm(path.join(project, "CLAUDE.md"));

  // Without the tool, the least a new agent must read to see what changed (and it still does not learn the task,
  // the next steps or the decisions): git status, the diff, and the changed files.
  const status = git(project, "status", "--short");
  const diff = git(project, "diff");
  let changedChars = 0;
  for (const [file] of edits) changedChars += (await fs.readFile(path.join(project, file), "utf8")).length;
  const minimal = status.length + diff.length + changedChars;

  const listTools = async (tools: "all" | "core" | "minimal") => {
    const c = new Client({ name: "bench-tools", version: "1" });
    const [cs, ss] = InMemoryTransport.createLinkedPair();
    await Promise.all([createServer(store, { tools }).connect(ss), c.connect(cs)]);
    return JSON.stringify((await c.listTools()).tools);
  };
  const toolsAll = await listTools("all");
  const toolsCore = await listTools("core");
  const toolsMinimal = await listTools("minimal");

  // Prompt gate accuracy on the labelled corpus (first prompt of a session).
  const first = { firstInSession: true, hasCheckpoint: false };
  let clear = 0, vague = 0, falseBlocks = 0, missed = 0;
  const gaps: number[] = [];
  for (const pair of CORPUS) {
    for (const lang of ["en", "ar"] as const) {
      const verdict = analyzePrompt(pair[lang], first);
      if (pair.label === "clear") (clear++, verdict.action === "block" && falseBlocks++);
      else (vague++, verdict.action === "allow" && missed++);
    }
    gaps.push(Math.abs(analyzePrompt(pair.en, first).score - analyzePrompt(pair.ar, first).score));
  }
  const meanGap = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;

  // Nudge cost: the one extra message the agent gets when it stops without recording its intent.
  const nudge = JSON.parse(
    (await runHook("stop", "claude", JSON.stringify({ cwd: project, session_id: "a", hook_event_name: "Stop" }), { store, env: {} })).stdout || "{}"
  ).reason as string | undefined;

  // Hook latency with real processes. The data directory is isolated.
  const env = { ...process.env, AI_HANDOFF_DATA_DIR: path.join(work, "latency") };
  const spawnHook = (event: string, input: object) => () =>
    spawnSync(process.execPath, [ENTRY, "hook", event, "--agent", "claude"], { input: JSON.stringify(input), env, cwd: project });
  const runs = 15;
  const latency = {
    bare: time(runs, () => spawnSync(process.execPath, ["-e", "0"])),
    // What every hook command paid before the SDK was loaded lazily: importing the MCP server SDK and zod.
    sdk: time(runs, () =>
      spawnSync(process.execPath, ["--input-type=module", "-e", 'await import("@modelcontextprotocol/sdk/server/mcp.js"); await import("zod");'], { cwd: ROOT })
    ),
    preTool: time(runs, spawnHook("pre-tool", { cwd: project, session_id: "l", tool_name: "Read", tool_input: { file_path: path.join(project, "src", "cli.ts") } })),
    prompt: time(runs, spawnHook("prompt-submit", { cwd: project, session_id: "l", prompt: "In src/cli.ts rename runCli() to run() so that the tests still pass" })),
    sessionStart: time(runs, spawnHook("session-start", { cwd: project, session_id: "l", source: "startup" }))
  };
  // npx from the package directory resolves this package without downloading it. A published `npx -y` adds a
  // registry check on top, so this is a lower bound for npx.
  const npx = time(5, () => spawnSync("npx --no-install ai-handoff-mcp --version", { cwd: ROOT, shell: true, env }));

  await fs.rm(work, { recursive: true, force: true });

  const cpu = os.cpus()[0]?.model.trim() ?? "unknown CPU";
  out("# Benchmark");
  out();
  out(`Measured ${new Date().toISOString().slice(0, 10)} on ${os.type()} ${os.release()}, Node ${process.version}, ${cpu}. Run \`npm run bench\` to reproduce.`);
  out("No model is called: these are deterministic measurements. Tokens are estimates at 3.5 characters per token.");
  out();
  out("## 1. What the next agent reads when it continues a task");
  out();
  out(`Fixture: this project's own code (${tracked.length} files, ${fmt(repoChars)} characters), a checkpoint, then 3 files edited before the session ends.`);
  out();
  out("| What the next agent reads | Characters | ~Tokens | Knows the task, next steps and decisions? |");
  out("|---|---|---|---|");
  out(`| **With ai-handoff**: brief injected at session start | ${fmt(briefStandard.length)} | ${fmt(tok(briefStandard))} | Yes |`);
  out(`| With ai-handoff, instructions block already loaded (rules not repeated) | ${fmt(briefDeduped.length)} | ${fmt(tok(briefDeduped))} | Yes |`);
  out(`| With ai-handoff, \`lean\` profile (brief capped at 3,000 characters; this one is under the cap) | ${fmt(briefLean.length)} | ${fmt(tok(briefLean))} | Yes |`);
  out(`| Without: \`git status\` + \`git diff\` + the 3 changed files (the minimum to see what changed) | ${fmt(minimal)} | ${fmt(Math.ceil(minimal / 3.5))} | No |`);
  out(`| Without: reading the whole codebase | ${fmt(repoChars)} | ${fmt(Math.ceil(repoChars / 3.5))} | No |`);
  out();
  out(
    `The brief is ${(minimal / briefStandard.length).toFixed(1)}x smaller than the minimum re-discovery, and it carries what re-discovery cannot recover at all. ` +
      "How many tokens an agent really spends exploring depends on the model and the task; this benchmark does not run a model, so it does not claim a number for that."
  );
  out();
  out("## 2. Fixed cost per session");
  out();
  out("| Part | ~Tokens | When |");
  out("|---|---|---|");
  out(`| Tool definitions, \`standard\` (9 tools) | ${fmt(tok(toolsAll))} | every request (most hosts cache it) |`);
  out(`| Tool definitions, \`lean\` (4 core tools, same descriptions) | ${fmt(tok(toolsCore))} | every request |`);
  out(`| Tool definitions, \`minimal\` (log_progress only; hosts that inject the brief) | ${fmt(tok(toolsMinimal))} | every request |`);
  out(`| Instructions block (AGENTS.md, CLAUDE.md) | ${fmt(tok(INSTRUCTIONS))} | every session |`);
  out(`| Rules left out of the brief when the instructions block is loaded | -${fmt(tok(briefStandard) - tok(briefDeduped))} | every session |`);
  out(`| Checkpoint nudge (only after 3+ edited files without a checkpoint, once) | ${nudge ? fmt(tok(nudge)) : "n/a"} + one model step for the agent's log_progress call (context re-read, mostly cached) | rarely |`);
  out("| Prompt gate (block), prompt strength, loop guard, file capture, Git delta | 0 | they run outside the model |");
  out();
  out("## 3. Prompt gate accuracy");
  out();
  out(`Labelled corpus: ${CORPUS.length} pairs, each written in English and Arabic, so ${clear + vague} prompts (${clear} clear, ${vague} vague; see test/prompt-corpus.ts). First prompt of a session.`);
  out();
  out("| Measure | Result |");
  out("|---|---|");
  out(`| Clear prompts stopped (false blocks) | ${falseBlocks} of ${clear} |`);
  out(`| Vague prompts let through | ${missed} of ${vague} |`);
  out(`| Same decision in English and Arabic | ${CORPUS.filter((p) => analyzePrompt(p.en, first).action === analyzePrompt(p.ar, first).action).length} of ${CORPUS.length} pairs |`);
  out(`| Mean score gap between the two languages | ${meanGap.toFixed(1)} points (of 100) |`);
  out();
  out("The corpus was written by the authors and the gate was tuned on it, so these are training-set numbers. They show the gate is consistent, not that it is right on prompts it has never seen.");
  out();
  out("## 4. Hook latency (real processes)");
  out();
  out(`| Command | Median | p90 |`);
  out("|---|---|---|");
  out(`| \`node -e 0\` (bare Node start, for reference) | ${latency.bare.median} ms | ${latency.bare.p90} ms |`);
  out(`| Node + loading the MCP SDK and zod (what hooks no longer load) | ${latency.sdk.median} ms | ${latency.sdk.p90} ms |`);
  out(`| pre-tool (loop guard, before every tool call) | ${latency.preTool.median} ms | ${latency.preTool.p90} ms |`);
  out(`| prompt-submit (prompt gate) | ${latency.prompt.median} ms | ${latency.prompt.p90} ms |`);
  out(`| session-start (brief + Git delta) | ${latency.sessionStart.median} ms | ${latency.sessionStart.p90} ms |`);
  out(`| through \`npx --no-install\` (lower bound for npx) | ${npx.median} ms | ${npx.p90} ms |`);
  out();
  out("Global install or local checkout (`node dist/src/index.js`); median of 15 runs, npx of 5. session-start runs once per session; pre-tool runs before every tool call.");
  out("Before the MCP SDK was loaded lazily (measured once on the same machine, 2026-10-21): pre-tool 259 ms, prompt-submit 334 ms.");
  out();
  // Section 5 takes minutes to build its fixture, so it only runs with --large; otherwise the last result is kept.
  const LARGE_HEADING = "## 5. Large repository";
  if (process.argv.includes("--large")) await largeRepo();
  else {
    const previous = await fs.readFile(path.join(ROOT, "BENCHMARK.md"), "utf8").catch(() => "");
    const kept = previous.indexOf(LARGE_HEADING);
    if (kept !== -1) lines.push(previous.slice(kept).trimEnd(), "");
  }
  const report = lines.join("\n") + "\n";
  process.stdout.write(report);
  if (write) await fs.writeFile(path.join(ROOT, "BENCHMARK.md"), report);

  async function largeRepo() {
    const files = 20000;
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ai-handoff-large-")));
    const repo = path.join(dir, "repo");
    const started = performance.now();
    for (let folder = 0; folder < files / 50; folder++) {
      const target = path.join(repo, `pkg${folder % 40}`, `mod${folder}`);
      await fs.mkdir(target, { recursive: true });
      await Promise.all(
        Array.from({ length: 50 }, (_, i) => fs.writeFile(path.join(target, `f${i}.ts`), `export const v${i} = ${folder * 50 + i};\n`.repeat(20)))
      );
    }
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "fixture");
    const build = Math.round((performance.now() - started) / 1000);
    // A busy working tree: 150 modified files and 50 new ones (fingerprints cover 200, under the 300 limit).
    const trackedFiles = git(repo, "ls-files").trim().split("\n");
    for (const file of trackedFiles.slice(0, 150)) await fs.appendFile(path.join(repo, file), "// edit\n");
    for (let i = 0; i < 50; i++) await fs.writeFile(path.join(repo, `new${i}.ts`), "export {};\n");
    const largeStore = new HandoffStore(path.join(dir, "data"));
    const { getGitSnapshot } = await import("../src/git.js");
    await largeStore.write(repo, (current) => ({ ...current, task: "t", nextSteps: ["n"] }), { agent: "claude", message: "saved", git: await getGitSnapshot(repo) });
    const record = await largeStore.get(repo);
    const timeAsync = async (runs: number, run: () => Promise<unknown>) => {
      const times: number[] = [];
      for (let i = 0; i < runs; i++) {
        const start = performance.now();
        await run();
        times.push(performance.now() - start);
      }
      return median(times);
    };
    const largeEnv = { ...process.env, AI_HANDOFF_DATA_DIR: path.join(dir, "data") };
    const rows = {
      snapshot: await timeAsync(8, () => getGitSnapshot(repo)),
      state: await timeAsync(8, () => getRepoState(repo, record?.git ?? null)),
      start: time(8, () =>
        spawnSync(process.execPath, [ENTRY, "hook", "session-start", "--agent", "claude"], {
          input: JSON.stringify({ cwd: repo, session_id: `l${Math.random()}`, source: "startup" }),
          env: largeEnv
        })
      ).median,
      preTool: time(8, () =>
        spawnSync(process.execPath, [ENTRY, "hook", "pre-tool", "--agent", "claude"], {
          input: JSON.stringify({ cwd: repo, session_id: "l", tool_name: "Read", tool_input: { file_path: path.join(repo, `x${Math.random()}`) } }),
          env: largeEnv
        })
      ).median
    };
    await fs.rm(dir, { recursive: true, force: true });
    out(LARGE_HEADING);
    out();
    out(`Fixture: ${fmt(files)} committed files (built in ${build} s), 150 modified and 50 new. Run with \`npm run bench -- --large\`.`);
    out();
    out("| Path | Median |");
    out("|---|---|");
    out(`| Git snapshot (every log_progress / checkpoint) | ${rows.snapshot} ms |`);
    out(`| Repository state with the checkpoint (session-start, resume_task) | ${rows.state} ms |`);
    out(`| session-start hook, real process | ${rows.start} ms |`);
    out(`| pre-tool hook, real process (no Git) | ${rows.preTool} ms |`);
    out();
    out("Measured on the same machine as above, in the same run (compare the bare Node row in section 4: a loaded machine raises every number). `git status` checks every file in the working tree, so these times grow with the repository size and with the number of modified files; past 300 changed files, fingerprints are skipped and a diff stat is used instead.");
    out();
  }
}

await main();
