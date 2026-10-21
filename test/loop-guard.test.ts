import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentMessage,
  callSignature,
  checkCall,
  DEFAULT_GUARD,
  editPair,
  isChangingCommand,
  newSession,
  noteResult,
  onUserPrompt,
  userMessage,
  type CallInfo,
  type GuardConfig,
  type GuardSession
} from "../src/loop-guard.js";

const NOW = "2026-01-01T00:00:00.000Z";
const bash = (command: string, extra: Record<string, unknown> = {}): CallInfo => ({ tool: "Bash", input: { command, ...extra }, isEdit: false });
const edit = (file: string, from: string, to: string): CallInfo => ({
  tool: "Edit",
  input: { file_path: file, old_string: from, new_string: to },
  isEdit: true
});
const read = (file: string): CallInfo => ({ tool: "Read", input: { file_path: file }, isEdit: false });

/** Runs calls in order and returns each decision's action (and rule when not allowed). */
function run(calls: CallInfo[], config: GuardConfig = DEFAULT_GUARD, start: GuardSession = newSession(NOW)) {
  let session = start;
  const actions: string[] = [];
  for (const call of calls) {
    const checked = checkCall(session, call, config, NOW);
    session = checked.session;
    actions.push(checked.decision.action === "allow" ? "allow" : `${checked.decision.action}:${checked.decision.rule}`);
  }
  return { actions, session };
}

test("callSignature ignores volatile arguments and key order", () => {
  assert.equal(callSignature("Bash", { command: "npm test", description: "a" }), callSignature("bash", { description: "b", command: " npm test " }));
  assert.equal(callSignature("Bash", { command: "npm test", timeout: 1 }), callSignature("Bash", { command: "npm test" }));
  assert.notEqual(callSignature("Bash", { command: "npm test" }), callSignature("Bash", { command: "npm run lint" }));
  assert.notEqual(callSignature("Read", { file_path: "a", offset: 1 }), callSignature("Read", { file_path: "a", offset: 2 }));
});

test("isChangingCommand recognises commands that change state", () => {
  for (const command of ["git commit -m x", "git add .", "npm install", "pip install x", "echo hi > out.txt", "rm -rf build", "mkdir dist", "sed -i s/a/b/ f"]) {
    assert.ok(isChangingCommand(command), command);
  }
  for (const command of ["npm test", "git status", "git diff", "ls -la", "cat a.ts", "pytest -q", "grep -r foo ."]) {
    assert.ok(!isChangingCommand(command), command);
  }
});

test("repeat: the third identical call with nothing changed is denied, the next one stops the agent", () => {
  const { actions, session } = run([bash("npm test"), bash("npm test"), bash("npm test"), bash("npm test"), bash("ls")]);
  assert.deepEqual(actions, ["allow", "allow", "deny:repeat", "stop:repeat", "deny:halted"]);
  assert.equal(session.stops, 1);
  assert.equal(session.halted, true);
});

test("repeat: an edit between runs is a normal fix-and-test cycle", () => {
  const { actions } = run([
    bash("npm test"),
    edit("a.ts", "1", "2"),
    bash("npm test"),
    edit("a.ts", "2", "3"),
    bash("npm test"),
    edit("b.ts", "x", "y"),
    bash("npm test")
  ]);
  assert.ok(actions.every((action) => action === "allow"), actions.join());
});

test("repeat: state-changing commands count as changes", () => {
  const { actions } = run([bash("git status"), bash("git add ."), bash("git status"), bash("git commit -m x"), bash("git status")]);
  assert.ok(actions.every((action) => action === "allow"), actions.join());
});

test("repeat: re-reading the same file with nothing changed is caught too", () => {
  assert.deepEqual(run([read("a.ts"), read("a.ts"), read("a.ts")]).actions, ["allow", "allow", "deny:repeat"]);
});

test("repeat: the identical edit applied again and again is caught", () => {
  const same = edit("a.ts", "foo", "bar");
  assert.deepEqual(run([same, same, same]).actions, ["allow", "allow", "deny:repeat"]);
});

test("ping-pong: undoing and redoing the same edit is denied, then stopped", () => {
  const { actions } = run([edit("a.ts", "A", "B"), edit("a.ts", "B", "A"), edit("a.ts", "A", "B"), edit("a.ts", "B", "A")]);
  assert.deepEqual(actions, ["allow", "allow", "deny:ping-pong", "stop:ping-pong"]);
});

test("ping-pong: one revert is fine, and different files do not interfere", () => {
  const { actions } = run([edit("a.ts", "A", "B"), edit("a.ts", "B", "A"), edit("b.ts", "A", "B"), edit("b.ts", "B", "C")]);
  assert.ok(actions.every((action) => action === "allow"), actions.join());
});

test("editPair handles multi-edit shapes", () => {
  const single = editPair({ file_path: "a", old_string: "x", new_string: "y" });
  const reverse = editPair({ file_path: "a", old_string: "y", new_string: "x" });
  assert.equal(single?.rev, reverse?.fwd);
  const multi = editPair({ file_path: "a", edits: [{ old_string: "1", new_string: "2" }, { old_string: "3", new_string: "4" }] });
  const undo = editPair({ file_path: "a", edits: [{ old_string: "4", new_string: "3" }, { old_string: "2", new_string: "1" }] });
  assert.equal(multi?.rev, undo?.fwd);
  assert.equal(editPair({ file_path: "a", content: "x" }), null);
});

test("failing: the same command failing failLimit times despite edits is denied, then stopped", () => {
  let session = newSession(NOW);
  const test = bash("npm test");
  for (let i = 0; i < DEFAULT_GUARD.failLimit; i++) {
    session = checkCall(session, test, DEFAULT_GUARD, NOW).session;
    const noted = noteResult(session, test, true, DEFAULT_GUARD);
    session = noted.session;
    assert.equal(noted.failingNow, i === DEFAULT_GUARD.failLimit - 1, `failure ${i + 1}`);
    session = checkCall(session, edit("a.ts", `v${i}`, `v${i + 1}`), DEFAULT_GUARD, NOW).session;
  }
  const denied = checkCall(session, test, DEFAULT_GUARD, NOW);
  assert.equal(denied.decision.action, "deny");
  assert.equal(denied.decision.rule, "failing");
  assert.equal(checkCall(denied.session, test, DEFAULT_GUARD, NOW).decision.action, "stop");
});

test("failing: a success resets the failure count", () => {
  let session = newSession(NOW);
  const test = bash("npm test");
  for (let i = 0; i < DEFAULT_GUARD.failLimit - 1; i++) session = noteResult(session, test, true, DEFAULT_GUARD).session;
  session = noteResult(session, test, false, DEFAULT_GUARD).session;
  assert.equal(noteResult(session, test, true, DEFAULT_GUARD).failingNow, false);
});

test("runaway: more tool calls in one turn than the budget stops the agent", () => {
  const config = { ...DEFAULT_GUARD, turnBudget: 5 };
  const calls = Array.from({ length: 6 }, (_, i) => read(`f${i}.ts`));
  assert.deepEqual(run(calls, config).actions, ["allow", "allow", "allow", "allow", "allow", "stop:runaway"]);
  assert.ok(run(Array.from({ length: 300 }, (_, i) => read(`f${i}.ts`)), { ...DEFAULT_GUARD, turnBudget: 0 }).actions.every((a) => a === "allow"));
});

test("warn mode never denies or halts; off mode allows everything", () => {
  const warn = run([bash("npm test"), bash("npm test"), bash("npm test"), bash("npm test")], { ...DEFAULT_GUARD, mode: "warn" });
  assert.deepEqual(warn.actions, ["allow", "allow", "warn:repeat", "warn:repeat"]);
  assert.equal(warn.session.halted, false);
  const off = run([bash("npm test"), bash("npm test"), bash("npm test")], { ...DEFAULT_GUARD, mode: "off" });
  assert.ok(off.actions.every((action) => action === "allow"));
});

test("a new user prompt clears the counters (but keeps the stop count)", () => {
  const stuck = run([bash("npm test"), bash("npm test"), bash("npm test"), bash("npm test")]).session;
  const fresh = onUserPrompt(stuck, "ar", NOW);
  assert.equal(fresh.halted, false);
  assert.equal(fresh.stops, 1);
  assert.equal(fresh.lang, "ar");
  assert.deepEqual(run([bash("npm test")], DEFAULT_GUARD, fresh).actions, ["allow"]);
});

test("messages tell the agent what to do and the user what happened, in their language", () => {
  const deny = { action: "deny" as const, rule: "repeat" as const, subject: "`npm test`" };
  assert.match(agentMessage(deny, DEFAULT_GUARD), /Do not retry it/);
  assert.match(agentMessage(deny, DEFAULT_GUARD), /log_progress/);
  const stop = { ...deny, action: "stop" as const };
  assert.match(agentMessage(stop, DEFAULT_GUARD), /Stop now/);
  assert.match(userMessage(stop, DEFAULT_GUARD, "ar"), /وفّرنا كريدت/);
  assert.match(userMessage(stop, DEFAULT_GUARD, "ar"), /`npm test`/);
  assert.match(userMessage({ action: "stop", rule: "runaway" }, DEFAULT_GUARD, "en"), /more than 150 tool calls/);
});

test("guard state never contains commands or file content", () => {
  const { session } = run([bash("echo SECRET-TOKEN-123"), edit("a.ts", "SECRET-OLD", "SECRET-NEW")]);
  const stored = JSON.stringify(session);
  assert.doesNotMatch(stored, /SECRET/);
});

test("redactSecrets hides credentials before anything reaches the timeline", async () => {
  const { redactSecrets } = await import("../src/loop-guard.js");
  const cases: [string, RegExp][] = [
    ["curl -H 'Authorization: Bearer abc.def.ghi' https://api.example.com", /Bearer abc/],
    ["deploy --token 1234567890abcdef", /1234567890abcdef/],
    ["export API_KEY=supersecretvalue", /supersecretvalue/],
    ["git push https://ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x", /ghp_abc/],
    ["mysql -u root --password=hunter2", /hunter2/]
  ];
  for (const [input, secret] of cases) assert.doesNotMatch(redactSecrets(input), secret, input);
  assert.equal(redactSecrets("npm test -- --watch"), "npm test -- --watch");
});
