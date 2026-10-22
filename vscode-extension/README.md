# AI Handoff for VS Code

**`@handoff` in the chat: see where the last AI agent stopped, rate a prompt before you send it, and continue the task.**

When Claude Code, Copilot, Cursor or another agent runs out of its usage limit mid-task, [ai-handoff-mcp](https://github.com/EngHamzaAboJarad/ai-handoff-mcp) keeps the stopping point. This extension puts it in the VS Code chat.

| Ask | What you get | Model / tokens |
|---|---|---|
| `@handoff /resume` | The brief the next agent gets: task, where the last agent stopped, next steps, files changed after the checkpoint. A button continues in agent mode. | None |
| `@handoff /status` | Task, next step, last checkpoint, and what the prompt gate and loop guard did | None |
| `@handoff /check fix it` | How the prompt gate rates a prompt, with what is missing | None |
| `@handoff what is left?` | An answer from the brief, by the model you picked in the chat | Your chat model |

The three commands run locally with the same code as the ai-handoff hooks and CLI, so the chat and the hooks never disagree. Nothing is sent anywhere, and session transcripts are never read.

## Setup

1. Set up the project once, so agents record checkpoints and the hooks capture the stopping point:

   ```bash
   npm install -g ai-handoff-mcp
   ai-handoff-mcp init --mode global
   ```

2. Install this extension, open the project folder, and type `@handoff` in the chat.

The checkpoint belongs to the first folder of the workspace. Data stays in `~/.ai-handoff-mcp` (or `AI_HANDOFF_DATA_DIR`).

## Requirements

VS Code 1.100 or later with the chat (GitHub Copilot) available. `/resume`, `/status` and `/check` work without a model; free questions use the model selected in the chat.
