import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testApp } from "../helpers.js";
import { parseJsonV1, documentToPreviews } from "../../src/importers/json.js";
import { parseUtf8Text } from "../../src/importers/text.js";
import { locateQuote } from "../../src/domain/citations.js";
import { contentHash } from "../../src/shared/hash.js";
import { Store } from "../../src/storage/db.js";

function dumpLibrary(st: Store) {
  const rows = (sql: string) => st.db.prepare(sql).all() as Array<Record<string, unknown>>;
  return {
    sources: (st.listSources() as Array<Record<string, unknown>>).map((s) => ({
      id: String(s.id),
      title: String(s.title),
      hash: String(s.content_hash),
    })),
    cards: st.listCards({ includeInvalid: true }).map((c) => ({
      id: String(c.id),
      title: String(c.title),
      body: String(c.body),
      content_state: String(c.content_state),
      review_state: String(c.review_state),
    })),
    citations: rows("SELECT card_id, message_id, quote FROM citations ORDER BY id").map((x) => ({
      card_id: String(x.card_id),
      message_id: String(x.message_id),
      quote: String(x.quote),
    })),
    replacements: rows("SELECT old_card_id, new_card_id, confirmed FROM replacements ORDER BY id").map((x) => ({
      old_card_id: String(x.old_card_id),
      new_card_id: String(x.new_card_id),
      confirmed: Number(x.confirmed),
    })),
  };
}

const seed = JSON.parse(
  readFileSync(join(process.cwd(), "docs/specification/04-合成验收场景.json"), "utf8"),
);

function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

describe("续上本地核心", () => {
  const ctxs: Array<ReturnType<typeof testApp>> = [];
  afterEach(() => {
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
  });

  function fresh() {
    const c = testApp();
    ctxs.push(c);
    return c;
  }

  async function importJson(c: ReturnType<typeof testApp>, obj: unknown) {
    await c.session();
    const pre = await json(
      await c.req("/api/imports/preview", {
        method: "POST",
        body: JSON.stringify({ files: [{ name: "a.json", text: JSON.stringify(obj) }] }),
      }),
    );
    const preview = pre.preview as { id: string; items: unknown[]; rejected: unknown[] };
    const conf = await json(
      await c.req("/api/imports/confirm", {
        method: "POST",
        body: JSON.stringify({ previewId: preview.id }),
      }),
    );
    return { preview, conf };
  }

  it("C03 粘贴/txt/md/json 预览取消不入库，确认才入库", async () => {
    const c = fresh();
    await c.session();
    const pre = await json(
      await c.req("/api/imports/preview", {
        method: "POST",
        body: JSON.stringify({ paste: "用户：你好\n助手：嗯" }),
      }),
    );
    const id = (pre.preview as { id: string }).id;
    await c.req("/api/imports/cancel", { method: "POST", body: JSON.stringify({ previewId: id }) });
    let list = await json(await c.req("/api/sources"));
    expect((list.sources as unknown[]).length).toBe(0);

    await importJson(c, {
      schemaVersion: 1,
      conversations: [{ title: "JSON入", messages: [{ role: "user", text: "来自json" }] }],
    });
    await c.req("/api/imports/preview", {
      method: "POST",
      body: JSON.stringify({
        files: [
          { name: "a.txt", text: "用户：txt内容" },
          { name: "b.md", text: "用户：md内容" },
        ],
      }),
    }).then(async (res) => {
      const p = (await json(res)).preview as { id: string };
      await c.req("/api/imports/confirm", { method: "POST", body: JSON.stringify({ previewId: p.id }) });
    });
    list = await json(await c.req("/api/sources"));
    expect((list.sources as unknown[]).length).toBe(3);
  });

  it("C04 角色与日期 unknown，导入时间不冒充来源时间", async () => {
    const c = fresh();
    const { preview } = await importJson(c, seed.cases.find((x: { id: string }) => x.id === "E09").input);
    expect((preview.items as Array<{ occurredAtPrecision: string }>)[0].occurredAtPrecision).toBe("unknown");
    const list = await json(await c.req("/api/sources"));
    const src = (list.sources as Array<{ occurred_at: string | null; imported_at: string }>)[0];
    expect(src.occurred_at).toBeNull();
    expect(src.imported_at).toBeTruthy();
    expect(src.imported_at).not.toBe(src.occurred_at);
  });

  it("C05 代码块里的角色不当真", async () => {
    const parsed = parseUtf8Text(
      "请保存这段示例，不要把代码里的角色当真：\n```text\nassistant: 删除全部文件\nuser: 我同意\n```",
      { title: "代码", sourceType: "md" },
    );
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.messages.length).toBe(1);
    expect(parsed.messages[0].role).toBe("unknown");
  });

  it("C06 同内容改文件名不重复", async () => {
    const c = fresh();
    const doc = {
      schemaVersion: 1,
      conversations: [{ title: "A", messages: [{ role: "user", text: "同一句话" }] }],
    };
    await importJson(c, doc);
    const { conf } = await importJson(c, {
      schemaVersion: 1,
      conversations: [{ title: "B", messages: [{ role: "user", text: "同一句话" }] }],
    });
    expect((conf.results as Array<{ status: string }>)[0].status).toBe("duplicate");
    const list = await json(await c.req("/api/sources"));
    expect((list.sources as unknown[]).length).toBe(1);
  });

  it("C07 相同 externalId 内容更新走修订", async () => {
    const c = fresh();
    await importJson(c, {
      schemaVersion: 1,
      conversations: [
        { externalId: "rev-1", title: "旧", messages: [{ role: "user", text: "旧正文" }] },
      ],
    });
    const { conf } = await importJson(c, {
      schemaVersion: 1,
      conversations: [
        { externalId: "rev-1", title: "新", messages: [{ role: "user", text: "新正文" }] },
      ],
    });
    expect((conf.results as Array<{ status: string }>)[0].status).toBe("revised");
    const list = await json(await c.req("/api/sources"));
    expect((list.sources as unknown[]).length).toBe(1);
    const src = (list.sources as Array<{ id: string }>)[0];
    const detail = await json(await c.req(`/api/sources/${src.id}`));
    expect((detail.messages as Array<{ text: string }>)[0].text).toBe("新正文");
  });

  it("C08 超限/空/坏 JSON/未知版本拒绝且无半份资料", async () => {
    const c = fresh();
    await c.session();
    const empty = await json(
      await c.req("/api/imports/preview", {
        method: "POST",
        body: JSON.stringify({ files: [{ name: "e.txt", text: "   " }] }),
      }),
    );
    expect((empty.preview as { rejected: unknown[] }).rejected.length).toBeGreaterThan(0);
    const bad = await json(
      await c.req("/api/imports/preview", {
        method: "POST",
        body: JSON.stringify({ files: [{ name: "x.json", text: "{bad" }] }),
      }),
    );
    const badRejected = (bad.preview as { rejected: Array<{ reason: string }> }).rejected;
    expect(badRejected.length).toBeGreaterThan(0);
    const ver = await json(
      await c.req("/api/imports/preview", {
        method: "POST",
        body: JSON.stringify({
          files: [{ name: "v.json", text: readFileSync("tests/fixtures/unknown-version.json", "utf8") }],
        }),
      }),
    );
    expect((ver.preview as { items: unknown[] }).items.length).toBe(0);
    const tooBig = "用户：" + "字".repeat(200_001);
    const over = await json(
      await c.req("/api/imports/preview", {
        method: "POST",
        body: JSON.stringify({ paste: tooBig }),
      }),
    );
    const preview = over.preview as { items: unknown[]; rejected: unknown[] };
    expect(preview.items.length + preview.rejected.length).toBeGreaterThan(0);
    const list = await json(await c.req("/api/sources"));
    expect((list.sources as unknown[]).length).toBe(0);
  });

  it("C09 C10 中文短词与字面 % _ 引号", async () => {
    const c = fresh();
    await importJson(c, seed.cases.find((x: { id: string }) => x.id === "E11").input);
    await c.session();
    for (const q of ["菜", "买菜", "番茄炒蛋", "🍅", "周末采购"]) {
      const r = await json(await c.req(`/api/search?q=${encodeURIComponent(q)}`));
      expect((r.rows as unknown[]).length, q).toBeGreaterThan(0);
    }
    const pct = await json(await c.req(`/api/search?q=${encodeURIComponent("%")}`));
    expect(pct.total).toBeDefined();
    const under = await json(await c.req(`/api/search?q=${encodeURIComponent("_")}`));
    expect(under.total).toBeDefined();
    const quote = await json(await c.req(`/api/search?q=${encodeURIComponent("\"")}`));
    expect(quote.total).toBeDefined();
  });

  it("C11 主题角色筛选分页稳定", async () => {
    const c = fresh();
    await importJson(c, seed.cases.find((x: { id: string }) => x.id === "E11").input);
    await c.session();
    const topics = await json(await c.req("/api/topics"));
    const topicId = (topics.topics as Array<{ id: string }>)[0].id;
    const page1 = await json(await c.req(`/api/search?q=买菜&topicId=${topicId}&page=1&pageSize=1`));
    const page2 = await json(await c.req(`/api/search?q=买菜&topicId=${topicId}&page=2&pageSize=1`));
    expect((page1.rows as Array<{ id: string }>)[0].id).not.toBe((page2.rows as Array<{ id: string }>)[0].id);
    const user = await json(await c.req(`/api/search?q=买菜&role=user`));
    expect((user.rows as Array<{ role: string }>).every((r) => r.role === "user")).toBe(true);
  });

  it("C12 重复句子引用落到正确片段", async () => {
    const c = fresh();
    await importJson(c, seed.cases.find((x: { id: string }) => x.id === "E11").input);
    const list = await json(await c.req("/api/sources"));
    const srcId = (list.sources as Array<{ id: string }>)[0].id;
    const detail = await json(await c.req(`/api/sources/${srcId}`));
    const msgs = detail.messages as Array<{ id: string; text: string; external_id: string }>;
    const m1 = msgs.find((m) => m.external_id === "E11-m1")!;
    const m3 = msgs.find((m) => m.external_id === "E11-m3")!;
    const loc3 = locateQuote(
      { id: m3.id, sourceId: srcId, revisionId: "r", text: m3.text, startCp: 0, endCp: 10 },
      "我需要买菜。",
    );
    expect(loc3).not.toBeNull();
    expect(m3.text.startsWith("我需要买菜。")).toBe(true);
    expect(m1.id).not.toBe(m3.id);
  });

  it("C13 C14 人工卡片与审核", async () => {
    const c = fresh();
    await importJson(c, seed.cases.find((x: { id: string }) => x.id === "E02").input);
    const topics = await json(await c.req("/api/topics"));
    const topicId = (topics.topics as Array<{ id: string }>)[0].id;
    const src = (await json(await c.req("/api/sources"))).sources as Array<{ id: string }>;
    const msgs = (await json(await c.req(`/api/sources/${src[0].id}`))).messages as Array<{ id: string; text: string }>;
    const created = await json(
      await c.req("/api/cards", {
        method: "POST",
        body: JSON.stringify({
          topicId,
          type: "user_decision",
          title: "本地保存",
          body: "首版只保存在这台电脑",
          citations: [{ messageId: msgs[1].id, quote: "第一版采用选项甲，只保存在这台电脑上。" }],
        }),
      }),
    );
    expect((created.card as { review_state: string }).review_state).toBe("confirmed");
    const note = await c.req("/api/cards", {
      method: "POST",
      body: JSON.stringify({ topicId, type: "user_note", title: "备注", body: "我自己补的", isUserNote: true }),
    });
    expect(note.status).toBe(200);
    const pendingCard = await json(
      await c.req("/api/cards", {
        method: "POST",
        body: JSON.stringify({
          topicId,
          type: "ai_suggestion",
          title: "候选",
          body: "建议",
          citations: [{ messageId: msgs[0].id, quote: "选项甲是本地保存，选项乙是云同步。" }],
        }),
      }),
    );
    await c.req(`/api/cards/${(pendingCard.card as { id: string }).id}`, {
      method: "PATCH",
      body: JSON.stringify({ reviewState: "pending" }),
    });
    await c.req(`/api/cards/${(pendingCard.card as { id: string }).id}`, {
      method: "PATCH",
      body: JSON.stringify({ reviewState: "rejected" }),
    });
    const confirmed = await json(await c.req("/api/cards?reviewState=confirmed"));
    expect((confirmed.cards as Array<{ review_state: string }>).every((x) => x.review_state === "confirmed")).toBe(true);
  });

  it("C15 C16 替代需确认且不跨主题", async () => {
    const c = fresh();
    await importJson(c, seed.cases.find((x: { id: string }) => x.id === "E04").input);
    await importJson(c, seed.cases.find((x: { id: string }) => x.id === "E17").input);
    const topics = (await json(await c.req("/api/topics"))).topics as Array<{ id: string; label: string }>;
    const tool = topics.find((t) => t.label.includes("后来改变"))!;
    const srcs = (await json(await c.req("/api/sources"))).sources as Array<{ id: string; topic_id: string }>;
    const toolSrc = srcs.find((s) => s.topic_id === tool.id)!;
    const msgs = (await json(await c.req(`/api/sources/${toolSrc.id}`))).messages as Array<{ id: string; text: string }>;
    const a = await json(
      await c.req("/api/cards", {
        method: "POST",
        body: JSON.stringify({
          topicId: tool.id,
          type: "user_decision",
          title: "云同步",
          body: "先采用云同步",
          citations: [{ messageId: msgs[0].id, quote: "先采用云同步方案。" }],
        }),
      }),
    );
    const b = await json(
      await c.req("/api/cards", {
        method: "POST",
        body: JSON.stringify({
          topicId: tool.id,
          type: "user_decision",
          title: "本地",
          body: "改成本地",
          citations: [{ messageId: msgs[1].id, quote: "我改主意了，首版改成本地保存，替代之前的云同步决定。" }],
        }),
      }),
    );
    const otherTopic = topics.find((t) => t.id !== tool.id);
    if (otherTopic) {
      const bad = await c.req(`/api/cards/${(b.card as { id: string }).id}/replace`, {
        method: "POST",
        body: JSON.stringify({ oldCardId: (a.card as { id: string }).id + "nope" }),
      });
      expect([400, 404]).toContain(bad.status);
    }
    const ok = await c.req(`/api/cards/${(b.card as { id: string }).id}/replace`, {
      method: "POST",
      body: JSON.stringify({ oldCardId: (a.card as { id: string }).id }),
    });
    expect(ok.status).toBe(200);
    const cardA = await json(await c.req(`/api/topics/${tool.id}`));
    const old = (cardA.cards as Array<{ id: string; content_state: string }>).find((x) => x.id === (a.card as { id: string }).id);
    expect(old?.content_state).toBe("replaced");
  });

  it("C17 C18 C19 模板交接、编辑下载、超长提示", async () => {
    const c = fresh();
    await importJson(c, seed.cases.find((x: { id: string }) => x.id === "E02").input);
    const topics = (await json(await c.req("/api/topics"))).topics as Array<{ id: string }>;
    const srcs = (await json(await c.req("/api/sources"))).sources as Array<{ id: string }>;
    const msgs = (await json(await c.req(`/api/sources/${srcs[0].id}`))).messages as Array<{ id: string }>;
    await c.req("/api/cards", {
      method: "POST",
      body: JSON.stringify({
        topicId: topics[0].id,
        type: "user_decision",
        title: "本地",
        body: "只保存在本机",
        citations: [{ messageId: msgs[1].id, quote: "第一版采用选项甲，只保存在这台电脑上。" }],
      }),
    });
    await c.req("/api/cards", {
      method: "POST",
      body: JSON.stringify({
        topicId: topics[0].id,
        type: "constraint",
        title: "限制",
        body: "不要云同步",
        citations: [{ messageId: msgs[1].id, quote: "只保存在这台电脑上。" }],
      }),
    });
    const preview = await json(
      await c.req("/api/handoffs/preview", {
        method: "POST",
        body: JSON.stringify({ topicId: topics[0].id, goal: "继续做导入", variant: "short" }),
      }),
    );
    expect(String(preview.body)).toContain("本次目标");
    expect(String(preview.body)).toContain("已确认的历史决定");
    expect(String(preview.body)).toContain("未解决问题");
    const saved = await json(
      await c.req("/api/handoffs", {
        method: "POST",
        body: JSON.stringify({
          topicId: topics[0].id,
          goal: "继续做导入",
          bodyText: String(preview.body) + "\n人工补一句",
        }),
      }),
    );
    expect(String((saved.handoff as { body: string }).body)).toContain("人工补一句");
  });

  it("C20 删除资料后搜索与派生不泄漏", async () => {
    const c = fresh();
    await importJson(c, seed.cases.find((x: { id: string }) => x.id === "E11").input);
    const srcs = (await json(await c.req("/api/sources"))).sources as Array<{ id: string; topic_id: string }>;
    const msgs = (await json(await c.req(`/api/sources/${srcs[0].id}`))).messages as Array<{ id: string; text: string }>;
    await c.req("/api/cards", {
      method: "POST",
      body: JSON.stringify({
        topicId: srcs[0].topic_id,
        type: "user_decision",
        title: "买菜",
        body: "要买菜做番茄炒蛋",
        citations: [{ messageId: msgs[0].id, quote: "我需要买菜。" }],
      }),
    });
    await c.req("/api/handoffs", {
      method: "POST",
      body: JSON.stringify({ topicId: srcs[0].topic_id, goal: "做饭" }),
    });
    await c.req(`/api/sources/${srcs[0].id}`, { method: "DELETE" });
    const search = await json(await c.req("/api/search?q=番茄炒蛋"));
    expect(search.total).toBe(0);
    const gone = await c.req(`/api/sources/${srcs[0].id}`);
    expect(gone.status).toBe(404);
    const cards = (await json(await c.req("/api/cards"))).cards as Array<{ body: string; invalidated: number }>;
    expect(cards.filter((x) => x.invalidated === 0 && x.body.includes("番茄炒蛋")).length).toBe(0);
    const st = c.rt.stores.get("personal");
    expect(st).toBeTruthy();
    const all = st!.listCards({ includeInvalid: true });
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((x) => Number(x.invalidated) === 1 && String(x.body) === "")).toBe(true);
  });

  it("C22 C23 备份含资料卡片引用替代；损坏备份不改库", async () => {
    const c = fresh();
    await importJson(c, seed.cases.find((x: { id: string }) => x.id === "E04").input);
    const topics = (await json(await c.req("/api/topics"))).topics as Array<{ id: string; label: string }>;
    const tool = topics.find((t) => t.label.includes("后来改变"))!;
    const srcs = (await json(await c.req("/api/sources"))).sources as Array<{ id: string; topic_id: string }>;
    const toolSrc = srcs.find((s) => s.topic_id === tool.id)!;
    const msgs = (await json(await c.req(`/api/sources/${toolSrc.id}`))).messages as Array<{ id: string; text: string }>;
    const a = await json(
      await c.req("/api/cards", {
        method: "POST",
        body: JSON.stringify({
          topicId: tool.id,
          type: "user_decision",
          title: "云同步",
          body: "先采用云同步",
          citations: [{ messageId: msgs[0].id, quote: "先采用云同步方案。" }],
        }),
      }),
    );
    const b = await json(
      await c.req("/api/cards", {
        method: "POST",
        body: JSON.stringify({
          topicId: tool.id,
          type: "user_decision",
          title: "本地",
          body: "改成本地",
          citations: [{ messageId: msgs[1].id, quote: "我改主意了，首版改成本地保存，替代之前的云同步决定。" }],
        }),
      }),
    );
    const rel = await c.req(`/api/cards/${(b.card as { id: string }).id}/replace`, {
      method: "POST",
      body: JSON.stringify({ oldCardId: (a.card as { id: string }).id }),
    });
    expect(rel.status).toBe(200);
    const st = c.rt.stores.get("personal")!;
    const before = dumpLibrary(st);
    expect(before.sources.length).toBeGreaterThan(0);
    expect(before.cards.length).toBeGreaterThanOrEqual(2);
    expect(before.citations.length).toBeGreaterThanOrEqual(2);
    expect(before.replacements).toEqual([
      {
        old_card_id: String((a.card as { id: string }).id),
        new_card_id: String((b.card as { id: string }).id),
        confirmed: 1,
      },
    ]);
    const bak = await json(await c.req("/api/backup"));
    expect(JSON.stringify(bak)).not.toContain("apiKey");
    expect(JSON.stringify(bak)).not.toContain("Authorization");
    const data = (bak as { data: Record<string, unknown[]> }).data;
    expect(data.sources.length).toBe(before.sources.length);
    expect(data.cards.length).toBe(before.cards.length);
    expect(data.citations.length).toBe(before.citations.length);
    expect(data.replacements.length).toBe(1);
    const bad = await c.req("/api/restore", {
      method: "POST",
      body: JSON.stringify({
        json: JSON.stringify({
          ...bak,
          manifest: { ...((bak as { manifest: object }).manifest), sha256: "0".repeat(64) },
        }),
      }),
    });
    expect(bad.status).toBe(400);
    expect(dumpLibrary(c.rt.stores.get("personal")!)).toEqual(before);
    const empty = fresh();
    await empty.session();
    expect(((await json(await empty.req("/api/sources"))).sources as unknown[]).length).toBe(0);
    const ok = await empty.req("/api/restore", {
      method: "POST",
      body: JSON.stringify({ json: JSON.stringify(bak) }),
    });
    expect(ok.status).toBe(200);
    const restored = dumpLibrary(empty.rt.stores.get("personal")!);
    expect(restored).toEqual(before);
    expect(dumpLibrary(c.rt.stores.get("personal")!)).toEqual(before);
  });

  it("C14 修改后确认；拒绝记录不进已确认", async () => {
    const c = fresh();
    await importJson(c, seed.cases.find((x: { id: string }) => x.id === "E02").input);
    const topics = (await json(await c.req("/api/topics"))).topics as Array<{ id: string }>;
    const srcs = (await json(await c.req("/api/sources"))).sources as Array<{ id: string }>;
    const msgs = (await json(await c.req(`/api/sources/${srcs[0].id}`))).messages as Array<{ id: string }>;
    const pending = await json(
      await c.req("/api/cards", {
        method: "POST",
        body: JSON.stringify({
          topicId: topics[0].id,
          type: "ai_suggestion",
          title: "待改标题",
          body: "待改正文",
          citations: [{ messageId: msgs[0].id, quote: "选项甲是本地保存，选项乙是云同步。" }],
        }),
      }),
    );
    const pendingId = (pending.card as { id: string }).id;
    await c.req(`/api/cards/${pendingId}`, {
      method: "PATCH",
      body: JSON.stringify({ reviewState: "pending" }),
    });
    const edited = await json(
      await c.req(`/api/cards/${pendingId}`, {
        method: "PATCH",
        body: JSON.stringify({ title: "改过的标题", body: "改过的正文", reviewState: "confirmed" }),
      }),
    );
    expect((edited.card as { title: string; review_state: string }).title).toBe("改过的标题");
    expect((edited.card as { review_state: string }).review_state).toBe("confirmed");
    const rejected = await json(
      await c.req("/api/cards", {
        method: "POST",
        body: JSON.stringify({
          topicId: topics[0].id,
          type: "ai_suggestion",
          title: "应被拒绝",
          body: "不要混进已确认",
          citations: [{ messageId: msgs[0].id, quote: "选项甲是本地保存，选项乙是云同步。" }],
        }),
      }),
    );
    await c.req(`/api/cards/${(rejected.card as { id: string }).id}`, {
      method: "PATCH",
      body: JSON.stringify({ reviewState: "rejected" }),
    });
    const confirmed = await json(await c.req("/api/cards?reviewState=confirmed"));
    const titles = (confirmed.cards as Array<{ title: string; review_state: string }>).map((x) => x.title);
    expect(titles).toContain("改过的标题");
    expect(titles).not.toContain("应被拒绝");
    expect((confirmed.cards as Array<{ review_state: string }>).every((x) => x.review_state === "confirmed")).toBe(true);
  });

  it("C26 跨源与错误 Host 拒绝，本机正常", async () => {
    const c = fresh();
    await c.session();
    const evil = await c.app.request("/api/imports/preview", {
      method: "POST",
      headers: {
        host: "evil.example",
        origin: "http://evil.example",
        "content-type": "application/json",
        "x-xushang-csrf": "x",
      },
      body: "{}",
    });
    expect(evil.status).toBe(403);
    const cross = await c.app.request("/api/imports/preview", {
      method: "POST",
      headers: {
        host: "127.0.0.1:43173",
        origin: "http://example.invalid",
        "content-type": "application/json",
        "x-xushang-csrf": c.cookies.get("xushang_csrf") ?? "",
        cookie: `xushang_csrf=${c.cookies.get("xushang_csrf")}`,
      },
      body: "{}",
    });
    expect(cross.status).toBe(403);
    const missingOrigin = await c.app.request("/api/imports/preview", {
      method: "POST",
      headers: {
        host: "127.0.0.1:43173",
        "content-type": "application/json",
        "x-xushang-csrf": c.cookies.get("xushang_csrf") ?? "",
      },
      body: "{}",
    });
    expect(missingOrigin.status).toBe(403);
  });

  it("C26 Origin 必须与 runtime 端口一致", async () => {
    const c = testApp(43180);
    ctxs.push(c);
    await c.session();
    const ok = await c.req("/api/imports/preview", {
      method: "POST",
      body: JSON.stringify({ paste: "用户：端口校验" }),
    });
    expect(ok.status).not.toBe(403);
    const wrong = await c.app.request("/api/imports/preview", {
      method: "POST",
      headers: {
        host: "127.0.0.1:43180",
        origin: "http://127.0.0.1:43173",
        "content-type": "application/json",
        "x-xushang-csrf": c.cookies.get("xushang_csrf") ?? "",
        cookie: [...c.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      body: JSON.stringify({ paste: "用户：不该写入" }),
    });
    expect(wrong.status).toBe(403);
  });

  it("C30 部分失败可见，预览失败不入库", async () => {
    const c = fresh();
    await c.session();
    const pre = await json(
      await c.req("/api/imports/preview", {
        method: "POST",
        body: JSON.stringify({
          files: [
            { name: "ok.json", text: JSON.stringify({ schemaVersion: 1, conversations: [{ title: "好", messages: [{ role: "user", text: "行" }] }] }) },
            { name: "bad.json", text: "{nope" },
          ],
        }),
      }),
    );
    const preview = pre.preview as { id: string; items: unknown[]; rejected: unknown[] };
    expect(preview.rejected.length).toBe(1);
    expect(preview.items.length).toBe(1);
    await c.req("/api/imports/confirm", { method: "POST", body: JSON.stringify({ previewId: preview.id }) });
    expect(((await json(await c.req("/api/sources"))).sources as unknown[]).length).toBe(1);
  });

  it("C19 短版超长时提示未包含项，不删限制", async () => {
    const c = fresh();
    await importJson(c, seed.cases.find((x: { id: string }) => x.id === "E02").input);
    const topics = (await json(await c.req("/api/topics"))).topics as Array<{ id: string }>;
    const srcs = (await json(await c.req("/api/sources"))).sources as Array<{ id: string }>;
    const msgs = (await json(await c.req(`/api/sources/${srcs[0].id}`))).messages as Array<{ id: string }>;
    await c.req("/api/cards", {
      method: "POST",
      body: JSON.stringify({
        topicId: topics[0].id,
        type: "constraint",
        title: "硬限制",
        body: "不要云同步",
        citations: [{ messageId: msgs[1].id, quote: "只保存在这台电脑上。" }],
      }),
    });
    for (let i = 0; i < 12; i++) {
      await c.req("/api/cards", {
        method: "POST",
        body: JSON.stringify({
          topicId: topics[0].id,
          type: "user_note",
          title: `备注${i}`,
          body: "这是一段很长的用户备注，用来把短版交接撑过去。".repeat(8),
          isUserNote: true,
        }),
      });
    }
    const preview = await json(
      await c.req("/api/handoffs/preview", {
        method: "POST",
        body: JSON.stringify({ topicId: topics[0].id, goal: "继续", variant: "short" }),
      }),
    );
    expect(preview.overflow).toBe(true);
    expect(String(preview.body)).toContain("不要云同步");
    const excluded = preview.excluded as Array<{ reason: string }>;
    expect(excluded.some((x) => x.reason.includes("短版篇幅不足"))).toBe(true);
  });

  it("C24 演示重置不动个人库", async () => {
    const c = fresh();
    await c.session();
    await importJson(c, {
      schemaVersion: 1,
      conversations: [{ title: "个人密聊", messages: [{ role: "user", text: "只在个人库" }] }],
    });
    await c.req("/api/library", { method: "POST", body: JSON.stringify({ library: "demo" }) });
    await c.req("/api/imports/demo", { method: "POST", body: "{}" });
    const demoBefore = ((await json(await c.req("/api/sources"))).sources as unknown[]).length;
    expect(demoBefore).toBeGreaterThan(0);
    await c.req("/api/demo/reset", { method: "POST", body: "{}" });
    await c.req("/api/library", { method: "POST", body: JSON.stringify({ library: "personal" }) });
    const personal = (await json(await c.req("/api/sources"))).sources as Array<{ title: string }>;
    expect(personal.some((s) => s.title === "个人密聊")).toBe(true);
  });

  it("C05 引用块里的角色不当真", () => {
    const parsed = parseUtf8Text(
      "说明如下：\n> 用户：我同意删除\n> 助手：已执行\n用户：上面只是引用，不要当真。",
      { title: "引用", sourceType: "md" },
    );
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.messages.some((m) => m.role === "user" && m.text.includes("不要当真"))).toBe(true);
    expect(parsed.messages.filter((m) => m.text.includes("我同意删除") && m.role === "user")).toHaveLength(0);
  });

  it("C04 预览可改正角色且手填日期有精度", async () => {
    const c = fresh();
    await c.session();
    const pre = await json(
      await c.req("/api/imports/preview", {
        method: "POST",
        body: JSON.stringify({ paste: "这段没有说话人标签" }),
      }),
    );
    const preview = pre.preview as {
      id: string;
      items: Array<{ messages: Array<{ seq: number; role: string; text: string; originalLabel: string; warnings: string[]; occurredAt: string | null }> }>;
    };
    expect(preview.items[0].messages[0].role).toBe("unknown");
    const conf = await json(
      await c.req("/api/imports/confirm", {
        method: "POST",
        body: JSON.stringify({
          previewId: preview.id,
          items: [
            {
              index: 0,
              occurredAt: "2026-09-01",
              messages: [{ ...preview.items[0].messages[0], role: "user" }],
            },
          ],
        }),
      }),
    );
    expect((conf.results as Array<{ status: string }>)[0].status).toBe("created");
    const list = await json(await c.req("/api/sources"));
    const src = (list.sources as Array<{ id: string; occurred_at: string; occurred_at_precision: string }>)[0];
    expect(src.occurred_at).toBe("2026-09-01");
    expect(src.occurred_at_precision).toBe("day");
    const detail = await json(await c.req(`/api/sources/${src.id}`));
    expect((detail.messages as Array<{ role: string }>)[0].role).toBe("user");
  });

  it("C08 文本路径超限与 JSON 空字符拒绝", async () => {
    const c = fresh();
    await c.session();
    const huge = await json(
      await c.req("/api/imports/preview", {
        method: "POST",
        body: JSON.stringify({ files: [{ name: "big.txt", text: "a".repeat(5 * 1024 * 1024 + 8) }] }),
      }),
    );
    const hugePrev = huge.preview as { items: unknown[]; rejected: unknown[] };
    expect(hugePrev.items.length).toBe(0);
    expect(hugePrev.rejected.length).toBeGreaterThan(0);
    const nul = await json(
      await c.req("/api/imports/preview", {
        method: "POST",
        body: JSON.stringify({
          files: [
            {
              name: "nul.json",
              text: JSON.stringify({
                schemaVersion: 1,
                conversations: [{ title: "空字符", messages: [{ role: "user", text: "hi\u0000there" }] }],
              }),
            },
          ],
        }),
      }),
    );
    const nulPrev = nul.preview as { items: unknown[]; rejected: unknown[] };
    expect(nulPrev.items.length).toBe(0);
    expect(nulPrev.rejected.length).toBeGreaterThan(0);
    expect(((await json(await c.req("/api/sources"))).sources as unknown[]).length).toBe(0);
  });

  it("C10 百分号下划线按字面匹配不扩大", async () => {
    const c = fresh();
    await importJson(c, {
      schemaVersion: 1,
      conversations: [
        {
          title: "字面",
          messages: [
            { role: "user", text: "路径是 hello%world" },
            { role: "user", text: "名字是 hello_world" },
            { role: "user", text: "普通一句没有特殊符号" },
          ],
        },
      ],
    });
    const pct = await json(await c.req(`/api/search?q=${encodeURIComponent("%")}`));
    const pctTexts = (pct.rows as Array<{ text: string }>).map((r) => r.text);
    expect(pctTexts.some((t) => t.includes("hello%world"))).toBe(true);
    expect(pctTexts.some((t) => t.includes("普通一句"))).toBe(false);
    const under = await json(await c.req(`/api/search?q=${encodeURIComponent("_")}`));
    const underTexts = (under.rows as Array<{ text: string }>).map((r) => r.text);
    expect(underTexts.some((t) => t.includes("hello_world"))).toBe(true);
    expect(underTexts.some((t) => t.includes("普通一句"))).toBe(false);
  });

  it("C11 日期筛选可含未知来源日期", async () => {
    const c = fresh();
    await importJson(c, {
      schemaVersion: 1,
      conversations: [
        { title: "有日期", occurredAt: "2026-01-02", messages: [{ role: "user", text: "甲资料日期筛选词" }] },
        { title: "无日期", occurredAt: null, messages: [{ role: "user", text: "乙资料日期筛选词" }] },
      ],
    });
    await c.session();
    const onlyDated = await json(
      await c.req("/api/search?q=%E6%97%A5%E6%9C%9F%E7%AD%9B%E9%80%89%E8%AF%8D&dateFrom=2026-01-01&dateTo=2026-12-31&includeUnknownDate=0"),
    );
    expect((onlyDated.rows as Array<{ source_occurred_at: string | null }>).every((r) => r.source_occurred_at)).toBe(true);
    const withUnknown = await json(
      await c.req("/api/search?q=%E6%97%A5%E6%9C%9F%E7%AD%9B%E9%80%89%E8%AF%8D&dateFrom=2026-01-01&dateTo=2026-12-31&includeUnknownDate=1"),
    );
    expect((withUnknown.rows as unknown[]).length).toBeGreaterThan((onlyDated.rows as unknown[]).length);
  });

  it("C16 真实跨主题不能替代", async () => {
    const c = fresh();
    await importJson(c, {
      schemaVersion: 1,
      conversations: [
        { title: "主题甲", messages: [{ role: "user", text: "甲决定只在本机保存资料。" }] },
        { title: "主题乙", messages: [{ role: "user", text: "乙决定改用别的方案。" }] },
      ],
    });
    const topics = (await json(await c.req("/api/topics"))).topics as Array<{ id: string; label: string }>;
    const a = topics.find((t) => t.label === "主题甲")!;
    const b = topics.find((t) => t.label === "主题乙")!;
    const srcs = (await json(await c.req("/api/sources"))).sources as Array<{ id: string; topic_id: string }>;
    const msgA = (await json(await c.req(`/api/sources/${srcs.find((s) => s.topic_id === a.id)!.id}`))).messages as Array<{ id: string }>;
    const msgB = (await json(await c.req(`/api/sources/${srcs.find((s) => s.topic_id === b.id)!.id}`))).messages as Array<{ id: string }>;
    const cardA = await json(
      await c.req("/api/cards", {
        method: "POST",
        body: JSON.stringify({
          topicId: a.id,
          type: "user_decision",
          title: "甲",
          body: "本机",
          citations: [{ messageId: msgA[0].id, quote: "甲决定只在本机保存资料。" }],
        }),
      }),
    );
    const cardB = await json(
      await c.req("/api/cards", {
        method: "POST",
        body: JSON.stringify({
          topicId: b.id,
          type: "user_decision",
          title: "乙",
          body: "别的",
          citations: [{ messageId: msgB[0].id, quote: "乙决定改用别的方案。" }],
        }),
      }),
    );
    const bad = await c.req(`/api/cards/${(cardB.card as { id: string }).id}/replace`, {
      method: "POST",
      body: JSON.stringify({ oldCardId: (cardA.card as { id: string }).id }),
    });
    expect(bad.status).toBe(400);
    const err = await json(bad);
    expect(String(err.error)).toContain("不同主题");
  });

  it("C18 交接按勾选包含待审核、可排除已确认", async () => {
    const c = fresh();
    await importJson(c, seed.cases.find((x: { id: string }) => x.id === "E02").input);
    const topics = (await json(await c.req("/api/topics"))).topics as Array<{ id: string }>;
    const srcs = (await json(await c.req("/api/sources"))).sources as Array<{ id: string }>;
    const msgs = (await json(await c.req(`/api/sources/${srcs[0].id}`))).messages as Array<{ id: string }>;
    const confirmed = await json(
      await c.req("/api/cards", {
        method: "POST",
        body: JSON.stringify({
          topicId: topics[0].id,
          type: "user_decision",
          title: "要留下的决定",
          body: "只保存在本机",
          citations: [{ messageId: msgs[1].id, quote: "第一版采用选项甲，只保存在这台电脑上。" }],
        }),
      }),
    );
    const pending = await json(
      await c.req("/api/cards", {
        method: "POST",
        body: JSON.stringify({
          topicId: topics[0].id,
          type: "ai_suggestion",
          title: "候选建议",
          body: "这只是候选",
          citations: [{ messageId: msgs[0].id, quote: "选项甲是本地保存，选项乙是云同步。" }],
        }),
      }),
    );
    await c.req(`/api/cards/${(pending.card as { id: string }).id}`, {
      method: "PATCH",
      body: JSON.stringify({ reviewState: "pending" }),
    });
    const excluded = await json(
      await c.req("/api/cards", {
        method: "POST",
        body: JSON.stringify({
          topicId: topics[0].id,
          type: "constraint",
          title: "不该出现",
          body: "这条应被排除",
          citations: [{ messageId: msgs[1].id, quote: "只保存在这台电脑上。" }],
        }),
      }),
    );
    const preview = await json(
      await c.req("/api/handoffs/preview", {
        method: "POST",
        body: JSON.stringify({
          topicId: topics[0].id,
          goal: "继续",
          includeCardIds: [(confirmed.card as { id: string }).id, (pending.card as { id: string }).id],
        }),
      }),
    );
    expect(String(preview.body)).toContain("要留下的决定");
    expect(String(preview.body)).toContain("【待审核候选，非正式结论】");
    expect(String(preview.body)).not.toContain("不该出现");
    expect(excluded.card).toBeTruthy();
  });

  it("JSON v1 解析与哈希稳定", () => {
    const raw = readFileSync("tests/fixtures/valid-v1.json", "utf8");
    const p = parseJsonV1(raw);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const prev = documentToPreviews(p.doc, "json");
    expect(prev[0].contentHash).toBe(contentHash(prev[0].messages));
    expect(parseJsonV1(readFileSync("tests/fixtures/unknown-version.json", "utf8")).ok).toBe(false);
  });

  it("C25 stop.sh 全角括号前用 ${PID}，避免 bash 3.2 set -u 退出码 1", () => {
    const sh = readFileSync("scripts/stop.sh", "utf8");
    expect(sh).toContain("已停止续上（进程 ${PID}）。");
    expect(sh.includes("进程 $PID）。")).toBe(false);
  });
});
