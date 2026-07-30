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
import { joinChineseClauses } from "../domain/chinese-punctuation.js";

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
  // Split on blank-line-separated blocks (standard markdown paragraph boundaries)
  const blocks = text.split(/\n{2,}/);
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;

  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    const firstLine = lines[0];

    // Match headings: ### Title or ##### Title
    const hMatch = firstLine.match(/^(#{1,6})\s+(.+)/);
    if (hMatch) {
      if (current) sections.push(current);
      current = {
        level: hMatch[1].length,
        title: hMatch[2].replace(/^[\d.]+\s*/, "").trim(),
        paragraphs: [],
        keyPoints: [],
      };
      // Remaining lines in this block are body text
      const body = lines.slice(1).join("");
      if (body.length > 10) current.paragraphs.push(body);
      continue;
    }

    // Match list blocks: lines starting with - or * or 1.
    if (current && lines.every((l) => /^[-*•]\s|^\d+[\.\、\)]\s/.test(l))) {
      for (const li of lines) {
        const m = li.match(/^[-*•]\s+(.+)|^\d+[\.\、\)]\s*(.+)/);
        if (m) {
          const point = (m[1] || m[2] || "").trim();
          if (point.length < 80) current.keyPoints.push(point);
        }
      }
      continue;
    }

    // Regular paragraph block: join all lines
    if (current && block.trim().length > 10) {
      const paragraph = lines.join("");
      current.paragraphs.push(paragraph);
    }
  }

  if (current) sections.push(current);
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

  // Determine card width: visual template has mixed widths, others are uniform
  const isVisualTemplate = _templateSlug.includes("visual");
  const cardCount = totalCards >= 4 ? totalCards : Math.min(totalCards + 1, 4); // pad to fill template rows

  for (let i = 0; i < cardCount; i++) {
    const sub = subs[i];
    if (sub) {
      titles.push(sub.title);
      const fullText = sub.paragraphs[0] || joinChineseClauses(sub.keyPoints);
      const isNarrow = isVisualTemplate && i === 2; // span-4 in visual
      paragraphs.push(extractSentences(fullText, isNarrow ? 80 : 140));
    } else {
      // Padding row: use root context for extra card
      titles.push(`${root.title}总结`);
      paragraphs.push(extractSentences(root.paragraphs[0] || "", 120));
    }

    // Collect key points + generate image prompt
    if (sub) {
      for (const kp of sub.keyPoints.slice(0, 2)) {
        summaryPoints.push(kp);
      }
      const imgPrompt = generateImagePrompt(sub);
      if (imgPrompt) {
        imagePrompts.push({ sectionIndex: i, sectionTitle: sub.title, prompt: imgPrompt });
      }
    } else {
      // Padded row: derive prompt from root content
      imagePrompts.push({
        sectionIndex: i,
        sectionTitle: `${root.title}总结`,
        prompt: generateImagePrompt(root),
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

  direct["summary-text"] = extractSentences(
    `本方案针对${root.title}，从${titles.slice(0, 3).join("、")}等${titles.length}个方面进行了全面响应和详细部署。`,
    100,
  );
  direct["bullet"] = summaryPoints.slice(0, 4);

  // Visual component content — derive short meaningful labels from section titles
  const shortTitles = titles.map((t) => {
    // Extract the core keyword: remove common suffixes
    return t.replace(/配置方案|调配机制|审批流程|管理制度|管理体系/g, "").slice(0, 6);
  });

  const padLabels = (arr: string[], min: number, prefix: string): string[] => {
    const result = [...arr];
    while (result.length < min) result.push(`${prefix}${result.length + 1}`);
    return result.slice(0, min);
  };

  direct["step-label"] = padLabels(shortTitles, 5, "步骤");
  direct["stage-label"] = padLabels(shortTitles, 4, "阶段");
  direct["stage-number"] = ["01", "02", "03", "04"];
  direct["item-label"] = padLabels(shortTitles, 4, "能力项");
  direct["node-label"] = [
    shortTitles[0] || "对接人员",
    shortTitles[1] || "作业班组",
    shortTitles[2] || "管理体系",
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
  // For 3 sections with images, use text-image (1:1 pairs, each card gets its own image slot)
  if (subCount >= 3) return "green-infographic-bid-a4-landscape-text-image";
  return "green-infographic-bid-a4-landscape-text-image";
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract complete sentences from text, targeting maxLen but willing
 * to go slightly over to avoid fragments. Always returns coherent text.
 */
function extractSentences(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;

  const sentences = text.split(/(?<=[。！？；])/);
  let result = "";

  for (const s of sentences) {
    const next = result + s;
    // Include sentence if: (a) it fits, OR (b) current result is under half of maxLen
    if (next.length <= maxLen || result.length < maxLen * 0.55) {
      result = next;
    } else {
      break;
    }
  }

  // If we have at least one sentence with reasonable length, return it
  if (result.length >= 60) return result;
  // Otherwise, take the first sentence even if short
  if (sentences.length > 0) return sentences[0];
  return text.slice(0, maxLen);
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

const SUMMARIZE_PROMPT = `你是一位标书技术方案撰写专家。请将以下段落改写为一段{targetLen}字以内的精炼正文，用于PPT卡片展示。

改写要求：
1. 保留所有具体数字、项目名称、面积数据
2. 保持原文的核心论证逻辑和关键结论
3. 句子之间衔接自然流畅，读起来通顺
4. 整段是一个完整的、自洽的论述
5. 以句号结尾
6. 直接输出改写后的段落，不要加任何标题或解释

原文：
{text}`;

async function summarizeParagraph(
  text: string,
  targetLen: number,
  config?: LLMConfig,
): Promise<string> {
  if (!config || text.length <= targetLen) return extractSentences(text, targetLen);

  try {
    const prompt = SUMMARIZE_PROMPT
      .replace("{targetLen}", String(targetLen))
      .replace("{text}", text);
    const result = await generateText(config, "", prompt);
    const cleaned = result.trim();
    if (cleaned.length > 0) {
      // Ensure it ends with a period
      return cleaned.endsWith("。") ? cleaned : cleaned + "。";
    }
    return extractSentences(text, targetLen);
  } catch {
    return extractSentences(text, targetLen);
  }
}

function generateImagePrompt(section: ParsedSection): string {
  const title = section.title;
  const fullText = section.paragraphs.join(" ");
  const keywords = extractKeywords(fullText);

  // Build detailed, DALL-E/SD-ready prompt from section content
  const sceneMap: Array<{ test: (t: string) => boolean; build: () => string }> = [
    {
      test: (t) => t.includes("对接") || t.includes("配置") || t.includes("人员配备"),
      build: () => {
        const details = keywords.filter((k) => k.length > 1).slice(0, 5).join("、");
        return `专业商务场景摄影：一名园林养护项目对接人员正在现代化办公室内与业主代表进行工作沟通，桌面上摆放着养护计划文件、工作台账和通信设备。项目对接人员身穿整洁的商务便装，手持文件正在汇报工作进展。窗外可见绿色园林景观。构图采用中景平视角度，自然光线从窗户透入，画面色调以绿色和白色为主，写实摄影风格，高清画质，适合标书配图。关键元素：${details || "项目对接、文档管理、专业沟通"}`;
      },
    },
    {
      test: (t) => t.includes("调配") || t.includes("动态") || t.includes("班组"),
      build: () => {
        const projects = fullText.match(/[^\s，。；]+（[\d,.]+㎡）/g) || [];
        const names = projects.slice(0, 3).join("、");
        return `园林养护管理信息图：展示8个物业项目的作业人员动态调配体系。画面以绿色渐变背景为主，中央为项目分布地图，标注${names || "各项目区域"}。左侧为基础配置层（稳定班组图标），中间为季节性调配层（春夏秋冬四色箭头），右侧为任务驱动层（闪电响应图标）。整体采用信息图设计风格，配色以绿色(#0B5A2A)、青色(#1D9DB2)、橙色(#D98A12)、蓝色(#0B84E6)为主，简洁专业的商务风格，适合标书插图。`;
      },
    },
    {
      test: (t) => t.includes("变更") || t.includes("审批") || t.includes("流程"),
      build: () => {
        const steps = fullText.match(/第[一二三四五六七八]步[^。；]+/g) || [];
        const stepNames = steps.slice(0, 5).map((s) => s.slice(0, 20)).join(" → ");
        return `标准化审批流程图：展示项目对接人员变更申请的完整审批链路。${stepNames ? "流程步骤：" + stepNames : "从提交书面申请到最终批复执行"}。采用纵向信息图布局，每个步骤以圆角卡片展示，卡片内包含步骤编号、名称和关键说明。箭头连接各步骤表示流转方向。配色以绿色(#0B5A2A)为主色调，已完成步骤为实色填充，待处理步骤为虚线边框。背景为浅灰绿色(#F2F7EF)，整体简洁大气，适合标书插图。`;
      },
    },
  ];

  for (const { test, build } of sceneMap) {
    if (test(title + fullText)) return build();
  }

  return `园林绿化养护相关场景示意图：${title}。绿色植被背景，阳光充足，写实摄影风格，高清画质，适合标书配图。关键内容：${keywords.slice(0, 5).join("、")}`;
}

/** Extract meaningful keywords from text for prompt enrichment */
function extractKeywords(text: string): string[] {
  // Match named entities, numbers, and key terms
  const patterns = [
    /[一-鿿]{2,}(?:人员|班组|项目|方案|机制|流程|体系|管理|养护|绿化|园林)/g,
    /[一-鿿]+（[\d,.]+㎡）/g,
    /\d+个(?:一-鿿]+)/g,
    /\d+分钟内/g,
  ];
  const keywords = new Set<string>();
  for (const pattern of patterns) {
    for (const m of text.match(pattern) || []) {
      keywords.add(m);
    }
  }
  return Array.from(keywords);
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
        const isLastNarrow = (totalCards === 3 && i === 2);
        const targetLen = isLastNarrow ? 70 : 130;
        if (paragraphs[i].length > targetLen + 20) {
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
