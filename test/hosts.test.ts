// Host adapters: every agent's hook input shape and output dialect, and the prompt clarity gate end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { defaultHost, pickHookInput, runHook, type Host } from "../src/hooks.js";
import { HandoffStore, emptyFields } from "../src/storage.js";
import { tempProject } from "./helpers.js";

const VAGUE = "صلحها";
const CLEAR = "In src/auth/login.ts, validateEmail() accepts 'a@b'. It should reject emails without a dot in the domain.";

async function setup() {
  const { project, dataDir } = await tempProject();
  return { project, store: new HandoffStore(dataDir) };
}

test("defaultHost maps agent names to output dialects", () => {
  assert.equal(defaultHost("claude"), "claude");
  assert.equal(defaultHost("Copilot"), "vscode");
  assert.equal(defaultHost("cursor"), "cursor");
  assert.equal(defaultHost("gemini"), "gemini");
  assert.equal(defaultHost("windsurf"), "windsurf");
  assert.equal(defaultHost("codex"), "generic");
});

test("input shapes: Cursor, Windsurf, Gemini and Copilot CLI are normalised", () => {
  const cursor = pickHookInput({
    conversation_id: "c1",
    workspace_roots: ["/c:/work/app"],
    hook_event_name: "afterFileEdit",
    file_path: "/c:/work/app/src/a.ts",
    transcript_path: "/x.jsonl"
  });
  assert.equal(cursor.sessionId, "c1");
  assert.equal(cursor.cwd, "c:/work/app");
  assert.equal(cursor.toolName, "afterFileEdit");
  assert.equal((cursor.toolInput as { file_path: string }).file_path, "/c:/work/app/src/a.ts");

  const windsurf = pickHookInput({ agent_action_name: "pre_user_prompt", trajectory_id: "t1", tool_info: { user_prompt: "hi there" } });
  assert.equal(windsurf.prompt, "hi there");
  assert.equal(windsurf.sessionId, "t1");
  const write = pickHookInput({ agent_action_name: "post_write_code", tool_info: { file_path: "/w/a.ts", edits: [] } });
  assert.equal(write.toolName, "post_write_code");
  assert.equal((write.toolInput as { file_path: string }).file_path, "/w/a.ts");

  const gemini = pickHookInput({ session_id: "g", cwd: "/w", hook_event_name: "BeforeAgent", prompt: "x", transcript_path: "/t.json" });
  assert.equal(gemini.prompt, "x");

  const copilotCli = pickHookInput({ sessionId: "s", cwd: "/w", toolName: "edit", toolArgs: '{"path":"/w/b.ts"}' });
  assert.equal(copilotCli.sessionId, "s");
  assert.deepEqual(copilotCli.toolInput, { path: "/w/b.ts" });

  const cursorPrompt = pickHookInput({ prompt: "fix this", attachments: [{ type: "file", file_path: "/w/a.ts" }] });
  assert.equal(cursorPrompt.attachments, 1);
});

const BLOCK_OUTPUT: Record<Host, (stdout: string, result: { stderr?: string; exitCode?: number }) => void> = {
  claude: (stdout) => {
    const out = JSON.parse(stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /ما انصرف أي كريدت/);
  },
  vscode: (stdout) => {
    const out = JSON.parse(stdout);
    assert.equal(out.continue, false);
    assert.match(out.stopReason, /--go/);
  },
  cursor: (stdout) => {
    const out = JSON.parse(stdout);
    assert.equal(out.continue, false);
    assert.match(out.user_message, /--go/);
  },
  gemini: (stdout) => {
    const out = JSON.parse(stdout);
    assert.equal(out.decision, "deny");
    assert.match(out.reason, /--go/);
  },
  windsurf: (stdout, result) => {
    assert.equal(stdout, "");
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr ?? "", /--go/);
  },
  generic: (stdout, result) => {
    assert.equal(JSON.parse(stdout).decision, "block");
    assert.equal(result.exitCode, 2);
  }
};

test("a vague prompt is blocked in each host's own format", async () => {
  for (const host of Object.keys(BLOCK_OUTPUT) as Host[]) {
    const { project, store } = await setup();
    const result = await runHook("prompt-submit", host, JSON.stringify({ cwd: project, session_id: "s", prompt: VAGUE }), { store, env: {}, host });
    BLOCK_OUTPUT[host](result.stdout, result);
  }
});

test("a clear prompt passes silently (Cursor gets an explicit continue)", async () => {
  for (const host of ["claude", "vscode", "gemini", "windsurf", "generic"] as Host[]) {
    const { project, store } = await setup();
    const result = await runHook("prompt-submit", host, JSON.stringify({ cwd: project, session_id: "s", prompt: CLEAR }), { store, env: {}, host });
    assert.deepEqual(result, { stdout: "" }, host);
  }
  const { project, store } = await setup();
  const cursor = await runHook("prompt-submit", "cursor", JSON.stringify({ workspace_roots: [project], prompt: CLEAR }), { store, env: {} });
  assert.deepEqual(JSON.parse(cursor.stdout), { continue: true });
});

test("session tracking: a blocked first prompt keeps the session 'new', an allowed one starts it", async () => {
  const { project, store } = await setup();
  const send = (prompt: string, session = "s1") =>
    runHook("prompt-submit", "claude", JSON.stringify({ cwd: project, session_id: session, prompt }), { store, env: {} });
  assert.match((await send("fix it")).stdout, /block/);
  assert.match((await send("fix it")).stdout, /block/, "retyping the same vague prompt is still screened");
  assert.equal((await send(CLEAR)).stdout, "");
  assert.equal((await send("fix it")).stdout, "", "follow-up in a started session refers to the conversation");
  assert.match((await send("refactor everything")).stdout, /block/, "whole-project requests are stopped even mid-session");
  assert.match((await send("fix it", "s2")).stdout, /block/, "a new session starts fresh");

  const state = await store.getPromptState(project);
  assert.equal(state.blocked, 4);
  assert.equal(state.allowed, 2);
  assert.deepEqual(Object.keys(state.sessions), ["s1"]);
  assert.doesNotMatch(await fs.readFile(store.promptStatePath(project), "utf8"), /fix it|validateEmail/, "prompt text is never stored");
});

test("without a session id, a long pause starts a new session", async () => {
  const { project, store } = await setup();
  const send = (prompt: string) => runHook("prompt-submit", "windsurf", JSON.stringify({ tool_info: { user_prompt: prompt } }), { store, env: {}, cwd: project });
  assert.equal((await send(CLEAR)).exitCode, undefined);
  assert.equal((await send("fix it")).exitCode, undefined, "same session: follow-up allowed");
  const state = await store.getPromptState(project);
  state.lastAllowedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  await fs.writeFile(store.promptStatePath(project), JSON.stringify(state));
  assert.equal((await send("fix it")).exitCode, 2, "after two hours it is a new session");
});

test("gate modes: --gate and .ai-handoff.json (warn adds context, off disables)", async () => {
  const { project, store } = await setup();
  const send = (gate?: "block" | "warn" | "off", session = "x") =>
    runHook("prompt-submit", "claude", JSON.stringify({ cwd: project, session_id: session, prompt: "fix it" }), { store, env: {}, gate });

  const warn = JSON.parse((await send("warn", "w")).stdout);
  assert.equal(warn.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(warn.hookSpecificOutput.additionalContext, /clarifying question/);
  assert.equal((await send("off", "o")).stdout, "");

  await fs.writeFile(path.join(project, ".ai-handoff.json"), JSON.stringify({ promptGate: { mode: "off" } }));
  assert.equal((await send(undefined, "c1")).stdout, "");
  assert.match((await send("block", "c2")).stdout, /block/, "--gate wins over the file's mode");
  await fs.writeFile(path.join(project, ".ai-handoff.json"), JSON.stringify({ promptGate: { mode: "block", threshold: 101 } }));
  const lenient = JSON.parse((await send(undefined, "c3")).stdout);
  assert.equal(lenient.decision, undefined, "threshold above 100 never blocks");
  assert.match(lenient.systemMessage, /Prompt strength 10\/100 \(weak\)/, "but the user still sees the prompt is weak");
});

test("a known task lets a short first prompt through", async () => {
  const { project, store } = await setup();
  await store.write(project, () => ({ ...emptyFields(), task: "Add login" }), { agent: "claude", message: "saved" });
  const result = await runHook("prompt-submit", "copilot", JSON.stringify({ cwd: project, session_id: "s", prompt: "finish the validation step" }), {
    store,
    env: {}
  });
  assert.equal(result.stdout, "");
});

test("Cursor: afterFileEdit records the file, stop with status aborted marks an abrupt end", async () => {
  const { project, store } = await setup();
  const base = { conversation_id: "c", workspace_roots: [project] };
  await runHook("post-tool", "cursor", JSON.stringify({ ...base, hook_event_name: "afterFileEdit", file_path: path.join(project, "src", "x.ts") }), { store, env: {} });
  const stop = await runHook("stop", "cursor", JSON.stringify({ ...base, hook_event_name: "stop", status: "aborted" }), { store, env: {} });
  assert.deepEqual(JSON.parse(stop.stdout), {});
  const auto = (await store.get(project))?.auto;
  assert.deepEqual(auto?.touchedFiles, ["src/x.ts"]);
  assert.equal(auto?.event, "aborted");
});

test("Windsurf: post_write_code records the file, post_run_command counts as activity", async () => {
  const { project, store } = await setup();
  const opts = { store, env: {}, cwd: project };
  await runHook("post-tool", "windsurf", JSON.stringify({ agent_action_name: "post_write_code", tool_info: { file_path: path.join(project, "a.py") } }), opts);
  await runHook("post-tool", "windsurf", JSON.stringify({ agent_action_name: "post_run_command", tool_info: { command_line: "pytest", cwd: project } }), opts);
  const auto = (await store.get(project))?.auto;
  assert.deepEqual(auto?.touchedFiles, ["a.py"]);
  assert.equal(auto?.toolCalls, 2);
  assert.equal(auto?.lastTool, "post_run_command");
});

test("Gemini: SessionStart injects context with GEMINI_PROJECT_DIR as the root", async () => {
  const { project, store } = await setup();
  await store.write(project, () => ({ ...emptyFields(), task: "Port to Rust" }), { agent: "claude", message: "saved" });
  const result = await runHook("session-start", "gemini", JSON.stringify({ session_id: "g" }), { store, env: { GEMINI_PROJECT_DIR: project }, cwd: "/elsewhere" });
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /Port to Rust/);
});

test("Cursor and Windsurf session-start outputs", async () => {
  const { project, store } = await setup();
  await store.write(project, () => ({ ...emptyFields(), task: "T1" }), { agent: "claude", message: "saved" });
  const cursor = await runHook("session-start", "cursor", JSON.stringify({ workspace_roots: [project] }), { store, env: {} });
  assert.match(JSON.parse(cursor.stdout).additional_context, /T1/);
  const windsurf = await runHook("session-start", "windsurf", "{}", { store, env: {}, cwd: project });
  assert.equal(windsurf.stdout, "", "Windsurf has no session-start event; instructions cover it");
});

test("the same event reported by two hosts at once is recorded once", async () => {
  const { project, store } = await setup();
  const edit = JSON.stringify({ cwd: project, tool_name: "Edit", tool_input: { file_path: path.join(project, "a.ts") } });
  await runHook("post-tool", "copilot", edit, { store, env: {} });
  await runHook("post-tool", "claude", edit, { store, env: {} });
  const auto = (await store.get(project))?.auto;
  assert.equal(auto?.toolCalls, 1);
  assert.equal(auto?.agent, "copilot", "the first report wins");
});

test("a weak prompt passes with its strength shown to the user only, in each host's own format", async () => {
  const WEAK = "add a logout button to settings";
  for (const host of ["claude", "vscode", "gemini"] as Host[]) {
    const { project, store } = await setup();
    const result = await runHook("prompt-submit", host, JSON.stringify({ cwd: project, session_id: "s", prompt: WEAK }), { store, env: {}, host });
    const output = JSON.parse(result.stdout);
    assert.match(output.systemMessage, /Prompt strength 60\/100 \(weak\)/, host);
    assert.equal(output.hookSpecificOutput, undefined, `${host}: nothing enters the model's context`);
    assert.equal(output.decision, undefined, host);
  }
  for (const host of ["windsurf", "generic"] as Host[]) {
    const { project, store } = await setup();
    const result = await runHook("prompt-submit", host, JSON.stringify({ cwd: project, session_id: "s", prompt: WEAK }), { store, env: {}, host });
    assert.equal(result.stdout, "", host);
    assert.equal(result.exitCode, undefined, `${host}: the prompt is not blocked`);
    assert.match(result.stderr ?? "", /Prompt strength/, host);
  }
  const { project, store } = await setup();
  const cursor = await runHook("prompt-submit", "cursor", JSON.stringify({ workspace_roots: [project], prompt: WEAK }), { store, env: {} });
  assert.deepEqual(JSON.parse(cursor.stdout), { continue: true });
});

test("showScore in .ai-handoff.json: off hides the strength, always shows it for clear prompts too", async () => {
  const { project, store } = await setup();
  const send = (prompt: string, session: string) =>
    runHook("prompt-submit", "claude", JSON.stringify({ cwd: project, session_id: session, prompt }), { store, env: {} });
  await fs.writeFile(path.join(project, ".ai-handoff.json"), JSON.stringify({ promptGate: { showScore: "off" } }));
  assert.equal((await send("add a logout button to settings", "a")).stdout, "");
  await fs.writeFile(path.join(project, ".ai-handoff.json"), JSON.stringify({ promptGate: { showScore: "always" } }));
  assert.match(JSON.parse((await send(CLEAR, "b")).stdout).systemMessage, /Prompt strength 100\/100 \(good\)/);
  assert.equal((await send("yes", "b")).stdout, "", "replies are never rated");
  await fs.writeFile(path.join(project, ".ai-handoff.json"), JSON.stringify({ promptGate: { mode: "warn" } }));
  const warn = JSON.parse((await send("fix it", "c")).stdout);
  assert.match(warn.hookSpecificOutput.additionalContext, /clarifying question/);
  assert.match(warn.systemMessage, /Prompt strength 10\/100 \(too vague\)/, "warn mode also tells the user");
  assert.doesNotMatch(await fs.readFile(store.promptStatePath(project), "utf8"), /logout|validateEmail/, "prompt text is never stored");
});
