// What the next agent receives: the checkpoint nudge (intent), the in-repo file (cloud agents) and the brief without
// duplicated rules or repeated injection.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { runHook, type Host } from "../src/hooks.js";
import { HandoffStore, emptyFields } from "../src/storage.js";
import { RULES } from "../src/handoff.js";
import { INSTRUCTIONS } from "../src/init.js";
import { REPO_FILE } from "../src/repo-file.js";
import { createServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { tempProject } from "./helpers.js";

async function setup() {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  const hook = (event: "post-tool" | "stop" | "session-start" | "pre-tool" | "prompt-submit", payload: Record<string, unknown>, host: Host = "claude") =>
    runHook(event, host, JSON.stringify({ cwd: project, session_id: "s1", ...payload }), { store, env: {}, host });
  const edit = (file: string, id: string) =>
    hook("post-tool", { hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: id, tool_input: { file_path: path.join(project, file) } });
  return { project, store, hook, edit };
}

async function mcp(store: HandoffStore) {
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([createServer(store).connect(serverSide), client.connect(clientSide)]);
  return async (name: string, args: Record<string, unknown>) =>
    ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0].text;
}

test("nudge: after several edits without a checkpoint, the agent is asked once to record its intent", async () => {
  const { store, hook, edit } = await setup();
  await edit("src/a.ts", "1");
  await edit("src/b.ts", "2");
  assert.equal((await hook("stop", { hook_event_name: "Stop" })).stdout, "", "two files: below the default of three");
  await edit("src/c.ts", "3");
  const nudge = JSON.parse((await hook("stop", { hook_event_name: "Stop" })).stdout);
  assert.equal(nudge.decision, "block");
  assert.match(nudge.reason, /edited 3 files since the last checkpoint \(src\/a.ts, src\/b.ts, src\/c.ts\)/);
  assert.match(nudge.reason, /call log_progress once/);
  assert.ok(nudge.reason.length < 600, "the nudge itself stays short");
  // Claude Code sets stop_hook_active while the agent continues because of the nudge: never ask twice in a row.
  assert.equal((await hook("stop", { hook_event_name: "Stop", stop_hook_active: true })).stdout, "");
  await edit("src/d.ts", "4");
  assert.equal((await hook("stop", { hook_event_name: "Stop" })).stdout, "", "asked once per checkpoint, even if ignored");
});

test("nudge: a checkpoint resets it, it respects minFiles and off, and only hosts that can continue get it", async () => {
  const { project, store, hook, edit } = await setup();
  for (const [i, file] of ["a", "b", "c"].entries()) await edit(`src/${file}.ts`, String(i));
  await store.write(project, (current) => ({ ...current, task: "t", currentStep: "s" }), { agent: "claude", message: "log_progress" });
  await edit("src/e.ts", "9");
  assert.equal((await hook("stop", { hook_event_name: "Stop" })).stdout, "", "one file after the checkpoint");

  await fs.writeFile(path.join(project, ".ai-handoff.json"), JSON.stringify({ checkpointNudge: { minFiles: 1 } }));
  await edit("src/f.ts", "10");
  assert.equal(JSON.parse((await hook("stop", { hook_event_name: "Stop" })).stdout).decision, "block");

  const other = await setup();
  for (const [i, file] of ["a", "b", "c"].entries()) await other.edit(`src/${file}.ts`, String(i));
  await fs.writeFile(path.join(other.project, ".ai-handoff.json"), JSON.stringify({ checkpointNudge: { mode: "off" } }));
  assert.equal((await other.hook("stop", { hook_event_name: "Stop" })).stdout, "");

  // Gemini's AfterAgent "deny" would reject the agent's final answer, so Gemini, Windsurf and generic hosts get none.
  for (const host of ["gemini", "windsurf", "generic"] as Host[]) {
    const { hook: hostHook, edit: hostEdit } = await setup();
    for (const [i, file] of ["a", "b", "c"].entries()) await hostEdit(`src/${file}.ts`, String(i));
    assert.doesNotMatch((await hostHook("stop", { hook_event_name: "Stop" }, host)).stdout, /decision|followup/, host);
  }
});

test("nudge on Cursor: a followup_message, never inside a follow-up loop or after an aborted turn", async () => {
  const cursorStop = async (payload: Record<string, unknown>) => {
    const { hook, edit } = await setup();
    for (const [i, file] of ["a", "b", "c"].entries()) await edit(`src/${file}.ts`, String(i));
    return (await hook("stop", { hook_event_name: "stop", status: "completed", loop_count: 0, ...payload }, "cursor")).stdout;
  };
  const output = JSON.parse(await cursorStop({}));
  assert.match(output.followup_message, /edited 3 files since the last checkpoint/);
  assert.equal(output.decision, undefined, "Cursor's own format");
  assert.deepEqual(JSON.parse(await cursorStop({ loop_count: 1 })), {}, "already continuing a follow-up");
  assert.deepEqual(JSON.parse(await cursorStop({ status: "aborted" })), {}, "a usage limit leaves no agent to answer");
  assert.deepEqual(JSON.parse(await cursorStop({ status: "error" })), {});
});

test("nudge: a turn the loop guard stopped stays stopped", async () => {
  const { hook, edit } = await setup();
  for (const [i, file] of ["a", "b", "c"].entries()) await edit(`src/${file}.ts`, String(i));
  const read = { tool_name: "Bash", tool_input: { command: "npm test" } };
  let stopped = false;
  for (let i = 0; i < 8 && !stopped; i++) stopped = /"continue":false/.test((await hook("pre-tool", read)).stdout);
  assert.ok(stopped, "the guard stopped the agent");
  assert.equal((await hook("stop", { hook_event_name: "Stop" })).stdout, "");
});

test("repo file: off by default; with repoFile it follows checkpoints and turn ends, without secrets", async () => {
  const { project, store, hook, edit } = await setup();
  const call = await mcp(store);
  const file = path.join(project, REPO_FILE);
  await call("save_handoff", { projectPath: project, agent: "claude", task: "Add login", nextSteps: ["Write tests"] });
  await assert.rejects(fs.access(file), "not written unless enabled");

  await fs.writeFile(path.join(project, ".ai-handoff.json"), JSON.stringify({ repoFile: true }));
  await call("log_progress", { projectPath: project, agent: "claude", currentStep: "Calling the API with token sk-abcdefghijklmnopqrstuvwxyz123456" });
  const written = await fs.readFile(file, "utf8");
  assert.match(written, /## Current task\nAdd login/);
  assert.match(written, /## Next steps\n1\. Write tests/);
  assert.doesNotMatch(written, /sk-abcdefghijklmnopqrstuvwxyz123456/, "credentials are redacted");

  await edit("src/login.ts", "1");
  assert.doesNotMatch(await fs.readFile(file, "utf8"), /src\/login.ts/, "not rewritten after every tool call");
  await hook("stop", { hook_event_name: "Stop" });
  assert.match(await fs.readFile(file, "utf8"), /Edited after this checkpoint[\s\S]*- src\/login.ts/, "updated when the turn ends");
});

test("instructions mention the repo file, so cloud agents know where to look", () => {
  assert.match(INSTRUCTIONS, /\.ai-handoff\/HANDOFF\.md/);
});

test("dedupe: the general rules are not repeated when the host already loads the instructions block", async () => {
  const { project, store, hook } = await setup();
  await store.write(project, () => ({ ...emptyFields(), task: "Add login", currentStep: "Form" }), { agent: "claude", message: "saved" });
  const brief = async (session: string) =>
    JSON.parse((await hook("session-start", { session_id: session, source: "startup" })).stdout).hookSpecificOutput.additionalContext as string;
  const full = await brief("a");
  assert.match(full, new RegExp(RULES[2].slice(0, 30)));

  await fs.writeFile(path.join(project, "CLAUDE.md"), `# Project\n${INSTRUCTIONS}\n`);
  const lean = await brief("b");
  assert.doesNotMatch(lean, new RegExp(RULES[2].slice(0, 30)), "checkpoint rules come from CLAUDE.md");
  assert.match(lean, /Verify the code and Git state/, "the rule about this brief stays");
  assert.ok(full.length - lean.length > 150, `saves ${full.length - lean.length} characters`);

  const call = await mcp(store);
  assert.doesNotMatch(await call("resume_task", { projectPath: project, agent: "claude" }), new RegExp(RULES[2].slice(0, 30)));
  assert.match(await call("resume_task", { projectPath: project, agent: "cursor" }), new RegExp(RULES[2].slice(0, 30)), "Cursor reads AGENTS.md, which has no block here");
});

test("dedupe: a resumed conversation is not given the same brief twice, but a changed checkpoint or a compaction is", async () => {
  const { project, store, hook } = await setup();
  await store.write(project, () => ({ ...emptyFields(), task: "Add login" }), { agent: "claude", message: "saved" });
  const start = async (source: string, session = "s1") => (await hook("session-start", { session_id: session, source })).stdout;
  assert.match(await start("startup"), /Add login/);
  assert.equal(await start("resume"), "", "same session, nothing changed");
  assert.match(await start("compact"), /Add login/, "compaction drops context, so the brief comes back");
  assert.match(await start("resume", "s2"), /Add login/, "another conversation never had it");
  await store.write(project, (current) => ({ ...current, currentStep: "Validation" }), { agent: "claude", message: "log_progress" });
  assert.match(await start("resume"), /Validation/, "the checkpoint changed since");
  assert.match(((await store.get(project))?.log ?? []).map((entry) => entry.message).join("\n"), /brief already in its context/);
});

test("stats: counts what happened, once per event, and stores no content", async () => {
  const { project, store, hook, edit } = await setup();
  const call = await mcp(store);
  await hook("prompt-submit", { prompt: "fix it" });
  await hook("prompt-submit", { prompt: "In src/a.ts rename foo() to bar() so that the tests still pass" });
  const npmTest = { tool_name: "Bash", tool_input: { command: "npm test -- --secret-flag" } };
  for (let i = 0; i < 6; i++) await hook("pre-tool", { ...npmTest, tool_use_id: `t${i}` });
  // The same call reported again (same tool_use_id) is not counted twice.
  await hook("pre-tool", { ...npmTest, tool_use_id: "t5" });
  for (const [i, file] of ["a", "b", "c"].entries()) await edit(`src/${file}.ts`, `e${i}`);
  await hook("prompt-submit", { prompt: "now the tests please, in test/a.test.ts" });
  await hook("stop", { hook_event_name: "Stop" });
  await call("save_handoff", { projectPath: project, agent: "claude", task: "Rename" });
  await call("log_progress", { projectPath: project, agent: "claude", currentStep: "tests" });
  await call("resume_task", { projectPath: project, agent: "copilot" });
  await hook("session-start", { session_id: "r", source: "startup" });
  await hook("session-start", { session_id: "r", source: "resume" });

  const stats = await store.getStats(project);
  assert.equal(stats.loopDenied, 1);
  assert.equal(stats.loopStopped, 1);
  assert.equal(stats.nudges, 1);
  assert.equal(stats.checkpoints, 2);
  assert.equal(stats.resumes, 1);
  assert.equal(stats.briefsInjected, 1);
  assert.equal(stats.briefsSkipped, 1);
  assert.ok(stats.briefChars > 100);
  assert.ok(stats.since);
  const raw = await fs.readFile(store.statsPath(project), "utf8");
  assert.doesNotMatch(raw, /fix it|secret-flag|rename|Rename|src\//, "counters only");

  let out = "";
  const { runCli } = await import("../src/cli.js");
  assert.equal(await runCli(["stats"], { cwd: project, out: (text) => void (out += text), err: () => {} }, store), 0);
  assert.match(out, /3 prompts checked, 1 stopped before reaching the model/);
  assert.match(out, /1 calls denied, 1 agents stopped/);
  assert.match(out, /1 briefs injected at session start \(~\d+ tokens on average\), 1 not repeated/);
  assert.match(out, /2 written by agents; 1 nudges to record the intent/);
});
