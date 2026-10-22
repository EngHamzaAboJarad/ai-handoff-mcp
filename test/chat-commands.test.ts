// @handoff in every agent's chat through the prompt-submit hook, in each host's own format.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { runHook, type Host } from "../src/hooks.js";
import { HandoffStore, emptyFields } from "../src/storage.js";
import { CONTINUE_PROMPT, parseHandoffCommand } from "../src/chat.js";
import { tempProject } from "./helpers.js";

async function setup() {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  await store.write(project, () => ({ ...emptyFields(), task: "Add login", currentStep: "Form", nextSteps: ["Validation", "Tests"] }), {
    agent: "claude",
    message: "saved"
  });
  const send = (prompt: string, host: Host = "claude", session = "s1") =>
    runHook("prompt-submit", host, JSON.stringify({ cwd: project, session_id: session, prompt }), { store, env: {}, host });
  return { project, store, send };
}

/** The text each host shows the user for a prompt the hook answered itself. */
function shown(host: Host, result: { stdout: string; stderr?: string; exitCode?: number }): string {
  if (host === "windsurf") return result.stderr ?? "";
  const out = JSON.parse(result.stdout);
  return out.reason ?? out.stopReason ?? out.user_message ?? "";
}

test("parseHandoffCommand reads commands, questions and help, and ignores other prompts", () => {
  assert.deepEqual(parseHandoffCommand("@handoff /status"), { command: "status", rest: "" });
  assert.deepEqual(parseHandoffCommand("  @HANDOFF /Check fix it"), { command: "check", rest: "fix it" });
  assert.deepEqual(parseHandoffCommand("@handoff"), { command: "help", rest: "" });
  assert.deepEqual(parseHandoffCommand("@handoff شو ضايل؟"), { command: null, rest: "شو ضايل؟" });
  assert.deepEqual(parseHandoffCommand("@handoff /unknown thing"), { command: null, rest: "/unknown thing" }, "an unknown command reads as a question");
  assert.equal(parseHandoffCommand("fix the @handoff bug"), null);
  assert.equal(parseHandoffCommand("@handoffs /status"), null);
});

test("/status, /resume, /check and /help are answered by the hook in every host's format, and never reach the model", async () => {
  for (const host of ["claude", "vscode", "cursor", "gemini", "windsurf", "generic"] as Host[]) {
    const { send } = await setup();
    const status = await send("@handoff /status", host);
    assert.match(shown(host, status), /Task: Add login[\s\S]*Next: Validation \(\+1 more\)/, `${host} /status`);
    assert.doesNotMatch(shown(host, status), /\*\*|\|---/, `${host}: plain text, no Markdown`);
    assert.match(shown(host, await send("@handoff /resume", host)), /## Was doing when stopped\nForm/, `${host} /resume`);
    const check = shown(host, await send("@handoff /check صلحها", host));
    assert.match(check, /^@handoff \/check: what the prompt gate would say:/, `${host}: reads as a rating, not as a stopped prompt`);
    assert.match(check, /قوة البرومبت: 10\/100/, `${host} /check`);
    assert.match(shown(host, await send("@handoff", host)), /@handoff \/resume[\s\S]*@handoff \/continue/, `${host} help`);
    if (host === "windsurf" || host === "generic") assert.equal(status.exitCode, 2, `${host}: exit code 2 keeps the prompt from the model`);
  }
});

test("local answers are not counted as prompts the gate stopped, and work with the gate off", async () => {
  const { project, store, send } = await setup();
  await send("@handoff /status");
  await send("@handoff /check fix it");
  const prompts = await store.getPromptState(project);
  assert.deepEqual([prompts.allowed, prompts.blocked], [0, 0]);
  await fs.writeFile(path.join(project, ".ai-handoff.json"), JSON.stringify({ promptGate: { mode: "off" } }));
  assert.match(shown("claude", await send("@handoff /status")), /Task: Add login/);
});

test("/continue and questions go to the model with the brief as context; Cursor and Windsurf say why they cannot", async () => {
  const { project, store, send } = await setup();
  const cont = JSON.parse((await send("@handoff /continue")).stdout);
  assert.equal(cont.decision, undefined, "not blocked: the agent does the work");
  assert.equal(cont.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.ok(cont.hookSpecificOutput.additionalContext.startsWith(CONTINUE_PROMPT));
  assert.match(cont.hookSpecificOutput.additionalContext, /## Task\nAdd login/);

  const question = JSON.parse((await send("@handoff شو ضايل؟", "gemini")).stdout);
  assert.equal(question.hookSpecificOutput.hookEventName, "BeforeAgent");
  assert.match(question.hookSpecificOutput.additionalContext, /Answer from the handoff brief[\s\S]*## Task\nAdd login/);
  assert.equal((await store.getPromptState(project)).allowed, 2, "a prompt that reaches the model counts as one");

  for (const host of ["cursor", "windsurf"] as Host[]) {
    assert.match(shown(host, await send("@handoff /continue", host)), /cannot receive the brief from a hook/, host);
  }
});

test("a vague prompt that only mentions @handoff later is still screened by the gate", async () => {
  const { send } = await setup();
  assert.match((await send("fix it @handoff", "claude", "new")).stdout, /stopped this prompt before it reached the model/);
});
