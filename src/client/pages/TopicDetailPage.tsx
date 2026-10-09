import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { del, patch, post } from "../api";
import { useShell } from "../ui/shell";
import { AiSend, NeedsModel } from "../ui/AiSend";
import { CardFormDialog } from "../ui/CardForm";
import { CardView, type CardData } from "../ui/CardView";
import { useAction, useLoad } from "../ui/hooks";
import { Button, Dialog, Empty, ErrorText, LinkButton, Loading, Notice, PageHeader, Panel, Stat, Tabs } from "../ui/kit";
import { FAMILIES, formatTime, sourceDate } from "../ui/labels";

type Tab = "now" | "questions" | "reference" | "recheck" | "timeline" | "sources";

/** 卡片的来源日期：引用里最早的那份资料日期；没有就是 null。 */
const cardDate = (c: CardData) => ((c.citations ?? []).map((x) => x.source_occurred_at).filter(Boolean) as string[]).sort()[0] ?? null;
const byDate = (a: CardData, b: CardData) => {
  const da = cardDate(a);
  const db = cardDate(b);
  if (da && db && da !== db) return da.localeCompare(db);
  if (!!da !== !!db) return da ? -1 : 1;
  return String(a.created_at).localeCompare(String(b.created_at));
};
const isLive = (c: CardData) => Number(c.invalidated) === 0 && c.review_state !== "rejected";
const needsCheck = (c: CardData) => c.review_state === "pending" || (Number(c.invalidated) === 1 && c.review_state !== "rejected");

export function TopicDetailPage() {
  const { id } = useParams();
  const shell = useShell();
  const { data, error, loading, reload } = useLoad(id ? `/api/topics/${id}` : null);
  const [tab, setTab] = useState<Tab>("now");
  const [replacing, setReplacing] = useState<CardData | null>(null);
  const [newerId, setNewerId] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [extractResult, setExtractResult] = useState<Record<string, any> | null>(null);
  const act = useAction();

  const cards = (data?.cards ?? []) as CardData[];
  const groups = useMemo(() => {
    const confirmed = cards.filter((c) => isLive(c) && c.review_state === "confirmed").sort(byDate);
    const byFamily = (key: string, list = confirmed) => list.filter((c) => FAMILIES.find((f) => f.key === key)!.types.includes(c.type as never));
    return {
      decisions: byFamily("decision"),
      frame: byFamily("frame"),
      attempts: byFamily("attempt"),
      questions: byFamily("question"),
      reference: byFamily("reference"),
      notes: byFamily("note"),
      recheck: cards.filter(needsCheck),
      confirmed,
    };
  }, [cards]);

  if (loading && !data) return <Loading>正在打开主题…</Loading>;
  if (error || !data) return <Notice tone="bad">{error || "主题不存在"}</Notice>;

  const topic = data.topic as { id: string; label: string };
  const sources = (data.sources ?? []) as Array<Record<string, any>>;
  const replacements = (data.replacements ?? []) as Array<Record<string, any>>;
  const conflicts = (data.conflicts ?? []) as Array<{ message: string; titles: string[] }>;
  const from = `/topics/${id}`;
  const openQuestions = groups.questions.filter((c) => c.content_state !== "user_resolved");
  const dated = sources.map((s) => s.occurred_at).filter(Boolean).sort();

  async function setState(card: CardData, contentState: string) {
    if (await act.run(() => patch(`/api/cards/${card.id}`, { contentState }))) await reload();
  }

  async function confirmReplace() {
    if (!replacing || !newerId) return;
    const r = await act.run(() => post(`/api/cards/${newerId}/replace`, { oldCardId: replacing.id }));
    if (r) {
      setReplacing(null);
      setNewerId("");
      await reload();
    }
  }

  const cardActions = (c: CardData) => (
    <>
      {c.type === "user_decision" && c.content_state !== "replaced" ? (
        <Button small onClick={() => setReplacing(c)}>
          被后来的决定替代…
        </Button>
      ) : null}
      {["open_question", "needs_clarification"].includes(c.type) ? (
        c.content_state === "user_resolved" ? (
          <Button small onClick={() => void setState(c, "unresolved")}>
            重新打开
          </Button>
        ) : (
          <Button small onClick={() => void setState(c, "user_resolved")}>
            标记已解决
          </Button>
        )
      ) : null}
      <LinkButton small tone="quiet" to={`/review?card=${c.id}`}>
        修改
      </LinkButton>
    </>
  );

  const list = (items: CardData[], empty: string) =>
    items.length ? (
      <div className="card-list">
        {items.map((c) => (
          <CardView key={c.id} card={c} from={from} actions={cardActions(c)} />
        ))}
      </div>
    ) : (
      <p className="hint">{empty}</p>
    );

  const timeline = (() => {
    const map = new Map<string, CardData[]>();
    for (const c of cards.filter(isLive)) {
      const dates = (c.citations ?? []).map((x) => x.source_occurred_at).filter(Boolean) as string[];
      const key = dates.sort()[0] ?? "";
      map.set(key, [...(map.get(key) ?? []), c]);
    }
    return [...map.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  })();

  return (
    <div className="page">
      <PageHeader
        back={<Link to="/topics">← 全部主题</Link>}
        title={topic.label}
        lead={
          dated.length
            ? `资料来源日期 ${sourceDate(dated[0])} 至 ${sourceDate(dated[dated.length - 1])}${dated.length < sources.length ? `，另有 ${sources.length - dated.length} 份日期未知` : ""}。下面只反映已导入的资料，不代表现在的状态。`
            : "资料来源日期未知。下面只反映已导入的资料，不代表现在的状态。"
        }
        actions={
          <>
            <Button onClick={() => setNoteOpen(true)}>写备注</Button>
            <LinkButton to={`/handoff?topic=${id}`} tone="primary">
              用这个主题写交接
            </LinkButton>
          </>
        }
      />
      <div className="stats" style={{ marginBottom: "1rem" }}>
        <Stat value={groups.decisions.length} label="已确认决定" />
        <Stat value={openQuestions.length} label="未决问题" />
        <Stat value={groups.recheck.length} label="待核对" to={groups.recheck.length ? "/review" : undefined} />
        <Stat value={sources.length} label="份资料" />
      </div>

      {conflicts.map((c) => (
        <Notice key={c.message} tone="warn" title="可能前后有变化">
          {c.message}
          <div className="hint" style={{ marginTop: "0.3rem" }}>
            涉及：{c.titles.join("、")}。在旧决定上点「被后来的决定替代…」来记录。
          </div>
        </Notice>
      ))}

      <div style={{ marginTop: "1rem" }}>
        <Tabs
          label="主题内容"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "now", label: "决定与背景", count: groups.decisions.length + groups.frame.length + groups.attempts.length },
            { value: "questions", label: "问题", count: groups.questions.length },
            { value: "reference", label: "仅供参考", count: groups.reference.length + groups.notes.length },
            { value: "recheck", label: "待核对 / 需重新核对", count: groups.recheck.length },
            { value: "timeline", label: "时间线" },
            { value: "sources", label: "资料", count: sources.length },
          ]}
        />
      </div>

      {tab === "now" ? (
        <Panel>
          {groups.decisions.length + groups.frame.length + groups.attempts.length === 0 ? (
            <Empty
              title="还没有确认过的决定或背景"
              actions={
                sources[0] ? <LinkButton to={`/sources/${sources[0].id}`}>打开资料，选中原文建卡</LinkButton> : null
              }
            >
              这里只显示你确认准确的卡片。「无记录」不等于「确认没有」。
            </Empty>
          ) : (
            <>
              <section className="family">
                <div className="family-head">
                  <h3>决定</h3>
                  <span className="hint">用户自己作出的选择；已被替代的划线保留作历史</span>
                </div>
                {list(groups.decisions, "无记录（不是「确认没有」）。")}
              </section>
              {replacements.length ? (
                <section className="family">
                  <div className="family-head">
                    <h3>替代关系</h3>
                  </div>
                  <ul className="list">
                    {replacements.map((r) => (
                      <li className="list-row" key={r.id}>
                        <span>
                          「{r.old_title}」已被「{r.new_title}」替代 <span className="hint">· 你在 {formatTime(r.created_at)} 确认</span>
                        </span>
                        <Button small tone="quiet" onClick={() => void act.run(() => del(`/api/replacements/${r.id}`)).then(reload)}>
                          撤销
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <section className="family">
                <div className="family-head">
                  <h3>目标与约束</h3>
                </div>
                {list(groups.frame, "无记录（不是「确认没有」）。")}
              </section>
              <section className="family">
                <div className="family-head">
                  <h3>试过的办法</h3>
                </div>
                {list(groups.attempts, "无记录（不是「确认没有」）。")}
              </section>
            </>
          )}
        </Panel>
      ) : null}

      {tab === "questions" ? (
        <Panel>
          <section className="family">
            <div className="family-head">
              <h3>还没解决</h3>
            </div>
            {list(openQuestions, "无记录（不是「确认没有」）。")}
          </section>
          {groups.questions.length > openQuestions.length ? (
            <section className="family">
              <div className="family-head">
                <h3>你标记为已解决</h3>
              </div>
              {list(groups.questions.filter((c) => c.content_state === "user_resolved"), "")}
            </section>
          ) : null}
        </Panel>
      ) : null}

      {tab === "reference" ? (
        <Panel hint="AI 建议、设想、暂定安排、聊天里的说法、工具报告——都不是用户决定；备注是你自己补充的。">
          {list([...groups.reference, ...groups.notes], "无记录（不是「确认没有」）。")}
        </Panel>
      ) : null}

      {tab === "recheck" ? (
        <Panel
          hint="待核对的候选，以及因为资料修订、删除或说话人更正而需要重新核对的卡片。它们不会进入交接，除非你确认。"
          actions={groups.recheck.length ? <LinkButton to="/review" tone="primary" small>逐条核对</LinkButton> : null}
        >
          {groups.recheck.length ? (
            <div className="card-list">
              {groups.recheck.map((c) => (
                <CardView
                  key={c.id}
                  card={c}
                  from={from}
                  actions={
                    <LinkButton small to={`/review?card=${c.id}`}>
                      去核对
                    </LinkButton>
                  }
                />
              ))}
            </div>
          ) : (
            <p className="hint">没有待核对的卡片。</p>
          )}
        </Panel>
      ) : null}

      {tab === "timeline" ? (
        <Panel hint="按卡片引用的资料来源日期排列，不按导入先后。同一天或日期未知的并列，不代表先后。">
          {timeline.length ? (
            <ol className="timeline">
              {timeline.map(([date, items]) => (
                <li key={date || "unknown"}>
                  <div className="timeline-date">{date ? sourceDate(date) : "来源日期未知"}</div>
                  <div className="card-list">
                    {items.map((c) => (
                      <CardView key={c.id} card={c} from={from} compact />
                    ))}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="hint">还没有卡片。</p>
          )}
        </Panel>
      ) : null}

      {tab === "sources" ? (
        <>
          <Panel>
            <ul className="list">
              {sources.map((s) => (
                <li className="list-row" key={s.id}>
                  <div className="list-row-main">
                    <Link className="list-row-title" to={`/sources/${s.id}`}>
                      {s.title}
                    </Link>
                    <div className="list-row-meta">
                      <span>来源日期 {sourceDate(s.occurred_at)}</span>
                      <span>{s.message_count} 段</span>
                      <span>导入于 {formatTime(s.imported_at)}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="用模型提炼候选卡片" hint="模型提出的都是候选，进「待核对」，不会自动确认。">
            {shell.modelConfigured ? (
              <AiSend
                kind="extract"
                request={{ topicId: id }}
                sendLabel="确认发送，开始提炼"
                onDone={(r) => {
                  setExtractResult(r);
                  void reload();
                }}
              />
            ) : (
              <NeedsModel alt="不连模型也可以：打开资料，选中原文，手动建卡。" />
            )}
            {extractResult ? (
              <Notice tone={extractResult.status === "部分完成" ? "warn" : "ok"} title={`提炼${extractResult.status ?? "完成"}`}>
                新增 {extractResult.created?.length ?? 0} 条候选，已处理 {extractResult.coverage?.processed} / {extractResult.coverage?.totalSegments} 段。
                {extractResult.note ? ` ${extractResult.note}` : ""}
                <div className="notice-actions">
                  <LinkButton small to="/review">
                    去核对
                  </LinkButton>
                </div>
              </Notice>
            ) : null}
          </Panel>
        </>
      ) : null}
      <ErrorText>{act.error}</ErrorText>

      <Dialog
        open={!!replacing}
        onClose={() => setReplacing(null)}
        title="记录决定的变化"
        actions={
          <>
            <Button onClick={() => setReplacing(null)}>取消</Button>
            <Button tone="primary" disabled={!newerId} busy={act.busy} onClick={() => void confirmReplace()}>
              确认替代
            </Button>
          </>
        }
      >
        <p>
          旧决定：<strong>{replacing?.title}</strong>
          <span className="hint">（来源日期 {replacing ? sourceDate(cardDate(replacing)) : ""}）</span>
        </p>
        <p className="hint" style={{ margin: "0.4rem 0 0.9rem" }}>
          选出替代它的新决定。只有你确认后才算替代；日期更晚本身不是证据。旧决定会保留，标为「已被替代」。
        </p>
        {groups.decisions.filter((c) => c.id !== replacing?.id && c.content_state !== "replaced").length ? (
          <div className="stack">
            {groups.decisions
              .filter((c) => c.id !== replacing?.id && c.content_state !== "replaced")
              .map((c) => (
                <label key={c.id} className="pick">
                  <input type="radio" name="newer" value={c.id} checked={newerId === c.id} onChange={() => setNewerId(c.id)} />
                  <span>
                    <span className="pick-title">{c.title}</span>
                    <span className="hint" style={{ display: "block" }}>
                      来源日期 {sourceDate(cardDate(c))} · {c.body}
                    </span>
                  </span>
                </label>
              ))}
          </div>
        ) : (
          <p className="hint">这个主题里还没有别的已确认决定。先把新决定建成卡片并确认。</p>
        )}
        {(() => {
          const newer = groups.decisions.find((c) => c.id === newerId);
          const a = replacing ? cardDate(replacing) : null;
          const b = newer ? cardDate(newer) : null;
          return a && b && b < a ? (
            <Notice tone="warn">你选的「新」决定来源日期（{sourceDate(b)}）比旧决定（{sourceDate(a)}）还早。确定方向没有反吗？</Notice>
          ) : null;
        })()}
        <ErrorText>{act.error}</ErrorText>
      </Dialog>

      <CardFormDialog
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
        topicId={topic.id}
        onSaved={() => {
          setNoteOpen(false);
          void reload();
        }}
      />
    </div>
  );
}
