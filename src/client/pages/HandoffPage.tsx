import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { downloadText, get, post } from "../api";
import { useShell } from "../ui/shell";
import { AiSend } from "../ui/AiSend";
import type { CardData } from "../ui/CardView";
import { useAction, useLoad } from "../ui/hooks";
import { Badge, Button, Empty, ErrorText, Field, Loading, Notice, PageHeader, Panel, Segmented, SelectField, TextArea } from "../ui/kit";
import { FAMILIES, formatTime, typeLabel } from "../ui/labels";

type Built = { body: string; previewToken: string; excluded: Array<{ id: string; title: string; reason: string }>; included: Array<{ id: string }>; overflow: boolean; generatedAt: string };

export function HandoffPage() {
  const [sp, setSp] = useSearchParams();
  const shell = useShell();
  const topics = useLoad<{ topics: Array<{ id: string; label: string }> }>("/api/topics");
  const [topicId, setTopicId] = useState(sp.get("topic") ?? "");
  const [goal, setGoal] = useState("");
  const [variant, setVariant] = useState<"short" | "full">("short");
  const [cards, setCards] = useState<CardData[] | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [built, setBuilt] = useState<Built | null>(null);
  const [builtInput, setBuiltInput] = useState("");
  const [body, setBody] = useState("");
  const [dirty, setDirty] = useState(false);
  const [flash, setFlash] = useState("");
  const [polishWarn, setPolishWarn] = useState<string[]>([]);
  const act = useAction();

  useEffect(() => {
    setBuilt(null);
    if (!topicId) {
      setCards(null);
      return;
    }
    setCards(null);
    let active = true;
    get(`/api/cards?topicId=${encodeURIComponent(topicId)}`)
      .then((d) => {
        if (!active) return;
        const list = d.cards as CardData[];
        setCards(list);
        // 默认只勾已确认、有效的卡；待核对的要用户自己勾
        setSelected(Object.fromEntries(list.map((c) => [c.id, c.review_state === "confirmed" && Number(c.invalidated) === 0])));
      })
      .catch(() => { if (active) setCards([]); });
    return () => { active = false; };
  }, [topicId]);

  const grouped = useMemo(() => {
    const usable = (cards ?? []).filter((c) => c.review_state !== "rejected");
    return FAMILIES.map((f) => ({ ...f, cards: usable.filter((c) => f.types.includes(c.type as never)) })).filter((g) => g.cards.length);
  }, [cards]);

  const includeCardIds = Object.entries(selected)
    .filter(([, v]) => v)
    .map(([k]) => k);
  const pendingPicked = (cards ?? []).filter((c) => selected[c.id] && c.review_state === "pending").length;
  const inputKey = JSON.stringify({ topicId, goal, variant, includeCardIds });
  const selectionChanged = !!built && builtInput !== inputKey;

  async function generate() {
    if (dirty && !window.confirm("重新生成会覆盖你在右边改过的内容，继续吗？")) return;
    const d = await act.run(() => post("/api/handoffs/preview", { topicId, goal, variant, includeCardIds }));
    if (!d) return;
    setBuilt(d);
    setBuiltInput(inputKey);
    setBody(d.body);
    setDirty(false);
    setPolishWarn([]);
    setFlash("");
  }

  async function saveSnapshot() {
    return act.run(() => post("/api/handoffs", { topicId, goal, variant, includeCardIds, bodyText: body, previewToken: built?.previewToken }));
  }

  async function download() {
    const saved = await saveSnapshot();
    if (!saved) return;
    const label = topics.data?.topics.find((t) => t.id === topicId)?.label ?? "交接";
    downloadText(`续上交接-${label}-${formatTime(new Date().toISOString()).replace(/[: ]/g, "")}.md`, body);
    setFlash("已下载 Markdown，并在本机保存了一份交接快照。");
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(body);
      setFlash("已复制到剪贴板。");
    } catch {
      setFlash("浏览器不允许直接复制。请在右边正文里全选后手动复制。");
    }
  }

  const topicLabel = topics.data?.topics.find((t) => t.id === topicId)?.label;

  return (
    <div className="page">
      <PageHeader
        title="交接说明"
        lead="把一个主题的背景整理成一份说明，交给下一个 AI 或下一个人。不连模型也能生成；默认只用你确认过的卡片。"
      />
      <div className="layout-2">
        <div className="stack">
          <Panel title="1. 选主题，写目标">
            <SelectField
              label="主题"
              value={topicId}
              onChange={(e) => {
                setTopicId(e.target.value);
                const next = new URLSearchParams(sp);
                if (e.target.value) next.set("topic", e.target.value);
                else next.delete("topic");
                setSp(next, { replace: true });
              }}
            >
              <option value="">请选择</option>
              {(topics.data?.topics ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </SelectField>
            <TextArea
              label="这次希望对方解决什么"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="比如：在现有导入功能上加 Markdown 表格支持，不要动存储格式。"
            />
            <div style={{ marginTop: "0.85rem" }}>
              <Segmented
                label="篇幅"
                value={variant}
                onChange={setVariant}
                options={[
                  { value: "short", label: "短版（约 1500 字内）" },
                  { value: "full", label: "完整版" },
                ]}
              />
            </div>
          </Panel>

          <Panel title="2. 选要带上的卡片" hint="已确认的默认勾上；待核对的要自己勾，勾了会在正文里标成「非正式结论」。">
            {!topicId ? (
              <p className="hint">先选一个主题。</p>
            ) : !cards ? (
              <Loading />
            ) : grouped.length === 0 ? (
              <Empty title="这个主题还没有卡片">
                没有卡片也能生成，但只有目标和资料清单。先 <Link to={`/topics/${topicId}`}>去主题</Link> 打开资料、选中原文建卡。
              </Empty>
            ) : (
              grouped.map((g) => (
                <div className="pick-group" key={g.key}>
                  <h3>{g.label}</h3>
                  {g.cards.map((c) => {
                    const invalid = Number(c.invalidated) === 1;
                    return (
                      <label key={c.id} className={`pick${invalid ? " disabled" : ""}`}>
                        <input
                          type="checkbox"
                          disabled={invalid}
                          checked={!!selected[c.id]}
                          onChange={(e) => setSelected({ ...selected, [c.id]: e.target.checked })}
                        />
                        <span>
                          <span className="pick-title">{c.title}</span>{" "}
                          <span className="badges">
                            {g.types.length > 1 ? <Badge>{typeLabel(c.type)}</Badge> : null}
                            {invalid ? <Badge tone="bad">需重新核对，不能带</Badge> : c.review_state === "pending" ? <Badge tone="warn">待核对</Badge> : null}
                            {c.content_state === "replaced" ? <Badge>已被替代</Badge> : null}
                            {c.content_state === "user_resolved" ? <Badge>已解决</Badge> : null}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              ))
            )}
            <div className="form-actions">
              <Button tone="primary" busy={act.busy} disabled={!topicId || !goal.trim()} onClick={() => void generate()}>
                {built ? "重新生成" : "生成交接说明"}
              </Button>
              {!goal.trim() && topicId ? <span className="hint">先写下这次的目标。</span> : null}
              {pendingPicked ? <span className="hint">含 {pendingPicked} 条待核对候选</span> : null}
            </div>
            <ErrorText>{act.error}</ErrorText>
          </Panel>
        </div>

        <div className="stack">
          {!built ? (
            <Panel>
              <Empty title="交接说明会出现在这里">
                包括：本次目标、背景、已确认的决定、约束、试过的办法、未解决问题、仅供参考的内容和来源索引。生成后可以直接改。
              </Empty>
            </Panel>
          ) : (
            <Panel
              title={`3. 预览与修改${topicLabel ? ` · ${topicLabel}` : ""}`}
              hint={`生成于 ${formatTime(built.generatedAt)}${dirty ? " · 已手动修改" : ""}`}
              actions={
                <>
                  <Button disabled={selectionChanged} onClick={() => void copy()}>复制</Button>
                  <Button tone="primary" disabled={selectionChanged} busy={act.busy} onClick={() => void download()}>
                    下载 Markdown
                  </Button>
                </>
              }
            >
              {selectionChanged ? <Notice tone="warn">主题、目标或卡片选择已变化，请重新生成后再复制或下载。当前编辑内容仍保留。</Notice> : null}
              {flash ? (
                <Notice tone="ok" role="status">
                  {flash}
                </Notice>
              ) : null}
              {built.overflow ? (
                <Notice tone="warn" title="短版放不下全部内容">
                  决定、约束、试过的办法和未解决问题都保留了；其余的列在下面「没有包含」里。需要的话改用完整版。
                </Notice>
              ) : null}
              {polishWarn.map((w) => (
                <Notice tone="warn" key={w}>
                  {w}
                </Notice>
              ))}
              <Field label="交接正文（Markdown，可直接修改）" htmlFor="handoff-body">
                <textarea
                  id="handoff-body"
                  className="input textarea editor"
                  value={body}
                  onChange={(e) => {
                    setBody(e.target.value);
                    setDirty(true);
                  }}
                />
              </Field>
              {built.excluded.filter((x) => x.reason !== "你没有勾选").length ? (
                <details style={{ marginTop: "0.8rem" }}>
                  <summary>没有包含的 {built.excluded.filter((x) => x.reason !== "你没有勾选").length} 条及原因</summary>
                  <ul className="excluded">
                    {built.excluded
                      .filter((x) => x.reason !== "你没有勾选")
                      .map((x, i) => (
                        <li key={`${x.id}-${i}`}>
                          {x.title} <span>— {x.reason}</span>
                        </li>
                      ))}
                  </ul>
                </details>
              ) : null}
            </Panel>
          )}
          {built && !selectionChanged && shell.modelConfigured ? (
            <Panel title="用模型润色（可选）" hint="只把当前正文发给你的模型。润色不能添加资料里没有的事实；如果丢了风险标记，会提醒你。">
              <AiSend
                kind="polish"
                request={{ topicId, handoffBody: body }}
                sendLabel="确认发送，润色正文"
                onDone={(r) => {
                  setBody(r.body);
                  setDirty(true);
                  setPolishWarn(r.warnings ?? []);
                  setFlash("已用润色结果替换正文，请通读后再用。");
                }}
              />
            </Panel>
          ) : null}
        </div>
      </div>
    </div>
  );
}
