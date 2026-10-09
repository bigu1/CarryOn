import type { CardType, ContentState, ReviewState } from "./types.js";

export function defaultContentState(type: CardType): ContentState {
  if (type === "open_question" || type === "needs_clarification") return "unresolved";
  if (type === "reported_result") return "reported_unverified";
  if (type === "user_note") return "active";
  return "active";
}

export function isDecisionType(type: CardType): boolean {
  return type === "user_decision" || type === "constraint";
}

export function reviewAllowsHandoffDefault(review: ReviewState): boolean {
  return review === "confirmed";
}

export const FACTUAL_TYPES: CardType[] = [
  "goal",
  "user_decision",
  "ai_suggestion",
  "open_question",
  "constraint",
  "attempt",
  "needs_clarification",
  "reported_result",
  "hypothesis",
  "tentative_plan",
  "tool_report",
];
