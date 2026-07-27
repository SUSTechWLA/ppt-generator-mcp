import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { listTemplates, loadTemplate } from "./lib/template-parser.js";
import { fillPlaceholders } from "./tools/fill-placeholders.js";
import { renderIcons } from "./tools/render-icons.js";
import { assemblePage } from "./tools/assemble-page.js";
import { validatePage } from "./tools/validate-page.js";
import { generateImages, generateSingleImage } from "./tools/generate-image.js";

// ============================================================================
// Paths
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const TEMPLATES_DIR = path.join(PROJECT_ROOT, "templates");

// ============================================================================
// Server
// ============================================================================

const server = new Server(
  {
    name: "ppt-generator-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// ============================================================================
// Tool Definitions
// ============================================================================

const TOOL_DEFINITIONS = [
  {
    name: "list_templates",
    description:
      "列出 templates/ 目录下所有可用的 HTML 模板，返回模板元数据（名称、适用场景、格式、组件等）。编排层可据此选择最合适的模板。",
    inputSchema: {
      type: "object" as const,
      properties: {
        templatesDir: {
          type: "string",
          description: "模板目录的绝对路径，默认为项目根目录下的 templates/",
        },
      },
    },
  },
  {
    name: "load_template",
    description:
      "加载指定模板的完整 HTML 内容，解析并返回所有占位符（XML 标签）和图标引用清单。编排层根据返回的占位符列表准备内容数据。",
    inputSchema: {
      type: "object" as const,
      properties: {
        slug: {
          type: "string",
          description:
            '模板的唯一标识（slug），如 "green-infographic-bid-a4-landscape"',
        },
        templatesDir: {
          type: "string",
          description: "模板目录的绝对路径，默认为项目 templates/",
        },
      },
      required: ["slug"],
    },
  },
  {
    name: "fill_placeholders",
    description:
      "用实际内容填充模板中的 XML 占位符。支持两种模式：（1）direct 直接替换文本；（2）expand 提供要点，调 LLM API 扩写为正式段落。这是编排层调度文生文 LLM 的核心工具。",
    inputSchema: {
      type: "object" as const,
      properties: {
        html: {
          type: "string",
          description: "模板 HTML 字符串",
        },
        content: {
          type: "object",
          description:
            "填充内容。direct 为直接文本替换（{tag: text}），expand 为要点扩写（调 LLM）",
          properties: {
            direct: {
              type: "object",
              description:
                '直接文本替换，key 为占位符标签名，value 为文本或文本数组。如 {"page-title": "第1页｜项目背景"}',
            },
            expand: {
              type: "object",
              description:
                'LLM 扩写，key 为占位符标签名，value 为 [{keyPoints: ["要点1","要点2"], style:"正式专业"}]',
            },
          },
        },
        llmConfig: {
          type: "object",
          description: "LLM API 配置，仅 expand 模式需要",
          properties: {
            provider: {
              type: "string",
              enum: ["openai", "anthropic"],
              description: "LLM 提供商",
            },
            apiKey: { type: "string", description: "API Key" },
            model: {
              type: "string",
              description:
                "模型名称，默认 openai=gpt-4o, anthropic=claude-sonnet-5-20251001",
            },
            baseUrl: {
              type: "string",
              description: "OpenAI 兼容 API Base URL（可选）",
            },
          },
          required: ["provider", "apiKey"],
        },
      },
      required: ["html", "content"],
    },
  },
  {
    name: "generate_image",
    description:
      "调用 DALL-E 文生图 API 生成配图。可传入 HTML（自动提取 <figures> 提示词），或直接传入 prompt 生成单张图片。生成后自动替换 HTML 中的 <figures> 标签为 <img>。",
    inputSchema: {
      type: "object" as const,
      properties: {
        html: {
          type: "string",
          description:
            "含 <figures> 占位符的 HTML（可选，如果直接传 prompt 则忽略）",
        },
        prompt: {
          type: "string",
          description: "直接传入图片生成提示词（不依赖 HTML 中的 <figures>）",
        },
        imageConfig: {
          type: "object",
          description: "DALL-E API 配置",
          properties: {
            apiKey: { type: "string", description: "OpenAI API Key" },
            baseUrl: {
              type: "string",
              description: "API Base URL（可选，默认 openai.com）",
            },
            model: {
              type: "string",
              description: "模型名称，默认 dall-e-3",
            },
          },
          required: ["apiKey"],
        },
        outputDir: {
          type: "string",
          description: "图片输出目录（绝对路径）",
        },
        outputUrlPrefix: {
          type: "string",
          description: '图片引用 URL 前缀，默认 "./assets/images/"',
        },
      },
      required: ["imageConfig", "outputDir"],
    },
  },
  {
    name: "render_icons",
    description:
      '将模板中的 <icon name="xxx">描述</icon> 替换为实际的 <img src="./assets/icons/xxx.svg">。纯本地操作，不调 API。',
    inputSchema: {
      type: "object" as const,
      properties: {
        html: {
          type: "string",
          description: "含 <icon> 标签的 HTML",
        },
        iconBasePath: {
          type: "string",
          description: "图标 SVG 目录的绝对路径",
        },
        iconsRelativePath: {
          type: "string",
          description: '生成的 <img> 中 src 的相对路径前缀，默认 "./assets/icons/"',
        },
      },
      required: ["html", "iconBasePath"],
    },
  },
  {
    name: "assemble_page",
    description:
      "组装最终的可交付 HTML 页面：移除 XML 注释、检查残留占位符、可选内联 CSS、可选压缩输出、写入文件。编排层在所有填充/渲染步骤完成后调用此工具输出最终页面。",
    inputSchema: {
      type: "object" as const,
      properties: {
        html: {
          type: "string",
          description: "待组装的 HTML",
        },
        config: {
          type: "object",
          description: "组装选项",
          properties: {
            removeXmlComment: {
              type: "boolean",
              description: "是否移除 HTML 头部的 XML 注释，默认 true",
            },
            minifyOutput: {
              type: "boolean",
              description: "是否压缩 HTML 输出，默认 false",
            },
            inlineCss: {
              type: "boolean",
              description: "是否内联 CSS 到 HTML，默认 false",
            },
            outputPath: {
              type: "string",
              description: "输出文件路径（绝对路径，含 .html 扩展名）",
            },
            linkedCssPath: {
              type: "string",
              description: "CSS 文件路径（inlineCss=true 时需要）",
            },
            templateDir: {
              type: "string",
              description: "模板目录（用于解析 CSS 相对路径）",
            },
          },
        },
      },
      required: ["html", "config"],
    },
  },
  {
    name: "validate_page",
    description:
      "验证生成的页面：检查是否残留 XML 占位符、<icon> 标签是否已渲染、图片引用是否有效、HTML 是否合法。编排层在交付前调用此工具做最终质量检查。",
    inputSchema: {
      type: "object" as const,
      properties: {
        html: {
          type: "string",
          description: "待验证的 HTML",
        },
        htmlFilePath: {
          type: "string",
          description: "HTML 文件路径（用于验证图片引用是否存在）",
        },
        checks: {
          type: "array",
          description: "要执行的检查项",
          items: {
            type: "string",
            enum: [
              "no-xml-tags",
              "all-icons-rendered",
              "all-images-exist",
              "valid-html",
            ],
          },
        },
      },
      required: ["html", "checks"],
    },
  },
];

// ============================================================================
// Request Handlers
// ============================================================================

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const input = (args || {}) as Record<string, unknown>;

  try {
    switch (name) {
      // === list_templates ===
      case "list_templates": {
        const dir = (input.templatesDir as string) || TEMPLATES_DIR;
        const templates = listTemplates(dir);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ templates }, null, 2),
            },
          ],
        };
      }

      // === load_template ===
      case "load_template": {
        const dir = (input.templatesDir as string) || TEMPLATES_DIR;
        const slug = input.slug as string;
        const parsed = loadTemplate(dir, slug);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  slug: parsed.slug,
                  filePath: parsed.filePath,
                  metadata: parsed.metadata,
                  placeholders: parsed.placeholders,
                  icons: parsed.icons,
                  html: parsed.html,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // === fill_placeholders ===
      case "fill_placeholders": {
        const result = await fillPlaceholders({
          html: input.html as string,
          content: (input.content || {}) as {
            direct?: Record<string, string | string[]>;
            expand?: Record<
              string,
              Array<{
                index?: number;
                keyPoints: string[];
                style?: string;
              }>
            >;
          },
          llmConfig: input.llmConfig as
            | {
                provider: "openai" | "anthropic";
                apiKey: string;
                model?: string;
                baseUrl?: string;
              }
            | undefined,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // === generate_image ===
      case "generate_image": {
        const html = input.html as string | undefined;
        const prompt = input.prompt as string | undefined;
        const imageConfig = input.imageConfig as {
          apiKey: string;
          baseUrl?: string;
          model?: string;
        };
        const outputDir = input.outputDir as string;
        const outputUrlPrefix = input.outputUrlPrefix as string | undefined;

        if (prompt && !html) {
          // Single image mode
          const result = await generateSingleImage(
            imageConfig,
            prompt,
            outputDir,
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } else if (html) {
          // HTML mode
          const result = await generateImages({
            html,
            imageConfig,
            outputDir,
            outputUrlPrefix,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } else {
          throw new Error(
            "Either 'html' or 'prompt' must be provided",
          );
        }
      }

      // === render_icons ===
      case "render_icons": {
        const result = renderIcons({
          html: input.html as string,
          iconBasePath: input.iconBasePath as string,
          iconsRelativePath: input.iconsRelativePath as string | undefined,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // === assemble_page ===
      case "assemble_page": {
        const result = assemblePage({
          html: input.html as string,
          config: (input.config || {}) as {
            removeXmlComment?: boolean;
            minifyOutput?: boolean;
            inlineCss?: boolean;
            outputPath?: string;
            linkedCssPath?: string;
            templateDir?: string;
          },
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // === validate_page ===
      case "validate_page": {
        const result = validatePage({
          html: input.html as string,
          htmlFilePath: input.htmlFilePath as string | undefined,
          checks: (input.checks || [
            "no-xml-tags",
            "all-icons-rendered",
            "valid-html",
          ]) as Array<
            | "no-xml-tags"
            | "all-icons-rendered"
            | "all-images-exist"
            | "valid-html"
          >,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: error instanceof Error ? error.message : String(error),
              stack:
                error instanceof Error ? error.stack : undefined,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
});

// ============================================================================
// Start
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("PPT Generator MCP Server running on stdio");
  console.error(`Templates directory: ${TEMPLATES_DIR}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
