import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { HandoffStore } from "../src/storage.js";
import { commitFile, initRepo, tempProject } from "./helpers.js";

async function connect(dataDir: string) {
  const store = new HandoffStore(dataDir);
  const server = createServer(store);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
    return { isError: Boolean(result.isError), text: result.content.map((part) => part.text).join("\n") };
  };
  return { client, store, call, close: () => client.close() };
}

test("lists every tool and prompt", async () => {
  const { dataDir } = await tempProject();
  const { client, close } = await connect(dataDir);
  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(tools, [
    "clear_handoff",
    "export_handoff_markdown",
    "get_handoff",
    "get_project_status",
    "log_progress",
    "prepare_handoff",
    "resume_task",
    "save_handoff",
    "update_handoff"
  ]);
  const prompts = (await client.listPrompts()).prompts.map((prompt) => prompt.name).sort();
  assert.deepEqual(prompts, ["checkpoint", "resume"]);
  const resume = await client.getPrompt({ name: "resume", arguments: { agent: "copilot" } });
  const message = resume.messages[0].content as { text: string };
  assert.match(message.text, /resume_task/);
  assert.match(message.text, /"copilot"/);
  const checkpoint = await client.getPrompt({ name: "checkpoint" });
  assert.match((checkpoint.messages[0].content as { text: string }).text, /update_handoff/);
  await close();
});

test("end to end: Claude stops at a usage limit and Copilot continues from the checkpoint", async () => {
  const { project, dataDir } = await tempProject();
  await initRepo(project);
  const { call, store, close } = await connect(dataDir);

  // 1. Claude starts the task.
  const saved = await call("save_handoff", {
    projectPath: project,
    agent: "Claude",
    task: "Add a login page",
    currentStep: "Create the form",
    nextSteps: ["Create the form", "Validate email", "Write tests"],
    keyFiles: ["src/login.ts"],
    decisions: ["Use plain HTML forms, no framework"]
  });
  assert.equal(saved.isError, false, saved.text);
  assert.match(saved.text, /Checkpoint saved .* by claude/);

  // 2. Claude finishes one step and logs it.
  await commitFile(project, "src/login.ts", "export const form = true;\n", "create login form");
  const progress = await call("log_progress", {
    projectPath: project,
    agent: "claude",
    completedStep: "Create the form",
    currentStep: "Validate email",
    changedFiles: ["src/login.ts"]
  });
  assert.equal(progress.isError, false, progress.text);

  // 3. Claude keeps working but hits its usage limit before it can checkpoint again.
  await commitFile(project, "src/validate.ts", "export const ok = 1;\n", "half-done email validation");
  await fs.writeFile(path.join(project, "src", "validate.ts"), "export const ok = 2;\n");

  // 4. Copilot opens the project and resumes.
  const brief = await call("resume_task", { projectPath: project, agent: "copilot" });
  assert.equal(brief.isError, false, brief.text);
  assert.match(brief.text, /Last checkpoint: .* by claude/);
  assert.match(brief.text, /## Task\nAdd a login page/);
  assert.match(brief.text, /## Was doing when stopped\nValidate email/);
  assert.match(brief.text, /## Next steps \(in order\)\n1\. Validate email\n2\. Write tests/);
  assert.match(brief.text, /## Completed\n- Create the form/);
  assert.match(brief.text, /Use plain HTML forms/);
  assert.match(brief.text, /## Key files \(read these first\)\n- src\/login.ts/);
  assert.match(brief.text, /## Changes after the last checkpoint/);
  assert.match(brief.text, /half-done email validation/);
  assert.match(brief.text, /src\/validate.ts/);
  assert.match(brief.text, /M src\/validate.ts/);
  assert.match(brief.text, /Do not read AI chat\/session transcripts/);

  const afterResume = await store.get(project);
  assert.equal(afterResume?.log.at(-1)?.agent, "copilot");
  assert.equal(afterResume?.log.at(-1)?.message, "resumed the task");
  assert.equal(afterResume?.updatedBy, "claude", "resuming does not change the checkpoint author");

  // 5. Copilot finishes and records the result.
  await call("log_progress", {
    projectPath: project,
    agent: "copilot",
    completedStep: "Validate email",
    changedFiles: ["src/validate.ts"],
    tests: ["npm test: 4 passed"]
  });
  const done = await call("update_handoff", {
    projectPath: project,
    agent: "copilot",
    status: "done",
    currentStep: "",
    appendCompleted: ["Write tests"],
    nextSteps: []
  });
  assert.equal(done.isError, false, done.text);

  const final = await store.get(project);
  assert.equal(final?.status, "done");
  assert.equal(final?.updatedBy, "copilot");
  assert.deepEqual(final?.completed, ["Create the form", "Validate email", "Write tests"]);
  assert.deepEqual(final?.nextSteps, []);
  assert.deepEqual(final?.changedFiles, ["src/login.ts", "src/validate.ts"]);
  assert.deepEqual(final?.tests, ["npm test: 4 passed"]);
  assert.equal(final?.git?.dirty, true);
  assert.deepEqual(
    final?.log.map((entry) => entry.agent),
    ["claude", "claude", "copilot", "copilot", "copilot"]
  );

  // 6. Claude comes back later: the brief now shows Copilot's work and no unexplained changes.
  const back = await call("resume_task", { projectPath: project, agent: "claude" });
  assert.match(back.text, /by copilot · status: done/);
  assert.doesNotMatch(back.text, /## Changes after the last checkpoint/);
  await close();
});

test("resume_task on a new project explains how to start", async () => {
  const { project, dataDir } = await tempProject();
  const { call, store, close } = await connect(dataDir);
  const brief = await call("resume_task", { projectPath: project, agent: "copilot" });
  assert.equal(brief.isError, false);
  assert.match(brief.text, /No checkpoint exists/);
  assert.match(brief.text, /Git status unavailable/);
  assert.equal(await store.get(project), null, "resuming does not create a checkpoint");
  await close();
});

test("rejects relative, missing and non-directory project paths", async () => {
  const { root, project, dataDir } = await tempProject();
  const { call, close } = await connect(dataDir);
  const relative = await call("save_handoff", { projectPath: "project", agent: "claude" });
  assert.equal(relative.isError, true);
  assert.match(relative.text, /absolute path/);

  const missing = await call("save_handoff", { projectPath: path.join(root, "nope"), agent: "claude" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /does not exist/);

  const file = path.join(project, "file.txt");
  await fs.writeFile(file, "x");
  const notDir = await call("resume_task", { projectPath: file, agent: "claude" });
  assert.equal(notDir.isError, true);
  assert.match(notDir.text, /not a directory/);
  await close();
});

test("validates status values and required agent", async () => {
  const { project, dataDir } = await tempProject();
  const { call, close } = await connect(dataDir);
  assert.equal((await call("save_handoff", { projectPath: project, agent: "claude", status: "finished" })).isError, true);
  assert.equal((await call("save_handoff", { projectPath: project })).isError, true);
  await close();
});

test("get_handoff and update_handoff keep untouched fields", async () => {
  const { project, dataDir } = await tempProject();
  const { call, close } = await connect(dataDir);
  assert.match((await call("get_handoff", { projectPath: project })).text, /No checkpoint exists/);
  await call("save_handoff", { projectPath: project, agent: "claude", task: "T", notes: "N", blockers: ["B"] });
  await call("update_handoff", { projectPath: project, agent: "copilot", status: "blocked", appendBlockers: ["C", "B"] });
  const record = JSON.parse((await call("get_handoff", { projectPath: project })).text);
  assert.equal(record.task, "T");
  assert.equal(record.notes, "N");
  assert.equal(record.status, "blocked");
  assert.deepEqual(record.blockers, ["B", "C"]);
  assert.equal(record.updatedBy, "copilot");
  assert.match(record.log.at(-1).message, /updated status, appendBlockers/);
  await close();
});

test("save_handoff replaces fields but keeps the timeline", async () => {
  const { project, dataDir } = await tempProject();
  const { call, store, close } = await connect(dataDir);
  await call("save_handoff", { projectPath: project, agent: "claude", task: "Old", nextSteps: ["x"] });
  await call("save_handoff", { projectPath: project, agent: "claude", task: "New" });
  const record = await store.get(project);
  assert.equal(record?.task, "New");
  assert.deepEqual(record?.nextSteps, []);
  assert.equal(record?.log.length, 2);
  await close();
});

test("get_project_status returns Git details", async () => {
  const { project, dataDir } = await tempProject();
  await initRepo(project);
  const { call, close } = await connect(dataDir);
  const status = JSON.parse((await call("get_project_status", { projectPath: project })).text);
  assert.equal(status.available, true);
  assert.equal(status.branch, "main");
  assert.match(status.head, /^[0-9a-f]{40}$/);
  await close();
});

test("prepare_handoff builds a paste-ready prompt", async () => {
  const { project, dataDir } = await tempProject();
  const { call, close } = await connect(dataDir);
  await call("save_handoff", { projectPath: project, agent: "copilot", task: "Fix bug 7", nextSteps: ["Reproduce"] });
  const prompt = await call("prepare_handoff", { projectPath: project, targetAgent: "claude" });
  assert.match(prompt.text, /^You are Claude Code taking over/);
  assert.match(prompt.text, /Fix bug 7/);
  assert.match(prompt.text, /1\. Reproduce/);
  await close();
});

test("export_handoff_markdown writes HANDOFF.md and refuses to overwrite", async () => {
  const { project, dataDir } = await tempProject();
  const { call, close } = await connect(dataDir);
  const none = await call("export_handoff_markdown", { projectPath: project });
  assert.equal(none.isError, true);
  assert.match(none.text, /No saved handoff/);

  await call("save_handoff", { projectPath: project, agent: "claude", task: "Ship it" });
  const first = await call("export_handoff_markdown", { projectPath: project });
  assert.equal(first.isError, false, first.text);
  const file = path.join(project, "HANDOFF.md");
  assert.match(await fs.readFile(file, "utf8"), /## Current task\nShip it/);

  const second = await call("export_handoff_markdown", { projectPath: project });
  assert.equal(second.isError, true);
  assert.match(second.text, /already exists/);

  await call("update_handoff", { projectPath: project, agent: "claude", task: "Ship it v2" });
  const third = await call("export_handoff_markdown", { projectPath: project, overwrite: true });
  assert.equal(third.isError, false);
  assert.match(await fs.readFile(file, "utf8"), /Ship it v2/);
  await close();
});

test("clear_handoff requires confirm=true", async () => {
  const { project, dataDir } = await tempProject();
  const { call, store, close } = await connect(dataDir);
  await call("save_handoff", { projectPath: project, agent: "claude", task: "T" });
  assert.equal((await call("clear_handoff", { projectPath: project })).isError, true);
  assert.equal((await call("clear_handoff", { projectPath: project, confirm: false })).isError, true);
  assert.ok(await store.get(project));
  assert.match((await call("clear_handoff", { projectPath: project, confirm: true })).text, /deleted/);
  assert.equal(await store.get(project), null);
  assert.match((await call("clear_handoff", { projectPath: project, confirm: true })).text, /No checkpoint existed/);
  await close();
});

test("reports a corrupted checkpoint as a tool error instead of crashing", async () => {
  const { project, dataDir } = await tempProject();
  const { call, store, close } = await connect(dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(store.filePath(project), "garbage");
  const result = await call("resume_task", { projectPath: project, agent: "copilot" });
  assert.equal(result.isError, true);
  assert.match(result.text, /not valid JSON/);
  await close();
});

test("the server's icons are served from this repository, and server.json lists the same ones", async () => {
  const { SERVER_ICONS } = await import("../src/version.js");
  const { dataDir } = await tempProject();
  const { client, close } = await connect(dataDir);
  assert.deepEqual(client.getServerVersion()?.icons, SERVER_ICONS, "sent in serverInfo");
  await close();
  const root = path.resolve(import.meta.dirname, "..");
  const registry = JSON.parse(await fs.readFile(path.join(root, "server.json"), "utf8"));
  assert.deepEqual(registry.icons, SERVER_ICONS, "server.json and the server agree");
  for (const icon of SERVER_ICONS) {
    assert.match(icon.src, /^https:\/\/raw\.githubusercontent\.com\/EngHamzaAboJarad\/ai-handoff-mcp\/master\/assets\//);
    assert.ok(icon.src.length <= 255, "the registry limit");
    await fs.access(path.join(root, "assets", path.basename(icon.src)));
  }
  const png = await fs.readFile(path.join(root, "assets", "icon.png"));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [256, 256], "the size server.json declares");
});
