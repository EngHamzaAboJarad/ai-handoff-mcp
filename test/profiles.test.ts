// Every profile: whatever the agent reads (tool definitions, prompts, every brief variant, the nudge, resume_task)
// names only tools that profile exposes. A call to a missing tool is a wasted model step, so this is checked for
// all of them together rather than one text at a time.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { HandoffStore, emptyFields } from "../src/storage.js";
import { runHook } from "../src/hooks.js";
import { INSTRUCTIONS } from "../src/init.js";
import { renderBrief } from "../src/handoff.js";
import { TOKEN_PROFILES, tokenSettings } from "../src/tokens.js";
import { tempProject } from "./helpers.js";

const ALL_TOOLS = [
  "resume_task",
  "save_handoff",
  "update_handoff",
  "log_progress",
  "get_handoff",
  "get_project_status",
  "prepare_handoff",
  "export_handoff_markdown",
  "clear_handoff"
];
const mentioned = (text: string) => ALL_TOOLS.filter((tool) => new RegExp(`\\b${tool}\\b`).test(text));

async function agentTexts(profile: (typeof TOKEN_PROFILES)[number]) {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  const tools = tokenSettings({ profile }).tools;
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([createServer(store, { tools }).connect(serverSide), client.connect(clientSide)]);
  const listed = (await client.listTools()).tools;
  const exposed = listed.map((tool) => tool.name);
  const texts: Record<string, string> = { "tool definitions": JSON.stringify(listed) };
  for (const prompt of (await client.listPrompts()).prompts) {
    texts[`prompt ${prompt.name}`] = JSON.stringify(await client.getPrompt({ name: prompt.name, arguments: {} }));
  }

  await fs.writeFile(path.join(project, ".ai-handoff.json"), JSON.stringify({ tokens: { profile, briefChars: 1500 } }));
  const hook = (event: "session-start" | "post-tool" | "stop", payload: Record<string, unknown>) =>
    runHook(event, "claude", JSON.stringify({ cwd: project, session_id: "s", ...payload }), { store, env: {} });
  const brief = async (session: string) =>
    JSON.parse((await hook("session-start", { session_id: session, source: "startup" })).stdout || "{}").hookSpecificOutput?.additionalContext ?? "";

  const git = { available: false, branch: null, head: null, status: "", diffStat: "" };
  texts["brief, no checkpoint"] = renderBrief({ projectPath: project, record: null, git, changes: null, minimalTools: tools === "minimal" });
  await hook("session-start", {});
  for (const [i, file] of ["a", "b", "c"].entries()) {
    await hook("post-tool", { tool_name: "Edit", tool_use_id: `e${i}`, tool_input: { file_path: path.join(project, `${file}.ts`) } });
  }
  texts["brief, hooks only"] = await brief("b1");
  texts["nudge"] = JSON.parse((await hook("stop", { hook_event_name: "Stop" })).stdout || "{}").reason ?? "";
  assert.ok(texts["nudge"], `${profile}: the nudge fires`);

  const many = (prefix: string) => Array.from({ length: 30 }, (_, i) => `${prefix} ${i} ${"detail ".repeat(10)}`);
  await store.write(
    project,
    (current) => ({ ...current, ...emptyFields(), task: "Add login", currentStep: "Form", nextSteps: many("next"), completed: many("done"), notes: "n ".repeat(500) }),
    { agent: "claude", message: "saved" }
  );
  texts["brief, checkpoint (trimmed to budget)"] = await brief("b2");
  assert.match(texts["brief, checkpoint (trimmed to budget)"], /left out to save context/, `${profile}: the trimmed variant is covered`);
  await fs.writeFile(path.join(project, "CLAUDE.md"), INSTRUCTIONS);
  texts["brief, instructions block loaded"] = await brief("b3");
  const record = await store.get(project);
  texts["brief, stale"] = renderBrief({
    projectPath: project,
    record: record && { ...record, updatedAt: "2020-01-01T00:00:00.000Z" },
    git,
    changes: null,
    minimalTools: tools === "minimal"
  });
  assert.match(texts["brief, stale"], /may be outdated/);
  if (exposed.includes("resume_task")) {
    const result = (await client.callTool({ name: "resume_task", arguments: { projectPath: project, agent: "claude" } })) as { content: { text: string }[] };
    texts["resume_task"] = result.content[0].text;
  }
  return { exposed, texts };
}

for (const profile of TOKEN_PROFILES) {
  test(`${profile}: everything the agent reads names only tools it has`, async () => {
    const { exposed, texts } = await agentTexts(profile);
    for (const [where, text] of Object.entries(texts)) {
      const missing = mentioned(text).filter((tool) => !exposed.includes(tool));
      assert.deepEqual(missing, [], `${profile}, ${where}`);
    }
  });
}

test("the instructions block holds for every profile: a tool not every profile has is named as 'where available'", () => {
  const minimal = tokenSettings({ profile: "minimal" }).tools;
  assert.equal(minimal, "minimal");
  for (const line of INSTRUCTIONS.split("\n")) {
    for (const tool of mentioned(line).filter((name) => name !== "log_progress")) {
      assert.match(line, new RegExp(`${tool}\\\`? \\(?where available`), `"${tool}" in: ${line}`);
    }
  }
  assert.match(INSTRUCTIONS, /otherwise `log_progress` with `task`/);
});
