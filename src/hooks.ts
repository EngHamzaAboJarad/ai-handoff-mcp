import path from "node:path";
import fs from "node:fs/promises";
import { HandoffStore, type HandoffRecord } from "./storage.js";
import { getGitSnapshot, getRepoState } from "./git.js";
import { normalizeAgent, renderBrief } from "./handoff.js";
import {
  analyzePrompt,
  blockMessage,
  DEFAULT_THRESHOLD,
  GATE_MODES,
  SCORE_DISPLAYS,
  shouldShowStrength,
  strengthMessage,
  warnContext,
  type GateMode,
  type ScoreDisplay
} from "./prompt-gate.js";
import {
  agentMessage,
  checkCall,
  DEFAULT_GUARD,
  failingContext,
  GUARD_MODES,
  noteResult,
  onUserPrompt,
  callSignature,
  describeCall,
  redactSecrets,
  userMessage,
  type GuardConfig,
  type GuardDecision,
  type GuardMode
} from "./loop-guard.js";
import { tokenSettings, type TokenSettings, type TokensConfig } from "./tokens.js";
import { writeRepoFile } from "./repo-file.js";
import { BLOCK_START } from "./init.js";
import { briefFor, checkFor, CONTINUE_PROMPT, helpFor, parseHandoffCommand, statusFor, systemPromptFor, type ChatCommand } from "./chat.js";

/**
 * Commands run by host hooks. One command line works for every host; `--host` only picks the output format.
 * They capture the stopping point automatically and screen prompts, so neither depends on the agent's cooperation.
 */
export const HOOK_EVENTS = ["session-start", "prompt-submit", "pre-tool", "post-tool", "pre-compact", "stop", "session-end"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * Output dialects. vscode also covers GitHub Copilot CLI, which reads the same VS Code-style .github/hooks files.
 * generic: JSON on stdout plus the exit-code-2 convention, for any other tool that can run a command hook.
 */
export const HOSTS = ["claude", "vscode", "cursor", "gemini", "windsurf", "generic"] as const;
export type Host = (typeof HOSTS)[number];

export function defaultHost(agent: string): Host {
  const known: Record<string, Host> = { claude: "claude", copilot: "vscode", cursor: "cursor", gemini: "gemini", windsurf: "windsurf" };
  return known[normalizeAgent(agent)] ?? "generic";
}

/** Tools that change files. Other tools only count as activity. */
const EDIT_TOOL = /edit|write|create|replace|patch|insert|rename|delete|move|notebook|apply/i;
/** This server's own tools: their calls are checkpoints, not activity to capture. */
const OWN_TOOL = /ai[-_]?handoff|resume_task|log_progress|save_handoff|update_handoff/i;
const PATH_KEY = /^(file_?path|filepath|path|notebook_?path|uri|target_?file|new_?path|old_?path)$/i;
const PATH_LIST_KEY = /^(files|file_?paths|paths)$/i;
/** The same event reported twice within this window (two hosts reading overlapping config files) is recorded once. */
export const DEDUPE_MS = 3000;
/** Without a session id, a prompt this long after the previous one starts a new session. */
const SESSION_GAP_MS = 30 * 60 * 1000;

/**
 * The only hook input fields this tool uses, normalised across hosts. Everything else, `transcript_path` in
 * particular, is dropped here and never reaches the rest of the code: session transcripts are not read.
 */
export interface HookInput {
  cwd?: string;
  hookEventName?: string;
  toolName?: string;
  toolInput?: unknown;
  /** Claude Code SessionStart source: startup, resume, clear or compact. */
  source?: string;
  /** The prompt being submitted; analysed in memory, never stored. */
  prompt?: string;
  sessionId?: string;
  /** Cursor stop status: completed, aborted or error. */
  status?: string;
  attachments?: number;
  /** Identifies one tool call (Claude Code, VS Code), to recognise the same call reported twice. */
  toolUseId?: string;
  /** The tool call failed (a failure event, or a structured error flag). Derived; the output itself is not kept. */
  failed?: boolean;
  /**
   * The agent is already continuing because a stop hook asked it to: Claude Code and Gemini send stop_hook_active,
   * Cursor a loop_count above 0.
   */
  stopHookActive?: boolean;
}

/**
 * Whether a post-tool payload reports a failure. Only structured signals are used: failure events (Claude Code
 * PostToolUseFailure, Cursor/Copilot CLI postToolUseFailure), error fields and exit codes. User interrupts don't count.
 */
export function payloadFailed(input: Record<string, unknown>): boolean {
  if (input.is_interrupt === true) return false;
  const event = String(input.hook_event_name ?? input.hookEventName ?? "");
  if (/failure/i.test(event)) return true;
  if ((typeof input.error === "string" && input.error) || (typeof input.error_message === "string" && input.error_message)) return true;
  let response: unknown = input.tool_response ?? input.toolResult;
  if (typeof response === "string") {
    try {
      response = JSON.parse(response);
    } catch {
      return false;
    }
  }
  if (!response || typeof response !== "object") return false;
  const r = response as Record<string, unknown>;
  if (r.is_error === true || r.isError === true || r.success === false) return true;
  if (r.error && (typeof r.error !== "string" || r.error.length > 0)) return true;
  for (const key of ["exitCode", "exit_code", "returncode", "returnCode"]) {
    if (typeof r[key] === "number" && r[key] !== 0) return true;
  }
  return false;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Cursor reports workspace roots like "/c:/Users/..." on Windows. */
function fixDrivePath(value: string | undefined): string | undefined {
  return value && /^\/[a-zA-Z]:[\\/]/.test(value) ? value.slice(1) : value;
}

export function pickHookInput(raw: unknown): HookInput {
  if (!raw || typeof raw !== "object") return {};
  const input = raw as Record<string, unknown>;
  // Windsurf nests event details in tool_info; it never contains the transcript for the events we subscribe to.
  const info = input.tool_info && typeof input.tool_info === "object" ? (input.tool_info as Record<string, unknown>) : {};
  const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots : [];
  let toolArgs: unknown = input.toolArgs;
  if (typeof toolArgs === "string") {
    try {
      toolArgs = JSON.parse(toolArgs);
    } catch {
      toolArgs = undefined;
    }
  }
  const hookEventName = text(input.hook_event_name) ?? text(input.hookEventName) ?? text(input.agent_action_name);
  return {
    cwd: fixDrivePath(text(input.cwd) ?? text(roots[0]) ?? text(info.cwd)),
    hookEventName,
    toolName: text(input.tool_name) ?? text(input.toolName) ?? hookEventName,
    toolInput:
      input.tool_input ??
      toolArgs ??
      (Object.keys(info).length ? { file_path: info.file_path, command_line: info.command_line, edits: info.edits } : undefined) ??
      (typeof input.file_path === "string" ? { file_path: input.file_path, edits: input.edits } : undefined) ??
      (typeof input.command === "string" ? { command: input.command, cwd: input.cwd } : undefined),
    source: text(input.source),
    prompt: typeof input.prompt === "string" ? input.prompt : typeof info.user_prompt === "string" ? info.user_prompt : undefined,
    sessionId: text(input.session_id) ?? text(input.sessionId) ?? text(input.conversation_id) ?? text(input.trajectory_id),
    status: text(input.status),
    attachments: Array.isArray(input.attachments) ? input.attachments.length : undefined,
    toolUseId: text(input.tool_use_id) ?? text(input.toolUseId),
    failed: payloadFailed(input),
    stopHookActive: input.stop_hook_active === true || (typeof input.loop_count === "number" && input.loop_count > 0) ? true : undefined
  };
}

function toProjectRelative(value: string, root: string): string | null {
  let file = value.trim();
  if (!file) return null;
  if (/^file:\/\//i.test(file)) {
    try {
      file = decodeURIComponent(new URL(file).pathname);
      if (/^\/[a-zA-Z]:\//.test(file)) file = file.slice(1);
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z0-9+.-]+:\/\//i.test(file)) {
    return null;
  }
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.replace(/\\/g, "/");
}

/** File paths inside the project named in a tool call's arguments (shapes differ between hosts). */
export function extractFilePaths(toolInput: unknown, root: string): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 3) return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === "string" && PATH_KEY.test(key)) {
        const file = toProjectRelative(item, root);
        if (file) found.add(file);
      } else if (Array.isArray(item) && PATH_LIST_KEY.test(key)) {
        for (const entry of item) {
          if (typeof entry === "string") {
            const file = toProjectRelative(entry, root);
            if (file) found.add(file);
          } else visit(entry, depth + 1);
        }
      } else if (Array.isArray(item)) {
        for (const entry of item) visit(entry, depth + 1);
      } else if (item && typeof item === "object") {
        visit(item, depth + 1);
      }
    }
  };
  visit(toolInput, 0);
  return [...found];
}

/** Hosts tell the hook the project root in different ways; fall back to the hook's own working directory. */
export function projectRootFor(input: HookInput, env: NodeJS.ProcessEnv, cwd: string): string {
  return path.resolve(env.CLAUDE_PROJECT_DIR || env.GEMINI_PROJECT_DIR || input.cwd || cwd);
}

export interface ProjectConfig {
  promptGate?: { mode?: GateMode; threshold?: number; showScore?: ScoreDisplay };
  loopGuard?: Partial<GuardConfig>;
  tokens?: TokensConfig;
  checkpointNudge?: { mode?: "on" | "off"; minFiles?: number };
  /** Also keep .ai-handoff/HANDOFF.md in the repository, for cloud agents and agents without MCP. */
  repoFile?: boolean;
}

/** The instructions files each host loads at session start, where init writes the AI Handoff block. */
const INSTRUCTION_FILES: Record<Host, string[]> = {
  claude: ["CLAUDE.md"],
  vscode: [path.join(".github", "copilot-instructions.md"), "AGENTS.md"],
  cursor: ["AGENTS.md"],
  gemini: ["GEMINI.md"],
  windsurf: ["AGENTS.md"],
  generic: []
};

/** Whether the host already loads the AI Handoff block, so the brief can leave out the general rules. */
export async function hasInstructionsBlock(root: string, host: Host): Promise<boolean> {
  for (const file of INSTRUCTION_FILES[host]) {
    try {
      if ((await fs.readFile(path.join(root, file), "utf8")).includes(BLOCK_START)) return true;
    } catch {
      // Not there.
    }
  }
  return false;
}

/** Hosts whose stop hook can ask the agent to continue (decision "block" with a reason). */
// Cursor continues with a followup_message (its own docs call it unreliable on Windows; then nothing happens).
// Gemini is left out on purpose: its AfterAgent "deny" rejects the agent's final answer to force a retry.
const NUDGE_HOSTS: Host[] = ["claude", "vscode", "cursor"];
export const DEFAULT_NUDGE_FILES = 3;

/**
 * Hooks know what changed, not why. When an agent ends its turn after editing several files without a checkpoint,
 * it is asked once to record its intent, the only part the next agent cannot reconstruct. That costs one short turn,
 * and only when the next agent would otherwise get files without a reason.
 */
function nudgeReason(record: HandoffRecord | null, input: HookInput, host: Host, config: ProjectConfig, tools: TokenSettings["tools"]): string | null {
  const nudge = config.checkpointNudge ?? {};
  const auto = record?.auto;
  if (nudge.mode === "off" || !NUDGE_HOSTS.includes(host) || input.stopHookActive || !auto || auto.nudged) return null;
  // A turn that was aborted or failed (a usage limit, for one) has no agent left to answer.
  if (input.status === "aborted" || input.status === "error") return null;
  const minFiles = typeof nudge.minFiles === "number" && nudge.minFiles >= 1 ? Math.floor(nudge.minFiles) : DEFAULT_NUDGE_FILES;
  if (auto.touchedFiles.length < minFiles) return null;
  const files = auto.touchedFiles.slice(-5).join(", ") + (auto.touchedFiles.length > 5 ? ", ..." : "");
  // Name only tools this profile exposes: a call to a missing tool is a wasted model step.
  const call =
    tools === "minimal"
      ? "call log_progress once (with the task too if none is recorded yet)"
      : "call log_progress once (update_handoff, or save_handoff if there is no checkpoint yet)";
  return (
    `ai-handoff: you edited ${auto.touchedFiles.length} files since the last checkpoint (${files}) but the reason is not recorded. ` +
    `Before you stop, ${call} with the step you finished, ` +
    "what you are doing now, decisions with reasons and the next steps, so another agent can continue if this session ends. Then stop; do no other work."
  );
}

/** Loop guard settings: defaults, then .ai-handoff.json, then the --guard flag. */
export function guardConfig(config: ProjectConfig, mode?: GuardMode): GuardConfig {
  const file = config.loopGuard ?? {};
  const number = (value: unknown, fallback: number) => (typeof value === "number" && value >= 0 ? Math.floor(value) : fallback);
  return {
    mode: mode ?? (GUARD_MODES.includes(file.mode as GuardMode) ? (file.mode as GuardMode) : DEFAULT_GUARD.mode),
    repeatLimit: Math.max(2, number(file.repeatLimit, DEFAULT_GUARD.repeatLimit)),
    turnBudget: number(file.turnBudget, DEFAULT_GUARD.turnBudget),
    failLimit: Math.max(2, number(file.failLimit, DEFAULT_GUARD.failLimit))
  };
}

/** Optional per-project settings in .ai-handoff.json at the project root. */
export async function readProjectConfig(root: string): Promise<ProjectConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(root, ".ai-handoff.json"), "utf8"));
    return raw && typeof raw === "object" ? (raw as ProjectConfig) : {};
  } catch {
    return {};
  }
}

export interface HookResult {
  /** What the host reads from stdout; empty for events that return nothing. */
  stdout: string;
  stderr?: string;
  /** Non-zero only when blocking through the exit-code convention (Windsurf, generic). */
  exitCode?: number;
}

export interface HookOptions {
  store?: HandoffStore;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  host?: Host;
  /** Overrides .ai-handoff.json; default block. */
  gate?: GateMode;
  /** Loop guard mode; overrides .ai-handoff.json; default block. */
  guard?: GuardMode;
}

const ARABIC_TEXT = /[؀-ۿ]/;

const json = (value: unknown) => JSON.stringify(value);

function sessionStartOutput(host: Host, brief: string): HookResult {
  switch (host) {
    case "cursor":
      return { stdout: json({ additional_context: brief }) };
    case "windsurf":
      return { stdout: "" };
    default:
      return { stdout: json({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: brief } }) };
  }
}

function promptAllowOutput(host: Host): HookResult {
  return host === "cursor" ? { stdout: json({ continue: true }) } : { stdout: "" };
}

function promptBlockOutput(host: Host, message: string): HookResult {
  switch (host) {
    case "claude":
      return { stdout: json({ decision: "block", reason: message }) };
    case "vscode":
      return { stdout: json({ continue: false, stopReason: message }) };
    case "cursor":
      return { stdout: json({ continue: false, user_message: message }) };
    case "gemini":
      return { stdout: json({ decision: "deny", reason: message }) };
    case "windsurf":
      return { stdout: "", stderr: message + "\n", exitCode: 2 };
    default:
      return { stdout: json({ decision: "block", continue: false, reason: message }), stderr: message + "\n", exitCode: 2 };
  }
}

/** A passing prompt with a note for the user only (the prompt strength); the model never sees it. */
function promptNoteOutput(host: Host, note: string): HookResult {
  switch (host) {
    case "cursor":
      // Cursor shows user_message only for a blocked prompt.
      return promptAllowOutput(host);
    case "windsurf":
    case "generic":
      return { stdout: "", stderr: note + "\n" };
    default:
      return { stdout: json({ systemMessage: note }) };
  }
}

function promptWarnOutput(host: Host, context: string, note?: string): HookResult {
  if (host === "cursor" || host === "windsurf") return promptAllowOutput(host);
  const hookEventName = host === "gemini" ? "BeforeAgent" : "UserPromptSubmit";
  const output = { hookSpecificOutput: { hookEventName, additionalContext: context } };
  if (host === "generic") return { stdout: json(output), ...(note ? { stderr: note + "\n" } : {}) };
  return { stdout: json(note ? { ...output, systemMessage: note } : output) };
}

/**
 * @handoff in any agent's chat, the way the VS Code extension answers it in Copilot. /resume, /status, /check and
 * /help are answered here and the prompt never reaches the model (the host shows the answer as the hook's message).
 * /continue and a question in the user's words do need the model: the prompt goes through with the brief added as
 * context, on hosts that can add it.
 */
async function answerHandoff(
  store: HandoffStore,
  root: string,
  input: HookInput,
  host: Host,
  handoff: { command: ChatCommand | null; rest: string },
  options: HookOptions,
  resetGuard: () => Promise<void>
): Promise<HookResult> {
  const local = (text: string) => promptBlockOutput(host, text);
  switch (handoff.command) {
    case "help":
      return local(helpFor("text"));
    case "status":
      return local(await statusFor(root, store, "text"));
    case "check":
      return local(checkFor(handoff.rest, "text"));
    case "resume":
      return local((await briefFor(root, store, (options.env ?? process.env).AI_HANDOFF_TOKENS)).brief);
  }
  // Cursor and Windsurf cannot add context to a prompt, so the model would get "@handoff ..." without the brief.
  if (host === "cursor" || host === "windsurf") {
    return local(
      "This agent cannot receive the brief from a hook, so @handoff /continue and questions are not available here. " +
        "The brief is injected when a session starts; to continue, say \"resume the task\"."
    );
  }
  const { brief } = await briefFor(root, store, (options.env ?? process.env).AI_HANDOFF_TOKENS);
  const context = handoff.command === "continue" ? `${CONTINUE_PROMPT}\n\n${brief}` : systemPromptFor(brief);
  // The prompt reaches the model: the user stepped in, as with any prompt.
  await Promise.all([store.notePrompt(root, input.sessionId ?? null, true), resetGuard()]);
  return promptWarnOutput(host, context);
}

async function screenPrompt(store: HandoffStore, root: string, input: HookInput, host: Host, options: HookOptions): Promise<HookResult> {
  const project = await readProjectConfig(root);
  const config = project.promptGate ?? {};
  const mode = options.gate ?? (GATE_MODES.includes(config.mode as GateMode) ? (config.mode as GateMode) : "block");
  const sessionId = input.sessionId ?? null;
  // A prompt that reaches the model means the user stepped in: the loop guard's counters start over.
  const resetGuard = async (lang: "ar" | "en") => {
    if (guardConfig(project, options.guard).mode === "off") return;
    await store.updateGuardSession(root, sessionId ?? "default", SESSION_GAP_MS, (session, now) => ({
      session: onUserPrompt(session, lang, now),
      result: undefined
    }));
  };
  if (input.prompt === undefined) return promptAllowOutput(host);
  const handoff = parseHandoffCommand(input.prompt);
  if (handoff) return answerHandoff(store, root, input, host, handoff, options, () => resetGuard(ARABIC_TEXT.test(input.prompt ?? "") ? "ar" : "en"));
  if (mode === "off") {
    await resetGuard(ARABIC_TEXT.test(input.prompt) ? "ar" : "en");
    return promptAllowOutput(host);
  }
  const [record, firstInSession] = await Promise.all([store.get(root), store.isFirstPrompt(root, sessionId, SESSION_GAP_MS)]);
  const threshold = typeof config.threshold === "number" ? config.threshold : DEFAULT_THRESHOLD;
  const showScore = SCORE_DISPLAYS.includes(config.showScore as ScoreDisplay) ? (config.showScore as ScoreDisplay) : "weak";
  const verdict = analyzePrompt(input.prompt, {
    firstInSession,
    hasCheckpoint: Boolean(record?.task),
    attachments: input.attachments,
    threshold
  });
  // In warn mode the prompt still goes through, so the session counts as started.
  const passes = verdict.action === "allow" || mode === "warn";
  await store.notePrompt(root, sessionId, passes);
  if (passes) await resetGuard(verdict.language);
  const note = shouldShowStrength(verdict, showScore, threshold) ? strengthMessage(verdict, threshold) : undefined;
  if (verdict.action === "allow") return note ? promptNoteOutput(host, note) : promptAllowOutput(host);
  return mode === "warn" ? promptWarnOutput(host, warnContext(verdict), note) : promptBlockOutput(host, blockMessage(verdict));
}

function preToolOutput(host: Host, decision: GuardDecision, config: GuardConfig, lang: "ar" | "en"): HookResult {
  if (decision.action === "allow") return host === "cursor" ? { stdout: json({ permission: "allow" }) } : { stdout: "" };
  const toAgent = agentMessage(decision, config);
  const toUser = userMessage(decision, config, lang);
  if (decision.action === "warn") {
    // Warn mode only informs the user; the call goes ahead.
    if (host === "cursor") return { stdout: json({ permission: "allow" }) };
    if (host === "windsurf" || host === "generic") return { stdout: "", stderr: toUser + "\n" };
    return { stdout: json({ systemMessage: toUser }) };
  }
  const stop = decision.action === "stop";
  switch (host) {
    case "claude":
    case "vscode": {
      const deny = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: toAgent } };
      return { stdout: json(stop ? { continue: false, stopReason: toUser, ...deny } : deny) };
    }
    case "gemini":
      return { stdout: json({ decision: "deny", reason: toAgent, ...(stop ? { continue: false, stopReason: toUser } : {}) }) };
    case "cursor":
      // Cursor cannot end a turn from a hook; once stopped, every further call is denied until the user writes.
      return { stdout: json({ permission: "deny", agent_message: toAgent, ...(stop ? { user_message: toUser } : {}) }) };
    case "windsurf":
      return { stdout: "", stderr: toAgent + "\n", exitCode: 2 };
    default:
      return {
        stdout: json({ decision: "block", reason: toAgent, ...(stop ? { continue: false, stopReason: toUser } : {}) }),
        stderr: toAgent + "\n",
        exitCode: 2
      };
  }
}

function failingOutput(host: Host, input: HookInput, context: string): HookResult {
  switch (host) {
    case "claude":
    case "vscode": {
      const hookEventName = /failure/i.test(input.hookEventName ?? "") ? "PostToolUseFailure" : "PostToolUse";
      return { stdout: json({ hookSpecificOutput: { hookEventName, additionalContext: context } }) };
    }
    case "gemini":
      return { stdout: json({ hookSpecificOutput: { hookEventName: "AfterTool", additionalContext: context } }) };
    case "cursor":
      return { stdout: json({ additional_context: context }) };
    default:
      return { stdout: "" };
  }
}

/** The same call reported by two hosts (overlapping config files) within this window is only counted once. */
const GUARD_DEDUPE_MS = 2000;

async function guardToolCall(store: HandoffStore, root: string, input: HookInput, agent: string, host: Host, options: HookOptions): Promise<HookResult> {
  const tool = input.toolName ?? "unknown";
  if (OWN_TOOL.test(tool)) return preToolOutput(host, { action: "allow" }, DEFAULT_GUARD, "en");
  const config = guardConfig(await readProjectConfig(root), options.guard);
  if (config.mode === "off") return preToolOutput(host, { action: "allow" }, config, "en");
  const call = { tool, input: input.toolInput, isEdit: EDIT_TOOL.test(tool) };
  const sig = callSignature(tool, input.toolInput);
  const { decision, lang, fresh, wasStopped } = await store.updateGuardSession(root, input.sessionId ?? "default", SESSION_GAP_MS, (session, now) => {
    const last = session.lastCall;
    const duplicate =
      last &&
      last.sig === sig &&
      (input.toolUseId ? last.id === input.toolUseId : last.agent !== agent && Date.now() - Date.parse(last.at) < GUARD_DEDUPE_MS);
    if (duplicate) {
      const decision: GuardDecision = { action: last.action, rule: last.rule, subject: describeCall(call) };
      return { session, result: { decision, lang: session.lang, fresh: false, wasStopped: true } };
    }
    const checked = checkCall(session, call, config, now);
    // Only the outcome is kept: the description contains the command and is rebuilt when needed.
    const lastCall = { id: input.toolUseId, sig, agent, at: now, action: checked.decision.action, rule: checked.decision.rule };
    const wasStopped = last?.action === "stop" || session.halted;
    return { session: { ...checked.session, lastCall }, result: { decision: checked.decision, lang: session.lang, fresh: true, wasStopped } };
  });
  // Counted once per event: a call reported twice (two hosts) and the calls after a stop (still "stop", or "halted"
  // on hosts that cannot end a turn) are the same event. Allowed calls are not counted: this hook must stay fast.
  if (fresh && !wasStopped && decision.rule !== "halted" && (decision.action === "deny" || decision.action === "stop")) {
    await store.bumpStats(root, decision.action === "stop" ? { loopStopped: 1 } : { loopDenied: 1 });
  }
  if (decision.action === "stop") {
    await store.appendLog(root, agent, `loop guard stopped the agent (${decision.rule}): ${redactSecrets(decision.subject ?? tool)}`);
  }
  return preToolOutput(host, decision, config, lang);
}

async function noteToolResult(store: HandoffStore, root: string, input: HookInput, agent: string, host: Host, options: HookOptions): Promise<HookResult> {
  const tool = input.toolName ?? "unknown";
  const config = guardConfig(await readProjectConfig(root), options.guard);
  if (config.mode === "off" || OWN_TOOL.test(tool)) return { stdout: "" };
  const call = { tool, input: input.toolInput, isEdit: EDIT_TOOL.test(tool) };
  const failingNow = await store.updateGuardSession(root, input.sessionId ?? "default", SESSION_GAP_MS, (session) => {
    const noted = noteResult(session, call, Boolean(input.failed), config);
    return { session: noted.session, result: noted.failingNow };
  });
  return failingNow ? failingOutput(host, input, failingContext(call, config)) : { stdout: "" };
}

export async function runHook(event: HookEvent, agentName: string, stdin: string, options: HookOptions = {}): Promise<HookResult> {
  const store = options.store ?? new HandoffStore();
  let raw: unknown = {};
  try {
    raw = stdin.trim() ? JSON.parse(stdin) : {};
  } catch {
    raw = {};
  }
  const input = pickHookInput(raw);
  const root = projectRootFor(input, options.env ?? process.env, options.cwd ?? process.cwd());
  const agent = normalizeAgent(agentName);
  const host = options.host ?? defaultHost(agent);

  if (event === "prompt-submit") return screenPrompt(store, root, input, host, options);
  if (event === "pre-tool") return guardToolCall(store, root, input, agent, host, options);

  if (event === "session-start") {
    const record = await store.get(root);
    if (!record) {
      // First session in this project: remember the starting Git state as the baseline for later changes.
      await store.recordAuto(root, { agent, event, git: await getGitSnapshot(root) });
      return { stdout: "" };
    }
    // A resumed conversation already contains the brief it was given; when nothing changed since, it is not repeated.
    const stateKey = `${record.updatedAt}|${record.auto?.updatedAt ?? ""}`;
    // Everything below is independent, so it runs at once: session start is when the user waits for this hook.
    const [hadBrief, { git, changes }, config, rulesInInstructions] = await Promise.all([
      input.sessionId ? store.noteBrief(root, input.sessionId, stateKey) : false,
      getRepoState(root, record.git),
      readProjectConfig(root),
      hasInstructionsBlock(root, host)
    ]);
    if (hadBrief && input.source === "resume") {
      await Promise.all([store.appendLog(root, agent, "session resumed, brief already in its context"), store.bumpStats(root, { briefsSkipped: 1 })]);
      return host === "cursor" ? { stdout: json({}) } : { stdout: "" };
    }
    // Keep the previous session's capture as it is: it describes where that session stopped.
    await store.appendLog(root, agent, `session started (${input.source ?? "auto"}), brief injected`);
    // The same override the server reads, so the brief never names a tool the server does not expose.
    const tokens = tokenSettings(config.tokens, (options.env ?? process.env).AI_HANDOFF_TOKENS);
    const brief = renderBrief({
      projectPath: root,
      record,
      git,
      changes,
      detail: "compact",
      maxChars: tokens.briefChars,
      rulesInInstructions,
      minimalTools: tokens.tools === "minimal"
    });
    // Windsurf has no way to inject it, so nothing reaches the model there.
    if (host !== "windsurf") await store.bumpStats(root, { briefsInjected: 1, briefChars: brief.length });
    return sessionStartOutput(host, brief);
  }

  const tool = event === "post-tool" ? input.toolName ?? null : null;
  if (tool && OWN_TOOL.test(tool)) return { stdout: "" };
  const files = tool && !input.failed && EDIT_TOOL.test(tool) ? extractFilePaths(input.toolInput, root) : [];
  // Cursor reports how the turn ended; an aborted or failed turn is an abrupt stop.
  const recorded = event === "stop" && (input.status === "aborted" || input.status === "error") ? "aborted" : event;
  const key = `${recorded}|${tool ?? ""}|${files.join(",")}|${input.toolUseId ?? ""}|${input.failed ? "failed" : ""}`;
  const existing = await store.get(root);
  const last = existing?.auto;
  if (last?.lastKey === key && Date.now() - Date.parse(last.updatedAt) < DEDUPE_MS) return { stdout: "" };
  const config = await readProjectConfig(root);
  const tools = tokenSettings(config.tokens, (options.env ?? process.env).AI_HANDOFF_TOKENS).tools;
  let nudge = event === "stop" ? nudgeReason(existing, input, host, config, tools) : null;
  // A turn the loop guard ended must stay ended: asking the agent to continue would undo the stop.
  if (nudge && (await store.getGuardSessions(root))[input.sessionId ?? "default"]?.lastCall?.action === "stop") nudge = null;
  const saved = await store.recordAuto(root, {
    agent,
    event: recorded,
    tool,
    files,
    key,
    git: existing ? undefined : await getGitSnapshot(root),
    ...(nudge ? { nudged: true } : {})
  });
  // The repository file follows the end of a turn or session; per-tool updates would only churn it.
  if (config.repoFile === true && event !== "post-tool") await writeRepoFile(root, saved).catch(() => null);
  if (nudge) {
    await store.bumpStats(root, { nudges: 1 });
    return { stdout: json(host === "cursor" ? { followup_message: nudge } : { decision: "block", reason: nudge }) };
  }
  if (event === "post-tool") return noteToolResult(store, root, input, agent, host, options);
  return host === "cursor" && event === "stop" ? { stdout: json({}) } : { stdout: "" };
}
