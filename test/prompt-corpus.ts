/**
 * Labelled prompts for measuring the prompt gate, as the first prompt of a session. Each entry is a pair with the
 * same meaning in English and Arabic (Levantine and MSA), so the gate can be checked for language parity.
 * Labels were written by the authors: "vague" = an agent would have to explore or guess, "clear" = actionable as is.
 * Prompts in between are left out on purpose; the gate is judged only where the right answer is obvious.
 */
export interface CorpusPair {
  label: "vague" | "clear";
  en: string;
  ar: string;
}

export const CORPUS: CorpusPair[] = [
  // Vague: no target, no expected result, or the whole project.
  { label: "vague", en: "fix it", ar: "صلحها" },
  { label: "vague", en: "fix the bug", ar: "صلح الغلط" },
  { label: "vague", en: "make it better", ar: "خليه أحسن" },
  { label: "vague", en: "improve the code", ar: "حسن الكود" },
  { label: "vague", en: "it doesn't work", ar: "مش شغال" },
  { label: "vague", en: "why is it not working?", ar: "ليش ما بيشتغل؟" },
  { label: "vague", en: "refactor everything", ar: "رتب كل الكود" },
  { label: "vague", en: "clean up the whole project", ar: "نظف المشروع كله" },
  { label: "vague", en: "help me", ar: "ساعدني" },
  { label: "vague", en: "optimize the app", ar: "حسن أداء التطبيق" },
  { label: "vague", en: "check the code", ar: "افحص الكود" },
  { label: "vague", en: "look at this", ar: "شوف هاد" },
  { label: "vague", en: "redo the design", ar: "عيد التصميم" },
  { label: "vague", en: "rewrite the whole app from scratch", ar: "اكتب التطبيق كله من الصفر" },
  { label: "vague", en: "update the code", ar: "عدل الكود" },
  { label: "vague", en: "fix the problem", ar: "صلح المشكلة" },
  { label: "vague", en: "make it work", ar: "خليه يشتغل" },
  { label: "vague", en: "what's wrong?", ar: "شو المشكلة؟" },
  { label: "vague", en: "review everything", ar: "راجع كل شي" },
  { label: "vague", en: "improve the whole codebase", ar: "طور المشروع كامل" },
  { label: "vague", en: "handle this", ar: "دبر هاد" },
  { label: "vague", en: "it's broken", ar: "خربان" },
  { label: "vague", en: "change it", ar: "غيره" },
  { label: "vague", en: "build the app", ar: "اعمل التطبيق" },

  // Clear: names a file, function, error or concrete result.
  {
    label: "clear",
    en: "In src/auth/login.ts, validateEmail() accepts 'a@b'. It should reject emails without a dot in the domain.",
    ar: "بملف src/auth/login.ts الدالة validateEmail() بتقبل 'a@b'. لازم ترفض أي إيميل ما فيه نقطة بالدومين."
  },
  {
    label: "clear",
    en: "npm test fails with TypeError: Cannot read properties of undefined (reading 'map') in src/list.tsx line 42",
    ar: "npm test بيفشل مع TypeError: Cannot read properties of undefined (reading 'map') بملف src/list.tsx سطر 42"
  },
  {
    label: "clear",
    en: "Rename getUserData to fetchUserProfile across the api folder and update the imports.",
    ar: "غير اسم getUserData لـ fetchUserProfile بكل مجلد api وحدث الـ imports."
  },
  {
    label: "clear",
    en: "Write unit tests for parseDate in utils/date.ts covering empty input, ISO strings and invalid dates.",
    ar: "اكتب unit tests للدالة parseDate بملف utils/date.ts بتغطي الإدخال الفاضي والـ ISO والتواريخ الغلط."
  },
  {
    label: "clear",
    en: "Add a logout button to the settings page so that it clears the token and returns the user to the login page.",
    ar: "أضف زر تسجيل خروج بصفحة الإعدادات بحيث يمسح التوكن ويرجع المستخدم لصفحة الدخول."
  },
  {
    label: "clear",
    en: "Create a GET /api/orders endpoint that returns the last 20 orders sorted by date.",
    ar: "اعمل API endpoint جديد /api/orders بيرجع آخر 20 طلب مرتبين حسب التاريخ."
  },
  {
    label: "clear",
    en: "What does the useEffect in components/Chart.tsx do?",
    ar: "شو بتعمل الـ useEffect بملف components/Chart.tsx؟"
  },
  {
    label: "clear",
    en: "Explain how authentication works in this repo, starting from middleware/auth.ts",
    ar: "اشرحلي كيف بيشتغل تسجيل الدخول بهالمشروع، ابدأ من middleware/auth.ts"
  },
  {
    label: "clear",
    en: "The home page shows TypeError: undefined at line 42 of app.js after login.",
    ar: "الصفحة الرئيسية بتعطي خطأ: TypeError undefined بالسطر 42 بملف app.js بعد تسجيل الدخول."
  },
  {
    label: "clear",
    en: "Change the default port in server/config.ts from 3000 to 8080 and update the README.",
    ar: "غير البورت الافتراضي بملف server/config.ts من 3000 لـ 8080 وحدث الـ README."
  },
  {
    label: "clear",
    en: "Make the navbar in components/Navbar.tsx sticky so it stays visible while scrolling.",
    ar: "خلي الـ navbar بملف components/Navbar.tsx ثابت بحيث يضل ظاهر وقت السكرول."
  },
  {
    label: "clear",
    en: "Remove the unused lodash import from src/utils/format.ts without changing behaviour.",
    ar: "شيل الـ import تبع lodash اللي مش مستخدم من src/utils/format.ts بدون ما يتغير السلوك."
  },
  {
    label: "clear",
    en: "Fix the failing test in test/cart.test.ts: expected 3 items but got 2 after removeItem().",
    ar: "صلح التيست الفاشل بملف test/cart.test.ts: المتوقع 3 عناصر بس طلع 2 بعد removeItem()."
  },
  {
    label: "clear",
    en: "Add pagination to the users table in pages/admin/users.tsx with 25 rows per page.",
    ar: "أضف pagination لجدول المستخدمين بملف pages/admin/users.tsx بحيث كل صفحة فيها 25 صف."
  },
  {
    label: "clear",
    en: "Upgrade react-router from v5 to v6 in src/App.tsx and replace Switch with Routes.",
    ar: "رقي react-router من v5 لـ v6 بملف src/App.tsx وبدل Switch بـ Routes."
  },
  {
    label: "clear",
    en: "Translate the error messages in locales/en.json to Arabic in a new file locales/ar.json.",
    ar: "ترجم رسائل الخطأ اللي بملف locales/en.json للعربي بملف جديد locales/ar.json."
  },
  {
    label: "clear",
    en: "The build fails with SyntaxError: Unexpected token '?' in dist/main.js; set the TypeScript target to ES2019.",
    ar: "الـ build بيفشل مع SyntaxError: Unexpected token '?' بملف dist/main.js، خلي الـ target تبع TypeScript هو ES2019."
  },
  {
    label: "clear",
    en: "Add a dark mode toggle to the settings page so that the choice is saved in localStorage and restored on reload.",
    ar: "أضف زر للوضع الليلي بصفحة الإعدادات بحيث ينحفظ الاختيار بالـ localStorage ويرجع بعد إعادة التحميل."
  },
  {
    label: "clear",
    en: "Validate the phone field in forms/SignupForm.tsx so it only accepts 10 digits starting with 07.",
    ar: "تحقق من حقل الهاتف بملف forms/SignupForm.tsx بحيث يقبل بس 10 أرقام بتبلش بـ 07."
  },
  {
    label: "clear",
    en: "Why does fetchOrders() in services/orders.ts return an empty array when the API responds with status 200?",
    ar: "ليش fetchOrders() بملف services/orders.ts بترجع array فاضي لما الـ API بيرد status 200؟"
  }
];
