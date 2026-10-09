import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { get, patch } from "../api";
import { useShell } from "../ui/shell";
import { TypeOptions } from "../ui/CardForm";
import { CardBadges, citationHref, type CardData } from "../ui/CardView";
import { useAction, useLoad } from "../ui/hooks";
import { Button, Check, Empty, ErrorText, LinkButton, Loading, Notice, PageHeader, Panel, SelectField, TextArea, TextInput } from "../ui/kit";
import { roleLabel, sourceDate, typeLabel } from "../ui/labels";

type Ctx = { source: Record<string, any>; historical: boolean; messageId: string; context: Array<Record<string, any>> } | { error: string };

function CitationContext({ c, from }: { c: CardData["citations"][number]; from: string }) {
  const [ctx, setCtx] = useState<Ctx | null>(null);
  useEffect(() => {
    if (c.status === "deleted") return;
    let live = true;
    get(`/api/messages/${c.message_id}/context`)
      .then((d) => live && setCtx(d))
      .catch((e: Error) => live && setCtx({ error: e.message }));
    return () => {
      live = false;
    };
  }, [c.message_id, c.status]);

  if (c.status === "deleted") {
    return <Notice tone="bad">引用的资料已删除，原文和摘录都已清除。</Notice>;
  }
  return (
    <div className="cite">
      <div className="cite-meta" style={{ paddingLeft: 0, marginBottom: "0.35rem" }}>
        <Link to={citationHref(c, from)}>{c.source_title}</Link>
        <span>{sourceDate(c.source_occurred_at)}</span>
        {c.status === "historical" ? <span style={{ color: "var(--warn)" }}>旧版本原文</span> : null}
      </div>
      {!ctx ? (
        <Loading>读取原文…</Loading>
      ) : "error" in ctx ? (
        <p className="hint">{ctx.error}</p>
      ) : (
        ctx.context.map((m) => {
          const cited = m.id === c.message_id;
          const at = cited ? String(m.text).indexOf(c.quote) : -1;
          return (
            <div key={m.id} className={`context-msg${cited ? " cited" : ""}`}>
              <span className={`msg-role ${m.role}`}>{roleLabel(m.role)}：</span>
              {at >= 0 ? (
                <>
                  {String(m.text).slice(0, at)}
                  <mark>{c.quote}</mark>
                  {String(m.text).slice(at + c.quote.length)}
                </>
              ) : (
                m.text
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

export function ReviewPage() {
  const [sp, setSp] = useSearchParams();
  const shell = useShell();
  const topics = useLoad<{ topics: Array<{ id: string; label: string }> }>("/api/topics");
  const [topicId, setTopicId] = useState("");
  const queue = useLoad<{ cards: CardData[] }>(`/api/cards?reviewState=pending${topicId ? `&topicId=${topicId}` : ""}`);
  const wanted = sp.get("card");
  const [extra, setExtra] = useState<CardData | null>(null);
  const [edit, setEdit] = useState({ type: "", title: "", body: "" });
  const [ackHistorical, setAckHistorical] = useState(false);
  const [done, setDone] = useState("");
  const act = useAction();

  const cards = queue.data?.cards ?? [];
  const current = useMemo(() => {
    if (wanted) return cards.find((c) => c.id === wanted) ?? (extra?.id === wanted ? extra : null);
    return cards[0] ?? null;
  }, [cards, wanted, extra]);

  // 从主题页点「修改」进来的卡不一定在待核对队列里，单独取
  useEffect(() => {
    if (!wanted || cards.some((c) => c.id === wanted)) return;
    get(`/api/cards/${wanted}`)
      .then((d) => setExtra(d.card))
      .catch(() => setExtra(null));
  }, [wanted, cards]);

  useEffect(() => {
    if (!current) return;
    setEdit({ type: current.type, title: current.title, body: current.body });
    setAckHistorical(false);
    act.setError("");
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const historicalOnly =
    !!current &&
    current.citations.length > 0 &&
    !current.citations.some((c) => c.status === "current") &&
    current.citations.some((c) => c.status === "historical");
  const allDeleted = !!current && current.citations.length > 0 && current.citations.every((c) => c.status === "deleted");
  const roleMismatch = !!current && edit.type === "user_decision" && current.citations.some((c) => c.message_role && c.message_role !== "user");

  async function decide(reviewState?: "confirmed" | "rejected") {
    if (!current) return;
    const body: Record<string, unknown> =
      reviewState === "rejected"
        ? { reviewState }
        : { type: edit.type, title: edit.title, body: edit.body, reviewState, acknowledgeHistorical: ackHistorical || undefined };
    const r = await act.run(() => patch(`/api/cards/${current.id}`, body));
    if (!r) return;
    setDone(
      reviewState === "confirmed" ? `已确认「${r.card.title}」。` : reviewState === "rejected" ? `已拒绝「${r.card.title}」，它不会进入结论和交接。` : "修改已保存。",
    );
    if (wanted) {
      sp.delete("card");
      setSp(sp, { replace: true });
    }
    setExtra(null);
    shell.refresh();
    await queue.reload();
  }

  const from = "/review";

  return (
    <div className="page">
      <PageHeader
        title="待核对"
        lead="逐条对照原文：准确就确认，不准就改了再确认，不该有就拒绝。不会批量确认。「已确认准确」只表示概括和原文一致，不代表事情已经办成。"
      />
      {done ? (
        <Notice tone="ok" role="status">
          {done}
        </Notice>
      ) : null}
      <div className="layout-queue" style={{ marginTop: "1rem" }}>
        <Panel className="sticky">
          <select className="input select" aria-label="按主题筛选" value={topicId} onChange={(e) => setTopicId(e.target.value)}>
            <option value="">全部主题</option>
            {(topics.data?.topics ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <div style={{ marginTop: "0.75rem" }}>
            {queue.loading && !queue.data ? (
              <Loading />
            ) : cards.length === 0 ? (
              <p className="hint">没有待核对的卡片。</p>
            ) : (
              <nav aria-label="待核对卡片">
                {cards.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`queue-item${current?.id === c.id ? " on" : ""}`}
                    aria-current={current?.id === c.id || undefined}
                    onClick={() => {
                      sp.set("card", c.id);
                      setSp(sp, { replace: true });
                    }}
                  >
                    <span className="queue-item-title">{c.title}</span>
                    <span className="queue-item-meta">
                      <span>{typeLabel(c.type)}</span>
                      {Number(c.invalidated) === 1 ? <span style={{ color: "var(--bad)" }}>需重新核对</span> : null}
                      {c.created_via === "model" ? <span>模型候选</span> : null}
                    </span>
                  </button>
                ))}
              </nav>
            )}
          </div>
        </Panel>

        {!current ? (
          <Panel>
            <Empty
              title="都核对完了"
              actions={
                <>
                  <LinkButton to="/sources">打开资料，选中原文建卡</LinkButton>
                  <LinkButton to="/topics">看主题</LinkButton>
                </>
              }
            >
              没连模型时，卡片由你在原文里选中文字来建；连了模型，可以在主题的「资料」页提炼候选。
            </Empty>
          </Panel>
        ) : (
          <div className="stack">
            <Panel
              title={current.title}
              hint={<CardBadges card={current} />}
              actions={current.review_state !== "pending" ? <span className="hint">不在待核对队列里，修改后可以重新确认</span> : null}
            >
              {current.invalidated_reason ? (
                <Notice tone="warn" title="为什么要重新核对">
                  {current.invalidated_reason}
                </Notice>
              ) : null}
              {roleMismatch ? (
                <Notice tone="warn">引用的话现在标为 AI 或其他人说的。如果用户没有明确采纳，类型应改成「AI 建议」。</Notice>
              ) : null}
              {allDeleted ? (
                <Notice tone="bad">引用的资料都已删除。可以拒绝，或改成「用户备注」并重写内容后保存。</Notice>
              ) : null}
              <div style={{ marginTop: "0.9rem" }}>
                <SelectField label="类型" value={edit.type} onChange={(e) => setEdit({ ...edit, type: e.target.value })}>
                  <TypeOptions />
                </SelectField>
                <TextInput label="标题" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
                <TextArea label="内容" value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} placeholder={current.body ? undefined : "内容已清除，请按现有原文重写"} />
                {historicalOnly ? (
                  <div style={{ marginTop: "0.85rem" }}>
                    <Check
                      label="我已对照旧版本原文，仍按历史记录确认"
                      hint="这张卡只引用了旧版本。确认后它表示「当时这么说过」，不是当前原文。"
                      checked={ackHistorical}
                      onChange={(e) => setAckHistorical(e.target.checked)}
                    />
                  </div>
                ) : null}
              </div>
              <div className="form-actions">
                <Button tone="primary" busy={act.busy} onClick={() => void decide("confirmed")}>
                  {edit.title !== current.title || edit.body !== current.body || edit.type !== current.type ? "保存修改并确认准确" : "确认准确"}
                </Button>
                <Button onClick={() => void decide()} disabled={act.busy}>
                  只保存修改
                </Button>
                {current.review_state !== "rejected" ? (
                  <Button tone="danger" onClick={() => void decide("rejected")} disabled={act.busy}>
                    拒绝
                  </Button>
                ) : null}
              </div>
              <ErrorText>{act.error}</ErrorText>
            </Panel>
            <Panel title="原文" hint="引用的那句标黄，前后各带一段上下文。">
              {current.citations.length ? (
                <div className="stack">
                  {current.citations.map((c, i) => (
                    <CitationContext key={`${c.message_id}-${i}`} c={c} from={from} />
                  ))}
                </div>
              ) : (
                <p className="hint">这是用户备注，没有原文引用。</p>
              )}
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}
