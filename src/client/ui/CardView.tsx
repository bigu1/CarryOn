import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Badge } from "./kit";
import { contentLabel, roleLabel, sourceDate, typeLabel } from "./labels";

export type Citation = {
  id?: string;
  source_id: string;
  message_id: string;
  revision_id?: string;
  quote: string;
  source_title?: string | null;
  source_occurred_at?: string | null;
  message_role?: string | null;
  status?: "current" | "historical" | "deleted";
};

export type CardData = Record<string, any> & {
  id: string;
  type: string;
  title: string;
  body: string;
  review_state: string;
  content_state: string;
  invalidated: number;
  invalidated_reason?: string | null;
  is_user_note?: number;
  created_via?: string;
  citations: Citation[];
};

/** 卡片状态用文字表达，不只靠颜色。 */
export function CardBadges({ card }: { card: CardData }) {
  const reference = ["ai_suggestion", "hypothesis", "tentative_plan", "reported_result", "tool_report"].includes(card.type);
  return (
    <span className="badges">
      <Badge tone={card.type === "user_decision" ? "accent" : reference ? "info" : "neutral"}>{typeLabel(card.type)}</Badge>
      {Number(card.invalidated) === 1 ? (
        <Badge tone="bad">需要重新核对</Badge>
      ) : card.review_state === "pending" ? (
        <Badge tone="warn">待核对</Badge>
      ) : card.review_state === "rejected" ? (
        <Badge tone="bad">已拒绝</Badge>
      ) : (
        <Badge tone="ok">已确认准确</Badge>
      )}
      {["replaced", "user_resolved", "reported_unverified", "needs_clarification"].includes(card.content_state) ? (
        <Badge tone={card.content_state === "replaced" ? "neutral" : "warn"}>{contentLabel(card.content_state)}</Badge>
      ) : null}
      {card.created_via === "model" ? <Badge>模型候选</Badge> : null}
    </span>
  );
}

export function citationHref(x: Citation, from: string) {
  const rev = x.status === "historical" && x.revision_id ? `&revision=${x.revision_id}` : "";
  return `/sources/${x.source_id}?msg=${x.message_id}&quote=${encodeURIComponent(x.quote)}${rev}&from=${encodeURIComponent(from)}`;
}

export function CitationList({ citations, from }: { citations: Citation[]; from: string }) {
  if (!citations.length) return null;
  return (
    <ul className="cites">
      {citations.map((x, i) => (
        <li key={x.id ?? `${x.message_id}-${i}`} className={`cite cite-${x.status ?? "current"}`}>
          <blockquote>{x.quote || "（原文已删除）"}</blockquote>
          <div className="cite-meta">
            {x.status === "deleted" ? (
              <span>来源已删除，引用失效</span>
            ) : (
              <>
                <Link to={citationHref(x, from)}>{x.source_title || "打开原文"}</Link>
                <span>{sourceDate(x.source_occurred_at)}</span>
                {x.message_role ? <span>{roleLabel(x.message_role)}说的</span> : null}
                {x.status === "historical" ? <Badge tone="warn">旧版本原文</Badge> : null}
              </>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function CardView({ card, from, actions, compact }: { card: CardData; from: string; actions?: ReactNode; compact?: boolean }) {
  return (
    <article className={`card-item${Number(card.invalidated) === 1 ? " is-invalid" : ""}${card.content_state === "replaced" ? " is-replaced" : ""}`}>
      <header className="card-item-head">
        <h3>{card.title}</h3>
        <CardBadges card={card} />
      </header>
      {card.body ? <p className="card-item-body">{card.body}</p> : null}
      {card.invalidated_reason ? <p className="card-item-reason">{card.invalidated_reason}</p> : null}
      {!compact ? <CitationList citations={card.citations ?? []} from={from} /> : null}
      {Number(card.is_user_note) === 1 ? <p className="hint">用户备注：不是从聊天提炼的事实。</p> : null}
      {actions ? <div className="card-item-actions">{actions}</div> : null}
    </article>
  );
}
