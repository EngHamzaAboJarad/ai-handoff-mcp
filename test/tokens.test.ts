// Token profiles: what the tool adds to the model's context, and that the core tools stay exactly as they are.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { HandoffStore, emptyFields } from "../src/storage.js";
import { runHook } from "../src/hooks.js";
import { runCli } from "../src/cli.js";
import { CORE_TOOLS, MIN_BRIEF_CHARS, estimateTokens, tokenSettings } from "../src/tokens.js";
import { tempProject } from "./helpers.js";

async function listTools(store: HandoffStore, tools?: "all" | "core") {
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([createServer(store, { tools }).connect(serverSide), client.connect(clientSide)]);
  const result = await client.listTools();
  const call = async (name: string, args: Record<string, unknown>) =>
    ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0].text;
  return { tools: result.tools, call };
}

/** A checkpoint big enough that the brief has to drop sections to fit a small budget. */
async function bigCheckpoint(store: HandoffStore, project: string) {
  const many = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix} ${i}: ${"detail ".repeat(12)}`);
  await store.write(
    project,
    () => ({
      ...emptyFields(),
      task: "Migrate the billing module to the new payments API",
      currentStep: "Porting src/billing/invoice.ts",
      nextSteps: many("next", 15),
      completed: many("done", 20),
      decisions: many("decision", 10),
      keyFiles: many("src/file", 10),
      tests: many("npm test", 5),
      notes: "note ".repeat(300)
    }),
    { agent: "claude", message: "saved" }
  );
}

test("token settings: standard by default, lean from .ai-handoff.json, AI_HANDOFF_TOKENS wins", () => {
  assert.deepEqual(tokenSettings(undefined), { profile: "standard", tools: "all", briefChars: 6000 });
  assert.deepEqual(tokenSettings({ profile: "lean" }), { profile: "lean", tools: "core", briefChars: 3000 });
  assert.equal(tokenSettings({ profile: "lean" }, "standard").tools, "all");
  assert.equal(tokenSettings({ profile: "nonsense" as never }).profile, "standard", "an unknown profile falls back");
  assert.equal(tokenSettings({ profile: "lean", briefChars: 4500 }).briefChars, 4500);
  assert.equal(tokenSettings({ briefChars: 10 }).briefChars, MIN_BRIEF_CHARS, "the brief always keeps its most important sections");
});

test("lean exposes only the core tools, with the same definitions word for word", async () => {
  const { dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  const all = (await listTools(store)).tools;
  const core = (await listTools(store, "core")).tools;
  assert.equal(all.length, 9);
  assert.deepEqual(core.map((tool) => tool.name).sort(), [...CORE_TOOLS].sort());
  for (const tool of core) {
    assert.deepEqual(tool, all.find((other) => other.name === tool.name), `${tool.name} is not shortened`);
  }
  const saved = estimateTokens(JSON.stringify(all)) - estimateTokens(JSON.stringify(core));
  assert.ok(saved > 600, `lean saves ${saved} tokens of tool definitions`);
});

test("the brief follows the project's token budget, at session start and in resume_task", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  await bigCheckpoint(store, project);
  const sessionStart = async () => {
    const result = await runHook("session-start", "claude", JSON.stringify({ cwd: project, session_id: "s" }), { store, env: {} });
    return JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
  };
  const standard = await sessionStart();
  assert.ok(standard.length <= 6000 && standard.length > 3000, `standard brief: ${standard.length} characters`);

  await fs.writeFile(path.join(project, ".ai-handoff.json"), JSON.stringify({ tokens: { profile: "lean" } }));
  const lean = await sessionStart();
  assert.ok(lean.length <= 3000, `lean brief: ${lean.length} characters`);
  for (const kept of ["Migrate the billing module", "Porting src/billing/invoice.ts", "next 0:"]) {
    assert.match(lean, new RegExp(kept), "the task, current step and next steps are always kept");
  }
  assert.match(lean, /left out to save context; call resume_task with detail="full"/);

  const { call } = await listTools(store, "core");
  const resumed = await call("resume_task", { projectPath: project, agent: "copilot" });
  assert.ok(resumed.length <= 3000, `resume_task brief: ${resumed.length} characters`);
  assert.ok((await call("resume_task", { projectPath: project, agent: "copilot", detail: "full" })).length > 6000, "full detail is still complete");
});

test("tokens command reports what the model pays for with the project's settings", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  let out = "";
  const io = (env: NodeJS.ProcessEnv) => ({ out: (text: string) => (out += text), err: () => {}, cwd: project, env });
  assert.equal(await runCli(["tokens"], io({}), store), 0);
  assert.match(out, /profile "standard"/);
  assert.match(out, /Tool definitions \(9 of 9 tools\)/);
  assert.match(out, /"profile": "lean"/, "standard suggests the lean profile");
  out = "";
  assert.equal(await runCli(["tokens"], io({ AI_HANDOFF_TOKENS: "lean" }), store), 0);
  assert.match(out, /Tool definitions \(4 of 9 tools\)/);
  assert.match(out, /Free \(runs outside the model\): prompt gate/);
});

async function connectWith(store: HandoffStore, tools?: "all" | "core" | "minimal") {
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([createServer(store, { tools }).connect(serverSide), client.connect(clientSide)]);
  return client;
}

test("minimal: one tool that records a whole checkpoint, and nothing extra for the other profiles", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  const minimal = await connectWith(store, "minimal");
  const tools = (await minimal.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["log_progress"]);
  const props = Object.keys((tools[0].inputSchema as { properties: object }).properties);
  for (const field of ["task", "keyFiles", "blockers"]) assert.ok(props.includes(field), field);
  assert.ok(estimateTokens(JSON.stringify(tools)) < 800, `minimal costs ${estimateTokens(JSON.stringify(tools))} tokens`);

  const standard = (await (await connectWith(store)).listTools()).tools.find((tool) => tool.name === "log_progress");
  assert.ok(!Object.keys((standard?.inputSchema as { properties: object }).properties).includes("task"), "standard log_progress is unchanged");

  const call = (args: Record<string, unknown>) => minimal.callTool({ name: "log_progress", arguments: { projectPath: project, agent: "claude", ...args } });
  await call({ task: "Add login", nextSteps: ["Form", "Tests"], keyFiles: ["src/login.ts"], blockers: ["API key missing"] });
  await call({ completedStep: "Form", currentStep: "Tests", blockers: [] });
  const record = await store.get(project);
  assert.equal(record?.task, "Add login");
  assert.deepEqual(record?.nextSteps, ["Tests"]);
  assert.deepEqual(record?.completed, ["Form"]);
  assert.deepEqual(record?.keyFiles, ["src/login.ts"]);
  assert.deepEqual(record?.blockers, [], "blockers are replaced, so they can be cleared");

  const prompts = (await minimal.listPrompts()).prompts.map((prompt) => prompt.name);
  assert.deepEqual(prompts, ["checkpoint"], "the resume prompt needs resume_task");
  const checkpoint = await minimal.getPrompt({ name: "checkpoint" });
  assert.match(JSON.stringify(checkpoint), /log_progress/);
  assert.doesNotMatch(JSON.stringify(checkpoint), /update_handoff/);
});

test("minimal: the injected brief never names a tool the agent does not have", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  await fs.writeFile(path.join(project, ".ai-handoff.json"), JSON.stringify({ tokens: { profile: "minimal" } }));
  const start = async (session: string) =>
    JSON.parse((await runHook("session-start", "claude", JSON.stringify({ cwd: project, session_id: session }), { store, env: {} })).stdout || "{}")
      .hookSpecificOutput?.additionalContext as string | undefined;
  await runHook("session-start", "claude", JSON.stringify({ cwd: project, session_id: "x" }), { store, env: {} });
  await runHook("post-tool", "claude", JSON.stringify({ cwd: project, session_id: "x", tool_name: "Edit", tool_input: { file_path: path.join(project, "a.ts") } }), { store, env: {} });
  const autoOnly = (await start("a")) ?? "";
  assert.match(autoOnly, /call log_progress with the task/);
  await store.write(project, (current) => ({ ...current, task: "Add login", currentStep: "Form" }), { agent: "claude", message: "log_progress" });
  const brief = (await start("b")) ?? "";
  assert.match(brief, /log_progress is this project's only checkpoint tool/);
  assert.doesNotMatch(brief, /update_handoff|save_handoff|resume_task/);
  assert.equal(tokenSettings({ profile: "minimal" }).tools, "minimal");
});

test("minimal: nextSteps is the whole remaining plan, so a changed plan can be corrected", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  const client = await connectWith(store, "minimal");
  const call = (args: Record<string, unknown>) => client.callTool({ name: "log_progress", arguments: { projectPath: project, agent: "claude", ...args } });
  await call({ task: "Add login", nextSteps: ["Form", "Validation", "Tests"] });
  await call({ completedStep: "Form", nextSteps: ["Form", "Server check", "Tests"] });
  assert.deepEqual((await store.get(project))?.nextSteps, ["Server check", "Tests"], "replaced, without the step just completed");
  const description = JSON.stringify((await client.listTools()).tools[0]);
  assert.match(description, /nextSteps and blockers replace their lists/);
  assert.match(description, /All remaining steps, in order; replaces the list/);
});
