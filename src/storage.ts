import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { newSession as newGuardSession, type GuardSession } from "./loop-guard.js";

export const SCHEMA_VERSION = 2;
export const MAX_LOG_ENTRIES = 50;

export const STATUSES = ["not_started", "in_progress", "blocked", "needs_review", "done"] as const;
export type HandoffStatus = (typeof STATUSES)[number];

export interface GitSnapshot {
  branch: string | null;
  head: string | null;
  dirty: boolean;
  /** Content hash of each uncommitted file at checkpoint time (absent for very dirty trees). */
  files?: Record<string, string>;
}

export interface LogEntry {
  at: string;
  agent: string;
  message: string;
}

export const MAX_AUTO_FILES = 100;

/**
 * Written by host hooks (Claude Code, VS Code) after every tool call, without the agent's help, so the stopping
 * point survives a session that ends abruptly (usage limit, crash). Reset whenever an agent writes a checkpoint.
 */
export interface AutoCapture {
  /** When the first automatic capture after the last checkpoint happened. */
  since: string;
  updatedAt: string;
  agent: string;
  /** Last hook event: post-tool, stop, aborted, pre-compact, session-end or session-start. */
  event: string;
  lastTool: string | null;
  toolCalls: number;
  /** Files edited by tools since the last checkpoint, relative to the project, oldest first. */
  touchedFiles: string[];
  /** Identity of the last event, used to drop the same event reported by two hosts. */
  lastKey?: string;
  /** The agent was already asked to checkpoint since the last checkpoint; it is asked once. */
  nudged?: boolean;
}

/** Lifetime counters for `ai-handoff-mcp stats`. What happened, never what was in it. */
const ZERO_STATS = {
  loopDenied: 0,
  loopStopped: 0,
  nudges: 0,
  briefsInjected: 0,
  /** Total size of the injected briefs, to show their average size. */
  briefChars: 0,
  briefsSkipped: 0,
  resumes: 0,
  checkpoints: 0
};
export type StatCounter = keyof typeof ZERO_STATS;
export type UsageStats = { since: string | null } & Record<StatCounter, number>;

/** Per-project prompt gate state: session ids and counters only, never prompt text. */
export interface PromptState {
  /** Session id -> time of its last allowed prompt. */
  sessions: Record<string, string>;
  lastAllowedAt: string | null;
  blocked: number;
  allowed: number;
}

const MAX_PROMPT_SESSIONS = 50;
const MAX_GUARD_SESSIONS = 20;

export interface HandoffRecord {
  schemaVersion: number;
  projectId: string;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  /** Agent that wrote the latest change, e.g. "claude", "copilot", "cursor". */
  updatedBy: string;
  /** The overall goal of the task. */
  task: string;
  status: HandoffStatus;
  /** What the agent was doing when it last checkpointed (may be half done). */
  currentStep: string;
  completed: string[];
  nextSteps: string[];
  /** Decisions already taken, with reasons, so the next agent does not revisit them. */
  decisions: string[];
  changedFiles: string[];
  /** Files the next agent should read first instead of exploring the codebase. */
  keyFiles: string[];
  tests: string[];
  blockers: string[];
  notes: string;
  /** Git state captured when the checkpoint was written. */
  git: GitSnapshot | null;
  /** Short timeline of who did what, newest last, capped at MAX_LOG_ENTRIES. */
  log: LogEntry[];
  /** Activity captured automatically by hooks after the last checkpoint. */
  auto: AutoCapture | null;
}

/** Fields an agent can write. Everything else is managed by the store. */
export type HandoffFields = Pick<
  HandoffRecord,
  | "task"
  | "status"
  | "currentStep"
  | "completed"
  | "nextSteps"
  | "decisions"
  | "changedFiles"
  | "keyFiles"
  | "tests"
  | "blockers"
  | "notes"
>;

export const LIST_FIELDS = [
  "completed",
  "nextSteps",
  "decisions",
  "changedFiles",
  "keyFiles",
  "tests",
  "blockers"
] as const;

export function emptyFields(): HandoffFields {
  return {
    task: "",
    status: "in_progress",
    currentStep: "",
    completed: [],
    nextSteps: [],
    decisions: [],
    changedFiles: [],
    keyFiles: [],
    tests: [],
    blockers: [],
    notes: ""
  };
}

/** Comparison key for a project path: Windows paths are case-insensitive. */
export function pathKey(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function projectId(projectPath: string): string {
  return crypto.createHash("sha256").update(pathKey(projectPath)).digest("hex").slice(0, 32);
}

/** File name used by version 0.1.0; still read so old checkpoints are not lost. */
function legacyProjectId(projectPath: string): string {
  return Buffer.from(path.resolve(projectPath).toLowerCase()).toString("base64url").slice(0, 80);
}

export function defaultDataDir(): string {
  return process.env.AI_HANDOFF_DATA_DIR
    ? path.resolve(process.env.AI_HANDOFF_DATA_DIR)
    : path.join(os.homedir(), ".ai-handoff-mcp");
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asStatus(value: unknown): HandoffStatus {
  return STATUSES.includes(value as HandoffStatus) ? (value as HandoffStatus) : "in_progress";
}

/** Fills in defaults so records from older versions or hand-edited files are safe to use. */
export function normalizeRecord(raw: Record<string, unknown>, projectPath: string): HandoffRecord {
  const resolved = path.resolve(projectPath);
  const updatedAt = asString(raw.updatedAt, new Date(0).toISOString());
  const git = raw.git as Partial<GitSnapshot> | null | undefined;
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: projectId(resolved),
    projectPath: resolved,
    createdAt: asString(raw.createdAt, updatedAt),
    updatedAt,
    updatedBy: asString(raw.updatedBy, "other"),
    task: asString(raw.task),
    status: asStatus(raw.status),
    currentStep: asString(raw.currentStep),
    completed: asStringList(raw.completed),
    nextSteps: asStringList(raw.nextSteps),
    decisions: asStringList(raw.decisions),
    changedFiles: asStringList(raw.changedFiles),
    keyFiles: asStringList(raw.keyFiles),
    tests: asStringList(raw.tests),
    blockers: asStringList(raw.blockers),
    notes: asString(raw.notes),
    git: git && typeof git === "object"
      ? {
          branch: git.branch ?? null,
          head: git.head ?? null,
          dirty: Boolean(git.dirty),
          ...(git.files && typeof git.files === "object" ? { files: { ...git.files } } : {})
        }
      : null,
    log: Array.isArray(raw.log)
      ? (raw.log as Partial<LogEntry>[])
          .filter((entry) => entry && typeof entry.message === "string")
          .map((entry) => ({ at: asString(entry.at), agent: asString(entry.agent, "other"), message: entry.message as string }))
          .slice(-MAX_LOG_ENTRIES)
      : [],
    auto: normalizeAuto(raw.auto)
  };
}

function normalizeAuto(value: unknown): AutoCapture | null {
  if (!value || typeof value !== "object") return null;
  const auto = value as Record<string, unknown>;
  const updatedAt = asString(auto.updatedAt);
  return {
    since: asString(auto.since, updatedAt),
    updatedAt,
    agent: asString(auto.agent, "other"),
    event: asString(auto.event, "post-tool"),
    lastTool: typeof auto.lastTool === "string" ? auto.lastTool : null,
    toolCalls: typeof auto.toolCalls === "number" && auto.toolCalls >= 0 ? Math.floor(auto.toolCalls) : 0,
    touchedFiles: asStringList(auto.touchedFiles).slice(-MAX_AUTO_FILES),
    ...(typeof auto.lastKey === "string" ? { lastKey: auto.lastKey } : {}),
    ...(auto.nudged === true ? { nudged: true } : {})
  };
}

export interface AutoEvent {
  agent: string;
  event: string;
  tool?: string | null;
  files?: string[];
  key?: string;
  /** This event asked the agent to checkpoint before stopping. */
  nudged?: boolean;
  /** Git snapshot used as the baseline when this event creates the record. */
  git?: GitSnapshot | null;
}

/** Folds one hook event into the automatic capture. */
export function applyAutoEvent(current: AutoCapture | null, event: AutoEvent, now: string): AutoCapture {
  const touched = [...(current?.touchedFiles ?? [])];
  for (const file of event.files ?? []) {
    const index = touched.indexOf(file);
    if (index !== -1) touched.splice(index, 1);
    touched.push(file);
  }
  const isTool = event.event === "post-tool";
  return {
    since: current?.since ?? now,
    updatedAt: now,
    agent: event.agent,
    event: event.event,
    lastTool: isTool ? event.tool ?? null : current?.lastTool ?? null,
    toolCalls: (current?.toolCalls ?? 0) + (isTool ? 1 : 0),
    touchedFiles: touched.slice(-MAX_AUTO_FILES),
    ...(event.key ? { lastKey: event.key } : {}),
    ...(current?.nudged || event.nudged ? { nudged: true } : {})
  };
}

export const LOCK_STALE_MS = 10000;
const LOCK_TIMEOUT_MS = 5000;

export interface WriteOptions {
  agent: string;
  /** Timeline message for this write. */
  message: string;
  git?: GitSnapshot | null;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class HandoffStore {
  constructor(readonly dataDir = defaultDataDir()) {}

  filePath(projectPath: string): string {
    return path.join(this.dataDir, `${projectId(projectPath)}.json`);
  }

  private async readFile(file: string, projectPath: string): Promise<HandoffRecord | null> {
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`Checkpoint file is not valid JSON: ${file}. Fix or delete it, then save a new handoff.`);
    }
    if (!raw || typeof raw !== "object") return null;
    const storedPath = (raw as { projectPath?: unknown }).projectPath;
    if (typeof storedPath !== "string" || pathKey(storedPath) !== pathKey(projectPath)) return null;
    return normalizeRecord(raw as Record<string, unknown>, projectPath);
  }

  async get(projectPath: string): Promise<HandoffRecord | null> {
    const resolved = path.resolve(projectPath);
    return (
      (await this.readFile(this.filePath(resolved), resolved)) ??
      (await this.readFile(path.join(this.dataDir, `${legacyProjectId(resolved)}.json`), resolved))
    );
  }

  /**
   * Applies `change` to the current record (or an empty one) and writes the result.
   * List and text fields are replaced by whatever `change` returns.
   */
  async write(
    projectPath: string,
    change: (current: HandoffFields) => HandoffFields,
    options: WriteOptions
  ): Promise<HandoffRecord> {
    const resolved = path.resolve(projectPath);
    return this.withLock(resolved, async () => {
      const old = await this.get(resolved);
      const now = new Date().toISOString();
      const fields = change(old ? pickFields(old) : emptyFields());
      const record: HandoffRecord = {
        schemaVersion: SCHEMA_VERSION,
        projectId: projectId(resolved),
        projectPath: resolved,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
        updatedBy: options.agent,
        ...fields,
        git: options.git === undefined ? old?.git ?? null : options.git,
        log: [...(old?.log ?? []), { at: now, agent: options.agent, message: options.message }].slice(-MAX_LOG_ENTRIES),
        // The agent's checkpoint now describes the work, so automatic capture starts over.
        auto: null
      };
      await this.persist(record);
      return record;
    });
  }

  /** Adds a timeline entry without changing the checkpoint fields. */
  async appendLog(projectPath: string, agent: string, message: string): Promise<HandoffRecord | null> {
    const resolved = path.resolve(projectPath);
    return this.withLock(resolved, async () => {
      const old = await this.get(resolved);
      if (!old) return null;
      const record: HandoffRecord = {
        ...old,
        log: [...old.log, { at: new Date().toISOString(), agent, message }].slice(-MAX_LOG_ENTRIES)
      };
      await this.persist(record);
      return record;
    });
  }

  /**
   * Records a hook event. Creates a record when none exists, so a session whose agent never checkpointed
   * still leaves its stopping point behind. Agent-written fields are never touched.
   */
  async recordAuto(projectPath: string, event: AutoEvent): Promise<HandoffRecord> {
    const resolved = path.resolve(projectPath);
    return this.withLock(resolved, async () => {
      const old = await this.get(resolved);
      const now = new Date().toISOString();
      const record: HandoffRecord = old
        ? { ...old, auto: applyAutoEvent(old.auto, event, now) }
        : {
            schemaVersion: SCHEMA_VERSION,
            projectId: projectId(resolved),
            projectPath: resolved,
            createdAt: now,
            updatedAt: now,
            updatedBy: event.agent,
            ...emptyFields(),
            git: event.git ?? null,
            log: [],
            auto: applyAutoEvent(null, event, now)
          };
      await this.persist(record);
      return record;
    });
  }

  guardStatePath(projectPath: string): string {
    return path.join(this.dataDir, `${projectId(projectPath)}.guard.json`);
  }

  async getGuardSessions(projectPath: string): Promise<Record<string, GuardSession>> {
    try {
      const raw = JSON.parse(await fs.readFile(this.guardStatePath(projectPath), "utf8")) as { sessions?: unknown };
      return raw.sessions && typeof raw.sessions === "object" ? (raw.sessions as Record<string, GuardSession>) : {};
    } catch {
      return {};
    }
  }

  /**
   * Read-modify-write of one loop-guard session under the project lock. A session idle for longer than `gapMs`
   * starts over (hosts without session ids share one key). Old sessions are pruned.
   */
  async updateGuardSession<T>(
    projectPath: string,
    sessionKey: string,
    gapMs: number,
    change: (session: GuardSession, now: string) => { session: GuardSession; result: T }
  ): Promise<T> {
    const resolved = path.resolve(projectPath);
    return this.withLock(resolved, async () => {
      const sessions = await this.getGuardSessions(resolved);
      const now = new Date().toISOString();
      const current = sessions[sessionKey];
      const fresh = !current || Date.now() - Date.parse(current.lastAt) > gapMs;
      const { session, result } = change(fresh ? newGuardSession(now, current?.lang) : current, now);
      delete sessions[sessionKey];
      sessions[sessionKey] = session;
      const keys = Object.keys(sessions);
      for (const key of keys) {
        if (key !== sessionKey && Date.now() - Date.parse(sessions[key].lastAt) > 24 * 60 * 60 * 1000) delete sessions[key];
      }
      for (const key of Object.keys(sessions).slice(0, Math.max(0, Object.keys(sessions).length - MAX_GUARD_SESSIONS))) delete sessions[key];
      await this.writeAtomic(this.guardStatePath(resolved), { sessions });
      return result;
    });
  }

  async delete(projectPath: string): Promise<boolean> {
    const resolved = path.resolve(projectPath);
    return this.withLock(resolved, async () => {
      let removed = false;
      for (const file of [this.filePath(resolved), path.join(this.dataDir, `${legacyProjectId(resolved)}.json`)]) {
        if (!(await this.readFile(file, resolved))) continue;
        await fs.rm(file, { force: true });
        removed = true;
      }
      return removed;
    });
  }

  /**
   * Serialises read-modify-write cycles across processes (the MCP server and hook commands run separately).
   * A lock directory older than LOCK_STALE_MS is assumed to belong to a crashed process and removed.
   */
  private async withLock<T>(projectPath: string, action: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const lock = `${this.filePath(projectPath)}.lock`;
    const started = Date.now();
    for (;;) {
      try {
        await fs.mkdir(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stats = await fs.stat(lock).catch(() => null);
        if (stats && Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lock, { recursive: true, force: true });
          continue;
        }
        if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for checkpoint lock: ${lock}`);
        await sleep(5 + Math.random() * 20);
      }
    }
    try {
      return await action();
    } finally {
      await fs.rm(lock, { recursive: true, force: true });
    }
  }

  statsPath(projectPath: string): string {
    return path.join(this.dataDir, `${projectId(projectPath)}.stats.json`);
  }

  async getStats(projectPath: string): Promise<UsageStats> {
    const empty: UsageStats = { since: null, ...ZERO_STATS };
    try {
      const raw = JSON.parse(await fs.readFile(this.statsPath(projectPath), "utf8")) as Partial<UsageStats>;
      const counters = Object.fromEntries(
        (Object.keys(ZERO_STATS) as StatCounter[]).map((key) => [key, typeof raw[key] === "number" && raw[key] >= 0 ? Math.floor(raw[key]) : 0])
      ) as Record<StatCounter, number>;
      return { since: typeof raw.since === "string" ? raw.since : null, ...counters };
    } catch {
      return empty;
    }
  }

  /** Adds to the lifetime counters behind `ai-handoff-mcp stats`. Counters only: no prompt, command or file content. */
  async bumpStats(projectPath: string, delta: Partial<Record<StatCounter, number>>): Promise<void> {
    const resolved = path.resolve(projectPath);
    await this.withLock(resolved, async () => {
      const stats = await this.getStats(resolved);
      for (const [key, value] of Object.entries(delta) as [StatCounter, number][]) stats[key] += value;
      await this.writeAtomic(this.statsPath(resolved), { ...stats, since: stats.since ?? new Date().toISOString() });
    });
  }

  briefStatePath(projectPath: string): string {
    return path.join(this.dataDir, `${projectId(projectPath)}.briefs.json`);
  }

  /**
   * Remembers which checkpoint state each session was given, so a resumed conversation that already contains the
   * same brief is not given it again. Returns true when this session already had this state. Only ids are stored.
   */
  async noteBrief(projectPath: string, sessionId: string, stateKey: string): Promise<boolean> {
    const resolved = path.resolve(projectPath);
    return this.withLock(resolved, async () => {
      let sessions: Record<string, string> = {};
      try {
        const raw = JSON.parse(await fs.readFile(this.briefStatePath(resolved), "utf8")) as { sessions?: unknown };
        if (raw.sessions && typeof raw.sessions === "object") sessions = raw.sessions as Record<string, string>;
      } catch {
        // First brief for this project.
      }
      const had = sessions[sessionId] === stateKey;
      delete sessions[sessionId];
      sessions[sessionId] = stateKey;
      const kept = Object.fromEntries(Object.entries(sessions).slice(-MAX_PROMPT_SESSIONS));
      await this.writeAtomic(this.briefStatePath(resolved), { sessions: kept });
      return had;
    });
  }

  promptStatePath(projectPath: string): string {
    return path.join(this.dataDir, `${projectId(projectPath)}.prompts.json`);
  }

  async getPromptState(projectPath: string): Promise<PromptState> {
    const empty: PromptState = { sessions: {}, lastAllowedAt: null, blocked: 0, allowed: 0 };
    try {
      const raw = JSON.parse(await fs.readFile(this.promptStatePath(projectPath), "utf8")) as Partial<PromptState>;
      return {
        sessions: raw.sessions && typeof raw.sessions === "object" ? raw.sessions : {},
        lastAllowedAt: typeof raw.lastAllowedAt === "string" ? raw.lastAllowedAt : null,
        blocked: typeof raw.blocked === "number" ? raw.blocked : 0,
        allowed: typeof raw.allowed === "number" ? raw.allowed : 0
      };
    } catch {
      return empty;
    }
  }

  /**
   * True when no prompt has been allowed in this session yet. Without a session id, a gap of `gapMs` since the last
   * allowed prompt counts as a new session. Blocked prompts do not count, so retyping a vague prompt is screened again.
   */
  async isFirstPrompt(projectPath: string, sessionId: string | null, gapMs: number): Promise<boolean> {
    const state = await this.getPromptState(projectPath);
    if (sessionId) return !(sessionId in state.sessions);
    return !state.lastAllowedAt || Date.now() - Date.parse(state.lastAllowedAt) > gapMs;
  }

  async notePrompt(projectPath: string, sessionId: string | null, allowed: boolean): Promise<PromptState> {
    const resolved = path.resolve(projectPath);
    return this.withLock(resolved, async () => {
      const state = await this.getPromptState(resolved);
      const now = new Date().toISOString();
      if (allowed) {
        state.allowed++;
        state.lastAllowedAt = now;
        if (sessionId) {
          delete state.sessions[sessionId];
          state.sessions[sessionId] = now;
          const ids = Object.keys(state.sessions);
          for (const id of ids.slice(0, Math.max(0, ids.length - MAX_PROMPT_SESSIONS))) delete state.sessions[id];
        }
      } else {
        state.blocked++;
      }
      await this.writeAtomic(this.promptStatePath(resolved), state);
      return state;
    });
  }

  private async persist(record: HandoffRecord): Promise<void> {
    await this.writeAtomic(this.filePath(record.projectPath), record);
  }

  private async writeAtomic(target: string, value: unknown): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    // On Windows a rename can briefly fail while another process (antivirus, a second agent) holds the file.
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(temporary, target);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
          await fs.rm(temporary, { force: true });
          throw error;
        }
        await sleep(25 * (attempt + 1));
      }
    }
  }
}

export function pickFields(record: HandoffRecord): HandoffFields {
  return {
    task: record.task,
    status: record.status,
    currentStep: record.currentStep,
    completed: [...record.completed],
    nextSteps: [...record.nextSteps],
    decisions: [...record.decisions],
    changedFiles: [...record.changedFiles],
    keyFiles: [...record.keyFiles],
    tests: [...record.tests],
    blockers: [...record.blockers],
    notes: record.notes
  };
}
