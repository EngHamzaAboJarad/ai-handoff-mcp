// Runs every test/*.test.ts. The file list is built here, not by a shell glob: npm runs scripts through cmd.exe on
// Windows, which does not expand globs, and Node 20's test runner does not expand them either.
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const files = fs
  .readdirSync(new URL("../test/", import.meta.url))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => `test/${name}`);
if (!files.length) {
  console.error("No test files found in test/.");
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
