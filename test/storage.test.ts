import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { HandoffStore, MAX_LOG_ENTRIES, emptyFields, normalizeRecord, projectId, pathKey } from "../src/storage.js";
import { tempProject } from "./helpers.js";

const fields = (overrides = {}) => ({ ...emptyFields(), task: "Implement login", nextSteps: ["Add validation"], ...overrides });

test("saves and retrieves a project checkpoint", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  const saved = await store.write(project, () => fields({ completed: ["Created login form"] }), { agent: "claude", message: "saved" });

  const loaded = await store.get(project);
  assert.equal(loaded?.task, "Implement login");
  assert.equal(loaded?.updatedBy, "claude");
  assert.equal(loaded?.projectId, saved.projectId);
  assert.equal(loaded?.schemaVersion, 2);
  assert.deepEqual(loaded?.nextSteps, ["Add validation"]);
  assert.deepEqual(loaded?.completed, ["Created login form"]);
  assert.equal(loaded?.log.length, 1);
  assert.equal(loaded?.log[0].message, "saved");
});

test("returns null when no checkpoint exists", async () => {
  const { root, dataDir } = await tempProject();
  assert.equal(await new HandoffStore(dataDir).get(path.join(root, "unknown")), null);
});

test("keeps createdAt and the timeline across writes", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  const first = await store.write(project, () => fields(), { agent: "claude", message: "one" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await store.write(project, (current) => ({ ...current, status: "blocked" }), { agent: "copilot", message: "two" });
  assert.equal(second.createdAt, first.createdAt);
  assert.notEqual(second.updatedAt, first.updatedAt);
  assert.equal(second.updatedBy, "copilot");
  assert.equal(second.task, "Implement login");
  assert.deepEqual(second.log.map((entry) => `${entry.agent}:${entry.message}`), ["claude:one", "copilot:two"]);
});

test("caps the timeline at MAX_LOG_ENTRIES", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  for (let i = 0; i < MAX_LOG_ENTRIES + 5; i++) {
    await store.write(project, (current) => current, { agent: "claude", message: `step ${i}` });
  }
  const record = await store.get(project);
  assert.equal(record?.log.length, MAX_LOG_ENTRIES);
  assert.equal(record?.log.at(-1)?.message, `step ${MAX_LOG_ENTRIES + 4}`);
  assert.equal(record?.log[0].message, "step 5");
});

test("keeps the stored git snapshot unless a new one is given", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  await store.write(project, () => fields(), { agent: "claude", message: "a", git: { branch: "main", head: "abc", dirty: false } });
  const kept = await store.write(project, (current) => current, { agent: "claude", message: "b" });
  assert.deepEqual(kept.git, { branch: "main", head: "abc", dirty: false });
  const cleared = await store.write(project, (current) => current, { agent: "claude", message: "c", git: null });
  assert.equal(cleared.git, null);
});

test("projects with long shared path prefixes do not collide", async () => {
  const { root, dataDir } = await tempProject();
  const base = path.join(root, "a".repeat(60), "b".repeat(60));
  const one = path.join(base, "project-one");
  const two = path.join(base, "project-two");
  await fs.mkdir(one, { recursive: true });
  await fs.mkdir(two, { recursive: true });
  const store = new HandoffStore(dataDir);
  await store.write(one, () => fields({ task: "one" }), { agent: "claude", message: "x" });
  await store.write(two, () => fields({ task: "two" }), { agent: "claude", message: "x" });
  assert.notEqual(projectId(one), projectId(two));
  assert.equal((await store.get(one))?.task, "one");
  assert.equal((await store.get(two))?.task, "two");
});

test("path comparison follows the platform's case rules", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  await store.write(project, () => fields(), { agent: "claude", message: "x" });
  const otherCase = project.toUpperCase();
  if (process.platform === "win32") {
    assert.equal(pathKey(otherCase), pathKey(project));
    assert.equal((await store.get(otherCase))?.task, "Implement login");
  } else {
    assert.equal(await store.get(otherCase), null);
  }
});

test("reads checkpoints written by version 0.1.0", async () => {
  const { project, dataDir } = await tempProject();
  await fs.mkdir(dataDir, { recursive: true });
  const legacyName = Buffer.from(path.resolve(project).toLowerCase()).toString("base64url").slice(0, 80);
  await fs.writeFile(
    path.join(dataDir, `${legacyName}.json`),
    JSON.stringify({
      projectId: legacyName,
      projectPath: path.resolve(project),
      updatedAt: "2025-01-01T00:00:00.000Z",
      updatedBy: "copilot",
      task: "Old task",
      status: "in_progress",
      completed: ["a"],
      nextSteps: ["b"],
      changedFiles: [],
      tests: [],
      blockers: [],
      notes: "legacy"
    })
  );
  const store = new HandoffStore(dataDir);
  const record = await store.get(project);
  assert.equal(record?.task, "Old task");
  assert.equal(record?.createdAt, "2025-01-01T00:00:00.000Z");
  assert.deepEqual(record?.decisions, []);
  assert.deepEqual(record?.log, []);

  const updated = await store.write(project, (current) => ({ ...current, notes: "migrated" }), { agent: "claude", message: "m" });
  assert.equal(updated.task, "Old task");
  assert.equal((await store.get(project))?.notes, "migrated");
});

test("ignores a checkpoint file that belongs to another path", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(store.filePath(project), JSON.stringify({ projectPath: "/somewhere/else", task: "wrong" }));
  assert.equal(await store.get(project), null);
});

test("reports a corrupted checkpoint file clearly", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(store.filePath(project), "{ not json");
  await assert.rejects(store.get(project), /not valid JSON/);
});

test("normalizeRecord fills defaults and drops invalid values", () => {
  const record = normalizeRecord(
    { status: "weird", completed: ["ok", 3, null], log: [{ message: "m", agent: "x", at: "t" }, { nope: true }], git: { head: "h" } },
    "/tmp/p"
  );
  assert.equal(record.status, "in_progress");
  assert.deepEqual(record.completed, ["ok"]);
  assert.equal(record.log.length, 1);
  assert.deepEqual(record.git, { branch: null, head: "h", dirty: false });
  assert.equal(record.updatedBy, "other");
});

test("appendLog adds an entry without changing fields, and is a no-op without a checkpoint", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  assert.equal(await store.appendLog(project, "copilot", "resumed"), null);
  assert.equal(await store.get(project), null);
  const saved = await store.write(project, () => fields(), { agent: "claude", message: "saved" });
  const after = await store.appendLog(project, "copilot", "resumed");
  assert.equal(after?.updatedBy, "claude");
  assert.equal(after?.updatedAt, saved.updatedAt);
  assert.equal(after?.log.at(-1)?.agent, "copilot");
});

test("delete removes the checkpoint", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  assert.equal(await store.delete(project), false);
  await store.write(project, () => fields(), { agent: "claude", message: "saved" });
  assert.equal(await store.delete(project), true);
  assert.equal(await store.get(project), null);
});

test("concurrent writes leave a valid file and no temp files", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => store.write(project, () => fields({ task: `t${i}` }), { agent: "claude", message: `${i}` }))
  );
  const record = await store.get(project);
  assert.match(record?.task ?? "", /^t\d$/);
  assert.equal(record?.log.length, 10, "the lock prevents lost updates");
  const files = await fs.readdir(dataDir);
  assert.deepEqual(files.filter((file) => file.endsWith(".tmp")), []);
});

test("recordAuto creates a record with a baseline and folds events", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  const first = await store.recordAuto(project, {
    agent: "claude",
    event: "post-tool",
    tool: "Edit",
    files: ["a.ts"],
    git: { branch: "main", head: "h", dirty: false }
  });
  assert.equal(first.task, "");
  assert.deepEqual(first.git, { branch: "main", head: "h", dirty: false });
  assert.equal(first.auto?.toolCalls, 1);
  const second = await store.recordAuto(project, { agent: "claude", event: "stop" });
  assert.equal(second.auto?.event, "stop");
  assert.equal(second.auto?.lastTool, "Edit", "stop keeps the last tool");
  assert.equal(second.auto?.since, first.auto?.since);
  assert.deepEqual(second.git, first.git, "later events do not move the baseline");
});

test("a stale lock left by a crashed process is cleared", async () => {
  const { project, dataDir } = await tempProject();
  const store = new HandoffStore(dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  const lock = `${store.filePath(project)}.lock`;
  await fs.mkdir(lock);
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(lock, old, old);
  const record = await store.write(project, () => fields(), { agent: "claude", message: "after crash" });
  assert.equal(record.task, "Implement login");
  await assert.rejects(fs.access(lock), "lock removed after the write");
});

test("uses AI_HANDOFF_DATA_DIR when set", async () => {
  const { dataDir } = await tempProject();
  const previous = process.env.AI_HANDOFF_DATA_DIR;
  process.env.AI_HANDOFF_DATA_DIR = dataDir;
  try {
    assert.equal(new HandoffStore().dataDir, path.resolve(dataDir));
  } finally {
    if (previous === undefined) delete process.env.AI_HANDOFF_DATA_DIR;
    else process.env.AI_HANDOFF_DATA_DIR = previous;
  }
});
