import fs from "node:fs/promises";
import path from "node:path";
import type { HookEvent } from "./hooks.js";
import type { TokenProfile } from "./tokens.js";

export const PACKAGE_NAME = "ai-handoff-mcp";
export const SERVER_KEY = "ai-handoff";
export const BLOCK_START = "<!-- ai-handoff:start -->";
export const BLOCK_END = "<!-- ai-handoff:end -->";

export const TARGETS = [
  "vscode",
  "claude",
  "claude-hooks",
  "copilot",
  "copilot-hooks",
  "agents",
  "cursor",
  "gemini",
  "windsurf"
] as const;
export type Target = (typeof TARGETS)[number];
/** Always written by init. cursor, gemini and windsurf are added when the project already uses them (see detectTargets). */
export const DEFAULT_TARGETS: Target[] = ["vscode", "claude", "claude-hooks", "copilot", "copilot-hooks", "agents"];

async function exists(file: string): Promise<boolean> {
  return fs
    .access(file)
    .then(() => true)
    .catch(() => false);
}

/** Default targets plus the other agents whose config folders or files are already in the project. */
export async function detectTargets(root: string): Promise<Target[]> {
  const targets = [...DEFAULT_TARGETS];
  const any = async (...names: string[]) => (await Promise.all(names.map((name) => exists(path.join(root, name))))).some(Boolean);
  if (await any(".cursor", ".cursorrules")) targets.push("cursor");
  if (await any(".gemini", "GEMINI.md")) targets.push("gemini");
  if (await any(".windsurf", ".devin", ".windsurfrules")) targets.push("windsurf");
  return targets;
}

export const LAUNCH_MODES = ["npx", "global", "local"] as const;
export type LaunchMode = (typeof LAUNCH_MODES)[number];

export interface ServerCommand {
  command: string;
  args: string[];
}

/** How an MCP host should start the server: from npm via npx, a global install, or this checkout with node. */
export function serverCommand(mode: LaunchMode, entryScript: string, platform = process.platform): {
  vscode: ServerCommand;
  claude: ServerCommand;
} {
  if (mode === "local") {
    const local = { command: "node", args: [entryScript.replace(/\\/g, "/")] };
    return { vscode: local, claude: local };
  }
  const base = mode === "npx" ? { command: "npx", args: ["-y", PACKAGE_NAME] } : { command: PACKAGE_NAME, args: [] };
  // Claude Code on native Windows cannot spawn .cmd shims (npx.cmd, ai-handoff-mcp.cmd) directly; it needs cmd /c.
  const claude = platform === "win32" ? { command: "cmd", args: ["/c", base.command, ...base.args] } : base;
  return { vscode: base, claude };
}

/** The shell command hook entries run. Hooks go through a shell, so .cmd shims work without a wrapper. */
export function toolCommand(mode: LaunchMode, entryScript: string): string {
  if (mode === "local") return `node "${entryScript.replace(/\\/g, "/")}"`;
  return mode === "npx" ? `npx -y ${PACKAGE_NAME}` : PACKAGE_NAME;
}

/** Running from an npm install or the npx cache means the package is published; otherwise it is a local checkout. */
export function detectLaunchMode(entryScript: string): LaunchMode {
  // Global installs live in %APPDATA%\npm\node_modules (Windows) or <prefix>/lib/node_modules (macOS/Linux).
  if (/[\\/](npm|lib)[\\/]node_modules[\\/]/.test(entryScript)) return "global";
  return /[\\/](node_modules|_npx)[\\/]/.test(entryScript) ? "npx" : "local";
}

export const INSTRUCTIONS = `${BLOCK_START}
## AI Handoff (ai-handoff MCP)
This project uses the \`ai-handoff\` MCP server so any AI agent (Claude, Copilot, Cursor, ...) can continue another agent's work.
- At the start of a session, if no "AI Handoff" brief is already in your context, call \`resume_task\` (where available) with \`projectPath\` = the absolute workspace root and \`agent\` = your name. Continue from "Was doing when stopped" and "Next steps".
- Do not read old chat/session transcripts and do not re-explore what the brief explains; read its key files first.
- Hooks record edited files automatically, but only you know the intent: after each meaningful step call \`log_progress\` (step done, what you are doing now, decisions). Usage limits can end your session without warning.
- Before you stop, record verified progress, ordered next steps and real test results with \`update_handoff\` where available, otherwise \`log_progress\`. If no checkpoint exists yet, start one once you understand the task: \`save_handoff\` where available, otherwise \`log_progress\` with \`task\`.
- Record only tests that actually ran. Preserve unrelated changes.
- Without the MCP server (e.g. a cloud agent), read \`.ai-handoff/HANDOFF.md\` if it exists.
${BLOCK_END}`;

export type Action = "created" | "updated" | "unchanged" | "skipped";

export interface InitResult {
  file: string;
  action: Action;
  reason?: string;
}

export interface InitOptions {
  projectPath: string;
  entryScript: string;
  mode?: LaunchMode;
  targets?: Target[];
  force?: boolean;
  platform?: NodeJS.Platform;
  /** Token profile to write to .ai-handoff.json; by default one is chosen from the targets, unless one is set. */
  tokens?: TokenProfile;
}

/**
 * The smallest profile every configured host can work with. minimal drops resume_task, so it needs every host to
 * inject the brief at session start: Claude Code with its hooks, Cursor, Gemini CLI. Visual Studio reads
 * .vscode/mcp.json without hooks, and Windsurf has no session-start event, so either of them means lean.
 */
export function chooseTokenProfile(targets: Set<Target>): { profile: TokenProfile; why: string } {
  if (targets.has("vscode")) return { profile: "lean", why: "Visual Studio also reads .vscode/mcp.json and needs resume_task" };
  if (targets.has("windsurf")) return { profile: "lean", why: "Windsurf cannot inject the brief, so it needs resume_task" };
  if (targets.has("claude") && !targets.has("claude-hooks")) return { profile: "lean", why: "Claude Code without hooks needs resume_task" };
  if (!["claude", "cursor", "gemini"].some((target) => targets.has(target as Target))) {
    return { profile: "lean", why: "no configured host injects the brief" };
  }
  return { profile: "minimal", why: "every configured host injects the brief at session start" };
}

/**
 * Writes the token profile to .ai-handoff.json, keeping every other setting. A profile already set is kept unless
 * one is given explicitly. The chosen profile keeps the default brief budget, so only the tool list changes.
 */
async function upsertTokenProfile(root: string, targets: Set<Target>, explicit?: TokenProfile): Promise<InitResult> {
  const file = path.join(root, ".ai-handoff.json");
  const read = await readJsonObject(file);
  if ("skip" in read) return { file, action: "skipped", reason: `${read.skip}; set "tokens": { "profile": ... } yourself` };
  const { existing, config } = read;
  const current = config.tokens as { profile?: unknown } | undefined;
  if (!explicit && current && typeof current === "object" && current.profile !== undefined) {
    return { file, action: "unchanged", reason: `token profile "${String(current.profile)}" kept` };
  }
  const { profile, why } = explicit ? { profile: explicit, why: "chosen with --tokens" } : chooseTokenProfile(targets);
  const tokens = { ...(current && typeof current === "object" ? current : {}), profile, ...(explicit ? {} : { briefChars: 6000 }) };
  const result = await writeJson(file, existing, { ...config, tokens });
  return { ...result, reason: `token profile "${profile}": ${why}` };
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeFile(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type JsonObject = Record<string, unknown>;

/** Reads a JSON object file; null with a reason when it is not plain JSON (e.g. JSON with comments). */
async function readJsonObject(file: string): Promise<{ existing: string | null; config: JsonObject } | { skip: string }> {
  const existing = await readIfExists(file);
  if (existing === null || !existing.trim()) return { existing, config: {} };
  let config: unknown;
  try {
    config = JSON.parse(existing);
  } catch {
    return { skip: "not plain JSON (comments?)" };
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) return { skip: "top level is not a JSON object" };
  return { existing, config: config as JsonObject };
}

async function writeJson(file: string, existing: string | null, config: JsonObject): Promise<InitResult> {
  const next = JSON.stringify(config, null, 2) + "\n";
  if (existing !== null && existing.trim() && sameJson(JSON.parse(existing), config)) return { file, action: "unchanged" };
  await writeFile(file, next);
  return { file, action: existing === null ? "created" : "updated" };
}

/** Adds the server under `rootKey` without touching other servers. Files that are not plain JSON are left alone. */
async function upsertMcpConfig(file: string, rootKey: "servers" | "mcpServers", entry: JsonObject, force: boolean): Promise<InitResult> {
  const read = await readJsonObject(file);
  if ("skip" in read) {
    return { file, action: "skipped", reason: `${read.skip}; add this under "${rootKey}" yourself: "${SERVER_KEY}": ${JSON.stringify(entry)}` };
  }
  const { existing, config } = read;
  const servers = (config[rootKey] ?? {}) as JsonObject;
  if (servers[SERVER_KEY] !== undefined && !sameJson(servers[SERVER_KEY], entry) && !force) {
    return { file, action: "skipped", reason: `"${SERVER_KEY}" is already configured differently; use --force to replace it` };
  }
  return writeJson(file, existing, { ...config, [rootKey]: { ...servers, [SERVER_KEY]: entry } });
}

/** Matches hook commands written by this tool, whatever launch mode was used. */
export const OWN_HOOK_COMMAND = /\shook (session-start|prompt-submit|pre-tool|post-tool|pre-compact|stop|session-end) --agent \S+( --[a-z]+ \S+)*$/;

function hookCommand(base: string, event: HookEvent, agent: string): string {
  return `${base} hook ${event} --agent ${agent}`;
}

/** Claude Code hook events and the matcher (tool filter) each one uses. */
interface HookSpec {
  /** The host's event name. */
  name: string;
  event: HookEvent;
  matcher?: string;
  /** In the host's unit: seconds for Claude Code and VS Code, milliseconds for Gemini CLI. */
  timeout?: number;
}

/** Claude Code: matcher groups in .claude/settings.json; timeouts in seconds. */
const CLAUDE_HOOKS: HookSpec[] = [
  { name: "SessionStart", event: "session-start", timeout: 20 },
  { name: "UserPromptSubmit", event: "prompt-submit", timeout: 10 },
  { name: "PreToolUse", event: "pre-tool", timeout: 10 },
  { name: "PostToolUse", event: "post-tool", matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash", timeout: 15 },
  { name: "PostToolUseFailure", event: "post-tool", timeout: 15 },
  { name: "PreCompact", event: "pre-compact", timeout: 15 },
  { name: "Stop", event: "stop", timeout: 15 },
  { name: "SessionEnd", event: "session-end", timeout: 15 }
];

/** VS Code agent hooks (Preview), also read by GitHub Copilot CLI: flat lists, no matchers, seconds. */
const VSCODE_HOOKS: HookSpec[] = [
  { name: "SessionStart", event: "session-start", timeout: 20 },
  { name: "UserPromptSubmit", event: "prompt-submit", timeout: 10 },
  { name: "PreToolUse", event: "pre-tool", timeout: 10 },
  { name: "PostToolUse", event: "post-tool", timeout: 15 },
  { name: "PreCompact", event: "pre-compact", timeout: 15 },
  { name: "Stop", event: "stop", timeout: 15 }
];

/** Cursor: .cursor/hooks.json, version 1, flat lists of { command }. */
const CURSOR_HOOKS: HookSpec[] = [
  { name: "sessionStart", event: "session-start" },
  { name: "beforeSubmitPrompt", event: "prompt-submit" },
  { name: "preToolUse", event: "pre-tool" },
  { name: "afterFileEdit", event: "post-tool" },
  { name: "postToolUseFailure", event: "post-tool" },
  { name: "preCompact", event: "pre-compact" },
  { name: "stop", event: "stop" },
  { name: "sessionEnd", event: "session-end" }
];

/** Gemini CLI: matcher groups in .gemini/settings.json like Claude Code, but timeouts in milliseconds. */
const GEMINI_HOOKS: HookSpec[] = [
  { name: "SessionStart", event: "session-start", timeout: 20000 },
  { name: "BeforeAgent", event: "prompt-submit", timeout: 10000 },
  { name: "BeforeTool", event: "pre-tool", matcher: "*", timeout: 10000 },
  { name: "AfterTool", event: "post-tool", matcher: "*", timeout: 15000 },
  { name: "PreCompress", event: "pre-compact", timeout: 15000 },
  { name: "AfterAgent", event: "stop", timeout: 15000 },
  { name: "SessionEnd", event: "session-end", timeout: 15000 }
];

/** Windsurf / Devin Desktop (Cascade): no session-start event; `powershell` is the Windows command. */
const WINDSURF_HOOKS: HookSpec[] = [
  { name: "pre_user_prompt", event: "prompt-submit" },
  { name: "pre_run_command", event: "pre-tool" },
  { name: "pre_write_code", event: "pre-tool" },
  { name: "pre_read_code", event: "pre-tool" },
  { name: "pre_mcp_tool_use", event: "pre-tool" },
  { name: "post_write_code", event: "post-tool" },
  { name: "post_run_command", event: "post-tool" },
  { name: "post_cascade_response", event: "stop" }
];

type HookEntry = { command?: string; powershell?: string; hooks?: HookEntry[] };

function isOurs(entry: HookEntry): boolean {
  return OWN_HOOK_COMMAND.test(entry.command ?? "") || OWN_HOOK_COMMAND.test(entry.powershell ?? "");
}

/**
 * Merges this tool's hooks into a host's hook map, keeping every other hook and replacing older ones of ours
 * (e.g. after switching launch mode). `grouped` hosts nest commands in { matcher, hooks: [...] } groups.
 */
function mergeHooks(
  current: unknown,
  specs: HookSpec[],
  grouped: boolean,
  entry: (spec: HookSpec) => Record<string, unknown>
): Record<string, unknown> {
  const hooks = { ...((current && typeof current === "object" ? current : {}) as Record<string, unknown>) };
  for (const name of new Set(specs.map((spec) => spec.name))) {
    const list = (Array.isArray(hooks[name]) ? hooks[name] : []) as HookEntry[];
    const kept = grouped
      ? list.map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !isOurs(hook)) })).filter((group) => group.hooks.length > 0)
      : list.filter((hook) => !isOurs(hook));
    const ours = specs
      .filter((spec) => spec.name === name)
      .map((spec) => (grouped ? { ...(spec.matcher ? { matcher: spec.matcher } : {}), hooks: [entry(spec)] } : entry(spec)));
    hooks[name] = [...kept, ...ours];
  }
  return hooks;
}

async function upsertHooksFile(
  file: string,
  build: (config: JsonObject) => JsonObject
): Promise<InitResult> {
  const read = await readJsonObject(file);
  if ("skip" in read) return { file, action: "skipped", reason: `${read.skip}; add the hooks from the documentation yourself` };
  return writeJson(file, read.existing, build(read.config));
}

const commandEntry = (base: string, agent: string) => (spec: HookSpec) => ({
  type: "command",
  command: hookCommand(base, spec.event, agent),
  ...(spec.timeout ? { timeout: spec.timeout } : {})
});

function upsertClaudeHooks(file: string, base: string) {
  return upsertHooksFile(file, (config) => ({ ...config, hooks: mergeHooks(config.hooks, CLAUDE_HOOKS, true, commandEntry(base, "claude")) }));
}

function upsertVsCodeHooks(file: string, base: string) {
  return upsertHooksFile(file, (config) => ({ ...config, hooks: mergeHooks(config.hooks, VSCODE_HOOKS, false, commandEntry(base, "copilot")) }));
}

function upsertCursorHooks(file: string, base: string) {
  return upsertHooksFile(file, (config) => ({
    ...config,
    version: 1,
    hooks: mergeHooks(config.hooks, CURSOR_HOOKS, false, (spec) => ({ command: hookCommand(base, spec.event, "cursor") }))
  }));
}

function upsertGeminiSettings(file: string, base: string, server: ServerCommand, force: boolean) {
  return upsertHooksFile(file, (config) => {
    const servers = (config.mcpServers ?? {}) as JsonObject;
    const keep = servers[SERVER_KEY] !== undefined && !force;
    return {
      ...config,
      mcpServers: { ...servers, [SERVER_KEY]: keep ? servers[SERVER_KEY] : { ...server } },
      hooks: mergeHooks(config.hooks, GEMINI_HOOKS, true, commandEntry(base, "gemini"))
    };
  });
}

function upsertWindsurfHooks(file: string, base: string) {
  return upsertHooksFile(file, (config) => ({
    ...config,
    hooks: mergeHooks(config.hooks, WINDSURF_HOOKS, false, (spec) => ({
      command: hookCommand(base, spec.event, "windsurf"),
      powershell: hookCommand(base, spec.event, "windsurf")
    }))
  }));
}

/** Inserts or refreshes the marked instructions block, keeping the rest of the file as it is. */
export async function upsertInstructions(file: string, block = INSTRUCTIONS): Promise<InitResult> {
  const existing = await readIfExists(file);
  if (existing === null) {
    await writeFile(file, block + "\n");
    return { file, action: "created" };
  }
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);
  let next: string;
  if (start !== -1 && end > start) {
    next = existing.slice(0, start) + block + existing.slice(end + BLOCK_END.length);
  } else {
    next = existing.replace(/\s*$/, "") + (existing.trim() ? "\n\n" : "") + block + "\n";
  }
  if (next === existing) return { file, action: "unchanged" };
  await writeFile(file, next);
  return { file, action: "updated" };
}

export async function initProject(options: InitOptions): Promise<InitResult[]> {
  const root = path.resolve(options.projectPath);
  const stats = await fs.stat(root).catch(() => null);
  if (!stats?.isDirectory()) throw new Error(`Project path is not a directory: ${root}`);
  const mode = options.mode ?? detectLaunchMode(options.entryScript);
  const targets = new Set(options.targets ?? (await detectTargets(root)));
  const commands = serverCommand(mode, options.entryScript, options.platform);
  const base = toolCommand(mode, options.entryScript);
  const force = options.force ?? false;
  const results: InitResult[] = [];

  if (targets.has("vscode")) {
    // VS Code (Copilot agent mode) and Visual Studio both read .vscode/mcp.json.
    results.push(await upsertMcpConfig(path.join(root, ".vscode", "mcp.json"), "servers", { type: "stdio", ...commands.vscode }, force));
  }
  if (targets.has("claude")) {
    results.push(await upsertMcpConfig(path.join(root, ".mcp.json"), "mcpServers", { type: "stdio", ...commands.claude }, force));
    results.push(await upsertInstructions(path.join(root, "CLAUDE.md")));
  }
  if (targets.has("claude-hooks")) {
    results.push(await upsertClaudeHooks(path.join(root, ".claude", "settings.json"), base));
  }
  if (targets.has("copilot")) {
    results.push(await upsertInstructions(path.join(root, ".github", "copilot-instructions.md")));
  }
  if (targets.has("copilot-hooks")) {
    // Also read by GitHub Copilot CLI, which understands this VS Code-style format.
    results.push(await upsertVsCodeHooks(path.join(root, ".github", "hooks", "ai-handoff.json"), base));
  }
  if (targets.has("agents")) {
    // AGENTS.md is read by Copilot, Codex, Cursor, Windsurf and others.
    results.push(await upsertInstructions(path.join(root, "AGENTS.md")));
  }
  if (targets.has("cursor")) {
    results.push(await upsertMcpConfig(path.join(root, ".cursor", "mcp.json"), "mcpServers", { ...commands.vscode }, force));
    results.push(await upsertCursorHooks(path.join(root, ".cursor", "hooks.json"), base));
  }
  if (targets.has("gemini")) {
    results.push(await upsertGeminiSettings(path.join(root, ".gemini", "settings.json"), base, commands.vscode, force));
    results.push(await upsertInstructions(path.join(root, "GEMINI.md")));
  }
  if (targets.has("windsurf")) {
    // Devin Desktop reads .devin/hooks.json and falls back to the legacy .windsurf/hooks.json.
    const dir = (await exists(path.join(root, ".devin", "hooks.json"))) ? ".devin" : ".windsurf";
    results.push(await upsertWindsurfHooks(path.join(root, dir, "hooks.json"), base));
  }
  results.push(await upsertTokenProfile(root, targets, options.tokens));
  return results;
}
