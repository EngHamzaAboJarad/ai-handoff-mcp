# Changelog

## 0.3.0 (beta)

A beta: everything below is tested (189 tests) and measured (BENCHMARK.md), but so far only on Windows and
without real-world usage. See "Known limitations".

New: a practical usage guide in Arabic, [USAGE.ar.md](USAGE.ar.md) (install, daily use, settings recipes, common problems).

### Handoff
- **Checkpoint nudge**: after 3+ edited files without a checkpoint, the stop hook asks the agent once to call
  `log_progress` (Claude Code, VS Code, Cursor through `followup_message`). Never twice in a row, never after a loop
  guard stop, never after an aborted turn. Gemini is left out on purpose: its hook would reject the final answer.
  `checkpointNudge` in `.ai-handoff.json`.
- **Stale checkpoint warning** in the brief: 7+ days old, or written on another branch.
- **`repoFile`** (opt-in): `.ai-handoff/HANDOFF.md` in the repository for cloud agents and agents without MCP,
  credentials redacted.
- **No double paying**: the brief leaves out the general rules when the host loads the instructions block, and a
  resumed conversation is not given the same brief twice.

### Token budget
- **Profiles** in `.ai-handoff.json` (`AI_HANDOFF_TOKENS` overrides): `standard` (9 tools, ~3,000 tokens of tool
  definitions), `lean` (4 core tools, ~2,200), `minimal` (`log_progress` only, ~620, for hosts that inject the
  brief). Tool and field descriptions are the same in every profile.
- **`init` chooses the profile**: the smallest one every configured host supports, keeping the 6,000-character brief;
  it never replaces a profile already set. `--tokens <profile>` chooses one yourself.
- In `minimal`, `log_progress` also takes `task`, `keyFiles` and `blockers`, and `nextSteps` is the whole
  remaining plan (it replaces the list).
- **No profile names a missing tool**: the instructions block says "where available"; the brief, the nudge and the
  prompts follow the profile. One test checks every agent-facing text for every profile.

### Prompt gate
- **Prompt strength**: a weak prompt that passes gets a one-line note for the user only (strength 0-100, what it
  names, one tip); it never enters the model's context. `promptGate.showScore`: `weak` (default), `always`, `off`.
- **Arabic parity**: attached pronouns ("صلحها") count like "fix it"; "شو المشكلة" is a why-broken question. On a
  labelled corpus of 88 prompts (Arabic and English pairs): no false blocks, no missed vague prompts, the same
  decision in both languages, mean score gap 2 points.

### Speed
- Hook commands no longer load the MCP SDK and zod: pre-tool ~0.1-0.3 s instead of ~0.26-0.35 s.
- Git runs in two parallel rounds instead of a chain of ~6 calls, one `rev-parse` gives root, HEAD and branch, and
  the brief no longer computes `git diff --stat` (it never showed it): session-start ~0.4 s, also on a
  20,000-file repository. The brief itself is unchanged.
- `init` warns when hooks would start through npx (2-4 s per tool call).

### CLI
- `tokens` (what the model pays for), `stats` (lifetime counters: prompts stopped, loops stopped, briefs, checkpoints,
  nudges; numbers only), `export` (HANDOFF.md), `clear --yes`, `init --tokens`.

### Measurement
- `npm run bench` writes BENCHMARK.md: resume context, fixed costs, prompt gate accuracy, hook latency, and with
  `--large` a 20,000-file repository. No model, no network. README numbers come from it, and claims it could not
  support were corrected ("a typical brief is about 900 characters", "milliseconds" for hooks, "about a second"
  through npx).
- **CI**: `.github/workflows/ci.yml` for Linux, macOS and Windows with Node 20 and 22.

### Upgrading from 0.2.0
- Re-run `ai-handoff-mcp init`: it refreshes the instructions block and writes a token profile. With the default
  targets that is `lean`, which hides `get_handoff`, `get_project_status`, `prepare_handoff`,
  `export_handoff_markdown` and `clear_handoff` from the model (the CLI has `show`, `prompt`, `export` and
  `clear`). To keep every tool: `ai-handoff-mcp init --tokens standard`.
- New files next to the checkpoint in `~/.ai-handoff-mcp`: `<id>.stats.json` and `<id>.briefs.json` (ids and
  counters only). 0.2.0 checkpoints are read as they are.
- `SERVER_VERSION` moved to `src/version.ts`.

### Known limitations
- Tests have only run on Windows so far; CI covers Linux and macOS once the repository is on GitHub.
- Savings are measured as the context a resuming agent needs, not with a model in the loop.
- The prompt gate was tuned on the corpus it is measured on: consistent, not proven on unseen prompts.
- Cursor's follow-ups are reported as unreliable on Windows by Cursor's own forum; there the nudge may not arrive.

## 0.2.0

- **Automatic capture** through host hooks, so the stopping point survives a session that ends without warning:
  Claude Code, VS Code (Copilot), Copilot CLI, Cursor, Gemini CLI, Windsurf / Devin Desktop, and a generic dialect.
- **Prompt clarity gate**: local, rule-based (Arabic and English) check that stops vague prompts before they reach
  the model; `block`, `warn` or `off`, `--go` override, per-project `.ai-handoff.json`. Prompts are never stored.
- **Loop guard**: pre-tool hooks stop an agent stuck in a loop (identical calls with nothing changed, edit
  ping-pong, the same command failing repeatedly, runaway turns): the first hit denies the call, the second stops the
  agent; counters reset on the next user prompt; the stop is logged (credentials redacted) for the next agent.
  Only hashes and counters are stored.
- **Git delta**: commits and files changed after the last checkpoint, including uncommitted edits (read-only per-file
  fingerprints).
- **Compact brief** with a 6,000-character budget and priority ordering; injected at session start.
- New tools: `resume_task`, `log_progress`, `clear_handoff`; MCP prompts `resume` and `checkpoint`.
- New fields: `currentStep`, `decisions`, `keyFiles`, timeline, Git snapshot.
- CLI: `init` (all agents, auto-detection, `--all`, `--mode npx|global|local`), `show`, `prompt`, `hook`, `check-prompt`.
- Storage: SHA-256 project ids (no collisions), cross-process lock, Windows rename retries, 0.1.0 files still read.
- `server.json` for the official MCP Registry and a pre-publish check.
- Breaking: tools take `agent` instead of `updatedBy`, and `projectPath` must be absolute.

## 0.1.0

- Initial local-first MCP server.
- Save, read, update, and export handoff records.
- Read-only Git status and continuation prompt tools.
- Basic storage tests and host configuration examples.
