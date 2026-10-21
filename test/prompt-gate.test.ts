import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzePrompt, blockMessage, promptStrength, shouldShowStrength, strengthMessage, warnContext, OVERRIDE_TOKEN } from "../src/prompt-gate.js";
import { CORPUS } from "./prompt-corpus.js";

const first = { firstInSession: true, hasCheckpoint: false };
const later = { firstInSession: false, hasCheckpoint: false };

/** Prompts that should be stopped as the first message of a new session. */
const VAGUE = [
  "fix it",
  "fix the bug",
  "make it better",
  "improve the code",
  "it doesn't work",
  "why is it not working?",
  "refactor everything",
  "clean up the whole project",
  "help me",
  "optimize the app",
  "صلحها",
  "صلح المشكلة",
  "حسن الكود",
  "ليش ما بيشتغل؟",
  "رتب كل المشروع",
  "خليه يشتغل",
  "شوف شو المشكلة",
  "طور التطبيق كله",
  "عدل الكود"
];

/** Prompts that are specific enough and must pass. */
const CLEAR = [
  "In src/auth/login.ts, validateEmail() accepts 'a@b'. It should reject emails without a dot in the domain.",
  "Add a dark mode toggle to the settings page so that the choice is saved in localStorage and restored on reload.",
  "npm test fails with TypeError: Cannot read properties of undefined (reading 'map') in src/list.tsx line 42",
  "Rename getUserData to fetchUserProfile across the api folder and update the imports.",
  "Write unit tests for the parseDate function in utils/date.ts covering empty input, ISO strings and invalid dates.",
  "بملف src/login.ts الدالة validateEmail بتقبل ايميلات غلط، لازم ترفض أي ايميل ما فيه @",
  "أضف زر تسجيل خروج بصفحة الإعدادات بحيث يمسح التوكن ويرجع المستخدم لصفحة الدخول",
  "الصفحة الرئيسية بتعطي خطأ: TypeError undefined بالسطر 42 بملف app.js",
  "اعمل API endpoint جديد /api/orders بيرجع آخر 20 طلب مرتبين حسب التاريخ",
  "What does the useEffect in components/Chart.tsx do?",
  "Explain how authentication works in this repo, starting from middleware/auth.ts"
];

/** Host commands, replies and resume phrases are never stopped. */
const ALWAYS_ALLOWED = [
  "/clear",
  "/mcp__ai-handoff__resume",
  "!npm test",
  "# remember to use pnpm",
  "yes",
  "ok",
  "do it",
  "نعم",
  "تمام",
  "ماشي",
  "كمل",
  "كمّل الشغل",
  "continue",
  "resume the task",
  "keep going from where you left off",
  ""
];

test("stops vague first prompts in English and Arabic", () => {
  for (const prompt of VAGUE) {
    const verdict = analyzePrompt(prompt, first);
    assert.equal(verdict.action, "block", `should block: "${prompt}" (score ${verdict.score})`);
    assert.ok(verdict.reasons.length > 0);
  }
});

test("lets clear prompts through", () => {
  for (const prompt of CLEAR) {
    const verdict = analyzePrompt(prompt, first);
    assert.equal(verdict.action, "allow", `should allow: "${prompt}" (score ${verdict.score}, ${verdict.reasons.join(",")})`);
  }
});

test("never stops host commands, replies or resume requests", () => {
  for (const prompt of ALWAYS_ALLOWED) {
    assert.equal(analyzePrompt(prompt, first).action, "allow", `should allow: "${prompt}"`);
  }
});

test("later in a session short follow-ups pass, but whole-project requests are still stopped", () => {
  for (const prompt of ["fix it", "صلحها", "make it better", "why is it not working?", "now the tests"]) {
    assert.equal(analyzePrompt(prompt, later).action, "allow", `follow-up: "${prompt}"`);
  }
  for (const prompt of ["refactor everything", "رتب كل المشروع", "rewrite the whole codebase"]) {
    assert.equal(analyzePrompt(prompt, later).action, "block", `broad: "${prompt}"`);
  }
});

test("a broad request with real constraints passes", () => {
  const prompt = "Refactor all the files in src/api to use the fetchJson() helper instead of axios, without changing behaviour; run npm test after.";
  assert.equal(analyzePrompt(prompt, first).action, "allow");
});

test("the override token always sends the prompt", () => {
  assert.equal(analyzePrompt(`fix it ${OVERRIDE_TOKEN}`, first).action, "allow");
  assert.equal(analyzePrompt(`${OVERRIDE_TOKEN} صلحها`, first).action, "allow");
});

test("a known task (checkpoint) or attachments make short prompts acceptable", () => {
  assert.equal(analyzePrompt("finish the validation step", { ...first, hasCheckpoint: true }).action, "allow");
  assert.equal(analyzePrompt("fix this", { ...first, attachments: 1 }).action, "allow");
});

test("Arabic word edges: words that merely contain a keyword are not keywords", () => {
  // "هيك" contains "هي" and "مصلحة" contains "صلح"; neither is a vague reference or action.
  const verdict = analyzePrompt("بدي الصفحة هيك بالضبط متل التصميم بملف design.png لمصلحة المستخدم", first);
  assert.equal(verdict.action, "allow", `score ${verdict.score}`);
});

test("threshold is configurable", () => {
  assert.equal(analyzePrompt("update the readme", { ...first, threshold: 101 }).action, "allow");
  assert.equal(analyzePrompt("update the readme with install steps", { ...first, threshold: 1 }).action, "block");
});

test("block messages follow the prompt language and explain how to fix or override", () => {
  const ar = blockMessage(analyzePrompt("صلحها", first));
  assert.match(ar, /ما انصرف أي كريدت/);
  assert.match(ar, /--go/);
  assert.match(ar, /أي ملف أو دالة/);
  const en = blockMessage(analyzePrompt("refactor everything", first));
  assert.match(en, /no credits used/);
  assert.match(en, /Limit it to one module/);
  assert.match(en, /--go/);
  assert.match(warnContext(analyzePrompt("fix it", first)), /ask the user one short clarifying question/);
});

test("prompt strength is the inverse of vagueness, rated against the threshold", () => {
  assert.deepEqual(promptStrength(analyzePrompt("fix it", first)), { strength: 10, level: "vague" });
  assert.deepEqual(promptStrength(analyzePrompt("add a logout button to settings", first)), { strength: 60, level: "weak" });
  assert.equal(promptStrength(analyzePrompt(CLEAR[0], first)).level, "good");
  // A stricter threshold makes the same prompt weak sooner.
  assert.equal(promptStrength(analyzePrompt("add a logout button to the settings page", first), 40).level, "weak");
});

test("signals say what the prompt contains; optional ones only when they apply", () => {
  assert.deepEqual(analyzePrompt("refactor everything", first).signals, { target: false, focusedScope: false, expectedResult: false });
  assert.deepEqual(analyzePrompt("why is it not working?", first).signals, { target: false, focusedScope: true, errorDetails: false });
  assert.deepEqual(analyzePrompt("What does the useEffect in components/Chart.tsx do?", first).signals, { target: true, focusedScope: true });
  for (const prompt of ["/clear", "yes", "تمام", "continue", `fix it ${OVERRIDE_TOKEN}`]) {
    assert.equal(analyzePrompt(prompt, first).signals, undefined, `not rated: "${prompt}"`);
  }
  assert.equal(analyzePrompt("fix it", later).followUp, true);
  assert.equal(analyzePrompt("fix it", first).followUp, undefined);
});

test("strength is shown for weak prompts by default, for all with 'always', never with 'off'", () => {
  const weak = analyzePrompt("add a logout button to settings", first);
  const good = analyzePrompt(CLEAR[0], first);
  const reply = analyzePrompt("yes", first);
  assert.equal(shouldShowStrength(weak, "weak"), true);
  assert.equal(shouldShowStrength(good, "weak"), false);
  assert.equal(shouldShowStrength(good, "always"), true);
  assert.equal(shouldShowStrength(reply, "always"), false, "replies and commands are never rated");
  assert.equal(shouldShowStrength(weak, "off"), false);
});

test("strength messages follow the prompt language, with a checklist and one tip for weak prompts", () => {
  const en = strengthMessage(analyzePrompt("add a logout button to settings", first));
  assert.match(en, /Prompt strength 60\/100 \(weak\)/);
  assert.match(en, /✗ file\/code named  ✓ focused scope/);
  assert.match(en, /Tip: Which file, function/);
  const ar = strengthMessage(analyzePrompt("ليش صفحة الدخول ما بتشتغل", first));
  assert.match(ar, /قوة البرومبت \d+\/100 \(ضعيف\)/);
  assert.match(ar, /✗ تفاصيل الخطأ/);
  assert.match(ar, /نصيحة:/);
  assert.doesNotMatch(strengthMessage(analyzePrompt(CLEAR[0], first)), /Tip:/, "a good prompt gets no tip");
  const followUp = strengthMessage(analyzePrompt("fix it", later));
  assert.match(followUp, /follow-up/);
  assert.doesNotMatch(followUp, /Tip:/, "follow-ups refer to the conversation, so no tip");
  assert.match(blockMessage(analyzePrompt("fix it", first)), /Prompt strength: 10\/100/);
});

test("labelled corpus: no clear prompt is stopped and no vague prompt gets through, in both languages", () => {
  const wrong: string[] = [];
  for (const pair of CORPUS) {
    for (const lang of ["en", "ar"] as const) {
      const verdict = analyzePrompt(pair[lang], first);
      if ((verdict.action === "block") !== (pair.label === "vague")) wrong.push(`${pair.label} ${lang} (${verdict.score}): ${pair[lang]}`);
    }
  }
  assert.deepEqual(wrong, []);
  assert.ok(CORPUS.length >= 40);
});

test("language parity: the same request gets the same decision and a close score in Arabic and English", () => {
  const gaps = CORPUS.map((pair) => {
    const en = analyzePrompt(pair.en, first);
    const ar = analyzePrompt(pair.ar, first);
    assert.equal(ar.action, en.action, `same decision: "${pair.en}" / "${pair.ar}"`);
    return Math.abs(en.score - ar.score);
  });
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  assert.ok(mean <= 5, `mean score gap ${mean.toFixed(1)}`);
  assert.ok(Math.max(...gaps) <= 20, `largest gap ${Math.max(...gaps)}`);
});

test("Arabic attached pronouns count as an unresolved reference, like 'it' in English", () => {
  for (const prompt of ["صلحها", "غيره", "خليه أحسن", "عدلها"]) {
    assert.ok(analyzePrompt(prompt, first).reasons.includes("unresolved-reference"), prompt);
  }
  // "غير" alone means "other/not", and words that only contain a verb are not verbs.
  assert.ok(!analyzePrompt("بدي حل غير هيك بملف api.ts", first).reasons.includes("unresolved-reference"));
  assert.ok(!analyzePrompt("لمصلحة المستخدم", first).reasons.includes("unresolved-reference"));
  assert.equal(analyzePrompt("اعملها", first).action, "allow", "a reply, like 'do it'");
});
