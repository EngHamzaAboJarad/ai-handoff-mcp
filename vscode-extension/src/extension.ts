import * as vscode from "vscode";
import { briefFor, checkFor, CONTINUE_PROMPT, statusFor, systemPromptFor } from "./answers.js";

/**
 * @handoff in the VS Code chat. /resume, /status and /check are answered locally, with no model and no tokens;
 * a question in the user's own words goes to the model the user picked in the chat, with the brief as context.
 */
export function activate(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant("ai-handoff.handoff", handle);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "icon.png");
  participant.followupProvider = {
    provideFollowups: (result: vscode.ChatResult) => {
      const after = (result.metadata as { command?: string } | undefined)?.command;
      const followups: vscode.ChatFollowup[] = [];
      if (after !== "resume") followups.push({ prompt: "", command: "resume", label: "Where did the last agent stop?" });
      if (after !== "status") followups.push({ prompt: "", command: "status", label: "Show the status" });
      return followups;
    }
  };
  context.subscriptions.push(participant);
}

export function deactivate(): void {}

async function handle(
  request: vscode.ChatRequest,
  _context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    stream.markdown("Open a project folder first: the checkpoint belongs to a folder.");
    return {};
  }
  const dir = folder.uri.fsPath;
  const result = { metadata: { command: request.command } };

  if (request.command === "check") {
    stream.markdown(checkFor(request.prompt));
    return result;
  }
  if (request.command === "status") {
    stream.markdown(await statusFor(dir));
    return result;
  }

  stream.progress("Reading the checkpoint...");
  const { brief, hasCheckpoint } = await briefFor(dir);
  if (request.command === "resume" || !request.prompt.trim()) {
    stream.markdown(brief);
    if (hasCheckpoint) {
      stream.button({
        command: "workbench.action.chat.open",
        arguments: [{ query: CONTINUE_PROMPT, mode: "agent" }],
        title: "Continue in agent mode"
      });
    }
    return result;
  }

  // A question in the user's words: the model the user picked in the chat answers it, from the brief.
  try {
    const messages = [vscode.LanguageModelChatMessage.User(systemPromptFor(brief)), vscode.LanguageModelChatMessage.User(request.prompt)];
    const response = await request.model.sendRequest(messages, {}, token);
    for await (const fragment of response.text) stream.markdown(fragment);
  } catch (error) {
    const reason = error instanceof vscode.LanguageModelError && error.code ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
    stream.markdown(`The chat model could not answer (${reason}). \`/resume\` and \`/status\` work without a model.`);
  }
  return result;
}
