<div dir="rtl">

# AI Handoff MCP: الدليل الكامل

أداة محلية (MCP server + hooks) تخلّي أي وكيل ذكاء اصطناعي (GitHub Copilot، Claude Code، Cursor، Codex...) **يكمل المهمة من النقطة اللي توقف عندها الوكيل الثاني بالضبط** لما يخلص الليمت أو تنقطع الجلسة. الوكيل الجديد ما بيحتاج يعيد قراءة الجلسات القديمة أو يستكشف المشروع من الصفر.

- تعمل داخل: **VS Code** (Copilot)، **Visual Studio 2022 (17.14+) و2026**، **Claude Code**، **Copilot CLI**، **Cursor**، **Gemini CLI**، **Windsurf / Devin Desktop**، وأي أداة تانية بتدعم command hooks.
- **فلتر وضوح البرومبت**: البرومبت المش واضح بيتوقف **قبل ما يوصل للنموذج**، يعني ما بيصرف ولا كريدت.
- **حارس الحلقات (Loop Guard)**: الوكيل اللي علق بحلقة وعم يكرر نفسه بيتوقف قبل ما يحرق كريدت أكتر.
- محلية بالكامل: بدون إنترنت وبدون telemetry، و**لا تقرأ سجلات الجلسات (transcripts) أبداً**، و**لا تخزّن نص البرومبتات**.

> **دليل الاستخدام العملي** (التثبيت، والاستخدام اليومي، ووصفات الإعدادات، والمشاكل الشائعة): [USAGE.ar.md](USAGE.ar.md).

### أرقام مقاسة، مش ادعاءات

كل رقم هون جاي من [BENCHMARK.md](BENCHMARK.md) (`npm run bench`، بدون نموذج وبدون إنترنت، والتوكنز تقدير على أساس 3.5 حرف لكل توكن):

| | النتيجة |
|---|---|
| شو بيقرأ الوكيل الجديد ليكمل (المثال: كود هالمشروع، و3 ملفات انعدلت بعد الـ checkpoint) | ~640 توكن، مقابل ~16,000 توكن بس لقراءة `git status` و`git diff` والملفات المعدلة، وهدول كمان ما بيقولوا شو كانت المهمة أو الخطوات الجاية |
| كلفة فلتر البرومبت وقوة البرومبت وحارس الحلقات وتسجيل الملفات | 0 توكن، لأنهم بيشتغلوا برا النموذج |
| الكلفة الثابتة بكل جلسة | تعريفات الأدوات: ~620 توكن (`minimal`)، أو ~2,200 (`lean`)، أو ~3,000 (`standard`)، و~355 لبلوك التعليمات. و`init` بيختار أصغر بروفايل بتدعمه بيئاتك |
| فلتر البرومبت على مجموعته (88 برومبت عربي وإنجليزي) | ولا برومبت واضح انرفض، ولا برومبت غامض مرق، ونفس القرار باللغتين لكل زوج |
| وقت الـ hook | ~0.1 لـ 0.3 ثانية لكل استدعاء أداة مع التثبيت الـ global (و2 لـ 4 ثواني عبر npx)، و~0.4 لـ 0.7 ثانية مرة وحدة ببداية الجلسة، حتى على repo فيه 20,000 ملف |

**شو ما بنقيسه:** قديش توكن بيصرف وكيل حقيقي بالاستكشاف بدون handoff. هاد بيعتمد على النموذج والمهمة، والـ benchmark ما بيشغّل نموذج.

---

## 1. المشكلة اللي بتحلها

لما يخلص ليمت Claude أو Copilot بنص الشغل:

- الوكيل الجديد ما بيعرف شو كانت المهمة، ولا وين وصل، ولا شو القرارات اللي انأخذت.
- بيضطر يعيد قراءة الكود كله أو يقرأ سجل المحادثة القديمة، وهاد بيستهلك context وتوكنز ووقت.
- أخطر شي: آخر خطوة غالباً بتكون **نصها خالص**، والوكيل الجديد ما بيعرف إنها ناقصة.

الحلول اللي بتعتمد على "الوكيل يكتب ملخص قبل ما يوقف" **بتفشل بالضبط بالحالة المهمة**، لأن الليمت ما بيستنى الوكيل يكتب الملخص.

## 2. كيف بتشتغل: ثلاث طبقات مستقلة

```
 جلسة Claude (أو Copilot)                                   جلسة جديدة (أي وكيل)
 ─────────────────────────                                 ──────────────────────
  كل أداة بتخلص  ──►  Hook: post-tool  ──┐
  نهاية كل دور   ──►  Hook: stop        ──┤                  Hook: session-start
  ضغط السياق     ──►  Hook: pre-compact ──┼──► ~/.ai-handoff-mcp/<hash>.json ──► ملخص مضغوط
  الوكيل نفسه    ──►  log_progress /     ──┘           ▲                          بيندمج تلقائياً
                     update_handoff                      │                          بسياق الوكيل الجديد
                                                Git (قراءة فقط): شو تغيّر
                                                بعد آخر checkpoint
```

| الطبقة | مين بيكتبها | بتنجو من الليمت المفاجئ؟ | شو بتعرف |
|---|---|---|---|
| **1. Hooks تلقائية** | البيئة نفسها (Claude Code / VS Code) بعد كل أداة | نعم، آخر أداة **اكتملت** دائماً محفوظة | الملفات اللي انعدّلت، عدد الأدوات، آخر أداة، وهل الدور انتهى طبيعي أو انقطع |
| **2. Checkpoints من الوكيل** | الوكيل عبر `log_progress` و`update_handoff` | لحد آخر استدعاء | **النية**: المهمة، الخطوة الحالية، الخطوات الجاية بالترتيب، القرارات وأسبابها، التيستات |
| **3. فرق Git** | بينحسب لحظة الاستئناف | نعم، دائماً | الـ commits والملفات اللي تغيرت بعد آخر checkpoint، حتى التعديلات غير المحفوظة بـ commit (بصمة لكل ملف بدون ما نكتب شي بالـ repo) |

**النتيجة:** حتى لو الوكيل ما استدعى ولا أداة من أدوات الـ handoff، الـ hooks وGit بيعرفوا وين وقف. ولو استدعاها، بتصير عندك النية كمان.

### تذكير الـ checkpoint: سد فجوة "ليش"

الـ hooks بتعرف **شو** تغيّر، بس ما بتعرف **ليش**. لما الوكيل يخلص دوره بعد ما عدّل 3 ملفات أو أكتر بدون checkpoint، الـ stop hook بيطلب منه **مرة وحدة** ينادي `log_progress`. هاد بيشتغل بـ Claude Code وVS Code وCursor، لأنه الـ stop hook عندهم بيقدر يطلب من الوكيل يكمل. بـ Cursor بيوصل كـ `followup_message`، بس منتدى Cursor نفسه فيه تقارير إنه مش ثابت على Windows. وGemini مستثنى عن قصد، لأنه الـ hook تبعه بيرفض جواب الوكيل الأخير ليجبره يعيد.

- الكلفة: ~120 توكن، وفوقهم خطوة نموذج وحدة للنداء. بهالخطوة النموذج بيقرأ المحادثة لهلأ، وأغلبها بيجي من الـ cache بالبيئات اللي بتدعم prompt caching. وهاد هو نفس النداء اللي التعليمات أصلاً بتطلبه بعد كل خطوة، يعني الوكيل الملتزم ما بيشوف التذكير أبداً.
- ما بيتكرر ورا بعض (Claude Code بيبعت `stop_hook_active`)، وما بيطلب مرة تانية لنفس الـ checkpoint حتى لو الوكيل تجاهله.
- ما بيشتغل أبداً بعد ما يوقف حارس الحلقات الدور، لأنه هيك بيلغي الإيقاف.
- الإعداد: `"checkpointNudge": { "mode": "off" }` أو `"minFiles": 5` بـ `.ai-handoff.json`.

### وكلاء الكلاود: ملف داخل الـ repo (اختياري)

مع `"repoFile": true`، الـ checkpoint بينحفظ كمان بملف `.ai-handoff/HANDOFF.md` جوا المشروع (مع حذف أي توكنات أو كلمات سر)، وبيتحدّث مع كل checkpoint وآخر كل دور. وكلاء الكلاود (Copilot coding agent، Claude Code على الويب، Codex) والوكلاء اللي ما عندهم MCP بيقرأوه، وبلوك التعليمات بيدلّهم عليه. ما في شي بينبعت لأي مكان، وإنت بتقرر إذا بدك تعمله commit. مطفي افتراضياً.

### كيف بيعرف إن الجلسة انقطعت بنص خطوة؟

- آخر حدث `post-tool` وما في بعده `stop`، يعني الجلسة انقطعت بنص دور (ليمت أو crash أو إيقاف)، فالملخص بيكتب: *"most likely stopped mid-step… The last step may be incomplete"*.
- آخر حدث `stop`، يعني الدور خلص بشكل طبيعي.

### تقليل السياق المسترجَع

الملخص (brief) هو الشي الوحيد اللي بيدفع ثمنه الوكيل الجديد من الـ context، لهيك:

- **ميزانية ثابتة**: الحد الأقصى 6000 حرف بالوضع الافتراضي `compact`. بالـ benchmark كان الملخص ~2,250 حرف (~640 توكن) لمهمة فيها checkpoint و3 ملفات انعدلت بعده.
- **تحذير الـ checkpoint القديم**: إذا عمر الـ checkpoint 7 أيام أو أكتر، أو انكتب على branch غير الحالي، الملخص بيبدأ بتحذير إنه لازم يتأكد الوكيل من الخطة مقابل الكود (~30 توكن، وبس بهالحالة).
- **ما بتدفع مرتين**: إذا البيئة بتحمّل بلوك التعليمات أصلاً (CLAUDE.md، AGENTS.md...)، الملخص ما بيكرر القواعد العامة (~80 توكن). والمحادثة اللي بترجعلها (resume) وفيها نفس الملخص ما بتاخده مرة تانية، إلا إذا تغيّر الـ checkpoint أو انضغط السياق (compact). والأداة بتكمّل ذاكرة البيئات نفسها (ذاكرة Claude Code وCopilot Memory) وما بتنافسها: هي بتحفظ معلومات عن المشروع جوا شركة وحدة، ونحنا منحفظ حالة المهمة اللي شغالين عليها، بين كل الشركات.
- **ترتيب حسب الأهمية**: القواعد ← المهمة ← الخطوة الحالية ← الخطوات الجاية ← العوائق ← التغييرات بعد الـ checkpoint ← القرارات ← الملفات المهمة ← حالة Git ← المنجز ← الملفات المعدلة ← التيستات ← الملاحظات ← النشاط الأخير. إذا تجاوزنا الميزانية بتنحذف الأقسام الأقل أهمية أولاً، مع ملاحظة إنه في تفاصيل كاملة متوفرة.
- **حدود لكل قائمة**: مثلاً آخر 6 خطوات منجزة فقط مع "… N earlier"، وأول 15 خطوة جاية، وآخر 5 تيستات.
- **الأقسام الفاضية ما بتظهر أبداً.**
- تيست بيثبت إنه لـ checkpoint ضخم (120 خطوة منجزة و200 ملف و10000 حرف ملاحظات)، الملخص المضغوط أقل من 6000 حرف وأصغر بأكثر من 5 مرات من الـ JSON الخام.
- إذا احتاج الوكيل كل شي: `resume_task` مع `detail: "full"`.

### فلتر وضوح البرومبت (Prompt Clarity Gate)

البرومبت المش واضح، متل "صلحها" أو "fix it" أو "رتب كل المشروع"، بيخلي الوكيل يصرف توكنز كتير بقراءة الملفات والتخمين قبل ما يفهم شو المطلوب. الفلتر بيحل هالمشكلة كالتالي:

1. لحظة ما تبعت البرومبت، الـ hook (`UserPromptSubmit` / `beforeSubmitPrompt` / `BeforeAgent` / `pre_user_prompt`) بيشغّل **تحليل محلي بالقواعد**: بدون نموذج وبدون إنترنت، يعني **صفر كريدت**.
2. التحليل بيعطي البرومبت "درجة غموض" من 0 لـ 100، بالعربي والإنجليزي، حسب هالعوامل:
   - **بيزيد الغموض**: برومبت قصير جداً، فعل غامض بدون هدف ("صلح"، "حسن"، "رتب"، "fix"، "improve")، إشارة بدون مرجع بأول الجلسة ("هاد"، "هي"، "المشكلة"، "it")، نطاق المشروع كله ("كل المشروع"، "everything")، أو "ليش ما بيشتغل" بدون رسالة الخطأ.
   - **بيقلل الغموض**: اسم ملف أو مسار، كود أو اسم دالة، رسالة خطأ، رابط، أرقام (سطر، بورت)، نتيجة متوقعة ("بحيث"، "لازم"، "should")، برومبت طويل أو مرتب بنقاط، ملفات مرفقة، أو checkpoint موجود بيشرح المهمة.
3. إذا الدرجة 60 أو أكثر، البيئة **بترفض البرومبت قبل ما يوصل للنموذج** وبتعرض رسالة بلغة البرومبت نفسها: شو الناقص بالضبط، مع مثال على برومبت واضح.

**شو ما بيتوقف أبداً:** الردود (نعم، تمام، ماشي، yes، ok)، أوامر الاستئناف (كمل، تابع، continue)، أوامر البيئة (`/clear`، `!npm test`)، وأي برومبت فيه `--go`.

**ذكاء الجلسة:** القواعد الصارمة بتنطبق بس على **أول برومبت بالجلسة**. بعدها، "صلحها" بتمرق لأنها بتشير لشي انحكى بالمحادثة، وبس الطلبات اللي بتشمل المشروع كله بتتوقف. البرومبت المرفوض ما بيعتبر بداية جلسة، فلو أعدت كتابته متل ما هو بينفحص من جديد.

**مثال حقيقي من الأداة:**

```text
$ ai-handoff-mcp check-prompt "صلحها"
block (vagueness 90/100): no-target, unresolved-reference, no-expected-result

أوقف ai-handoff هذا البرومبت قبل وصوله للنموذج (ما انصرف أي كريدت): البرومبت مش واضح، والوكيل رح يصرف توكنز كتير بالاستكشاف والتخمين.
قوة البرومبت: 10/100

- أي ملف أو دالة أو شاشة أو ميزة؟ اذكرها بالاسم أو الصق الكود المقصود.
- كلمات مثل "هاد/هي/المشكلة" ما إلها مرجع بجلسة جديدة. وضّح شو المقصود.
- اذكر النتيجة المتوقعة، مثلاً "بحيث ..." أو "لازم يرجع ...".

مثال: "بملف src/auth/login.ts الدالة validateEmail() بتقبل 'a@b'. لازم ترفض أي إيميل ما فيه نقطة بالدومين، وأضف تيست بـ test/login.test.ts"
لإرساله كما هو رغم هيك، أضف --go للبرومبت.
```

**الإعدادات** بملف `.ai-handoff.json` بجذر المشروع:

```json
{ "promptGate": { "mode": "block", "threshold": 60, "showScore": "weak" } }
```

| `mode` | السلوك |
|---|---|
| `block` (الافتراضي) | يرفض البرومبت الغامض قبل النموذج |
| `warn` | يمرّق البرومبت، بس بيضيف تعليمات للوكيل يسأل سؤال توضيح واحد بدل ما يستكشف (Claude / VS Code / Gemini) |
| `off` | يطفي الفلتر |

`threshold` هي الدرجة اللي بيبدأ عندها الرفض. كل ما رفعتها بيصير الفلتر أقل صرامة، و101 معناها ما في رفض أبداً.

**قوة البرومبت:** البرومبت اللي بيمرق بس ضعيف بيطلعلك سطر **إلك إنت بس**. ما بيدخل كونتكست النموذج، فما بيكلف ولا توكن:

```text
ai-handoff · قوة البرومبت 60/100 (ضعيف) · ✗ ملف/كود محدد  ✓ نطاق محدد
نصيحة: أي ملف أو دالة أو شاشة أو ميزة؟ اذكرها بالاسم أو الصق الكود المقصود.
```

القوة = `100 - درجة الغموض`. الإعداد `showScore`: `weak` (الافتراضي: بيظهر لما تكون درجة الغموض نص الـ threshold أو أكتر)، `always` (لكل برومبت)، `off`. الردود والأوامر ما بتتقيّم أبداً. Claude Code وVS Code وGemini بيعرضوه كرسالة، وWindsurf والـ generic على stderr. Cursor ما بيقدر يعرض ملاحظة على برومبت مقبول.

> **الخصوصية:** البرومبت بيتحلل بالذاكرة بس وما بينحفظ. اللي بينحفظ هو أرقام الجلسات وعدادات (كم برومبت انقبل وكم انرفض)، وفي تيست بيتأكد من هالشي.

### حارس الحلقات (Loop Guard)

أحياناً الوكيل بيعلق: بيشغّل نفس التيست مرة ورا مرة بدون ما يغير شي، أو بيعمل تعديل وبيرجع عنه وبيرجع يعمله، أو بيجرب نفس نوع الحل والأمر بيضل يفشل. كل دورة من هدول بتصرف كريدت بدون أي فايدة.

الحارس بيشتغل عبر hook **قبل كل استدعاء أداة** (`PreToolUse` / `preToolUse` / `BeforeTool` / `pre_run_command`...) وبيكشف 4 أنماط:

| القاعدة | شو بتكشف | شو ما بيعتبر حلقة |
|---|---|---|
| **repeat** (تكرار) | نفس الاستدعاء بالضبط (نفس الأداة ونفس المدخلات) للمرة التالتة **بدون ما يتغير شي بينهم**، مثلاً إعادة `npm test` أو إعادة قراءة نفس الملف | دورة "صلّح وجرّب": أي تعديل ملف، أو أمر بيغير الحالة (`git commit`، `npm install`، `rm`، `>`...) بالنص، بيصفّر العداد |
| **ping-pong** (ذهاب وإياب) | تعديل بيلغي التعديل اللي قبله لنفس الملف، وبيرجع يعمله، أكتر من مرة | رجوع واحد عن تعديل (طبيعي) |
| **failing** (فشل متكرر) | نفس الأمر فشل 4 مرات ورا بعض رغم إنه الوكيل عم يعدّل الكود بين المحاولات | الإيقاف اليدوي منك، والنجاح بيصفّر العداد |
| **runaway** (انفلات) | أكتر من 150 استدعاء أداة بدور واحد بدون ما تكتب إنت شي | المهام الطويلة الطبيعية تحت هالحد |

**كيف بيتصرف (على مرحلتين):**

1. **أول مرة** بتنطبق القاعدة: الحارس **بيرفض هالاستدعاء بس**، وبيقول للوكيل ليش، وبيطلب منه يغير طريقته أو يوقف ويسألك، ويسجل الشي بـ `log_progress`.
2. **إذا رجع على نفس القاعدة**: الحارس **بيوقف الوكيل كلياً** (Claude Code وVS Code وGemini بيدعموا هالشي)، وبتطلعلك رسالة **بلغة آخر برومبت كتبته**، مثلاً:

```text
أوقف ai-handoff الوكيل لأنه علق بحلقة، وهيك وفّرنا كريدت: الوكيل شغّل `npm test` أكتر من 3 مرات بدون ما يتغير شي بينهم.
أعطيه توجيه جديد (شو يجرب أو معلومات إضافية)، أو اكتب "كمل" إذا بدك يكمل.
```

- على Cursor وWindsurf ما في طريقة لإنهاء الدور من hook، فالحارس **بيرفض كل استدعاء بعدها** لحتى تكتب إنت برومبت جديد.
- **أول برومبت بتكتبه** بيصفّر كل العدادات، فالوكيل بيرجع يشتغل طبيعي.
- **الإيقاف بينكتب بسجل الـ handoff** (مع إخفاء أي توكن أو باسورد)، فالوكيل الجاي بيعرف إنه هالطريق ما زبط وما بيكرره.
- **الخصوصية:** الحارس بيخزن **hashes وعدادات بس**، بدون نص الأوامر أو محتوى الملفات، وفي تيستات بتتأكد من هالشي (حتى لما الأمر فيه توكن سري).
- إذا بيئتين بلّغوا عن نفس الاستدعاء (متل Copilot CLI لما يقرأ ملفين إعدادات)، بينحسب مرة وحدة بس، عن طريق `tool_use_id` أو نافذة زمنية قصيرة.

**الإعدادات** بنفس ملف `.ai-handoff.json`:

```json
{
  "promptGate": { "mode": "block", "threshold": 60, "showScore": "weak" },
  "loopGuard": { "mode": "block", "repeatLimit": 3, "failLimit": 4, "turnBudget": 150 },
  "checkpointNudge": { "mode": "on", "minFiles": 3 },
  "repoFile": false
}
```

| الإعداد | المعنى |
|---|---|
| `mode` | `block` (الافتراضي: رفض ثم إيقاف)، `warn` (بس تنبيه إلك بدون رفض)، `off` (مطفي) |
| `repeatLimit` | عدد التكرارات المتطابقة اللي بيبدأ عندها الرفض (الحد الأدنى 2) |
| `failLimit` | عدد مرات الفشل المتتالية لنفس الأمر (الحد الأدنى 2) |
| `turnBudget` | الحد الأقصى لاستدعاءات الأدوات بدور واحد، و`0` بيطفي قاعدة الانفلات |

### ميزانية التوكنز: إنت بتقرر قديش بتكلف الأداة

كل شي بيحمي الكريدت تبعك بيشتغل **برا النموذج وبكلفة 0 توكن**: فلتر البرومبت بوضع block، وقوة البرومبت، وحارس الحلقات، وتسجيل الملفات، والـ Git delta. اللي بيدفع حقه النموذج هو تعريفات الأدوات، والملخص اللي بيدخل أول الجلسة، ونداءات الـ checkpoint اللي بيعملها الوكيل. وهدول بتتحكم فيهم ببروفايل بملف `.ai-handoff.json`:

| | `standard` (الافتراضي) | `lean` | `minimal` |
|---|---|---|---|
| الأدوات اللي بيشوفها النموذج | كل الـ 9 (~3,000 توكن) | الـ 4 اللي بيحتاجهم الـ handoff: `resume_task` و`log_progress` و`update_handoff` و`save_handoff` (~2,200 توكن) | بس `log_progress`، وبيصير ياخد كمان `task` و`keyFiles` و`blockers` (~600 توكن) |
| الملخص أول الجلسة | لحد 6,000 حرف (~1,700 توكن) | لحد 3,000 حرف (~860 توكن) | لحد 3,000 حرف |
| أوصاف الأدوات والحقول | متل ما هي | **متل ما هي**: هي اللي بتخلي الـ checkpoint مفيد للوكيل الجاي | متل ما هي |
| بيشتغل على | كل البيئات | كل البيئات | البيئات اللي بتدمج الملخص أول الجلسة: Claude Code وVS Code وCursor وGemini CLI (مش Windsurf ولا Visual Studio، لأنهم بيحتاجوا `resume_task`) |

```json
{ "tokens": { "profile": "lean", "briefChars": 3000 } }
```

`briefChars` بيغيّر حجم الملخص بغض النظر عن البروفايل (الحد الأدنى 1,500). إذا الملخص تجاوز الحجم، بتنحذف الأقسام الأقل أهمية أولاً، و`resume_task` مع `detail: "full"` بيرجع كل شي متل ما هو. الـ hooks بتقرأ الإعداد من المشروع. أما سيرفر الـ MCP فبيقرأه لما يشتغل، من المجلد اللي شغّلته منه البيئة. إذا البيئة بتشغله من مكان تاني (إعدادات على مستوى المستخدم)، حط `AI_HANDOFF_TOKENS=lean` بالـ `env` تبع السيرفر. وبالـ `lean` والـ `minimal`، الـ CLI بيعمل شغل الأدوات المخفية: `show` و`prompt` و`export` و`clear`.

**`init` بيختار البروفايل لحاله**: أصغر بروفايل بتدعمه كل البيئات اللي ركّبها. بيختار `minimal` إذا كل البيئات بتدمج الملخص، و`lean` إذا في `.vscode/mcp.json` (لأنه Visual Studio بيقرأه وما عنده hooks) أو إذا في Windsurf. وبيخلّي حجم الملخص 6,000 حرف متل الافتراضي، يعني اللي بيتغير بس قائمة الأدوات. وما بيلمس بروفايل إنت مختاره. ولتختار بنفسك: `--tokens <profile>`.

**ولا بروفايل بيبعت الوكيل لأداة مش موجودة**: الملخص ورسالة التذكير والـ prompts وتعريفات الأدوات ما بيذكروا غير الأدوات الموجودة بالبروفايل، وفي تيست بيفحصهم كلهم بكل البروفايلات. بلوك التعليمات واحد لكل البروفايلات، فالأدوات اللي مش موجودة بكل البروفايلات مذكورة فيه بعبارة "where available". وبالـ `minimal`، `nextSteps` هي الخطة الباقية كاملة وبتستبدل القائمة، فالوكيل بيقدر يصلّح خطة تغيّرت بدون `update_handoff`.

لتشوف الأرقام الحقيقية لمشروعك: `ai-handoff-mcp tokens`

---

## 3. المتطلبات

- **Node.js 20.11 أو أحدث**
- **Git** (اختياري، بس الطبقة 3 بتحتاجه)
- واحد على الأقل من:
  - VS Code مع GitHub Copilot (Agent Mode). الـ hooks بتحتاج VS Code 1.109+ وهي ميزة Preview.
  - Visual Studio 2022 إصدار 17.14+ أو Visual Studio 2026
  - Claude Code
  - Cursor

---

## 4. التثبيت

### الطريقة أ: من npm (بعد النشر) مع تثبيت global (الأسرع، وهي الموصى بها)

```bash
npm install -g ai-handoff-mcp
cd C:/path/to/your/project
ai-handoff-mcp init --mode global
```

### الطريقة ب: من npm بدون تثبيت

```bash
npx -y ai-handoff-mcp init
```

> ملاحظة: بهالطريقة كل hook بيشتغل عبر `npx`، وهاد بياخذ 2 لـ 4 ثواني لكل استدعاء أداة (مقاس بـ BENCHMARK.md)، و`init` بينبّهك. مع التثبيت الـ global بياخد ~0.1 لـ 0.2 ثانية.

### الطريقة ج: من نسخة محلية من هالمشروع (قبل النشر، أو للتطوير)

```bash
cd C:/Users/haboj/Desktop/ai-handoff-mcp-0.1.0/ai-handoff-mcp
npm install
npm run build
node dist/src/index.js init C:/path/to/your/project --mode local
```

### شو بيكتب أمر `init`؟

| الملف | لمين |
|---|---|
| `.vscode/mcp.json` | VS Code (Copilot) **و Visual Studio 2022/2026** (كلاهما بيقرأ هالملف) |
| `.mcp.json` | Claude Code |
| `CLAUDE.md` | تعليمات Claude |
| `.claude/settings.json` | **Hooks** الالتقاط التلقائي لـ Claude Code |
| `.github/hooks/ai-handoff.json` | **Hooks** الالتقاط التلقائي لـ VS Code Copilot |
| `.github/copilot-instructions.md` | تعليمات Copilot |
| `AGENTS.md` | تعليمات عامة (Codex، Cursor، Windsurf، وغيرهم) |
| `.cursor/mcp.json` + `.cursor/hooks.json` | Cursor (إذا المشروع فيه `.cursor`، أو مع `--all`) |
| `.gemini/settings.json` + `GEMINI.md` | Gemini CLI (إذا فيه `.gemini` أو `GEMINI.md`، أو مع `--all`) |
| `.windsurf/hooks.json` (أو `.devin/hooks.json`) | Windsurf / Devin Desktop (إذا فيه `.windsurf` أو `.devin`، أو مع `--all`) |

كل ملفات الـ hooks بتتضمن **فلتر البرومبت** و**الالتقاط التلقائي** و**حارس الحلقات** مع بعض.

**أمان التعديل:**

- بيدمج مع ملفات JSON الموجودة وما بيمسح سيرفرات أو hooks تانية إلك.
- إذا الملف فيه تعليقات (JSONC) ما بيلمسه، وبيطبعلك شو لازم تضيف بإيدك.
- بيحدّث بس الـ block تبعه بين `<!-- ai-handoff:start -->` و `<!-- ai-handoff:end -->`.
- تشغيله مرتين ما بيكرر شي (idempotent).
- إذا في إعداد `ai-handoff` مختلف، ما بيستبدله إلا مع `--force`.

خيارات إضافية:

```bash
ai-handoff-mcp init --only vscode,copilot-hooks,copilot   # بس ملفات Copilot
ai-handoff-mcp init --only claude,claude-hooks            # بس Claude Code
ai-handoff-mcp init --only cursor                         # Cursor
ai-handoff-mcp init --all                                 # كل الوكلاء المدعومين
```

الأهداف المتاحة: `vscode`، `claude`، `claude-hooks`، `copilot`، `copilot-hooks`، `agents`، `cursor`، `gemini`، `windsurf`

---

## 5. التفعيل داخل كل بيئة

### VS Code (GitHub Copilot)

1. افتح مجلد المشروع، ووافق على **Trust Workspace** (الـ hooks ما بتشتغل بدونها).
2. افتح `.vscode/mcp.json`، بيظهر زر **Start** فوق السيرفر. أو من Command Palette: `MCP: List Servers` ثم ai-handoff ثم Start.
3. بنافذة Copilot Chat اختار وضع **Agent**، ومن زر الأدوات تأكد إن أدوات ai-handoff مفعّلة.
4. الـ hooks: الإعداد `chat.useHooks` مفعّل افتراضياً. خلي `chat.useClaudeHooks` **مطفّى** (هو الافتراضي)، وإلا hooks تبع Claude رح تشتغل كمان داخل VS Code وتتسجل باسم claude.

### Visual Studio 2022 (17.14+) / 2026

1. افتح الـ solution من المجلد اللي فيه `.vscode/mcp.json` (لازم يكون بجذر الـ solution). Visual Studio بيقرأ `<SOLUTIONDIR>\.vscode\mcp.json` تلقائياً.
2. بـ Copilot Chat اختار **Agent**، ثم **Tools**، وفعّل أدوات ai-handoff (الأدوات بتكون مطفاية افتراضياً بـ Visual Studio).
3. للاستئناف: **+ Add Reference** ثم **Prompts** ثم **MCP prompts** ثم `resume`، أو اكتب "resume the task".

> Visual Studio ما عنده hooks موثقة حالياً، فهناك بتشتغل الطبقة 2 (checkpoints الوكيل) والطبقة 3 (فرق Git) بس.

### Claude Code

1. شغّل `claude` داخل مجلد المشروع، رح يسألك توافق على سيرفر `.mcp.json`، وافق.
2. الـ hooks بتنقرأ من `.claude/settings.json`. تقدر تراجعها من الأمر `/hooks` داخل Claude Code بالتيرمنال.
3. أمر الاستئناف اليدوي: `/mcp__ai-handoff__resume`

### GitHub Copilot CLI

بيقرأ نفس ملف `.github/hooks/ai-handoff.json` (بصيغة VS Code)، فالالتقاط التلقائي وحقن الملخص بيشتغلوا بدون أي إعداد إضافي. بس Copilot CLI **ما بيسمح للـ hooks ترفض البرومبت**، فالفلتر ما بيشتغل هناك. الـ MCP بيتضاف من إعدادات Copilot CLI للمستخدم.

### Cursor

```bash
ai-handoff-mcp init --only cursor,agents
```

بيكتب `.cursor/mcp.json` و `.cursor/hooks.json`، وهي الأحداث: `sessionStart` (حقن الملخص)، `beforeSubmitPrompt` (الفلتر)، `afterFileEdit`، `preCompact`، `stop`، `sessionEnd`. Cursor كمان بيخبرنا إذا الدور انتهى بـ `aborted` أو `error`، وهي إشارة مباشرة إنه الجلسة انقطعت.

### Gemini CLI

```bash
ai-handoff-mcp init --only gemini
```

بيضيف سيرفر MCP والـ hooks بـ `.gemini/settings.json` (بدون ما يمسح إعداداتك)، والتعليمات بـ `GEMINI.md`.

> ملاحظة: Gemini CLI صار إلو بديل اسمه Antigravity CLI. الـ adapter مبني على توثيق Gemini CLI.

### Windsurf / Devin Desktop

```bash
ai-handoff-mcp init --only windsurf,agents
```

بيكتب `.windsurf/hooks.json`، أو `.devin/hooks.json` إذا موجود. الأحداث هي: `pre_user_prompt` (الفلتر، بيرفض عبر exit code 2)، `post_write_code`، `post_run_command`، و`post_cascade_response`. Windsurf ما عنده حدث بداية جلسة، فالاستئناف بيعتمد على تعليمات `AGENTS.md`. سيرفر MCP بـ Windsurf بيتضاف من إعدادات المستخدم (`~/.codeium/windsurf/mcp_config.json`).

### أي وكيل تاني (Generic)

أي أداة بتقدر تشغّل أمر وتبعتله JSON على stdin، بتقدر تستخدم:

```bash
ai-handoff-mcp hook post-tool --agent myagent --host generic       # stdin: {"cwd","tool_name","tool_input"}
ai-handoff-mcp hook prompt-submit --agent myagent --host generic   # stdin: {"cwd","session_id","prompt"}
```

عند الرفض: بيطبع `{"decision":"block","continue":false,"reason":...}` على stdout، والرسالة على stderr، وبيخرج بـ exit code 2.

> وحتى الوكلاء اللي ما عندهم hooks ولا MCP، الطبقة 3 (فرق Git) بتشتغل معهم، و`ai-handoff-mcp prompt` بيطبع نص جاهز للصق.

---

## 6. الاستخدام اليومي (سيناريو كامل)

1. **Claude** شغّال على "إضافة صفحة تسجيل دخول":
   - استدعى `save_handoff` بالمهمة والخطوات الجاية.
   - بعد كل خطوة بيستدعي `log_progress` (مثلاً: خلصت "Create the form" وهلق عم اشتغل على "Validate email").
   - الـ hooks بتسجل كل ملف بيتعدل **تلقائياً**.
2. **الليمت خلص** وClaude بنص كتابة `src/validate.ts`.
3. بتفتح **Copilot** بـ VS Code (وضع Agent) وبتكتب أي شي، مثلاً "كمّل".
   - Hook الـ `SessionStart` بيحقن الملخص تلقائياً بسياق Copilot، بدون ما يحتاج يستدعي أي أداة.
   - Copilot بيشوف: المهمة، "Was doing when stopped: Validate email"، الخطوات الجاية، وتحذير إنه `src/validate.ts` تغيّر **بعد** آخر checkpoint وإنه الجلسة غالباً انقطعت بنص خطوة.
4. Copilot بيفحص `src/validate.ts` بس (مش كل المشروع)، بيكمل، وبيستدعي `log_progress` و`update_handoff`.
5. بكرا بترجع لـ Claude، وبيشوف شغل Copilot بنفس الطريقة.

**وكيل بدون MCP؟**

```bash
ai-handoff-mcp prompt --target cursor
```

هالأمر بيطبع نص جاهز تلصقه بأي وكيل.

---

## 7. مثال على الملخص اللي بيوصل للوكيل الجديد

```markdown
# AI Handoff: continue this task

Project: C:\work\shop
Last checkpoint: 2026-10-18T13:56:54Z by claude · status: in_progress

## Rules
- Continue from "Was doing when stopped" and "Next steps"; do not restart the task. Do not read AI chat/session transcripts ...
- Verify the code and Git state before editing, especially anything under "Changes after the last checkpoint". ...
- Call log_progress after each meaningful step and update_handoff before you stop ...

## Task
Add a login page

## Was doing when stopped
Validate email

## Next steps (in order)
1. Validate email
2. Write tests

## Changes after the last checkpoint
Captured automatically (hooks): 3 tool call(s) by claude from ... to ...; last tool: Edit.
The last thing recorded is a tool call with no end-of-turn after it: the session most likely stopped mid-step ...
Files edited by tools:
- src/validate.ts
Git shows work after the last checkpoint that the checkpoint does NOT describe. Inspect it before continuing:
Commits:
3f2a1bc half-done email validation
Files changed since checkpoint:
- src/validate.ts

## Decisions already made (do not revisit)
- Use plain HTML forms, no framework

## Key files (read these first)
- src/login.ts

## Repository now
Branch: main · HEAD: 3f2a1bc0 · HEAD at checkpoint: 7c8b0435
Uncommitted changes:
 M src/validate.ts

## Completed
- Create the form
```

---

## 8. مرجع أدوات MCP

كل الأدوات بتطلب `projectPath` **مسار مطلق** لجذر المشروع (المسارات النسبية مرفوضة)، ومعظمها بتطلب `agent` (اسم الوكيل: claude، copilot، cursor...).

| الأداة | الوظيفة |
|---|---|
| `resume_task` | **أول شي بالجلسة.** بترجع الملخص الكامل (checkpoint + الالتقاط التلقائي + فرق Git + القواعد). `detail: "full"` لكل التفاصيل |
| `log_progress` | checkpoint خفيف ومتكرر: `completedStep` (بتنتقل من nextSteps لـ completed تلقائياً إذا النص مطابق)، `currentStep`، `changedFiles`، `tests`، `decisions`، `nextSteps` إضافية، `status` |
| `update_handoff` | تعديل حقول محددة. الحقول المعطاة بتستبدل القديمة، وحقول `append*` بتضيف بدون تكرار (`appendCompleted`، `appendNextSteps`، `appendDecisions`، `appendChangedFiles`، `appendKeyFiles`، `appendTests`، `appendBlockers`) |
| `save_handoff` | checkpoint جديد كامل لمهمة جديدة (بيستبدل الحقول وبيحافظ على السجل الزمني) |
| `get_handoff` | السجل الخام بصيغة JSON |
| `get_project_status` | حالة Git للقراءة فقط: الفرع، HEAD، status، diff stat |
| `prepare_handoff` | نص جاهز للصق بوكيل تاني (`targetAgent`) |
| `export_handoff_markdown` | بيكتب `HANDOFF.md` بالمشروع (ما بيكتب فوق ملف موجود إلا مع `overwrite: true`) |
| `clear_handoff` | بيحذف الـ checkpoint (لازم `confirm: true`) |

**حقول الـ checkpoint:**

| الحقل | المعنى |
|---|---|
| `task` | الهدف العام |
| `status` | `not_started` / `in_progress` / `blocked` / `needs_review` / `done` |
| `currentStep` | شو عم يعمل هلق (ممكن تكون نصها خالصة) |
| `completed` | خطوات خلصت وتم التحقق منها |
| `nextSteps` | الخطوات الجاية **بالترتيب** |
| `decisions` | قرارات انأخذت مع السبب، حتى الوكيل الجاي ما يرجع يناقشها |
| `changedFiles` | ملفات انعدّلت |
| `keyFiles` | ملفات لازم الوكيل الجاي يقرأها أولاً بدل ما يستكشف |
| `tests` | تيستات **انشغّلت فعلاً** مع النتيجة |
| `blockers` | عوائق |
| `notes` | أي شي تاني |

**MCP Prompts:**

- `resume`: بيطلب من الوكيل يستدعي `resume_task` ويكمّل.
  - VS Code: `/mcp.ai-handoff.resume`
  - Claude Code: `/mcp__ai-handoff__resume`
- `checkpoint`: بيطلب من الوكيل يحفظ checkpoint كامل هلق.

---

## 9. أوامر CLI

```text
ai-handoff-mcp                       تشغيل سيرفر MCP على stdio (البيئات بتعمله تلقائياً)
ai-handoff-mcp init [dir]            --only <targets> --mode <npx|global|local> --force --tokens <profile>
ai-handoff-mcp show [dir] [--full]   طباعة الملخص
ai-handoff-mcp prompt [dir]          --target <agent>  نص جاهز للصق
ai-handoff-mcp export [dir]          كتابة HANDOFF.md (--overwrite للاستبدال)
ai-handoff-mcp clear [dir] --yes     حذف الـ checkpoint
ai-handoff-mcp stats [dir]           شو عمل فلتر البرومبت وحارس الحلقات والـ handoff (عدادات بس)
ai-handoff-mcp check-prompt "..."    تجربة فلتر البرومبت (--later = منتصف جلسة)
ai-handoff-mcp tokens [dir]          قديش توكن بتضيف الأداة لكونتكست النموذج، حسب إعدادات المشروع
ai-handoff-mcp hook <event>          --agent <name> --host <claude|vscode|cursor|gemini|windsurf|generic>
                                     --gate <block|warn|off> --guard <block|warn|off>
                                     events: session-start | prompt-submit | pre-tool | post-tool | pre-compact | stop | session-end
ai-handoff-mcp --help | --version
```

`--host` بيحدد "لهجة" المخرجات (كل بيئة بتتوقع شكل JSON مختلف)، والافتراضي بيتحدد من `--agent`.

**قواعد أوامر الـ hook:**

- بتقرأ JSON البيئة من stdin، مع مهلة 3 ثواني حتى ما تعلّق أبداً.
- ما بتطبع شي على stdout إلا سياق `SessionStart`.
- **دائماً بتخرج بـ 0**. أي خطأ بيروح على stderr، فمشكلة بالأداة ما بتكسر جلسة الوكيل، والفلتر لو صار فيه خطأ بيمرّق البرومبت (fail open). الاستثناء الوحيد: الرفض المقصود على البيئات اللي بتعتمد exit code 2 (Windsurf وgeneric).
- إذا بيئتين قرأوا نفس الإعدادات وبلّغوا عن نفس الحدث بنفس اللحظة، بينسجّل مرة وحدة بس.
- بتتجاهل استدعاءات أدوات ai-handoff نفسها (لأنها checkpoints مش نشاط).

---

## 10. الخصوصية والتخزين

- **المكان**: `~/.ai-handoff-mcp/<sha256 للمسار>.json`، وبتقدر تغيّره بالمتغير `AI_HANDOFF_DATA_DIR`.
- **الأمان**: صلاحيات الملف 0600، والكتابة atomic (ملف مؤقت ثم rename مع إعادة محاولة على Windows). في كمان **قفل بين العمليات** حتى السيرفر والـ hooks ما يمسحوا تحديثات بعض، وإذا انهارت عملية وتركت قفل، بيتشال تلقائياً بعد 10 ثواني.
- **سجلات الجلسات ممنوعة**: مدخلات الـ hook بتتصفى لقائمة بيضاء (`cwd`، `hook_event_name`، `tool_name`، `tool_input`، `source`) قبل ما يوصلها أي كود تاني. `transcript_path` بينحذف فوراً. وفي تيست بيراقب كل عمليات نظام الملفات وبيثبت إنه ملف الـ transcript **ما بينفتح أبداً**، وإنه محتواه ما بيظهر لا بالتخزين ولا بالمخرجات.
- **البرومبتات ما بتنحفظ**: بيتحلل البرومبت بالذاكرة، وبيتخزن بس رقم الجلسة وعدادات بملف `~/.ai-handoff-mcp/<hash>.prompts.json`.
- **عدادات الاستخدام** لأمر `stats` (البرومبتات اللي انوقفت، ورفض وإيقاف حارس الحلقات، والملخصات وحجمها، والـ checkpoints، والتذكيرات) بتنحفظ جنب الـ checkpoint بملف `<hash>.stats.json`. أرقام بس، بدون نص برومبت أو أوامر أو محتوى ملفات، وفي تيست بيتأكد.
- **بس ملفات داخل المشروع** بتتسجل. أي مسار برا المشروع بيتجاهل.
- **Git للقراءة فقط**: `hash-object` بدون `-w` و`status --no-optional-locks`. وفي تيست بيتأكد إنه ما انكتب ولا object جديد بالـ repo.
- **بدون إنترنت وبدون telemetry.**
- السجل الزمني محدود بـ 50 مدخل، والملفات الملتقطة تلقائياً بـ 100.
- ملفات قديمة من إصدار 0.1.0 بتنقرأ تلقائياً (migration).

---

## 11. الاختبارات

```bash
npm test
```

هالأمر بيعمل build، ثم type-check للكود والتيستات، ثم بيشغل **189 تيست** (كلها ناجحة وقت كتابة هالدليل). التيستات بتغطي:

| الملف | شو بيغطي |
|---|---|
| `test/storage.test.ts` | الحفظ والقراءة، السجل الزمني وحده، عدم تصادم المشاريع، حساسية حالة الأحرف على Windows، قراءة إصدار 0.1.0، ملف تالف، كتابات متزامنة بدون فقدان (القفل)، قفل عالق، الالتقاط التلقائي |
| `test/handoff.test.ts` | دمج التحديثات، `log_progress`، **ميزانية حجم الملخص** (checkpoint ضخم أقل من 6000 حرف وأصغر 5 مرات من JSON)، ترتيب الأولويات، شرح الانقطاع بنص خطوة |
| `test/git.test.ts` | بدون Git، repo بدون commits، أسماء ملفات عربية، commits وملفات بعد الـ checkpoint، **تعديلات غير محفوظة كانت موجودة وقت الـ checkpoint ما بتنعرض كأنها جديدة**، revert وحذف، **ما في أي كتابة بالـ repo** |
| `test/hooks.test.ts` | تصفية المدخلات، استخراج المسارات من أشكال Claude وVS Code، تجاهل أدوات الأداة نفسها، حقن الملخص بـ SessionStart، **الـ transcript ما بينفتح أبداً**، **سيناريو كامل: Claude ما عمل ولا checkpoint، خلص الليمت، وCopilot بياخذ نقطة التوقف رغم هيك** |
| `test/server.test.ts` | كل أدوات MCP عبر client حقيقي، **سيناريو كامل Claude ثم ليمت ثم Copilot ثم Claude**، التحقق من المدخلات، التصدير، الحذف |
| `test/init.test.ts` | كل ملفات الإعداد، الدمج بدون مسح إعدادات المستخدم، استبدال hooks قديمة تبعنا فقط، JSONC، `--force` |
| `test/cli.test.ts` | كل الأوامر، `hook` بيخرج 0 حتى مع بيانات تالفة |
| `test/prompt-gate.test.ts` | **19 برومبت غامض** (عربي وإنجليزي) بيترفضوا، **11 برومبت واضح** بيمرقوا، **16 رد وأمر** ما بيترفضوا أبداً، حدود الكلمات العربية ("هيك" مش "هي")، `--go`، الـ threshold، رسائل بلغة البرومبت، قوة البرومبت ومستوياتها ووضع `showScore` |
| `test/tokens.test.ts` | بروفايلات التوكنز: `lean` بيعرض الأدوات الأساسية الـ 4 **بنفس تعريفاتها حرفياً**، والملخص بيلتزم بالحجم (بأول الجلسة وبـ `resume_task`) مع الحفاظ على المهمة والخطوات الجاية، و`detail: "full"` كامل، وأمر `tokens` |
| `test/handoff-quality.test.ts` | تذكير الـ checkpoint (مرة وحدة، و`stop_hook_active`، وما بيشتغل بعد إيقاف حارس الحلقات، و`minFiles` و`off`، وبس بالبيئات اللي بتدعمه)، وملف `.ai-handoff/HANDOFF.md` (مطفي افتراضياً، وبيحذف التوكنات)، وعدم تكرار القواعد والملخص بالـ resume |
| `test/prompt-corpus.ts` + `test/prompt-gate.test.ts` | 88 برومبت بأزواج عربي/إنجليزي: صفر رفض غلط، وصفر غامض بيمرق، ونفس القرار باللغتين، والفرق بالدرجة ≤ 5 بالمتوسط. والضمائر المتصلة ("صلحها") محسوبة متل "fix it" |
| `test/hosts.test.ts` | أشكال مدخلات ومخرجات **كل بيئة** (Claude، VS Code، Cursor، Gemini، Windsurf، generic)، تتبع الجلسات، أوضاع warn/off، `.ai-handoff.json`، **البرومبت ما بينحفظ**، `aborted` تبع Cursor، منع التكرار بين بيئتين |
| `test/loop-guard.test.ts` | قواعد الحارس الأربعة، دورة "صلّح وجرّب" ما بتنعتبر حلقة، الأوامر اللي بتغير الحالة، رجوع واحد مسموح، إعادة التصفير عند برومبت جديد، وضع warn/off، الرسائل بالعربي، **ما في نص أوامر أو ملفات بالتخزين**، إخفاء التوكنات والباسوردات |
| `test/loop-guard-hooks.test.ts` | الرفض ثم الإيقاف بصيغة **كل بيئة**، الاستمرار بعد برومبت جديد، رسالة الإيقاف بلغة البرومبت، `PostToolUseFailure`، منع العد المزدوج، تجاهل أدوات ai-handoff، الإعدادات، تسجيل الإيقاف للوكيل الجاي بدون أسرار |
| `test/stdio.test.ts` | تشغيل `dist` كعملية حقيقية عبر stdio، **وتشغيل أوامر الـ hook عبر shell حقيقي** متل ما بتعمل البيئات (بما فيها رفض البرومبت بـ JSON لـ Claude وبـ exit code 2 لـ Windsurf، والحارس: رفض ثم إيقاف) |

غير هيك، انفحصت الحزمة المنشورة نفسها: `npm pack`، ثم تثبيت الـ tarball بمجلد منفصل، ثم اتصال MCP (9 أدوات و2 prompts)، ثم hook الـ session-start، ثم `check-prompt`، ثم `init` مع اكتشاف Cursor وGemini تلقائياً.

---

<a id="النشر"></a>

## 12. النشر

### 12.1 تجهيز الأسماء (إلزامي)

استبدل `YOUR-GITHUB-USERNAME` باسمك على GitHub بـ:

- `package.json`: الحقلين `mcpName` و `repository.url`
- `server.json`: الحقلين `name` و `repository.url`

```bash
npm run check:publish
```

هالسكربت بيرفض النشر طول ما في placeholder، أو إذا الإصدار أو الاسم مش متطابقين بين `package.json` و`server.json`، أو إذا الوصف أطول من 100 حرف.

### 12.2 GitHub

```bash
git init
git add .
git commit -m "AI Handoff MCP 0.3.0"
git branch -M main
git remote add origin https://github.com/YOUR-GITHUB-USERNAME/ai-handoff-mcp.git
git push -u origin main
```

> ملف `.mcp.json` المحلي (فيه مسار من جهازك) موجود بـ `.gitignore`، والقالب موجود بـ `.mcp.json.example`.

### 12.3 npm

```bash
npm view ai-handoff-mcp name   # 404 معناها الاسم متاح (كان متاح وقت الفحص، بس تأكد مرة تانية قبل النشر)
npm login
npm pack --dry-run             # راجع الملفات: dist/src/*.js و README و LICENSE و package.json
npm publish --access public    # prepublishOnly بيشغل كل التيستات وcheck:publish أولاً
npm view ai-handoff-mcp version
```

إذا الاسم صار محجوز، استخدم اسم بـ scope: `@username/ai-handoff-mcp`، وعدّل `identifier` بـ `server.json`، وأوامر `npx` بـ `src/init.ts` (الثابت `PACKAGE_NAME`).

### 12.4 MCP Registry الرسمي (حتى تظهر الأداة بمعرض VS Code و Visual Studio)

السلسلة كالتالي: **MCP Registry الرسمي** ← **GitHub MCP Registry** ← معرض `@mcp` بـ VS Code، وقائمة **Extensions → MCP Registries** بـ Visual Studio.

**1. تثبيت `mcp-publisher` على Windows (PowerShell):**

```powershell
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }
Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"
tar xf mcp-publisher.tar.gz mcp-publisher.exe
rm mcp-publisher.tar.gz
```

بعدها انقل `mcp-publisher.exe` لمجلد موجود بالـ PATH.

**2. تسجيل الدخول والنشر (بعد ما تنشر على npm أولاً):**

```bash
mcp-publisher login github
mcp-publisher publish
```

**3. التحقق:**

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.YOUR-GITHUB-USERNAME/ai-handoff-mcp"
```

**4. بـ VS Code:** فعّل `chat.mcp.gallery.enabled`، وابحث بـ Extensions عن `@mcp ai-handoff`.

> **مهم:** معرض VS Code بيعطي سيرفر MCP بس (الأدوات)، **بدون الـ hooks والتعليمات**. لهيك نصيحتي للمستخدمين: بعد التثبيت من المعرض، يشغّلوا مرة وحدة بالمشروع:
>
> ```bash
> npx -y ai-handoff-mcp init
> ```

**إضافة مباشرة من سطر الأوامر لـ VS Code (بدون معرض):**

```bash
code --add-mcp "{\"name\":\"ai-handoff\",\"command\":\"npx\",\"args\":[\"-y\",\"ai-handoff-mcp\"]}"
```

### 12.5 نشر إصدار جديد

1. ارفع الرقم بـ `package.json` (مثلاً `npm version patch`).
2. حدّث نفس الرقم بـ `server.json` (بمكانين: `version` و `packages[0].version`)، وبـ `SERVER_VERSION` بملف `src/version.ts` (في تيست بيتأكد إنهم متطابقين).
3. `npm publish --access public` ثم `mcp-publisher publish`.
4. حدّث `CHANGELOG.md`.

---

## 13. القيود (بصراحة)

- الـ hooks بتلتقط آخر **أداة اكتملت**. التفكير اللي ما خلص أو تعديل كان عم يتولّد وقت الانقطاع ما حدا بيقدر يرجّعه، والملخص بيوضح هالشي.
- التيستات بتشتغل بالـ CI على Linux وmacOS وWindows، مع Node 20 و22، مع كل push.
- الـ hooks بتعرف **شو** تغيّر بس مش **ليش**. النية بتجي من `log_progress` تبع الوكيل، والتعليمات اللي بيولدها `init` بتطلب منه يستدعيها بعد كل خطوة.
- hooks تبع VS Code لسا **Preview** وممكن يتغير شكلها، وممكن المؤسسة تطفيها. أسماء أدوات التعديل بـ VS Code مش موثقة، فاستخراج المسارات تقريبي، بس فرق Git بيغطي أي شي فات.
- Visual Studio ما عنده hooks موثقة، فهناك بتشتغل الطبقة 2 و3 بس.
- `npx` بيبطّئ الـ hooks (2 لـ 4 ثواني لكل أداة بالقياس)، والتثبيت الـ global بيحل المشكلة (~0.1 لـ 0.2 ثانية).
- **فلتر البرومبت تقريبي (heuristic)**: على مجموعته (88 برومبت عربي وإنجليزي) ما غلط ولا مرة، بس انضبط على نفس المجموعة. يعني هالرقم بيثبت إنه ثابت بقراراته، مش إنه دقيق على برومبتات ما شافها قبل. وممكن يغلط. لهيك في `--go` ووضع `warn` و`threshold`. وهو ما بيشوف المحادثة (لأنا ما منقرأ الـ transcripts)، فالقواعد الصارمة بتنطبق بس على أول برومبت بالجلسة.
- Copilot CLI وVisual Studio ما بيسمحوا للـ hooks ترفض برومبت، فالفلتر ما بيشتغل عندهم.
- **حارس الحلقات** بيشغّل عملية صغيرة قبل كل استدعاء أداة. مع التثبيت الـ global بتاخد ~0.1 لـ 0.2 ثانية، بس عبر `npx` بتزيد 2 لـ 4 ثواني لكل استدعاء، فاستخدم `--mode global`. أنماطه محافظة، بس ممكن يرفض تكرار مقصود مرة وحدة، وساعتها الوكيل بياخد شرح، وإنت بتقدر تقله يكمل.
- Visual Studio ما عنده hooks، فالحارس ما بيشتغل فيه.
- البيانات محلية لكل جهاز (بدون sync، وهاد مقصود).
- إذا فتحت الوكيل من مجلد فرعي بدل جذر المشروع، المفتاح بيختلف. افتح دائماً من جذر المشروع.

---

## 14. حل المشاكل

| المشكلة | الحل |
|---|---|
| الأدوات ما ظهرت بـ VS Code | `MCP: List Servers` ثم ai-handoff ثم Start / Show Output. تأكد إن `node -v` بيعطي 20.11 أو أحدث |
| Claude Code على Windows ما شغّل السيرفر | لازم `.mcp.json` يستخدم `cmd /c npx ...`، و`init` بيعمل هيك تلقائياً على Windows |
| الملخص ما انحقن تلقائياً | تأكد من Trust Workspace و`chat.useHooks` بـ VS Code، أو `/hooks` بـ Claude Code. وبكل الأحوال الوكيل بيقدر يستدعي `resume_task` |
| `Checkpoint file is not valid JSON` | الملف تالف. احذفه من `~/.ai-handoff-mcp/` أو استدعي `clear_handoff` |
| `Timed out waiting for checkpoint lock` | عملية تانية علقت. القفل بينشال تلقائياً بعد 10 ثواني |
| بدي أشوف الملخص بنفسي | `ai-handoff-mcp show` أو `ai-handoff-mcp show --full` |
| الفلتر رفض برومبت واضح | أضف `--go` للبرومبت، أو ارفع `threshold` بـ `.ai-handoff.json`، أو استخدم `"mode": "warn"` |
| بدي جرّب الفلتر | `ai-handoff-mcp check-prompt "نص البرومبت"` |
| الحارس وقّف الوكيل | اكتبله توجيه جديد أو "كمل"، فالعدادات بتتصفر. ولو بيوقف بشغل طبيعي، ارفع `repeatLimit` أو `turnBudget`، أو استخدم `"mode": "warn"` |

---

## 15. هيكل المشروع

```
src/
  index.ts     نقطة الدخول (bin)
  cli.ts       الأوامر: serve, init, show, prompt, hook
  server.ts    أدوات MCP و prompts
  storage.ts   التخزين: atomic + قفل + migration + الالتقاط التلقائي
  handoff.ts   منطق الدمج وبناء الملخص المضغوط
  git.ts       Git للقراءة فقط + بصمات الملفات + التغييرات بعد الـ checkpoint
  hooks.ts     adapters لكل البيئات: توحيد المدخلات + لهجة المخرجات (بدون transcripts)
  prompt-gate.ts  فلتر وضوح البرومبت (محلي، عربي وإنجليزي)
  loop-guard.ts   حارس الحلقات (تكرار، ذهاب وإياب، فشل متكرر، انفلات)
  init.ts      كتابة ملفات الإعداد والـ hooks والتعليمات لكل الوكلاء
test/          189 تيست
scripts/check-publish.mjs   فحص قبل النشر
server.json    تعريف الأداة لـ MCP Registry
```

</div>
