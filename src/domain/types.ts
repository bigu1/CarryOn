export const ROLES = ["user", "assistant", "tool", "unknown"] as const;
export type Role = (typeof ROLES)[number];

export const CARD_TYPES = [
  "goal",
  "user_decision",
  "ai_suggestion",
  "open_question",
  "constraint",
  "attempt",
  "needs_clarification",
  "reported_result",
  "hypothesis",
  "tentative_plan",
  "tool_report",
  "user_note",
] as const;
export type CardType = (typeof CARD_TYPES)[number];

export const REVIEW_STATES = ["pending", "confirmed", "rejected"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const CONTENT_STATES = [
  "active",
  "replaced",
  "needs_clarification",
  "unresolved",
  "reported_unverified",
  "user_resolved",
] as const;
export type ContentState = (typeof CONTENT_STATES)[number];

export type LibraryId = "personal" | "demo";

export type SourceType = "paste" | "txt" | "md" | "json" | "synthetic";

export interface JsonV1Message {
  externalId?: string | null;
  role: string;
  text: string;
  occurredAt?: string | null;
}

export interface JsonV1Conversation {
  externalId?: string | null;
  title: string;
  source?: string;
  occurredAt?: string | null;
  messages: JsonV1Message[];
}

export interface JsonV1Document {
  schemaVersion: 1;
  conversations: JsonV1Conversation[];
}

export interface PreviewMessage {
  seq: number;
  role: Role;
  originalLabel: string;
  text: string;
  occurredAt: string | null;
  warnings: string[];
  externalId?: string | null;
}

export interface PreviewConversation {
  title: string;
  sourceType: SourceType;
  occurredAt: string | null;
  occurredAtPrecision: "unknown" | "day" | "datetime";
  topicLabel: string;
  messages: PreviewMessage[];
  contentHash: string;
  externalId?: string | null;
  warnings: string[];
  duplicateOfSourceId?: string | null;
  revisionOfSourceId?: string | null;
  filename?: string;
}

export interface ImportPreview {
  id: string;
  createdAt: string;
  items: PreviewConversation[];
  rejected: Array<{ name: string; reason: string }>;
}

export const CARD_TYPE_LABEL: Record<CardType, string> = {
  goal: "目标",
  user_decision: "用户决定",
  ai_suggestion: "AI 建议",
  open_question: "未解决问题",
  constraint: "约束",
  attempt: "已尝试事项",
  needs_clarification: "待澄清",
  reported_result: "来源中的说法",
  hypothesis: "设想",
  tentative_plan: "暂定安排",
  tool_report: "工具报告",
  user_note: "用户备注",
};

export const REVIEW_LABEL: Record<ReviewState, string> = {
  pending: "待审核",
  confirmed: "已确认准确",
  rejected: "已拒绝",
};

export const CONTENT_LABEL: Record<ContentState, string> = {
  active: "记录中有效",
  replaced: "已被替代",
  needs_clarification: "待澄清",
  unresolved: "未解决",
  reported_unverified: "有解决说法但待核验",
  user_resolved: "用户标记已解决",
};
