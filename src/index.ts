#!/usr/bin/env node
import { main } from "./cli.js";

main().catch((error) => {
  process.stderr.write(`ai-handoff-mcp failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
