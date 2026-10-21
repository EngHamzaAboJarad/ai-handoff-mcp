import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { GitSnapshot } from "./storage.js";

/** Keeps tool output small: long Git output costs the next agent tokens. */
export const MAX_GIT_OUTPUT = 4000;
/** Above this many uncommitted files the snapshot stores no per-file fingerprints. */
export const MAX_TRACKED_FILES = 300;
/** Maximum number of file paths listed in "changed after the checkpoint". */
export const MAX_LISTED_FILES = 50;

export function truncate(text: string, max = MAX_GIT_OUTPUT): string {
  if (text.length <= max) return text;
  const remaining = text.slice(max).split("\n").length;
  return `${text.slice(0, max)}\n… (${remaining} more lines truncated)`;
}

function git(cwd: string, args: string[], input?: string): Promise<string> {
  // quotepath=false keeps non-ASCII file names (Arabic, etc.) readable; no optional locks keeps status read-only.
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["-c", "core.quotepath=false", "--no-optional-locks", ...args],
      { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024, timeout: 15000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trimEnd()))
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

async function tryGit(cwd: string, args: string[], input?: string): Promise<string | null> {
  try {
    return await git(cwd, args, input);
  } catch {
    return null;
  }
}

export interface GitStatus {
  available: boolean;
  branch: string | null;
  head: string | null;
  status: string;
  diffStat: string;
}

const UNAVAILABLE: GitStatus = {
  available: false,
  branch: null,
  head: null,
  status: "Git status unavailable (not a Git repository or Git not installed)",
  diffStat: ""
};

/** Every uncommitted change, untracked files included, with paths relative to the repository root. */
const DIRTY_STATUS = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];

interface RepoIdentity {
  top: string;
  head: string | null;
  branch: string | null;
}

/**
 * Repository root, HEAD commit and branch in one process. Outside a repository it is null. A repository without
 * commits has no HEAD to resolve, so it falls back to separate calls.
 */
async function repoIdentity(cwd: string): Promise<RepoIdentity | null> {
  const combined = await tryGit(cwd, ["rev-parse", "--show-toplevel", "HEAD", "--abbrev-ref", "HEAD"]);
  if (combined !== null) {
    const [top, head, branch] = combined.split("\n").map((line) => line.trim());
    // A detached HEAD abbreviates to "HEAD", where `git branch --show-current` prints nothing.
    if (top && head) return { top, head, branch: branch && branch !== "HEAD" ? branch : null };
  }
  const [top, branch] = await Promise.all([tryGit(cwd, ["rev-parse", "--show-toplevel"]), tryGit(cwd, ["branch", "--show-current"])]);
  return top === null ? null : { top, head: null, branch: branch || null };
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  return (await tryGit(cwd, ["rev-parse", "--is-inside-work-tree"])) === "true";
}

/** Paths (relative to the repository root) of every uncommitted change, including untracked files. */
export function parsePorcelainZ(output: string): string[] {
  const tokens = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    paths.push(entry.slice(3));
    // Renames and copies are followed by the original path.
    if (/^[RC]|^.[RC]/.test(entry)) i++;
  }
  return paths;
}

/**
 * Content fingerprint of each uncommitted file (from DIRTY_STATUS output), so a later resume can tell which files
 * changed after the checkpoint. Uses `git hash-object` without -w: nothing is written to the repository.
 */
async function fingerprint(top: string, status: string): Promise<Record<string, string> | null> {
  const paths = parsePorcelainZ(status);
  if (paths.length > MAX_TRACKED_FILES) return null;
  const files: Record<string, string> = {};
  const existing: string[] = [];
  const stats = await Promise.all(paths.map((file) => fs.stat(path.join(top, file)).catch(() => null)));
  paths.forEach((file, index) => {
    if (stats[index]?.isFile()) existing.push(file);
    else files[file] = stats[index] ? "not-a-file" : "deleted";
  });
  if (existing.length) {
    const hashes = await tryGit(top, ["hash-object", "--stdin-paths"], existing.join("\n") + "\n");
    if (hashes === null) return null;
    hashes.split("\n").forEach((hash, index) => (files[existing[index]] = hash.trim()));
  }
  return files;
}

/**
 * Git calls are made in at most two rounds of parallel processes. On Windows each Git process costs ~40-50 ms, so
 * what the user waits for is the number of calls in a row, not the number of calls.
 */
export async function getGitSnapshot(cwd: string): Promise<GitSnapshot | null> {
  const [repo, status] = await Promise.all([repoIdentity(cwd), tryGit(cwd, DIRTY_STATUS)]);
  if (!repo) return null;
  const files = status === null ? null : await fingerprint(repo.top, status);
  const snapshot: GitSnapshot = { branch: repo.branch, head: repo.head, dirty: files ? Object.keys(files).length > 0 : true };
  if (files) snapshot.files = files;
  return snapshot;
}

export interface ChangesSince {
  /** False when the checkpoint commit no longer exists (rebased, other clone). */
  baseFound: boolean;
  /** Commits made after the checkpoint, newest first. */
  commits: string;
  /** Files (relative to the repository root) that changed after the checkpoint, committed or not. */
  files: string[];
  /** Diff stat against the checkpoint commit; only used for checkpoints without file fingerprints. */
  diffStat: string;
}

export interface RepoState {
  git: GitStatus;
  /** Null without a checkpoint snapshot or outside a Git repository. */
  changes: ChangesSince | null;
}

function lines(text: string | null): string[] {
  return text ? text.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

function capList(values: string[]): string[] {
  return values.length > MAX_LISTED_FILES
    ? [...values.slice(0, MAX_LISTED_FILES), `… and ${values.length - MAX_LISTED_FILES} more`]
    : values;
}

/**
 * Everything a brief needs from Git: the repository now, and what happened after the checkpoint (e.g. work done
 * right before a usage limit hit). First round: every call that needs nothing else; second round: the calls that
 * depend on it (fingerprints of dirty files, commits since the checkpoint).
 * The diff stat of uncommitted work is left out unless asked for: the brief does not show it, and computing it
 * means diffing every modified file (the slowest call in a large repository).
 */
export async function getRepoState(cwd: string, base: GitSnapshot | null, options: { diffStat?: boolean } = {}): Promise<RepoState> {
  const [repo, status, diffStat, dirty, baseFound] = await Promise.all([
    repoIdentity(cwd),
    tryGit(cwd, ["status", "--short"]),
    options.diffStat ? tryGit(cwd, ["diff", "--stat", "HEAD"]) : Promise.resolve(""),
    base?.files ? tryGit(cwd, DIRTY_STATUS) : Promise.resolve(null),
    base?.head ? tryGit(cwd, ["cat-file", "-e", `${base.head}^{commit}`]).then((out) => out !== null) : Promise.resolve(true)
  ]);
  if (!repo) return { git: UNAVAILABLE, changes: null };
  const { top, head } = repo;
  const git: GitStatus = { available: true, branch: repo.branch, head, status: truncate(status ?? ""), diffStat: truncate(diffStat ?? "") };
  if (!base) return { git, changes: null };
  if (!baseFound) return { git, changes: { baseFound: false, commits: "", files: [], diffStat: "" } };

  const moved = Boolean(base.head && head && head !== base.head);
  const [commits, committed, sinceStat, now] = await Promise.all([
    moved ? tryGit(cwd, ["log", "--oneline", "--max-count=20", `${base.head}..HEAD`]) : "",
    moved ? tryGit(cwd, ["diff", "--name-only", base.head as string, "HEAD"]) : "",
    // Older checkpoint or too many files: fall back to a diff against the checkpoint commit.
    !base.files && base.head ? tryGit(cwd, ["diff", "--stat", base.head]) : "",
    base.files && dirty !== null ? fingerprint(top, dirty) : null
  ]);
  if (!base.files) {
    return { git, changes: { baseFound: true, commits: truncate(commits ?? ""), files: [], diffStat: truncate(sinceStat ?? "") } };
  }

  const current = now ?? {};
  const changed = new Set(lines(committed));
  for (const [file, hash] of Object.entries(current)) {
    if (base.files[file] !== hash) changed.add(file);
  }
  // A file that was dirty at the checkpoint and is now clean was reverted or committed.
  for (const file of Object.keys(base.files)) {
    if (!(file in current)) changed.add(file);
  }
  return { git, changes: { baseFound: true, commits: truncate(commits ?? ""), files: capList([...changed].sort()), diffStat: "" } };
}

/** The repository now, with the diff stat (get_project_status). */
export async function getGitStatus(cwd: string): Promise<GitStatus> {
  return (await getRepoState(cwd, null, { diffStat: true })).git;
}

/** What happened in the repository after a checkpoint was written. */
export async function getChangesSince(cwd: string, base: GitSnapshot | null): Promise<ChangesSince | null> {
  return base ? (await getRepoState(cwd, base)).changes : null;
}
