// What @handoff answers lives in the shared source, so the extension and the prompt hooks of every other agent give
// the same answers. The extension shows them as Markdown.
export { briefFor, checkFor, CONTINUE_PROMPT, statusFor, systemPromptFor } from "../../src/chat.js";
