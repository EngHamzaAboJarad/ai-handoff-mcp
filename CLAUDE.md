# AI Handoff MCP project instructions

- Read the README before changing configuration.
- Keep storage local-first; do not add telemetry or remote sync without an explicit design decision.
- Never search for or read Claude/Copilot session transcripts.
- Keep MCP stdout reserved for protocol messages; diagnostics belong on stderr.
- Add tests for changes to storage or tools.
- Never claim tests or publishing succeeded unless verified.
