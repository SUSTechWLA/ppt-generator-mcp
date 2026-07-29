import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { generateSlideOutputSchema, type GenerateSlideOutput } from "../../src/domain/quality-report.js";
import type { GenerateSlideInput } from "../../src/domain/source-document.js";
import { createPptMcpServer, type PptMcpDependencies } from "../../src/mcp/register-tools.js";

export async function callGenerateSlideThroughInMemoryMcp(
  input: GenerateSlideInput,
  dependencies: PptMcpDependencies,
): Promise<GenerateSlideOutput> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createPptMcpServer(dependencies);
  const client = new Client({ name: "mcp-harness", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "generate_slide", arguments: input });
    if (result.isError) {
      const content = (Array.isArray(result.content) ? result.content : []) as Array<{ type: string; text?: string }>;
      const message = content.map((item) => item.type === "text" ? item.text ?? "" : "").join("\n");
      throw new Error(message);
    }
    return generateSlideOutputSchema.parse(result.structuredContent);
  } finally {
    await client.close();
    await server.close();
  }
}
