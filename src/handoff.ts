import type { HandoffFields, HandoffRecord, HandoffStatus } from "./storage.js";
import { LIST_FIELDS } from "./storage.js";
import type { ChangesSince, GitStatus } from "./git.js";

export const RULES = [
  "Continue from \"Was doing when stopped\" and \"Next steps\"; do not restart the task. Do not read AI chat/session transcripts and do not re-explore what this brief explains: read the key files first.",
  "Verify the code and Git state before editing, especially anything under \"Changes after the last checkpoint\". Preserve unrelated changes.",
  "Call log_progress after each meaningful step and update_handoff before you stop: a usage limit can end your session without warning. Record only tests that actually ran."
];

/**
 * When the host already loads the instructions block written by init (CLAUDE.md, AGENTS.md, ...), it states the
 * general rules; repeating them in the brief would be paid for twice. Only the rule about this brief stays.
 */
/** The minimal profile has one checkpoint tool, which the general rules (update_handoff, save_handoff) do not name. */
const MINIMAL_CHECKPOINT_RULE =
  "log_progress is this project's only checkpoint tool: call it after each meaningful step and before you stop, with the task, next steps, decisions, key files and only tests that actually ran. A usage limit can end your session without warning.";

export const RULES_WITH_INSTRUCTIONS = [RULES[1], "The AI Handoff rules in your instructions file apply (checkpoints, transcripts, tests)."];

export function normalizeAgent(agent: string): string {
  return agent.trim().toLowerCase() || "other";
}

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function uniqueAppend(list: string[], items: string[]): string[] {
  const result = [...list];
  for (const item of items) {
    const value = item.trim();
    if (value && !result.some((existing) => sameText(existing, value))) result.push(value);
  }
  return result;
}

export type FieldUpdate = Partial<HandoffFields> & {
  [K in (typeof LIST_FIELDS)[number] as `append${Capitalize<K>}`]?: string[];
};

/** Replaces the fields given in `update`, then appends any `append*` lists without duplicates. */
export function mergeUpdate(current: HandoffFields, update: FieldUpdate): HandoffFields {
  const next: HandoffFields = { ...current };
  for (const key of Object.keys(current) as (keyof HandoffFields)[]) {
    const value = update[key];
    if (value !== undefined) (next as Record<string, unknown>)[key] = Array.isArray(value) ? [...value] : value;
  }
  for (const field of LIST_FIELDS) {
    const appended = update[`append${field[0].toUpperCase()}${field.slice(1)}` as keyof FieldUpdate] as string[] | undefined;
    if (appended?.length) next[field] = uniqueAppend(next[field], appended);
  }
  return next;
}

export interface ProgressInput {
  /** Only offered by the minimal profile, where log_progress is the only checkpoint tool. */
  task?: string;
  keyFiles?: string[];
  /** Replaces the list: these are the blockers now ([] clears them). */
  blockers?: string[];
  /**
   * Replaces nextSteps with the remaining plan. The minimal profile has no update_handoff, so this is how an agent
   * there corrects a plan that changed.
   */
  allNextSteps?: string[];
  completedStep?: string;
  currentStep?: string;
  changedFiles?: string[];
  tests?: string[];
  decisions?: string[];
  nextSteps?: string[];
  status?: HandoffStatus;
}

/**
 * A small, frequent checkpoint: marks a step done (removing it from nextSteps when it matches),
 * records what is being worked on now, and appends files/tests/decisions.
 */
export function applyProgress(current: HandoffFields, input: ProgressInput): HandoffFields {
  const next: HandoffFields = { ...current };
  if (input.task?.trim()) next.task = input.task.trim();
  if (input.keyFiles?.length) next.keyFiles = uniqueAppend(current.keyFiles, input.keyFiles);
  if (input.blockers) next.blockers = input.blockers.map((item) => item.trim()).filter(Boolean);
  if (input.completedStep?.trim()) {
    const step = input.completedStep.trim();
    next.completed = uniqueAppend(current.completed, [step]);
    next.nextSteps = current.nextSteps.filter((item) => !sameText(item, step));
    if (sameText(current.currentStep, step)) next.currentStep = "";
  }
  if (input.currentStep !== undefined) next.currentStep = input.currentStep.trim();
  if (input.changedFiles?.length) next.changedFiles = uniqueAppend(next.changedFiles, input.changedFiles);
  if (input.tests?.length) next.tests = uniqueAppend(next.tests, input.tests);
  if (input.decisions?.length) next.decisions = uniqueAppend(next.decisions, input.decisions);
  if (input.nextSteps?.length) next.nextSteps = uniqueAppend(next.nextSteps, input.nextSteps);
  if (input.allNextSteps) {
    const done = input.completedStep?.trim();
    next.nextSteps = uniqueAppend([], input.allNextSteps).filter((item) => !done || !sameText(item, done));
  }
  if (input.status) next.status = input.status;
  return next;
}

export function describeProgress(input: ProgressInput): string {
  const parts: string[] = [];
  if (input.task?.trim()) parts.push("task set");
  if (input.completedStep?.trim()) parts.push(`done: ${input.completedStep.trim()}`);
  if (input.currentStep?.trim()) parts.push(`now: ${input.currentStep.trim()}`);
  if (input.changedFiles?.length) parts.push(`files: ${input.changedFiles.length}`);
  if (input.tests?.length) parts.push(`tests: ${input.tests.length}`);
  if (input.status) parts.push(`status: ${input.status}`);
  return parts.length ? `progress (${parts.join("; ")})` : "progress";
}

function bullets(values: string[]): string {
  return values.map((value) => `- ${value}`).join("\n");
}

function numbered(values: string[]): string {
  return values.map((value, index) => `${index + 1}. ${value}`).join("\n");
}

function shortHash(hash: string | null | undefined): string {
  return hash ? hash.slice(0, 8) : "none";
}

export type BriefDetail = "compact" | "full";

/** Limits for the compact brief. The brief is what every new session pays for in context, so it stays small. */
export const COMPACT_LIMITS = {
  maxChars: 6000,
  nextSteps: 15,
  completed: 6,
  decisions: 10,
  keyFiles: 10,
  changedFiles: 15,
  tests: 5,
  blockers: 10,
  notesChars: 1200,
  statusLines: 25,
  changedSince: 25,
  autoFiles: 20,
  activity: 5
};

export interface BriefInput {
  projectPath: string;
  record: HandoffRecord | null;
  git: GitStatus;
  changes: ChangesSince | null;
  /** "compact" (default) caps every list and the total size; "full" includes everything. */
  detail?: BriefDetail;
  /** Size budget of the compact brief, in characters (default COMPACT_LIMITS.maxChars). */
  maxChars?: number;
  /** The agent's instructions file already contains the AI Handoff block, so the general rules are left out. */
  rulesInInstructions?: boolean;
  /** Current time, to tell how old the checkpoint is (default: now). */
  now?: Date;
  /** The minimal token profile: log_progress is the only checkpoint tool, so the brief names no other. */
  minimalTools?: boolean;
}

/** A checkpoint at least this old may describe a plan the code has moved past. */
export const STALE_CHECKPOINT_DAYS = 7;

/**
 * Hosts' own memories verify or expire what they recall; a checkpoint is shown as the plan to follow, so the agent
 * is told when it may be outdated. It costs nothing when the checkpoint is recent and on the current branch.
 */
export function staleWarning(record: HandoffRecord, git: GitStatus, now: Date): string | null {
  const reasons: string[] = [];
  const days = Math.floor((now.getTime() - Date.parse(record.updatedAt)) / 86_400_000);
  if (days >= STALE_CHECKPOINT_DAYS) reasons.push(`it is ${days} days old`);
  const branch = record.git?.branch;
  if (branch && git.branch && branch !== git.branch) reasons.push(`it was written on branch ${branch}, and this is ${git.branch}`);
  return reasons.length ? `Warning: this checkpoint may be outdated (${reasons.join("; ")}). Check the plan against the code before following it.` : null;
}

/** Keeps the first `max` items (or the last ones with fromEnd) and says how many were left out. */
function cap(values: string[], max: number, fromEnd = false): string[] {
  if (values.length <= max) return values;
  const hidden = values.length - max;
  return fromEnd
    ? [`… ${hidden} earlier`, ...values.slice(-max)]
    : [...values.slice(0, max), `… ${hidden} more`];
}

function capText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more characters)`;
}

function hasAgentCheckpoint(record: HandoffRecord): boolean {
  return Boolean(
    record.task || record.currentStep || record.notes || record.nextSteps.length || record.completed.length || record.decisions.length
  );
}

function describeEnding(event: string): string {
  switch (event) {
    case "post-tool":
      return "The last thing recorded is a tool call with no end-of-turn after it: the session most likely stopped mid-step (usage limit, crash or interruption). The last step may be incomplete.";
    case "aborted":
      return "The host reported that the last turn was aborted or failed (usage limit, error or interruption). The last step may be incomplete.";
    case "stop":
      return "The session ended after a completed turn.";
    case "pre-compact":
      return "The session was compacting its context when it was last seen.";
    case "session-end":
      return "The session was closed.";
    default:
      return "";
  }
}

/**
 * The single document a resuming agent needs: checkpoint, automatic capture, repository state and rules.
 * Sections are ordered by importance; empty ones are left out, and in compact mode the least important
 * ones are dropped first when the brief would exceed the size budget.
 */
export function renderBrief({ projectPath, record, git, changes, detail = "compact", maxChars, rulesInInstructions, now = new Date(), minimalTools }: BriefInput): string {
  const compact = detail === "compact";
  const limit = (values: string[], max: number, fromEnd = false) => (compact ? cap(values, max, fromEnd) : values);
  const L = { ...COMPACT_LIMITS, maxChars: maxChars ?? COMPACT_LIMITS.maxChars };
  const sections: string[] = [];
  const section = (title: string, body: string) => {
    if (body.trim()) sections.push(`## ${title}\n${body}`);
  };

  const header = ["# AI Handoff: continue this task"];
  const agentWrote = record ? hasAgentCheckpoint(record) : false;
  const firstCheckpoint = minimalTools ? "log_progress with the task, next steps and key files" : "save_handoff with the task, next steps and key files";
  if (!record || (!agentWrote && !record.auto)) {
    header.push(
      `Project: ${projectPath}\n\nNo checkpoint exists for this project yet. This is a fresh start: ` +
        `once you understand the task, call ${firstCheckpoint}.`
    );
  } else if (!agentWrote) {
    header.push(
      `Project: ${record.projectPath}\nNo agent has written a checkpoint yet; the activity below was captured automatically. ` +
        `Work out the task from it and the code, then call ${firstCheckpoint}.`
    );
  } else {
    header.push(`Project: ${record.projectPath}\nLast checkpoint: ${record.updatedAt} by ${record.updatedBy} · status: ${record.status}`);
    const stale = staleWarning(record, git, now);
    if (stale) header.push(stale);
  }
  const rules = rulesInInstructions ? RULES_WITH_INSTRUCTIONS : RULES;
  header.push(`## Rules\n${bullets(minimalTools ? [...rules.filter((rule) => !/update_handoff/.test(rule)), MINIMAL_CHECKPOINT_RULE] : rules)}`);

  if (record && agentWrote) {
    section("Task", record.task || "Not specified");
    section("Was doing when stopped", record.currentStep);
    section("Next steps (in order)", numbered(limit(record.nextSteps, L.nextSteps)));
    section("Blockers", bullets(limit(record.blockers, L.blockers)));
  }

  const after: string[] = [];
  if (record?.auto) {
    const auto = record.auto;
    after.push(
      `Captured automatically (hooks): ${auto.toolCalls} tool call(s) by ${auto.agent} from ${auto.since} to ${auto.updatedAt}` +
        (auto.lastTool ? `; last tool: ${auto.lastTool}` : "") +
        "."
    );
    const ending = describeEnding(auto.event);
    if (ending) after.push(ending);
    if (auto.touchedFiles.length) after.push(`Files edited by tools:\n${bullets(limit(auto.touchedFiles, L.autoFiles, true))}`);
  }
  if (changes && !changes.baseFound) {
    after.push("The checkpoint commit is not in this repository (rebased or a different clone). Compare the code with the checkpoint manually.");
  } else if (changes && (changes.commits || changes.files.length || changes.diffStat)) {
    after.push("Git shows work after the last checkpoint that the checkpoint does NOT describe. Inspect it before continuing:");
    if (changes.commits) after.push(`Commits:\n${changes.commits}`);
    if (changes.files.length) after.push(`Files changed since checkpoint:\n${bullets(limit(changes.files, L.changedSince))}`);
    if (changes.diffStat) after.push(`Diff since checkpoint:\n${changes.diffStat}`);
  }
  section("Changes after the last checkpoint", after.join("\n"));

  if (record && agentWrote) {
    section("Decisions already made (do not revisit)", bullets(limit(record.decisions, L.decisions)));
    section("Key files (read these first)", bullets(limit(record.keyFiles, L.keyFiles)));
  }

  if (git.available) {
    const statusLines = git.status ? git.status.split("\n") : [];
    const lines = [
      `Branch: ${git.branch ?? "detached"} · HEAD: ${shortHash(git.head)}` +
        (record?.git ? ` · HEAD at checkpoint: ${shortHash(record.git.head)}` : "")
    ];
    lines.push(statusLines.length ? `Uncommitted changes:\n${limit(statusLines, L.statusLines).join("\n")}` : "Working tree clean.");
    section("Repository now", lines.join("\n"));
  } else {
    section("Repository now", git.status);
  }

  if (record && agentWrote) {
    section("Completed", bullets(limit(record.completed, L.completed, true)));
    section("Changed files", bullets(limit(record.changedFiles, L.changedFiles)));
    section("Tests", bullets(limit(record.tests, L.tests, true)));
    section("Notes", compact ? capText(record.notes, L.notesChars) : record.notes);
  }

  if (record?.log.length) {
    const entries = compact ? record.log.slice(-L.activity) : record.log;
    section("Recent activity", bullets(entries.map((entry) => `${entry.at} ${entry.agent}: ${entry.message}`)));
  }

  const join = (parts: string[]) => [...header, ...parts].join("\n\n") + "\n";
  let brief = join(sections);
  if (compact) {
    let kept = sections.length;
    while (brief.length > L.maxChars && kept > 1) {
      kept--;
      const more = minimalTools ? "" : `; call resume_task with detail="full" if you need them`;
      brief = join([...sections.slice(0, kept), `(${sections.length - kept} less important section(s) left out to save context${more}.)`]);
    }
    if (brief.length > L.maxChars) brief = capText(brief, L.maxChars) + "\n";
  }
  return brief;
}

export function agentDisplayName(agent: string): string {
  const names: Record<string, string> = {
    claude: "Claude Code",
    copilot: "GitHub Copilot",
    cursor: "Cursor",
    codex: "Codex",
    gemini: "Gemini",
    windsurf: "Windsurf"
  };
  return names[normalizeAgent(agent)] ?? agent;
}

/** A prompt the user can paste into another agent that has no MCP access to this server. */
export function renderContinuationPrompt(targetAgent: string, brief: string): string {
  return `You are ${agentDisplayName(targetAgent)} taking over a task another AI agent started. Everything you need is below.\n\n${brief}`;
}

export function renderMarkdown(record: HandoffRecord): string {
  const list = (values: string[]) => (values.length ? bullets(values) : "- None recorded");
  return [
    "# AI Handoff",
    `- Updated: ${record.updatedAt}`,
    `- Updated by: ${record.updatedBy}`,
    `- Status: ${record.status}`,
    record.git ? `- Git: ${record.git.branch ?? "detached"} @ ${shortHash(record.git.head)}${record.git.dirty ? " (uncommitted changes)" : ""}` : "",
    "",
    "## Current task",
    record.task || "Not specified",
    "",
    "## Was doing when stopped",
    record.currentStep || "Nothing recorded",
    "",
    "## Completed",
    list(record.completed),
    "",
    "## Next steps",
    record.nextSteps.length ? numbered(record.nextSteps) : "- None recorded",
    "",
    "## Decisions",
    list(record.decisions),
    "",
    "## Key files",
    list(record.keyFiles),
    "",
    "## Changed files",
    list(record.changedFiles),
    "",
    "## Tests",
    list(record.tests),
    "",
    "## Blockers",
    list(record.blockers),
    "",
    "## Notes",
    record.notes || "None",
    ""
  ]
    .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
    .join("\n");
}
