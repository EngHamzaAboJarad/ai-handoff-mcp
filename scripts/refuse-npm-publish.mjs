// The VS Code extension shares the npm package's name, so `npm publish` in vscode-extension/ would overwrite the
// MCP server on npm. The extension is published to the Visual Studio Marketplace as a VSIX instead.
console.error("This folder is the VS Code extension. Publish it with `npm run package` and upload the VSIX to the Marketplace.\nTo publish ai-handoff-mcp to npm, run `npm publish` in the repository root.");
process.exit(1);
