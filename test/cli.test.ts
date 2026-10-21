import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { HELP, parseArgs, runCli } from "../src/cli.js";
import { HandoffStore, emptyFields } from "../src/storage.js";
import { SERVER_VERSION } from "../src/server.js";
import { tempProject } from "./helpers.js";

function io(cwd: string) {
  const captured = { out: "", err: "" };
  return {
    captured,
    io: { cwd, out: (text: string) => void (captured.out += text), err: (text: string) => void (captured.err += text) }
  };
}

test("parseArgs reads commands, positionals and flags", () => {
  const parsed = parseArgs(["init", "./app", "--only", "vscode,claude", "--force", "--target=copilot", "-h"]);
  assert.equal(parsed.command, "init");
  assert.deepEqual(parsed.positional, ["./app"]);
  assert.equal(parsed.flags.get("only"), "vscode,claude");
  assert.equal(parsed.flags.get("force"), true);
  assert.equal(parsed.flags.get("target"), "copilot");
  assert.equal(parsed.flags.get("help"), true);
});

test("no command (or serve) means start the server", async () => {
  const { project } = await tempProject();
  assert.equal(await runCli([], io(project).io), null);
  assert.equal(await runCli(["serve"], io(project).io), null);
});

test("--help and --version print to stdout", async () => {
  const { project } = await tempProject();
  const help = io(project);
  assert.equal(await runCli(["--help"], help.io), 0);
  assert.equal(help.captured.out, HELP);
  const version = io(project);
  assert.equal(await runCli(["--version"], version.io), 0);
  assert.equal(version.captured.out.trim(), SERVER_VERSION);
});

test("unknown commands fail with exit code 2", async () => {
  const { project } = await tempProject();
  const run = io(project);
  assert.equal(await runCli(["frobnicate"], run.io), 2);
  assert.match(run.captured.err, /Unknown command: frobnicate/);
});

test("init writes files relative to the working directory", async () => {
  const { project } = await tempProject();
  const run = io(path.dirname(project));
  assert.equal(await runCli(["init", "project", "--mode", "local", "--only", "vscode"], run.io), 0);
  assert.match(run.captured.out, /created\s+\.vscode[\\/]mcp\.json/);
  const config = JSON.parse(await fs.readFile(path.join(project, ".vscode", "mcp.json"), "utf8"));
  assert.equal(config.servers["ai-handoff"].command, "node");
  assert.match(config.servers["ai-handoff"].args[0], /index\.js$/);
});

test("init rejects bad flags", async () => {
  const { project } = await tempProject();
  const mode = io(project);
  assert.equal(await runCli(["init", "--mode", "docker"], mode.io), 1);
  assert.match(mode.captured.err, /--mode must be one of: npx, global, local/);
  const bad = io(project);
  assert.equal(await runCli(["init", "--only", "vscode,emacs"], bad.io), 1);
  assert.match(bad.captured.err, /Unknown target\(s\): emacs/);
});

test("show and prompt print the brief for a project", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  await store.write(project, () => ({ ...emptyFields(), task: "Refactor API", nextSteps: ["Split routes"] }), {
    agent: "claude",
    message: "saved"
  });
  const show = io(project);
  assert.equal(await runCli(["show"], show.io, store), 0);
  assert.match(show.captured.out, /## Task\nRefactor API/);
  assert.match(show.captured.out, /1\. Split routes/);

  const prompt = io(project);
  assert.equal(await runCli(["prompt", ".", "--target", "cursor"], prompt.io, store), 0);
  assert.match(prompt.captured.out, /^You are Cursor taking over/);
  assert.equal((await store.get(project))?.log.length, 1, "show/prompt do not write to the timeline");
});

test("hook reads stdin, records the event and always exits 0", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  const run = io(project);
  const stdin = JSON.stringify({ cwd: project, tool_name: "Write", tool_input: { file_path: path.join(project, "a.ts") } });
  assert.equal(await runCli(["hook", "post-tool", "--agent", "claude"], { ...run.io, readStdin: async () => stdin }, store), 0);
  assert.equal(run.captured.out, "");
  assert.deepEqual((await store.get(project))?.auto?.touchedFiles, ["a.ts"]);

  const bad = io(project);
  assert.equal(await runCli(["hook", "explode"], bad.io, store), 0);
  assert.match(bad.captured.err, /hook needs an event/);

  // A broken data directory must not break the agent's session either.
  await fs.writeFile(store.filePath(project), "garbage");
  const broken = io(project);
  assert.equal(await runCli(["hook", "stop", "--agent", "claude"], { ...broken.io, readStdin: async () => "{}" }, store), 0);
  assert.match(broken.captured.err, /ai-handoff hook stop failed: .*not valid JSON/);
});

test("show --full prints everything", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  const completed = Array.from({ length: 30 }, (_, i) => `step ${i}`);
  await store.write(project, () => ({ ...emptyFields(), task: "Big", completed }), { agent: "claude", message: "saved" });
  const compact = io(project);
  await runCli(["show"], compact.io, store);
  assert.doesNotMatch(compact.captured.out, /- step 0\n/);
  assert.match(compact.captured.out, /… 24 earlier/);
  const full = io(project);
  await runCli(["show", "--full"], full.io, store);
  assert.match(full.captured.out, /- step 0\n/);
});

test("init warns when hooks would start through npx, and not with a global install", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  const npx = io(project);
  assert.equal(await runCli(["init", "--mode", "npx", "--only", "claude-hooks"], npx.io, store), 0);
  assert.match(npx.captured.out, /hooks will start through npx, which adds about/);
  assert.match(npx.captured.out, /npm install -g ai-handoff-mcp && ai-handoff-mcp init --mode global/);
  const global = io(project);
  assert.equal(await runCli(["init", "--mode", "global", "--only", "claude-hooks", "--force"], global.io, store), 0);
  assert.doesNotMatch(global.captured.out, /through npx/);
});

test("export and clear: the CLI side of the tools lean and minimal hide", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  const run = async (...args: string[]) => {
    const captured = io(project);
    const code = await runCli(args, captured.io, store);
    return { code, ...captured.captured };
  };
  assert.equal((await run("export")).code, 1, "nothing to export yet");
  await store.write(project, () => ({ ...emptyFields(), task: "Add login" }), { agent: "claude", message: "saved" });
  assert.equal((await run("export")).code, 0);
  assert.match(await fs.readFile(path.join(project, "HANDOFF.md"), "utf8"), /Add login/);
  assert.match((await run("export")).err, /already exists/);
  assert.equal((await run("export", "--overwrite")).code, 0);

  assert.match((await run("clear")).err, /--yes/);
  assert.ok(await store.get(project), "not deleted without --yes");
  assert.match((await run("clear", "--yes")).out, /Checkpoint deleted/);
  assert.equal(await store.get(project), null);
});

test("init --tokens validates the profile", async () => {
  const { project, dataDir } = await tempProject();
  const bad = io(project);
  assert.equal(await runCli(["init", "--tokens", "tiny", "--only", "claude"], bad.io, new HandoffStore(dataDir)), 1);
  assert.match(bad.captured.err, /--tokens must be one of: standard, lean, minimal/);
});
