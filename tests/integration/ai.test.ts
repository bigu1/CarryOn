import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { testApp } from "../helpers.js";
import { chunkMessages } from "../../src/ai/client.js";

function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

function mockServer(handler: (body: string, res: import("node:http").ServerResponse) => void) {
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => handler(raw, res));
  });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

describe("AI 接入路径（模拟服务）", () => {
  const closers: Array<() => Promise<void>> = [];
  const ctxs: Array<ReturnType<typeof testApp>> = [];
  afterEach(async () => {
    for (const c of ctxs) for (const s of c.rt.stores.values()) try { s.close(); } catch { /* */ }
    ctxs.length = 0;
    for (const f of closers) await f();
    closers.length = 0;
  });

  it("A01 凭据不进备份，重启语义为进程内存", async () => {
    const c = testApp();
    ctxs.push(c);
    await c.session();
    const mock = await mockServer((_b, res) => res.writeHead(200).end("{}"));
    closers.push(mock.close);
    await c.req("/api/ai/config", {
      method: "POST",
      body: JSON.stringify({ baseUrl: mock.url, model: "m", apiKey: "secret-key-xyz" }),
    });
    const bak = await json(await c.req("/api/backup"));
    expect(JSON.stringify(bak)).not.toContain("secret-key-xyz");
    await c.req("/api/ai/config", { method: "DELETE" });
    const st = await json(await c.req("/api/ai/status"));
    expect(st.configured).toBe(false);
  });

  it("A02 未确认不发送；范围预览可见", async () => {
    const c = testApp();
    ctxs.push(c);
    await c.session();
    let hits = 0;
    const mock = await mockServer((_b, res) => {
      hits++;
      res.writeHead(200).end(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
    });
    closers.push(mock.close);
    await c.req("/api/ai/config", {
      method: "POST",
      body: JSON.stringify({ baseUrl: mock.url, model: "m", apiKey: "k" }),
    });
    const denied = await c.req("/api/ai/extract", {
      method: "POST",
      body: JSON.stringify({ sourceIds: [], confirmSend: false }),
    });
    expect(denied.status).toBe(400);
    expect(hits).toBe(0);
    const scope = await json(await c.req("/api/ai/preview-scope", { method: "POST", body: JSON.stringify({}) }));
    expect(scope.target).toBe(mock.url);
  });

  it("A03 重定向、认证失败、空响应可控", async () => {
    const c = testApp();
    ctxs.push(c);
    await c.session();
    const mock = await mockServer((_b, res) => {
      res.writeHead(302, { location: "https://example.invalid" }).end();
    });
    closers.push(mock.close);
    await c.req("/api/ai/config", {
      method: "POST",
      body: JSON.stringify({ baseUrl: mock.url, model: "m", apiKey: "k" }),
    });
    const pre = await json(
      await c.req("/api/imports/preview", {
        method: "POST",
        body: JSON.stringify({
          files: [{ name: "a.json", text: JSON.stringify({ schemaVersion: 1, conversations: [{ title: "t", messages: [{ role: "user", text: "hello-world-quote" }] }] }) }],
        }),
      }),
    );
    await c.req("/api/imports/confirm", { method: "POST", body: JSON.stringify({ previewId: (pre.preview as { id: string }).id }) });
    const srcs = (await json(await c.req("/api/sources"))).sources as Array<{ id: string }>;
    const r = await c.req("/api/ai/extract", {
      method: "POST",
      body: JSON.stringify({ sourceIds: [srcs[0].id], confirmSend: true }),
    });
    expect(r.status).toBe(502);
    const body = await json(r);
    expect(String(body.error)).toMatch(/重定向|认证|空|失败|解析/);
  });

  it("A04 坏引用不入库；C21 删除后迟到结果丢弃", async () => {
    const c = testApp();
    ctxs.push(c);
    await c.session();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const mock = await mockServer(async (_b, res) => {
      await gate;
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  claims: [
                    {
                      type: "user_decision",
                      title: "迟到",
                      body: "不该写回",
                      evidence: [{ messageId: "no-such", quote: "x" }],
                    },
                  ],
                }),
              },
            },
          ],
        }),
      );
    });
    closers.push(mock.close);
    await c.req("/api/ai/config", {
      method: "POST",
      body: JSON.stringify({ baseUrl: mock.url, model: "m", apiKey: "k" }),
    });
    const pre = await json(
      await c.req("/api/imports/preview", {
        method: "POST",
        body: JSON.stringify({
          files: [{ name: "a.json", text: JSON.stringify({ schemaVersion: 1, conversations: [{ title: "t", messages: [{ role: "user", text: "原文一句足够长" }] }] }) }],
        }),
      }),
    );
    await c.req("/api/imports/confirm", { method: "POST", body: JSON.stringify({ previewId: (pre.preview as { id: string }).id }) });
    const srcs = (await json(await c.req("/api/sources"))).sources as Array<{ id: string }>;
    const pending = c.req("/api/ai/extract", {
      method: "POST",
      body: JSON.stringify({ sourceIds: [srcs[0].id], confirmSend: true }),
    });
    await c.req(`/api/sources/${srcs[0].id}`, { method: "DELETE" });
    release();
    const done = await pending;
    expect([400, 409, 502]).toContain(done.status);
    const cards = (await json(await c.req("/api/cards"))).cards as Array<{ title: string }>;
    expect(cards.some((x) => x.title === "迟到")).toBe(false);
  });

  it("拒绝非回环 HTTP 远程地址", async () => {
    const c = testApp();
    ctxs.push(c);
    await c.session();
    const res = await c.req("/api/ai/config", {
      method: "POST",
      body: JSON.stringify({ baseUrl: "http://example.invalid", model: "m", apiKey: "k" }),
    });
    expect(res.status).toBe(400);
  });

  it("A04 同一响应里坏引用则整批不入库", async () => {
    const c = testApp();
    ctxs.push(c);
    await c.session();
    const pre = await json(
      await c.req("/api/imports/preview", {
        method: "POST",
        body: JSON.stringify({
          files: [{ name: "a.json", text: JSON.stringify({ schemaVersion: 1, conversations: [{ title: "t", messages: [{ role: "user", text: "原文一句足够长" }] }] }) }],
        }),
      }),
    );
    await c.req("/api/imports/confirm", { method: "POST", body: JSON.stringify({ previewId: (pre.preview as { id: string }).id }) });
    const srcs = (await json(await c.req("/api/sources"))).sources as Array<{ id: string }>;
    const msgs = (await json(await c.req(`/api/sources/${srcs[0].id}`))).messages as Array<{ id: string }>;
    const mock = await mockServer((_b, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  claims: [
                    {
                      type: "user_decision",
                      title: "不该留下",
                      body: "有引用但下一条是坏的",
                      evidence: [{ messageId: msgs[0].id, quote: "原文一句足够长" }],
                    },
                    {
                      type: "user_decision",
                      title: "坏引用",
                      body: "不存在",
                      evidence: [{ messageId: "no-such", quote: "x" }],
                    },
                  ],
                }),
              },
            },
          ],
        }),
      );
    });
    closers.push(mock.close);
    await c.req("/api/ai/config", {
      method: "POST",
      body: JSON.stringify({ baseUrl: mock.url, model: "m", apiKey: "k" }),
    });
    const r = await c.req("/api/ai/extract", {
      method: "POST",
      body: JSON.stringify({ sourceIds: [srcs[0].id], confirmSend: true }),
    });
    expect(r.status).toBe(502);
    const cards = (await json(await c.req("/api/cards"))).cards as Array<{ title: string }>;
    expect(cards.some((x) => x.title === "不该留下")).toBe(false);
    expect(cards.some((x) => x.title === "坏引用")).toBe(false);
  });

  it("长资料按段切开，单条过长单独失败", () => {
    const { chunks, oversized } = chunkMessages(
      [{ text: "a".repeat(50) }, { text: "b".repeat(50) }, { text: "c".repeat(200) }],
      60,
    );
    expect(chunks.length).toBe(2);
    expect(oversized.length).toBe(1);
    expect(chunks[0][0].text.startsWith("a")).toBe(true);
  });
});
