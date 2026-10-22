/**
 * @handoff in any agent's chat. The VS Code extension answers it as a chat participant (Markdown); every host with a
 * prompt hook (Claude Code, Copilot, Cursor, Gemini CLI, Windsurf) answers it from the prompt-submit hook (plain
 * text). Both use this module, so the answers are the same everywhere. Nothing here calls a model.
 */
import { HandoffStore } from "./storage.js";
import { getRepoState } from "./git.js";
import { renderBrief } from "./handoff.js";
import { readProjectConfig } from "./hooks.js";
import { tokenSettings } from "./tokens.js";
import { analyzePrompt, blockMessage, promptStrength, strengthMessage } from "./prompt-gate.js";

export type ChatFormat = "markdown" | "text";

export const CHAT_COMMANDS = ["resume", "status", "check", "continue", "help"] as const;
export type ChatCommand = (typeof CHAT_COMMANDS)[number];

/**
 * "@handoff /status" -> { command: "status", rest: "" }. "@handoff what is left?" -> { command: null, rest: ... }.
 * Not addressed to @handoff -> null. An unknown /word is kept in rest, so it reads as a question.
 */
export function parseHandoffCommand(prompt: string): { command: ChatCommand | null; rest: string } | null {
  const match = /^\s*@handoff\b\s*(.*)$/is.exec(prompt);
  if (!match) return null;
  const body = match[1].trim();
  const slash = /^\/([a-z]+)\b\s*(.*)$/is.exec(body);
  if (slash && (CHAT_COMMANDS as readonly string[]).includes(slash[1].toLowerCase())) {
    return { command: slash[1].toLowerCase() as ChatCommand, rest: slash[2].trim() };
  }
  return { command: body ? null : "help", rest: body };
}

/** The brief the next agent would get at session start, for this folder. */
export async function briefFor(dir: string, store = new HandoffStore(), profileOverride?: string): Promise<{ brief: string; hasCheckpoint: boolean }> {
  const [record, config] = await Promise.all([store.get(dir), readProjectConfig(dir)]);
  const { git, changes } = await getRepoState(dir, record?.git ?? null);
  const tokens = tokenSettings(config.tokens, profileOverride);
  const brief = renderBrief({ projectPath: dir, record, git, changes, maxChars: tokens.briefChars, minimalTools: tokens.tools === "minimal" });
  return { brief, hasCheckpoint: Boolean(record?.task || record?.currentStep || record?.nextSteps.length) };
}

/** /status: the task, where it stopped, what is next, and what the guards did. */
export async function statusFor(dir: string, store = new HandoffStore(), format: ChatFormat = "markdown"): Promise<string> {
  const [record, stats, prompts] = await Promise.all([store.get(dir), store.getStats(dir), store.getPromptState(dir)]);
  const label = (name: string) => (format === "markdown" ? `**${name}:**` : `${name}:`);
  const lines: string[] = format === "text" ? ["AI Handoff · status", ""] : [];
  if (record?.task || record?.currentStep) {
    lines.push(`${label("Task")} ${record.task || "not set"}`);
    if (record.currentStep) lines.push(`${label("Was doing")} ${record.currentStep}`);
    if (record.nextSteps.length) lines.push(`${label("Next")} ${record.nextSteps[0]}${record.nextSteps.length > 1 ? ` (+${record.nextSteps.length - 1} more)` : ""}`);
    lines.push(`${label("Last checkpoint")} ${record.updatedAt.slice(0, 16).replace("T", " ")} by ${record.updatedBy} · ${record.status}`);
  } else {
    const how = format === "markdown" ? "`log_progress` or `save_handoff`" : "log_progress or save_handoff";
    lines.push(`No checkpoint for this folder yet. An agent with the ai-handoff MCP server records one with ${how}.`);
  }
  if (record?.auto?.touchedFiles.length) lines.push(`${label("Edited since the checkpoint (hooks)")} ${record.auto.touchedFiles.slice(-5).join(", ")}`);
  const average = stats.briefsInjected ? Math.round(stats.briefChars / stats.briefsInjected / 3.5) : 0;
  const rows: [string, string][] = [
    ["Prompts checked / stopped before the model", `${prompts.allowed + prompts.blocked} / ${prompts.blocked}`],
    ["Loop guard: calls denied / agents stopped", `${stats.loopDenied} / ${stats.loopStopped}`],
    ["Briefs injected at session start", `${stats.briefsInjected}${average ? ` (~${average} tokens each)` : ""}`],
    ["Checkpoints written by agents", `${stats.checkpoints}`]
  ];
  lines.push("");
  if (format === "markdown") lines.push("| | |", "|---|---|", ...rows.map(([name, value]) => `| ${name} | ${value} |`));
  else lines.push(...rows.map(([name, value]) => `${name}: ${value}`));
  return lines.join("\n");
}

/** /check: how the prompt gate rates a prompt, as the first prompt of a session. */
export function checkFor(prompt: string, format: ChatFormat = "markdown"): string {
  const text = prompt.trim();
  // In a hook message the gate's own wording ("stopped this prompt") could read as if @handoff itself was stopped.
  const fence = (body: string) => (format === "markdown" ? "```text\n" + body + "\n```" : `@handoff /check: what the prompt gate would say:\n\n${body}`);
  if (!text) return format === "markdown" ? "Write the prompt after `/check`, for example: `/check fix the login bug`" : "Write the prompt after /check, for example: @handoff /check fix the login bug";
  const verdict = analyzePrompt(text, { firstInSession: true, hasCheckpoint: false });
  if (!verdict.signals) return "This is a reply or a command, so it is never stopped.";
  if (verdict.action === "block") return fence(blockMessage(verdict));
  const { level } = promptStrength(verdict);
  return fence(strengthMessage(verdict)) + (level === "good" ? "\nIt would go through." : "\nIt would go through, but an agent may have to explore to understand it.");
}

/** The commands, for "@handoff" alone or "@handoff /help". */
export function helpFor(format: ChatFormat = "markdown"): string {
  const code = (value: string) => (format === "markdown" ? `\`${value}\`` : value);
  return [
    format === "markdown" ? "**AI Handoff**: where the last AI agent stopped, and how to continue." : "AI Handoff: where the last AI agent stopped, and how to continue.",
    "",
    `${code("@handoff /resume")}    the brief the next agent gets (no model, no tokens)`,
    `${code("@handoff /status")}    task, next step and what the guards did (no model, no tokens)`,
    `${code("@handoff /check ...")} rate a prompt before you send it (no model, no tokens)`,
    `${code("@handoff /continue")}  the agent continues the task from the brief`,
    `${code("@handoff <question>")} the agent answers from the brief, e.g. "what is left?"`
  ].join("\n");
}

/** Instructions for the model when the user asks @handoff something in their own words. */
export function systemPromptFor(brief: string): string {
  return [
    "The user is asking AI Handoff about a coding task another AI agent started.",
    "Answer from the handoff brief below: what the task is, where the previous agent stopped, what is next, what changed after the checkpoint.",
    "Be short. Answer in the user's language. If the brief does not say, say so instead of guessing, and do not invent files or steps.",
    "Do not continue the task or edit files unless the user asks you to.",
    "",
    brief
  ].join("\n");
}

export const CONTINUE_PROMPT =
  "Continue the task from the AI Handoff brief: start from \"Was doing when stopped\" and \"Next steps\", check the files changed after the checkpoint first, and record progress with log_progress.";
