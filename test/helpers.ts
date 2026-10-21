import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";

/** A fresh temporary directory with its real path (avoids Windows 8.3 short names). */
export async function tempDir(prefix = "ai-handoff-test-"): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

export async function tempProject(): Promise<{ root: string; project: string; dataDir: string }> {
  const root = await tempDir();
  const project = path.join(root, "project");
  await fs.mkdir(project);
  return { root, project, dataDir: path.join(root, "data") };
}

/** Runs git in a throwaway test repository with a fixed identity and no signing. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();
}

export async function initRepo(dir: string, withCommit = true): Promise<void> {
  git(dir, "init", "-q", "-b", "main");
  if (withCommit) {
    await fs.writeFile(path.join(dir, "README.md"), "# test\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "initial");
  }
}

export async function commitFile(dir: string, file: string, content: string, message: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await fs.writeFile(path.join(dir, file), content);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", message);
}
