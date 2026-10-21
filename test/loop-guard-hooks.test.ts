// Loop guard through the hook commands, in each host's dialect.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { payloadFailed, runHook, type Host } from "../src/hooks.js";
import { HandoffStore, emptyFields } from "../src/storage.js";
import { getGitStatus } from "../src/git.js";
import { renderBrief } from "../src/handoff.js";
import { tempProject } from "./helpers.js";

async function setup() {
  const { project, dataDir } = await tempProject();
  return { project, store: new HandoffStore(dataDir) };
}

function caller(store: HandoffStore, project: string, agent: string, extra: Record<string, unknown> = {}) {
  const call = (event: "pre-tool" | "post-tool" | "prompt-submit", payload: Record<string, unknown>, options: Record<string, unknown> = {}) =>
    runHook(event, agent, JSON.stringify({ cwd: project, session_id: "s1", ...extra, ...payload }), { store, env: {}, ...options });
  return {
    pre: (tool: string, input: Record<string, unknown>, options = {}) => call("pre-tool", { tool_name: tool, tool_input: input }, options),
    post: (payload: Record<string, unknown>) => call("post-tool", payload),
    prompt: (prompt: string) => call("prompt-submit", { prompt })
  };
}

test("Claude Code: deny on the third identical call, stop the agent on the fourth, log it for the next agent", async () => {
  const { project, store } = await setup();
  await store.write(project, () => ({ ...emptyFields(), task: "Fix the build" }), { agent: "claude", message: "saved" });
  const claude = caller(store, project, "claude");
  assert.equal((await claude.pre("Bash", { command: "npm test" })).stdout, "");
  assert.equal((await claude.pre("Bash", { command: "npm test" })).stdout, "");

  const deny = JSON.parse((await claude.pre("Bash", { command: "npm test", description: "again" })).stdout);
  assert.equal(deny.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(deny.hookSpecificOutput.permissionDecision, "deny");
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /`npm test`.*Do not retry it/s);
  assert.equal(deny.continue, undefined, "first hit only denies the call");

  const stop = JSON.parse((await claude.pre("Bash", { command: "npm test" })).stdout);
  assert.equal(stop.continue, false);
  assert.match(stop.stopReason, /loop guard stopped the agent/);
  assert.equal(stop.hookSpecificOutput.permissionDecision, "deny");

  const record = await store.get(project);
  assert.match(record?.log.at(-1)?.message ?? "", /loop guard stopped the agent \(repeat\): `npm test`/);
  const brief = renderBrief({ projectPath: project, record, git: await getGitStatus(project), changes: null });
  assert.match(brief, /loop guard stopped the agent/, "the next agent learns not to repeat it");
});

test("a new user prompt lets the agent work again, and the stop message follows the prompt's language", async () => {
  const { project, store } = await setup();
  const claude = caller(store, project, "claude");
  assert.equal((await claude.prompt("بملف src/app.ts الدالة login لازم ترجع 401 لما الباسورد غلط")).stdout, "");
  for (let i = 0; i < 3; i++) await claude.pre("Read", { file_path: path.join(project, "a.ts") });
  const stop = JSON.parse((await claude.pre("Read", { file_path: path.join(project, "a.ts") })).stdout);
  assert.match(stop.stopReason, /أوقف ai-handoff الوكيل/);
  assert.match(JSON.parse((await claude.pre("Grep", { pattern: "x" })).stdout).hookSpecificOutput.permissionDecisionReason, /already stopped/);

  assert.equal((await claude.prompt("كمل")).stdout, "");
  assert.equal((await claude.pre("Read", { file_path: path.join(project, "a.ts") })).stdout, "", "counters start over after the user writes");
});

test("the guard resets on new prompts even when the prompt gate is off", async () => {
  const { project, store } = await setup();
  await fs.writeFile(path.join(project, ".ai-handoff.json"), JSON.stringify({ promptGate: { mode: "off" } }));
  const claude = caller(store, project, "claude");
  for (let i = 0; i < 4; i++) await claude.pre("Bash", { command: "ls" });
  assert.match((await claude.pre("Bash", { command: "pwd" })).stdout, /deny/);
  await claude.prompt("continue");
  assert.equal((await claude.pre("Bash", { command: "pwd" })).stdout, "");
});

const STOP_FORMATS: Record<Host, (result: { stdout: string; stderr?: string; exitCode?: number }) => void> = {
  claude: (r) => assert.equal(JSON.parse(r.stdout).continue, false),
  vscode: (r) => {
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, false);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  },
  gemini: (r) => {
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "deny");
    assert.equal(out.continue, false);
  },
  cursor: (r) => {
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, "deny");
    assert.match(out.agent_message, /Stop now/);
    assert.match(out.user_message, /loop guard/);
  },
  windsurf: (r) => {
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr ?? "", /Stop now/);
  },
  generic: (r) => {
    assert.equal(r.exitCode, 2);
    assert.equal(JSON.parse(r.stdout).continue, false);
  }
};

test("every host gets the stop in its own format", async () => {
  for (const host of Object.keys(STOP_FORMATS) as Host[]) {
    const { project, store } = await setup();
    const agent = caller(store, project, host);
    let result = await agent.pre("run_shell_command", { command: "make" }, { host });
    for (let i = 0; i < 3; i++) result = await agent.pre("run_shell_command", { command: "make" }, { host });
    STOP_FORMATS[host](result);
  }
});

test("Cursor allows explicitly, and keeps denying after a stop until the user writes", async () => {
  const { project, store } = await setup();
  const cursor = caller(store, project, "cursor", { conversation_id: "c1", workspace_roots: [project], cwd: undefined, session_id: undefined });
  assert.deepEqual(JSON.parse((await cursor.pre("Shell", { command: "npm test" })).stdout), { permission: "allow" });
  for (let i = 0; i < 3; i++) await cursor.pre("Shell", { command: "npm test" });
  const after = JSON.parse((await cursor.pre("Read", { path: "b.ts" })).stdout);
  assert.equal(after.permission, "deny");
});

test("Windsurf: a repeated command is blocked through exit code 2", async () => {
  const { project, store } = await setup();
  const send = () =>
    runHook("pre-tool", "windsurf", JSON.stringify({ agent_action_name: "pre_run_command", trajectory_id: "t", tool_info: { command_line: "pytest", cwd: project } }), {
      store,
      env: {},
      cwd: project
    });
  assert.equal((await send()).exitCode, undefined);
  assert.equal((await send()).exitCode, undefined);
  const blocked = await send();
  assert.equal(blocked.exitCode, 2);
  assert.match(blocked.stderr ?? "", /`pytest`/);
});

test("repeated failures (PostToolUseFailure) warn the agent, then the next run is denied", async () => {
  const { project, store } = await setup();
  const claude = caller(store, project, "claude");
  const fail = { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npm test" }, error: "Exit code 1\nboom" };
  let last = { stdout: "" };
  for (let i = 0; i < 4; i++) {
    await claude.pre("Bash", { command: "npm test" });
    last = await claude.post({ ...fail, tool_use_id: `t${i}` });
    await claude.pre("Edit", { file_path: path.join(project, "a.ts"), old_string: `v${i}`, new_string: `v${i + 1}` });
  }
  const context = JSON.parse(last.stdout).hookSpecificOutput;
  assert.equal(context.hookEventName, "PostToolUseFailure");
  assert.match(context.additionalContext, /failed 4 times in a row/);
  const denied = JSON.parse((await claude.pre("Bash", { command: "npm test" })).stdout);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /has failed 4 times in a row/);
});

test("a user interrupt is not a failure; structured errors are", () => {
  assert.equal(payloadFailed({ hook_event_name: "PostToolUseFailure", is_interrupt: true }), false);
  assert.equal(payloadFailed({ hook_event_name: "postToolUseFailure", error_message: "x" }), true);
  assert.equal(payloadFailed({ hook_event_name: "AfterTool", tool_response: { error: { message: "x" } } }), true);
  assert.equal(payloadFailed({ tool_response: { exitCode: 2 } }), true);
  assert.equal(payloadFailed({ tool_response: '{"is_error":true}' }), true);
  assert.equal(payloadFailed({ tool_response: { exitCode: 0, stdout: "error: none" } }), false, "no guessing from output text");
  assert.equal(payloadFailed({ tool_response: { filePath: "a", type: "create" } }), false);
});

test("the same call reported twice (same tool_use_id, or two hosts at once) counts once", async () => {
  const { project, store } = await setup();
  const claude = caller(store, project, "claude");
  for (let i = 0; i < 2; i++) {
    await claude.pre("Bash", { command: "npm test" }, {});
  }
  // Re-deliveries of call #2 with its id: still only two calls.
  const sameId = (id: string) =>
    runHook("pre-tool", "claude", JSON.stringify({ cwd: project, session_id: "d", tool_name: "Bash", tool_input: { command: "x" }, tool_use_id: id }), { store, env: {} });
  await sameId("a");
  await sameId("a");
  await sameId("a");
  assert.equal((await sameId("b")).stdout, "", "a, a, a, b = two distinct calls");

  const twoHosts = (agent: string) =>
    runHook("pre-tool", agent, JSON.stringify({ cwd: project, session_id: "e", tool_name: "Bash", tool_input: { command: "y" } }), { store, env: {} });
  await twoHosts("copilot");
  await twoHosts("claude");
  await twoHosts("copilot");
  await twoHosts("claude");
  const sessions = await store.getGuardSessions(project);
  const streak = Object.values(sessions.e.streaks)[0];
  assert.equal(streak.count, 2, "copilot+claude reporting the same call within 2 s is one call");
});

test("this server's own tools are never guarded", async () => {
  const { project, store } = await setup();
  const claude = caller(store, project, "claude");
  for (let i = 0; i < 6; i++) {
    assert.equal((await claude.pre("mcp__ai-handoff__log_progress", { projectPath: project })).stdout, "");
  }
});

test("--guard and .ai-handoff.json control the guard", async () => {
  const { project, store } = await setup();
  const claude = caller(store, project, "claude");
  for (let i = 0; i < 5; i++) assert.equal((await claude.pre("Bash", { command: "ls" }, { guard: "off" })).stdout, "");

  const warn = JSON.parse((await claude.pre("Bash", { command: "pwd" }, { guard: "warn" })).stdout || "{}");
  assert.deepEqual(warn, {}, "first call is fine");
  await claude.pre("Bash", { command: "pwd" }, { guard: "warn" });
  const warned = JSON.parse((await claude.pre("Bash", { command: "pwd" }, { guard: "warn" })).stdout);
  assert.match(warned.systemMessage, /loop guard/);
  assert.equal(warned.hookSpecificOutput, undefined, "warn mode does not deny");

  await fs.writeFile(path.join(project, ".ai-handoff.json"), JSON.stringify({ loopGuard: { repeatLimit: 5, turnBudget: 0 } }));
  const other = caller(store, project, "claude", { session_id: "s2" });
  for (let i = 0; i < 4; i++) assert.equal((await other.pre("Bash", { command: "date" })).stdout, "", `call ${i + 1} under repeatLimit 5`);
  assert.match((await other.pre("Bash", { command: "date" })).stdout, /deny/);
});

test("guard state on disk holds hashes and counters only", async () => {
  const { project, store } = await setup();
  const claude = caller(store, project, "claude");
  // Run the secret command until it is denied and stopped, so decisions are stored too.
  for (let i = 0; i < 4; i++) await claude.pre("Bash", { command: "curl -H 'Authorization: SECRET-123' https://x" });
  await claude.pre("Edit", { file_path: path.join(project, "a.ts"), old_string: "SECRET-OLD", new_string: "SECRET-NEW" });
  assert.equal((await store.getGuardSessions(project)).s1.stops, 1);
  const raw = await fs.readFile(store.guardStatePath(project), "utf8");
  assert.doesNotMatch(raw, /SECRET|curl/);
});

test("the timeline entry about a stop never contains credentials", async () => {
  const { project, store } = await setup();
  await store.write(project, () => ({ ...emptyFields(), task: "Call the API" }), { agent: "claude", message: "saved" });
  const claude = caller(store, project, "claude");
  for (let i = 0; i < 4; i++) await claude.pre("Bash", { command: "curl -H 'Authorization: Bearer sk-live-SECRETSECRET' https://x" });
  const log = (await store.get(project))?.log.at(-1)?.message ?? "";
  assert.match(log, /loop guard stopped the agent/);
  assert.doesNotMatch(log, /SECRETSECRET/);
});

test("session lifecycle: sessions are isolated, a stopped one stays blocked, --guard off bypasses without touching state", async () => {
  const { project, store } = await setup();
  const session = (id: string) => caller(store, project, "claude", { session_id: id });
  const verdict = (stdout: string) => {
    if (!stdout) return "allow";
    const out = JSON.parse(stdout);
    return out.continue === false ? "stop" : out.hookSpecificOutput?.permissionDecision === "deny" ? "deny" : "other";
  };
  const read = (file: string) => ({ file_path: path.join(project, file) });
  const s1 = session("s1");
  const repeated: string[] = [];
  for (let i = 0; i < 4; i++) repeated.push(verdict((await s1.pre("Read", read("a.txt"))).stdout));
  assert.deepEqual(repeated, ["allow", "allow", "deny", "stop"], "repeatLimit 3 in one session");
  assert.equal(verdict((await s1.pre("Read", read("other.txt"))).stdout), "deny", "a stopped session stays blocked, whatever the call");

  const s2 = session("s2");
  for (let i = 0; i < 2; i++) assert.equal(verdict((await s2.pre("Read", read("a.txt"))).stdout), "allow", "a new session inherits nothing");
  assert.equal(verdict((await s2.pre("Read", read("other.txt"))).stdout), "allow", "and can work while s1 is stopped");

  const statsBefore = await store.getStats(project);
  assert.equal(verdict((await s1.pre("Read", read("a.txt"), { guard: "off" })).stdout), "allow", "--guard off bypasses even a stopped session");
  const s3 = session("s3");
  for (let i = 0; i < 5; i++) assert.equal(verdict((await s3.pre("Read", read("b.txt"), { guard: "off" })).stdout), "allow");
  const sessions = await store.getGuardSessions(project);
  assert.equal(sessions.s3, undefined, "--guard off records no state");
  assert.equal(sessions.s1.halted, true, "and leaves the stopped session as it was");
  assert.deepEqual(await store.getStats(project), statsBefore, "and counts nothing");
  assert.match((await s3.prompt("fix it")).stdout, /block/, "the prompt gate is a separate protection and still works");
  assert.equal(verdict((await s1.pre("Read", read("a.txt"))).stdout), "deny", "without --guard off, s1 is still stopped");

  await s1.prompt("In a.txt change the header so that it says 2026");
  assert.equal(verdict((await s1.pre("Read", read("a.txt"))).stdout), "allow", "the user's next prompt lets s1 work again");
  const stats = await store.getStats(project);
  assert.deepEqual([stats.loopDenied, stats.loopStopped], [1, 1], "counters are cumulative and count each event once");
});

test("--guard off on one hook command only covers that command; .ai-handoff.json turns the whole guard off", async () => {
  const { project, store } = await setup();
  const claude = caller(store, project, "claude");
  const failing = { tool_name: "Bash", tool_input: { command: "npm test" }, hook_event_name: "PostToolUseFailure", error: "exit code 1" };
  let warned = false;
  for (let i = 0; i < 4 && !warned; i++) {
    await claude.pre("Bash", { command: "npm test" }, { guard: "off" });
    await claude.post({ tool_name: "Edit", tool_input: { file_path: path.join(project, `f${i}.ts`) } });
    warned = /additionalContext/.test((await claude.post(failing)).stdout);
  }
  assert.ok(warned, "post-tool without --guard off still tracks repeated failures");

  const { project: other, store: otherStore } = await setup();
  await fs.writeFile(path.join(other, ".ai-handoff.json"), JSON.stringify({ loopGuard: { mode: "off" } }));
  const off = caller(otherStore, other, "claude");
  for (let i = 0; i < 6; i++) {
    assert.equal((await off.pre("Bash", { command: "npm test" })).stdout, "");
    assert.equal((await off.post(failing)).stdout, "", "the config file covers every hook");
  }
  assert.deepEqual(await otherStore.getGuardSessions(other), {}, "and no guard state is written at all");
});
