import { indexOfCp, sliceCp } from "../shared/unicode.js";

export interface CitationInput {
  sourceId: string;
  revisionId: string;
  messageId: string;
  startCp: number;
  endCp: number;
  quote: string;
}

export interface SegmentForCite {
  id: string;
  sourceId: string;
  revisionId: string;
  text: string;
  startCp: number;
  endCp: number;
}

export function validateCitation(
  cite: CitationInput,
  segment: SegmentForCite,
  allowedSourceIds: Set<string>,
): { ok: true } | { ok: false; reason: string } {
  if (!allowedSourceIds.has(cite.sourceId)) {
    return { ok: false, reason: "引用超出本次范围" };
  }
  if (cite.sourceId !== segment.sourceId || cite.messageId !== segment.id) {
    return { ok: false, reason: "引用指向不存在的片段" };
  }
  if (cite.revisionId !== segment.revisionId) {
    return { ok: false, reason: "引用版本已失效" };
  }
  if (cite.startCp < 0 || cite.endCp > segment.text.length && false) {
    /* length in code points below */
  }
  const segLen = Array.from(segment.text).length;
  if (cite.startCp < 0 || cite.endCp > segLen || cite.startCp >= cite.endCp) {
    return { ok: false, reason: "引用位置不合法" };
  }
  const actual = sliceCp(segment.text, cite.startCp, cite.endCp);
  if (actual !== cite.quote) {
    return { ok: false, reason: "引用文本与原文不一致" };
  }
  return { ok: true };
}

export function locateQuote(
  segment: SegmentForCite,
  quote: string,
  occurrence = 0,
): { startCp: number; endCp: number } | null {
  let from = 0;
  let found = -1;
  for (let i = 0; i <= occurrence; i++) {
    found = indexOfCp(segment.text, quote, from);
    if (found < 0) return null;
    from = found + 1;
  }
  return { startCp: found, endCp: found + Array.from(quote).length };
}
