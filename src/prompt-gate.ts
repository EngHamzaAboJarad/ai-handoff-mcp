/**
 * Prompt clarity gate: a local, rule-based check that runs when the user submits a prompt, before the model sees it.
 * A vague prompt makes the agent spend many tokens exploring and guessing; stopping it costs nothing, because no
 * model is involved. The prompt is analysed in memory and never stored.
 */

export const GATE_MODES = ["block", "warn", "off"] as const;
export type GateMode = (typeof GATE_MODES)[number];
/** When the prompt strength is shown to the user: never, only for weak prompts that still pass, or for every prompt. */
export const SCORE_DISPLAYS = ["off", "weak", "always"] as const;
export type ScoreDisplay = (typeof SCORE_DISPLAYS)[number];

/** Typed anywhere in a prompt, sends it as it is. */
export const OVERRIDE_TOKEN = "--go";
/** Vagueness score (0-100) at which a prompt is stopped. */
export const DEFAULT_THRESHOLD = 60;

export interface PromptContext {
  /** True when this is the first prompt of the session, so there is no earlier conversation to resolve "it" or "this". */
  firstInSession: boolean;
  /** A handoff checkpoint exists, so the task itself is already known. */
  hasCheckpoint: boolean;
  /** Files attached to the prompt by the host (e.g. Cursor attachments). */
  attachments?: number;
  threshold?: number;
}

export interface PromptVerdict {
  action: "allow" | "block";
  /** 0 = perfectly clear, 100 = says nothing actionable. */
  score: number;
  language: "ar" | "en";
  /** Short codes for what is missing, e.g. "no-target". */
  reasons: string[];
  /** What the prompt contains. Absent when the prompt was not analysed (commands, replies, resume, --go). */
  signals?: PromptSignals;
  /** Scored as a follow-up in a started session, where "it/this" refer to the conversation. */
  followUp?: boolean;
}

/** Each field is true when present. An optional field is absent when it does not apply to the prompt. */
export interface PromptSignals {
  /** A file, function, code, error message, URL or attachment. */
  target: boolean;
  /** Not the whole project. */
  focusedScope: boolean;
  /** "so that ...", "should ...": only asked of requests to change something. */
  expectedResult?: boolean;
  /** The exact error: only asked of "why doesn't it work" prompts. */
  errorDetails?: boolean;
}

const AR = "\\u0600-\\u06FF";
const ARABIC = new RegExp(`[${AR}]`, "u");
const WORD = /[\p{L}\p{N}_]+/gu;

/**
 * Builds a regex from English alternatives (ASCII word boundaries) and Arabic ones. \b does not see Arabic letters,
 * so Arabic word edges are checked explicitly; an optional leading و/ف/ب/ل/ال (and, so, with, for, the) is allowed.
 * With wholeWord the match must also end at a word edge (so "هي" does not match inside "هيك"); otherwise suffixes
 * such as attached pronouns ("صلحها") still match.
 */
function pattern(english: string[], arabic: string[], wholeWord: boolean): RegExp {
  const ar = `(?<![${AR}])(?:[وفبل]|ال)?(?:${arabic.join("|")})${wholeWord ? `(?![${AR}])` : ""}`;
  return new RegExp(`\\b(?:${english.join("|")})\\b|${ar}`, "iu");
}

/** Host commands (slash commands, shell mode, memory notes, mentions): never stopped. */
const HOST_COMMAND = /^\s*[/!#@]/;
/** Replies that only make sense inside a conversation. */
const CONFIRMATION = new RegExp(
  "^(?:y|yes|yep|yeah|no|nope|ok|okay|k|sure|go|go ahead|do it|proceed|continue|next|done|thanks|thank you|nah|" +
    "نعم|لا|لأ|اه|آه|ايوه|أيوه|ايه|إيه|تمام|ماشي|اوكي|أوكي|موافق|نفذ|نفّذ|طبق|طبّق|طيب|كمل|كمّل|يلا|خلص|شكرا|شكراً|مشكور|اعملها|اعمله|سويها|سويه)[\\s.!؟?]*$",
  "iu"
);
const RESUME = pattern(
  ["resume", "continue", "carry on", "keep going", "pick up where", "where (?:you|we) left off"],
  ["كمل", "كمّل", "تابع", "استمر", "استكمل", "كفي", "كفّي"],
  false
);
/** Arabic vague verbs. "غير" (change) only counts with an attached pronoun, because alone it also means "other/not". */
const AR_VAGUE_VERBS = ["صلح", "صلّح", "اصلح", "إصلاح", "حسن", "حسّن", "طور", "طوّر", "رتب", "رتّب", "ظبط", "زبط", "ضبط", "عدل", "عدّل", "اعمل", "سوي", "سوّي", "خلي", "شوف", "افحص", "راجع", "ساعد", "نظف", "نظّف", "أعد", "اعد", "عيد", "دبر", "دبّر"];
const AR_PRONOUN = "(?:ها|ه|هم|هن|و|ياها)";
const VAGUE_ACTION = pattern(
  [
    "fix", "improve", "optimi[sz]e", "clean ?up", "refactor", "enhance", "update", "change", "make it (?:work|better|faster|nicer)",
    "do (?:something|it|that|this)", "help(?: me)?", "sort (?:it|this) out", "handle (?:it|this)", "look at", "check", "review",
    "make", "build", "create", "rewrite", "redo", "rebuild", "redesign"
  ],
  [...AR_VAGUE_VERBS, `غيّ?ر(?=${AR_PRONOUN}(?![${AR}]))`],
  false
);
/**
 * Arabic attaches the object pronoun to the verb ("صلحها" = "fix it"), so "it" is not a separate word as in English.
 * A vague verb with an attached pronoun is the same unresolved reference as "fix it".
 */
const ATTACHED_REF = new RegExp(`(?<![${AR}])[وف]?(?:${[...AR_VAGUE_VERBS, "غيّ?ر"].join("|")})${AR_PRONOUN}(?![${AR}])`, "u");
const DEICTIC = pattern(
  ["it", "this", "that", "these", "those", "the thing", "the issue", "the problem", "the bug", "the error"],
  ["هاد", "هادا", "هذا", "هذه", "هيدا", "هيدي", "هاي", "هي", "هو", "ياها", "ياه", "مشكلة", "المشكلة", "الغلط", "الخطأ", "الشي", "الموضوع"],
  true
);
const BROAD_SCOPE = pattern(
  [
    "everything", "every file", "all (?:the )?(?:files|code|pages|components|tests)",
    "(?:the )?(?:whole|entire|full) (?:project|codebase|app|application|repo|repository|system|code)", "end to end", "from scratch"
  ],
  ["كل (?:المشروع|الملفات|الكود|التطبيق|الصفحات|شي|شيء)", "كلشي", "المشروع (?:كله|كامل|كلو)", "التطبيق (?:كله|كامل|كلو)", "من الصفر", "من اول وجديد"],
  true
);
const WHY_BROKEN = pattern(
  ["why (?:does|doesn'?t|is|isn'?t|won'?t)", "what'?s wrong", "not working", "doesn'?t work", "broken"],
  ["ليش", "ليه", "لماذا", "ما (?:بيشتغل|يشتغل|عم يشتغل|اشتغل|زبط)", "مش شغال", "خربان", "خربت", "مضروب", "شو (?:المشكلة|الغلط|القصة)", "وين (?:المشكلة|الغلط)", "ما المشكلة"],
  false
);
const CRITERIA = pattern(
  ["should", "must", "expected", "instead of", "so that", "acceptance", "without", "only", "returns?", "so it"],
  ["بحيث", "لازم", "يجب", "المطلوب", "النتيجة", "المتوقع", "بدل", "بدون", "فقط", "يرجع", "يرجّع", "يعرض", "لما"],
  false
);

const FILE_REF = /[\w@~-]+(?:[\\/][\w.@~-]+)+|\b[\w-]{2,}\.[a-z]{1,6}\b/i;
const CODE = /`[^`]+`|```|\b[A-Za-z_]\w*\([^)]*\)|\b[a-z]+[A-Z]\w*\b|\b[a-z]+_[a-z_]+\b|\b[A-Z][a-z]+[A-Z]\w*\b/;
const ERROR_TEXT = /\b(?:error|exception|traceback|stack ?trace|failed|undefined|null|NaN|TypeError|SyntaxError|status \d{3}|exit code)\b|خطأ:/i;
const URL = /https?:\/\/\S+/i;
const NUMBER_DETAIL = /\b(?:line|row|port|version|v)\s*\d+|\b\d+(?:px|ms|s|%|kb|mb)\b|سطر\s*\d+|\b\d{2,}\b/i;

function wordCount(text: string): number {
  return (text.match(WORD) ?? []).length;
}

/** Scores how actionable a prompt is. Pure function: no I/O, no model calls. */
export function analyzePrompt(prompt: string, context: PromptContext): PromptVerdict {
  const text = prompt.trim();
  const language = ARABIC.test(text) ? "ar" : "en";
  const allow = (score = 0): PromptVerdict => ({ action: "allow", score, language, reasons: [] });

  if (!text || text.includes(OVERRIDE_TOKEN) || HOST_COMMAND.test(text)) return allow();
  if (CONFIRMATION.test(text)) return allow();
  const words = wordCount(text);
  if (RESUME.test(text) && words <= 12) return allow();

  const lines = text.split(/\r?\n/).filter((line) => line.trim()).length;
  const specific = {
    file: FILE_REF.test(text) || (context.attachments ?? 0) > 0,
    code: CODE.test(text),
    error: ERROR_TEXT.test(text),
    url: URL.test(text),
    number: NUMBER_DETAIL.test(text),
    criteria: CRITERIA.test(text),
    structured: lines >= 3
  };
  const specifics = Object.values(specific).filter(Boolean).length;
  const target = specific.file || specific.code || specific.error || specific.url;
  const vagueAction = VAGUE_ACTION.test(text);
  const deictic = DEICTIC.test(text) || ATTACHED_REF.test(text);
  const broad = BROAD_SCOPE.test(text);
  const whyBroken = WHY_BROKEN.test(text);

  let score = 0;
  const reasons: string[] = [];
  if (words <= 3) score += 35;
  else if (words <= 7) score += 25;
  else if (words <= 14) score += 10;
  if (vagueAction && !target) score += 20;
  if (!target) {
    score += 15;
    reasons.push("no-target");
  }
  if (deictic && context.firstInSession && !target) {
    score += 20;
    reasons.push("unresolved-reference");
  }
  if (broad) {
    score += specifics >= 2 ? 10 : 30;
    reasons.push("broad-scope");
  }
  if (whyBroken && !specific.error) {
    score += 15;
    reasons.push("no-error-details");
  }
  if (!specific.criteria && (vagueAction || broad)) reasons.push("no-expected-result");
  const signals: PromptSignals = {
    target,
    focusedScope: !broad,
    ...(vagueAction || broad ? { expectedResult: specific.criteria } : {}),
    ...(whyBroken ? { errorDetails: specific.error } : {})
  };

  score -= specifics * 15;
  if (words > 25) score -= 15;
  if (words > 50) score -= 20;
  if (context.hasCheckpoint) score -= 15;
  // Later in a session "fix it" refers to what was just discussed; only obviously expensive requests are stopped.
  if (!context.firstInSession) score -= broad ? 20 : 60;
  score = Math.max(0, Math.min(100, score));
  const analysed = { signals, ...(context.firstInSession ? {} : { followUp: true }) };

  if (score < (context.threshold ?? DEFAULT_THRESHOLD)) return { ...allow(score), ...analysed };
  if (!reasons.length) reasons.push("too-short");
  return { action: "block", score, language, reasons, ...analysed };
}

export type StrengthLevel = "good" | "weak" | "vague";

/** Strength is the inverse of vagueness. A prompt is weak from half the threshold up, and vague once it is stopped. */
export function promptStrength(verdict: PromptVerdict, threshold = DEFAULT_THRESHOLD): { strength: number; level: StrengthLevel } {
  const level = verdict.score >= threshold ? "vague" : verdict.score >= threshold / 2 ? "weak" : "good";
  return { strength: 100 - verdict.score, level };
}

/** Whether to tell the user how strong a passing prompt is. Replies and commands are never rated. */
export function shouldShowStrength(verdict: PromptVerdict, display: ScoreDisplay, threshold = DEFAULT_THRESHOLD): boolean {
  if (display === "off" || !verdict.signals) return false;
  return display === "always" || promptStrength(verdict, threshold).level !== "good";
}

const REASONS = {
  en: {
    "no-target": "Which file, function, screen or feature? Name it, or paste the relevant code.",
    "unresolved-reference": "\"it/this\" has nothing to refer to in a new session. Say what you mean.",
    "broad-scope": "The scope is the whole project. Limit it to one module, folder or feature.",
    "no-error-details": "Paste the exact error message, or describe what happens vs. what should happen.",
    "no-expected-result": "Describe the expected result, e.g. \"so that ...\" or \"should return ...\".",
    "too-short": "Say what to change, where, and the expected result."
  },
  ar: {
    "no-target": "أي ملف أو دالة أو شاشة أو ميزة؟ اذكرها بالاسم أو الصق الكود المقصود.",
    "unresolved-reference": "كلمات مثل \"هاد/هي/المشكلة\" ما إلها مرجع بجلسة جديدة. وضّح شو المقصود.",
    "broad-scope": "النطاق هو المشروع كله. حدده بموديول أو مجلد أو ميزة واحدة.",
    "no-error-details": "الصق رسالة الخطأ كما هي، أو اشرح شو بيصير وشو المفروض يصير.",
    "no-expected-result": "اذكر النتيجة المتوقعة، مثلاً \"بحيث ...\" أو \"لازم يرجع ...\".",
    "too-short": "اكتب شو بدك يتغير، ووين، وشو النتيجة المتوقعة."
  }
} as const satisfies Record<"en" | "ar", Record<string, string>>;

const TEXT = {
  en: {
    title:
      "ai-handoff stopped this prompt before it reached the model (no credits used): it is too vague, so the agent would spend many tokens exploring and guessing.",
    example:
      "Example: \"In src/auth/login.ts, validateEmail() accepts 'a@b'. It should reject addresses without a dot in the domain. Add a test in test/login.test.ts.\"",
    override: `To send it unchanged anyway, add ${OVERRIDE_TOKEN} to the prompt.`
  },
  ar: {
    title: "أوقف ai-handoff هذا البرومبت قبل وصوله للنموذج (ما انصرف أي كريدت): البرومبت مش واضح، والوكيل رح يصرف توكنز كتير بالاستكشاف والتخمين.",
    example: "مثال: \"بملف src/auth/login.ts الدالة validateEmail() بتقبل 'a@b'. لازم ترفض أي إيميل ما فيه نقطة بالدومين، وأضف تيست بـ test/login.test.ts\"",
    override: `لإرساله كما هو رغم هيك، أضف ${OVERRIDE_TOKEN} للبرومبت.`
  }
};

const STRENGTH = {
  en: {
    title: "Prompt strength",
    levels: { good: "good", weak: "weak", vague: "too vague" },
    signals: { target: "file/code named", focusedScope: "focused scope", expectedResult: "expected result", errorDetails: "error details" },
    followUp: "follow-up: it/this refer to the conversation",
    tip: "Tip:"
  },
  ar: {
    title: "قوة البرومبت",
    levels: { good: "جيد", weak: "ضعيف", vague: "غامض" },
    signals: { target: "ملف/كود محدد", focusedScope: "نطاق محدد", expectedResult: "النتيجة المتوقعة", errorDetails: "تفاصيل الخطأ" },
    followUp: "متابعة: الإشارات بترجع للمحادثة",
    tip: "نصيحة:"
  }
} as const;

/** The reason shown for each missing signal. */
const SIGNAL_REASON: Record<keyof PromptSignals, string> = {
  target: "no-target",
  focusedScope: "broad-scope",
  expectedResult: "no-expected-result",
  errorDetails: "no-error-details"
};

/**
 * A note for the user: strength, level and a checklist of what the prompt contains, plus the first missing item as a
 * tip when the prompt is weak. It is shown to the user only and never enters the model's context.
 */
export function strengthMessage(verdict: PromptVerdict, threshold = DEFAULT_THRESHOLD): string {
  const t = STRENGTH[verdict.language];
  const { strength, level } = promptStrength(verdict, threshold);
  const signals: PromptSignals = verdict.signals ?? { target: true, focusedScope: true };
  const keys = (Object.keys(t.signals) as (keyof PromptSignals)[]).filter((key) => signals[key] !== undefined);
  const checklist = keys.map((key) => `${signals[key] ? "✓" : "✗"} ${t.signals[key]}`).join("  ");
  let message = `ai-handoff · ${t.title} ${strength}/100 (${t.levels[level]}) · ${checklist}`;
  if (verdict.followUp) message += ` · ${t.followUp}`;
  const missing = keys.find((key) => !signals[key]);
  if (level !== "good" && missing && !verdict.followUp) message += `\n${t.tip} ${reasonText(verdict.language, SIGNAL_REASON[missing])}`;
  return message;
}

function reasonText(language: "ar" | "en", reason: string): string {
  return (REASONS[language] as Record<string, string>)[reason] ?? reason;
}

/** The message shown to the user when a prompt is stopped. */
export function blockMessage(verdict: PromptVerdict): string {
  const t = TEXT[verdict.language];
  const strength = `${STRENGTH[verdict.language].title}: ${100 - verdict.score}/100`;
  return [t.title, strength, "", ...verdict.reasons.map((reason) => `- ${reasonText(verdict.language, reason)}`), "", t.example, t.override].join("\n");
}

/** Context for the model in warn mode, so it asks one question instead of exploring. */
export function warnContext(verdict: PromptVerdict): string {
  return (
    "The user's prompt is vague. Before exploring the codebase or editing anything, ask the user one short clarifying question. Missing: " +
    verdict.reasons.map((reason) => reasonText("en", reason)).join(" ")
  );
}
