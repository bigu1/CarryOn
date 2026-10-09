import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { testApp } from "../helpers.js";
import { Store } from "../../src/storage/db.js";
import { questionTerms } from "../../src/ai/jobs.js";

/** 2026-10 整改：审查中用 HTTP 复现的 L1–L8 逻辑缺陷。 */

function json(res: Response) {
  return res.json() as Promise<Record<string, any>>;
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
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

describe("整改回归 L1–L8", () => {
  const ctxs: Array<ReturnType<typeof testApp>> = [];
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of ctxs) for (const s of c.rt.stores.values()) try { s.close(); } catch { /* ignore */ }
    ctxs.length = 0;
    for (const f of closers) await f();
    closers.length = 0;
  });
  function fresh() {
    const c = testApp();
    ctxs.push(c);
    return c;
  }

  async function paste(c: ReturnType<typeof testApp>, text: string, extra: Record<string, unknown> = {}) {
    await c.session();
    const pre = await json(await c.req("/api/imports/preview", { method: "POST", body: JSON.stringify({ paste: text, ...extra }) }));
    await c.req("/api/imports/confirm", { method: "POST", body: JSON.stringify({ previewId: pre.preview.id }) });
    const srcs = (await json(await c.req("/api/sources"))).sources as Array<Record<string, any>>;
    const src = srcs[0];
    const detail = await json(await c.req(`/api/sources/${src.id}`));
    return { pre, src, messages: detail.messages as Array<Record<string, any>> };
  }

  async function card(c: ReturnType<typeof testApp>, topicId: string, messageId: string, quote: string, extra: Record<string, unknown> = {}) {
    const r = await json(
      await c.req("/api/cards", {
        method: "POST",
        body: JSON.stringify({ topicId, type: "user_decision", title: "本机版", body: "先做本机版", citations: [{ messageId, quote }], ...extra }),
      }),
    );
    return r.card as Record<string, any>;
  }

  it("L5 导入的统一主题生效；粘贴标题取第一句", async () => {
    const c = fresh();
    const { pre, src } = await paste(c, "用户：我决定先做本机版。\n助手：建议用 SQLite。", { defaultTopic: "资料保存" });
    expect(pre.preview.items[0].topicLabel).toBe("资料保存");
    expect(pre.preview.items[0].title).toBe("我决定先做本机版。");
    expect(src.topic_label).toBe("资料保存");
  });

  it("L1 说话人更正后重新确认：卡片回到有效，不会消失", async () => {
    const c = fresh();
    const { src, messages } = await paste(c, "用户：我决定先做本机版。\n助手：建议用 SQLite。");
    const k = await card(c, src.topic_id, messages[0].id, "先做本机版");
    await c.req(`/api/sources/${src.id}`, { method: "PATCH", body: JSON.stringify({ messages: [{ id: messages[0].id, role: "assistant" }] }) });
    let listed = (await json(await c.req(`/api/cards?topicId=${src.topic_id}`))).cards as Array<Record<string, any>>;
    expect(listed.find((x) => x.id === k.id)).toMatchObject({ review_state: "pending", invalidated: 1 });
    expect(listed.find((x) => x.id === k.id)!.citations[0].message_role).toBe("assistant");
    const r = await c.req(`/api/cards/${k.id}`, { method: "PATCH", body: JSON.stringify({ type: "ai_suggestion", reviewState: "confirmed" }) });
    expect(r.status).toBe(200);
    listed = (await json(await c.req(`/api/cards?topicId=${src.topic_id}`))).cards as Array<Record<string, any>>;
    expect(listed.find((x) => x.id === k.id)).toMatchObject({ review_state: "confirmed", invalidated: 0, type: "ai_suggestion" });
  });

  it("L1 来源已删除的卡不能被确认回来；改成用户备注并重写正文可以", async () => {
    const c = fresh();
    const { src, messages } = await paste(c, "用户：我决定先做本机版。");
    const k = await card(c, src.topic_id, messages[0].id, "先做本机版");
    await c.req(`/api/cards/${k.id}`, { method: "PATCH", body: JSON.stringify({ reviewState: "pending" }) });
    await c.req(`/api/sources/${src.id}`, { method: "DELETE" });
    const bad = await c.req(`/api/cards/${k.id}`, { method: "PATCH", body: JSON.stringify({ reviewState: "confirmed" }) });
    expect(bad.status).toBe(400);
    expect((await json(bad)).code).toBe("needs_body");
    const noSrc = await c.req(`/api/cards/${k.id}`, { method: "PATCH", body: JSON.stringify({ body: "我记得是本机版", reviewState: "confirmed" }) });
    expect((await json(noSrc)).code).toBe("no_live_source");
    const ok = await c.req(`/api/cards/${k.id}`, {
      method: "PATCH",
      body: JSON.stringify({ body: "我记得是本机版", type: "user_note", reviewState: "confirmed" }),
    });
    expect(ok.status).toBe(200);
    expect((await json(ok)).card).toMatchObject({ is_user_note: 1, invalidated: 0 });
  });

  it("L2 不传勾选清单时，交接不带待审核卡", async () => {
    const c = fresh();
    const { src, messages } = await paste(c, "用户：我决定先做本机版。\n助手：建议用 SQLite。");
    await card(c, src.topic_id, messages[0].id, "先做本机版", { title: "已确认决定" });
    const p = await card(c, src.topic_id, messages[1].id, "建议用 SQLite", { type: "ai_suggestion", title: "候选建议" });
    await c.req(`/api/cards/${p.id}`, { method: "PATCH", body: JSON.stringify({ reviewState: "pending" }) });
    const pre = await json(await c.req("/api/handoffs/preview", { method: "POST", body: JSON.stringify({ topicId: src.topic_id, goal: "继续" }) }));
    expect(pre.body).toContain("已确认决定");
    expect(pre.body).not.toContain("候选建议");
    const saved = await json(await c.req("/api/handoffs", { method: "POST", body: JSON.stringify({ topicId: src.topic_id, goal: "继续" }) }));
    expect(JSON.parse(saved.handoff.included_card_ids)).not.toContain(p.id);
    const explicit = await json(
      await c.req("/api/handoffs/preview", { method: "POST", body: JSON.stringify({ topicId: src.topic_id, goal: "继续", includePending: true }) }),
    );
    expect(explicit.body).toContain("【待审核候选，非正式结论】候选建议");
  });

  it("L3 删除后备份里没有资料标题、卡片标题、交接目标", async () => {
    const c = fresh();
    const { src, messages } = await paste(c, "用户：番茄炒蛋计划要保密。", { pasteTitle: "番茄炒蛋计划", defaultTopic: "做饭" });
    await card(c, src.topic_id, messages[0].id, "番茄炒蛋计划要保密", { title: "番茄炒蛋保密" });
    await c.req("/api/handoffs", { method: "POST", body: JSON.stringify({ topicId: src.topic_id, goal: "番茄炒蛋目标" }) });
    await c.req(`/api/sources/${src.id}`, { method: "DELETE" });
    const pack = await json(await c.req("/api/backup"));
    const leaks = Object.entries(pack.data as Record<string, unknown[]>).flatMap(([t, rows]) =>
      rows.filter((r) => JSON.stringify(r).includes("番茄炒蛋")).map((r) => `${t}:${JSON.stringify(r).slice(0, 160)}`),
    );
    expect(leaks).toEqual([]);
  });

  it("L4 上次中断的任务不会永久占住模型", async () => {
    const c = fresh();
    await c.session();
    await c.req("/api/home");
    const st = c.rt.stores.get("personal")!;
    st.createJob("extract", {}, {});
    expect(st.runningJobCount()).toBe(1);
    st.close();
    c.rt.stores.delete("personal");
    const reopened = new Store({ path: `${c.rt.dataRoot}/personal/xushang.db` });
    expect(reopened.runningJobCount()).toBe(0);
    reopened.close();
  });

  it("L6 资料修订后旧卡进入待核对并保留正文；只引旧版时需明确知情才能确认", async () => {
    const c = fresh();
    await c.session();
    const doc = (text: string) =>
      JSON.stringify({ schemaVersion: 1, conversations: [{ title: "修订", externalId: "REV-1", messages: [{ role: "user", text }] }] });
    const imp = async (text: string) => {
      const pre = await json(await c.req("/api/imports/preview", { method: "POST", body: JSON.stringify({ files: [{ name: "a.json", text: doc(text) }] }) }));
      await c.req("/api/imports/confirm", { method: "POST", body: JSON.stringify({ previewId: pre.preview.id }) });
    };
    await imp("我选甲。");
    const src = ((await json(await c.req("/api/sources"))).sources as Array<Record<string, any>>)[0];
    const msgs = (await json(await c.req(`/api/sources/${src.id}`))).messages as Array<Record<string, any>>;
    const k = await card(c, src.topic_id, msgs[0].id, "我选甲");
    await imp("我选乙。");
    const after = (await json(await c.req(`/api/cards/${k.id}`))).card;
    expect(after).toMatchObject({ review_state: "pending", invalidated: 1, body: "先做本机版" });
    expect(after.citations[0].status).toBe("historical");
    const pending = (await json(await c.req("/api/cards?reviewState=pending"))).cards as Array<{ id: string }>;
    expect(pending.some((x) => x.id === k.id)).toBe(true);
    const r1 = await c.req(`/api/cards/${k.id}`, { method: "PATCH", body: JSON.stringify({ reviewState: "confirmed" }) });
    expect((await json(r1)).code).toBe("historical");
    const r2 = await c.req(`/api/cards/${k.id}`, { method: "PATCH", body: JSON.stringify({ reviewState: "confirmed", acknowledgeHistorical: true }) });
    expect(r2.status).toBe(200);
  });

  it("L7 润色只发送交接正文，预览字数与实际发送一致", async () => {
    const c = fresh();
    const { src } = await paste(c, "用户：SECRET_SOURCE_TEXT_L7 不该发给润色。");
    const sent: string[] = [];
    const mock = await mockServer((raw, res) => {
      sent.push(raw);
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ body: "# 交接\n润色后" }) } }] }),
      );
    });
    closers.push(mock.close);
    await c.req("/api/ai/config", { method: "POST", body: JSON.stringify({ baseUrl: mock.url, model: "m", apiKey: "k" }) });
    const handoffBody = "# 交接\n## 未解决问题\n- 还没定";
    const pre = await json(
      await c.req("/api/ai/preview-scope", { method: "POST", body: JSON.stringify({ topicId: src.topic_id, kind: "polish", handoffBody }) }),
    );
    expect(pre.sources).toEqual([]);
    expect(pre.sendChars).toBe(Array.from(handoffBody).length);
    const r = await json(
      await c.req("/api/ai/polish", { method: "POST", body: JSON.stringify({ topicId: src.topic_id, handoffBody, confirmSend: true }) }),
    );
    expect(sent.length).toBe(1);
    expect(sent[0]).not.toContain("SECRET_SOURCE_TEXT_L7");
    expect(r.warnings[0]).toMatch(/## 未解决问题/);
  });

  it("L8 回答按问题里的词挑原文，保存结构化来源而不是 UUID", async () => {
    const c = fresh();
    const { src, messages } = await paste(c, "用户：首版不做云同步，先验证本地价值。\n用户：今天天气不错。");
    const sent: string[] = [];
    const target = messages[0];
    await card(c, src.topic_id, target.id, "首版不做云同步", { title: "已核对的历史决定" });
    const mock = await mockServer((raw, res) => {
      sent.push(raw);
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  points: [{ text: "首版不做云同步", kind: "decision", support: [{ messageId: target.id, quote: "首版不做云同步" }] }],
                  insufficient: false,
                  conflicts: [],
                }),
              },
            },
          ],
        }),
      );
    });
    closers.push(mock.close);
    await c.req("/api/ai/config", { method: "POST", body: JSON.stringify({ baseUrl: mock.url, model: "m", apiKey: "k" }) });
    const pre = await json(
      await c.req("/api/ai/preview-scope", { method: "POST", body: JSON.stringify({ topicId: src.topic_id, question: "为什么放弃云同步？", kind: "answer" }) }),
    );
    expect(pre.hitCount).toBe(1);
    expect(pre.sendMessageCount).toBe(1);
    const r = await json(
      await c.req("/api/ai/answer", { method: "POST", body: JSON.stringify({ topicId: src.topic_id, question: "为什么放弃云同步？", confirmSend: true }) }),
    );
    const payload = JSON.parse(JSON.parse(sent[0]).messages[1].content);
    expect(payload.messages.map((m: { text: string }) => m.text)).toEqual([target.text]);
    expect(r.answer.body).not.toContain(target.id);
    const points = JSON.parse(r.answer.points_json);
    expect(points.points[0]).toMatchObject({ kind: "decision", kindLabel: "已确认的历史决定" });
    expect(points.points[0].support[0].sourceTitle).toBe(src.title);
  });

  it("问题拆词：英文代码整词保留，中文去掉虚词", () => {
    const terms = questionTerms("为什么放弃云同步？HIT_F08_X");
    expect(terms).toContain("放弃云同步");
    expect(terms).toContain("同步");
    expect(terms).toContain("放弃");
    expect(terms).toContain("hit_f08_x");
    expect(terms).not.toContain("什么");
  });

  it("替代关系：不能自替代，新决定必须已确认", async () => {
    const c = fresh();
    const { src, messages } = await paste(c, "用户：先用甲。\n用户：改用乙。");
    const a = await card(c, src.topic_id, messages[0].id, "先用甲", { title: "甲" });
    const b = await card(c, src.topic_id, messages[1].id, "改用乙", { title: "乙" });
    expect((await c.req(`/api/cards/${a.id}/replace`, { method: "POST", body: JSON.stringify({ oldCardId: a.id }) })).status).toBe(400);
    await c.req(`/api/cards/${b.id}`, { method: "PATCH", body: JSON.stringify({ reviewState: "pending" }) });
    expect((await c.req(`/api/cards/${b.id}/replace`, { method: "POST", body: JSON.stringify({ oldCardId: a.id }) })).status).toBe(400);
    await c.req(`/api/cards/${b.id}`, { method: "PATCH", body: JSON.stringify({ reviewState: "confirmed" }) });
    expect((await c.req(`/api/cards/${b.id}/replace`, { method: "POST", body: JSON.stringify({ oldCardId: a.id }) })).status).toBe(200);
    const topic = await json(await c.req(`/api/topics/${src.topic_id}`));
    expect(topic.replacements[0]).toMatchObject({ old_title: "甲", new_title: "乙" });
  });

  it("替代关系一端因删除失效后，关系撤销，旧决定恢复有效", async () => {
    const c = fresh();
    const a0 = await paste(c, "用户：先用甲。", { defaultTopic: "选型" });
    const a = await card(c, a0.src.topic_id, a0.messages[0].id, "先用甲", { title: "甲" });
    await c.session();
    const pre = await json(await c.req("/api/imports/preview", { method: "POST", body: JSON.stringify({ paste: "用户：改用乙。", defaultTopic: "选型" }) }));
    await c.req("/api/imports/confirm", { method: "POST", body: JSON.stringify({ previewId: pre.preview.id }) });
    const srcB = ((await json(await c.req("/api/sources"))).sources as Array<Record<string, any>>).find((x) => x.title === "改用乙。")!;
    const msgB = ((await json(await c.req(`/api/sources/${srcB.id}`))).messages as Array<Record<string, any>>)[0];
    const b = await card(c, a0.src.topic_id, msgB.id, "改用乙", { title: "乙" });
    await c.req(`/api/cards/${b.id}/replace`, { method: "POST", body: JSON.stringify({ oldCardId: a.id }) });
    expect((await json(await c.req(`/api/cards/${a.id}`))).card.content_state).toBe("replaced");
    await c.req(`/api/sources/${srcB.id}`, { method: "DELETE" });
    const topic = await json(await c.req(`/api/topics/${a0.src.topic_id}`));
    expect(topic.replacements).toEqual([]);
    expect((await json(await c.req(`/api/cards/${a.id}`))).card.content_state).toBe("active");
  });

  it("整句搜不到时给出能命中的词", async () => {
    const c = fresh();
    await paste(c, "用户：首版不做云同步。");
    const r = await json(await c.req(`/api/search?q=${encodeURIComponent("为什么放弃云同步")}`));
    expect(r.total).toBe(0);
    expect((r.suggestions as Array<{ term: string }>).map((x) => x.term)).toContain("同步");
  });

  it("首次访问只发一套会话", async () => {
    const c = fresh();
    const res = await c.req("/api/session");
    const cookies = res.headers.get("set-cookie") ?? "";
    expect(cookies.match(/xushang_session=/g)?.length).toBe(1);
  });
});
