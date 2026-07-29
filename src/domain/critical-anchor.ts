import * as z from "zod/v4";

export const criticalAnchorKindSchema = z.enum([
  "number",
  "unit",
  "negation",
  "time",
  "name",
  "approval",
  "condition",
  "obligation",
]);

export type CriticalAnchorKind = z.infer<typeof criticalAnchorKindSchema>;

export interface CanonicalCriticalAnchor {
  kind: CriticalAnchorKind;
  start: number;
  end: number;
  text: string;
}

const PATTERNS: Array<{ kind: CriticalAnchorKind; expression: RegExp }> = [
  { kind: "time", expression: /(?:\d[\d,.]*|[零一二三四五六七八九十百千万两]+)(?:个工作日|工作日|分钟|小时|天|日|周|个月|月|年)(?:内|前|后)?/gu },
  { kind: "time", expression: /每日|每周|每月|年度|月度|周期|定期|临时/gu },
  { kind: "number", expression: /(?:\d[\d,.]*(?:%|万元|元|㎡|家|个|名|项|次|台|套)?|[零一二三四五六七八九十百千万两]+(?:家|个|名|项|次|台|套))/gu },
  { kind: "negation", expression: /不得|不应|不能|不可|不少于|不超过|未经|未(?:完成|达到|通过|取得|收到|发现|发生|履行|执行|提交|批准|确认|验收|处理|整改|关闭|解决|中断|遗漏)|无需|无(?:中断|遗漏|停顿|异常|差错|缺失|风险|影响|变更|故障|损坏|泄漏|空缺)|严禁|禁止/gu },
  { kind: "approval", expression: /书面申请|书面批准|采购人审核|采购人批准|审核|审批|批准|同意|许可|签字/gu },
  { kind: "condition", expression: /仅限|只有|除非|如果|若|如遇|当[一-鿿]{0,12}时|在[一-鿿]{1,16}情况下|前提/gu },
  { kind: "obligation", expression: /必须|应当|应在|应于|应(?=[一-鿿])|须|需在|需(?=[一-鿿])|要求|确保|保证|至少|不少于|不超过/gu },
  { kind: "name", expression: /《[^》]+》|“[^”]+”|「[^」]+」|\b[A-Z][A-Za-z0-9._-]{1,30}\b|[一-鿿]{2,12}(?:壹号|一号|二号|三号|四号|五号|六号|七号|八号|九号|十号)|[一-鿿A-Za-z0-9]{2,24}(?:项目|中心|大学|学校|学院|总部|华府|雅苑|佳苑|楼|阁|园|公园|广场|道路|路|街道|公司|集团|委员会|政府|银行|医院|局|馆|站|所|市|县|区|镇|村)/gu },
];

export function extractCanonicalAnchors(text: string): CanonicalCriticalAnchor[] {
  const anchors: CanonicalCriticalAnchor[] = [];
  const seen = new Set<string>();
  for (const { kind, expression } of PATTERNS) {
    expression.lastIndex = 0;
    for (const match of text.matchAll(expression)) {
      const start = match.index;
      const value = match[0];
      if (start === undefined || !value) continue;
      const key = `${kind}:${start}:${start + value.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      anchors.push({ kind, start, end: start + value.length, text: value });
    }
  }
  const numericExpression = /(?:\d[\d,.]*|[零一二三四五六七八九十百千万两]+)/gu;
  for (const numeric of text.matchAll(numericExpression)) {
    if (numeric.index === undefined) continue;
    const tailStart = numeric.index + numeric[0].length;
    const tail = text.slice(tailStart, tailStart + 100);
    const associated = tail.match(/^\s*(?:[（(][^）)]{0,80}[）)])?\s*(万人次|人次|平方公里|平方米|工作日|公里|千米|千克|公斤|毫升|万元|分钟|小时|个月|㎡|%|株|辆|台|套|架|艘|座|栋|部|件|份|吨|升|家|个|名|项|次|人|组|处)(?!称)/u);
    if (!associated?.[1] || associated.index === undefined) continue;
    const relativeUnitStart = associated[0].lastIndexOf(associated[1]);
    const start = tailStart + associated.index + relativeUnitStart;
    const key = `unit:${start}:${start + associated[1].length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push({ kind: "unit", start, end: start + associated[1].length, text: associated[1] });
  }
  return anchors.sort((left, right) => left.start - right.start || left.end - right.end || left.kind.localeCompare(right.kind));
}
