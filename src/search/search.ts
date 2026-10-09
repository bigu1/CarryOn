import type { DatabaseSync } from "node:sqlite";

/**
 * 本地检索：参数化 LIKE 子串匹配。
 * 选它而不是 FTS5 trigram：中文 1–2 字查询必须命中，trigram 对少于 3 个字符不匹配；
 * 单人本机 2 万条规模下子串扫描足够（见 scripts/perf-20k.ts）。
 */

/** 用户输入的 % _ \ 按字面匹配，不扩大 LIKE 通配。 */
export function literalLikePattern(query: string): string {
  return query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export function prepareQuery(q: string): string {
  return q.trim();
}

/** 命中处前后各取一段，长消息不整段返回给列表。按码点切，不切坏 emoji。 */
export function snippetAround(text: string, q: string, radius = 70): string {
  const cps = Array.from(text);
  if (!q) return cps.length > radius * 2 ? cps.slice(0, radius * 2).join("") + "…" : text;
  const lower = text.toLowerCase();
  const at = lower.indexOf(q.toLowerCase());
  if (at < 0) return cps.length > radius * 2 ? cps.slice(0, radius * 2).join("") + "…" : text;
  const startCp = Array.from(text.slice(0, at)).length;
  const qLen = Array.from(q).length;
  const from = Math.max(0, startCp - radius);
  const to = Math.min(cps.length, startCp + qLen + radius);
  return (from > 0 ? "…" : "") + cps.slice(from, to).join("") + (to < cps.length ? "…" : "");
}

export interface SearchOptions {
  q: string;
  topicId?: string;
  role?: string;
  dateFrom?: string;
  dateTo?: string;
  includeUnknownDate?: boolean;
  page?: number;
  pageSize?: number;
}

type SqlVal = string | number | null;

export function searchMessages(db: DatabaseSync, opts: SearchOptions) {
  const q = prepareQuery(opts.q);
  const page = Math.max(1, Math.floor(Number.isFinite(opts.page) ? Number(opts.page) : 1));
  const pageSize = Math.min(50, Math.max(1, Math.floor(Number.isFinite(opts.pageSize) ? Number(opts.pageSize) : 20)));
  const args: SqlVal[] = [];
  const where = ["s.deleted_at IS NULL", "m.revision_id = s.current_revision_id"];
  if (q) {
    // LIKE 对 ASCII 大小写不敏感，中文按字面匹配
    where.push("m.text LIKE ? ESCAPE '\\'");
    args.push(`%${literalLikePattern(q)}%`);
  }
  if (opts.topicId) {
    where.push("s.topic_id = ?");
    args.push(opts.topicId);
  }
  if (opts.role) {
    where.push("m.role = ?");
    args.push(opts.role);
  }
  if (opts.dateFrom || opts.dateTo) {
    const range: string[] = [];
    if (opts.dateFrom) {
      range.push("s.occurred_at >= ?");
      args.push(opts.dateFrom);
    }
    if (opts.dateTo) {
      // 日期精度到天时，止日当天的带时刻记录也算在内
      range.push("s.occurred_at <= ?");
      args.push(`${opts.dateTo}\uffff`);
    }
    const inRange = `(s.occurred_at IS NOT NULL AND ${range.join(" AND ")})`;
    where.push(opts.includeUnknownDate ? `(s.occurred_at IS NULL OR ${inRange})` : inRange);
  }
  const sqlWhere = where.join(" AND ");
  const count = db
    .prepare(`SELECT COUNT(*) AS n FROM messages m JOIN sources s ON s.id=m.source_id WHERE ${sqlWhere}`)
    .get(...args) as { n: number };
  const rows = db
    .prepare(
      `SELECT m.*, s.title AS source_title, s.topic_id, t.label AS topic_label,
              s.occurred_at AS source_occurred_at, s.imported_at
         FROM messages m
         JOIN sources s ON s.id=m.source_id
         JOIN topics t ON t.id=s.topic_id
        WHERE ${sqlWhere}
        ORDER BY COALESCE(s.occurred_at, '0000'), s.id, m.seq
        LIMIT ? OFFSET ?`,
    )
    .all(...args, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;
  return {
    total: count.n,
    page,
    pageSize,
    rows: rows.map((r) => ({ ...r, snippet: snippetAround(String(r.text), q) })),
  };
}

/** 卡片也能被找到：标题或正文命中，排除失效和已拒绝。 */
export function searchCards(db: DatabaseSync, opts: { q: string; topicId?: string; limit?: number }) {
  const q = prepareQuery(opts.q);
  if (!q) return [];
  const args: SqlVal[] = [`%${literalLikePattern(q)}%`, `%${literalLikePattern(q)}%`];
  let sql = `SELECT c.id, c.topic_id, c.type, c.title, c.body, c.review_state, c.content_state, c.is_user_note,
                    t.label AS topic_label
               FROM cards c JOIN topics t ON t.id=c.topic_id
              WHERE c.invalidated=0 AND c.review_state != 'rejected'
                AND (c.title LIKE ? ESCAPE '\\' OR c.body LIKE ? ESCAPE '\\')`;
  if (opts.topicId) {
    sql += " AND c.topic_id = ?";
    args.push(opts.topicId);
  }
  sql += " ORDER BY CASE c.review_state WHEN 'confirmed' THEN 0 ELSE 1 END, c.updated_at DESC LIMIT ?";
  args.push(opts.limit ?? 20);
  return db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
}
