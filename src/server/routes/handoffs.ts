import { nowIso } from "../../shared/ids.js";
import { sha256 } from "../../shared/hash.js";
import { buildHandoff } from "../../domain/handoff.js";
import { router, storeOf } from "../ctx.js";

export const handoffRoutes = router();

type HandoffBody = {
  topicId?: string;
  goal?: string;
  variant?: "short" | "full";
  includePending?: boolean;
  includeCardIds?: string[];
  bodyText?: string;
  previewToken?: string;
};

function build(st: ReturnType<typeof storeOf>, body: HandoffBody & { topicId: string; goal: string }) {
  const topic = st.getTopic(body.topicId) as { label: string } | undefined;
  if (!topic) return null;
  const material = st.handoffMaterial(body.topicId);
  const result = buildHandoff({
    goal: body.goal,
    topicLabel: topic.label,
    cards: material.cards,
    sources: material.sources,
    variant: body.variant ?? "short",
    includePending: !!body.includePending,
    includeCardIds: body.includeCardIds ?? null,
  });
  return { ...result, previewToken: sha256(JSON.stringify({ result, goal: body.goal, variant: body.variant,
    versions: st.sourceVersions(material.sources.map((s) => s.id)) })) };
}

handoffRoutes.post("/api/handoffs/preview", async (c) => {
  const body = await c.req.json<HandoffBody>();
  if (!body.topicId || !body.goal?.trim()) return c.json({ error: "请选择主题并写下这次希望对方解决什么" }, 400);
  const built = build(storeOf(c), { ...body, topicId: body.topicId, goal: body.goal });
  if (!built) return c.json({ error: "主题不存在" }, 404);
  return c.json({ ...built, generatedAt: nowIso(), modelUsed: false });
});

/** 保存一份交接快照。正文可以是用户编辑或润色后的版本；包含哪些卡由服务端按同样规则重新算，不信浏览器。 */
handoffRoutes.post("/api/handoffs", async (c) => {
  const body = await c.req.json<HandoffBody>();
  if (!body.topicId || !body.goal?.trim()) return c.json({ error: "缺少主题或目标" }, 400);
  const st = storeOf(c);
  const built = build(st, { ...body, topicId: body.topicId, goal: body.goal });
  if (!built) return c.json({ error: "主题不存在" }, 404);
  if (body.previewToken && body.previewToken !== built.previewToken) {
    return c.json({ error: "资料或卡片已变化，请重新生成交接后再保存或下载" }, 409);
  }
  const row = st.saveHandoff({
    topicId: body.topicId,
    goal: body.goal,
    variant: body.variant ?? "short",
    body: body.bodyText?.trim() ? body.bodyText : built.body,
    includedCardIds: built.included.map((x) => x.id),
    excluded: built.excluded,
  });
  return c.json({ handoff: row });
});

handoffRoutes.get("/api/handoffs/:id", (c) => {
  const row = storeOf(c).getHandoff(c.req.param("id"));
  if (!row) return c.json({ error: "交接不存在" }, 404);
  return c.json({ handoff: row });
});
