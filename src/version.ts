/** Kept apart from server.ts so hook commands can print the version without loading the MCP SDK. */
export const SERVER_NAME = "ai-handoff-mcp";
export const SERVER_VERSION = "0.3.0";

/** Served from the repository; server.json lists the same icons for the MCP Registry (a test keeps them equal). */
const ICON_BASE = "https://raw.githubusercontent.com/EngHamzaAboJarad/ai-handoff-mcp/master/assets";
export const SERVER_ICONS = [
  { src: `${ICON_BASE}/icon.png`, mimeType: "image/png", sizes: ["256x256"] },
  { src: `${ICON_BASE}/icon.svg`, mimeType: "image/svg+xml", sizes: ["any"] }
];
