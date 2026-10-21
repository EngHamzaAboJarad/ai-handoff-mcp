import crypto from "node:crypto";

/**
 * Loop guard: watches tool calls through pre-tool hooks and stops an agent that is stuck repeating itself, before it
 * burns more credits. Pure logic over a small per-session state; only hashes and counters are kept, never the
 * content of commands, files or tool output.
 *
 * Rules
 * - repeat:    the identical call (same tool, same arguments) again with nothing changed in between.
 * - ping-pong: an edit that undoes a previous edit of the same file, back and forth.
 * - failing:   the same command keeps failing even though the agent edits code in between.
 * - runaway:   too many tool calls in one turn without the user stepping in.
 * The first hit of a rule denies that call and tells the agent to change approach; hitting it again stops the agent.
 */

export const GUARD_MODES = ["block", "warn", "off"] as const;
export type GuardMode = (typeof GUARD_MODES)[number];

export interface GuardConfig {
  mode: GuardMode;
  /** Identical calls, with nothing changed in between, that trigger the guard. */
  repeatLimit: number;
  /** Tool calls in one turn (between two user prompts) that stop the agent; 0 disables. */
  turnBudget: number;
  /** Consecutive failures of the same command that trigger the guard. */
  failLimit: number;
}

export const DEFAULT_GUARD: GuardConfig = { mode: "block", repeatLimit: 3, turnBudget: 150, failLimit: 4 };

export type Rule = "repeat" | "ping-pong" | "failing" | "runaway" | "halted";

export interface GuardSession {
  lastAt: string;
  /** Language of the user's last prompt (from the prompt gate), for messages shown to the user. */
  lang: "ar" | "en";
  turnCalls: number;
  /** Increases whenever something changes (a file edit or a state-changing command). */
  changeSeq: number;
  /** Call signature -> how many times in a row it ran with nothing changed in between. */
  streaks: Record<string, { count: number; changeSeq: number }>;
  /** Recent edits as hashes: forward (old->new) and reverse (new->old). */
  edits: { file: string; fwd: string; rev: string }[];
  /** File -> how many times an edit undid the previous one. */
  reversals: Record<string, number>;
  /** Call signature -> consecutive failures. */
  failures: Record<string, number>;
  /** Rules (per signature or file) that were already denied once; hitting them again stops the agent. */
  warned: Record<string, true>;
  /** Set after a stop on hosts that cannot end a turn: every further call is denied until the user writes. */
  halted: boolean;
  stops: number;
  /** The last call seen, to answer a duplicate report of it with the same decision. */
  lastCall?: { id?: string; sig: string; agent: string; at: string; action: GuardDecision["action"]; rule?: Rule };
}

export function newSession(now: string, lang: "ar" | "en" = "en"): GuardSession {
  return {
    lastAt: now,
    lang,
    turnCalls: 0,
    changeSeq: 0,
    streaks: {},
    edits: [],
    reversals: {},
    failures: {},
    warned: {},
    halted: false,
    stops: 0
  };
}

/** A new user prompt means the user has stepped in: counters start over. */
export function onUserPrompt(session: GuardSession, lang: "ar" | "en", now: string): GuardSession {
  return { ...newSession(now, lang), stops: session.stops };
}

/** Arguments that do not change what a call does. */
const VOLATILE_KEYS = /^(description|timeout|run_in_background|explanation|reason|thought|justification|sandbox|is_background|tool_use_id)$/i;
const MAX_STREAKS = 200;
const MAX_EDITS = 20;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .filter((key) => !VOLATILE_KEYS.test(key))
        .sort()
        .map((key) => [key, stable((value as Record<string, unknown>)[key])])
    );
  }
  return typeof value === "string" ? value.trim() : value;
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Identity of a call: tool name plus its meaningful arguments. */
export function callSignature(tool: string, input: unknown): string {
  return hash(`${tool.toLowerCase()}\u0000${JSON.stringify(stable(input ?? {}))}`);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The shell command of a call, for hosts that put it in different places. */
export function commandOf(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  return text(record.command) || text(record.command_line) || text(record.cmd) || text(record.script);
}

function fileOf(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  return text(record.file_path) || text(record.filePath) || text(record.path) || text(record.notebook_path) || text(record.target_file);
}

/** Forward/reverse hashes of an edit's old->new text, for ping-pong detection. Null when the call has no old/new pair. */
export function editPair(input: unknown): { file: string; fwd: string; rev: string } | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const pairs: [string, string][] = [];
  if (typeof record.old_string === "string" && typeof record.new_string === "string") pairs.push([record.old_string, record.new_string]);
  for (const key of ["edits", "replacements"]) {
    const list = record[key];
    if (Array.isArray(list)) {
      for (const edit of list) {
        if (edit && typeof edit === "object" && typeof edit.old_string === "string" && typeof edit.new_string === "string") {
          pairs.push([edit.old_string, edit.new_string]);
        }
      }
    }
  }
  if (!pairs.length) return null;
  const file = fileOf(input);
  const join = (items: [string, string][]) => items.map(([a, b]) => `${a}\u0000${b}`).join("\u0001");
  return {
    file,
    fwd: hash(`${file}\u0002${join(pairs)}`),
    rev: hash(`${file}\u0002${join([...pairs].reverse().map(([a, b]) => [b, a] as [string, string]))}`)
  };
}

/** Shell commands that change files or repository state count as "something changed", like an edit. */
const CHANGING_COMMAND = new RegExp(
  [
    "\\bgit\\s+(?:add|commit|checkout|switch|reset|restore|merge|rebase|stash|pull|push|rm|mv|apply|cherry-pick|revert|clean)\\b",
    "\\bnpm\\s+(?:i|install|ci|uninstall|update|run\\s+(?:build|format|fix|migrate))\\b",
    "\\bpnpm\\s+(?:i|install|add|remove|update)\\b",
    "\\byarn(?:\\s+(?:add|install|remove|upgrade))?(?=\\s|$)",
    "\\bpip3?\\s+install\\b",
    "\\bpoetry\\s+(?:add|install)\\b",
    "\\bcargo\\s+(?:add|update)\\b",
    "\\bgo\\s+(?:get|mod\\s+tidy)\\b",
    "\\bdotnet\\s+(?:add|restore)\\b",
    // File-system commands: the word itself, then whitespace (\\b after a space would never match "rm -rf").
    "(?:^|[\\s;&|(])(?:rm|mv|cp|mkdir|touch|tee|chmod|chown)\\s",
    "\\bsed\\s+-i",
    "\\b(?:New-Item|Remove-Item|Set-Content|Add-Content|Out-File|Move-Item|Copy-Item|Rename-Item)\\b",
    ">{1,2}\\s*[^\\s&|]"
  ].join("|"),
  "i"
);

export function isChangingCommand(command: string): boolean {
  return Boolean(command) && CHANGING_COMMAND.test(command);
}

export interface CallInfo {
  tool: string;
  input: unknown;
  /** The host says this tool edits files. */
  isEdit: boolean;
}

export interface GuardDecision {
  action: "allow" | "deny" | "stop" | "warn";
  rule?: Rule;
  /** Short description of the call, e.g. "`npm test`". */
  subject?: string;
}

/** Hides credentials in text that is written to the handoff timeline. */
export function redactSecrets(value: string): string {
  return value
    .replace(/\b(authorization|x-api-key|api[-_]?key|token|secret|password|passwd|pwd)(\s*[:=]\s*|\s+)("[^"]*"|'[^']*'|\S+)/gi, "$1$2***")
    .replace(/(--?(?:token|password|secret|api-key|key|auth)[= ])("[^"]*"|'[^']*'|\S+)/gi, "$1***")
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 ***")
    .replace(/\b(?:sk|pk|ghp|gho|ghs|xox[abp]|AKIA)[-_]?[A-Za-z0-9_-]{12,}\b/g, "***")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "***");
}

/** Short human description of a call, e.g. "`npm test`". Built on demand and never stored. */
export function describeCall(call: CallInfo): string {
  const command = commandOf(call.input);
  if (command) return `\`${command.length > 80 ? command.slice(0, 77) + "..." : command}\``;
  const file = fileOf(call.input);
  return file ? `${call.tool} on ${file.split(/[\\/]/).slice(-2).join("/")}` : call.tool;
}

function trimStreaks(streaks: GuardSession["streaks"]): GuardSession["streaks"] {
  const keys = Object.keys(streaks);
  if (keys.length <= MAX_STREAKS) return streaks;
  return Object.fromEntries(keys.slice(-MAX_STREAKS).map((key) => [key, streaks[key]]));
}

/** Decides about a call before it runs, and returns the updated session. */
export function checkCall(session: GuardSession, call: CallInfo, config: GuardConfig, now: string): { decision: GuardDecision; session: GuardSession } {
  const next: GuardSession = {
    ...session,
    lastAt: now,
    turnCalls: session.turnCalls + 1,
    streaks: { ...session.streaks },
    edits: [...session.edits],
    reversals: { ...session.reversals },
    warned: { ...session.warned }
  };
  const subject = describeCall(call);
  const escalate = (rule: Rule, key: string): GuardDecision => {
    if (config.mode === "warn") return { action: "warn", rule, subject };
    if (next.warned[key]) {
      next.stops++;
      next.halted = true;
      return { action: "stop", rule, subject };
    }
    next.warned[key] = true;
    return { action: "deny", rule, subject };
  };

  if (config.mode === "off") return { decision: { action: "allow" }, session: next };
  if (next.halted) return { decision: { action: config.mode === "warn" ? "warn" : "deny", rule: "halted", subject }, session: next };

  if (config.turnBudget > 0 && next.turnCalls > config.turnBudget) {
    if (config.mode === "warn") return { decision: { action: "warn", rule: "runaway", subject }, session: next };
    next.stops++;
    next.halted = true;
    return { decision: { action: "stop", rule: "runaway", subject }, session: next };
  }

  const sig = callSignature(call.tool, call.input);
  const command = commandOf(call.input);
  const changes = call.isEdit || isChangingCommand(command);

  let decision: GuardDecision = { action: "allow" };

  // ping-pong: this edit undoes an earlier edit of the same file.
  const pair = call.isEdit ? editPair(call.input) : null;
  if (pair) {
    if (next.edits.some((edit) => edit.file === pair.file && edit.fwd === pair.rev)) {
      next.reversals[pair.file] = (next.reversals[pair.file] ?? 0) + 1;
      if (next.reversals[pair.file] >= 2) decision = escalate("ping-pong", `ping-pong:${pair.file}`);
    }
    next.edits = [...next.edits, pair].slice(-MAX_EDITS);
  }

  // repeat: the identical call with nothing changed since its previous run (identical edits always count).
  const streak = next.streaks[sig];
  const count = streak && (call.isEdit || streak.changeSeq === next.changeSeq) ? streak.count + 1 : 1;
  delete next.streaks[sig];
  next.streaks[sig] = { count, changeSeq: next.changeSeq };
  next.streaks = trimStreaks(next.streaks);
  if (decision.action === "allow" && count >= config.repeatLimit) decision = escalate("repeat", `repeat:${sig}`);

  // failing: this command already failed failLimit times in a row.
  if (decision.action === "allow" && (session.failures[sig] ?? 0) >= config.failLimit) decision = escalate("failing", `failing:${sig}`);

  // Only a call that actually runs changes anything.
  if (changes && (decision.action === "allow" || decision.action === "warn")) next.changeSeq++;
  return { decision, session: next };
}

/** Records the outcome of a call that ran. Returns whether the command has now failed failLimit times in a row. */
export function noteResult(session: GuardSession, call: CallInfo, failed: boolean, config: GuardConfig): { session: GuardSession; failingNow: boolean } {
  const sig = callSignature(call.tool, call.input);
  const failures = { ...session.failures };
  if (failed) failures[sig] = (failures[sig] ?? 0) + 1;
  else delete failures[sig];
  const failingNow = config.mode !== "off" && failed && failures[sig] === config.failLimit;
  return { session: { ...session, failures }, failingNow };
}

const AGENT_TEXT: Record<Rule, (subject: string, config: GuardConfig) => string> = {
  repeat: (s, c) => `you are running ${s} again (${c.repeatLimit} identical calls) with nothing changed since the last run, so it will give the same result.`,
  "ping-pong": (s) => `this edit (${s}) undoes your previous edit again: you are going back and forth between the same two versions.`,
  failing: (s, c) => `${s} has failed ${c.failLimit} times in a row despite your changes; repeating the same kind of fix is not working.`,
  runaway: (_s, c) => `you have made more than ${c.turnBudget} tool calls in this turn without input from the user.`,
  halted: () => "the loop guard already stopped this turn."
};

const USER_TEXT = {
  en: {
    repeat: (s: string, c: GuardConfig) => `the agent ran ${s} ${c.repeatLimit}+ times with nothing changed in between.`,
    "ping-pong": (s: string) => `the agent keeps undoing and redoing the same edit (${s}).`,
    failing: (s: string, c: GuardConfig) => `${s} failed ${c.failLimit}+ times in a row and the agent kept trying the same kind of fix.`,
    runaway: (_s: string, c: GuardConfig) => `the agent made more than ${c.turnBudget} tool calls in one turn.`,
    halted: () => "the agent was already stopped in this turn.",
    title: "ai-handoff loop guard stopped the agent to save credits:",
    next: "Give it a new direction (what to try, or more information), or reply \"continue\" to let it go on."
  },
  ar: {
    repeat: (s: string, c: GuardConfig) => `الوكيل شغّل ${s} أكتر من ${c.repeatLimit} مرات بدون ما يتغير شي بينهم.`,
    "ping-pong": (s: string) => `الوكيل عم يعمل نفس التعديل ويرجع عنه أكتر من مرة (${s}).`,
    failing: (s: string, c: GuardConfig) => `${s} فشل أكتر من ${c.failLimit} مرات ورا بعض، والوكيل عم يجرب نفس نوع الحل.`,
    runaway: (_s: string, c: GuardConfig) => `الوكيل عمل أكتر من ${c.turnBudget} استدعاء أدوات بدور واحد.`,
    halted: () => "الوكيل انوقف أصلاً بهالدور.",
    title: "أوقف ai-handoff الوكيل لأنه علق بحلقة، وهيك وفّرنا كريدت:",
    next: "أعطيه توجيه جديد (شو يجرب أو معلومات إضافية)، أو اكتب \"كمل\" إذا بدك يكمل."
  }
};

/** Message for the agent when a call is denied. */
export function agentMessage(decision: GuardDecision, config: GuardConfig): string {
  const reason = AGENT_TEXT[decision.rule ?? "repeat"](decision.subject ?? "this call", config);
  const stop =
    decision.action === "stop" || decision.rule === "halted"
      ? "Stop now: do not call more tools. Summarise what you tried and what you learned, then ask the user how to proceed."
      : "Do not retry it. Change your approach, or stop and ask the user. Before that, call log_progress with what you tried.";
  return `[ai-handoff loop guard] Blocked: ${reason} ${stop}`;
}

/** Message for the user when the agent is stopped. */
export function userMessage(decision: GuardDecision, config: GuardConfig, lang: "ar" | "en"): string {
  const t = USER_TEXT[lang];
  const rule = decision.rule ?? "repeat";
  return `${t.title} ${t[rule](decision.subject ?? "", config)}\n${t.next}`;
}

/** Context for the agent after a command reached failLimit failures. */
export function failingContext(call: CallInfo, config: GuardConfig): string {
  return `[ai-handoff loop guard] ${describeCall(call)} has now failed ${config.failLimit} times in a row. Step back: re-read the error, question your assumptions, and if you have no new idea, stop and ask the user instead of trying again.`;
}
