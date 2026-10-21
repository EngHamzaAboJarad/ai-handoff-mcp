# Benchmark

Measured 2026-10-21 on Windows_NT 10.0.26200, Node v24.21.0, 11th Gen Intel(R) Core(TM) i5-1135G7 @ 2.40GHz. Run `npm run bench` to reproduce.
No model is called: these are deterministic measurements. Tokens are estimates at 3.5 characters per token.

## 1. What the next agent reads when it continues a task

Fixture: this project's own code (30 files, 337,744 characters), a checkpoint, then 3 files edited before the session ends.

| What the next agent reads | Characters | ~Tokens | Knows the task, next steps and decisions? |
|---|---|---|---|
| **With ai-handoff**: brief injected at session start | 2,252 | 644 | Yes |
| With ai-handoff, instructions block already loaded (rules not repeated) | 1,972 | 564 | Yes |
| With ai-handoff, `lean` profile (brief capped at 3,000 characters; this one is under the cap) | 1,972 | 564 | Yes |
| Without: `git status` + `git diff` + the 3 changed files (the minimum to see what changed) | 64,549 | 18,443 | No |
| Without: reading the whole codebase | 337,744 | 96,499 | No |

The brief is 28.7x smaller than the minimum re-discovery, and it carries what re-discovery cannot recover at all. How many tokens an agent really spends exploring depends on the model and the task; this benchmark does not run a model, so it does not claim a number for that.

## 2. Fixed cost per session

| Part | ~Tokens | When |
|---|---|---|
| Tool definitions, `standard` (9 tools) | 2,978 | every request (most hosts cache it) |
| Tool definitions, `lean` (4 core tools, same descriptions) | 2,176 | every request |
| Tool definitions, `minimal` (log_progress only; hosts that inject the brief) | 618 | every request |
| Instructions block (AGENTS.md, CLAUDE.md) | 355 | every session |
| Rules left out of the brief when the instructions block is loaded | -80 | every session |
| Checkpoint nudge (only after 3+ edited files without a checkpoint, once) | 118 + one model step for the agent's log_progress call (context re-read, mostly cached) | rarely |
| Prompt gate (block), prompt strength, loop guard, file capture, Git delta | 0 | they run outside the model |

## 3. Prompt gate accuracy

Labelled corpus: 44 pairs, each written in English and Arabic, so 88 prompts (40 clear, 48 vague; see test/prompt-corpus.ts). First prompt of a session.

| Measure | Result |
|---|---|
| Clear prompts stopped (false blocks) | 0 of 40 |
| Vague prompts let through | 0 of 48 |
| Same decision in English and Arabic | 44 of 44 pairs |
| Mean score gap between the two languages | 2.0 points (of 100) |

The corpus was written by the authors and the gate was tuned on it, so these are training-set numbers. They show the gate is consistent, not that it is right on prompts it has never seen.

## 4. Hook latency (real processes)

| Command | Median | p90 |
|---|---|---|
| `node -e 0` (bare Node start, for reference) | 96 ms | 163 ms |
| Node + loading the MCP SDK and zod (what hooks no longer load) | 442 ms | 828 ms |
| pre-tool (loop guard, before every tool call) | 221 ms | 328 ms |
| prompt-submit (prompt gate) | 314 ms | 631 ms |
| session-start (brief + Git delta) | 387 ms | 631 ms |
| through `npx --no-install` (lower bound for npx) | 2446 ms | 6386 ms |

Global install or local checkout (`node dist/src/index.js`); median of 15 runs, npx of 5. session-start runs once per session; pre-tool runs before every tool call.
Before the MCP SDK was loaded lazily (measured once on the same machine, 2026-10-21): pre-tool 259 ms, prompt-submit 334 ms.

## 5. Large repository

Fixture: 20,000 committed files (built in 329 s), 150 modified and 50 new. Run with `npm run bench -- --large`.

| Path | Median |
|---|---|
| Git snapshot (every log_progress / checkpoint) | 329 ms |
| Repository state with the checkpoint (session-start, resume_task) | 362 ms |
| session-start hook, real process | 690 ms |
| pre-tool hook, real process (no Git) | 253 ms |

Measured on the same machine as above, in the same run (compare the bare Node row in section 4: a loaded machine raises every number). `git status` checks every file in the working tree, so these times grow with the repository size and with the number of modified files; past 300 changed files, fingerprints are skipped and a diff stat is used instead.

