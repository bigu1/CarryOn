import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { del, get, patch } from "../api";
import { useShell } from "../ui/shell";
import { CardFormDialog } from "../ui/CardForm";
import { useAction, useLoad } from "../ui/hooks";
import { Badge, Button, Dialog, ErrorText, Loading, Notice, PageHeader, Panel, TextInput } from "../ui/kit";
import { formatTime, ROLE_LABEL, ROLE_OPTIONS, roleLabel, sourceDate } from "../ui/labels";

type Msg = { id: string; role: string; original_label: string; text: string; seq: number };

function MessageText({ text, quote }: { text: string; quote: string }) {
  const at = quote ? text.indexOf(quote) : -1;
  if (at < 0) return <div className="msg-text">{text}</div>;
  return (
    <div className="msg-text">
      {text.slice(0, at)}
      <mark>{quote}</mark>
      {text.slice(at + quote.length)}
    </div>
  );
}

export function SourceDetailPage() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const shell = useShell();
  const target = sp.get("msg");
  const quote = sp.get("quote") ?? "";
  const revision = sp.get("revision") ?? "";
  const from = sp.get("from") ?? "";
  const path = id ? `/api/sources/${id}${revision ? `?revision=${encodeURIComponent(revision)}` : ""}` : null;
  const { data, error, loading, reload } = useLoad(path);

  const [fixRoles, setFixRoles] = useState(false);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [editMeta, setEditMeta] = useState(false);
  const [meta, setMeta] = useState({ title: "", topicLabel: "", occurredAt: "" });
  const [deleting, setDeleting] = useState(false);
  const [impact, setImpact] = useState<Record<string, number> | null>(null);
  const [selection, setSelection] = useState<{ messageId: string; quote: string; role: string } | null>(null);
  const [cardFor, setCardFor] = useState<{ messageId?: string; quote?: string; role?: string } | null>(null);
  const [saved, setSaved] = useState("");
  const act = useAction();

  const source = data?.source as Record<string, any> | undefined;
  const messages = (data?.messages ?? []) as Msg[];
  const cards = (data?.cards ?? []) as Array<Record<string, any>>;
  const historical = !!data?.isHistoricalRevision;
  const cardsByMsg = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cards) m.set(c.message_id, (m.get(c.message_id) ?? 0) + 1);
    return m;
  }, [cards]);

  useEffect(() => {
    if (!target || !messages.length) return;
    document.getElementById(`m-${target}`)?.scrollIntoView({ block: "center" });
  }, [target, messages.length]);

  useEffect(() => {
    if (historical) return;
    const onUp = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? "";
      if (!sel || !text || sel.rangeCount === 0) return setSelection(null);
      const a = (sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement)?.closest("[data-msg]");
      const f = (sel.focusNode instanceof Element ? sel.focusNode : sel.focusNode?.parentElement)?.closest("[data-msg]");
      if (!a || a !== f) return setSelection(null);
      const msg = messages.find((m) => m.id === a.getAttribute("data-msg"));
      if (!msg || !msg.text.includes(text)) return setSelection(null);
      setSelection({ messageId: msg.id, quote: text, role: msg.role });
    };
    document.addEventListener("mouseup", onUp);
    document.addEventListener("keyup", onUp);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("keyup", onUp);
    };
  }, [messages, historical]);

  if (loading && !data) return <Loading>正在打开原文…</Loading>;
  if (error || !source) {
    return (
      <div className="page narrow">
        <Notice tone="bad" title="打不开这份资料">
          {error || "资料不存在"}。如果刚删除过，它的原文和卡片内容已经清除。
        </Notice>
        <p style={{ marginTop: "1rem" }}>
          <Link to="/sources">回到全部资料</Link>
        </p>
      </div>
    );
  }

  async function saveRoles() {
    const changed = messages.filter((m) => roles[m.id] && roles[m.id] !== m.role).map((m) => ({ id: m.id, role: roles[m.id] }));
    if (!changed.length) return setFixRoles(false);
    const r = await act.run(() => patch(`/api/sources/${id}`, { messages: changed }));
    if (!r) return;
    setFixRoles(false);
    setRoles({});
    setSaved(`已更正 ${changed.length} 段的说话人。引用这些段落的卡片已送回「待核对」，需要你重新确认。`);
    shell.refresh();
    await reload();
  }

  async function saveMeta() {
    const r = await act.run(() =>
      patch(`/api/sources/${id}`, { title: meta.title, topicLabel: meta.topicLabel, occurredAt: meta.occurredAt.trim() || null }),
    );
    if (!r) return;
    setEditMeta(false);
    setSaved("资料信息已保存。");
    await reload();
  }

  async function openDelete() {
    setDeleting(true);
    setImpact(null);
    const d = await act.run(() => get(`/api/sources/${id}/impact`));
    if (d) setImpact(d.impact);
  }

  async function doDelete() {
    const r = await act.run(() => del(`/api/sources/${id}`));
    if (!r) return;
    shell.refresh();
    nav("/sources");
  }

  const revisions = (data?.revisions ?? []) as Array<{ id: string; version: number; created_at: string }>;

  return (
    <div className="page narrow">
      <PageHeader
        back={from ? <Link to={from}>← 返回刚才的位置</Link> : <Link to="/sources">← 全部资料</Link>}
        title={source.title}
        lead={
          <span className="row" style={{ gap: "0.9rem" }}>
            <span>
              主题 <Link to={`/topics/${source.topic_id}`}>{source.topic_label}</Link>
            </span>
            <span>来源日期 {sourceDate(source.occurred_at)}</span>
            <span className="hint">导入于 {formatTime(source.imported_at)}（导入时间不代表聊天发生时间）</span>
          </span>
        }
        actions={
          historical ? null : (
            <>
              <Button
                onClick={() => {
                  setMeta({ title: source.title, topicLabel: source.topic_label, occurredAt: source.occurred_at ?? "" });
                  setEditMeta(true);
                }}
              >
                改标题 / 主题 / 日期
              </Button>
              <Button onClick={() => setFixRoles((v) => !v)}>{fixRoles ? "取消更正" : "更正说话人"}</Button>
              <Button onClick={() => setCardFor({})}>写备注</Button>
            </>
          )
        }
      />

      {historical ? (
        <Notice tone="warn" title="你在看旧版本" actions={<Link to={`/sources/${id}`}>看当前版本</Link>}>
          这份资料后来有了新版本。这里是被引用时的原文，不是当前内容。
        </Notice>
      ) : null}
      {!historical && revisions.length > 1 ? (
        <Notice tone="info">
          这份资料有 {revisions.length} 个版本，当前是第 {revisions[0].version} 版。
          {revisions.slice(1).map((r) => (
            <Link key={r.id} to={`/sources/${id}?revision=${r.id}`} style={{ marginLeft: "0.6rem" }}>
              第 {r.version} 版
            </Link>
          ))}
        </Notice>
      ) : null}
      {saved ? (
        <Notice tone="ok" role="status">
          {saved}
        </Notice>
      ) : null}
      {!historical && !fixRoles ? (
        <p className="hint" style={{ margin: "0.8rem 0" }}>
          用鼠标选中一段原文，就能把它做成卡片（决定、问题、约束……），引用会精确指回这里。
        </p>
      ) : null}
      {fixRoles ? (
        <Notice tone="info" title="更正说话人">
          改完点「保存更正」。被引用段落的说话人变了，相关卡片会送回待核对。
        </Notice>
      ) : null}

      <Panel className="thread-panel">
        <div className="thread">
          {messages.map((m) => (
            <article key={m.id} id={`m-${m.id}`} className={`msg${target === m.id ? " target" : ""}`}>
              <div className={`msg-role ${m.role}`}>
                {fixRoles ? (
                  <select
                    className="input input-sm"
                    aria-label={`第 ${m.seq + 1} 段说话人`}
                    value={roles[m.id] ?? m.role}
                    onChange={(e) => setRoles((r) => ({ ...r, [m.id]: e.target.value }))}
                  >
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                ) : (
                  roleLabel(m.role)
                )}
                {m.original_label && m.original_label !== roleLabel(m.role) ? <small>原标签：{m.original_label}</small> : null}
              </div>
              <div data-msg={m.id}>
                <MessageText text={m.text} quote={target === m.id ? quote : ""} />
                {!historical && !fixRoles ? (
                  <div className="msg-foot">
                    {cardsByMsg.get(m.id) ? <Badge tone="accent">{cardsByMsg.get(m.id)} 张卡引用</Badge> : null}
                    <Button small tone="quiet" onClick={() => setCardFor({ messageId: m.id, quote: m.text, role: m.role })}>
                      整段建卡
                    </Button>
                  </div>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </Panel>
      {fixRoles ? (
        <Panel className="flat">
          <div className="row">
            <Button tone="primary" busy={act.busy} onClick={() => void saveRoles()}>
              保存更正
            </Button>
            <Button onClick={() => setFixRoles(false)}>取消</Button>
          </div>
          <ErrorText>{act.error}</ErrorText>
        </Panel>
      ) : null}

      {!historical ? (
        <Panel className="danger" title="删除这份资料" hint="原文、搜索结果、引用它的卡片内容、相关回答和交接都会被清除。你以前下载到别处的备份不会自动删除。">
          <Button tone="danger" onClick={() => void openDelete()}>
            删除…
          </Button>
        </Panel>
      ) : null}

      {selection && !cardFor ? (
        <div className="selection-bar" role="status">
          <span>已选：{selection.quote}</span>
          <Button small tone="primary" onClick={() => setCardFor(selection)}>
            用选中的文字建卡
          </Button>
          <button type="button" className="icon-btn" style={{ color: "#fff" }} aria-label="取消选择" onClick={() => setSelection(null)}>
            ×
          </button>
        </div>
      ) : null}

      <CardFormDialog
        open={!!cardFor}
        onClose={() => setCardFor(null)}
        topicId={String(source.topic_id)}
        messageId={cardFor?.messageId}
        quote={cardFor?.quote}
        role={cardFor?.role}
        onSaved={(card) => {
          setCardFor(null);
          setSelection(null);
          window.getSelection()?.removeAllRanges();
          setSaved(`已保存卡片「${card.title}」。`);
          shell.refresh();
          void reload();
        }}
      />

      <Dialog
        open={editMeta}
        onClose={() => setEditMeta(false)}
        title="改资料信息"
        actions={
          <>
            <Button onClick={() => setEditMeta(false)}>取消</Button>
            <Button tone="primary" busy={act.busy} onClick={() => void saveMeta()}>
              保存
            </Button>
          </>
        }
      >
        <TextInput label="标题" value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} />
        <TextInput
          label="主题"
          value={meta.topicLabel}
          onChange={(e) => setMeta({ ...meta, topicLabel: e.target.value })}
          hint="换主题时，只引用这份资料的卡片会一起移过去。"
        />
        <TextInput
          label="来源日期"
          value={meta.occurredAt}
          onChange={(e) => setMeta({ ...meta, occurredAt: e.target.value })}
          placeholder="未知"
          hint="如 2026-09-05；不知道就留空。"
        />
        <ErrorText>{act.error}</ErrorText>
      </Dialog>

      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="确定删除这份资料？"
        actions={
          <>
            <Button onClick={() => setDeleting(false)}>不删了</Button>
            <Button tone="danger" busy={act.busy} disabled={!impact} onClick={() => void doDelete()}>
              确认删除
            </Button>
          </>
        }
      >
        {impact ? (
          <div className="stack">
            <p>
              「{source.title}」的原文会被清除。同时会让 <strong>{impact.cards}</strong> 张卡片失效并清掉内容，<strong>{impact.answers}</strong>{" "}
              份已保存的回答、<strong>{impact.handoffs}</strong> 份交接快照失效。
            </p>
            <p className="hint">你以前下载到别处的备份或交接文件不会被自动删除。这不是磁盘取证级擦除。</p>
          </div>
        ) : (
          <Loading>正在统计影响…</Loading>
        )}
        <ErrorText>{act.error}</ErrorText>
      </Dialog>
    </div>
  );
}
