import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyFields, normalizeRecord } from "../src/storage.js";
import {
  applyProgress,
  describeProgress,
  mergeUpdate,
  normalizeAgent,
  renderBrief,
  renderContinuationPrompt,
  renderMarkdown,
  uniqueAppend,
  COMPACT_LIMITS,
  STALE_CHECKPOINT_DAYS
} from "../src/handoff.js";

const noGit = { available: false, branch: null, head: null, status: "Git status unavailable", diffStat: "" };

function record(overrides: Record<string, unknown> = {}) {
  return normalizeRecord(
    {
      projectPath: "/work/app",
      updatedAt: "2026-01-01T10:00:00.000Z",
      updatedBy: "claude",
      task: "Build login",
      status: "in_progress",
      currentStep: "Writing validation",
      completed: ["Form created"],
      nextSteps: ["Validate email", "Add tests"],
      decisions: ["Use zod for validation because it is already a dependency"],
      keyFiles: ["src/login.ts"],
      log: [{ at: "2026-01-01T10:00:00.000Z", agent: "claude", message: "saved checkpoint" }],
      ...overrides
    },
    "/work/app"
  );
}

test("normalizeAgent lowercases and trims", () => {
  assert.equal(normalizeAgent("  Copilot "), "copilot");
  assert.equal(normalizeAgent("   "), "other");
});

test("uniqueAppend skips blanks and case-insensitive duplicates", () => {
  assert.deepEqual(uniqueAppend(["a.ts"], ["A.ts", " b.ts ", "", "b.ts"]), ["a.ts", "b.ts"]);
});

test("mergeUpdate replaces given fields and appends append* lists", () => {
  const current = { ...emptyFields(), task: "t", nextSteps: ["one"], changedFiles: ["a.ts"], notes: "keep" };
  const next = mergeUpdate(current, { status: "blocked", nextSteps: ["two"], appendChangedFiles: ["b.ts", "a.ts"], appendBlockers: ["no db"] });
  assert.equal(next.task, "t");
  assert.equal(next.notes, "keep");
  assert.equal(next.status, "blocked");
  assert.deepEqual(next.nextSteps, ["two"]);
  assert.deepEqual(next.changedFiles, ["a.ts", "b.ts"]);
  assert.deepEqual(next.blockers, ["no db"]);
  assert.deepEqual(current.changedFiles, ["a.ts"], "input is not mutated");
});

test("applyProgress moves a finished step from nextSteps to completed", () => {
  const current = { ...emptyFields(), currentStep: "Validate email", nextSteps: ["Validate email", "Add tests"] };
  const next = applyProgress(current, { completedStep: "validate email ", changedFiles: ["src/login.ts"], tests: ["npm test: 3 passed"] });
  assert.deepEqual(next.completed, ["validate email"]);
  assert.deepEqual(next.nextSteps, ["Add tests"]);
  assert.equal(next.currentStep, "");
  assert.deepEqual(next.changedFiles, ["src/login.ts"]);
  assert.deepEqual(next.tests, ["npm test: 3 passed"]);
});

test("applyProgress sets the current step, new steps and status", () => {
  const next = applyProgress({ ...emptyFields(), nextSteps: ["a"] }, { currentStep: " Refactor ", nextSteps: ["b", "a"], status: "needs_review", decisions: ["d"] });
  assert.equal(next.currentStep, "Refactor");
  assert.deepEqual(next.nextSteps, ["a", "b"]);
  assert.equal(next.status, "needs_review");
  assert.deepEqual(next.decisions, ["d"]);
});

test("describeProgress summarises the call for the timeline", () => {
  assert.equal(describeProgress({}), "progress");
  assert.equal(describeProgress({ completedStep: "x", changedFiles: ["a", "b"] }), "progress (done: x; files: 2)");
});

test("renderBrief without a checkpoint tells the agent to start one", () => {
  const brief = renderBrief({ projectPath: "/work/app", record: null, git: noGit, changes: null });
  assert.match(brief, /No checkpoint exists/);
  assert.match(brief, /save_handoff/);
  assert.match(brief, /## Rules/);
});

test("renderBrief includes the checkpoint and leaves out empty sections", () => {
  const brief = renderBrief({ projectPath: "/work/app", record: record(), git: noGit, changes: null });
  assert.match(brief, /Last checkpoint: 2026-01-01T10:00:00.000Z by claude/);
  assert.match(brief, /## Was doing when stopped\nWriting validation/);
  assert.match(brief, /## Next steps \(in order\)\n1\. Validate email\n2\. Add tests/);
  assert.match(brief, /## Decisions already made/);
  assert.match(brief, /## Key files \(read these first\)\n- src\/login.ts/);
  assert.match(brief, /## Recent activity\n- 2026-01-01T10:00:00.000Z claude: saved checkpoint/);
  assert.doesNotMatch(brief, /## Blockers/);
  assert.doesNotMatch(brief, /## Tests/);
  assert.doesNotMatch(brief, /## Changes after/);
});

test("renderBrief shows Git state and work done after the checkpoint", () => {
  const brief = renderBrief({
    projectPath: "/work/app",
    record: record({ git: { branch: "main", head: "aaaaaaaa1111", dirty: false } }),
    git: { available: true, branch: "main", head: "bbbbbbbb2222", status: " M src/login.ts", diffStat: "" },
    changes: { commits: "bbbbbbb add check", files: ["src/validate.ts"], diffStat: " src/login.ts | 4 ++++", baseFound: true }
  });
  assert.match(brief, /Branch: main · HEAD: bbbbbbbb · HEAD at checkpoint: aaaaaaaa/);
  assert.match(brief, /Uncommitted changes:\n M src\/login.ts/);
  assert.match(brief, /the checkpoint does NOT describe/);
  assert.match(brief, /Commits:\nbbbbbbb add check/);
  assert.match(brief, /Files changed since checkpoint:\n- src\/validate.ts/);
  assert.match(brief, /Diff since checkpoint:\n src\/login.ts/);
});

test("renderBrief warns when the checkpoint commit is missing", () => {
  const brief = renderBrief({
    projectPath: "/work/app",
    record: record(),
    git: { available: true, branch: "main", head: "c", status: "", diffStat: "" },
    changes: { commits: "", files: [], diffStat: "", baseFound: false }
  });
  assert.match(brief, /Working tree clean/);
  assert.match(brief, /checkpoint commit is not in this repository/);
});

test("renderContinuationPrompt names the target agent", () => {
  assert.match(renderContinuationPrompt("copilot", "BRIEF"), /^You are GitHub Copilot taking over/);
  assert.match(renderContinuationPrompt("Zed", "BRIEF"), /^You are Zed taking over[\s\S]*BRIEF$/);
});

test("renderMarkdown lists every section", () => {
  const markdown = renderMarkdown(record({ git: { branch: "dev", head: "1234567890", dirty: true } }));
  assert.match(markdown, /^# AI Handoff/);
  assert.match(markdown, /- Git: dev @ 12345678 \(uncommitted changes\)/);
  assert.match(markdown, /## Next steps\n1\. Validate email/);
  assert.match(markdown, /## Blockers\n- None recorded/);
  assert.doesNotMatch(markdown, /\n\n\n/);
});

function bigRecord() {
  const many = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix} ${i} ${"detail ".repeat(8)}`);
  return record({
    completed: many("completed", 120),
    nextSteps: many("next", 40),
    decisions: many("decision", 40),
    keyFiles: many("src/key", 40),
    changedFiles: many("src/changed", 200),
    tests: many("test", 60),
    notes: "n".repeat(10000),
    log: Array.from({ length: 50 }, (_, i) => ({ at: "2026-01-01T00:00:00.000Z", agent: "claude", message: `entry ${i}` }))
  });
}

test("compact brief stays within the size budget even for a huge checkpoint", () => {
  const big = bigRecord();
  const compact = renderBrief({ projectPath: "/work/app", record: big, git: noGit, changes: null });
  const full = renderBrief({ projectPath: "/work/app", record: big, git: noGit, changes: null, detail: "full" });
  const json = JSON.stringify(big, null, 2);
  assert.ok(compact.length <= COMPACT_LIMITS.maxChars, `compact brief is ${compact.length} chars`);
  assert.ok(full.length > compact.length * 3, "full brief keeps everything");
  assert.ok(compact.length < json.length / 5, `compact ${compact.length} vs raw JSON ${json.length}`);
  // The most important parts survive the budget.
  assert.match(compact, /## Rules/);
  assert.match(compact, /## Task\nBuild login/);
  assert.match(compact, /## Was doing when stopped/);
  assert.match(compact, /1\. next 0/);
  assert.match(compact, /… 25 more/);
  assert.match(compact, /left out to save context/);
  assert.match(full, /- completed 0 /);
  assert.match(full, /entry 0/);
});

test("compact brief shows the newest completed steps and tests", () => {
  const brief = renderBrief({
    projectPath: "/work/app",
    record: record({ completed: Array.from({ length: 10 }, (_, i) => `c${i}`), tests: ["t1", "t2", "t3", "t4", "t5", "t6"] }),
    git: noGit,
    changes: null
  });
  assert.match(brief, /## Completed\n- … 4 earlier\n- c4\n/);
  assert.match(brief, /- c9/);
  assert.match(brief, /## Tests\n- … 1 earlier\n- t2/);
});

test("brief explains automatically captured activity", () => {
  const auto = {
    since: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-01T10:05:00.000Z",
    agent: "claude",
    event: "post-tool",
    lastTool: "Edit",
    toolCalls: 7,
    touchedFiles: ["src/a.ts", "src/b.ts"]
  };
  const brief = renderBrief({ projectPath: "/work/app", record: record({ auto }), git: noGit, changes: null });
  assert.match(brief, /7 tool call\(s\) by claude from 2026-01-01T10:00:00.000Z to 2026-01-01T10:05:00.000Z; last tool: Edit/);
  assert.match(brief, /most likely stopped mid-step/);
  assert.match(brief, /Files edited by tools:\n- src\/a.ts\n- src\/b.ts/);
  const clean = renderBrief({ projectPath: "/work/app", record: record({ auto: { ...auto, event: "stop" } }), git: noGit, changes: null });
  assert.match(clean, /ended after a completed turn/);
});

test("brief for a record that only hooks wrote", () => {
  const hooksOnly = normalizeRecord(
    { projectPath: "/work/app", auto: { since: "t", updatedAt: "t", agent: "claude", event: "stop", toolCalls: 2, touchedFiles: ["x.ts"] } },
    "/work/app"
  );
  const brief = renderBrief({ projectPath: "/work/app", record: hooksOnly, git: noGit, changes: null });
  assert.match(brief, /No agent has written a checkpoint yet/);
  assert.doesNotMatch(brief, /## Task/);
  assert.match(brief, /- x.ts/);
  const empty = renderBrief({ projectPath: "/work/app", record: normalizeRecord({ projectPath: "/work/app" }, "/work/app"), git: noGit, changes: null });
  assert.match(empty, /No checkpoint exists/);
});

test("a checkpoint that may be outdated says so: old, or written on another branch", () => {
  const checkpoint = record({ updatedAt: "2026-10-01T10:00:00.000Z", git: { branch: "feature/login", head: "abc", dirty: false } });
  const git = { available: true, branch: "feature/login", head: "abc", status: "", diffStat: "" };
  const brief = (now: string, branch = "feature/login") =>
    renderBrief({ projectPath: "/work/app", record: checkpoint, git: { ...git, branch }, changes: null, now: new Date(now) });
  assert.doesNotMatch(brief("2026-10-05T10:00:00.000Z"), /may be outdated/, "4 days, same branch");
  assert.match(brief("2026-10-09T10:00:00.000Z"), /may be outdated \(it is 8 days old\)/);
  assert.match(brief("2026-10-02T10:00:00.000Z", "main"), /written on branch feature\/login, and this is main/);
  assert.equal(STALE_CHECKPOINT_DAYS, 7);
});
