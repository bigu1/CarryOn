import { assertEndpoint } from "../../ai/client.js";
import { planPreview, planSend, runJob, type JobKind, type JobRequest } from "../../ai/jobs.js";
import { router, rt, storeOf } from "../ctx.js";
import { aiRequest, modelConfig } from "../validation.js";

export const aiRoutes = router();

aiRoutes.post("/api/ai/config", async (c) => {
  const checked = modelConfig.safeParse(await c.req.json().catch(() => null));
  if (!checked.success) {
    return c.json({ error: "请填写服务地址、模型名和本次凭据" }, 400);
  }
  const body = checked.data;
  const ep = assertEndpoint(body.baseUrl);
  if (!ep.ok) return c.json({ error: ep.reason }, 400);
  const runtime = rt(c);
  runtime.model = { baseUrl: body.baseUrl.replace(/\/$/, ""), model: body.model, apiKey: body.apiKey };
  return c.json({
    configured: true,
    baseUrl: runtime.model.baseUrl,
    model: runtime.model.model,
    note: "凭据只留在本次进程内存，重启后需重填。不会写入数据库、导出或浏览器存储。",
  });
});

aiRoutes.delete("/api/ai/config", (c) => {
  rt(c).model = undefined;
  return c.json({ configured: false });
});

aiRoutes.get("/api/ai/status", (c) => {
  const model = rt(c).model;
  return c.json({
    configured: !!model,
    baseUrl: model?.baseUrl ?? null,
    model: model?.model ?? null,
    runningJobs: storeOf(c).runningJobCount(),
  });
});

const run = (kind: JobKind) =>
  aiRoutes.post(`/api/ai/${kind}`, async (c) => {
    const runtime = rt(c);
    if (!runtime.model) return c.json({ error: "需要连接模型", hint: "改用关键词查找或手动整理" }, 400);
    const checked = aiRequest.safeParse(await c.req.json().catch(() => null));
    if (!checked.success) return c.json({ error: "发送参数无效，请检查范围和正文长度" }, 400);
    const body = checked.data;
    if (!body.confirmSend) return c.json({ error: "请确认本次要发送的范围后再发送" }, 400);
    const result = await runJob({ st: storeOf(c), model: runtime.model, kind, request: body, abort: runtime.abort });
    return c.json(result.body, result.status);
  });
run("extract");
run("answer");
run("polish");

aiRoutes.post("/api/ai/jobs/:id/cancel", (c) => {
  storeOf(c).cancelJob(c.req.param("id"));
  rt(c).abort.get(c.req.param("id"))?.abort();
  return c.json({ ok: true });
});

aiRoutes.get("/api/ai/jobs/running", (c) => {
  const row = storeOf(c).db.prepare("SELECT id, kind, created_at FROM analysis_jobs WHERE status='running' ORDER BY created_at DESC LIMIT 1").get();
  return c.json({ job: row ?? null });
});

aiRoutes.post("/api/ai/preview-scope", async (c) => {
  const checked = aiRequest.safeParse(await c.req.json().catch(() => null));
  if (!checked.success) return c.json({ error: "预览参数无效，请检查范围和正文长度" }, 400);
  const body = checked.data;
  const kind: JobKind = body.kind ?? (body.handoffBody?.trim() ? "polish" : body.question ? "answer" : "extract");
  const st = storeOf(c);
  return c.json(planPreview(st, planSend(st, kind, body), rt(c).model));
});
