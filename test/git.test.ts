import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { getChangesSince, getGitSnapshot, getGitStatus, getRepoState, isGitRepo, parsePorcelainZ, truncate } from "../src/git.js";
import { commitFile, git, initRepo, tempDir } from "./helpers.js";

test("reports Git as unavailable outside a repository", async () => {
  const dir = await tempDir();
  assert.equal(await isGitRepo(dir), false);
  const status = await getGitStatus(dir);
  assert.equal(status.available, false);
  assert.equal(status.head, null);
  assert.equal(await getGitSnapshot(dir), null);
  assert.equal(await getChangesSince(dir, { branch: "main", head: "abc", dirty: false }), null);
});

test("handles a repository without commits", async () => {
  const dir = await tempDir();
  await initRepo(dir, false);
  await fs.writeFile(path.join(dir, "new.txt"), "x");
  const status = await getGitStatus(dir);
  assert.equal(status.available, true);
  assert.equal(status.head, null);
  assert.match(status.status, /\?\? new.txt/);
  const snapshot = await getGitSnapshot(dir);
  assert.equal(snapshot?.branch, "main");
  assert.equal(snapshot?.head, null);
  assert.equal(snapshot?.dirty, true);
  assert.match(snapshot?.files?.["new.txt"] ?? "", /^[0-9a-f]{40}$/);
  assert.equal(await getChangesSince(dir, null), null);
});

test("reads branch, HEAD, status and diff stat", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  const head = git(dir, "rev-parse", "HEAD");
  assert.deepEqual(await getGitSnapshot(dir), { branch: "main", head, dirty: false, files: {} });

  await fs.writeFile(path.join(dir, "README.md"), "# changed\n");
  const status = await getGitStatus(dir);
  assert.equal(status.branch, "main");
  assert.equal(status.head, head);
  assert.match(status.status, /M README.md/);
  assert.match(status.diffStat, /README.md/);
  // The brief never shows the diff stat, and it is the slowest call in a large repository: only get_project_status pays for it.
  const forBrief = (await getRepoState(dir, null)).git;
  assert.equal(forBrief.diffStat, "");
  assert.deepEqual({ ...forBrief, diffStat: status.diffStat }, status);
  assert.equal((await getGitSnapshot(dir))?.dirty, true);
});

test("keeps non-ASCII file names readable", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  await fs.writeFile(path.join(dir, "ملف.txt"), "x");
  assert.match((await getGitStatus(dir)).status, /ملف\.txt/);
  assert.ok("ملف.txt" in ((await getGitSnapshot(dir))?.files ?? {}));
});

test("parsePorcelainZ reads plain entries and renames", () => {
  assert.deepEqual(parsePorcelainZ(" M a.ts\0R  new.ts\0old.ts\0?? dir/b.ts\0"), ["a.ts", "new.ts", "dir/b.ts"]);
  assert.deepEqual(parsePorcelainZ(""), []);
});

test("lists commits and files changed after a checkpoint", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  const base = await getGitSnapshot(dir);
  assert.deepEqual(await getChangesSince(dir, base), { baseFound: true, commits: "", files: [], diffStat: "" });

  await commitFile(dir, "src/a.ts", "export const a = 1;\n", "add a");
  await fs.writeFile(path.join(dir, "README.md"), "# edited after\n");
  await fs.writeFile(path.join(dir, "untracked.txt"), "new\n");
  const changes = await getChangesSince(dir, base);
  assert.equal(changes?.baseFound, true);
  assert.match(changes?.commits ?? "", /add a/);
  assert.deepEqual(changes?.files, ["README.md", "src/a.ts", "untracked.txt"]);
});

test("uncommitted work that existed at the checkpoint is not reported again", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  await fs.writeFile(path.join(dir, "README.md"), "# dirty at checkpoint\n");
  await fs.writeFile(path.join(dir, "wip.txt"), "wip\n");
  const base = await getGitSnapshot(dir);
  assert.deepEqual(Object.keys(base?.files ?? {}).sort(), ["README.md", "wip.txt"]);
  assert.deepEqual((await getChangesSince(dir, base))?.files, []);

  // Editing a file that was already dirty is a change after the checkpoint.
  await fs.writeFile(path.join(dir, "wip.txt"), "wip, more\n");
  assert.deepEqual((await getChangesSince(dir, base))?.files, ["wip.txt"]);

  // Reverting a dirty file is a change too.
  git(dir, "checkout", "--", "README.md");
  assert.deepEqual((await getChangesSince(dir, base))?.files, ["README.md", "wip.txt"]);

  // Deleting one is reported as well.
  await fs.rm(path.join(dir, "wip.txt"));
  assert.deepEqual((await getChangesSince(dir, base))?.files, ["README.md", "wip.txt"]);
});

test("falls back to a diff stat for checkpoints without fingerprints", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  const head = git(dir, "rev-parse", "HEAD");
  await fs.writeFile(path.join(dir, "README.md"), "# edited\n");
  const changes = await getChangesSince(dir, { branch: "main", head, dirty: false });
  assert.deepEqual(changes?.files, []);
  assert.match(changes?.diffStat ?? "", /README.md/);
});

test("detects a checkpoint commit that does not exist", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  const changes = await getChangesSince(dir, { branch: "main", head: "0123456789abcdef0123456789abcdef01234567", dirty: false, files: {} });
  assert.deepEqual(changes, { baseFound: false, commits: "", files: [], diffStat: "" });
});

test("does not change the repository", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  await fs.writeFile(path.join(dir, "wip.txt"), "wip\n");
  const before = git(dir, "count-objects", "-v");
  const statusBefore = git(dir, "status", "--porcelain");
  const base = await getGitSnapshot(dir);
  await getChangesSince(dir, base);
  assert.equal(git(dir, "count-objects", "-v"), before, "no objects written");
  assert.equal(git(dir, "status", "--porcelain"), statusBefore);
});

test("truncate keeps short text and marks long text", () => {
  assert.equal(truncate("short", 10), "short");
  const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const result = truncate(long, 50);
  assert.ok(result.length < long.length);
  assert.match(result, /more lines truncated/);
});
