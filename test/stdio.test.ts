// Runs the built server (dist/) as a real child process over stdio, the way VS Code and Claude Code start it.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { toolCommand } from "../src/init.js";
import { HandoffStore } from "../src/storage.js";
import { tempProject } from "./helpers.js";

const ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "src", "index.js");

test("built server works over stdio and keeps stdout for the protocol", async () => {
  await fs.access(ENTRY).catch(() => {
    throw new Error(`Build output missing at ${ENTRY}; run "npm run build" first (npm test does this).`);
  });
  const { project, dataDir } = await tempProject();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: { ...(process.env as Record<string, string>), AI_HANDOFF_DATA_DIR: dataDir },
    stderr: "pipe"
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => (stderr += chunk));
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    assert.equal(client.getServerVersion()?.name, "ai-handoff-mcp");
    assert.equal((await client.listTools()).tools.length, 9);

    const saved = (await client.callTool({
      name: "save_handoff",
      arguments: { projectPath: project, agent: "claude", task: "stdio task", nextSteps: ["step one"] }
    })) as { isError?: boolean; content: { text: string }[] };
    assert.ok(!saved.isError, saved.content[0].text);

    const resumed = (await client.callTool({ name: "resume_task", arguments: { projectPath: project, agent: "copilot" } })) as {
      content: { text: string }[];
    };
    assert.match(resumed.content[0].text, /stdio task/);
    assert.match(resumed.content[0].text, /1\. step one/);
    // The checkpoint and its usage counters (for `ai-handoff-mcp stats`), nothing else.
    const written = (await fs.readdir(dataDir)).filter((file) => file.endsWith(".json")).sort();
    assert.equal(written.length, 2, "data written to AI_HANDOFF_DATA_DIR");
    assert.match(written.join(" "), /^[0-9a-f]+\.json [0-9a-f]+\.stats\.json$/);
  } finally {
    await client.close();
  }
  assert.doesNotMatch(stderr, /Error/);
});

/** Runs a command line through a shell with JSON on stdin, the way Claude Code and VS Code run hook commands. */
function runShell(command: string, stdin: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, env: { ...(process.env as Record<string, string>), ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

test("hook commands written by init work as real shell commands", async () => {
  const { project, dataDir } = await tempProject();
  const base = toolCommand("local", ENTRY);
  const env = { AI_HANDOFF_DATA_DIR: dataDir };
  const edit = JSON.stringify({
    session_id: "s",
    transcript_path: path.join(project, "never-read.jsonl"),
    cwd: project,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: path.join(project, "src", "app.ts") }
  });
  const post = await runShell(`${base} hook post-tool --agent claude`, edit, env);
  assert.deepEqual({ code: post.code, stdout: post.stdout, stderr: post.stderr }, { code: 0, stdout: "", stderr: "" });

  const store = new HandoffStore(dataDir);
  await store.write(project, (current) => ({ ...current, task: "Shell task" }), { agent: "claude", message: "saved" });
  const start = await runShell(`${base} hook session-start --agent copilot`, JSON.stringify({ cwd: project, source: "startup" }), env);
  assert.equal(start.code, 0, start.stderr);
  const output = JSON.parse(start.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /## Task\nShell task/);

  // Hooks must not block or fail the host even with garbage input.
  const garbage = await runShell(`${base} hook stop --agent claude`, "{{{", env);
  assert.equal(garbage.code, 0);
});

test("prompt gate as a real shell command: JSON for Claude, exit code 2 for Windsurf", async () => {
  const { project, dataDir } = await tempProject();
  const base = toolCommand("local", ENTRY);
  const env = { AI_HANDOFF_DATA_DIR: dataDir };
  const claude = await runShell(`${base} hook prompt-submit --agent claude`, JSON.stringify({ cwd: project, session_id: "a", prompt: "fix it" }), env);
  assert.equal(claude.code, 0);
  assert.equal(JSON.parse(claude.stdout).decision, "block");

  const windsurf = await runShell(
    `${base} hook prompt-submit --agent windsurf`,
    JSON.stringify({ agent_action_name: "pre_user_prompt", tool_info: { user_prompt: "رتب كل المشروع" } }),
    env
  );
  assert.equal(windsurf.code, 2);
  assert.match(windsurf.stderr, /ما انصرف أي كريدت/);

  const check = await runShell(`${base} check-prompt "fix it"`, "", env);
  assert.equal(check.code, 1);
  assert.match(check.stdout, /^block \(vagueness \d+\/100\)/);
});

test("loop guard as a real shell command: deny, then stop", async () => {
  const { project, dataDir } = await tempProject();
  const command = `${toolCommand("local", ENTRY)} hook pre-tool --agent claude`;
  const env = { AI_HANDOFF_DATA_DIR: dataDir };
  const call = JSON.stringify({ cwd: project, session_id: "s", tool_name: "Bash", tool_input: { command: "npm test" } });
  const outputs = [];
  for (let i = 0; i < 4; i++) outputs.push(await runShell(command, call, env));
  assert.deepEqual(outputs.map((o) => o.code), [0, 0, 0, 0]);
  assert.equal(outputs[1].stdout, "");
  assert.equal(JSON.parse(outputs[2].stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(JSON.parse(outputs[3].stdout).continue, false);
});

test("built CLI prints help and version", () => {
  const help = execFileSync(process.execPath, [ENTRY, "--help"], { encoding: "utf8" });
  assert.match(help, /ai-handoff-mcp init \[dir\]/);
  const version = execFileSync(process.execPath, [ENTRY, "--version"], { encoding: "utf8" }).trim();
  const pkg = JSON.parse(execFileSync(process.execPath, ["-e", "process.stdout.write(require('fs').readFileSync('package.json','utf8'))"], {
    encoding: "utf8",
    cwd: path.resolve(path.dirname(ENTRY), "..", "..")
  }));
  assert.equal(version, pkg.version, "SERVER_VERSION matches package.json");
});
