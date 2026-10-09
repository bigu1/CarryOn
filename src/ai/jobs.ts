import { LIMITS } from "../shared/limits.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { locateQuote, validateCitation } from "../domain/citations.js";
import { CARD_TYPES, type CardType } from "../domain/types.js";
import type { Store } from "../storage/db.js";
import {
  ANSWER_SYSTEM,
  EXTRACT_SYSTEM,
  POLISH_SYSTEM,
  PROMPT_TEMPLATE_VERSION,
  chatCompletions,
  chunkMessages,
  type ModelConfig,
} from "./client.js";

export type JobKind = "extract" | "answer" | "polish";

export interface JobRequest {
  sourceIds?: string[];
  topicId?: string;
  question?: string;
  handoffBody?: string;
  previewToken?: string;
}

type Msg = { id: string; source_id: string; role: string; text: string };

/** 一次发送的完整计划。预览和真实发送都只从这里取，保证两者一致。 */
export interface SendPlan {
  kind: JobKind;
  question?: string;
  sourceIds: string[];
  scopeMode: "explicit" | "topic" | "all";
  /** 范围内的全部消息条数 */
  poolCount: number;
  /** 实际会发出的批次；回答和润色最多一批 */
  batches: Msg[][];
  /** 单条超过发送上限、不会截断也不会发送的消息 */
  oversized: Msg[];
  /** 回答：范围内但因预算没有发送的消息条数 */
  leftOut: number;
  /** 回答：有关键词命中时，没命中、因此没发送的消息条数 */
  unmatched: number;
  searched: boolean;
  hitCount: number;
  /** 回答：一并发送的卡片 */
  cards: Array<{ id: string; type: string; state: string; contentState: string; messageIds: string[]; title: string; body: string }>;
  /** 润色：要发送的交接正文 */
  handoffBody?: string;
  handoffOver: boolean;
  /** 实际发送的正文字数（码点） */
  sendChars: number;
}

export function resolveSourceIds(st: Store, body: JobRequest) {
  const explicit = (body.sourceIds ?? []).filter((id) => {
    const s = st.getSource(id);
    return !!(s && !s.deleted_at);
  });
  // 显式空选、失效或已删除 ID 绝不能回退成全库。
  if (body.sourceIds !== undefined) return { sourceIds: [...new Set(explicit)], mode: "explicit" as const };
  const ids = (st.listSources(body.topicId ? { topicId: body.topicId } : undefined) as Array<{ id: string }>).map((s) =>
    String(s.id),
  );
  return { sourceIds: ids, mode: body.topicId ? ("topic" as const) : ("all" as const) };
}

const STOP_CHARS = new Set(Array.from("的了吗呢吧啊么是我你他她它在和与及或就都也还又这那个有没么哪谁吗"));
const STOP_WORDS = new Set(["什么", "为什么", "怎么", "怎样", "是否", "我们", "你们", "当时", "现在", "一下", "后来", "之前", "最后", "如何"]);

/** 自然语言问题拆成本地检索词：英文/数字/代码按整词，中文连续段整段 + 二字组。 */
export function questionTerms(question: string): string[] {
  const terms = new Set<string>();
  const parts = question
    .split(/[\s，。！？、；：,.!?;:()（）「」『』“”"'《》【】\[\]]+/u)
    .map((x) => x.trim())
    .filter(Boolean);
  for (const p of parts) {
    const runs = p.match(/[\p{Script=Han}]+|[^\p{Script=Han}]+/gu) ?? [];
    for (const run of runs) {
      if (/\p{Script=Han}/u.test(run)) {
        let core = run;
        for (const w of STOP_WORDS) core = core.replaceAll(w, " ");
        for (const piece of core.split(" ")) if (Array.from(piece).length >= 2) terms.add(piece);
        const cps = Array.from(run);
        for (let i = 0; i + 1 < cps.length; i++) {
          const bi = cps[i] + cps[i + 1];
          if (STOP_WORDS.has(bi) || STOP_CHARS.has(cps[i]) || STOP_CHARS.has(cps[i + 1])) continue;
          terms.add(bi);
        }
      } else if (run.trim().length >= 2) {
        terms.add(run.trim().toLowerCase());
      }
    }
  }
  return [...terms];
}

function cp(text: string) {
  return Array.from(text).length;
}

function describeMessage(st: Store, m: Msg) {
  const src = st.getSource(m.source_id);
  return { messageId: m.id, source: src ? String(src.title) : "", sourceDate: src?.occurred_at ?? null,
    role: m.role, text: m.text };
}

export function planSend(st: Store, kind: JobKind, body: JobRequest): SendPlan {
  const { sourceIds, mode } = resolveSourceIds(st, body);
  const all = sourceIds.flatMap((sid) => st.listMessages(sid) as unknown as Msg[]);
  const base = {
    kind,
    question: kind === "answer" ? body.question : undefined,
    sourceIds,
    scopeMode: mode,
    poolCount: all.length,
    leftOut: 0,
    unmatched: 0,
    searched: false,
    hitCount: 0,
    cards: [] as SendPlan["cards"],
    handoffOver: false,
  };

  if (kind === "polish") {
    // 润色只发送交接正文本身，不夹带原文
    const text = body.handoffBody ?? "";
    const over = cp(JSON.stringify({ handoffBody: text })) + cp(POLISH_SYSTEM) > LIMITS.modelMaxInputChars;
    const ok = !!text.trim() && !over;
    return {
      ...base,
      sourceIds: [],
      poolCount: 0,
      batches: [],
      oversized: [],
      handoffBody: ok ? text : undefined,
      handoffOver: over,
      sendChars: ok ? cp(text) : 0,
    };
  }

  if (kind === "extract") {
    const { chunks, oversized } = chunkMessages(all, LIMITS.modelMaxInputChars - cp(EXTRACT_SYSTEM) - 100,
      (m) => cp(JSON.stringify(describeMessage(st, m))) + 1);
    return {
      ...base,
      batches: chunks,
      oversized,
      sendChars: chunks.flat().reduce((n, m) => n + cp(m.text), 0),
    };
  }

  // 回答：先带上卡片（已确认的和待审核的分开标），再按关键词相关度挑原文，装满预算为止
  const cardRows = body.topicId
    ? st.listCards({ topicId: body.topicId }).filter((c) => {
        if (Number(c.invalidated) || c.review_state === "rejected") return false;
        if (mode !== "explicit") return true;
        return c.citations.length > 0 && c.citations.every((x) => sourceIds.includes(String(x.source_id)));
      })
    : [];
  const cards: SendPlan["cards"] = [];
  let cardChars = 0;
  const cardBudget = Math.floor(LIMITS.modelMaxInputChars * 0.2);
  for (const c of cardRows) {
    const item = {
      id: String(c.id),
      type: String(c.type),
      state: c.review_state === "confirmed" ? "用户已确认" : "待审核候选",
      contentState: String(c.content_state),
      messageIds: c.citations.map((x) => String(x.message_id)),
      title: String(c.title),
      body: String(c.body),
    };
    const n = cp(JSON.stringify(item)) + 1;
    if (cardChars + n > cardBudget) break;
    cards.push(item);
    cardChars += n;
  }
  const budget = Math.max(0, LIMITS.modelMaxInputChars - cardChars - cp(ANSWER_SYSTEM) - cp(JSON.stringify(body.question ?? "")) - 1500);
  const terms = questionTerms(body.question ?? "");
  let candidates = all;
  let searched = false;
  let hitCount = 0;
  if (terms.length) {
    searched = true;
    const scored = all
      .map((m, order) => {
        const lower = m.text.toLowerCase();
        const score = terms.reduce((n, t) => (lower.includes(t) ? n + cp(t) : n), 0);
        return { m, order, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order);
    hitCount = scored.length;
    if (scored.length) candidates = scored.map((x) => x.m);
  }
  const picked: Msg[] = [];
  const oversized: Msg[] = [];
  let used = 0;
  for (const m of candidates) {
    const n = cp(JSON.stringify(describeMessage(st, m))) + 1;
    if (n > budget) {
      oversized.push(m);
      continue;
    }
    if (used + n > budget) continue;
    picked.push(m);
    used += n;
  }
  // 发出去时按原文顺序排，方便模型理解上下文
  const order = new Map(all.map((m, i) => [m.id, i]));
  picked.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return {
    ...base,
    batches: picked.length ? [picked] : [],
    oversized,
    leftOut: candidates.length - picked.length - oversized.length,
    unmatched: all.length - candidates.length,
    searched,
    hitCount,
    cards,
    sendChars: picked.reduce((n, m) => n + cp(m.text), 0) + cards.reduce((n, c) => n + cp(c.title) + cp(c.body), 0),
  };
}

export function planNote(plan: SendPlan): string | undefined {
  if (plan.kind === "polish") {
    if (plan.handoffOver) return "有超过发送上限的资料，未截断、未发送。交接正文太长，请先删减或改用短版。";
    if (!plan.handoffBody) return "交接正文是空的，没有可发送的内容。";
    return "只发送当前交接正文，不发送原始聊天。";
  }
  if (plan.poolCount === 0) return "范围内没有已导入资料，不是检索后没有证据。";
  if (!plan.batches.length && plan.oversized.length) return "有超过发送上限的资料，未截断、未发送。";
  const parts: string[] = [];
  if (plan.kind === "extract" && plan.batches.length > 1) {
    parts.push(`将分成 ${plan.batches.length} 段依次发送，失败段会单独标明，不会静默截断。`);
  }
  if (plan.kind === "answer") {
    if (plan.searched && plan.hitCount === 0) parts.push("问题里的词在原文中没有直接命中，按范围顺序发送预算内的原文，覆盖可能不足。");
    if (plan.searched && plan.hitCount > 0) parts.push(`按问题里的词挑出 ${plan.hitCount} 段相关原文；其余 ${plan.unmatched} 段没有命中，没有发送。`);
    if (plan.leftOut > 0) parts.push(`另有 ${plan.leftOut} 段相关原文因篇幅上限没有发送，回答只基于已发送部分。`);
  }
  if (plan.oversized.length) parts.push(`${plan.oversized.length} 条单条过长的原文没有发送，也不会被截断。`);
  return parts.length ? parts.join("") : undefined;
}

export function planPreview(st: Store, plan: SendPlan, model: ModelConfig | undefined) {
  const sentIds = new Set(plan.batches.flat().map((m) => m.id));
  const sources = plan.sourceIds
    .map((id) => st.getSource(id))
    .filter((s): s is Record<string, unknown> => !!s && !s.deleted_at)
    .map((s) => {
      const msgs = st.listMessages(String(s.id)) as unknown as Msg[];
      return {
        id: String(s.id),
        title: String(s.title),
        topic: String(s.topic_label),
        bytes: msgs.reduce((n, m) => n + Buffer.byteLength(m.text, "utf8"), 0),
        sendCount: msgs.filter((m) => sentIds.has(m.id)).length,
      };
    });
  const segments = plan.kind === "polish" ? (plan.handoffBody ? 1 : 0) : plan.batches.length;
  const oversizedMessages = plan.kind === "polish" ? (plan.handoffOver ? 1 : 0) : plan.oversized.length;
  return {
    kind: plan.kind,
    previewToken: previewToken(st, plan, model),
    target: model?.baseUrl ?? "尚未配置",
    model: model?.model ?? null,
    scopeMode: plan.scopeMode,
    sources,
    totalBytes: sources.reduce((n, s) => n + s.bytes, 0),
    messageCount: plan.poolCount,
    sendMessageCount: sentIds.size,
    sendCardCount: plan.cards.length,
    sendChars: plan.sendChars,
    segments,
    oversizedMessages,
    leftOut: plan.leftOut,
    unmatched: plan.unmatched,
    searched: plan.searched,
    hitCount: plan.hitCount,
    overLimit: segments > 1 || oversizedMessages > 0 || plan.leftOut > 0,
    note: planNote(plan),
  };
}

/** 预览绑定正文、角色、资料版本、卡片和目标服务，变化后必须重新预览。 */
function previewToken(st: Store, plan: SendPlan, model: ModelConfig | undefined): string {
  return createHash("sha256").update(JSON.stringify({ plan, versions: st.sourceVersions(plan.sourceIds),
    target: model?.baseUrl, model: model?.model })).digest("hex");
}

type JobResult = { status: 200 | 400 | 409 | 502; body: Record<string, unknown> };

/** 执行一次模型任务。一切写库都在版本校验之后；取消或资料变化后迟到的结果丢弃。 */
export async function runJob(opts: {
  st: Store;
  model: ModelConfig;
  kind: JobKind;
  request: JobRequest;
  abort: Map<string, AbortController>;
}): Promise<JobResult> {
  const { st, model, kind, request } = opts;
  if (st.runningJobCount() > 0 || opts.abort.size > 0) {
    return { status: 409, body: { error: "已有整理任务在进行，一次只运行一个" } };
  }
  const plan = planSend(st, kind, request);
  if (request.previewToken && request.previewToken !== previewToken(st, plan, model)) {
    return { status: 409, body: { error: "资料、问题或模型设置已变化，请重新查看发送范围后再发送" } };
  }
  const noSend = kind === "polish" ? !plan.handoffBody : plan.batches.length === 0;
  if (noSend) {
    return {
      status: 400,
      body: {
        error: "没有可发送的分段。不会静默截断。",
        segments: 0,
        oversizedMessages: kind === "polish" ? (plan.handoffOver ? 1 : 0) : plan.oversized.length,
        note: planNote(plan),
      },
    };
  }

  const versions = st.sourceVersions(plan.sourceIds);
  const jobId = st.createJob(kind, { sourceIds: plan.sourceIds, topicId: request.topicId, question: request.question }, versions);
  const ac = new AbortController();
  opts.abort.set(jobId, ac);
  const stale = () => {
    const job = st.getJob(jobId);
    if (!job || job.status === "cancelled") return "任务已取消，结果未写入";
    if (!st.versionsStillMatch(versions)) return "资料已变更或删除，迟到结果已丢弃";
    return null;
  };
  const staleStatus = (msg: string) => (msg.includes("取消") ? 400 : 409) as 400 | 409;
  const system = kind === "extract" ? EXTRACT_SYSTEM : kind === "answer" ? ANSWER_SYSTEM : POLISH_SYSTEM;
  const callModel = async (userContent: string) => {
    const attempt = () =>
      chatCompletions(model, [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ], { signal: ac.signal });
    try {
      return await attempt();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "失败";
      // 重试最多一次，且用户已取消时不重试
      if (!ac.signal.aborted && /超时|限流|错误 5/.test(msg)) return await attempt();
      throw e;
    }
  };
  const describe = (m: Msg) => describeMessage(st, m);

  try {
    if (kind === "extract") {
      const coverage = {
        totalSegments: plan.batches.length + plan.oversized.length,
        processed: 0,
        failed: plan.oversized.length,
        oversized: plan.oversized.length,
        totalChars: plan.sendChars,
      };
      const chunkReports: Array<{ status: string; reason?: string; created?: number }> = plan.oversized.map(() => ({
        status: "failed",
        reason: "单条超过发送上限，未截断、未发送",
      }));
      const createdAll: Array<Record<string, unknown>> = [];
      const fail = (msg: string) => {
        for (const c of createdAll) st.invalidateCard(String(c.id), msg);
        st.finishJob(jobId, "failed", undefined, msg);
        return { status: staleStatus(msg), body: { error: msg, coverage } } as JobResult;
      };
      for (const chunk of plan.batches) {
        const late = stale();
        if (late) return fail(late);
        try {
          const result = await callModel(JSON.stringify({ messages: chunk.map(describe) }));
          const late2 = stale();
          if (late2) return fail(late2);
          let parsed: unknown;
          try {
            parsed = JSON.parse(result.text);
          } catch {
            throw new Error("模型输出无法解析");
          }
          const created = applyExtract(st, parsed, new Set(chunk.map((m) => m.id)), plan.sourceIds, result.model);
          createdAll.push(...created);
          const late3 = stale();
          if (late3) return fail(late3);
          coverage.processed += 1;
          chunkReports.push({ status: "done", created: created.length });
        } catch (e) {
          if (ac.signal.aborted) return fail("任务已取消，结果未写入");
          coverage.failed += 1;
          chunkReports.push({ status: "failed", reason: e instanceof Error ? e.message : "分段失败" });
        }
      }
      if (coverage.processed === 0) {
        st.finishJob(jobId, "failed", { coverage, chunkReports }, "提炼失败，未生成成功卡片");
        return { status: 502, body: { error: "提炼失败，未生成成功卡片", coverage, chunkReports } };
      }
      const partial = coverage.failed > 0;
      st.finishJob(jobId, partial ? "partial" : "done", { created: createdAll.length, coverage, chunkReports });
      return {
        status: 200,
        body: {
          jobId,
          created: createdAll,
          coverage,
          chunkReports,
          status: partial ? "部分完成" : "完成",
          note: partial ? "部分完成，不能据此回答「全部聊天的最终结论」。" : undefined,
          model: model.model,
          promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        },
      };
    }

    if (kind === "polish") {
      const result = await callModel(JSON.stringify({ handoffBody: plan.handoffBody }));
      const late = stale();
      if (late) {
        st.finishJob(jobId, "failed", undefined, late);
        return { status: staleStatus(late), body: { error: late } };
      }
      let parsed: { body?: unknown };
      try {
        parsed = JSON.parse(result.text) as { body?: unknown };
      } catch {
        st.finishJob(jobId, "failed", undefined, "模型输出无法解析");
        return { status: 502, body: { error: "模型输出无法解析，交接正文未改动" } };
      }
      const bodyText = typeof parsed.body === "string" ? parsed.body : "";
      if (!bodyText.trim()) {
        st.finishJob(jobId, "failed", undefined, "润色结果缺少正文");
        return { status: 502, body: { error: "润色结果缺少正文，交接正文未改动" } };
      }
      const lost = lostMarkers(plan.handoffBody ?? "", bodyText);
      st.finishJob(jobId, "done", { chars: cp(bodyText) });
      return {
        status: 200,
        body: {
          jobId,
          body: bodyText,
          model: result.model,
          warnings: lost.length ? [`润色结果丢掉了这些标记，请核对后再用：${lost.join("、")}`] : [],
        },
      };
    }

    // answer
    const sent = plan.batches[0];
    const result = await callModel(
      JSON.stringify({
        question: request.question,
        messages: sent.map(describe),
        cards: plan.cards,
        coverageNote: planNote(plan),
      }),
    );
    const late = stale();
    if (late) {
      st.finishJob(jobId, "failed", undefined, late);
      return { status: staleStatus(late), body: { error: late } };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      st.finishJob(jobId, "failed", undefined, "模型输出无法解析");
      return { status: 502, body: { error: "模型输出无法解析，没有保存回答" } };
    }
    const answer = applyAnswer(st, parsed, request, plan, new Set(sent.map((m) => m.id)));
    if (answer.error !== undefined) {
      st.finishJob(jobId, "failed", undefined, answer.error);
      return { status: 502, body: { error: answer.error } };
    }
    const late2 = stale();
    if (late2) {
      st.db
        .prepare("UPDATE answers SET invalidated=1, body=?, points_json=NULL WHERE id=?")
        .run("（已失效：资料已变更，迟到结果已丢弃）", answer.id);
      st.finishJob(jobId, "failed", undefined, late2);
      return { status: staleStatus(late2), body: { error: late2 } };
    }
    st.finishJob(jobId, "done", { answerId: answer.id });
    return { status: 200, body: { jobId, answer, note: planNote(plan) } };
  } catch (e) {
    const msg = ac.signal.aborted ? "任务已取消，结果未写入" : e instanceof Error ? e.message : "模型调用失败";
    const job = st.getJob(jobId);
    if (job?.status === "running") st.finishJob(jobId, "failed", undefined, msg);
    return { status: ac.signal.aborted ? 400 : 502, body: { error: msg } };
  } finally {
    opts.abort.delete(jobId);
  }
}

const KEEP_MARKERS = [
  "【待审核候选，非正式结论】",
  "【用户备注，不是从聊天提炼的事实】",
  "【已被替代，仅作历史】",
  "【聊天中的说法，未由本产品核验】",
  "## 未解决问题",
  "## 约束",
];

/** 润色前后对比：交接里的风险标记不能被润掉。 */
export function lostMarkers(before: string, after: string): string[] {
  return KEEP_MARKERS.filter((m) => before.includes(m) && !after.includes(m));
}

function applyExtract(
  st: Store,
  parsed: unknown,
  sentIds: Set<string>,
  scopeSourceIds: string[],
  modelName?: string,
) {
  const checked = z.object({ claims: z.array(z.object({ type: z.enum(CARD_TYPES),
    title: z.string().min(1), body: z.string().min(1),
    evidence: z.array(z.object({ messageId: z.string().min(1), quote: z.string().min(1) })).min(1),
  })) }).safeParse(parsed);
  if (!checked.success) throw new Error("模型候选结构无效，未入库");
  const claims = checked.data.claims;
  const allowed = new Set(scopeSourceIds);
  const pending: Parameters<Store["createCards"]>[0] = [];
  for (const raw of claims) {
    const cl = raw as {
      type?: CardType;
      title?: string;
      body?: string;
      evidence?: Array<{ messageId?: string; quote?: string }>;
    };
    if (!cl.type || !CARD_TYPES.includes(cl.type) || cl.type === "user_note" || !cl.title || !cl.body) continue;
    const citations = [];
    for (const ev of cl.evidence ?? []) {
      if (!ev.messageId || !ev.quote) continue;
      if (!sentIds.has(ev.messageId)) throw new Error("引用了本次没有发送的片段，未入库");
      const msg = st.getMessage(ev.messageId);
      if (!msg) throw new Error("引用不存在，未入库");
      const src = st.getSource(String(msg.source_id));
      if (!src || src.deleted_at) throw new Error("引用指向已删除资料，未入库");
      const segment = {
        id: String(msg.id),
        sourceId: String(msg.source_id),
        revisionId: String(msg.revision_id),
        text: String(msg.text),
        startCp: Number(msg.start_cp),
        endCp: Number(msg.end_cp),
      };
      const loc = locateQuote(segment, ev.quote);
      if (!loc) throw new Error("引用错位，未入库");
      if (locateQuote(segment, ev.quote, 1)) throw new Error("摘录在同一段重复出现，无法确定引用位置，未入库；请使用更完整的摘录");
      const cite = {
        sourceId: segment.sourceId,
        revisionId: segment.revisionId,
        messageId: segment.id,
        startCp: loc.startCp,
        endCp: loc.endCp,
        quote: ev.quote,
      };
      const v = validateCitation(cite, segment, allowed);
      if (!v.ok) throw new Error(v.reason + "，未入库");
      citations.push(cite);
    }
    if (!citations.length) throw new Error("事实性候选缺少合法引用，未入库");
    if (cl.type === "user_decision" && !citations.some((x) => st.getMessage(x.messageId)?.role === "user")) {
      throw new Error("用户决定缺少用户采纳的原文，不能把 AI 或工具的说法当决定");
    }
    pending.push({
      topicId: String(st.getSource(citations[0].sourceId)?.topic_id),
      type: cl.type,
      title: cl.title,
      body: cl.body,
      createdVia: "model",
      reviewState: "pending",
      modelName,
      promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
      citations,
    });
  }
  return st.createCards(pending) as Array<Record<string, unknown>>;
}

const POINT_KINDS: Record<string, string> = {
  decision: "已确认的历史决定",
  candidate: "尚未审核的候选",
  ai_suggestion: "AI 当时的建议",
  other: "原文记录",
};

function applyAnswer(
  st: Store,
  parsed: unknown,
  body: JobRequest,
  plan: SendPlan,
  sentIds: Set<string>,
): { error: string } | { id: string; error?: undefined; [k: string]: unknown } {
  const checked = z.object({
    points: z.array(z.object({ text: z.string().min(1), kind: z.string().optional(),
      support: z.array(z.object({ messageId: z.string().min(1), quote: z.string().min(1) })).min(1),
    })).optional(),
    insufficient: z.boolean().optional(), missing: z.string().optional(), conflicts: z.array(z.string()).optional(),
  }).safeParse(parsed);
  if (!checked.success) return { error: "回答结构无效，未保存" };
  const obj = checked.data;
  if (!obj.points && !obj.insufficient) return { error: "回答结构无效，未保存" };
  const points: Array<{
    text: string;
    kind: string;
    kindLabel: string;
    support: Array<{ messageId: string; sourceId: string; sourceTitle: string; sourceDate: string | null; role: string; quote: string; startCp: number; endCp: number }>;
  }> = [];
  for (const p of obj.points ?? []) {
    if (!p.text) continue;
    const support: (typeof points)[number]["support"] = [];
    for (const s of p.support ?? []) {
      if (!s.messageId || !s.quote) return { error: "要点缺少引用，未保存" };
      const msg = st.getMessage(s.messageId);
      if (!msg) return { error: "回答引用不存在，未保存" };
      if (!sentIds.has(s.messageId)) return { error: "回答引用越范围，未保存" };
      const segment = { id: String(msg.id), sourceId: String(msg.source_id), revisionId: String(msg.revision_id),
        text: String(msg.text), startCp: Number(msg.start_cp), endCp: Number(msg.end_cp) };
      const loc = locateQuote(segment, s.quote);
      if (!loc) return { error: "回答引用与原文不一致，未保存" };
      if (locateQuote(segment, s.quote, 1)) return { error: "回答摘录在同一段重复出现，无法确定位置，未保存；请使用更完整的摘录" };
      const src = st.getSource(String(msg.source_id));
      support.push({
        messageId: s.messageId,
        sourceId: String(msg.source_id),
        sourceTitle: String(src?.title ?? ""),
        sourceDate: (src?.occurred_at as string | null) ?? null,
        role: String(msg.role),
        quote: s.quote,
        startCp: loc.startCp,
        endCp: loc.endCp,
      });
    }
    if (!support.length) return { error: "事实性要点没有来源，未保存" };
    let kind = p.kind && p.kind in POINT_KINDS ? p.kind : "other";
    if (kind === "decision" && !plan.cards.some((c) => c.type === "user_decision" &&
      c.state === "用户已确认" && c.contentState === "active" && support.some((s) => c.messageIds.includes(s.messageId)))) {
      kind = support.every((s) => s.role === "assistant") ? "ai_suggestion" : "other";
    }
    points.push({ text: p.text, kind, kindLabel: POINT_KINDS[kind], support });
  }
  if (!points.length && !obj.insufficient) return { error: "回答结构无效，未保存" };
  const conflicts = (obj.conflicts ?? []).filter((x) => typeof x === "string" && x.trim());
  const lines = points.map(
    (p, i) => `${i + 1}. 【${p.kindLabel}】${p.text}（来源：${p.support.map((s) => `${s.sourceTitle}「${s.quote}」`).join("；")}）`,
  );
  if (conflicts.length) lines.push("并列冲突：", ...conflicts.map((x) => `- ${x}`));
  if (obj.insufficient) lines.push(`当前材料不足以完整回答。${obj.missing ?? ""}`);
  const note = planNote(plan);
  if (note) lines.push(`范围说明：${note}`);
  return st.saveAnswer({
    topicId: body.topicId || null,
    question: body.question ?? "",
    body: lines.join("\n"),
    points: { points, conflicts, insufficient: !!obj.insufficient, missing: obj.missing ?? null, note: note ?? null },
    scope: { sourceIds: plan.sourceIds, topicId: body.topicId, sentMessageIds: [...sentIds] },
  }) as { id: string; [k: string]: unknown };
}
