import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getLibraryCookie, protect } from "./protect.js";
import type { Runtime } from "./runtime.js";
import type { Env } from "./ctx.js";
import { libraryRoutes } from "./routes/library.js";
import { sourceRoutes } from "./routes/sources.js";
import { cardRoutes } from "./routes/cards.js";
import { handoffRoutes } from "./routes/handoffs.js";
import { aiRoutes } from "./routes/ai.js";

/**
 * HTTP 层只做：本机防护、解析参数、调用领域/存储、翻译错误。
 * 规则所在：卡片审核 domain/review.ts，交接 domain/handoff.ts，检索 search/search.ts，
 * 模型任务 ai/jobs.ts，导入 importers/batch.ts，删除与备份 storage/。
 */
export function createApp(runtime: Runtime) {
  const app = new Hono<Env>();
  app.use("/api/*", async (c, next) => {
    c.set("rt", runtime);
    c.set("library", getLibraryCookie(c));
    return protect(c, next);
  });
  app.use("/api/*", bodyLimit({ maxSize: 64 * 1024 * 1024,
    onError: (c) => c.json({ error: "请求超过 64 MiB，请分批导入或缩小备份" }, 413) }));
  app.onError((e, c) => c.json({ error: e instanceof SyntaxError ? "请求不是合法 JSON" : "操作失败，资料未能处理，请检查输入后重试" }, e instanceof SyntaxError ? 400 : 500));
  app.route("/", libraryRoutes);
  app.route("/", sourceRoutes);
  app.route("/", cardRoutes);
  app.route("/", handoffRoutes);
  app.route("/", aiRoutes);
  app.all("/api/*", (c) => c.json({ error: "没有这个接口" }, 404));
  return app;
}
