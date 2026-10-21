// Fails before `npm publish` when placeholders are left or package.json and server.json disagree.
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const server = JSON.parse(fs.readFileSync(new URL("../server.json", import.meta.url), "utf8"));
const problems = [];

const raw = JSON.stringify([pkg, server]);
if (raw.includes("YOUR-GITHUB-USERNAME")) problems.push("Replace YOUR-GITHUB-USERNAME in package.json and server.json with your GitHub user name.");
if (server.name !== pkg.mcpName) problems.push(`server.json name (${server.name}) must equal package.json mcpName (${pkg.mcpName}).`);
if (server.version !== pkg.version) problems.push(`server.json version (${server.version}) must equal package.json version (${pkg.version}).`);
for (const entry of server.packages ?? []) {
  if (entry.registryType === "npm" && entry.identifier !== pkg.name) problems.push(`server.json package identifier must be ${pkg.name}.`);
  if (entry.registryType === "npm" && entry.version !== pkg.version) problems.push(`server.json package version must be ${pkg.version}.`);
}
if ((server.description ?? "").length > 100) problems.push("server.json description must be 100 characters or fewer.");
if (!fs.existsSync(new URL("../dist/src/index.js", import.meta.url))) problems.push("dist/src/index.js is missing; run npm run build.");

if (problems.length) {
  console.error("Not ready to publish:\n- " + problems.join("\n- "));
  process.exit(1);
}
console.error("Publish check passed.");
