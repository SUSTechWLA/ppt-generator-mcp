import type { SourceDocument } from "../domain/source-document.js";
import { slideSpecSchema, type SlideSpec } from "../domain/slide-spec.js";
import { WorkflowError } from "../domain/workflow-error.js";
import type { TextProvider } from "../providers/contracts.js";

export const SLIDE_SPEC_SYSTEM_PROMPT = `你是中文商务投标单页信息设计师。请把提供的正文事实规划为一页 A4 横向信息页，并只返回 JSON。

硬性要求：
1. 所有标题、结论、正文、指标和图片语义只能来自 payload.facts；不得新增人物、数量、时限、承诺或结论。
2. 生成 3–6 个内容模块，每个模块必须填写 sourceFactIds；整页和每个资产也必须关联事实 ID。
3. 中文文案简洁、专业、适合采购评审；一个清晰结论，标题不超过 40 字，正文不超过 500 字。
4. 图片提示词描述真实、可信的中国商务或项目服务场景；图片中不得出现文字、Logo、水印或无法核验的数据。
5. 图片必须有完整中文 alt；图片规格固定 1792×1024；ID 从 img-001 连续编号。
6. 输出必须严格符合 SlideSpec JSON 结构，不要 Markdown，不要解释。`;

export function validateFactReferences(source: SourceDocument, spec: SlideSpec): void {
  const allowed = new Set(source.facts.map((fact) => fact.id));
  const referenced = new Set([
    ...spec.sourceFactIds,
    ...spec.blocks.flatMap((block) => block.sourceFactIds),
    ...spec.assets.flatMap((asset) => asset.sourceFactIds),
  ]);
  for (const factId of referenced) {
    if (!allowed.has(factId)) {
      throw new WorkflowError({
        code: "MODEL_FAILED",
        stage: "build_slide_spec",
        retryable: true,
        message: `Unknown source fact: ${factId}`,
        recovery: "Regenerate the specification using only provided fact IDs.",
      });
    }
  }
}

export async function buildSlideSpec(
  source: SourceDocument,
  provider: TextProvider,
  audience = "项目决策者",
): Promise<SlideSpec> {
  const raw = await provider.generateJson({
    schemaName: "slide_spec",
    system: SLIDE_SPEC_SYSTEM_PROMPT,
    payload: {
      audience,
      title: source.title,
      sections: source.sections.map(({ id, heading, keyPoints, order }) => ({ id, heading, keyPoints, order })),
      facts: source.facts,
    },
  });

  let spec: SlideSpec;
  try {
    spec = slideSpecSchema.parse(raw);
  } catch (cause) {
    throw new WorkflowError({
      code: "MODEL_FAILED",
      stage: "build_slide_spec",
      retryable: true,
      message: "Generated slide specification does not match the required schema",
      recovery: "Ask the content model to return a strict SlideSpec JSON object.",
      cause,
    });
  }
  validateFactReferences(source, spec);
  return spec;
}
