import { contentHash } from "../../shared/hash.js";
import { LIMITS } from "../../shared/limits.js";
import type { PreviewConversation, Role } from "../../domain/types.js";
import { datePrecision } from "../../importers/json.js";
import { previewBatch, type ImportInput } from "../../importers/batch.js";
import { questionTerms } from "../../ai/jobs.js";
import { errMessage, lib, router, rt, storeOf } from "../ctx.js";
import { importInput } from "../validation.js";

export const sourceRoutes = router();

sourceRoutes.post("/api/imports/preview", async (c) => {
  const checked = importInput.safeParse(await c.req.json().catch(() => null));
  if (!checked.success) return c.json({ error: "导入请求无效，请检查文件数量和文本格式" }, 400);
  const body = checked.data;
  const preview = previewBatch(storeOf(c), body);
  if ("error" in preview) return c.json(preview, 400);
  rt(c).previews.set(preview.id, { ...preview, library: lib(c) });
  return c.json({ preview });
});

sourceRoutes.post("/api/imports/cancel", async (c) => {
  const body = await c.req.json<{ previewId?: string }>().catch(() => ({}) as { previewId?: string });
  if (body.previewId) rt(c).previews.delete(body.previewId);
  return c.json({ ok: true });
});

sourceRoutes.post("/api/imports/confirm", async (c) => {
  const body = await c.req.json<{
    previewId?: string;
    items?: Array<{
      index: number;
      skip?: boolean;
      topicLabel?: string;
      title?: string;
      occurredAt?: string | null;
      messages?: PreviewConversation["messages"];
    }>;
  }>();
  const runtime = rt(c);
  const preview = body.previewId ? runtime.previews.get(body.previewId) : undefined;
  if (!preview) return c.json({ error: "预览已失效或不存在，没有写入正式库" }, 400);
  if (preview.library !== lib(c)) return c.json({ error: "资料库已切换，请在当前库重新预览后导入" }, 409);
  const st = storeOf(c);
  const results = [];
  for (const [index, it] of preview.items.entries()) {
    const corr = body.items?.find((x) => x.index === index);
    if (corr?.skip) {
      results.push({ title: it.title, status: "skipped" });
      continue;
    }
    const date = datePrecision(corr?.occurredAt === undefined ? it.occurredAt : corr.occurredAt);
    // 只接受对角色的更正；正文以服务端预览为准，浏览器不能借确认改写原文
    const messages = it.messages.map((m, j) => {
      const role = corr?.messages?.[j]?.role;
      return role && ["user", "assistant", "tool", "unknown"].includes(role) ? { ...m, role: role as Role } : m;
    });
    const merged: PreviewConversation = {
      ...it,
      title: corr?.title?.trim() || it.title,
      topicLabel: corr?.topicLabel?.trim() || it.topicLabel || it.title,
      occurredAt: date.occurredAt,
      occurredAtPrecision: date.precision,
      messages,
    };
    merged.contentHash = contentHash(merged.messages);
    if (date.warning) merged.warnings = [...merged.warnings, date.warning];
    if (merged.messages.some((m) => m.text.length > LIMITS.messageChars)) {
      results.push({ title: merged.title, status: "failed", reason: "单条超限，未入库" });
      continue;
    }
    try {
      results.push({ title: merged.title, ...st.importConfirmed(merged) });
    } catch (e) {
      results.push({ title: merged.title, status: "failed", reason: errMessage(e, "失败") });
    }
  }
  runtime.previews.delete(preview.id);
  return c.json({ results });
});

sourceRoutes.get("/api/sources", (c) => {
  const topicId = c.req.query("topicId") || undefined;
  return c.json({ sources: storeOf(c).listSources(topicId ? { topicId } : undefined) });
});

sourceRoutes.get("/api/sources/:id", (c) => {
  const st = storeOf(c);
  const source = st.getSource(c.req.param("id"));
  if (!source || source.deleted_at) return c.json({ error: "资料不存在或已删除" }, 404);
  const revision = c.req.query("revision") || undefined;
  const current = String(source.current_revision_id);
  const revisions = st.db
    .prepare("SELECT id, version, created_at FROM source_revisions WHERE source_id=? ORDER BY version DESC")
    .all(c.req.param("id"));
  const cards = st.db
    .prepare(
      `SELECT DISTINCT c.id, c.title, c.type, c.review_state, c.invalidated, x.message_id
         FROM cards c JOIN citations x ON x.card_id=c.id WHERE x.source_id=?`,
    )
    .all(c.req.param("id"));
  return c.json({
    source,
    messages: st.listMessages(c.req.param("id"), revision),
    viewingRevision: revision ?? current,
    isHistoricalRevision: !!(revision && revision !== current),
    revisions,
    cards,
  });
});

sourceRoutes.patch("/api/sources/:id", async (c) => {
  const body = await c.req.json<{
    title?: string;
    topicLabel?: string;
    occurredAt?: string | null;
    messages?: Array<{ id: string; role: Role }>;
  }>();
  if (body.occurredAt) {
    const d = datePrecision(body.occurredAt);
    if (d.warning) return c.json({ error: d.warning }, 400);
  }
  if (body.messages?.some((m) => !["user", "assistant", "tool", "unknown"].includes(m.role))) {
    return c.json({ error: "未知说话人角色，校正未保存" }, 400);
  }
  try {
    storeOf(c).updateSourceMeta(c.req.param("id"), {
      ...body,
      occurredAtPrecision: body.occurredAt ? datePrecision(body.occurredAt).precision : undefined,
    });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: errMessage(e, "无法保存") }, 400);
  }
});

sourceRoutes.get("/api/sources/:id/impact", (c) => {
  const src = storeOf(c).getSource(c.req.param("id"));
  if (!src || src.deleted_at) return c.json({ error: "资料不存在" }, 404);
  return c.json({
    impact: storeOf(c).deleteImpact(c.req.param("id")),
    note: "已下载到外部的备份不会被自动删除。这不是磁盘取证级擦除。",
  });
});

sourceRoutes.delete("/api/sources/:id", (c) => {
  try {
    return c.json({ ok: true, impact: storeOf(c).deleteSource(c.req.param("id")) });
  } catch (e) {
    return c.json({ error: errMessage(e, "删除失败") }, 400);
  }
});

sourceRoutes.get("/api/search", (c) => {
  const q = c.req.query("q") ?? "";
  const topicId = c.req.query("topicId") || undefined;
  const st = storeOf(c);
  const result = st.search({
    q,
    topicId,
    role: c.req.query("role") || undefined,
    dateFrom: c.req.query("dateFrom") || undefined,
    dateTo: c.req.query("dateTo") || undefined,
    includeUnknownDate: c.req.query("includeUnknownDate") === "1" || c.req.query("includeUnknownDate") === "true",
    page: Number(c.req.query("page") ?? 1),
    pageSize: Number(c.req.query("pageSize") ?? 20),
  });
  const page = Number(c.req.query("page") ?? 1);
  // 整句没有字面命中时，拆出能命中的词给用户点，而不是只说「没有命中」
  const suggestions =
    result.total === 0 && q.trim()
      ? questionTerms(q)
          .filter((t) => t !== q.trim().toLowerCase())
          .sort((a, b) => Array.from(b).length - Array.from(a).length)
          .slice(0, 8)
          .map((t) => ({ term: t, total: st.search({ q: t, topicId, pageSize: 1 }).total }))
          .filter((x) => x.total > 0)
          .slice(0, 5)
      : [];
  return c.json({ ...result, suggestions, cards: page <= 1 ? st.searchCards({ q, topicId }) : [] });
});
