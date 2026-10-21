import path from "node:path";
import fs from "node:fs/promises";
import { renderMarkdown } from "./handoff.js";
import { redactSecrets } from "./loop-guard.js";
import type { HandoffRecord } from "./storage.js";

/**
 * Optional checkpoint file inside the repository, for agents that cannot reach this machine's checkpoint store:
 * cloud agents (Copilot coding agent, Claude Code on the web, Codex cloud) and agents without MCP. Nothing is sent
 * anywhere: the file is written next to the code, and whether it is committed is the user's choice.
 */
export const REPO_FILE = path.join(".ai-handoff", "HANDOFF.md");

export function repoFileContent(record: HandoffRecord): string {
  const auto = record.auto;
  const extra = auto?.touchedFiles.length
    ? `\n## Edited after this checkpoint (recorded by hooks; the reason is not known)\n${auto.touchedFiles.map((file) => `- ${file}`).join("\n")}\n`
    : "";
  const header =
    "<!-- Written by ai-handoff (repoFile in .ai-handoff.json). Continue from \"Was doing when stopped\" and \"Next steps\". -->\n";
  return redactSecrets(header + renderMarkdown(record) + extra);
}

/** Writes the file atomically when the content changed. Returns the path written, or null when nothing changed. */
export async function writeRepoFile(root: string, record: HandoffRecord): Promise<string | null> {
  const file = path.join(root, REPO_FILE);
  const content = repoFileContent(record);
  try {
    if ((await fs.readFile(file, "utf8")) === content) return null;
  } catch {
    // Not written yet.
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, "utf8");
  await fs.rename(temporary, file);
  return file;
}
