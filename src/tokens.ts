/**
 * Token budget: how much this tool adds to the model's context. Hooks, the prompt gate, the prompt strength and the
 * loop guard run outside the model and cost nothing. The model pays for the tool definitions, the injected brief and
 * the agent's own checkpoint calls, so those are what a profile controls. Tool and field descriptions are never
 * shortened: they are what makes agents write checkpoints the next agent can use.
 */

export const TOKEN_PROFILES = ["standard", "lean", "minimal"] as const;
export type TokenProfile = (typeof TOKEN_PROFILES)[number];

/** What a handoff needs: resume, frequent checkpoints, a final update, a new task. The other tools are conveniences. */
export const CORE_TOOLS = ["resume_task", "log_progress", "update_handoff", "save_handoff"] as const;

/**
 * For hosts that inject the brief at session start (Claude Code, VS Code, Cursor, Gemini CLI): the agent never needs
 * resume_task, and log_progress, given task, keyFiles and blockers too, records everything a checkpoint holds.
 */
export const MINIMAL_TOOLS = ["log_progress"] as const;

/** The brief keeps at least its most important sections (rules, task, current and next steps). */
export const MIN_BRIEF_CHARS = 1500;

export interface TokensConfig {
  profile?: TokenProfile;
  /** Overrides the profile's brief budget, in characters. */
  briefChars?: number;
}

export interface TokenSettings {
  profile: TokenProfile;
  /** all: every tool; core: only CORE_TOOLS; minimal: only MINIMAL_TOOLS. */
  tools: "all" | "core" | "minimal";
  /** Maximum size of the compact brief, in characters. */
  briefChars: number;
}

const PROFILES: Record<TokenProfile, Omit<TokenSettings, "profile">> = {
  standard: { tools: "all", briefChars: 6000 },
  lean: { tools: "core", briefChars: 3000 },
  minimal: { tools: "minimal", briefChars: 3000 }
};

/** Settings from .ai-handoff.json ("tokens"), with an optional profile override (the AI_HANDOFF_TOKENS variable). */
export function tokenSettings(config: TokensConfig | undefined, override?: string): TokenSettings {
  const pick = (value: unknown) => (TOKEN_PROFILES.includes(value as TokenProfile) ? (value as TokenProfile) : undefined);
  const profile = pick(override) ?? pick(config?.profile) ?? "standard";
  const chars = config?.briefChars;
  const briefChars = typeof chars === "number" && chars > 0 ? Math.max(MIN_BRIEF_CHARS, Math.floor(chars)) : PROFILES[profile].briefChars;
  return { profile, ...PROFILES[profile], briefChars };
}

export function isExposed(tool: string, tools: TokenSettings["tools"]): boolean {
  if (tools === "minimal") return (MINIMAL_TOOLS as readonly string[]).includes(tool);
  return tools === "all" || (CORE_TOOLS as readonly string[]).includes(tool);
}

/** Rough token count for English and JSON (about 3.5 characters per token). No tokenizer is bundled. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
