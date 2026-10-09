import { setCookie } from "hono/cookie";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LIMITS } from "../../shared/limits.js";
import { nowIso } from "../../shared/ids.js";
import type { LibraryId } from "../../domain/types.js";
import { documentToPreviews, parseJsonV1 } from "../../importers/json.js";
import { buildBackup, restoreToEmptyOrSwap, verifyBackup } from "../../storage/backup.js";
import { reopenStore } from "../runtime.js";
import { ensureSession, LIBRARY_COOKIE } from "../protect.js";
import { errMessage, lib, router, rt, storeOf } from "../ctx.js";

export const libraryRoutes = router();

libraryRoutes.get("/api/health", (c) => c.json({ ok: true, name: "续上", library: lib(c), time: nowIso() }));

libraryRoutes.get("/api/session", (c) => {
  const s = ensureSession(c);
  const model = rt(c).model;
  return c.json({
    csrf: s.csrf,
    library: lib(c),
    dataRoot: rt(c).dataRoot,
    model: model ? { configured: true, baseUrl: model.baseUrl, model: model.model } : { configured: false },
    limits: LIMITS,
  });
});

libraryRoutes.post("/api/library", async (c) => {
  const body = (await c.req.json<{ library?: string }>().catch(() => ({}))) as { library?: string };
  const library: LibraryId = body.library === "demo" ? "demo" : "personal";
  setCookie(c, LIBRARY_COOKIE, library, { httpOnly: false, sameSite: "Strict", path: "/" });
  c.set("library", library);
  return c.json({ library, counts: storeOf(c).counts() });
});

libraryRoutes.get("/api/home", (c) => {
  const st = storeOf(c);
  return c.json({
    library: lib(c),
    counts: st.counts(),
    topics: st.listTopics(),
    recentSources: st.listSources().slice(0, 6),
    pending: st.listCards({ reviewState: "pending" }).length,
    modelConfigured: !!rt(c).model,
  });
});

libraryRoutes.post("/api/imports/demo", (c) => {
  if (lib(c) !== "demo") return c.json({ error: "演示资料只会写入演示库。请先切换到演示库。" }, 400);
  const fixture = join(process.cwd(), "docs/specification/05-演示导入.json");
  if (!existsSync(fixture)) return c.json({ error: "找不到演示资料" }, 500);
  const parsed = parseJsonV1(readFileSync(fixture, "utf8"));
  if (!parsed.ok) return c.json({ error: parsed.reason }, 500);
  const st = storeOf(c);
  const results = documentToPreviews(parsed.doc, "synthetic").map((it) => {
    try {
      return { title: it.title, ...st.importConfirmed(it) };
    } catch (e) {
      return { title: it.title, status: "failed", reason: errMessage(e, "失败") };
    }
  });
  return c.json({ results });
});

libraryRoutes.post("/api/demo/reset", (c) => {
  if (lib(c) !== "demo") return c.json({ error: "只能重置演示库，个人资料不受影响" }, 400);
  const runtime = rt(c);
  const path = `${runtime.dataRoot}/demo/xushang.db`;
  try {
    storeOf(c).close();
  } catch {
    /* ignore */
  }
  runtime.stores.delete("demo");
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(path + suffix)) rmSync(path + suffix);
  }
  return c.json({ ok: true, library: "demo", personalUntouched: true });
});

libraryRoutes.get("/api/data", (c) =>
  c.json({ library: lib(c), dataRoot: rt(c).dataRoot, counts: storeOf(c).counts(), bind: "127.0.0.1" }),
);

libraryRoutes.get("/api/backup", (c) => {
  const pack = buildBackup(storeOf(c), lib(c));
  return c.json(pack, 200, {
    "content-disposition": `attachment; filename="xushang-${lib(c)}-${Date.now()}.json"`,
  });
});

libraryRoutes.post("/api/restore", async (c) => {
  const body = await c.req.json<{ json?: string }>().catch(() => ({}) as { json?: string });
  if (!body.json) return c.json({ error: "请提供备份 JSON" }, 400);
  const checked = verifyBackup(body.json);
  if (!checked.ok) return c.json({ error: checked.reason }, 400);
  const before = storeOf(c).counts();
  const result = restoreToEmptyOrSwap({ dataRoot: rt(c).dataRoot, library: lib(c), raw: body.json, current: storeOf(c) });
  reopenStore(rt(c), lib(c));
  if (!result.ok) return c.json({ error: result.reason, unchanged: before, after: storeOf(c).counts() }, 400);
  return c.json({ ok: true, before, counts: storeOf(c).counts() });
});
