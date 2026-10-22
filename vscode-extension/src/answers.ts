// What @handoff answers, without VS Code: the same code as the hooks and the CLI, so the chat never disagrees with
// them. Nothing here calls a model.
import { HandoffStore } from "../../src/storage.js";
import { getRepoState } from "../../src/git.js";
import { renderBrief } from "../../src/handoff.js";
import { readProjectConfig } from "../../src/hooks.js";
import { tokenSettings } from "../../src/tokens.js";
import { analyzePrompt, blockMessage, promptStrength, strengthMessage } from "../../src/prompt-gate.js";

/** The brief the next agent would get at session start, for this folder. */
export async function briefFor(dir: string, store = new HandoffStore()): Promise<{ brief: string; hasCheckpoint: boolean }> {
  const [record, config] = await Promise.all([store.get(dir), readProjectConfig(dir)]);
  const { git, changes } = await getRepoState(dir, record?.git ?? null);
  const tokens = tokenSettings(config.tokens);
  const brief = renderBrief({ projectPath: dir, record, git, changes, maxChars: tokens.briefChars, minimalTools: tokens.tools === "minimal" });
  return { brief, hasCheckpoint: Boolean(record?.task || record?.currentStep || record?.nextSteps.length) };
}

/** /status: the task, where it stopped, what is next, and what the guards did. */
export async function statusFor(dir: string, store = new HandoffStore()): Promise<string> {
  const [record, stats, prompts] = await Promise.all([store.get(dir), store.getStats(dir), store.getPromptState(dir)]);
  const lines: string[] = [];
  if (record?.task || record?.currentStep) {
    lines.push(`**Task:** ${record.task || "not set"}`);
    if (record.currentStep) lines.push(`**Was doing:** ${record.currentStep}`);
    if (record.nextSteps.length) lines.push(`**Next:** ${record.nextSteps[0]}${record.nextSteps.length > 1 ? ` (+${record.nextSteps.length - 1} more)` : ""}`);
    lines.push(`**Last checkpoint:** ${record.updatedAt.slice(0, 16).replace("T", " ")} by ${record.updatedBy} · ${record.status}`);
  } else {
    lines.push("No checkpoint for this folder yet. An agent with the ai-handoff MCP server records one with `log_progress` or `save_handoff`.");
  }
  if (record?.auto?.touchedFiles.length) lines.push(`**Edited since the checkpoint (hooks):** ${record.auto.touchedFiles.slice(-5).join(", ")}`);
  const average = stats.briefsInjected ? Math.round(stats.briefChars / stats.briefsInjected / 3.5) : 0;
  lines.push(
    "",
    "| | |",
    "|---|---|",
    `| Prompts checked / stopped before the model | ${prompts.allowed + prompts.blocked} / ${prompts.blocked} |`,
    `| Loop guard: calls denied / agents stopped | ${stats.loopDenied} / ${stats.loopStopped} |`,
    `| Briefs injected at session start | ${stats.briefsInjected}${average ? ` (~${average} tokens each)` : ""} |`,
    `| Checkpoints written by agents | ${stats.checkpoints} |`
  );
  return lines.join("\n");
}

/** /check: how the prompt gate rates a prompt, as the first prompt of a session. */
export function checkFor(prompt: string): string {
  const text = prompt.trim();
  if (!text) return "Write the prompt after `/check`, for example: `/check fix the login bug`";
  const verdict = analyzePrompt(text, { firstInSession: true, hasCheckpoint: false });
  if (!verdict.signals) return "This is a reply or a command, so it is never stopped.";
  if (verdict.action === "block") return "```text\n" + blockMessage(verdict) + "\n```";
  const { level } = promptStrength(verdict);
  return "```text\n" + strengthMessage(verdict) + "\n```" + (level === "good" ? "\nIt would go through." : "\nIt would go through, but an agent may have to explore to understand it.");
}

/** Instructions for the model when the user asks @handoff something in their own words. */
export function systemPromptFor(brief: string): string {
  return [
    "You are AI Handoff, inside the VS Code chat. You help the user continue a coding task another AI agent started.",
    "Answer from the handoff brief below: what the task is, where the previous agent stopped, what is next, what changed after the checkpoint.",
    "Be short. Answer in the user's language. If the brief does not say, say so instead of guessing, and do not invent files or steps.",
    "To actually continue the work, tell the user to use the button or switch to agent mode: you cannot edit files from here.",
    "",
    brief
  ].join("\n");
}

export const CONTINUE_PROMPT =
  "Continue the task from the AI Handoff brief: start from \"Was doing when stopped\" and \"Next steps\", check the files changed after the checkpoint first, and record progress with log_progress.";
