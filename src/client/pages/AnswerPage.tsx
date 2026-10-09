import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { get } from "../api";
import { useShell } from "../ui/shell";
import { AiSend, NeedsModel } from "../ui/AiSend";
import { CardBadges } from "../ui/CardView";
import { useAction, useLoad } from "../ui/hooks";
import { Badge, Button, Check, ErrorText, Highlight, Notice, PageHeader, Panel } from "../ui/kit";
import { roleLabel, ROLE_LABEL, ROLE_OPTIONS, sourceDate } from "../ui/labels";

type Hits = {
  total: number;
  page: number;
  pageSize: number;
  rows: Array<Record<string, any>>;
  cards: Array<Record<string, any>>;
  suggestions?: Array<{ term: string; total: number }>;
};
type Point = { text: string; kind: string; kindLabel: string; support: Array<{ messageId: string; sourceId: string; sourceTitle: string; sourceDate: string | null; role: string; quote: string }> };

export function AnswerPage() {
  const [sp, setSp] = useSearchParams();
  const shell = useShell();
  const topics = useLoad<{ topics: Array<{ id: string; label: string }> }>("/api/topics");
  const [q, setQ] = useState(sp.get("q") ?? "");
  const [topicId, setTopicId] = useState(sp.get("topic") ?? "");
  const [role, setRole] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [withUnknown, setWithUnknown] = useState(true);
  const [moreFilters, setMoreFilters] = useState(false);
  const [hits, setHits] = useState<Hits | null>(null);
  const [searched, setSearched] = useState("");
  const [answer, setAnswer] = useState<Record<string, any> | null>(null);
  const act = useAction();

  async function search(page = 1, query = q) {
    const params = new URLSearchParams({ q: query, page: String(page) });
    if (topicId) params.set("topicId", topicId);
    if (role) params.set("role", role);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    if (dateFrom || dateTo) params.set("includeUnknownDate", withUnknown ? "1" : "0");
    const d = await act.run(() => get(`/api/search?${params.toString()}`));
    if (d) {
      setHits(d);
      setSearched(query);
      const next = new URLSearchParams(sp);
      next.set("q", query);
      if (topicId) next.set("topic", topicId);
      else next.delete("topic");
      setSp(next, { replace: true });
    }
  }

  useEffect(() => {
    const initial = sp.get("q");
    if (initial) void search(1, initial);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const from = `/answers?${new URLSearchParams({ q: searched, ...(topicId ? { topic: topicId } : {}) }).toString()}`;
  const points = answer?.points_json ? (JSON.parse(answer.points_json) as { points: Point[]; conflicts: string[]; insufficient: boolean; missing: string | null; note: string | null }) : null;

  return (
    <div className="page">
      <PageHeader title="查找与回答" lead="关键词直接搜原文，中文一两个字、英文、数字、代码片段都可以。连了模型还能用一句话提问，回答的每一点都带原文出处。" />
      <Panel>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setAnswer(null);
            void search(1);
          }}
        >
          <div className="row">
            <input className="input grow" style={{ flexBasis: "18rem" }} aria-label="你想找回什么" placeholder="比如：云同步、为什么放弃云同步" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className="input select" style={{ width: "auto", minWidth: "10rem" }} aria-label="限定主题" value={topicId} onChange={(e) => setTopicId(e.target.value)}>
              <option value="">全部主题</option>
              {(topics.data?.topics ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <Button type="submit" tone="primary" busy={act.busy}>
              查找
            </Button>
            <Button tone="quiet" onClick={() => setMoreFilters((v) => !v)} aria-expanded={moreFilters}>
              {moreFilters ? "收起筛选" : "更多筛选"}
            </Button>
          </div>
          {moreFilters ? (
            <div className="fields" style={{ marginTop: "0.9rem" }}>
              <select className="input select" aria-label="按说话人筛选" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="">所有说话人</option>
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
              <input className="input" type="date" aria-label="来源日期从" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
              <input className="input" type="date" aria-label="来源日期到" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
              <Check label="也包括日期未知的资料" checked={withUnknown} onChange={(e) => setWithUnknown(e.target.checked)} />
            </div>
          ) : null}
        </form>
        <ErrorText>{act.error}</ErrorText>
      </Panel>

      <Panel title="用一句话提问" hint="模型只根据你导入的资料回答；会说明哪些是已确认的决定、哪些只是候选或 AI 建议，以及材料回答不了的部分。">
        {!shell.modelConfigured ? (
          <NeedsModel alt="不连模型也能用上面的关键词查找，或者去主题页看已整理的决定。" />
        ) : !q.trim() ? (
          <p className="hint">先在上面的框里写下问题。</p>
        ) : (
          <AiSend
            key={`${q}|${topicId}`}
            kind="answer"
            request={{ question: q, topicId: topicId || undefined }}
            previewLabel="让模型回答（先看发送范围）"
            sendLabel="确认发送，请模型回答"
            onDone={(r) => setAnswer(r.answer)}
          />
        )}
        {answer ? (
          <div style={{ marginTop: "1rem" }}>
            <h3 style={{ fontSize: "1rem", marginBottom: "0.6rem" }}>「{answer.question}」</h3>
            {points ? (
              <>
                {points.points.map((p, i) => (
                  <div className="answer-point" key={i}>
                    <p>
                      <Badge tone={p.kind === "decision" ? "accent" : p.kind === "candidate" ? "warn" : p.kind === "ai_suggestion" ? "info" : "neutral"}>
                        {p.kindLabel}
                      </Badge>{" "}
                      {p.text}
                    </p>
                    <ul className="cites">
                      {p.support.map((s, j) => (
                        <li className="cite" key={j}>
                          <blockquote>{s.quote}</blockquote>
                          <div className="cite-meta">
                            <Link to={`/sources/${s.sourceId}?msg=${s.messageId}&quote=${encodeURIComponent(s.quote)}&from=${encodeURIComponent(from)}`}>{s.sourceTitle}</Link>
                            <span>{sourceDate(s.sourceDate)}</span>
                            <span>{roleLabel(s.role)}说的</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {points.conflicts.length ? (
                  <Notice tone="warn" title="资料里前后不一致">
                    <ul style={{ paddingLeft: "1.1rem" }}>
                      {points.conflicts.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  </Notice>
                ) : null}
                {points.insufficient ? <Notice tone="info" title="材料不足以完整回答">{points.missing || "已导入的资料里找不到足够依据。"}</Notice> : null}
                {points.note ? <p className="hint" style={{ marginTop: "0.6rem" }}>{points.note}</p> : null}
              </>
            ) : (
              <pre className="msg-text">{answer.body}</pre>
            )}
          </div>
        ) : null}
      </Panel>

      {hits ? (
        <>
          {hits.cards.length ? (
            <Panel title={`相关卡片 ${hits.cards.length}`} hint="标题或内容里出现了这个词的卡片。">
              <ul className="list">
                {hits.cards.map((c) => (
                  <li className="list-row" key={c.id}>
                    <div className="list-row-main">
                      <Link className="list-row-title" to={`/topics/${c.topic_id}`}>
                        <Highlight text={c.title} q={searched} />
                      </Link>
                      <div className="hint" style={{ marginTop: "0.15rem" }}>
                        <Highlight text={c.body} q={searched} />
                      </div>
                      <div className="list-row-meta">{c.topic_label}</div>
                    </div>
                    <CardBadges card={{ ...c, citations: [] } as never} />
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
          <Panel title={`原文命中 ${hits.total} 处`} hint="按来源日期排列，日期未知的排在最前；已删除的资料不会出现。">
            {hits.rows.length === 0 ? (
              <div className="stack">
                <p className="hint">整句没有原样出现在原文里。换个说法，或者去掉筛选条件再试。</p>
                {hits.suggestions?.length ? (
                  <div className="row">
                    <span className="hint">试试这些词：</span>
                    {hits.suggestions.map((s) => (
                      <Button
                        key={s.term}
                        small
                        onClick={() => {
                          setQ(s.term);
                          void search(1, s.term);
                        }}
                      >
                        {s.term}（{s.total}）
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <div>
                {hits.rows.map((r) => (
                  <div className="hit" key={r.id}>
                    <div className="hit-head">
                      <Link to={`/sources/${r.source_id}?msg=${r.id}&quote=${encodeURIComponent(searched)}&from=${encodeURIComponent(from)}`}>{r.source_title}</Link>
                      <span>{r.topic_label}</span>
                      <span>{roleLabel(r.role)}</span>
                      <span>{sourceDate(r.source_occurred_at)}</span>
                    </div>
                    <p className="hit-text">
                      <Highlight text={String(r.snippet ?? r.text)} q={searched} />
                    </p>
                  </div>
                ))}
              </div>
            )}
            {hits.total > hits.pageSize ? (
              <div className="pager">
                <Button small disabled={hits.page <= 1} onClick={() => void search(hits.page - 1, searched)}>
                  上一页
                </Button>
                <span className="hint">
                  第 {hits.page} / {Math.ceil(hits.total / hits.pageSize)} 页
                </span>
                <Button small disabled={hits.page * hits.pageSize >= hits.total} onClick={() => void search(hits.page + 1, searched)}>
                  下一页
                </Button>
              </div>
            ) : null}
          </Panel>
        </>
      ) : null}
    </div>
  );
}
