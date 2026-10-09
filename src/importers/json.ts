import { z } from "zod";
import { contentHash } from "../shared/hash.js";
import { LIMITS } from "../shared/limits.js";
import type {
  JsonV1Document,
  PreviewConversation,
  PreviewMessage,
  Role,
  SourceType,
} from "../domain/types.js";
import { ROLES } from "../domain/types.js";

const messageSchema = z.object({
  externalId: z.string().nullish(),
  role: z.string(),
  text: z.string(),
  occurredAt: z.string().nullish(),
});

const conversationSchema = z.object({
  externalId: z.string().nullish(),
  title: z.string().min(1),
  source: z.string().optional(),
  occurredAt: z.string().nullish(),
  messages: z.array(messageSchema).min(1),
});

export const jsonV1Schema = z.object({
  schemaVersion: z.literal(1),
  conversations: z.array(conversationSchema).min(1),
});

export type ParseFail = { ok: false; reason: string };
export type ParseOk = { ok: true; doc: JsonV1Document; extrasIgnored: boolean };

export function parseJsonV1(raw: string): ParseOk | ParseFail {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "不是合法 JSON" };
  }
  if (!data || typeof data !== "object") {
    return { ok: false, reason: "JSON 根节点必须是对象" };
  }
  const rec = data as Record<string, unknown>;
  if (!("schemaVersion" in rec)) {
    return { ok: false, reason: "缺少 schemaVersion，不能把其它导出当成续上 JSON" };
  }
  if (rec.schemaVersion !== 1) {
    return { ok: false, reason: `不支持的 schemaVersion：${String(rec.schemaVersion)}` };
  }
  const parsed = jsonV1Schema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, reason: `JSON v1 字段不完整：${parsed.error.issues[0]?.message ?? "校验失败"}` };
  }
  return { ok: true, doc: parsed.data as JsonV1Document, extrasIgnored: true };
}

function normalizeRole(role: string): { role: Role; warning?: string } {
  const r = role.trim().toLowerCase();
  if ((ROLES as readonly string[]).includes(r)) return { role: r as Role };
  return { role: "unknown", warning: `未知角色「${role}」已记为不确定` };
}

export function datePrecision(value: string | null | undefined): {
  occurredAt: string | null;
  precision: "unknown" | "day" | "datetime";
  warning?: string;
} {
  if (!value) return { occurredAt: null, precision: "unknown" };
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { occurredAt: value, precision: "day" };
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    return {
      occurredAt: null,
      precision: "unknown",
      warning: `日期不合法：${value}，已记为来源日期未知`,
    };
  }
  return { occurredAt: value, precision: "datetime" };
}

export function documentToPreviews(
  doc: JsonV1Document,
  sourceType: SourceType,
  filename?: string,
): PreviewConversation[] {
  return doc.conversations.map((c) => {
    const warnings: string[] = [];
    const date = datePrecision(c.occurredAt);
    if (date.warning) warnings.push(date.warning);
    const messages: PreviewMessage[] = c.messages.map((m, seq) => {
      const mw: string[] = [];
      if (m.text.length > LIMITS.messageChars) {
        mw.push(`单条消息超过 ${LIMITS.messageChars} 字，请拆分后再导入，不会静默截断`);
      }
      const nr = normalizeRole(m.role);
      if (nr.warning) mw.push(nr.warning);
      const md = datePrecision(m.occurredAt);
      if (md.warning) mw.push(md.warning);
      if (m.text.includes("\u0000")) mw.push("包含空字符，已拒绝按二进制处理");
      return {
        seq,
        role: nr.role,
        originalLabel: m.role,
        text: m.text,
        occurredAt: md.occurredAt,
        warnings: mw,
        externalId: m.externalId ?? null,
      };
    });
    return {
      title: c.title,
      sourceType: c.source === "synthetic" ? "synthetic" : sourceType,
      occurredAt: date.occurredAt,
      occurredAtPrecision: date.precision,
      topicLabel: c.title.replace(/^演示资料：|^合成测试：/, "") || "未命名主题",
      messages,
      contentHash: contentHash(messages),
      externalId: c.externalId ?? null,
      warnings,
      filename,
    };
  });
}
