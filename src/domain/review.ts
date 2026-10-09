import type { CardType, ContentState, ReviewState } from "./types.js";
import { CARD_TYPES, CONTENT_STATES, REVIEW_STATES } from "./types.js";

/** 审核时需要知道的卡片现状（来自库）。 */
export interface ReviewSubject {
  type: string;
  title: string;
  body: string;
  review_state: string;
  invalidated: number;
  is_user_note: number;
}

export interface CitationHealth {
  /** 引用仍指向当前版本、未删除来源的数量 */
  live: number;
  /** 引用指向旧修订的数量 */
  historical: number;
  /** 引用指向已删除来源的数量 */
  dead: number;
  user?: number;
}

export interface ReviewPatch {
  title?: string;
  body?: string;
  type?: CardType;
  reviewState?: ReviewState;
  contentState?: ContentState;
  /** 用户明确知道引用来自旧修订，仍按历史记录确认 */
  acknowledgeHistorical?: boolean;
}

export type ReviewDecision =
  | { ok: true; clearInvalidation: boolean; isUserNote: boolean }
  | { ok: false; reason: string; code: "bad_input" | "needs_body" | "no_live_source" | "historical" };

/**
 * 卡片修改与审核的唯一规则入口。HTTP 层和存储层都不再各自判断。
 *
 * - 失效卡（来源删除 / 修订 / 说话人更正）不能被「确认」悄悄变回有效，除非：
 *   正文非空、至少有一处仍有效的引用（或改成用户备注），引用旧修订时用户明确知情。
 * - 确认成功会清掉失效标记；拒绝不清，失效原因保留。
 */
export function decideReview(card: ReviewSubject, patch: ReviewPatch, cites: CitationHealth): ReviewDecision {
  if (patch.type !== undefined && !CARD_TYPES.includes(patch.type)) {
    return { ok: false, code: "bad_input", reason: "未知卡片类型" };
  }
  if (patch.reviewState !== undefined && !REVIEW_STATES.includes(patch.reviewState)) {
    return { ok: false, code: "bad_input", reason: "未知审核状态" };
  }
  if (patch.contentState !== undefined && !CONTENT_STATES.includes(patch.contentState)) {
    return { ok: false, code: "bad_input", reason: "未知内容状态" };
  }
  const nextType = patch.type ?? (card.type as CardType);
  const isUserNote = nextType === "user_note";
  const nextTitle = (patch.title ?? card.title).trim();
  const nextBody = (patch.body ?? card.body).trim();
  if (patch.title !== undefined && !nextTitle) {
    return { ok: false, code: "bad_input", reason: "标题不能为空" };
  }

  if ((patch.reviewState ?? card.review_state) !== "confirmed") {
    return { ok: true, clearInvalidation: false, isUserNote };
  }

  if (!nextBody) {
    return {
      ok: false,
      code: "needs_body",
      reason: "这张卡的正文已被清除（来源删除或修订）。请先按现有原文重写正文，再确认。",
    };
  }
  if (!isUserNote && cites.live + cites.historical === 0) {
    return {
      ok: false,
      code: "no_live_source",
      reason: "这张卡引用的原文都已删除。可以改成「用户备注」保存，或从现有原文重新建卡。",
    };
  }
  if (nextType === "user_decision" && cites.user === 0) {
    return { ok: false, code: "bad_input", reason: "用户决定需要用户采纳的原文；请改为 AI 建议、待澄清或用户备注" };
  }
  if (!isUserNote && cites.live === 0 && cites.historical > 0 && !patch.acknowledgeHistorical) {
    return {
      ok: false,
      code: "historical",
      reason: "这张卡只引用了旧版本原文，不是当前内容。请对照旧版本后勾选「按历史记录确认」，或从当前原文重新建卡。",
    };
  }
  return { ok: true, clearInvalidation: card.invalidated === 1, isUserNote };
}
