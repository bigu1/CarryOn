import {
  CARD_TYPE_LABEL,
  CONTENT_LABEL,
  REVIEW_LABEL,
  type CardType,
  type ContentState,
  type ReviewState,
} from "../../domain/types";

export const ROLE_LABEL: Record<string, string> = {
  user: "用户",
  assistant: "AI",
  tool: "工具",
  unknown: "不确定",
};
export const ROLE_OPTIONS = ["user", "assistant", "tool", "unknown"] as const;

export function roleLabel(r: unknown) {
  return ROLE_LABEL[String(r)] ?? String(r);
}
export function typeLabel(t: unknown) {
  return CARD_TYPE_LABEL[String(t) as CardType] ?? String(t);
}
export function reviewLabel(r: unknown) {
  return REVIEW_LABEL[String(r) as ReviewState] ?? String(r);
}
export function contentLabel(s: unknown) {
  return CONTENT_LABEL[String(s) as ContentState] ?? String(s);
}

/** 十二种卡片按用途分五类展示；数据层不合并。 */
export const FAMILIES: Array<{ key: string; label: string; hint: string; types: CardType[] }> = [
  { key: "decision", label: "决定", hint: "用户自己作出的选择", types: ["user_decision"] },
  { key: "frame", label: "目标与约束", hint: "要达成什么、不能做什么", types: ["goal", "constraint"] },
  { key: "attempt", label: "试过的办法", hint: "做过什么、结果如何", types: ["attempt"] },
  { key: "question", label: "问题", hint: "还没解决或说不清的", types: ["open_question", "needs_clarification"] },
  {
    key: "reference",
    label: "仅供参考",
    hint: "AI 建议、设想、暂定安排、聊天里的说法、工具报告——都不是用户决定",
    types: ["ai_suggestion", "hypothesis", "tentative_plan", "reported_result", "tool_report"],
  },
  { key: "note", label: "备注", hint: "用户自己补充的，不是从聊天提炼的事实", types: ["user_note"] },
];

export function familyOf(t: unknown) {
  return FAMILIES.find((f) => f.types.includes(String(t) as CardType)) ?? FAMILIES[FAMILIES.length - 1];
}

export function formatTime(iso: unknown) {
  if (!iso) return "";
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 来源日期按材料原样显示（只有天就只显示天），不补时刻。 */
export function sourceDate(v: unknown) {
  return v ? String(v).replace("T", " ").replace(/:\d{2}(\.\d+)?Z?$/, "") : "日期未知";
}
