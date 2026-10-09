import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { testApp } from "../helpers.js";
import { buildHandoff } from "../../src/domain/handoff.js";
import { CARD_TYPES } from "../../src/domain/types.js";
import { digest, verifyBackup } from "../../src/storage/backup.js";
import { LIMITS } from "../../src/shared/limits.js";
import { SCHEMA_VERSION } from "../../src/storage/schema.js";
import type { CardType } from "../../src/domain/types.js";

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

describe("F01-F09 Codex 反例回归", () => {
  const ctxs: Array<ReturnType<typeof testApp>> = [];
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of ctxs) {
      for (const s of c.rt.stores.values()) {
        try {
          s.close();
        } catch {
          /* ignore */
        }
      }
    }
    ctxs.length = 0;
    for (const f of closers) await f();
    closers.length = 0;
  });

  function fresh() {
    const c = testApp();
    ctxs.push(c);
    return c;
  }

  async function importText(c: ReturnType<typeof testApp>, text: string, extra?: { title?: string; externalId?: string }) {
    await c.session();
    const pre = await json(
      await c.req("/api/imports/preview", {
        method: "POST",
        body: JSON.stringify({
          files: [
            {
              name: "a.json",
              text: JSON.stringify({
                schemaVersion: 1,
                conversations: [
                  {
                    title: extra?.title ?? "合成资料",
                    externalId: extra?.externalId,
                    messages: [{ role: "user", text }],
                  },
                ],
              }),
            },
          ],
        }),
      }),
    );
    await c.req("/api/imports/confirm", {
      method: "POST",
      body: JSON.stringify({ previewId: (pre.preview as { id: string }).id }),
    });
    const srcs = (await json(await c.req("/api/sources"))).sources as Array<{
      id: string;
      topic_id: string;
      title: string;
      current_revision_id: string;
    }>;
    const src = extra?.title ? srcs.find((s) => s.title === extra.title) ?? srcs[0] : srcs[0];
    const detail = await json(await c.req(`/api/sources/${src.id}`));
    return { src, messages: detail.messages as Array<{ id: string; text: string; revision_id: string; role: string }> };
  }

  it("F01 删除后新备份不含原文/摘录/修订正文，仅来源索引交接失效", async () => {
    const c = fresh();
    const marker = "DELETE_ORIGINAL_SYNTHETIC_4153";
    const { src, messages } = await importText(c, marker, { title: "待删资料" });
    await c.req("/api/cards", {
      method: "POST",
      body: JSON.stringify({
        topicId: src.topic_id,
        type: "user_decision",
        title: "派生",
        body: "DELETE_DERIVED_SYNTHETIC_4153",
        citations: [{ messageId: messages[0].id, quote: marker }],
      }),
    });
    const del = await c.req(`/api/sources/${src.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await c.req(`/api/sources/${src.id}`)).status).toBe(404);
    const search = await json(await c.req(`/api/search?q=${encodeURIComponent(marker)}`));
    expect(search.total).toBe(0);
    const bak = await json(await c.req("/api/backup"));
    const blob = JSON.stringify((bak as { data: Record<string, unknown> }).data);
    expect(blob).not.toContain(marker);
    expect(blob).not.toContain("DELETE_DERIVED_SYNTHETIC_4153");

    const c2 = fresh();
    const { src: only } = await importText(c2, "普通内容", { title: "DELETED_TITLE_SYNTHETIC_4153" });
    const saved = await json(
      await c2.req("/api/handoffs", {
        method: "POST",
        body: JSON.stringify({ topicId: only.topic_id, goal: "交接", variant: "full", includeCardIds: [] }),
      }),
    );
    await c2.req(`/api/sources/${only.id}`, { method: "DELETE" });
    const row = await json(await c2.req(`/api/handoffs/${(saved.handoff as { id: string }).id}`));
    const handoff = row.handoff as { invalidated: number; body: string };
    expect(handoff.invalidated).toBe(1);
    expect(handoff.body).not.toContain("DELETED_TITLE_SYNTHETIC_4153");
  });

  it("F02 正文含 apiKey/Authorization 的自有备份能恢复，结构外字段拒绝", async () => {
    const c = fresh();
    const bodyText = "今天讨论 Authorization 请求头和 apiKey 字段命名。这只是普通说明，没有任何真实凭据。";
    const { src } = await importText(c, bodyText);
    const secret = "LIVE_CONFIG_KEY_F02_SYNTHETIC_4153";
    await c.req("/api/ai/config", {
      method: "POST",
      body: JSON.stringify({ baseUrl: "http://127.0.0.1:9", model: "m", apiKey: secret }),
    });
    const pack = await json(await c.req("/api/backup"));
    const raw = JSON.stringify(pack);
    expect(raw).toContain("apiKey");
    expect(raw).toContain("Authorization");
    expect(raw).not.toContain(secret);
    const ok = verifyBackup(raw);
    expect(ok.ok).toBe(true);

    const empty = fresh();
    await empty.session();
    expect(((await json(await empty.req("/api/sources"))).sources as unknown[]).length).toBe(0);
    const restored = await empty.req("/api/restore", { method: "POST", body: JSON.stringify({ json: raw }) });
    expect(restored.status).toBe(200);
    const srcs = (await json(await empty.req("/api/sources"))).sources as Array<{ id: string }>;
    expect(srcs.length).toBe(1);
    const detail = await json(await empty.req(`/api/sources/${srcs[0].id}`));
    const texts = (detail.messages as Array<{ text: string }>).map((m) => m.text).join("\n");
    expect(texts).toContain("apiKey");
    expect(texts).toContain("Authorization");
    expect(texts).toContain(bodyText);
    const hits = await json(await empty.req("/api/search?q=apiKey"));
    expect(Number(hits.total)).toBeGreaterThan(0);

    const before = ((await json(await c.req("/api/sources"))).sources as unknown[]).length;
    expect(before).toBeGreaterThan(0);
    const badVer = await c.req("/api/restore", {
      method: "POST",
      body: JSON.stringify({ json: JSON.stringify({ ...pack, schemaVersion: 999 }) }),
    });
    expect(badVer.status).toBe(400);
    const badBody = await json(badVer);
    expect(String(badBody.error)).toMatch(/不兼容的备份版本/);
    expect(((await json(await c.req("/api/sources"))).sources as unknown[]).length).toBe(before);
    expect((await json(await c.req(`/api/sources/${src.id}`))).messages).toBeDefined();

    const data = (pack as { data: Record<string, unknown[]> }).data;
    const tainted = {
      ...data,
      messages: (data.messages as Array<Record<string, unknown>>).map((row, i) =>
        i === 0 ? { ...row, apiKey: "should-not-export" } : row,
      ),
    };
    const smuggledRaw = JSON.stringify({
      ...pack,
      schemaVersion: SCHEMA_VERSION,
      data: tainted,
      manifest: { ...(pack as { manifest: Record<string, unknown> }).manifest, sha256: digest(tainted) },
    });
    const smuggledHttp = await empty.req("/api/restore", { method: "POST", body: JSON.stringify({ json: smuggledRaw }) });
    expect(smuggledHttp.status).toBe(400);
    expect(String((await json(smuggledHttp)).error)).toMatch(/未授权字段/);
    const smuggled = verifyBackup(smuggledRaw);
    expect(smuggled.ok).toBe(false);
    if (!smuggled.ok) expect(smuggled.reason).toMatch(/未授权字段/);
  });

  it("F03 十二种卡片都进交接正文；已解决不混进未解决", () => {
    const cards = CARD_TYPES.map((type, i) => ({
      id: String(i),
      type,
      title: `标题${type}`,
      body: `MARKER_${type}`,
      review_state: "confirmed",
      content_state: "active",
      is_user_note: type === "user_note" ? 1 : 0,
      invalidated: 0,
    }));
    const built = buildHandoff({
      goal: "审计",
      topicLabel: "审计",
      cards: cards as never,
      sources: [],
      variant: "full",
      includePending: false,
    });
    expect(built.included.length).toBe(12);
    expect(built.excluded.length).toBe(0);
    for (const type of CARD_TYPES) {
      expect(built.body).toContain(`MARKER_${type}`);
    }
    const resolved = buildHandoff({
      goal: "审计",
      topicLabel: "审计",
      cards: [{ ...cards[3], type: "open_question" as CardType, content_state: "user_resolved", body: "RESOLVED_Q" }] as never,
      sources: [],
      variant: "full",
      includePending: false,
    });
    const unsolved = resolved.body.split("## 已解决问题")[0];
    expect(unsolved).not.toMatch(/## 未解决问题\s*\n\s*- /);
    expect(resolved.body).toContain("已解决");
    expect(resolved.body).toContain("RESOLVED_Q");
  });

  it("F04 角色更正后已确认用户决定失效待审", async () => {
    const c = fresh();
    const quote = "我建议采用方案甲。";
    const { src, messages } = await importText(c, quote);
    const created = await json(
      await c.req("/api/cards", {
        method: "POST",
        body: JSON.stringify({
          topicId: src.topic_id,
          type: "user_decision",
          title: "用户决定采用方案甲",
          body: "用户决定采用方案甲",
          citations: [{ messageId: messages[0].id, quote }],
        }),
      }),
    );
    const id = (created.card as { id: string }).id;
    expect((created.card as { review_state: string }).review_state).toBe("confirmed");
    const patch = await c.req(`/api/sources/${src.id}`, {
      method: "PATCH",
      body: JSON.stringify({ messages: [{ id: messages[0].id, role: "assistant" }] }),
    });
    expect(patch.status).toBe(200);
    const st = c.rt.stores.get("personal")!;
    const now = st.getCard(id)!;
    expect(st.getMessage(messages[0].id)?.role).toBe("assistant");
    expect(now.review_state).toBe("pending");
    expect(Number(now.invalidated)).toBe(1);
    expect(String(now.invalidated_reason)).toMatch(/更正|重新审核/);

    const bak = await json(await c.req("/api/backup"));
    const dumped = ((bak as { data: { cards: Array<Record<string, unknown>> } }).data.cards).find((row) => row.id === id)!;
    expect(dumped.review_state).toBe("pending");
    expect(Number(dumped.invalidated)).toBe(1);
    expect(String(dumped.invalidated_reason)).toMatch(/说话人已从「user」更正为「assistant」/);

    const topic = await json(await c.req(`/api/topics/${src.topic_id}`));
    const listed = (topic.cards as Array<Record<string, unknown>>).find((row) => row.id === id);
    expect(listed).toBeTruthy();
    expect(listed!.review_state).toBe("pending");
    expect(Number(listed!.invalidated)).toBe(1);
    expect(String(listed!.invalidated_reason)).toMatch(/重新审核/);

    const pending = await json(await c.req("/api/cards?reviewState=pending"));
    expect((pending.cards as Array<{ id: string }>).some((row) => row.id === id)).toBe(true);

    // 2026-10 界面重做：主题页「待核对 / 需重新核对」标签页列出待审与失效卡（needsCheck），不再按 invalidated 过滤掉
    const pageSrc = readFileSync(join(process.cwd(), "src/client/pages/TopicDetailPage.tsx"), "utf8");
    expect(pageSrc).toMatch(/待核对 \/ 需重新核对/);
    expect(pageSrc).toMatch(/Number\(c\.invalidated\) === 1 && c\.review_state !== "rejected"/);
    expect(pageSrc).not.toMatch(/filter\(\(c\) => !c\.invalidated\)/);
  });

  it("F04 未引用被更正消息的旧卡保持原状；未知消息 PATCH 不得假成功", async () => {
    const c = fresh();
    await c.session();
    const pre = await json(
      await c.req("/api/imports/preview", {
        method: "POST",
        body: JSON.stringify({
          files: [
            {
              name: "a.json",
              text: JSON.stringify({
                schemaVersion: 1,
                conversations: [
                  {
                    title: "F04双消息",
                    messages: [
                      { role: "user", text: "旧卡依赖这句话。" },
                      { role: "user", text: "新卡依赖这句话。" },
                    ],
                  },
                ],
              }),
            },
          ],
        }),
      }),
    );
    await c.req("/api/imports/confirm", {
      method: "POST",
      body: JSON.stringify({ previewId: (pre.preview as { id: string }).id }),
    });
    const srcs = (await json(await c.req("/api/sources"))).sources as Array<{
      id: string;
      topic_id: string;
    }>;
    const src = srcs[0];
    const detail = await json(await c.req(`/api/sources/${src.id}`));
    const messages = detail.messages as Array<{ id: string; text: string }>;
    const leftoverQuote = "旧卡依赖这句话。";
    const targetQuote = "新卡依赖这句话。";
    const leftoverMsg = messages.find((m) => m.text === leftoverQuote)!;
    const targetMsg = messages.find((m) => m.text === targetQuote)!;
    const leftover = await json(
      await c.req("/api/cards", {
        method: "POST",
        body: JSON.stringify({
          topicId: src.topic_id,
          type: "user_decision",
          title: "旧卡71c723ee形",
          body: leftoverQuote,
          citations: [{ messageId: leftoverMsg.id, quote: leftoverQuote }],
        }),
      }),
    );
    const target = await json(
      await c.req("/api/cards", {
        method: "POST",
        body: JSON.stringify({
          topicId: src.topic_id,
          type: "user_decision",
          title: "对照62f11bff形",
          body: targetQuote,
          citations: [{ messageId: targetMsg.id, quote: targetQuote }],
        }),
      }),
    );
    const leftoverId = (leftover.card as { id: string }).id;
    const targetId = (target.card as { id: string }).id;
    const missing = await c.req(`/api/sources/${src.id}`, {
      method: "PATCH",
      body: JSON.stringify({ messages: [{ id: "missing-message-id", role: "assistant" }] }),
    });
    expect(missing.status).toBe(400);
    expect(String((await json(missing)).error)).toMatch(/不存在|没有写回/);
    const st = c.rt.stores.get("personal")!;
    expect(st.getCard(leftoverId)!.review_state).toBe("confirmed");
    expect(Number(st.getCard(leftoverId)!.invalidated)).toBe(0);

    const patch = await c.req(`/api/sources/${src.id}`, {
      method: "PATCH",
      body: JSON.stringify({ messages: [{ id: targetMsg.id, role: "assistant" }] }),
    });
    expect(patch.status).toBe(200);
    const bak = await json(await c.req("/api/backup"));
    const rows = (bak as { data: { cards: Array<Record<string, unknown>> } }).data.cards;
    const leftoverDump = rows.find((row) => row.id === leftoverId)!;
    const targetDump = rows.find((row) => row.id === targetId)!;
    expect(leftoverDump.review_state).toBe("confirmed");
    expect(Number(leftoverDump.invalidated)).toBe(0);
    expect(String(leftoverDump.updated_at)).toBe(String(leftoverDump.created_at));
    expect(targetDump.review_state).toBe("pending");
    expect(Number(targetDump.invalidated)).toBe(1);
    expect(String(targetDump.invalidated_reason)).toMatch(/更正|重新审核/);
  });

  it("F05 旧修订引用不得当作当前已确认事实，且能打开旧文", async () => {
    const c = fresh();
    const first = await importText(c, "旧结论甲", { title: "修订主题", externalId: "SYNTHETIC_REVISION" });
    await importText(c, "新结论乙", { title: "修订主题", externalId: "SYNTHETIC_REVISION" });
    const result = await json(
      await c.req("/api/cards", {
        method: "POST",
        body: JSON.stringify({
          topicId: first.src.topic_id,
          type: "user_decision",
          title: "旧引文新建卡片",
          body: "仍然选甲",
          citations: [{ messageId: first.messages[0].id, quote: "旧结论甲" }],
        }),
      }),
    );
    const card = result.card as {
      review_state: string;
      invalidated: number;
      citations: Array<{ revision_id: string }>;
      invalidated_reason: string | null;
    };
    const st = c.rt.stores.get("personal")!;
    const current = String(st.getSource(first.src.id)?.current_revision_id);
    expect(result.error).toBeUndefined();
    expect(card.review_state).toBe("pending");
    expect(Number(card.invalidated)).toBe(0);
    expect(card.citations[0].revision_id).not.toBe(current);
    expect(String(card.invalidated_reason)).toMatch(/历史版本/);
    const oldView = await json(
      await c.req(`/api/sources/${first.src.id}?revision=${card.citations[0].revision_id}`),
    );
    expect(oldView.isHistoricalRevision).toBe(true);
    expect((oldView.messages as Array<{ text: string }>)[0].text).toBe("旧结论甲");
    const curView = await json(await c.req(`/api/sources/${first.src.id}`));
    expect((curView.messages as Array<{ text: string }>)[0].text).toBe("新结论乙");
  });

  it("F06 insufficient 不能豁免无引用要点，混合要点也不入库", async () => {
    const c = fresh();
    const { src } = await importText(c, "只讨论了字体大小。");
    let last = "";
    const mock = await mockServer((raw, res) => {
      last = raw;
      const payload = JSON.parse(raw) as { messages?: Array<{ content?: string }> };
      const user = String(payload.messages?.[1]?.content ?? "");
      const mixed = user.includes("混合");
      const body = mixed
        ? {
            points: [
              { text: "字体只讨论过大小", support: [] },
              { text: "完全没有证据支持的决定：用户已经批准公开所有聊天。", support: [] },
            ],
            insufficient: true,
            conflicts: [],
          }
        : {
            points: [{ text: "完全没有证据支持的决定：用户已经批准公开所有聊天。", support: [] }],
            insufficient: true,
            conflicts: [],
          };
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }),
      );
    });
    closers.push(mock.close);
    await c.req("/api/ai/config", {
      method: "POST",
      body: JSON.stringify({ baseUrl: mock.url, model: "m", apiKey: "k" }),
    });
    const r = await c.req("/api/ai/answer", {
      method: "POST",
      body: JSON.stringify({ topicId: src.topic_id, question: "决定是什么？", confirmSend: true }),
    });
    expect(r.status).toBe(502);
    const body = await json(r);
    expect(String(body.error)).toMatch(/没有来源|未保存/);
    const st = c.rt.stores.get("personal")!;
    expect((st.db.prepare("SELECT count(*) n FROM answers").get() as { n: number }).n).toBe(0);

    const mixed = await c.req("/api/ai/answer", {
      method: "POST",
      body: JSON.stringify({ topicId: src.topic_id, question: "混合要点", confirmSend: true }),
    });
    expect(mixed.status).toBe(502);
    expect((st.db.prepare("SELECT count(*) n FROM answers").get() as { n: number }).n).toBe(0);
    expect(last).toContain("max_tokens");
  });

  it("F07 全部已导入资料预览与发送范围一致", async () => {
    const c = fresh();
    await importText(c, "ALL_SOURCE_MARKER_4153");
    const requests: string[] = [];
    const mock = await mockServer((raw, res) => {
      requests.push(raw);
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ points: [], insufficient: true, conflicts: [] }) } }],
        }),
      );
    });
    closers.push(mock.close);
    await c.req("/api/ai/config", {
      method: "POST",
      body: JSON.stringify({ baseUrl: mock.url, model: "m", apiKey: "k" }),
    });
    const pre = await json(await c.req("/api/ai/preview-scope", { method: "POST", body: JSON.stringify({}) }));
    expect(pre.scopeMode).toBe("all");
    expect(Number(pre.messageCount)).toBeGreaterThan(0);
    const ans = await c.req("/api/ai/answer", {
      method: "POST",
      body: JSON.stringify({ question: "我刚才决定什么？", topicId: "", confirmSend: true }),
    });
    expect(ans.status).toBe(200);
    expect(requests.length).toBe(1);
    const payload = JSON.parse(requests[0]) as { messages: Array<{ content: string }> };
    const sent = JSON.parse(payload.messages[1].content) as { messages: Array<{ text: string }> };
    expect(sent.messages.length).toBeGreaterThan(0);
    expect(sent.messages.some((m) => m.text.includes("ALL_SOURCE_MARKER_4153"))).toBe(true);
  });

  it("F08 回答遵守输入上限，预览与发送一致，请求带输出预算", async () => {
    const c = fresh();
    const { src } = await importText(c, `可查找的决定。${"长".repeat(90_000)}`);
    const requests: string[] = [];
    const mock = await mockServer((raw, res) => {
      requests.push(raw);
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ points: [], insufficient: true, conflicts: [] }) } }],
        }),
      );
    });
    closers.push(mock.close);
    await c.req("/api/ai/config", {
      method: "POST",
      body: JSON.stringify({ baseUrl: mock.url, model: "m", apiKey: "k" }),
    });
    const pre = await json(
      await c.req("/api/ai/preview-scope", {
        method: "POST",
        body: JSON.stringify({ topicId: src.topic_id, question: "决定是什么", kind: "answer" }),
      }),
    );
    expect(Number(pre.segments)).toBe(0);
    expect(Number(pre.oversizedMessages)).toBe(1);
    expect(String(pre.note)).not.toMatch(/分成 0 段发送/);
    const result = await c.req("/api/ai/answer", {
      method: "POST",
      body: JSON.stringify({ question: "决定是什么", topicId: src.topic_id, confirmSend: true }),
    });
    expect(result.status).toBe(400);
    expect(requests.length).toBe(0);
    expect(LIMITS.modelMaxInputChars).toBe(80_000);
    expect(LIMITS.modelMaxOutputTokens).toBeGreaterThan(0);
  });

  it("F08 提炼与润色过长不发送，预览与发送一致", async () => {
    const c = fresh();
    const { src } = await importText(c, `可查找的决定。${"长".repeat(90_000)}`);
    const requests: string[] = [];
    const mock = await mockServer((raw, res) => {
      requests.push(raw);
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ claims: [], body: "ok" }) } }],
        }),
      );
    });
    closers.push(mock.close);
    await c.req("/api/ai/config", {
      method: "POST",
      body: JSON.stringify({ baseUrl: mock.url, model: "m", apiKey: "k" }),
    });
    const extractPre = await json(
      await c.req("/api/ai/preview-scope", {
        method: "POST",
        body: JSON.stringify({ topicId: src.topic_id, kind: "extract" }),
      }),
    );
    expect(Number(extractPre.segments)).toBe(0);
    expect(Number(extractPre.oversizedMessages)).toBe(1);
    const extract = await c.req("/api/ai/extract", {
      method: "POST",
      body: JSON.stringify({ topicId: src.topic_id, confirmSend: true }),
    });
    expect(extract.status).toBe(400);
    expect(requests.length).toBe(0);

    const short = fresh();
    const { src: shortSrc } = await importText(short, "短交接原文。");
    const polishReqs: string[] = [];
    const polishMock = await mockServer((raw, res) => {
      polishReqs.push(raw);
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ body: "润色" }) } }] }),
      );
    });
    closers.push(polishMock.close);
    await short.req("/api/ai/config", {
      method: "POST",
      body: JSON.stringify({ baseUrl: polishMock.url, model: "m", apiKey: "k" }),
    });
    const hugeHandoff = `超长交接。${"长".repeat(90_000)}`;
    const polishPre = await json(
      await short.req("/api/ai/preview-scope", {
        method: "POST",
        body: JSON.stringify({ topicId: shortSrc.topic_id, kind: "polish", handoffBody: hugeHandoff }),
      }),
    );
    expect(Number(polishPre.segments)).toBe(0);
    expect(Number(polishPre.oversizedMessages)).toBeGreaterThan(0);
    expect(String(polishPre.note)).toMatch(/未截断、未发送/);
    const polish = await short.req("/api/ai/polish", {
      method: "POST",
      body: JSON.stringify({ topicId: shortSrc.topic_id, handoffBody: hugeHandoff, confirmSend: true }),
    });
    expect(polish.status).toBe(400);
    expect(polishReqs.length).toBe(0);
  });

  it("F08 回答先本地检索再组装；取消不写入；输出上限与读取上限分开", async () => {
    const c = fresh();
    const hit = "HIT_F08_LOCAL_RETRIEVE_4153";
    const noise = "NOISE_F08_UNRELATED_4153";
    await importText(c, hit, { title: "命中资料" });
    await importText(c, noise, { title: "无关资料" });
    const sent: string[] = [];
    const mock = await mockServer((raw, res) => {
      sent.push(raw);
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ points: [], insufficient: true, conflicts: [] }) } }],
        }),
      );
    });
    closers.push(mock.close);
    await c.req("/api/ai/config", {
      method: "POST",
      body: JSON.stringify({ baseUrl: mock.url, model: "m", apiKey: "k" }),
    });
    const pre = await json(
      await c.req("/api/ai/preview-scope", {
        method: "POST",
        body: JSON.stringify({ question: hit, kind: "answer" }),
      }),
    );
    expect(pre.searched).toBe(true);
    expect(Number(pre.hitCount)).toBeGreaterThan(0);
    const ans = await c.req("/api/ai/answer", {
      method: "POST",
      body: JSON.stringify({ question: hit, confirmSend: true }),
    });
    expect(ans.status).toBe(200);
    expect(sent.length).toBe(1);
    const payload = JSON.parse(sent[0]) as { max_tokens?: number; messages: Array<{ content: string }> };
    expect(payload.max_tokens).toBe(LIMITS.modelMaxOutputTokens);
    const assembled = JSON.parse(payload.messages[1].content) as { messages: Array<{ text: string }> };
    expect(assembled.messages.some((m) => m.text.includes(hit))).toBe(true);
    expect(assembled.messages.some((m) => m.text.includes(noise))).toBe(false);

    const readC = fresh();
    await importText(readC, "读取上限样本。");
    let genSawMax = false;
    const huge = "H".repeat(LIMITS.modelMaxOutputChars + 50);
    const readMock = await mockServer((raw, res) => {
      const body = JSON.parse(raw) as { max_tokens?: number };
      genSawMax = body.max_tokens === LIMITS.modelMaxOutputTokens;
      res.writeHead(200, { "content-type": "application/json" }).end(huge);
    });
    closers.push(readMock.close);
    await readC.req("/api/ai/config", {
      method: "POST",
      body: JSON.stringify({ baseUrl: readMock.url, model: "m", apiKey: "k" }),
    });
    const overRead = await readC.req("/api/ai/answer", {
      method: "POST",
      body: JSON.stringify({ question: "读取上限样本", confirmSend: true }),
    });
    expect(genSawMax).toBe(true);
    expect(overRead.status).toBe(502);
    expect(String((await json(overRead)).error)).toMatch(/过大/);
    const answers = readC.rt.stores.get("personal")!.db.prepare("SELECT count(*) n FROM answers").get() as { n: number };
    expect(answers.n).toBe(0);

    const cancelC = fresh();
    await importText(cancelC, "取消样本决定。");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancelReqs: string[] = [];
    const cancelMock = await mockServer((raw, res) => {
      cancelReqs.push(raw);
      void gate.then(() => {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ points: [{ text: "不该写入", support: [] }], insufficient: false, conflicts: [] }) } }],
          }),
        );
      });
    });
    closers.push(cancelMock.close);
    await cancelC.req("/api/ai/config", {
      method: "POST",
      body: JSON.stringify({ baseUrl: cancelMock.url, model: "m", apiKey: "k" }),
    });
    const pending = cancelC.req("/api/ai/answer", {
      method: "POST",
      body: JSON.stringify({ question: "取消样本决定", confirmSend: true }),
    });
    for (let i = 0; i < 50 && cancelReqs.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const job = cancelC.rt.stores.get("personal")!.db.prepare("SELECT id FROM analysis_jobs WHERE status='running'").get() as
      | { id: string }
      | undefined;
    expect(job?.id).toBeTruthy();
    const cancelled = await cancelC.req(`/api/ai/jobs/${job!.id}/cancel`, { method: "POST" });
    expect(cancelled.status).toBe(200);
    release();
    const cancelRes = await pending;
    expect([400, 409, 502]).toContain(cancelRes.status);
    const saved = cancelC.rt.stores.get("personal")!.db.prepare("SELECT count(*) n FROM answers WHERE invalidated=0").get() as {
      n: number;
    };
    expect(saved.n).toBe(0);
  });

  function runStop(pidFile: string) {
    try {
      const output = execFileSync("sh", ["scripts/stop.sh"], {
        cwd: process.cwd(),
        env: { ...process.env, XUSHANG_PID_FILE: pidFile },
        encoding: "utf8",
      });
      return { status: 0, output };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { status: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  }

  function stillAlive(pid: number) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it("F09 stop.sh 不误杀无关 tsx、另一副本；过期 PID 不杀；无法确认则不结束", () => {
    const dir = mkdtempSync(join(tmpdir(), "xushang-f09-"));
    const pidFile = join(dir, "xushang.pid");
    const index = join(process.cwd(), "src/server/index.ts");

    const unrelated = spawn(process.execPath, ["-e", "/* unrelated-tsx-synthetic-audit */ setInterval(()=>{}, 1000)"], {
      stdio: "ignore",
      detached: true,
    });
    if (!unrelated.pid) throw new Error("无法启动可丢弃无关进程");
    writeFileSync(pidFile, String(unrelated.pid), "utf8");
    const unrelatedStop = runStop(pidFile);
    const unrelatedAlive = stillAlive(unrelated.pid);
    try {
      process.kill(unrelated.pid, "SIGTERM");
    } catch {
      /* ignore */
    }
    expect(unrelatedAlive).toBe(true);
    expect(unrelatedStop.status).not.toBe(0);
    expect(unrelatedStop.output).toMatch(/没有结束/);

    const otherPidFile = join(dir, "other-copy.pid");
    const other = spawn(process.execPath, ["-e", `/* ${index} */ setInterval(()=>{}, 1000)`], {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, XUSHANG_PID_FILE: otherPidFile },
    });
    if (!other.pid) throw new Error("无法启动可丢弃另一副本");
    writeFileSync(pidFile, String(other.pid), "utf8");
    const otherStop = runStop(pidFile);
    const otherAlive = stillAlive(other.pid);
    try {
      process.kill(other.pid, "SIGTERM");
    } catch {
      /* ignore */
    }
    expect(otherAlive).toBe(true);
    expect(otherStop.status).not.toBe(0);
    expect(otherStop.output).toMatch(/没有结束|另一副本/);

    writeFileSync(pidFile, "9999999", "utf8");
    const stale = runStop(pidFile);
    expect(stale.status).toBe(0);
    expect(stale.output).toMatch(/已经不在运行/);
  });
});
