import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { HandoffStore } from "./storage.js";
import { getRepoState } from "./git.js";
import { renderBrief, renderContinuationPrompt, renderMarkdown } from "./handoff.js";
import { SERVER_VERSION } from "./version.js";
import { DEFAULT_TARGETS, detectLaunchMode, initProject, INSTRUCTIONS, LAUNCH_MODES, TARGETS, type LaunchMode, type Target } from "./init.js";
import { HOOK_EVENTS, HOSTS, readProjectConfig, runHook, type HookEvent, type Host } from "./hooks.js";
import { analyzePrompt, blockMessage, GATE_MODES, strengthMessage, type GateMode } from "./prompt-gate.js";
import { GUARD_MODES, type GuardMode } from "./loop-guard.js";
import { estimateTokens, TOKEN_PROFILES, tokenSettings, type TokenProfile } from "./tokens.js";

export const ENTRY_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");

export const HELP = `ai-handoff-mcp ${SERVER_VERSION}
Local MCP server that lets one AI coding agent continue another agent's task.

Usage:
  ai-handoff-mcp                     Start the MCP server on stdio (used by VS Code, Claude Code, ...)
  ai-handoff-mcp init [dir]          Configure a project: MCP config, auto-capture hooks, agent instructions
      --only <list>                  Comma list of: ${TARGETS.join(", ")}
                                     (default: ${DEFAULT_TARGETS.join(", ")}, plus cursor/gemini/windsurf
                                     when the project already uses them)
      --all                          Configure every supported agent
      --mode <${LAUNCH_MODES.join("|")}>      How hosts start the tool: npx (from npm), global (after
                                     npm i -g ai-handoff-mcp; fastest hooks), local (node + this checkout)
      --force                        Replace an existing, different "ai-handoff" server entry
      --tokens <standard|lean|minimal>  Token profile for .ai-handoff.json (default: the smallest one
                                     every configured host supports; an existing profile is kept)
  ai-handoff-mcp show [dir] [--full] Print the resume brief for a project
  ai-handoff-mcp export [dir]        Write the checkpoint to HANDOFF.md (--overwrite to replace it)
  ai-handoff-mcp clear [dir] --yes   Delete the project's checkpoint
  ai-handoff-mcp stats [dir]         What the prompt gate, loop guard and handoff did in this project
  ai-handoff-mcp prompt [dir]        Print a continuation prompt to paste into another agent
      --target <agent>               Agent name, default: copilot
  ai-handoff-mcp hook <event>        Run by host hooks with the hook JSON on stdin. Events:
                                     ${HOOK_EVENTS.join(", ")}
      --agent <name>                 claude, copilot, cursor, gemini, windsurf, ...
      --host <format>                Output format: ${HOSTS.join(", ")} (default from --agent)
      --gate <mode>                  Prompt gate: block (default), warn, off
      --guard <mode>                 Loop guard: block (default), warn, off
  ai-handoff-mcp check-prompt "..."  Try the prompt clarity gate on a prompt (--later: mid-session)
  ai-handoff-mcp tokens [dir]        Show how many tokens the tool adds to the model's context for a project
  ai-handoff-mcp --version | --help

Token profile: "tokens": { "profile": "standard" | "lean" } in .ai-handoff.json, or AI_HANDOFF_TOKENS for the server.
Data is stored in ~/.ai-handoff-mcp (override with AI_HANDOFF_DATA_DIR). No network access, no telemetry,
and AI session transcripts are never read.
`;

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  cwd: string;
  readStdin?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
}

/** Reads the hook payload; gives up after timeoutMs so a host that keeps stdin open cannot hang the hook. */
export function readStdin(stream: NodeJS.ReadStream = process.stdin, timeoutMs = 3000): Promise<string> {
  if (stream.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    const finish = () => {
      clearTimeout(timer);
      stream.pause();
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => (data += chunk));
    stream.on("end", finish);
    stream.on("error", finish);
  });
}

interface Parsed {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["only", "target", "agent", "mode", "host", "gate", "guard", "tokens"]);

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2);
      if (inline !== undefined) flags.set(name, inline);
      else if (VALUE_FLAGS.has(name) && argv[i + 1] !== undefined) flags.set(name, argv[++i]);
      else flags.set(name, true);
    } else if (arg === "-h") flags.set("help", true);
    else if (arg === "-v") flags.set("version", true);
    else positional.push(arg);
  }
  return { command: positional.shift() ?? "", positional, flags };
}

/** Runs a non-server command. Returns the process exit code, or null when the MCP server should start. */
export async function runCli(argv: string[], io: CliIo, store = new HandoffStore()): Promise<number | null> {
  const { command, positional, flags } = parseArgs(argv);
  if (flags.has("help") || command === "help") {
    io.out(HELP);
    return 0;
  }
  if (flags.has("version")) {
    io.out(`${SERVER_VERSION}\n`);
    return 0;
  }

  if (command === "hook") {
    const event = positional[0] as HookEvent;
    if (!HOOK_EVENTS.includes(event)) {
      io.err(`hook needs an event: ${HOOK_EVENTS.join(", ")}\n`);
      return 0;
    }
    const agent = flags.get("agent");
    const host = flags.get("host");
    const gate = flags.get("gate");
    const guard = flags.get("guard");
    try {
      const stdin = io.readStdin ? await io.readStdin() : "";
      const result = await runHook(event, typeof agent === "string" ? agent : "other", stdin, {
        store,
        cwd: io.cwd,
        host: HOSTS.includes(host as Host) ? (host as Host) : undefined,
        gate: GATE_MODES.includes(gate as GateMode) ? (gate as GateMode) : undefined,
        guard: GUARD_MODES.includes(guard as GuardMode) ? (guard as GuardMode) : undefined
      });
      io.out(result.stdout);
      if (result.stderr) io.err(result.stderr);
      return result.exitCode ?? 0;
    } catch (error) {
      // A failing hook must never break the agent's session (prompts included: fail open): report and exit 0.
      io.err(`ai-handoff hook ${event} failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return 0;
    }
  }

  if (command === "check-prompt") {
    const prompt = positional.join(" ") || (io.readStdin ? await io.readStdin() : "");
    const verdict = analyzePrompt(prompt, { firstInSession: !flags.has("later"), hasCheckpoint: flags.has("checkpoint") });
    io.out(`${verdict.action} (vagueness ${verdict.score}/100)${verdict.reasons.length ? `: ${verdict.reasons.join(", ")}` : ""}\n`);
    if (verdict.signals && verdict.action === "allow") io.out(`${strengthMessage(verdict)}\n`);
    if (verdict.action === "block") io.out(`\n${blockMessage(verdict)}\n`);
    return verdict.action === "block" ? 1 : 0;
  }

  const dir = path.resolve(io.cwd, positional[0] ?? ".");
  try {
    switch (command) {
      case "":
      case "serve":
        return null;
      case "init": {
        const modeFlag = flags.get("mode");
        if (modeFlag !== undefined && !LAUNCH_MODES.includes(modeFlag as LaunchMode)) {
          throw new Error(`--mode must be one of: ${LAUNCH_MODES.join(", ")}`);
        }
        let targets: Target[] | undefined = flags.has("all") ? [...TARGETS] : undefined;
        const only = flags.get("only");
        if (typeof only === "string") {
          targets = only.split(",").map((item) => item.trim()).filter(Boolean) as Target[];
          const unknown = targets.filter((item) => !TARGETS.includes(item));
          if (unknown.length) throw new Error(`Unknown target(s): ${unknown.join(", ")}. Use: ${TARGETS.join(", ")}`);
        }
        const tokensFlag = flags.get("tokens");
        if (tokensFlag !== undefined && !TOKEN_PROFILES.includes(tokensFlag as TokenProfile)) {
          throw new Error(`--tokens must be one of: ${TOKEN_PROFILES.join(", ")}`);
        }
        const results = await initProject({
          projectPath: dir,
          entryScript: ENTRY_SCRIPT,
          mode: modeFlag as LaunchMode | undefined,
          targets,
          force: flags.has("force"),
          tokens: tokensFlag as TokenProfile | undefined
        });
        for (const result of results) {
          io.out(`${result.action.padEnd(9)} ${path.relative(dir, result.file) || result.file}${result.reason ? ` - ${result.reason}` : ""}\n`);
        }
        if ((modeFlag ?? detectLaunchMode(ENTRY_SCRIPT)) === "npx") {
          // The loop guard runs before every tool call, so a slow start is felt on every step the agent takes.
          io.out(
            "\nNote: hooks will start through npx, which adds about 2-4 s to every tool call (see BENCHMARK.md). For ~0.2 s, run\n" +
              "  npm install -g ai-handoff-mcp && ai-handoff-mcp init --mode global\n"
          );
        }
        io.out("\nDone. Reload VS Code (or restart Claude Code), then ask the agent to resume the task.\n");
        return 0;
      }
      case "show":
      case "prompt": {
        const brief = await projectBrief(store, dir, flags.has("full") ? "full" : "compact");
        const target = flags.get("target");
        io.out(command === "show" ? brief : renderContinuationPrompt(typeof target === "string" ? target : "copilot", brief));
        return 0;
      }
      // The CLI side of the tools the lean and minimal profiles hide from the model.
      case "export": {
        const record = await store.get(dir);
        if (!record) {
          io.err("No checkpoint for this project.\n");
          return 1;
        }
        const file = path.join(dir, "HANDOFF.md");
        try {
          await fs.writeFile(file, renderMarkdown(record), { encoding: "utf8", flag: flags.has("overwrite") ? "w" : "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          io.err("HANDOFF.md already exists. Use --overwrite to replace it.\n");
          return 1;
        }
        io.out(`Exported ${file}\n`);
        return 0;
      }
      case "stats": {
        // Facts only: what happened in this project. No estimate of tokens saved is made up here.
        const [stats, prompts] = await Promise.all([store.getStats(dir), store.getPromptState(dir)]);
        const average = stats.briefsInjected ? Math.round(stats.briefChars / stats.briefsInjected / 3.5) : 0;
        io.out(
          [
            `ai-handoff stats for ${dir}${stats.since ? ` (since ${stats.since.slice(0, 10)})` : ""}`,
            "",
            `Prompt gate:  ${prompts.allowed + prompts.blocked} prompts checked, ${prompts.blocked} stopped before reaching the model`,
            `Loop guard:   ${stats.loopDenied} calls denied, ${stats.loopStopped} agents stopped`,
            `Handoff:      ${stats.briefsInjected} briefs injected at session start${average ? ` (~${average} tokens on average)` : ""}, ` +
              `${stats.briefsSkipped} not repeated in a resumed conversation, ${stats.resumes} resume_task calls`,
            `Checkpoints:  ${stats.checkpoints} written by agents; ${stats.nudges} nudges to record the intent`,
            "",
            "Stopping a prompt or a loop costs 0 tokens: both run outside the model. Counters only; nothing else is stored.",
            ""
          ].join("\n")
        );
        return 0;
      }
      case "clear":
        if (!flags.has("yes")) {
          io.err("This deletes the project's checkpoint. Run again with --yes to confirm.\n");
          return 1;
        }
        io.out((await store.delete(dir)) ? "Checkpoint deleted.\n" : "No checkpoint existed for this project.\n");
        return 0;
      case "tokens":
        io.out(await tokenReport(store, dir, io.env ?? process.env));
        return 0;
      default:
        io.err(`Unknown command: ${command}\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    io.err(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function projectBrief(store: HandoffStore, dir: string, detail: "compact" | "full"): Promise<string> {
  const [record, config] = await Promise.all([store.get(dir), readProjectConfig(dir)]);
  const { git, changes } = await getRepoState(dir, record?.git ?? null);
  return renderBrief({ projectPath: dir, record, git, changes, detail, maxChars: tokenSettings(config.tokens).briefChars });
}

/** What the model pays for with the project's current settings, measured from the real tool list and brief. */
async function tokenReport(store: HandoffStore, dir: string, env: NodeJS.ProcessEnv): Promise<string> {
  const settings = tokenSettings((await readProjectConfig(dir)).tokens, env.AI_HANDOFF_TOKENS);
  // The MCP SDK is loaded only here and for the server: hook commands run before every tool call and must start fast.
  const [{ Client }, { InMemoryTransport }, { createServer }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/inMemory.js"),
    import("./server.js")
  ]);
  const listTools = async (tools: "all" | "core" | "minimal") => {
    const client = new Client({ name: "ai-handoff-tokens", version: SERVER_VERSION });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer(store, { tools }).connect(serverSide);
    await client.connect(clientSide);
    const { tools: list } = await client.listTools();
    await client.close();
    return list;
  };
  const [exposed, all] = await Promise.all([listTools(settings.tools), listTools("all")]);
  const brief = await projectBrief(store, dir, "compact");
  const n = (value: number) => `~${value.toLocaleString("en-US")}`;
  const row = (label: string, tokens: string, when: string) => `  ${label.padEnd(42)} ${tokens.padEnd(18)} ${when}`;
  const maxBrief = Math.ceil(settings.briefChars / 3.5);
  return [
    `Token budget for ${dir}: profile "${settings.profile}", brief up to ${settings.briefChars} characters`,
    "",
    "Paid by the model:",
    row(`Tool definitions (${exposed.length} of ${all.length} tools)`, n(estimateTokens(JSON.stringify(exposed))), "every request (most hosts cache it)"),
    row("Instructions block (AGENTS.md, CLAUDE.md)", n(estimateTokens(INSTRUCTIONS)), "every session, where init wrote it"),
    row("Brief at session start", `${n(estimateTokens(brief))} (max ${n(maxBrief)})`, "once per session"),
    row("Each log_progress / update_handoff call", "~150-300", "per step the agent records"),
    "",
    "Free (runs outside the model): prompt gate in block mode, prompt strength, loop guard, file capture, Git delta.",
    "Small extras: warn mode ~100 per vague prompt, a loop guard denial ~80.",
    "Estimates at about 3.5 characters per token." +
      (settings.profile === "standard" ? ' "tokens": { "profile": "lean" } keeps only the core tools and a shorter brief.' : ""),
    ...(settings.profile === "minimal"
      ? ["minimal needs a host that injects the brief at session start (Claude Code, VS Code, Cursor, Gemini CLI). Windsurf and Visual Studio need resume_task: use lean there."]
      : []),
    ""
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const code = await runCli(argv, {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    cwd: process.cwd(),
    readStdin: () => readStdin()
  });
  if (code !== null) {
    process.exitCode = code;
    return;
  }
  // stdout belongs to the MCP protocol from here on; diagnostics go to stderr.
  const [{ StdioServerTransport }, { createServer }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("./server.js")
  ]);
  const config = await readProjectConfig(process.cwd());
  const server = createServer(undefined, { tools: tokenSettings(config.tokens, process.env.AI_HANDOFF_TOKENS).tools });
  await server.connect(new StdioServerTransport());
  if (process.stdin.isTTY) {
    process.stderr.write(`ai-handoff-mcp ${SERVER_VERSION} is running on stdio. It is meant to be started by an MCP host; see --help.\n`);
  }
}
