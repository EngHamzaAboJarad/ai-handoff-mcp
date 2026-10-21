<div dir="rtl">

# دليل الاستخدام: AI Handoff MCP 0.3.0 (beta)

هاد الدليل العملي: شو بتعمل، وشو رح تشوف. للتفاصيل التقنية الكاملة، شوف [DOCUMENTATION.ar.md](DOCUMENTATION.ar.md)، وبالإنجليزي [README.md](README.md).

**بجملة وحدة:** لما يخلص ليمت وكيل (Claude، Copilot، Cursor...) بنص الشغل، الوكيل اللي بعده بيكمّل من نفس النقطة بالضبط، بدون ما يعيد يستكشف المشروع، وبدون ما يصرف توكنز على هالشي. وفوقها، البرومبت الغامض بيتوقف قبل ما يوصل للنموذج، والوكيل اللي علق بحلقة بيتوقف قبل ما يحرق كريدت.

> **نسخة تجريبية:** كل شي مجرّب (189 تيست) ومقاس ([BENCHMARK.md](BENCHMARK.md))، بس لهلأ على Windows بس، وبدون استخدام حقيقي واسع. إذا لقيت شي غلط، شوف آخر قسم.

---

## 1. قبل ما تبلّش

- **Node.js 20.11 أو أحدث**. لتتأكد: `node --version`
- **Git**: مش إجباري، بس بدونه ما في "شو تغيّر بعد آخر checkpoint".

## 2. التثبيت (3 خطوات)

**الخطوة 1: ثبّت الأداة.** التثبيت الـ global هو الأسرع، لأنه الـ hooks بتاخد ~0.1 لـ 0.3 ثانية بدل 2 لـ 4 ثواني عبر npx.

```bash
npm install -g ai-handoff-mcp
```

> قبل ما تنزل على npm، من نسخة محلية من هالمشروع: `npm install` ثم `npm run build`، وبالخطوة 2 استعمل `node dist/src/index.js init <مسار مشروعك> --mode local`.

**الخطوة 2: جهّز مشروعك.**

```bash
cd path/to/your/project
ai-handoff-mcp init --mode global
```

شو رح تشوف (مثال حقيقي لمشروع Claude Code بس):

```text
created   .mcp.json
created   CLAUDE.md
created   .claude\settings.json
created   AGENTS.md
created   .ai-handoff.json - token profile "minimal": every configured host injects the brief at session start
```

- `init` بيكتب إعدادات MCP والـ hooks والتعليمات لكل وكيل. وإذا لقى مجلدات Cursor أو Gemini أو Windsurf بالمشروع، بيضيفهم كمان. ولكل الوكلاء: `--all`.
- **بيختار بروفايل التوكنز لحاله**: أصغر بروفايل بتدعمه كل وكلائك. إذا اختار شي إنت ما بدك ياه: `--tokens standard` (كل الأدوات)، أو `lean`، أو `minimal`.
- آمن تعيد تشغيله: ما بيمسح إعداداتك، وما بيغيّر بروفايل إنت مختاره.

**الخطوة 3: أعد تشغيل المحرر أو الوكيل**، ووافق على السيرفر والـ hooks لما ينسألك.

- **VS Code**: الـ hooks لسا Preview، فلازم `chat.useHooks` يكون مشغّل.

## 3. الاستخدام اليومي

ما في شي لازم تعمله. هيك بيصير:

1. **Claude شغال على مهمة.** بعد كل خطوة بيسجّل checkpoint (`log_progress`)، والـ hooks بتسجّل كل ملف بيعدّله.
2. **الليمت بيخلص بنص خطوة.** ما في مشكلة: آخر أداة اكتملت محفوظة، وGit بيعرف شو تغيّر.
3. **بتفتح Copilot (أو أي وكيل تاني).** الملخص بيدخل لحاله ببداية الجلسة، والوكيل بيكمّل.

هاد مقتطف من ملخص حقيقي وصل لـ Copilot بعد ما Claude انقطع:

```text
## Task
Validate the email field on the login form

## Was doing when stopped
Writing validateEmail() in src/login.ts

## Next steps (in order)
1. Call validateEmail from the form
2. Add tests in test/login.test.ts
3. Run npm test

## Changes after the last checkpoint
The last thing recorded is a tool call with no end-of-turn after it: the session most likely stopped mid-step
(usage limit, crash or interruption). The last step may be incomplete.
Files changed since checkpoint:
- src/login.ts
```

الملخص كله بهالمثال كان ~511 توكن. والوكيل الجديد بيعرف وين وقف اللي قبله، وإنه آخر خطوة يمكن ناقصة، وأي ملف لازم يتأكد منه أول شي.

**إذا الوكيل ما وصله الملخص لحاله** (Visual Studio وWindsurf ما بيدعموا هالشي):
- VS Code: اكتب `/mcp.ai-handoff.resume`
- Claude Code: اكتب `/mcp__ai-handoff__resume`
- Visual Studio: **+ Add Reference ← Prompts**
- أو ببساطة قلّه: "resume the task".
- لوكيل ما عنده MCP أبداً: `ai-handoff-mcp prompt --target cursor` بيطبعلك نص جاهز تلصقه.

## 4. لما يوقفلك برومبت

البرومبت الغامض بيكلّف توكنز كتير، لأنه الوكيل بيقعد يستكشف ويخمّن. لهيك الأداة **بتوقفه قبل ما يوصل للنموذج**، وهاد بيكلّف **صفر توكن**.

مثال حقيقي، بأول برومبت بالجلسة:

```text
أوقف ai-handoff هذا البرومبت قبل وصوله للنموذج (ما انصرف أي كريدت): البرومبت مش واضح، والوكيل رح يصرف توكنز كتير بالاستكشاف والتخمين.
قوة البرومبت: 10/100

- أي ملف أو دالة أو شاشة أو ميزة؟ اذكرها بالاسم أو الصق الكود المقصود.
- كلمات مثل "هاد/هي/المشكلة" ما إلها مرجع بجلسة جديدة. وضّح شو المقصود.
- اذكر النتيجة المتوقعة، مثلاً "بحيث ..." أو "لازم يرجع ...".
```

| البرومبت | النتيجة |
|---|---|
| `صلحها` | بيتوقف (قوته 10/100) |
| `أضف زر تسجيل خروج بصفحة الإعدادات` | بيمرق، بس بيطلعلك سطر إلك إنت بس: `قوة البرومبت 60/100 (ضعيف) · ✗ ملف/كود محدد` مع نصيحة |
| `بملف src/login.ts الدالة validateEmail بتقبل ايميلات غلط، لازم ترفض أي ايميل ما فيه @` | بيمرق (100/100) |

- **الردود والأوامر ما بتتوقف أبداً**: `تمام`، `كمل`، `yes`، `/clear`، `!npm test`.
- **بنص الجلسة** "صلحها" بتمرق، لأنها بتشير لشي انحكى بالمحادثة. وبس الطلبات اللي بتشمل المشروع كله بتضل تتوقف.
- **بدك تبعته رغم هيك؟** ضيف `--go` لأي مكان بالبرومبت.
- **لتجرّب برومبت قبل ما تبعته**: `ai-handoff-mcp check-prompt "نص البرومبت"`

## 5. لما يعلق الوكيل بحلقة

إذا الوكيل صار يكرر نفس الأمر بدون ما يتغير شي، أو يعدّل ويرجع عن تعديله، أو نفس الأمر بيفشل مرة ورا مرة:

1. **أول مرة** بيترفض الاستدعاء، وبيوصل للوكيل شرح ليغيّر طريقته.
2. **إذا كرّرها**، بيتوقف الوكيل، وبيوصلك إنت شرح بلغة البرومبت تبعك عن الحلقة اللي كان فيها. (Cursor وWindsurf ما بيقدروا يوقفوا الوكيل من hook، فبينرفض كل استدعاء بعدها لحد ما تكتب.)
3. **برومبتك الجاي** بيصفّر العدادات، فبتقدر تقلّه يكمّل عادي.

## 6. أوامر بتحتاجها

| الأمر | شو بيعمل |
|---|---|
| `ai-handoff-mcp show` | بيطبع الملخص اللي رح يوصل للوكيل الجاي (`--full` للتفاصيل كاملة) |
| `ai-handoff-mcp stats` | شو عملت الأداة بمشروعك: برومبتات انوقفت، حلقات انوقفت، ملخصات، checkpoints |
| `ai-handoff-mcp tokens` | قديش توكن بتضيف الأداة لكل جلسة، حسب إعداداتك |
| `ai-handoff-mcp check-prompt "..."` | جرّب برومبت قبل ما تبعته |
| `ai-handoff-mcp prompt --target cursor` | نص جاهز تلصقه لوكيل ما عنده MCP |
| `ai-handoff-mcp export` | بيكتب الـ checkpoint بملف `HANDOFF.md` (`--overwrite` للاستبدال) |
| `ai-handoff-mcp clear --yes` | بيحذف الـ checkpoint (مثلاً بعد ما تخلص المهمة) |

مثال حقيقي لـ `stats`:

```text
Prompt gate:  0 prompts checked, 0 stopped before reaching the model
Loop guard:   0 calls denied, 0 agents stopped
Handoff:      1 briefs injected at session start (~511 tokens on average), 0 not repeated in a resumed conversation, 0 resume_task calls
Checkpoints:  1 written by agents; 0 nudges to record the intent
```

## 7. وصفات إعدادات جاهزة

كل الإعدادات بملف `.ai-handoff.json` بجذر المشروع. انسخ اللي بدك ياه بس:

**بدي أوفّر أكتر شي ممكن** (Claude Code وVS Code وCursor وGemini بس، مش Visual Studio ولا Windsurf):
```json
{ "tokens": { "profile": "minimal" } }
```

**بدي كل الأدوات ترجع:**
```json
{ "tokens": { "profile": "standard" } }
```

**الفلتر عم يوقفلي برومبتات واضحة:**
```json
{ "promptGate": { "mode": "warn" } }
```
بوضع `warn` البرومبت بيمرق، بس الوكيل بيسأل سؤال توضيح واحد بدل ما يستكشف. أو خلّي `block` وارفع `"threshold": 75`.

**ما بدي سطر "قوة البرومبت":**
```json
{ "promptGate": { "showScore": "off" } }
```

**ما بدي تذكير الـ checkpoint:**
```json
{ "checkpointNudge": { "mode": "off" } }
```

**بدي وكلاء الكلاود يكمّلوا كمان** (Copilot coding agent، Claude Code على الويب، Codex):
```json
{ "repoFile": true }
```
هيك بيصير في ملف `.ai-handoff/HANDOFF.md` جوا المشروع. التوكنات وكلمات السر بتنحذف منه، بس الحذف تقريبي، فراجعه قبل ما تعمله commit.

بتقدر تجمع أكتر من إعداد بنفس الملف:
```json
{
  "tokens": { "profile": "minimal" },
  "promptGate": { "mode": "warn" },
  "repoFile": true
}
```

## 8. مشاكل شائعة

| المشكلة | الحل |
|---|---|
| الوكيل الجديد ما وصله الملخص | أعد تشغيل المحرر ووافق على الـ hooks. بـ VS Code شغّل `chat.useHooks`. وبـ Visual Studio وWindsurf استعمل `resume` (القسم 3) |
| كل استدعاء أداة صار بطيء (ثواني) | الـ hooks شغالة عبر npx. ثبّت الأداة global، ثم `ai-handoff-mcp init --mode global` |
| الفلتر وقّف برومبت واضح | ضيف `--go`، أو استعمل `warn` (القسم 7). **وابعتلنا البرومبت**، لأنه هاد اللي بيحسّن الفلتر |
| الوكيل حاول ينادي أداة مش موجودة | حط البروفايل بـ `.ai-handoff.json`، مش بس بـ `AI_HANDOFF_TOKENS`، حتى السيرفر والـ hooks يتفقوا |
| التذكير ما وصل بـ Cursor على Windows | مشكلة معروفة من Cursor نفسه بالـ follow-ups على Windows. الـ hooks بتضل تسجّل الملفات عادي |
| بدي أعرف شو رح يوصل للوكيل الجاي | `ai-handoff-mcp show` |

## 9. شو بتخزن الأداة ووين

- **الـ checkpoint** بـ `~/.ai-handoff-mcp/` على جهازك. بتقدر تغيّر المكان بـ `AI_HANDOFF_DATA_DIR`.
- **ما في إنترنت ولا telemetry.** ولا شي بيطلع من جهازك.
- **سجلات المحادثات (transcripts) ما بتنقرأ أبداً**، وفي تيست بيتأكد من هالشي.
- **البرومبتات ما بتنحفظ**. بينحفظ بس عدادات وأرقام جلسات، والعدادات اللي بيعرضها `stats` أرقام بس.
- **ما في شي جوا مشروعك** غير ملفات الإعدادات اللي بيكتبها `init`، وملف `.ai-handoff/HANDOFF.md` إذا شغّلت `repoFile`.

## 10. حدود النسخة التجريبية، وكيف بتساعدنا

- **لهلأ مجرّبة على Windows بس.** الـ CI جاهز لـ Linux وmacOS، بس رح يشتغل لما يكون المشروع على GitHub.
- **التوفير مقاس كحد أدنى للقراءة**، مش باستهلاك وكيل حقيقي. لتقيسه بنفسك: نفس المهمة، مرة مع الأداة ومرة بدونها، وقارن الاستهلاك اللي بتعرضه البيئة نفسها (مثلاً `/cost` بـ Claude Code).
- **الفلتر انضبط على برومبتات كتبناها نحنا.** كل برومبت بيوقفه وهو واضح، أو بيمرّقه وهو غامض، بيساعدنا نحسّنه. ابعته متل ما هو (بدون أسرار).
- **الـ hooks بتعرف شو تغيّر، بس مش ليش.** النية بتجي من الوكيل لما يسجّل checkpoint، والتذكير بيطلب منه يسجّل إذا نسي.

</div>
