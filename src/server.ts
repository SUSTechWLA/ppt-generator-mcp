import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createProductionDependencies } from "./app.js";
import { loadAppConfig } from "./config/env.js";
import { createPptMcpServer } from "./mcp/register-tools.js";

async function main(): Promise<void> {
  const config = loadAppConfig();
  const dependencies = createProductionDependencies(config);
  const server = createPptMcpServer(dependencies);
  await server.connect(new StdioServerTransport());
  console.error("PPT Generator MCP Server v2 running on stdio");
  console.error(`Output root: ${config.outputRoot}`);
}

main().catch((error) => {
  console.error("PPT Generator MCP failed to start:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
