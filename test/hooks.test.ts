import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fsp from "node:fs/promises";
import { extractFilePaths, pickHookInput, projectRootFor, runHook } from "../src/hooks.js";
import { HandoffStore, emptyFields } from "../src/storage.js";
import { commitFile, initRepo, tempProject } from "./helpers.js";

const payload = (fields: Record<string, unknown>) => JSON.stringify(fields);

test("pickHookInput keeps only the fields it needs and drops transcript_path", () => {
  const picked = pickHookInput({
    session_id: "s1",
    transcript_path: "/home/me/.claude/projects/x/s1.jsonl",
    cwd: "/work/app",
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "/work/app/a.ts" },
    tool_response: { success: true }
  });
  assert.deepEqual(Object.keys(picked).sort(), [
    "attachments",
    "cwd",
    "failed",
    "hookEventName",
    "prompt",
    "sessionId",
    "source",
    "status",
    "stopHookActive",
    "toolInput",
    "toolName",
    "toolUseId"
  ]);
  assert.equal(picked.sessionId, "s1");
  assert.ok(!JSON.stringify(picked).includes("jsonl"));
  assert.deepEqual(pickHookInput("nonsense"), {});
  assert.equal(pickHookInput({ toolName: "x", hookEventName: "Stop" }).toolName, "x");
});

test("extractFilePaths understands Claude Code and VS Code tool shapes", () => {
  const root = path.resolve("/work/app");
  const inRoot = (file: string) => path.join(root, file);
  assert.deepEqual(extractFilePaths({ file_path: inRoot("src/a.ts"), old_string: "x" }, root), ["src/a.ts"]);
  assert.deepEqual(extractFilePaths({ filePath: inRoot("src/b.ts") }, root), ["src/b.ts"]);
  assert.deepEqual(extractFilePaths({ notebook_path: inRoot("n.ipynb") }, root), ["n.ipynb"]);
  assert.deepEqual(extractFilePaths({ files: ["src/c.ts", inRoot("src/d.ts")] }, root), ["src/c.ts", "src/d.ts"]);
  assert.deepEqual(extractFilePaths({ edits: [{ path: "src/e.ts" }, { filePath: "src/f.ts" }] }, root), ["src/e.ts", "src/f.ts"]);
  assert.deepEqual(extractFilePaths({ uri: "file://" + inRoot("g.ts").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:") }, root), ["g.ts"]);
  assert.deepEqual(extractFilePaths({ file_path: path.resolve("/etc/passwd") }, root), [], "outside the project");
  assert.deepEqual(extractFilePaths({ file_path: "../other/x.ts" }, root), []);
  assert.deepEqual(extractFilePaths({ uri: "https://example.com/a.ts" }, root), []);
  assert.deepEqual(extractFilePaths({ command: "rm -rf build" }, root), []);
  assert.deepEqual(extractFilePaths(null, root), []);
});

test("projectRootFor prefers CLAUDE_PROJECT_DIR, then the hook cwd", () => {
  assert.equal(projectRootFor({ cwd: "/b" }, { CLAUDE_PROJECT_DIR: "/a" }, "/c"), path.resolve("/a"));
  assert.equal(projectRootFor({ cwd: "/b" }, {}, "/c"), path.resolve("/b"));
  assert.equal(projectRootFor({}, {}, "/c"), path.resolve("/c"));
});

test("post-tool records edited files and tool calls without touching the agent's checkpoint", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  await store.write(project, () => ({ ...emptyFields(), task: "T", nextSteps: ["a"] }), { agent: "claude", message: "saved" });
  const options = { store, env: {}, cwd: project };

  const edit = (file: string) => payload({ cwd: project, tool_name: "Edit", tool_input: { file_path: path.join(project, file) } });
  assert.deepEqual(await runHook("post-tool", "claude", edit("src/a.ts"), options), { stdout: "" });
  await runHook("post-tool", "claude", edit("src/b.ts"), options);
  await runHook("post-tool", "claude", edit("src/a.ts"), options);
  await runHook("post-tool", "claude", payload({ cwd: project, tool_name: "Bash", tool_input: { command: "npm test" } }), options);

  const record = await store.get(project);
  assert.equal(record?.task, "T");
  assert.deepEqual(record?.nextSteps, ["a"]);
  assert.equal(record?.log.length, 1, "hooks do not flood the timeline");
  assert.equal(record?.auto?.toolCalls, 4);
  assert.equal(record?.auto?.lastTool, "Bash");
  assert.equal(record?.auto?.event, "post-tool");
  assert.deepEqual(record?.auto?.touchedFiles, ["src/b.ts", "src/a.ts"], "most recent last, no duplicates");
});

test("post-tool ignores this server's own tool calls", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  await runHook("post-tool", "copilot", payload({ cwd: project, tool_name: "mcp_ai-handoff_log_progress", tool_input: {} }), { store, env: {} });
  await runHook("post-tool", "claude", payload({ cwd: project, tool_name: "mcp__ai-handoff__update_handoff", tool_input: {} }), { store, env: {} });
  assert.equal(await store.get(project), null);
});

test("an agent checkpoint resets the automatic capture", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  await runHook("post-tool", "claude", payload({ cwd: project, tool_name: "Write", tool_input: { file_path: "x.ts" } }), { store, env: {} });
  assert.equal((await store.get(project))?.auto?.toolCalls, 1);
  await store.write(project, (current) => ({ ...current, task: "T" }), { agent: "claude", message: "saved" });
  assert.equal((await store.get(project))?.auto, null);
});

test("stop, pre-compact and session-end record how the session ended", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  for (const event of ["stop", "pre-compact", "session-end"] as const) {
    await runHook(event, "claude", payload({ cwd: project }), { store, env: {} });
    const auto = (await store.get(project))?.auto;
    assert.equal(auto?.event, event);
    assert.equal(auto?.toolCalls, 0);
  }
});

test("session-start without a record stores a Git baseline and prints nothing", async () => {
  const { project, dataDir } = await tempProject();
  await initRepo(project);
  const store = new HandoffStore(dataDir);
  const result = await runHook("session-start", "claude", payload({ cwd: project, source: "startup" }), { store, env: {} });
  assert.equal(result.stdout, "");
  const record = await store.get(project);
  assert.match(record?.git?.head ?? "", /^[0-9a-f]{40}$/);
  assert.equal(record?.task, "");
});

test("session-start with a checkpoint injects the compact brief as additional context", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  await store.write(project, () => ({ ...emptyFields(), task: "Ship feature X", nextSteps: ["Write docs"] }), { agent: "claude", message: "saved" });
  const result = await runHook("session-start", "copilot", payload({ cwd: project, source: "startup" }), { store, env: {} });
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(output.hookSpecificOutput.additionalContext, /## Task\nShip feature X/);
  assert.match(output.hookSpecificOutput.additionalContext, /1\. Write docs/);
  assert.match((await store.get(project))?.log.at(-1)?.message ?? "", /session started \(startup\)/);
});

test("invalid or empty stdin still works", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  assert.deepEqual(await runHook("stop", "claude", "not json", { store, env: {}, cwd: project }), { stdout: "" });
  assert.deepEqual(await runHook("stop", "claude", "", { store, env: {}, cwd: project }), { stdout: "" });
  assert.equal((await store.get(project))?.auto?.event, "stop");
});

test("hooks never open the session transcript", async () => {
  const { root, project, dataDir } = await tempProject();
  await initRepo(project);
  const transcript = path.join(root, "session-transcript.jsonl");
  await fsp.writeFile(transcript, '{"secret":"TRANSCRIPT-SECRET-123"}\n');
  const store = new HandoffStore(dataDir);
  await store.write(project, () => ({ ...emptyFields(), task: "T" }), { agent: "claude", message: "saved" });

  const touched: string[] = [];
  const spied = ["readFile", "open", "stat", "lstat", "access", "readdir", "copyFile", "cp", "opendir", "watch"] as const;
  const fsAny = fsp as unknown as Record<string, (...args: unknown[]) => unknown>;
  const originals = Object.fromEntries(spied.map((name) => [name, fsAny[name]]));
  for (const name of spied) {
    fsAny[name] = (...args: unknown[]) => {
      if (String(args[0]).includes("session-transcript")) touched.push(`${name}(${String(args[0])})`);
      return originals[name].apply(fsp, args);
    };
  }
  try {
    const base = { session_id: "s", transcript_path: transcript, cwd: project };
    const start = await runHook("session-start", "claude", payload({ ...base, hook_event_name: "SessionStart" }), { store, env: {} });
    await runHook(
      "post-tool",
      "claude",
      payload({ ...base, tool_name: "Edit", tool_input: { file_path: path.join(project, "a.ts") }, tool_response: "ok" }),
      { store, env: {} }
    );
    await runHook("stop", "claude", payload(base), { store, env: {} });
    await runHook("pre-compact", "claude", payload(base), { store, env: {} });
    assert.deepEqual(touched, [], "transcript was accessed");
    assert.doesNotMatch(start.stdout, /TRANSCRIPT-SECRET|session-transcript/);
    const stored = await fsp.readFile(store.filePath(project), "utf8");
    assert.doesNotMatch(stored, /TRANSCRIPT-SECRET|session-transcript/);
  } finally {
    for (const name of spied) fsAny[name] = originals[name];
  }
});

test("end to end: Claude never checkpoints, hits its limit, and Copilot still gets the stopping point", async () => {
  const { project, dataDir } = await tempProject();
  await initRepo(project);
  const store = new HandoffStore(dataDir);
  const claude = (event: Parameters<typeof runHook>[0], fields: Record<string, unknown> = {}) =>
    runHook(event, "claude", payload({ cwd: project, transcript_path: "/nope.jsonl", ...fields }), { store, env: { CLAUDE_PROJECT_DIR: project } });

  // Claude's session: SessionStart, then edits. The agent itself never calls an ai-handoff tool.
  await claude("session-start", { source: "startup" });
  await commitFile(project, "src/api.ts", "export const api = 1;\n", "add api");
  await claude("post-tool", { tool_name: "Write", tool_input: { file_path: path.join(project, "src", "api.ts") } });
  await claude("stop");
  await fsp.writeFile(path.join(project, "src", "routes.ts"), "export const routes = [];\n");
  await claude("post-tool", { tool_name: "Edit", tool_input: { file_path: path.join(project, "src", "routes.ts") } });
  // Usage limit: no Stop event, no checkpoint.

  const start = await runHook("session-start", "copilot", payload({ cwd: project }), { store, env: {} });
  const brief = JSON.parse(start.stdout).hookSpecificOutput.additionalContext as string;
  assert.match(brief, /No agent has written a checkpoint yet/);
  assert.match(brief, /2 tool call\(s\) by claude/);
  assert.match(brief, /last tool: Edit/);
  assert.match(brief, /most likely stopped mid-step/);
  assert.match(brief, /Files edited by tools:\n- src\/api.ts\n- src\/routes.ts/);
  assert.match(brief, /Commits:\n[0-9a-f]+ add api/);
  assert.match(brief, /Files changed since checkpoint:\n- src\/api.ts\n- src\/routes.ts/);
  assert.ok(brief.length < 3000, `brief is small (${brief.length} chars)`);
});
