import { locateQuote, validateCitation } from "../../domain/citations.js";
import { CARD_TYPES, type CardType } from "../../domain/types.js";
import type { ReviewPatch } from "../../domain/review.js";
import { ReviewError } from "../../storage/db.js";
import { errMessage, router, storeOf } from "../ctx.js";

export const cardRoutes = router();

cardRoutes.get("/api/topics", (c) => c.json({ topics: storeOf(c).listTopics() }));

cardRoutes.post("/api/topics", async (c) => {
  const body = await c.req.json<{ label?: string }>().catch(() => ({}) as { label?: string });
  if (!body.label?.trim()) return c.json({ error: "请填写主题名称" }, 400);
  return c.json({ topic: storeOf(c).ensureTopic(body.label.trim()) });
});

cardRoutes.get("/api/topics/:id", (c) => {
  const st = storeOf(c);
  const topicId = c.req.param("id");
  const topic = st.getTopic(topicId);
  if (!topic) return c.json({ error: "主题不存在" }, 404);
  const cards = st.listCards({ topicId });
  return c.json({
    topic,
    cards,
    sources: st.listSources({ topicId }),
    replacements: st.listReplacements(topicId),
    conflicts: possibleConflicts(cards),
    handoffs: st.listHandoffs(topicId),
  });
});

cardRoutes.get("/api/cards", (c) =>
  c.json({
    cards: storeOf(c).listCards({
      topicId: c.req.query("topicId") || undefined,
      reviewState: c.req.query("reviewState") || undefined,
    }),
  }),
);

cardRoutes.get("/api/cards/:id", (c) => {
  const st = storeOf(c);
  const card = st.getCard(c.req.param("id"));
  if (!card) return c.json({ error: "卡片不存在" }, 404);
  return c.json({ card, revisions: st.cardRevisions(card.id).map((r) => ({ id: r.id, at: r.at })) });
});

/** 给核对页：引用片段连同前后各一条原文。 */
cardRoutes.get("/api/messages/:id/context", (c) => {
  const st = storeOf(c);
  const msg = st.getMessage(c.req.param("id"));
  if (!msg) return c.json({ error: "原文片段不存在" }, 404);
  const src = st.getSource(String(msg.source_id));
  if (!src || src.deleted_at) return c.json({ error: "来源资料已删除" }, 404);
  const rows = st.db
    .prepare("SELECT id, role, original_label, text, seq FROM messages WHERE source_id=? AND revision_id=? AND seq BETWEEN ? AND ? ORDER BY seq")
    .all(String(msg.source_id), String(msg.revision_id), Number(msg.seq) - 1, Number(msg.seq) + 1);
  return c.json({
    source: { id: src.id, title: src.title, occurred_at: src.occurred_at, topic_label: src.topic_label },
    historical: String(msg.revision_id) !== String(src.current_revision_id),
    messageId: msg.id,
    context: rows,
  });
});

cardRoutes.post("/api/cards", async (c) => {
  const body = await c.req.json<{
    topicId?: string;
    type?: CardType;
    title?: string;
    body?: string;
    isUserNote?: boolean;
    citations?: Array<{ messageId: string; quote?: string; startCp?: number; endCp?: number }>;
  }>();
  if (!body.topicId || !body.title?.trim() || !body.body?.trim() || !body.type) {
    return c.json({ error: "请填写主题、类型、标题和正文" }, 400);
  }
  if (!CARD_TYPES.includes(body.type)) return c.json({ error: "未知卡片类型" }, 400);
  const st = storeOf(c);
  if (!st.getTopic(body.topicId)) return c.json({ error: "主题不存在" }, 400);
  const cites = [];
  for (const raw of body.citations ?? []) {
    const msg = st.getMessage(raw.messageId);
    if (!msg || st.getSource(String(msg.source_id))?.deleted_at) {
      return c.json({ error: "引用指向不存在的原文" }, 400);
    }
    const segment = {
      id: String(msg.id),
      sourceId: String(msg.source_id),
      revisionId: String(msg.revision_id),
      text: String(msg.text),
      startCp: Number(msg.start_cp),
      endCp: Number(msg.end_cp),
    };
    let start = raw.startCp;
    let end = raw.endCp;
    let quote = raw.quote ?? "";
    if (start == null || end == null) {
      if (!quote) return c.json({ error: "引用需要原文摘录" }, 400);
      const loc = locateQuote(segment, quote);
      if (!loc) return c.json({ error: "摘录在原文中找不到" }, 400);
      if (locateQuote(segment, quote, 1)) return c.json({ error: "摘录在这一段重复出现，请从原文选中准确位置再建卡" }, 400);
      start = loc.startCp;
      end = loc.endCp;
    } else {
      quote = quote || Array.from(segment.text).slice(start, end).join("");
    }
    const cite = { sourceId: segment.sourceId, revisionId: segment.revisionId, messageId: segment.id, startCp: start, endCp: end, quote };
    const v = validateCitation(cite, segment, new Set([segment.sourceId]));
    if (!v.ok) return c.json({ error: v.reason }, 400);
    cites.push(cite);
  }
  const isNote = !!body.isUserNote || body.type === "user_note";
  if (!isNote && body.type === "user_decision" && !cites.some((x) => st.getMessage(x.messageId)?.role === "user")) {
    return c.json({ error: "用户决定需要用户采纳的原文；请改为 AI 建议、待澄清或用户备注" }, 400);
  }
  if (!isNote && cites.length === 0) {
    return c.json({ error: "从聊天提炼的卡片至少要有一处可打开的原文引用。没有来源请标为用户备注。" }, 400);
  }
  const card = st.createCard({
    topicId: body.topicId,
    type: isNote ? "user_note" : body.type,
    title: body.title.trim(),
    body: body.body.trim(),
    createdVia: "manual",
    isUserNote: isNote,
    citations: cites,
  });
  return c.json({ card });
});

cardRoutes.patch("/api/cards/:id", async (c) => {
  const body = await c.req.json<ReviewPatch>();
  try {
    return c.json({ card: storeOf(c).updateCard(c.req.param("id"), body) });
  } catch (e) {
    if (e instanceof ReviewError) return c.json({ error: e.message, code: e.code }, e.code === "not_found" ? 404 : 400);
    return c.json({ error: errMessage(e, "无法保存") }, 400);
  }
});

cardRoutes.post("/api/cards/:id/replace", async (c) => {
  const body = await c.req.json<{ oldCardId?: string }>().catch(() => ({}) as { oldCardId?: string });
  if (!body.oldCardId) return c.json({ error: "请指定被替代的旧卡片" }, 400);
  try {
    storeOf(c).confirmReplacement(body.oldCardId, c.req.param("id"));
    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof ReviewError) return c.json({ error: e.message }, e.code === "not_found" ? 404 : 400);
    return c.json({ error: errMessage(e, "无法保存") }, 400);
  }
});

cardRoutes.delete("/api/replacements/:id", (c) => {
  try {
    storeOf(c).undoReplacement(c.req.param("id"));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: errMessage(e, "无法撤销") }, 400);
  }
});

/** 同主题里还有效的多条用户决定，提示可能发生变更；只提示，不替用户判断哪条最新。 */
function possibleConflicts(cards: Array<Record<string, unknown>>) {
  const decisions = cards.filter(
    (c) =>
      c.type === "user_decision" &&
      Number(c.invalidated) === 0 &&
      c.review_state !== "rejected" &&
      c.content_state !== "replaced",
  );
  if (decisions.length < 2) return [];
  return [
    {
      message: `这个主题有 ${decisions.length} 条仍然有效的决定，可能前后有变化。日期更晚本身不是替代证据，需要你对照原文后确认哪条替代了哪条。`,
      cardIds: decisions.map((d) => d.id),
      titles: decisions.map((d) => d.title),
    },
  ];
}
