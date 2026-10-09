import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import { id, nowIso } from "../shared/ids.js";
import { sha256 } from "../shared/hash.js";
import { searchCards, searchMessages, type SearchOptions } from "../search/search.js";
import { defaultContentState } from "../domain/cards.js";
import { decideReview, type CitationHealth, type ReviewPatch } from "../domain/review.js";
import type { HandoffCard, HandoffSource } from "../domain/handoff.js";
import type {
  CardType,
  ContentState,
  LibraryId,
  PreviewConversation,
  ReviewState,
  Role,
} from "../domain/types.js";
import type { CitationInput } from "../domain/citations.js";

type SqlVal = string | number | bigint | null | Uint8Array;
type Row = Record<string, SqlVal>;

export type CardRow = Row & {
  id: string;
  topic_id: string;
  type: string;
  title: string;
  body: string;
  review_state: string;
  content_state: string;
  invalidated: number;
  citations: Row[];
};

export interface OpenOptions {
  path: string;
}

/** 备份只导出这些表和列。不含 analysis_jobs、schema_meta、模型凭据或机器路径。 */
export const BACKUP_TABLE_COLUMNS: Record<string, readonly string[]> = {
  topics: ["id", "label", "created_at"],
  sources: [
    "id",
    "external_id",
    "title",
    "source_type",
    "topic_id",
    "imported_at",
    "occurred_at",
    "occurred_at_precision",
    "occurred_at_trust",
    "content_hash",
    "current_revision_id",
    "deleted_at",
  ],
  source_revisions: ["id", "source_id", "version", "content_hash", "created_at"],
  messages: [
    "id",
    "source_id",
    "revision_id",
    "external_id",
    "original_label",
    "role",
    "text",
    "seq",
    "occurred_at",
    "start_cp",
    "end_cp",
  ],
  cards: [
    "id",
    "topic_id",
    "type",
    "title",
    "body",
    "review_state",
    "content_state",
    "applicable_at",
    "created_via",
    "model_name",
    "prompt_template_version",
    "is_user_note",
    "invalidated",
    "invalidated_reason",
    "created_at",
    "updated_at",
  ],
  citations: ["id", "card_id", "source_id", "revision_id", "message_id", "start_cp", "end_cp", "quote"],
  card_revisions: ["id", "card_id", "at", "snapshot_json"],
  replacements: ["id", "old_card_id", "new_card_id", "confirmed", "created_at"],
  answers: ["id", "topic_id", "question", "body", "points_json", "scope_json", "created_at", "invalidated"],
  handoffs: [
    "id",
    "topic_id",
    "goal",
    "variant",
    "body",
    "included_card_ids",
    "included_source_ids",
    "excluded_json",
    "created_at",
    "invalidated",
  ],
  audit_events: ["id", "type", "at", "anon_ids"],
};

function parseIdList(raw: unknown): string[] {
  if (raw == null || raw === "") return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function scrubRevisionSnapshot(raw: string, deletedSourceIds: Set<string>): string {
  try {
    const snap = JSON.parse(raw) as Record<string, unknown>;
    const cites = Array.isArray(snap.citations) ? (snap.citations as Array<Record<string, unknown>>) : [];
    const hit = cites.some((c) => deletedSourceIds.has(String(c.source_id)));
    if (!hit && !deletedSourceIds.has(String(snap.source_id ?? ""))) return raw;
    snap.body = "";
    snap.title = DELETED_CARD_TITLE;
    snap.citations = cites.map((c) =>
      deletedSourceIds.has(String(c.source_id)) ? { ...c, quote: "", source_title: "" } : c,
    );
    return JSON.stringify(snap);
  } catch {
    return "";
  }
}

export const DELETED_SOURCE_TITLE = "（已删除的资料）";
export const DELETED_CARD_TITLE = "（来源已删除，内容已清除）";

export class ReviewError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(opts: OpenOptions) {
    this.path = opts.path;
    if (opts.path !== ":memory:") mkdirSync(dirname(opts.path), { recursive: true });
    this.db = new DatabaseSync(opts.path);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA_SQL);
    const row = this.db.prepare("SELECT version FROM schema_meta LIMIT 1").get() as
      | { version: number }
      | undefined;
    if (!row) {
      this.db.prepare("INSERT INTO schema_meta(version) VALUES (?)").run(SCHEMA_VERSION);
    }
    this.ensureColumn("handoffs", "included_source_ids", "TEXT");
    this.ensureColumn("answers", "points_json", "TEXT");
    // 上次进程中断时仍在「运行」的任务不会再有结果，标为中断，避免永久占住「一次一个任务」的名额
    this.db
      .prepare("UPDATE analysis_jobs SET status='failed', error=?, updated_at=? WHERE status='running'")
      .run("服务重启，任务中断，结果未写入", nowIso());
  }

  private ensureColumn(table: string, column: string, type: string) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  close(): void {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  findTopicByLabel(label: string): { id: string; label: string } | undefined {
    return this.db.prepare("SELECT id, label FROM topics WHERE label = ?").get(label) as
      | { id: string; label: string }
      | undefined;
  }

  ensureTopic(label: string): { id: string; label: string } {
    const existing = this.findTopicByLabel(label);
    if (existing) return existing;
    const row = { id: id(), label, created_at: nowIso() };
    this.db
      .prepare("INSERT INTO topics(id, label, created_at) VALUES (?, ?, ?)")
      .run(row.id, row.label, row.created_at);
    return { id: row.id, label: row.label };
  }

  listTopics() {
    return this.db
      .prepare(
        `SELECT t.id, t.label, t.created_at,
          (SELECT COUNT(*) FROM sources s WHERE s.topic_id = t.id AND s.deleted_at IS NULL) AS source_count,
          (SELECT COUNT(*) FROM cards c WHERE c.topic_id = t.id AND c.review_state = 'pending') AS pending_count,
          (SELECT COUNT(*) FROM cards c WHERE c.topic_id = t.id AND c.review_state = 'confirmed' AND c.invalidated = 0) AS confirmed_count,
          (SELECT COUNT(*) FROM cards c WHERE c.topic_id = t.id AND c.invalidated = 0 AND c.review_state != 'rejected'
              AND c.type IN ('open_question','needs_clarification') AND c.content_state NOT IN ('user_resolved','replaced')) AS open_count,
          (SELECT MAX(s.occurred_at) FROM sources s WHERE s.topic_id = t.id AND s.deleted_at IS NULL) AS latest_occurred_at,
          (SELECT MAX(s.imported_at) FROM sources s WHERE s.topic_id = t.id AND s.deleted_at IS NULL) AS latest_imported_at
         FROM topics t
         ORDER BY COALESCE((SELECT MAX(c.updated_at) FROM cards c WHERE c.topic_id = t.id), '') DESC,
                  COALESCE((SELECT MAX(s.imported_at) FROM sources s WHERE s.topic_id = t.id), t.created_at) DESC`,
      )
      .all();
  }

  getTopic(topicId: string) {
    return this.db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId);
  }

  findActiveByHash(hash: string) {
    return this.db
      .prepare("SELECT * FROM sources WHERE content_hash = ? AND deleted_at IS NULL")
      .get(hash) as Record<string, unknown> | undefined;
  }

  findActiveByExternal(externalId: string) {
    return this.db
      .prepare("SELECT * FROM sources WHERE external_id = ? AND deleted_at IS NULL")
      .get(externalId) as Record<string, unknown> | undefined;
  }

  importConfirmed(item: PreviewConversation, corrections?: Partial<PreviewConversation>) {
    const merged = { ...item, ...corrections, messages: corrections?.messages ?? item.messages };
    return this.tx(() => {
      const topic = this.ensureTopic(merged.topicLabel);
      if (merged.externalId) {
        const prev = this.findActiveByExternal(merged.externalId);
        if (prev && prev.content_hash !== merged.contentHash) {
          return this.reviseSource(String(prev.id), merged, topic.id);
        }
      }
      const dup = this.findActiveByHash(merged.contentHash);
      if (dup) {
        return { status: "duplicate" as const, sourceId: String(dup.id) };
      }
      return { status: "created" as const, sourceId: this.insertSource(merged, topic.id) };
    });
  }

  private insertSource(item: PreviewConversation, topicId: string): string {
    const sourceId = id();
    const revisionId = id();
    const importedAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO sources(id, external_id, title, source_type, topic_id, imported_at, occurred_at,
          occurred_at_precision, occurred_at_trust, content_hash, current_revision_id, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        sourceId,
        item.externalId ?? null,
        item.title,
        item.sourceType,
        topicId,
        importedAt,
        item.occurredAt,
        item.occurredAtPrecision,
        item.occurredAt ? "material" : "unknown",
        item.contentHash,
        revisionId,
      );
    this.insertRevision(sourceId, revisionId, 1, item);
    return sourceId;
  }

  private reviseSource(sourceId: string, item: PreviewConversation, topicId: string) {
    const ver = this.db
      .prepare("SELECT COALESCE(MAX(version),0) AS v FROM source_revisions WHERE source_id = ?")
      .get(sourceId) as { v: number };
    const revisionId = id();
    this.insertRevision(sourceId, revisionId, ver.v + 1, item);
    this.db
      .prepare(
        `UPDATE sources SET title=?, topic_id=?, occurred_at=?, occurred_at_precision=?,
          occurred_at_trust=?, content_hash=?, current_revision_id=? WHERE id=?`,
      )
      .run(
        item.title,
        topicId,
        item.occurredAt,
        item.occurredAtPrecision,
        item.occurredAt ? "material" : "unknown",
        item.contentHash,
        revisionId,
        sourceId,
      );
    this.reopenCardsForRevision(sourceId);
    return { status: "revised" as const, sourceId, revisionId };
  }

  /**
   * 替代关系的任一端失效（来源删除、修订、说话人更正）后，这条替代不再成立：
   * 删掉关系，被替代的旧卡恢复为「记录中有效」，由用户重新判断。
   */
  private dropBrokenReplacements() {
    const broken = this.db
      .prepare(
        `SELECT r.id, r.old_card_id FROM replacements r
           JOIN cards o ON o.id = r.old_card_id JOIN cards n ON n.id = r.new_card_id
          WHERE o.invalidated = 1 OR n.invalidated = 1`,
      )
      .all() as Array<{ id: string; old_card_id: string }>;
    for (const r of broken) {
      this.db.prepare("DELETE FROM replacements WHERE id=?").run(r.id);
      const still = this.db.prepare("SELECT COUNT(*) AS n FROM replacements WHERE old_card_id=?").get(r.old_card_id) as { n: number };
      if (still.n === 0) {
        this.db
          .prepare("UPDATE cards SET content_state='active', updated_at=? WHERE id=? AND content_state='replaced'")
          .run(nowIso(), r.old_card_id);
      }
    }
  }

  /** 修订不涉及隐私，保留正文，送回待审核并说明原因；不会无提示地继续当当前事实。 */
  private reopenCardsForRevision(sourceId: string) {
    const cards = this.db
      .prepare("SELECT DISTINCT card_id FROM citations WHERE source_id=?")
      .all(sourceId) as { card_id: string }[];
    const at = nowIso();
    for (const c of cards) {
      this.db
        .prepare(
          `UPDATE cards SET invalidated=1, review_state=CASE WHEN review_state='rejected' THEN 'rejected' ELSE 'pending' END,
             invalidated_reason=?, updated_at=? WHERE id=?`,
        )
        .run("资料有了新版本，这张卡引用的是旧版本，需要对照新原文重新核对", at, c.card_id);
      this.addCardRevision(c.card_id);
    }
    this.dropBrokenReplacements();
  }

  private insertRevision(
    sourceId: string,
    revisionId: string,
    version: number,
    item: PreviewConversation,
  ) {
    this.db
      .prepare(
        "INSERT INTO source_revisions(id, source_id, version, content_hash, created_at) VALUES (?,?,?,?,?)",
      )
      .run(revisionId, sourceId, version, item.contentHash, nowIso());
    let cp = 0;
    for (const m of item.messages) {
      const len = Array.from(m.text).length;
      this.db
        .prepare(
          `INSERT INTO messages(id, source_id, revision_id, external_id, original_label, role, text, seq, occurred_at, start_cp, end_cp)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id(),
          sourceId,
          revisionId,
          m.externalId ?? null,
          m.originalLabel,
          m.role,
          m.text,
          m.seq,
          m.occurredAt,
          cp,
          cp + len,
        );
      cp += len + 1;
    }
  }

  updateSourceMeta(
    sourceId: string,
    patch: {
      title?: string;
      topicLabel?: string;
      occurredAt?: string | null;
      occurredAtPrecision?: string;
      messages?: Array<{ id: string; role: Role }>;
    },
  ) {
    this.tx(() => {
      const src = this.getSource(sourceId);
      if (!src || src.deleted_at) throw new Error("资料不存在");
      let topicId = String(src.topic_id);
      if (patch.topicLabel?.trim()) topicId = this.ensureTopic(patch.topicLabel.trim()).id;
      if (topicId !== String(src.topic_id)) {
        // 只引用这份资料的卡跟着资料换主题；同时引用别的资料的卡留在原主题
        this.db
          .prepare(
            `UPDATE cards SET topic_id=?, updated_at=? WHERE id IN (
               SELECT card_id FROM citations GROUP BY card_id
               HAVING SUM(CASE WHEN source_id=? THEN 1 ELSE 0 END) = COUNT(*))`,
          )
          .run(topicId, nowIso(), sourceId);
      }
      const occurredAt = (patch.occurredAt === undefined ? src.occurred_at : patch.occurredAt) as SqlVal;
      const precision =
        patch.occurredAtPrecision ??
        (occurredAt ? String(src.occurred_at_precision) : "unknown");
      this.db
        .prepare(
          `UPDATE sources SET title=?, topic_id=?, occurred_at=?, occurred_at_precision=?, occurred_at_trust=? WHERE id=?`,
        )
        .run(
          patch.title ?? String(src.title),
          topicId,
          occurredAt,
          precision,
          occurredAt ? "user_confirmed" : "unknown",
          sourceId,
        );
      if (patch.messages) {
        for (const m of patch.messages) {
          const cur = this.db
            .prepare("SELECT id, role FROM messages WHERE id=? AND source_id=?")
            .get(m.id, sourceId) as { id: string; role: string } | undefined;
          if (!cur) {
            throw new Error("要更正的消息不存在，校正未保存。说话人更正没有写回。");
          }
          if (cur.role === m.role) continue;
          this.db.prepare("UPDATE messages SET role=? WHERE id=? AND source_id=?").run(m.role, m.id, sourceId);
          this.reopenCardsAfterRoleChange(cur.id, cur.role, m.role);
        }
      }
    });
  }

  private reopenCardsAfterRoleChange(messageId: string, oldRole: string, newRole: string) {
    const reason = `说话人已从「${oldRole}」更正为「${newRole}」，原结论需重新审核，不能再当作已确认用户决定`;
    const cards = this.db
      .prepare(
        `SELECT DISTINCT c.id, c.type, c.review_state FROM cards c
         JOIN citations x ON x.card_id = c.id
         WHERE x.message_id=? AND c.invalidated=0`,
      )
      .all(messageId) as { id: string; type: string; review_state: string }[];
    const at = nowIso();
    for (const card of cards) {
      if (card.type === "user_decision") {
        this.db
          .prepare(
            "UPDATE cards SET invalidated=1, review_state='pending', invalidated_reason=?, updated_at=? WHERE id=?",
          )
          .run(reason, at, card.id);
      } else {
        this.db
          .prepare("UPDATE cards SET review_state='pending', invalidated_reason=?, updated_at=? WHERE id=?")
          .run(reason, at, card.id);
      }
      this.addCardRevision(card.id);
    }
    this.dropBrokenReplacements();
  }

  listSources(opts?: { topicId?: string; includeDeleted?: boolean }) {
    let sql = `SELECT s.*, t.label AS topic_label,
      (SELECT COUNT(*) FROM messages m WHERE m.revision_id = s.current_revision_id) AS message_count
      FROM sources s JOIN topics t ON t.id = s.topic_id`;
    const args: string[] = [];
    const where: string[] = [];
    if (!opts?.includeDeleted) where.push("s.deleted_at IS NULL");
    if (opts?.topicId) {
      where.push("s.topic_id = ?");
      args.push(opts.topicId);
    }
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY s.imported_at DESC";
    return this.db.prepare(sql).all(...args);
  }

  getSource(sourceId: string) {
    return this.db
      .prepare(
        `SELECT s.*, t.label AS topic_label FROM sources s JOIN topics t ON t.id = s.topic_id WHERE s.id=?`,
      )
      .get(sourceId) as Record<string, unknown> | undefined;
  }

  listMessages(sourceId: string, revisionId?: string) {
    const src = this.getSource(sourceId);
    if (!src) return [];
    const rev = revisionId ?? String(src.current_revision_id);
    return this.db
      .prepare("SELECT * FROM messages WHERE source_id=? AND revision_id=? ORDER BY seq")
      .all(sourceId, rev);
  }

  getMessage(messageId: string) {
    return this.db.prepare("SELECT * FROM messages WHERE id=?").get(messageId) as
      | Record<string, unknown>
      | undefined;
  }

  search(opts: SearchOptions) {
    return searchMessages(this.db, opts);
  }

  searchCards(opts: { q: string; topicId?: string; limit?: number }) {
    return searchCards(this.db, opts);
  }

  createCard(input: {
    topicId: string;
    type: CardType;
    title: string;
    body: string;
    reviewState?: ReviewState;
    contentState?: ContentState;
    applicableAt?: string | null;
    createdVia: "manual" | "model";
    isUserNote?: boolean;
    modelName?: string;
    promptTemplateVersion?: string;
    citations?: CitationInput[];
  }) {
    return this.createCards([input])[0];
  }

  createCards(
    inputs: Array<{
      topicId: string;
      type: CardType;
      title: string;
      body: string;
      reviewState?: ReviewState;
      contentState?: ContentState;
      applicableAt?: string | null;
      createdVia: "manual" | "model";
      isUserNote?: boolean;
      modelName?: string;
      promptTemplateVersion?: string;
      citations?: CitationInput[];
    }>,
  ) {
    const ids: string[] = [];
    this.tx(() => {
      for (const input of inputs) {
        ids.push(this.insertCardRow(input));
      }
    });
    return ids.map((cardId) => this.getCard(cardId)!);
  }

  private insertCardRow(input: {
    topicId: string;
    type: CardType;
    title: string;
    body: string;
    reviewState?: ReviewState;
    contentState?: ContentState;
    applicableAt?: string | null;
    createdVia: "manual" | "model";
    isUserNote?: boolean;
    modelName?: string;
    promptTemplateVersion?: string;
    citations?: CitationInput[];
  }): string {
    const pendingSame = this.db
      .prepare(
        `SELECT id FROM cards WHERE topic_id=? AND type=? AND title=? AND body=? AND review_state='pending' AND invalidated=0 LIMIT 1`,
      )
      .get(input.topicId, input.type, input.title, input.body) as { id: string } | undefined;
    if (pendingSame && input.createdVia === "model") {
      return pendingSame.id;
    }
    const historical = this.hasHistoricalCitations(input.citations ?? []);
    const cardId = id();
    const at = nowIso();
    const reviewState = historical
      ? "pending"
      : (input.reviewState ?? (input.createdVia === "model" ? "pending" : "confirmed"));
    this.db
      .prepare(
        `INSERT INTO cards(id, topic_id, type, title, body, review_state, content_state, applicable_at,
            created_via, model_name, prompt_template_version, is_user_note, invalidated, invalidated_reason, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`,
      )
      .run(
        cardId,
        input.topicId,
        input.type,
        input.title,
        input.body,
        reviewState,
        input.contentState ?? defaultContentState(input.type),
        input.applicableAt ?? null,
        input.createdVia,
        input.modelName ?? null,
        input.promptTemplateVersion ?? null,
        input.isUserNote ? 1 : 0,
        historical ? "引用的是历史版本，不是当前原文；不能当作当前已确认事实" : null,
        at,
        at,
      );
    for (const c of input.citations ?? []) {
      this.db
        .prepare(
          `INSERT INTO citations(id, card_id, source_id, revision_id, message_id, start_cp, end_cp, quote)
             VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(id(), cardId, c.sourceId, c.revisionId, c.messageId, c.startCp, c.endCp, c.quote);
    }
    this.addCardRevision(cardId);
    return cardId;
  }

  citationIsHistorical(messageId: string): boolean {
    const msg = this.getMessage(messageId);
    if (!msg) return false;
    const src = this.getSource(String(msg.source_id));
    if (!src || src.deleted_at) return false;
    return String(msg.revision_id) !== String(src.current_revision_id);
  }

  private hasHistoricalCitations(citations: CitationInput[]) {
    return citations.some((c) => {
      const src = this.getSource(c.sourceId);
      if (!src || src.deleted_at) return false;
      return String(c.revisionId) !== String(src.current_revision_id);
    });
  }

  invalidateCard(cardId: string, reason: string) {
    this.db
      .prepare("UPDATE cards SET invalidated=1, body='', invalidated_reason=?, updated_at=? WHERE id=?")
      .run(reason, nowIso(), cardId);
  }

  addCardRevision(cardId: string) {
    // 快照只存卡片本身和原始引用，不带联表得来的来源标题，删除时才能擦干净
    const row = this.db.prepare("SELECT * FROM cards WHERE id=?").get(cardId) as Row | undefined;
    const card = row && { ...row, citations: this.db.prepare("SELECT * FROM citations WHERE card_id=?").all(cardId) };
    this.db
      .prepare("INSERT INTO card_revisions(id, card_id, at, snapshot_json) VALUES (?,?,?,?)")
      .run(id(), cardId, nowIso(), JSON.stringify(card));
  }

  /** 引用连同来源标题与状态：当前 / 旧版本 / 已删除，界面据此提示。 */
  private citationsFor(cardId: string): Row[] {
    return this.db
      .prepare(
        `SELECT x.*, s.title AS source_title, s.occurred_at AS source_occurred_at, m.role AS message_role,
                CASE WHEN s.id IS NULL OR s.deleted_at IS NOT NULL THEN 'deleted'
                     WHEN x.revision_id != s.current_revision_id THEN 'historical'
                     ELSE 'current' END AS status
           FROM citations x LEFT JOIN sources s ON s.id = x.source_id LEFT JOIN messages m ON m.id = x.message_id
          WHERE x.card_id=? ORDER BY x.rowid`,
      )
      .all(cardId) as Row[];
  }

  citationHealth(cardId: string): CitationHealth {
    const out: CitationHealth = { live: 0, historical: 0, dead: 0, user: 0 };
    for (const c of this.citationsFor(cardId)) {
      if (c.status === "current") out.live += 1;
      else if (c.status === "historical") out.historical += 1;
      else out.dead += 1;
      if (c.status !== "deleted" && c.message_role === "user") out.user! += 1;
    }
    return out;
  }

  getCard(cardId: string) {
    const card = this.db.prepare("SELECT * FROM cards WHERE id=?").get(cardId) as Row | undefined;
    if (!card) return undefined;
    return { ...card, citations: this.citationsFor(cardId) } as CardRow;
  }

  listCards(opts: { topicId?: string; reviewState?: string; includeInvalid?: boolean }) {
    const where = ["1=1"];
    const args: SqlVal[] = [];
    if (!opts.includeInvalid) {
      if (opts.reviewState !== "pending") {
        where.push("(invalidated = 0 OR (invalidated = 1 AND review_state = 'pending'))");
      }
    }
    if (opts.topicId) {
      where.push("topic_id = ?");
      args.push(opts.topicId);
    }
    if (opts.reviewState) {
      where.push("review_state = ?");
      args.push(opts.reviewState);
    }
    const cards = this.db
      .prepare(`SELECT * FROM cards WHERE ${where.join(" AND ")} ORDER BY created_at DESC`)
      .all(...args) as Row[];
    return cards.map((c) => ({ ...c, citations: this.citationsFor(String(c.id)) })) as CardRow[];
  }

  updateCard(cardId: string, patch: ReviewPatch) {
    return this.tx(() => {
      const cur = this.getCard(cardId);
      if (!cur) throw new ReviewError("卡片不存在", "not_found");
      const decision = decideReview(
        {
          type: String(cur.type),
          title: String(cur.title),
          body: String(cur.body),
          review_state: String(cur.review_state),
          invalidated: Number(cur.invalidated),
          is_user_note: Number(cur.is_user_note),
        },
        patch,
        this.citationHealth(cardId),
      );
      if (!decision.ok) throw new ReviewError(decision.reason, decision.code);
      this.db
        .prepare(
          `UPDATE cards SET title=?, body=?, type=?, review_state=?, content_state=?, is_user_note=?,
             invalidated=CASE WHEN ? THEN 0 ELSE invalidated END,
             invalidated_reason=CASE WHEN ? THEN NULL ELSE invalidated_reason END,
             updated_at=? WHERE id=?`,
        )
        .run(
          patch.title?.trim() || String(cur.title),
          patch.body !== undefined ? patch.body.trim() : String(cur.body),
          patch.type ?? String(cur.type),
          patch.reviewState ?? String(cur.review_state),
          patch.contentState ?? String(cur.content_state),
          decision.isUserNote ? 1 : 0,
          decision.clearInvalidation ? 1 : 0,
          decision.clearInvalidation ? 1 : 0,
          nowIso(),
          cardId,
        );
      this.addCardRevision(cardId);
      return this.getCard(cardId);
    });
  }

  cardRevisions(cardId: string) {
    return this.db
      .prepare("SELECT id, at, snapshot_json FROM card_revisions WHERE card_id=? ORDER BY at DESC, rowid DESC")
      .all(cardId) as Array<{ id: string; at: string; snapshot_json: string }>;
  }

  confirmReplacement(oldId: string, newId: string) {
    if (oldId === newId) throw new ReviewError("不能用一张卡替代它自己", "bad_input");
    const oldC = this.getCard(oldId);
    const newC = this.getCard(newId);
    if (!oldC || !newC) throw new ReviewError("卡片不存在", "not_found");
    if (oldC.topic_id !== newC.topic_id) throw new ReviewError("不同主题的记录不能互相替代", "bad_input");
    if (Number(oldC.invalidated) || Number(newC.invalidated)) {
      throw new ReviewError("已失效的卡要先重新核对，才能建立替代关系", "bad_input");
    }
    if (newC.review_state !== "confirmed") {
      throw new ReviewError("新决定要先确认准确，才能用它替代旧决定", "bad_input");
    }
    if (oldC.content_state === "replaced") throw new ReviewError("旧决定已经被替代过了", "bad_input");
    this.tx(() => {
      this.db
        .prepare("INSERT INTO replacements(id, old_card_id, new_card_id, confirmed, created_at) VALUES (?,?,?,1,?)")
        .run(id(), oldId, newId, nowIso());
      this.db
        .prepare("UPDATE cards SET content_state='replaced', updated_at=? WHERE id=?")
        .run(nowIso(), oldId);
      this.addCardRevision(oldId);
    });
  }

  undoReplacement(relId: string) {
    const rel = this.db.prepare("SELECT * FROM replacements WHERE id=?").get(relId) as
      | { old_card_id: string }
      | undefined;
    if (!rel) throw new Error("替代关系不存在");
    this.tx(() => {
      this.db
        .prepare("UPDATE cards SET content_state='active', updated_at=? WHERE id=?")
        .run(nowIso(), rel.old_card_id);
      this.db.prepare("DELETE FROM replacements WHERE id=?").run(relId);
      this.addCardRevision(rel.old_card_id);
    });
  }

  listReplacements(topicId: string) {
    return this.db
      .prepare(
        `SELECT r.*, o.title AS old_title, c.title AS new_title FROM replacements r
         JOIN cards c ON c.id = r.new_card_id
         LEFT JOIN cards o ON o.id = r.old_card_id
         WHERE c.topic_id=? ORDER BY r.created_at`,
      )
      .all(topicId);
  }

  deleteImpact(sourceId: string) {
    const src = this.getSource(sourceId);
    const cards = this.db
      .prepare(
        `SELECT DISTINCT c.id FROM cards c JOIN citations x ON x.card_id=c.id WHERE x.source_id=? AND c.invalidated=0`,
      )
      .all(sourceId) as { id: string }[];
    const answers = this.db
      .prepare("SELECT id, scope_json FROM answers WHERE invalidated=0")
      .all() as { id: string; scope_json: string }[];
    const hitAnswers = answers.filter((a) => {
      const scope = JSON.parse(a.scope_json) as { sourceIds?: string[] };
      return scope.sourceIds?.includes(sourceId);
    });
    const hitHandoffs = src
      ? this.listHandoffsDependingOnSource(sourceId, src).filter((h) => Number(h.invalidated) === 0)
      : [];
    return {
      cards: cards.length,
      answers: hitAnswers.length,
      handoffs: hitHandoffs.length,
    };
  }

  deleteSource(sourceId: string) {
    return this.tx(() => {
      const src = this.getSource(sourceId);
      if (!src || src.deleted_at) throw new Error("资料不存在");
      const impact = this.deleteImpact(sourceId);
      this.invalidateCardsForSource(sourceId, "来源资料已删除，卡片正文已清除以免泄漏");
      // 标题、外部编号也可能含正文信息；删除后只留匿名 ID 供引用显示「已失效」
      this.db
        .prepare(
          "UPDATE sources SET deleted_at=?, title=?, external_id=NULL, content_hash=? WHERE id=?",
        )
        .run(nowIso(), DELETED_SOURCE_TITLE, `deleted:${sourceId}`, sourceId);
      const answers = this.db.prepare("SELECT id, scope_json FROM answers").all() as {
        id: string;
        scope_json: string;
      }[];
      for (const a of answers) {
        const scope = JSON.parse(a.scope_json) as { sourceIds?: string[] };
        if (scope.sourceIds?.includes(sourceId)) {
          this.db
            .prepare("UPDATE answers SET invalidated=1, body=?, question='', points_json=NULL WHERE id=?")
            .run("（已失效：相关资料已删除）", a.id);
        }
      }
      for (const h of this.listHandoffsDependingOnSource(sourceId, src)) {
        this.db
          .prepare("UPDATE handoffs SET invalidated=1, body=?, goal='', excluded_json=NULL WHERE id=?")
          .run("（已失效：相关资料已删除，正文已清除）", h.id);
      }
      this.purgeDeletedSourceContent(sourceId);
      this.db
        .prepare("INSERT INTO audit_events(id, type, at, anon_ids) VALUES (?,?,?,?)")
        .run(id(), "source_deleted", nowIso(), sourceId);
      this.db
        .prepare("UPDATE analysis_jobs SET status='cancelled', error=?, updated_at=? WHERE status='running'")
        .run("资料已删除，任务取消", nowIso());
      return impact;
    });
  }

  private listHandoffsDependingOnSource(sourceId: string, src: Record<string, unknown>) {
    const cited = this.db
      .prepare("SELECT DISTINCT card_id FROM citations WHERE source_id=?")
      .all(sourceId) as { card_id: string }[];
    const cardIds = new Set(cited.map((c) => c.card_id));
    const title = String(src.title);
    const topicId = String(src.topic_id);
    const rows = this.db
      .prepare(
        "SELECT id, included_card_ids, included_source_ids, body, topic_id, invalidated FROM handoffs",
      )
      .all() as {
      id: string;
      included_card_ids: string;
      included_source_ids: string | null;
      body: string;
      topic_id: string;
      invalidated: number;
    }[];
    return rows.filter((h) => {
      if (parseIdList(h.included_source_ids).includes(sourceId)) return true;
      if (parseIdList(h.included_card_ids).some((i) => cardIds.has(i))) return true;
      return h.topic_id === topicId && title.length > 0 && h.body.includes(title);
    });
  }

  private inferHandoffSourceIds(topicId: string, cardIds: string[]) {
    const fromTopic = this.listSources({ topicId }).map((s) => String((s as { id: string }).id));
    const fromCards: string[] = [];
    for (const cardId of cardIds) {
      const rows = this.db
        .prepare("SELECT DISTINCT source_id FROM citations WHERE card_id=?")
        .all(cardId) as { source_id: string }[];
      for (const r of rows) fromCards.push(r.source_id);
    }
    return [...new Set([...fromTopic, ...fromCards])];
  }

  private purgeDeletedSourceContent(sourceId: string) {
    this.db.prepare("UPDATE messages SET text='' WHERE source_id=?").run(sourceId);
    this.db.prepare("UPDATE citations SET quote='' WHERE source_id=?").run(sourceId);
    const revs = this.db
      .prepare(
        `SELECT r.id, r.snapshot_json FROM card_revisions r
         WHERE r.card_id IN (SELECT DISTINCT card_id FROM citations WHERE source_id=?)`,
      )
      .all(sourceId) as { id: string; snapshot_json: string }[];
    const deleted = new Set([sourceId]);
    for (const r of revs) {
      this.db
        .prepare("UPDATE card_revisions SET snapshot_json=? WHERE id=?")
        .run(scrubRevisionSnapshot(r.snapshot_json, deleted), r.id);
    }
  }

  invalidateCardsForSource(sourceId: string, reason: string) {
    const cards = this.db
      .prepare("SELECT DISTINCT card_id FROM citations WHERE source_id=?")
      .all(sourceId) as { card_id: string }[];
    for (const c of cards) {
      this.db
        .prepare("UPDATE cards SET invalidated=1, body='', title=?, invalidated_reason=?, updated_at=? WHERE id=?")
        .run(DELETED_CARD_TITLE, reason, nowIso(), c.card_id);
    }
    this.dropBrokenReplacements();
  }

  createJob(kind: string, scope: unknown, versions: unknown) {
    const jobId = id();
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO analysis_jobs(id, kind, status, scope_json, source_versions_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(jobId, kind, "running", JSON.stringify(scope), JSON.stringify(versions), at, at);
    return jobId;
  }

  getJob(jobId: string) {
    return this.db.prepare("SELECT * FROM analysis_jobs WHERE id=?").get(jobId) as
      | Record<string, unknown>
      | undefined;
  }

  finishJob(jobId: string, status: string, result?: unknown, error?: string) {
    this.db
      .prepare("UPDATE analysis_jobs SET status=?, result_json=?, error=?, updated_at=? WHERE id=?")
      .run(status, result ? JSON.stringify(result) : null, error ?? null, nowIso(), jobId);
  }

  cancelJob(jobId: string) {
    this.db
      .prepare("UPDATE analysis_jobs SET status='cancelled', error='用户取消', updated_at=? WHERE id=? AND status='running'")
      .run(nowIso(), jobId);
  }

  runningJobCount() {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM analysis_jobs WHERE status='running'").get() as {
      n: number;
    };
    return r.n;
  }

  sourceVersions(sourceIds: string[]) {
    const out: Record<string, string> = {};
    for (const sid of sourceIds) {
      const s = this.getSource(sid);
      if (s) out[sid] = this.sourceVersionToken(sid, s);
    }
    return out;
  }

  versionsStillMatch(versions: Record<string, string>): boolean {
    for (const [sid, token] of Object.entries(versions)) {
      const s = this.getSource(sid);
      if (!s || s.deleted_at) return false;
      if (this.sourceVersionToken(sid, s) !== token) return false;
    }
    return true;
  }

  private sourceVersionToken(sourceId: string, src: Record<string, unknown>) {
    return sha256(JSON.stringify({ revision: src.current_revision_id,
      roles: this.roleFingerprint(sourceId, String(src.current_revision_id)),
      title: src.title, topic: src.topic_id, date: src.occurred_at, precision: src.occurred_at_precision }));
  }

  private roleFingerprint(sourceId: string, revisionId: string) {
    const rows = this.db
      .prepare("SELECT id, role FROM messages WHERE source_id=? AND revision_id=? ORDER BY seq, id")
      .all(sourceId, revisionId) as { id: string; role: string }[];
    return rows.map((r) => `${r.id}:${r.role}`).join(",");
  }

  saveAnswer(input: { topicId?: string | null; question: string; body: string; points?: unknown; scope: unknown }) {
    const aid = id();
    this.db
      .prepare(
        `INSERT INTO answers(id, topic_id, question, body, points_json, scope_json, created_at, invalidated) VALUES (?,?,?,?,?,?,?,0)`,
      )
      .run(
        aid,
        input.topicId ?? null,
        input.question,
        input.body,
        input.points === undefined ? null : JSON.stringify(input.points),
        JSON.stringify(input.scope),
        nowIso(),
      );
    return this.db.prepare("SELECT * FROM answers WHERE id=?").get(aid);
  }

  getAnswer(id_: string) {
    return this.db.prepare("SELECT * FROM answers WHERE id=?").get(id_);
  }

  saveHandoff(input: {
    topicId: string;
    goal: string;
    variant: string;
    body: string;
    includedCardIds: string[];
    includedSourceIds?: string[];
    excluded: unknown;
  }) {
    const hid = id();
    const sourceIds = input.includedSourceIds ?? this.inferHandoffSourceIds(input.topicId, input.includedCardIds);
    this.db
      .prepare(
        `INSERT INTO handoffs(id, topic_id, goal, variant, body, included_card_ids, included_source_ids, excluded_json, created_at, invalidated)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        hid,
        input.topicId,
        input.goal,
        input.variant,
        input.body,
        JSON.stringify(input.includedCardIds),
        JSON.stringify(sourceIds),
        JSON.stringify(input.excluded),
        nowIso(),
        0,
      );
    return this.db.prepare("SELECT * FROM handoffs WHERE id=?").get(hid);
  }

  /** 交接用的卡片（带引用来源）和资料清单，预览与保存走同一份。 */
  handoffMaterial(topicId: string): { cards: HandoffCard[]; sources: HandoffSource[] } {
    const cards = this.listCards({ topicId }).map((c) => ({
      id: String(c.id),
      type: c.type as CardType,
      title: String(c.title),
      body: String(c.body),
      review_state: String(c.review_state),
      content_state: String(c.content_state),
      is_user_note: Number(c.is_user_note),
      invalidated: Number(c.invalidated),
      applicable_at: (c.applicable_at as string | null) ?? null,
      source_ids: [...new Set(c.citations.map((x) => String(x.source_id)))],
    }));
    const sources = (this.listSources({ topicId }) as Array<Record<string, unknown>>)
      .map((s) => ({
        id: String(s.id),
        title: String(s.title),
        occurred_at: (s.occurred_at as string | null) ?? null,
        imported_at: String(s.imported_at),
      }))
      .sort((a, b) => (a.occurred_at ?? "9999").localeCompare(b.occurred_at ?? "9999") || a.imported_at.localeCompare(b.imported_at));
    return { cards, sources };
  }

  listHandoffs(topicId?: string) {
    const sql = `SELECT id, topic_id, goal, variant, created_at, invalidated FROM handoffs
                 ${topicId ? "WHERE topic_id=?" : ""} ORDER BY created_at DESC LIMIT 50`;
    return (topicId ? this.db.prepare(sql).all(topicId) : this.db.prepare(sql).all()) as Array<Record<string, unknown>>;
  }

  getHandoff(id_: string) {
    return this.db.prepare("SELECT * FROM handoffs WHERE id=?").get(id_) as
      | Record<string, unknown>
      | undefined;
  }

  counts() {
    return {
      topics: (this.db.prepare("SELECT COUNT(*) AS n FROM topics").get() as { n: number }).n,
      sources: (this.db.prepare("SELECT COUNT(*) AS n FROM sources WHERE deleted_at IS NULL").get() as { n: number }).n,
      cards: (this.db.prepare("SELECT COUNT(*) AS n FROM cards WHERE invalidated=0").get() as { n: number }).n,
    };
  }

  exportPayload(library: LibraryId) {
    const deletedIds = new Set(
      (this.db.prepare("SELECT id FROM sources WHERE deleted_at IS NOT NULL").all() as { id: string }[]).map(
        (s) => s.id,
      ),
    );
    const data: Record<string, unknown[]> = {};
    for (const [table, cols] of Object.entries(BACKUP_TABLE_COLUMNS)) {
      const rows = this.db.prepare(`SELECT ${cols.join(",")} FROM ${table}`).all() as Array<
        Record<string, unknown>
      >;
      data[table] = rows.map((row) => this.redactBackupRow(table, row, deletedIds));
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      kind: "xushang-backup",
      library,
      exportedAt: nowIso(),
      data,
    };
  }

  private redactBackupRow(table: string, row: Record<string, unknown>, deletedIds: Set<string>) {
    if (table === "messages" && deletedIds.has(String(row.source_id))) {
      return { ...row, text: "" };
    }
    if (table === "citations" && deletedIds.has(String(row.source_id))) {
      return { ...row, quote: "" };
    }
    if (table === "card_revisions") {
      return { ...row, snapshot_json: scrubRevisionSnapshot(String(row.snapshot_json ?? ""), deletedIds) };
    }
    return row;
  }
}

export function libraryPath(root: string, library: LibraryId): string {
  return `${root}/${library}/xushang.db`;
}
