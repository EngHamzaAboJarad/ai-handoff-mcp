import path from "node:path";
import fs from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { HandoffStore, STATUSES, type HandoffRecord } from "./storage.js";
import { getGitSnapshot, getGitStatus, getRepoState } from "./git.js";
import {
  applyProgress,
  describeProgress,
  mergeUpdate,
  normalizeAgent,
  renderBrief,
  renderContinuationPrompt,
  renderMarkdown,
  type BriefDetail
} from "./handoff.js";
import { defaultHost, hasInstructionsBlock, readProjectConfig } from "./hooks.js";
import { isExposed, tokenSettings, type TokenSettings } from "./tokens.js";
import { REPO_FILE, writeRepoFile } from "./repo-file.js";

import { SERVER_NAME, SERVER_VERSION } from "./version.js";

export { SERVER_NAME, SERVER_VERSION };

const projectPathSchema = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value), "projectPath must be an absolute path to the workspace root")
  .describe("Absolute path of the workspace/project root");
const agentSchema = z
  .string()
  .min(1)
  .max(50)
  .describe("Your agent name: claude, copilot, cursor, codex, gemini, or other");
const text = (max: number) => z.string().max(max);
const list = z.array(text(1000)).max(100);
const statusSchema = z.enum(STATUSES);

const fieldShape = {
  task: text(4000).describe("Overall goal of the task"),
  status: statusSchema,
  currentStep: text(2000).describe("What you are doing right now (may be half done)"),
  completed: list.describe("Steps already finished and verified"),
  nextSteps: list.describe("Remaining steps, in order"),
  decisions: list.describe("Decisions taken and why, so the next agent does not revisit them"),
  changedFiles: list.describe("Files created or modified, relative to the project root"),
  keyFiles: list.describe("Files the next agent should read first"),
  tests: list.describe("Tests actually run, with results, e.g. 'npm test: 12 passed'"),
  blockers: list.describe("Problems that stop progress"),
  notes: text(8000).describe("Anything else the next agent must know")
};

function ok(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function requireDirectory(projectPath: string): Promise<string> {
  const root = path.resolve(projectPath);
  let stats;
  try {
    stats = await fs.stat(root);
  } catch {
    throw new Error(`Project path does not exist: ${root}`);
  }
  if (!stats.isDirectory()) throw new Error(`Project path is not a directory: ${root}`);
  return root;
}

function guarded<A>(handler: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  };
}

function summary(record: HandoffRecord): string {
  const next = record.nextSteps[0] ? ` Next: ${record.nextSteps[0]}` : "";
  return (
    `Checkpoint saved for ${record.projectPath} by ${record.updatedBy} at ${record.updatedAt}. ` +
    `Status: ${record.status}; ${record.completed.length} completed, ${record.nextSteps.length} next steps.${next}`
  );
}

/** After every checkpoint write: count it and keep the in-repo file current. Returns a note for the agent, if any. */
async function afterCheckpoint(store: HandoffStore, root: string, record: HandoffRecord): Promise<string> {
  const [note] = await Promise.all([syncRepoFile(root, record), store.bumpStats(root, { checkpoints: 1 })]);
  return note;
}

/** Keeps the optional in-repo checkpoint file current. A failure is reported but never fails the checkpoint. */
async function syncRepoFile(root: string, record: HandoffRecord): Promise<string> {
  if ((await readProjectConfig(root)).repoFile !== true) return "";
  try {
    await writeRepoFile(root, record);
    return "";
  } catch (error) {
    return ` Could not update ${REPO_FILE}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** With the reading agent's name, the general rules are left out when its instructions file already states them. */
async function buildBrief(store: HandoffStore, root: string, detail: BriefDetail = "compact", reader?: string, minimalTools = false): Promise<string> {
  const [record, config, rulesInInstructions] = await Promise.all([
    store.get(root),
    readProjectConfig(root),
    reader ? hasInstructionsBlock(root, defaultHost(reader)) : false
  ]);
  const { git, changes } = await getRepoState(root, record?.git ?? null);
  const maxChars = tokenSettings(config.tokens, process.env.AI_HANDOFF_TOKENS).briefChars;
  return renderBrief({ projectPath: root, record, git, changes, detail, maxChars, rulesInInstructions, minimalTools });
}

export interface ServerOptions {
  /** "core" registers only the tools a handoff needs, "minimal" only log_progress; their definitions are what the model pays for. */
  tools?: TokenSettings["tools"];
}

export function createServer(store = new HandoffStore(), options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const exposed = (tool: string) => isExposed(tool, options.tools ?? "all");
  const minimal = options.tools === "minimal";

  if (exposed("resume_task")) server.registerTool(
    "resume_task",
    {
      title: "Resume task",
      description:
        "CALL THIS FIRST in a new session. Returns the saved checkpoint written by the previous agent (Claude, Copilot, ...), " +
        "what hooks captured automatically after it, the current Git state and any work done after the checkpoint, " +
        "so you can continue exactly where it stopped " +
        "without reading old chat transcripts. Records in the timeline that you resumed.",
      inputSchema: {
        projectPath: projectPathSchema,
        agent: agentSchema,
        detail: z
          .enum(["compact", "full"])
          .default("compact")
          .describe("compact (default) keeps the brief small; full includes every list entry and the whole timeline")
      }
    },
    guarded(async ({ projectPath, agent, detail }) => {
      const root = await requireDirectory(projectPath);
      const brief = await buildBrief(store, root, detail, agent);
      await Promise.all([store.appendLog(root, normalizeAgent(agent), "resumed the task"), store.bumpStats(root, { resumes: 1 })]);
      return ok(brief);
    })
  );

  if (exposed("save_handoff")) server.registerTool(
    "save_handoff",
    {
      title: "Save handoff",
      description:
        "Write a complete checkpoint for the project, replacing the previous one (the timeline is kept). " +
        "Use at the start of a new task; use update_handoff or log_progress afterwards.",
      inputSchema: {
        projectPath: projectPathSchema,
        agent: agentSchema,
        task: fieldShape.task.default(""),
        status: fieldShape.status.default("in_progress"),
        currentStep: fieldShape.currentStep.default(""),
        completed: fieldShape.completed.default([]),
        nextSteps: fieldShape.nextSteps.default([]),
        decisions: fieldShape.decisions.default([]),
        changedFiles: fieldShape.changedFiles.default([]),
        keyFiles: fieldShape.keyFiles.default([]),
        tests: fieldShape.tests.default([]),
        blockers: fieldShape.blockers.default([]),
        notes: fieldShape.notes.default("")
      }
    },
    guarded(async ({ projectPath, agent, ...fields }) => {
      const root = await requireDirectory(projectPath);
      const record = await store.write(root, () => fields, {
        agent: normalizeAgent(agent),
        message: "saved checkpoint",
        git: await getGitSnapshot(root)
      });
      return ok(summary(record) + (await afterCheckpoint(store, root, record)));
    })
  );

  if (exposed("update_handoff")) server.registerTool(
    "update_handoff",
    {
      title: "Update handoff",
      description:
        "Change selected checkpoint fields. Given fields replace the stored value; append* lists are added without duplicates. " +
        "Call before you stop, with verified progress, next steps and real test results.",
      inputSchema: {
        projectPath: projectPathSchema,
        agent: agentSchema,
        task: fieldShape.task.optional(),
        status: fieldShape.status.optional(),
        currentStep: fieldShape.currentStep.optional(),
        completed: fieldShape.completed.optional(),
        nextSteps: fieldShape.nextSteps.optional(),
        decisions: fieldShape.decisions.optional(),
        changedFiles: fieldShape.changedFiles.optional(),
        keyFiles: fieldShape.keyFiles.optional(),
        tests: fieldShape.tests.optional(),
        blockers: fieldShape.blockers.optional(),
        notes: fieldShape.notes.optional(),
        appendCompleted: list.optional(),
        appendNextSteps: list.optional(),
        appendDecisions: list.optional(),
        appendChangedFiles: list.optional(),
        appendKeyFiles: list.optional(),
        appendTests: list.optional(),
        appendBlockers: list.optional()
      }
    },
    guarded(async ({ projectPath, agent, ...update }) => {
      const root = await requireDirectory(projectPath);
      const record = await store.write(root, (current) => mergeUpdate(current, update), {
        agent: normalizeAgent(agent),
        message: `updated ${Object.keys(update).join(", ") || "checkpoint"}`,
        git: await getGitSnapshot(root)
      });
      return ok(summary(record) + (await afterCheckpoint(store, root, record)));
    })
  );

  const progressShape = {
    projectPath: projectPathSchema,
    agent: agentSchema,
    completedStep: text(1000).optional().describe("A step you just finished"),
    currentStep: fieldShape.currentStep.optional(),
    changedFiles: fieldShape.changedFiles.optional(),
    tests: fieldShape.tests.optional(),
    decisions: fieldShape.decisions.optional(),
    nextSteps: list.optional().describe("New steps to add at the end"),
    status: statusSchema.optional()
  };
  // Only the minimal profile, where log_progress is the only checkpoint tool, pays for these three fields.
  const minimalShape = {
    ...progressShape,
    task: fieldShape.task.optional().describe("Overall goal of the task; set it once"),
    keyFiles: list.optional().describe("Files the next agent should read first"),
    blockers: list.optional().describe("Problems that stop progress now; replaces the list ([] clears it)"),
    nextSteps: list.optional().describe("All remaining steps, in order; replaces the list")
  };
  server.registerTool(
    "log_progress",
    {
      title: "Log progress",
      description:
        "Cheap, frequent checkpoint. Call after EVERY meaningful step, because a usage limit can end your session at any time. " +
        "completedStep is moved from nextSteps to completed when the text matches; lists are appended without duplicates." +
        (minimal ? " This is the only checkpoint tool: also use it to set the task, key files and blockers; nextSteps and blockers replace their lists." : ""),
      inputSchema: (minimal ? minimalShape : progressShape) as typeof minimalShape
    },
    guarded(async ({ projectPath, agent, ...progress }) => {
      const root = await requireDirectory(projectPath);
      // In minimal, nextSteps is the whole remaining plan (there is no update_handoff to correct it with).
      const input = minimal ? { ...progress, nextSteps: undefined, allNextSteps: progress.nextSteps } : progress;
      const record = await store.write(root, (current) => applyProgress(current, input), {
        agent: normalizeAgent(agent),
        message: describeProgress(progress),
        git: await getGitSnapshot(root)
      });
      return ok(summary(record) + (await afterCheckpoint(store, root, record)));
    })
  );

  if (exposed("get_handoff")) server.registerTool(
    "get_handoff",
    {
      title: "Get handoff",
      description: "Read the raw saved checkpoint (JSON) for a project. Prefer resume_task when starting a session.",
      inputSchema: { projectPath: projectPathSchema },
      annotations: { readOnlyHint: true }
    },
    guarded(async ({ projectPath }) => {
      const record = await store.get(path.resolve(projectPath));
      return ok(record ? JSON.stringify(record, null, 2) : "No checkpoint exists for this project yet.");
    })
  );

  if (exposed("get_project_status")) server.registerTool(
    "get_project_status",
    {
      title: "Get project status",
      description: "Read-only Git branch, HEAD, short status and diff stat for the project. Does not read source files or session logs.",
      inputSchema: { projectPath: projectPathSchema },
      annotations: { readOnlyHint: true }
    },
    guarded(async ({ projectPath }) => {
      const root = await requireDirectory(projectPath);
      return ok(JSON.stringify({ projectPath: root, ...(await getGitStatus(root)) }, null, 2));
    })
  );

  if (exposed("prepare_handoff")) server.registerTool(
    "prepare_handoff",
    {
      title: "Prepare handoff",
      description:
        "Build a continuation prompt the user can paste into another agent (useful when that agent has no MCP access). Does not message agents.",
      inputSchema: { projectPath: projectPathSchema, targetAgent: agentSchema },
      annotations: { readOnlyHint: true }
    },
    guarded(async ({ projectPath, targetAgent }) => {
      const root = await requireDirectory(projectPath);
      return ok(renderContinuationPrompt(targetAgent, await buildBrief(store, root)));
    })
  );

  if (exposed("export_handoff_markdown")) server.registerTool(
    "export_handoff_markdown",
    {
      title: "Export handoff Markdown",
      description: "Write the checkpoint to HANDOFF.md in the project root; refuses to overwrite unless overwrite=true.",
      inputSchema: { projectPath: projectPathSchema, overwrite: z.boolean().default(false) }
    },
    guarded(async ({ projectPath, overwrite }) => {
      const root = await requireDirectory(projectPath);
      const record = await store.get(root);
      if (!record) return fail("No saved handoff for this project.");
      const file = path.join(root, "HANDOFF.md");
      try {
        await fs.writeFile(file, renderMarkdown(record), { encoding: "utf8", flag: overwrite ? "w" : "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return fail("HANDOFF.md already exists. Set overwrite=true to replace it.");
        }
        throw error;
      }
      return ok(`Exported ${file}`);
    })
  );

  if (exposed("clear_handoff")) server.registerTool(
    "clear_handoff",
    {
      title: "Clear handoff",
      description: "Delete the saved checkpoint for a project (e.g. after the task is done). Requires confirm=true.",
      inputSchema: { projectPath: projectPathSchema, confirm: z.literal(true) },
      annotations: { destructiveHint: true }
    },
    guarded(async ({ projectPath }) => {
      const removed = await store.delete(path.resolve(projectPath));
      return ok(removed ? "Checkpoint deleted." : "No checkpoint existed for this project.");
    })
  );

  if (exposed("resume_task")) server.registerPrompt(
    "resume",
    {
      title: "Resume the previous agent's task",
      description: "Continue the task another AI agent left, from its last checkpoint",
      argsSchema: { agent: z.string().optional().describe("Your agent name, e.g. copilot") }
    },
    ({ agent }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Call the ai-handoff tool resume_task with projectPath set to the absolute path of the current workspace root` +
              ` and agent set to "${agent?.trim() || "your agent name"}". Then continue the task from where the previous agent stopped,` +
              " following the rules in the result. Do not read old chat transcripts or re-explore what the checkpoint explains." +
              " Call log_progress after every meaningful step."
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "checkpoint",
    {
      title: "Save a handoff checkpoint now",
      description: "Ask the agent to record verified progress so another agent can take over"
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              (minimal
                ? "Call the ai-handoff tool log_progress for the current workspace root."
                : "Call the ai-handoff tool update_handoff (or save_handoff if no checkpoint exists) for the current workspace root.") +
              " Record the task, what you were doing (currentStep), completed steps, ordered nextSteps, decisions with reasons," +
              " changed files, key files to read first, and only tests you actually ran with their results. Then stop."
          }
        }
      ]
    })
  );

  return server;
}
