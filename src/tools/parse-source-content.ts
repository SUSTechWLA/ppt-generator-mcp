/**
 * parse_source_content — 将原始 Markdown/正文解析为模板填充所需的
 * 结构化 content 对象。编排层调用此工具获得 content 后，直接传给
 * fill_placeholders。
 *
 * 两种模式:
 *   direct  — 纯正则解析（无需 API Key）
 *   llm     — 调 LLM 提取关键信息、生成图片提示词（质量更高）
 */
import { generateText, type LLMConfig } from "../lib/llm-client.js";

// ============================================================================
// Types
// ============================================================================

export interface ParsedSection {
  level: number;        // heading level (### = 3, ##### = 5)
  title: string;        // cleaned heading text
  paragraphs: string[]; // body text under this heading
  keyPoints: string[];  // extracted bullet points
}

export interface ParseSourceInput {
  sourceText: string;          // raw markdown / plain text
  templateSlug?: string;       // force a template; omit for auto-detect
  mode?: "direct" | "llm";     // default "direct"
  llmConfig?: LLMConfig;       // required for llm mode
}

export interface ParseSourceOutput {
  // Structured content ready for fill_placeholders.direct
  content: {
    direct: Record<string, string | string[]>;
  };
  // Image prompts derived from content sections
  imagePrompts: Array<{
    sectionIndex: number;
    sectionTitle: string;
    prompt: string;
  }>;
  // Icon prompts — text descriptions for icon generation
  iconPrompts: Array<{
    position: string;
    description: string;
    prompt: string;
  }>;
  // Recommended template slug
  recommendedTemplate: string;
  // Parsed sections for inspection
  sections: ParsedSection[];
}

// ============================================================================
// Markdown Parser
// ============================================================================

function parseMarkdown(text: string): ParsedSection[] {
  const lines = text.split("\n");
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;
  let buffer: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // Match headings: ### Title or ##### Title
    const hMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (hMatch) {
      // Save previous section
      if (current && buffer.length > 0) {
        current.paragraphs.push(buffer.join(""));
        buffer = [];
      }
      if (current) sections.push(current);

      current = {
        level: hMatch[1].length,
        title: hMatch[2].replace(/^[\d.]+\s*/, "").trim(),
        paragraphs: [],
        keyPoints: [],
      };
      continue;
    }

    // Match list items: - xxx or * xxx or 1. xxx
    const liMatch = line.match(/^[-*•]\s+(.+)|^\d+[\.\、\)]\s*(.+)/);
    if (liMatch && current) {
      const point = (liMatch[1] || liMatch[2] || "").trim();
      if (point && point.length < 80) {
        current.keyPoints.push(point);
      }
      continue;
    }

    // Regular paragraph text
    if (current && line.length > 10) {
      buffer.push(line);
    }

    // Flush paragraph at sentence endings or after sufficient length
    if (buffer.join("").length > 200 || (line.endsWith("。") && buffer.join("").length > 60)) {
      current!.paragraphs.push(buffer.join(""));
      buffer = [];
    }
  }

  // Flush remaining
  if (current) {
    if (buffer.length > 0) current.paragraphs.push(buffer.join(""));
    sections.push(current);
  }

  // Post-process: merge very short sections
  return sections.filter((s) => s.paragraphs.length > 0 || s.keyPoints.length > 0);
}

// ============================================================================
// Content Mapping
// ============================================================================

function mapToTemplate(
  sections: ParsedSection[],
  _templateSlug: string,
): {
  content: { direct: Record<string, string | string[]> };
  imagePrompts: ParseSourceOutput["imagePrompts"];
  iconPrompts: ParseSourceOutput["iconPrompts"];
} {
  const direct: Record<string, string | string[]> = {};
  const imagePrompts: ParseSourceOutput["imagePrompts"] = [];
  const iconPrompts: ParseSourceOutput["iconPrompts"] = [];

  // Root section (### heading) → page metadata
  const root = sections[0];
  direct["topic-title"] = root.title;
  direct["subsection-title"] = `${root.title}`;
  direct["section-title"] = `第二章：技术方案与保障措施`;
  direct["chapter-label"] = `2.1 项目人员配备`;
  direct["part-number"] = `PART.2`;
  direct["part-label"] = `人员配备`;
  direct["page-title"] = `第1页 | ${root.title}`;
  direct["page-number"] = `1`;

  // Sub-sections (##### headings) → card titles
  const subs = sections.slice(1).filter((s) => s.level >= 4);
  const totalCards = Math.min(subs.length, 5);
  const titles: string[] = [];
  const paragraphs: string[] = [];
  const summaryPoints: string[] = [];

  for (let i = 0; i < totalCards; i++) {
    const sub = subs[i];
    titles.push(sub.title);

    // Position-aware truncation:
    // - Wide cards (span-6/span-8): 140-150 chars
    // - Narrow cards (span-4, last position in visual template): 70-80 chars
    const isLastNarrow = (totalCards === 3 && i === 2); // visual template span-4
    const maxLen = isLastNarrow ? 80 : 145;
    const fullText = sub.paragraphs[0] || sub.keyPoints.join("；");
    paragraphs.push(truncateParagraph(fullText, maxLen));

    // Collect key points for summary
    for (const kp of sub.keyPoints.slice(0, 2)) {
      summaryPoints.push(kp);
    }

    // Generate image prompt from section content
    const imgPrompt = generateImagePrompt(sub);
    if (imgPrompt) {
      imagePrompts.push({
        sectionIndex: i,
        sectionTitle: sub.title,
        prompt: imgPrompt,
      });
    }
  }

  direct["component-title"] = titles;
  direct["paragraph"] = paragraphs;
  direct["figure-ref"] = titles.length > 1 ? titles[1] : titles[0]; // for image cards

  // Summary — extract key points from paragraph text if no explicit list items
  if (summaryPoints.length === 0 && root.paragraphs.length > 0) {
    // Derive key points from root paragraph by splitting on numbered markers
    const rootText = root.paragraphs.join("");
    const derived = rootText
      .split(/[；;]\s*(?:第一|第二|第三|第四|第五|[一二三四五六七八]、)/)
      .filter((s) => s.length > 4)
      .map((s) => s.trim().slice(0, 20));
    if (derived.length >= 3) summaryPoints.push(...derived.slice(0, 4));
  }
  if (summaryPoints.length === 0) {
    // Fallback: use section titles as summary bullets
    summaryPoints.push(...titles.map((t) => t.slice(0, 12)));
  }

  direct["summary-text"] = truncateParagraph(
    `本方案针对${root.title}，从${titles.slice(0, 3).join("、")}等${titles.length}个方面进行了全面响应和详细部署。`,
    100,
  );
  direct["bullet"] = summaryPoints.slice(0, 4);

  // Visual component content — pad to common template needs (min 4-5)
  const padLabels = (arr: string[], min: number, prefix: string): string[] => {
    const result = [...arr.map((s) => s.slice(0, 8))];
    while (result.length < min) result.push(`${prefix}${result.length + 1}`);
    return result.slice(0, min);
  };

  direct["step-label"] = padLabels(titles, 5, "步骤");   // need 4-5
  direct["stage-label"] = padLabels(titles, 4, "阶段");  // need 4
  direct["stage-number"] = ["01", "02", "03", "04"];
  direct["item-label"] = padLabels(titles, 4, "能力项"); // need 3-4
  direct["node-label"] = [
    subs[0]?.title.slice(0, 6) || "对接人员",
    subs[1]?.title.slice(0, 6) || "作业班组",
    subs[2]?.title.slice(0, 6) || "管理体系",
  ];

  // Table content (for table templates)
  const tableHeaders = ["响应维度", "核心内容", "保障措施"];
  const tableCells: string[] = [];
  for (const sub of subs.slice(0, 6)) {
    tableCells.push(
      sub.title.slice(0, 12),
      (sub.keyPoints[0] || sub.title).slice(0, 20),
      (sub.keyPoints[1] || "已制定专项方案").slice(0, 20),
    );
  }
  direct["table-header"] = tableHeaders;
  direct["table-cell"] = tableCells;

  // Image caption
  direct["image-caption"] = `项目人员配备场景示意图（AI生成，非项目实景）`;

  // Generate icon prompts from content context
  const generatedIconPrompts = generateIconPrompts(sections);

  return { content: { direct }, imagePrompts, iconPrompts: generatedIconPrompts };
}

// ============================================================================
// Template Recommendation
// ============================================================================

function recommendTemplate(sections: ParsedSection[]): string {
  const subCount = sections.filter((s) => s.level >= 4).length;

  // Match template to content structure:
  // 5+ sub-sections → original paired template (5 text + 5 visual)
  // 4 sub-sections → text-image staggered layout
  // 3 sub-sections → visual template (fewer cards, more visual weight)
  // 1-2 sub-sections → text-image (1:1 ratio)

  if (subCount >= 5) return "green-infographic-bid-a4-landscape";
  if (subCount >= 4) return "green-infographic-bid-a4-landscape-text-image";
  if (subCount >= 3) return "green-infographic-bid-a4-landscape-visual";
  return "green-infographic-bid-a4-landscape-text-image";
}

// ============================================================================
// Helpers
// ============================================================================

function truncateParagraph(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  // Cut at the best sentence/clause boundary within range
  const range = text.slice(0, maxLen);
  // Preferred: end of sentence (。)
  const period = range.lastIndexOf("。");
  if (period > maxLen * 0.65) return range.slice(0, period + 1);
  // Next best: Chinese semicolon (；)
  const semi = range.lastIndexOf("；");
  if (semi > maxLen * 0.65) return range.slice(0, semi + 1) + "。";
  // Last resort: comma at reasonable position
  const comma = range.lastIndexOf("，");
  if (comma > maxLen * 0.7) return range.slice(0, comma) + "。";
  return range + "…";
}

function generateIconPrompts(sections: ParsedSection[]): ParseSourceOutput["iconPrompts"] {
  const allText = sections.map((s) => s.title + " " + s.paragraphs.join(" ")).join(" ");
  const prompts: ParseSourceOutput["iconPrompts"] = [];

  // Map content keywords to icon concepts and generation prompts
  const iconConcepts: Array<{ keyword: RegExp; concept: string; prompt: string }> = [
    { keyword: /人员|团队|班组|对接|组织/, concept: "团队协作图标", prompt: "A simple line icon of two people or a team, professional style, green color (#0B5A2A), transparent background, suitable for bid document" },
    { keyword: /审批|流程|变更|申请/, concept: "审批流程图标", prompt: "A simple line icon of a clipboard with checkmark, professional style, green color (#0B5A2A), transparent background, suitable for bid document" },
    { keyword: /文件|文档|台账|记录|归档/, concept: "文档管理图标", prompt: "A simple line icon of a document or file, professional style, green color (#0B5A2A), transparent background, suitable for bid document" },
    { keyword: /检查|巡查|考核|评估/, concept: "检查评估图标", prompt: "A simple line icon of a magnifying glass or checklist, professional style, green color (#0B5A2A), transparent background, suitable for bid document" },
    { keyword: /计划|日程|安排|编制/, concept: "计划日历图标", prompt: "A simple line icon of a calendar, professional style, green color (#0B5A2A), transparent background, suitable for bid document" },
    { keyword: /作业|养护|修剪|施工/, concept: "养护作业图标", prompt: "A simple line icon of garden shears or a plant, professional style, green color (#0B5A2A), transparent background, suitable for bid document" },
    { keyword: /设备|车辆|运输|机械/, concept: "设备运输图标", prompt: "A simple line icon of a truck or equipment, professional style, green color (#0B5A2A), transparent background, suitable for bid document" },
    { keyword: /质量|安全|保障|达标/, concept: "质量安全图标", prompt: "A simple line icon of a shield with checkmark, professional style, green color (#0B5A2A), transparent background, suitable for bid document" },
  ];

  for (const { keyword, concept, prompt } of iconConcepts) {
    if (keyword.test(allText)) {
      prompts.push({ position: concept, description: concept, prompt });
    }
  }

  return prompts;
}

const SUMMARIZE_PROMPT = `你是一个专业的标书文档精简助手。请将以下段落精简为指定字数以内的版本，保留所有关键信息和数据，删除冗余修饰词，确保语句通顺专业。

要求：
1. 保留所有具体数字、名称、关键术语
2. 删减重复表述和修饰性语言
3. 确保每句话都有实质性信息
4. 直接输出精简后的文本，不要解释

目标字数：{targetLen}字以内
原文：{text}`;

async function summarizeParagraph(
  text: string,
  targetLen: number,
  config?: LLMConfig,
): Promise<string> {
  if (!config || text.length <= targetLen) return text;

  try {
    const prompt = SUMMARIZE_PROMPT
      .replace("{targetLen}", String(targetLen))
      .replace("{text}", text);
    const result = await generateText(config, "", prompt);
    const cleaned = result.trim();
    return cleaned.length > 0 ? cleaned : text.slice(0, targetLen);
  } catch {
    return truncateParagraph(text, targetLen);
  }
}

function generateImagePrompt(section: ParsedSection): string {
  const title = section.title;
  const text = (section.paragraphs[0] || "").slice(0, 150);

  // Check section content traits (order matters — check specific before general)
  if (title.includes("配置") || title.includes("对接")) {
    return `项目对接人员工作场景：专职人员持通信设备与采购人现场沟通，办公环境整洁，文档资料齐全，绿色商务风格，写实摄影`;
  }
  if (title.includes("调配") || title.includes("动态") || text.includes("调配")) {
    return `园林养护人员调配示意图：多班组按项目区域分布，机动班组巡回路线标注，季节性人员调整甘特图，信息图风格，绿色商务配色`;
  }
  if (title.includes("变更") || title.includes("审批") || title.includes("流程")) {
    return `标准化变更审批流程图：书面申请、审核评估、批复执行、岗位交接四步流程，信息图风格，绿色主题，简洁专业`;
  }
  if (title.includes("养护") || title.includes("作业")) {
    return `园林绿化养护作业场景：工人修剪灌木、操作专业设备，绿色植被背景，阳光充足，写实摄影风格，高清画质`;
  }
  return `园林绿化养护相关场景示意图，${title.slice(0, 30)}，写实摄影风格，绿色植被背景，阳光充足`;
}

// ============================================================================
// LLM-assisted parsing (higher quality)
// ============================================================================

const EXTRACTION_PROMPT = `你是一个标书文档结构化提取助手。根据提供的文档内容，提取以下结构化信息，以 JSON 格式返回：

{
  "pageTitle": "页面标题（10-20字）",
  "sectionTitle": "分节标题",
  "chapterLabel": "章节编号和名称",
  "topicTitle": "页面主题（8-15字）",
  "cardTitles": ["卡片标题1", "卡片标题2", ...],       // 3-5个
  "cardParagraphs": ["段落1 120-160字", "段落2", ...],  // 与标题一一对应
  "summaryText": "总结段落 40-80字",
  "summaryBullets": ["要点1", "要点2", "要点3"],        // 3-4个
  "imagePrompts": ["图片提示词1", ...],                  // 与卡片一一对应
  "stepLabels": ["步骤1", "步骤2", ...],                // 4-5个流程步骤
  "recommendedTemplate": "模板slug"
}

规则：
1. 从 ### 标题提取 pageTitle 和 topicTitle
2. 从 ##### 标题提取 cardTitles
3. 每个标题下的正文内容提炼为120-160字的 cardParagraphs
4. 总结提炼核心观点
5. 图片提示词应描述与对应卡片内容相关的业务场景
6. 步骤标签描述业务流程的关键步骤

直接返回 JSON，不要其他文字。`;

async function llmExtract(
  sourceText: string,
  config: LLMConfig,
): Promise<Record<string, unknown>> {
  const result = await generateText(config, EXTRACTION_PROMPT, sourceText);
  // Try to parse JSON from the result (may have markdown code fence)
  const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/) || result.match(/(\{[\s\S]*\})/);
  const jsonStr = jsonMatch ? jsonMatch[1] : result;
  return JSON.parse(jsonStr.trim());
}

// ============================================================================
// Main Export
// ============================================================================

export async function parseSourceContent(
  input: ParseSourceInput,
): Promise<ParseSourceOutput> {
  // Phase 1: Parse markdown structure
  const sections = parseMarkdown(input.sourceText);

  // Phase 2: Template recommendation (or use forced slug)
  const recommended = input.templateSlug || recommendTemplate(sections);

  // Phase 3: Map content
  let result = mapToTemplate(sections, recommended);

  // Phase 3b: LLM summarization for paragraphs too long for their card width
  if (input.llmConfig) {
    const paragraphs = result.content.direct["paragraph"];
    if (Array.isArray(paragraphs)) {
      const totalCards = (result.content.direct["component-title"] as string[])?.length || 0;
      for (let i = 0; i < paragraphs.length; i++) {
        const isLastNarrow = (totalCards === 3 && i === 2); // visual template span-4
        const targetLen = isLastNarrow ? 80 : 145;
        if (paragraphs[i].length > targetLen + 10) {
          paragraphs[i] = await summarizeParagraph(paragraphs[i], targetLen, input.llmConfig);
        }
      }
    }
  }

  // Phase 4: LLM-assisted extraction (higher quality, overrides template mapping)
  if (input.mode === "llm" && input.llmConfig) {
    try {
      const extracted = await llmExtract(input.sourceText, input.llmConfig);

      const direct: Record<string, string | string[]> = {};
      if (extracted.pageTitle) direct["page-title"] = extracted.pageTitle as string;
      if (extracted.sectionTitle) direct["section-title"] = extracted.sectionTitle as string;
      if (extracted.chapterLabel) direct["chapter-label"] = extracted.chapterLabel as string;
      if (extracted.topicTitle) direct["topic-title"] = extracted.topicTitle as string;
      if (extracted.cardTitles) direct["component-title"] = extracted.cardTitles as string[];
      if (extracted.cardParagraphs) direct["paragraph"] = extracted.cardParagraphs as string[];
      if (extracted.summaryText) direct["summary-text"] = extracted.summaryText as string;
      if (extracted.summaryBullets) direct["bullet"] = extracted.summaryBullets as string[];
      if (extracted.stepLabels) direct["step-label"] = extracted.stepLabels as string[];

      if (extracted.imagePrompts) {
        result.imagePrompts = (extracted.imagePrompts as string[]).map((p, i) => ({
          sectionIndex: i,
          sectionTitle: (extracted.cardTitles as string[])?.[i] || `Section ${i + 1}`,
          prompt: p,
        }));
      }

      // Merge with template-mapped content (LLM takes priority)
      result.content.direct = { ...result.content.direct, ...direct };

      if (extracted.recommendedTemplate) {
        return {
          ...result,
          recommendedTemplate: extracted.recommendedTemplate as string,
          sections,
        };
      }
    } catch (err) {
      console.error("LLM extraction failed, falling back to direct mode:", err);
    }
  }

  return { ...result, recommendedTemplate: recommended, sections };
}
