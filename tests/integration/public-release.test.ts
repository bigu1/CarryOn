import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { testApp } from "../helpers.js";
import { assertEndpoint, chatCompletions } from "../../src/ai/client.js";
import { digest, verifyBackup } from "../../src/storage/backup.js";
import { LIMITS } from "../../src/shared/limits.js";

describe("公开发布的数据与模型边界", () => {
  const contexts: ReturnType<typeof testApp>[] = [];
  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(async () => {
    for (const c of contexts.splice(0)) for (const st of c.rt.stores.values()) try { st.close(); } catch { /* closed */ }
    for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
  });
  const fresh = () => { const c = testApp(); contexts.push(c); return c; };
  async function post(c: ReturnType<typeof testApp>, path: string, body: unknown) {
    return c.req(path, { method: "POST", body: JSON.stringify(body) });
  }
  async function source(c: ReturnType<typeof testApp>, text = "用户：选择本机版。", title = "合成甲") {
    await c.session();
    const pre = await (await post(c, "/api/imports/preview", { paste: text, pasteTitle: title, defaultTopic: "合成主题" })).json();
    const result = await (await post(c, "/api/imports/confirm", { previewId: pre.preview.id })).json();
    const detail = await (await c.req(`/api/sources/${result.results[0].sourceId}`)).json();
    return detail;
  }
  async function model(c: ReturnType<typeof testApp>, handler: (raw: string, res: ServerResponse) => void) {
    const s = createServer((req, res) => { let raw = ""; req.on("data", (v) => raw += v); req.on("end", () => handler(raw, res)); });
    servers.push(s);
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    await post(c, "/api/ai/config", { baseUrl: url, model: "synthetic", apiKey: "synthetic-test-only" });
    return url;
  }
  function reply(res: ServerResponse, value: unknown) {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
  }
  async function card(c: ReturnType<typeof testApp>, d: any, title: string) {
    return (await (await post(c, "/api/cards", { topicId: d.source.topic_id, type: "user_decision", title, body: title,
      citations: [{ messageId: d.messages[0].id, quote: d.messages[0].text }] })).json()).card;
  }

  it("空选、失效选择不扩大到全库", async () => {
    const c = fresh(); await source(c);
    for (const sourceIds of [[], ["missing-source"]]) {
      const p = await (await post(c, "/api/ai/preview-scope", { kind: "extract", sourceIds })).json();
      expect(p.scopeMode).toBe("explicit"); expect(p.sendMessageCount).toBe(0); expect(p.sources).toEqual([]);
    }
  });
  it("选一份资料时不夹带同主题其他卡片", async () => {
    const c = fresh(); const a = await source(c); const b = await source(c, "用户：另一个私密选择。", "合成乙");
    await card(c, a, "允许发送甲"); await card(c, b, "不得发送乙");
    const p = await (await post(c, "/api/ai/preview-scope", { kind: "answer", sourceIds: [a.source.id], topicId: a.source.topic_id, question: "选择" })).json();
    expect(p.sendCardCount).toBe(1); expect(p.sources.map((s: any) => s.id)).toEqual([a.source.id]);
    let sent = "";
    await model(c, (raw, res) => { sent = raw; reply(res, { points: [], insufficient: true, missing: "资料不足" }); });
    await post(c, "/api/ai/answer", { sourceIds: [a.source.id], topicId: a.source.topic_id, question: "选择", confirmSend: true });
    expect(sent).toContain("允许发送甲"); expect(sent).not.toContain("不得发送乙"); expect(sent).not.toContain("另一个私密选择");
  });
  it("导入预览不能跨个人库和演示库确认", async () => {
    const c = fresh(); await c.session();
    const p = await (await post(c, "/api/imports/preview", { paste: "用户：个人资料。" })).json();
    await post(c, "/api/library", { library: "demo" });
    expect((await post(c, "/api/imports/confirm", { previewId: p.preview.id })).status).toBe(409);
    expect((await (await c.req("/api/home")).json()).counts.sources).toBe(0);
  });
  it("问题改变后旧预览不能发送，实际模型未收到请求", async () => {
    const c = fresh(); await source(c); let calls = 0;
    await model(c, (_, res) => { calls++; reply(res, { points: [], insufficient: true }); });
    const p = await (await post(c, "/api/ai/preview-scope", { kind: "answer", question: "选择甲" })).json();
    const r = await post(c, "/api/ai/answer", { question: "选择乙", previewToken: p.previewToken, confirmSend: true });
    expect(r.status).toBe(409); expect(calls).toBe(0);
  });
  it.each(["role", "delete"])("%s 后迟到的提炼响应不能写回", async (change) => {
    const c = fresh(); const d = await source(c);
    let release!: () => void; let arrived!: () => void;
    const ready = new Promise<void>((r) => arrived = r);
    await model(c, (_, res) => { release = () => reply(res, { claims: [{ type: "user_decision", title: "迟到决定", body: "选择本机版", evidence: [{ messageId: d.messages[0].id, quote: "选择本机版" }] }] }); arrived(); });
    const pending = post(c, "/api/ai/extract", { sourceIds: [d.source.id], confirmSend: true });
    await ready;
    await c.req(`/api/sources/${d.source.id}`, { method: change === "role" ? "PATCH" : "DELETE",
      body: change === "role" ? JSON.stringify({ messages: [{ id: d.messages[0].id, role: "assistant" }] }) : undefined });
    release(); expect((await pending).status).toBe(change === "delete" ? 400 : 409);
    expect((await (await c.req("/api/cards")).json()).cards).toEqual([]);
    expect(JSON.stringify(await (await c.req("/api/backup")).json())).not.toContain("迟到决定");
  });
  it("模型不能把未人工核对的原文标成已确认决定", async () => {
    const c = fresh(); const d = await source(c);
    await model(c, (_, res) => reply(res, { points: [{ kind: "decision", text: "选择本机版", support: [{ messageId: d.messages[0].id, quote: "选择本机版" }] }], insufficient: false }));
    const r = await (await post(c, "/api/ai/answer", { topicId: d.source.topic_id, question: "本机版", confirmSend: true })).json();
    expect(JSON.parse(r.answer.points_json).points[0].kind).toBe("other");
  });
  it("只有 AI 原话不能建立用户决定，仍可建 AI 建议", async () => {
    const c = fresh(); const d = await source(c, "助手：建议使用本机版。");
    expect(await card(c, d, "错误采纳")).toBeUndefined();
    const r = await post(c, "/api/cards", { topicId: d.source.topic_id, type: "ai_suggestion", title: "建议", body: "建议本机版", citations: [{ messageId: d.messages[0].id, quote: "建议使用本机版" }] });
    expect(r.status).toBe(200);
  });
  it("已确认卡片仅保存修改也不能清空事实正文", async () => {
    const c = fresh(); const d = await source(c); const k = await card(c, d, "决定");
    const r = await c.req(`/api/cards/${k.id}`, { method: "PATCH", body: JSON.stringify({ body: "" }) });
    expect(r.status).toBe(400); expect((await (await c.req(`/api/cards/${k.id}`)).json()).card.body).toBe("决定");
  });
  it("损坏备份的外键通过哈希也不能替换原库", async () => {
    const c = fresh(); await source(c);
    const pack = await (await c.req("/api/backup")).json();
    pack.data.messages[0].source_id = "does-not-exist"; pack.manifest.sha256 = digest(pack.data);
    const r = await post(c, "/api/restore", { json: JSON.stringify(pack) });
    expect(r.status).toBe(400); expect((await (await c.req("/api/home")).json()).counts.sources).toBe(1);
    expect((await (await c.req("/api/search?q=本机版")).json()).total).toBe(1);
  });
  it("缺表备份和没有 data 的包可控拒绝", async () => {
    const c = fresh(); await source(c);
    const pack = await (await c.req("/api/backup")).json(); delete pack.data.messages; pack.manifest.sha256 = digest(pack.data);
    expect(verifyBackup(JSON.stringify(pack)).ok).toBe(false);
    expect(verifyBackup(JSON.stringify({ schemaVersion: 1, kind: "xushang-backup", manifest: { sha256: "bad" } })).ok).toBe(false);
  });
  it("endpoint 保留代理路径并拒绝 URL 中的凭据", async () => {
    const c = fresh(); await c.session(); let actual = "";
    const url = await model(c, (raw, res) => { actual = raw; reply(res, { points: [], insufficient: true }); });
    const s = servers.at(-1)!; let path = ""; s.on("request", (req) => path = req.url!);
    await chatCompletions({ baseUrl: url + "/proxy/v1", model: "m", apiKey: "synthetic" }, [{ role: "user", content: "test" }], {});
    expect(path).toBe("/proxy/v1/chat/completions"); expect(actual).toContain("test");
    expect(assertEndpoint("https://example.invalid/?apiKey=synthetic").ok).toBe(false);
    expect(assertEndpoint("https://name:synthetic@example.invalid").ok).toBe(false);
  });
  it("输入含结构信息超限时不发送", async () => {
    await expect(chatCompletions({ baseUrl: "http://127.0.0.1:1", model: "m", apiKey: "synthetic" },
      [{ role: "user", content: "甲".repeat(LIMITS.modelMaxInputChars + 1) }], {})).rejects.toThrow(/超过发送上限/);
  });
  it("错误类型的导入及范围参数得到 400", async () => {
    const c = fresh(); await c.session();
    expect((await post(c, "/api/imports/preview", { paste: 123 })).status).toBe(400);
    expect((await post(c, "/api/ai/preview-scope", { sourceIds: "all" })).status).toBe(400);
  });
  it("删除后旧交接预览不能再保存到应用或备份", async () => {
    const c = fresh(); const d = await source(c); await card(c, d, "只属于旧资料的概括");
    const request = { topicId: d.source.topic_id, goal: "继续", variant: "full" };
    const p = await (await post(c, "/api/handoffs/preview", request)).json();
    await c.req(`/api/sources/${d.source.id}`, { method: "DELETE" });
    const r = await post(c, "/api/handoffs", { ...request, bodyText: p.body, previewToken: p.previewToken });
    expect(r.status).toBe(409);
    expect(JSON.stringify(await (await c.req("/api/backup")).json())).not.toContain("只属于旧资料的概括");
  });
});
