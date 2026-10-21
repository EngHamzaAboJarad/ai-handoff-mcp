import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import {
  BLOCK_END,
  BLOCK_START,
  INSTRUCTIONS,
  OWN_HOOK_COMMAND,
  detectLaunchMode,
  initProject,
  chooseTokenProfile,
  serverCommand,
  toolCommand,
  upsertInstructions
} from "../src/init.js";
import { tempDir } from "./helpers.js";

const ENTRY = "C:\\tools\\ai-handoff-mcp\\dist\\src\\index.js";

async function readJson(file: string) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

const rel = (dir: string, file: string) => path.relative(dir, file).replace(/\\/g, "/");

test("serverCommand builds npx, global and local launch commands", () => {
  assert.deepEqual(serverCommand("npx", ENTRY, "linux"), {
    vscode: { command: "npx", args: ["-y", "ai-handoff-mcp"] },
    claude: { command: "npx", args: ["-y", "ai-handoff-mcp"] }
  });
  assert.deepEqual(serverCommand("npx", ENTRY, "win32").claude, { command: "cmd", args: ["/c", "npx", "-y", "ai-handoff-mcp"] });
  assert.deepEqual(serverCommand("global", ENTRY, "win32"), {
    vscode: { command: "ai-handoff-mcp", args: [] },
    claude: { command: "cmd", args: ["/c", "ai-handoff-mcp"] }
  });
  assert.deepEqual(serverCommand("local", ENTRY, "win32").vscode, { command: "node", args: ["C:/tools/ai-handoff-mcp/dist/src/index.js"] });
});

test("toolCommand builds the command hooks run", () => {
  assert.equal(toolCommand("npx", ENTRY), "npx -y ai-handoff-mcp");
  assert.equal(toolCommand("global", ENTRY), "ai-handoff-mcp");
  assert.equal(toolCommand("local", ENTRY), 'node "C:/tools/ai-handoff-mcp/dist/src/index.js"');
});

test("detectLaunchMode recognises how the package was installed", () => {
  assert.equal(detectLaunchMode("C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\ai-handoff-mcp\\dist\\src\\index.js"), "npx");
  assert.equal(detectLaunchMode("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\ai-handoff-mcp\\dist\\src\\index.js"), "global");
  assert.equal(detectLaunchMode("/usr/local/lib/node_modules/ai-handoff-mcp/dist/src/index.js"), "global");
  assert.equal(detectLaunchMode("/work/app/node_modules/ai-handoff-mcp/dist/src/index.js"), "npx");
  assert.equal(detectLaunchMode("C:\\dev\\ai-handoff-mcp\\dist\\src\\index.js"), "local");
});

test("init creates every config, hook and instructions file", async () => {
  const dir = await tempDir();
  const results = await initProject({ projectPath: dir, entryScript: ENTRY, mode: "npx", platform: "linux" });
  assert.deepEqual(
    results.map((result) => [rel(dir, result.file), result.action]),
    [
      [".vscode/mcp.json", "created"],
      [".mcp.json", "created"],
      ["CLAUDE.md", "created"],
      [".claude/settings.json", "created"],
      [".github/copilot-instructions.md", "created"],
      [".github/hooks/ai-handoff.json", "created"],
      ["AGENTS.md", "created"],
      [".ai-handoff.json", "created"]
    ]
  );
  assert.deepEqual((await readJson(path.join(dir, ".vscode", "mcp.json"))).servers["ai-handoff"], {
    type: "stdio",
    command: "npx",
    args: ["-y", "ai-handoff-mcp"]
  });
  assert.equal((await readJson(path.join(dir, ".mcp.json"))).mcpServers["ai-handoff"].command, "npx");
  for (const file of ["CLAUDE.md", "AGENTS.md", path.join(".github", "copilot-instructions.md")]) {
    const text = await fs.readFile(path.join(dir, file), "utf8");
    assert.ok(text.includes(BLOCK_START) && text.includes(BLOCK_END) && text.includes("resume_task"), file);
  }

  const claude = (await readJson(path.join(dir, ".claude", "settings.json"))).hooks;
  assert.deepEqual(Object.keys(claude), ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PreCompact", "Stop", "SessionEnd"]);
  assert.equal(claude.SessionStart[0].hooks[0].command, "npx -y ai-handoff-mcp hook session-start --agent claude");
  assert.equal(claude.UserPromptSubmit[0].hooks[0].command, "npx -y ai-handoff-mcp hook prompt-submit --agent claude");
  assert.equal(claude.PostToolUse[0].matcher, "Edit|Write|MultiEdit|NotebookEdit|Bash");
  assert.equal(claude.PostToolUse[0].hooks[0].type, "command");

  const vscode = (await readJson(path.join(dir, ".github", "hooks", "ai-handoff.json"))).hooks;
  assert.deepEqual(Object.keys(vscode), ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "Stop"]);
  assert.deepEqual(vscode.PostToolUse, [{ type: "command", command: "npx -y ai-handoff-mcp hook post-tool --agent copilot", timeout: 15 }]);
});

test("init is idempotent", async () => {
  const dir = await tempDir();
  await initProject({ projectPath: dir, entryScript: ENTRY, mode: "npx" });
  const again = await initProject({ projectPath: dir, entryScript: ENTRY, mode: "npx" });
  assert.ok(again.every((result) => result.action === "unchanged"), JSON.stringify(again));
  const claude = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8");
  assert.equal(claude.split(BLOCK_START).length, 2, "block written once");
});

test("Claude hooks keep the user's own hooks and replace older ai-handoff ones", async () => {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, ".claude"));
  await fs.writeFile(
    path.join(dir, ".claude", "settings.json"),
    JSON.stringify({
      permissions: { allow: ["Bash(npm test)"] },
      hooks: { PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "prettier --write" }] }] }
    })
  );
  await initProject({ projectPath: dir, entryScript: ENTRY, mode: "local", targets: ["claude-hooks"] });
  await initProject({ projectPath: dir, entryScript: ENTRY, mode: "global", targets: ["claude-hooks"] });
  const settings = await readJson(path.join(dir, ".claude", "settings.json"));
  assert.deepEqual(settings.permissions, { allow: ["Bash(npm test)"] });
  const post = settings.hooks.PostToolUse;
  assert.equal(post.length, 2, "user hook + one ai-handoff hook, the local one was replaced");
  assert.equal(post[0].hooks[0].command, "prettier --write");
  assert.equal(post[1].hooks[0].command, "ai-handoff-mcp hook post-tool --agent claude");
  assert.equal(settings.hooks.SessionStart.length, 1);
});

test("OWN_HOOK_COMMAND recognises only this tool's hook commands", () => {
  assert.ok(OWN_HOOK_COMMAND.test('node "C:/x/index.js" hook post-tool --agent claude'));
  assert.ok(OWN_HOOK_COMMAND.test("npx -y ai-handoff-mcp hook session-start --agent copilot"));
  assert.ok(OWN_HOOK_COMMAND.test("ai-handoff-mcp hook prompt-submit --agent claude --gate warn"));
  assert.ok(!OWN_HOOK_COMMAND.test("prettier --write"));
  assert.ok(!OWN_HOOK_COMMAND.test("git hook post-tool"));
});

test("VS Code hooks keep the user's own hooks in the same file", async () => {
  const dir = await tempDir();
  const file = path.join(dir, ".github", "hooks", "ai-handoff.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ hooks: { Stop: [{ type: "command", command: "./mine.sh" }] } }));
  const [result] = await initProject({ projectPath: dir, entryScript: ENTRY, mode: "npx", targets: ["copilot-hooks"] });
  assert.equal(result.action, "updated");
  // Ours can always be refreshed, e.g. after switching launch mode, without duplicating.
  await initProject({ projectPath: dir, entryScript: ENTRY, mode: "global", targets: ["copilot-hooks"] });
  const stop = (await readJson(file)).hooks.Stop;
  assert.deepEqual(
    stop.map((hook: { command: string }) => hook.command),
    ["./mine.sh", "ai-handoff-mcp hook stop --agent copilot"]
  );
});

test("Cursor: MCP config and version 1 hooks", async () => {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, ".cursor"));
  await fs.writeFile(path.join(dir, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: "prettier" }] } }));
  await initProject({ projectPath: dir, entryScript: ENTRY, mode: "npx", targets: ["cursor"] });
  assert.equal((await readJson(path.join(dir, ".cursor", "mcp.json"))).mcpServers["ai-handoff"].command, "npx");
  const hooks = await readJson(path.join(dir, ".cursor", "hooks.json"));
  assert.equal(hooks.version, 1);
  assert.deepEqual(Object.keys(hooks.hooks), ["afterFileEdit", "sessionStart", "beforeSubmitPrompt", "preToolUse", "postToolUseFailure", "preCompact", "stop", "sessionEnd"]);
  assert.deepEqual(hooks.hooks.afterFileEdit, [{ command: "prettier" }, { command: "npx -y ai-handoff-mcp hook post-tool --agent cursor" }]);
  assert.deepEqual(hooks.hooks.beforeSubmitPrompt, [{ command: "npx -y ai-handoff-mcp hook prompt-submit --agent cursor" }]);
});

test("Gemini CLI: MCP server, millisecond-timeout hooks and GEMINI.md", async () => {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, ".gemini"));
  await fs.writeFile(path.join(dir, ".gemini", "settings.json"), JSON.stringify({ theme: "dark" }));
  await initProject({ projectPath: dir, entryScript: ENTRY, mode: "npx", targets: ["gemini"] });
  const settings = await readJson(path.join(dir, ".gemini", "settings.json"));
  assert.equal(settings.theme, "dark");
  assert.deepEqual(settings.mcpServers["ai-handoff"], { command: "npx", args: ["-y", "ai-handoff-mcp"] });
  assert.deepEqual(Object.keys(settings.hooks), ["SessionStart", "BeforeAgent", "BeforeTool", "AfterTool", "PreCompress", "AfterAgent", "SessionEnd"]);
  assert.equal(settings.hooks.BeforeAgent[0].hooks[0].command, "npx -y ai-handoff-mcp hook prompt-submit --agent gemini");
  assert.equal(settings.hooks.BeforeAgent[0].hooks[0].timeout, 10000);
  assert.equal(settings.hooks.AfterTool[0].matcher, "*");
  assert.match(await fs.readFile(path.join(dir, "GEMINI.md"), "utf8"), /resume_task/);
});

test("Windsurf: hooks with a PowerShell command, in .devin when that file exists", async () => {
  const dir = await tempDir();
  await initProject({ projectPath: dir, entryScript: ENTRY, mode: "global", targets: ["windsurf"] });
  const hooks = (await readJson(path.join(dir, ".windsurf", "hooks.json"))).hooks;
  assert.deepEqual(Object.keys(hooks), [
    "pre_user_prompt",
    "pre_run_command",
    "pre_write_code",
    "pre_read_code",
    "pre_mcp_tool_use",
    "post_write_code",
    "post_run_command",
    "post_cascade_response"
  ]);
  assert.deepEqual(hooks.pre_user_prompt, [
    { command: "ai-handoff-mcp hook prompt-submit --agent windsurf", powershell: "ai-handoff-mcp hook prompt-submit --agent windsurf" }
  ]);

  const devin = await tempDir();
  await fs.mkdir(path.join(devin, ".devin"));
  await fs.writeFile(path.join(devin, ".devin", "hooks.json"), JSON.stringify({ hooks: {} }));
  await initProject({ projectPath: devin, entryScript: ENTRY, mode: "global", targets: ["windsurf"] });
  assert.ok((await readJson(path.join(devin, ".devin", "hooks.json"))).hooks.post_write_code);
  await assert.rejects(fs.access(path.join(devin, ".windsurf")));
});

test("init adds other agents only when the project already uses them", async () => {
  const dir = await tempDir();
  const plain = await initProject({ projectPath: dir, entryScript: ENTRY, mode: "npx" });
  assert.ok(!plain.some((result) => /\.cursor|\.gemini|\.windsurf/.test(result.file)));
  await fs.mkdir(path.join(dir, ".cursor"));
  await fs.writeFile(path.join(dir, "GEMINI.md"), "# notes\n");
  const detected = await initProject({ projectPath: dir, entryScript: ENTRY, mode: "npx" });
  const files = detected.map((result) => rel(dir, result.file));
  assert.ok(files.includes(".cursor/hooks.json"));
  assert.ok(files.includes(".gemini/settings.json"));
  assert.ok(!files.some((file) => file.startsWith(".windsurf")));
});

test("init keeps other servers and existing instructions", async () => {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, ".vscode"));
  await fs.writeFile(path.join(dir, ".vscode", "mcp.json"), JSON.stringify({ inputs: [], servers: { other: { command: "x" } } }));
  await fs.writeFile(path.join(dir, "CLAUDE.md"), "# My rules\n\n- be nice\n");
  const results = await initProject({ projectPath: dir, entryScript: ENTRY, mode: "local", targets: ["vscode", "claude"] });
  assert.equal(results.find((result) => rel(dir, result.file) === ".vscode/mcp.json")?.action, "updated");
  const config = await readJson(path.join(dir, ".vscode", "mcp.json"));
  assert.deepEqual(config.servers.other, { command: "x" });
  assert.deepEqual(config.inputs, []);
  assert.equal(config.servers["ai-handoff"].command, "node");
  const claude = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8");
  assert.ok(claude.startsWith("# My rules\n\n- be nice\n\n" + BLOCK_START));
  await assert.rejects(fs.access(path.join(dir, "AGENTS.md")), "only selected targets are written");
});

test("init does not replace a different server entry without force", async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { "ai-handoff": { command: "custom" } } }));
  const [config] = (await initProject({ projectPath: dir, entryScript: ENTRY, mode: "npx", targets: ["claude"] })).filter((r) =>
    r.file.endsWith(".mcp.json")
  );
  assert.equal(config.action, "skipped");
  assert.match(config.reason ?? "", /--force/);
  assert.equal((await readJson(path.join(dir, ".mcp.json"))).mcpServers["ai-handoff"].command, "custom");

  await initProject({ projectPath: dir, entryScript: ENTRY, mode: "npx", targets: ["claude"], force: true, platform: "linux" });
  assert.equal((await readJson(path.join(dir, ".mcp.json"))).mcpServers["ai-handoff"].command, "npx");
});

test("init leaves JSON-with-comments files alone and explains what to add", async () => {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, ".vscode"));
  const original = '{\n  // my servers\n  "servers": {}\n}\n';
  await fs.writeFile(path.join(dir, ".vscode", "mcp.json"), original);
  const [result] = await initProject({ projectPath: dir, entryScript: ENTRY, mode: "npx", targets: ["vscode"] });
  assert.equal(result.action, "skipped");
  assert.match(result.reason ?? "", /"ai-handoff"/);
  assert.equal(await fs.readFile(path.join(dir, ".vscode", "mcp.json"), "utf8"), original);
});

test("init supports Cursor", async () => {
  const dir = await tempDir();
  await initProject({ projectPath: dir, entryScript: ENTRY, mode: "npx", targets: ["cursor"] });
  assert.equal((await readJson(path.join(dir, ".cursor", "mcp.json"))).mcpServers["ai-handoff"].command, "npx");
});

test("init rejects a missing project directory", async () => {
  const dir = await tempDir();
  await assert.rejects(initProject({ projectPath: path.join(dir, "missing"), entryScript: ENTRY }), /not a directory/);
});

test("upsertInstructions refreshes an outdated block in place", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "AGENTS.md");
  await fs.writeFile(file, `before\n${BLOCK_START}\nold text\n${BLOCK_END}\nafter\n`);
  assert.equal((await upsertInstructions(file)).action, "updated");
  assert.equal(await fs.readFile(file, "utf8"), `before\n${INSTRUCTIONS}\nafter\n`);
  assert.equal((await upsertInstructions(file)).action, "unchanged");
});

test("token profile: the smallest one every configured host supports", () => {
  const choose = (...targets: string[]) => chooseTokenProfile(new Set(targets as never[])).profile;
  assert.equal(choose("vscode", "claude", "claude-hooks", "copilot", "copilot-hooks", "agents"), "lean", "default targets: Visual Studio may read .vscode/mcp.json");
  assert.equal(choose("claude", "claude-hooks"), "minimal");
  assert.equal(choose("claude", "claude-hooks", "cursor", "gemini", "agents"), "minimal");
  assert.equal(choose("claude"), "lean", "Claude Code without hooks needs resume_task");
  assert.equal(choose("cursor", "windsurf"), "lean", "Windsurf cannot inject the brief");
  assert.equal(choose("agents"), "lean", "no host injects the brief");
});

test("init writes the token profile with the default brief budget, keeps other settings, and never overrides a choice", async () => {
  const dir = await tempDir();
  const config = () => readJson(path.join(dir, ".ai-handoff.json"));
  await fs.writeFile(path.join(dir, ".ai-handoff.json"), JSON.stringify({ promptGate: { mode: "warn" } }));
  const first = await initProject({ projectPath: dir, entryScript: ENTRY, mode: "global", targets: ["claude", "claude-hooks"] });
  const written = first.find((result) => result.file.endsWith(".ai-handoff.json"));
  assert.equal(written?.action, "updated");
  assert.match(written?.reason ?? "", /token profile "minimal": every configured host injects the brief/);
  assert.deepEqual(await config(), { promptGate: { mode: "warn" }, tokens: { profile: "minimal", briefChars: 6000 } }, "brief quality unchanged");

  const again = await initProject({ projectPath: dir, entryScript: ENTRY, mode: "global", targets: ["vscode"] });
  assert.match(again.find((result) => result.file.endsWith(".ai-handoff.json"))?.reason ?? "", /"minimal" kept/);
  assert.equal((await config()).tokens.profile, "minimal", "a profile already set is the user's choice");

  await initProject({ projectPath: dir, entryScript: ENTRY, mode: "global", targets: ["vscode"], tokens: "standard" });
  assert.deepEqual((await config()).tokens, { profile: "standard", briefChars: 6000 }, "--tokens is explicit");

  await fs.writeFile(path.join(dir, ".ai-handoff.json"), "{ // comment\n}");
  const skipped = await initProject({ projectPath: dir, entryScript: ENTRY, mode: "global", targets: ["claude"] });
  assert.equal(skipped.find((result) => result.file.endsWith(".ai-handoff.json"))?.action, "skipped");
  assert.equal(await fs.readFile(path.join(dir, ".ai-handoff.json"), "utf8"), "{ // comment\n}", "a file with comments is left alone");
});
