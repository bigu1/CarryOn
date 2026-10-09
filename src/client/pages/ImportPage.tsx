import { useState } from "react";
import { Link } from "react-router-dom";
import { post } from "../api";
import { useShell } from "../ui/shell";
import { useAction, useLoad } from "../ui/hooks";
import { Badge, Button, Check, ErrorText, Field, Notice, PageHeader, Panel, Segmented, TextArea, TextInput } from "../ui/kit";
import { ROLE_LABEL, ROLE_OPTIONS } from "../ui/labels";

const MAX_FILE = 5 * 1024 * 1024;

type PreviewItem = {
  title: string;
  topicLabel: string;
  sourceType: string;
  occurredAt: string | null;
  occurredAtPrecision: string;
  warnings: string[];
  filename?: string;
  duplicateOfSourceId?: string | null;
  revisionOfSourceId?: string | null;
  messages: Array<{ seq: number; role: string; originalLabel: string; text: string; warnings: string[] }>;
};
type Preview = { id: string; items: PreviewItem[]; rejected: Array<{ name: string; reason: string }> };
type Edit = { title: string; topicLabel: string; occurredAt: string; roles: string[]; skip: boolean };
type Result = { title: string; status: string; reason?: string; sourceId?: string };

const SOURCE_TYPE: Record<string, string> = { paste: "粘贴", txt: "TXT 文件", md: "Markdown 文件", json: "续上 JSON", synthetic: "合成资料" };
const STATUS: Record<string, { label: string; tone: "ok" | "info" | "warn" | "bad" | "neutral" }> = {
  created: { label: "已入库", tone: "ok" },
  duplicate: { label: "和已有资料相同，没有再存一份", tone: "info" },
  revised: { label: "已保存为新版本，相关卡片待重新核对", tone: "warn" },
  skipped: { label: "你选择了不导入", tone: "neutral" },
  failed: { label: "失败，未入库", tone: "bad" },
};

export function ImportPage() {
  const shell = useShell();
  const topics = useLoad<{ topics: Array<{ id: string; label: string }> }>("/api/topics");
  const [mode, setMode] = useState<"paste" | "file">("paste");
  const [paste, setPaste] = useState("");
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteWhole, setPasteWhole] = useState(false);
  const [topic, setTopic] = useState("");
  const [files, setFiles] = useState<Array<{ name: string; text: string; asWhole: boolean }>>([]);
  const [fileErr, setFileErr] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [edits, setEdits] = useState<Edit[]>([]);
  const [results, setResults] = useState<Result[] | null>(null);
  const act = useAction();

  async function addFiles(list: FileList | File[]) {
    const next: typeof files = [];
    const errs: string[] = [];
    for (const f of Array.from(list)) {
      if (f.size > MAX_FILE) {
        errs.push(`${f.name} 超过单文件 5 MiB，没有加入（不会截断）`);
        continue;
      }
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(await f.arrayBuffer());
        next.push({ name: f.name, text, asWhole: false });
      } catch {
        errs.push(`${f.name} 不是有效 UTF-8 文本，没有加入；请转换编码后重试`);
      }
    }
    setFileErr(errs.join("；"));
    setFiles((prev) => [...prev.filter((p) => !next.some((n) => n.name === p.name)), ...next]);
  }

  async function makePreview() {
    const data = await act.run(() =>
      post("/api/imports/preview", {
        paste: mode === "paste" ? paste : undefined,
        pasteTitle: mode === "paste" ? pasteTitle : undefined,
        pasteAsWhole: mode === "paste" ? pasteWhole : undefined,
        files: mode === "file" ? files : [],
        defaultTopic: topic,
      }),
    );
    if (!data) return;
    const p = data.preview as Preview;
    setPreview(p);
    setEdits(
      p.items.map((it) => ({
        title: it.title,
        topicLabel: it.topicLabel,
        occurredAt: it.occurredAt ?? "",
        roles: it.messages.map((m) => m.role),
        skip: !!it.duplicateOfSourceId,
      })),
    );
  }

  async function confirm() {
    if (!preview) return;
    const data = await act.run(() =>
      post("/api/imports/confirm", {
        previewId: preview.id,
        items: preview.items.map((it, index) => ({
          index,
          skip: edits[index]?.skip,
          title: edits[index]?.title,
          topicLabel: edits[index]?.topicLabel,
          occurredAt: edits[index]?.occurredAt.trim() ? edits[index].occurredAt.trim() : null,
          messages: it.messages.map((m, j) => ({ role: edits[index]?.roles[j] ?? m.role })),
        })),
      }),
    );
    if (!data) return;
    setResults(data.results);
    setPreview(null);
    shell.refresh();
    void topics.reload();
  }

  async function cancel() {
    if (preview) await post("/api/imports/cancel", { previewId: preview.id }).catch(() => {});
    setPreview(null);
  }

  function reset() {
    setResults(null);
    setPaste("");
    setPasteTitle("");
    setFiles([]);
  }

  const patch = (i: number, p: Partial<Edit>) => setEdits((prev) => prev.map((e, j) => (j === i ? { ...e, ...p } : e)));
  const step = results ? 3 : preview ? 2 : 1;
  const canPreview = mode === "paste" ? !!paste.trim() : files.length > 0;
  const toImport = edits.filter((e) => !e.skip).length;

  return (
    <div className="page narrow">
      <PageHeader
        title="添加聊天"
        lead="粘贴一段聊天，或选择 .txt / .md / 续上 JSON 文件。先看预览、改正说话人和日期，确认后才会保存。"
      />
      {shell.library === "demo" ? <Notice tone="warn">你现在在演示库，导入的内容会存进演示库，不进个人库。</Notice> : null}
      <ol className="steps" aria-label="导入步骤">
        {["放入聊天", "核对预览", "完成"].map((s, i) => (
          <li key={s} className={step === i + 1 ? "on" : step > i + 1 ? "done" : ""} aria-current={step === i + 1 ? "step" : undefined}>
            <span className="n">{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>

      {step === 1 ? (
        <Panel>
          <Segmented
            label="来源"
            value={mode}
            onChange={setMode}
            options={[
              { value: "paste", label: "粘贴文字" },
              { value: "file", label: "选择文件" },
            ]}
          />
          <div style={{ marginTop: "1rem" }}>
            {mode === "paste" ? (
              <>
                <TextArea
                  label="粘贴一段聊天"
                  className="input textarea tall"
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  placeholder={"用户：第一版先只在本机用。\n助手：可以考虑 SQLite。"}
                  hint="行首写「用户：」「助手：」「AI：」「assistant:」等会被识别成说话人；代码块和引用里的不算。认不出来就整段保存，下一步可以改。"
                />
                <div className="fields" style={{ marginTop: "0.85rem" }}>
                  <TextInput label="标题（可不填）" value={pasteTitle} onChange={(e) => setPasteTitle(e.target.value)} placeholder="不填就用第一句话" />
                </div>
                <div style={{ marginTop: "0.85rem" }}>
                  <Check label="不拆分，按整段导入" hint="自动识别分错时用这个" checked={pasteWhole} onChange={(e) => setPasteWhole(e.target.checked)} />
                </div>
              </>
            ) : (
              <>
                <div
                  className={`dropzone${dragOver ? " over" : ""}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    void addFiles(e.dataTransfer.files);
                  }}
                >
                  <p>{dragOver ? "松开就加入" : "把文件拖到这里，或者"}</p>
                  <label className="btn btn-sm" style={{ marginTop: "0.5rem" }}>
                    选择文件
                    <input
                      type="file"
                      multiple
                      accept=".txt,.md,.json,text/plain,text/markdown,application/json"
                      className="sr"
                      aria-label="选择聊天文件"
                      onChange={(e) => {
                        void addFiles(e.target.files ?? []);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <p className="hint" style={{ marginTop: "0.5rem" }}>
                    UTF-8 的 .txt / .md，或续上自己的 JSON v1。单个文件不超过 5 MiB，一次最多 50 个。
                  </p>
                </div>
                <ErrorText>{fileErr}</ErrorText>
                {files.length ? (
                  <ul className="file-list">
                    {files.map((f) => (
                      <li key={f.name}>
                        <span className="grow">{f.name}</span>
                        {!f.name.toLowerCase().endsWith(".json") ? (
                          <Check
                            label="按整段导入"
                            checked={f.asWhole}
                            onChange={(e) => setFiles((prev) => prev.map((x) => (x.name === f.name ? { ...x, asWhole: e.target.checked } : x)))}
                          />
                        ) : null}
                        <Button small tone="quiet" onClick={() => setFiles((prev) => prev.filter((x) => x.name !== f.name))}>
                          移除
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </div>
          <hr className="divider" />
          <Field label="归入主题" hint="可以选已有主题，也可以写新名字。留空时每份资料用自己的标题建主题。" htmlFor="import-topic">
            <input id="import-topic" className="input" list="topic-options" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="比如：资料保存方式" />
            <datalist id="topic-options">
              {(topics.data?.topics ?? []).map((t) => (
                <option key={t.id} value={t.label} />
              ))}
            </datalist>
          </Field>
          <div className="form-actions">
            <Button tone="primary" onClick={() => void makePreview()} busy={act.busy} disabled={!canPreview}>
              预览
            </Button>
            <span className="hint">预览不会保存任何东西。</span>
          </div>
          <ErrorText>{act.error}</ErrorText>
        </Panel>
      ) : null}

      {step === 2 && preview ? (
        <div className="stack">
          {preview.rejected.length ? (
            <Notice tone="bad" title={`${preview.rejected.length} 份没法导入`}>
              <ul style={{ paddingLeft: "1.1rem" }}>
                {preview.rejected.map((r, i) => (
                  <li key={`${r.name}-${i}`}>
                    {r.name}：{r.reason}
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {preview.items.length === 0 ? <Notice tone="warn">没有可以导入的资料。回到上一步换个文件再试，不会留下半份记录。</Notice> : null}
          {preview.items.map((it, i) => {
            const e = edits[i];
            if (!e) return null;
            return (
              <Panel
                key={i}
                title={`第 ${i + 1} 份 · ${it.messages.length} 段`}
                hint={`${SOURCE_TYPE[it.sourceType] ?? it.sourceType}${it.filename ? ` · ${it.filename}` : ""}`}
                actions={<Check label="这份不导入" checked={e.skip} onChange={(ev) => patch(i, { skip: ev.target.checked })} />}
              >
                {it.duplicateOfSourceId ? (
                  <Notice tone="info">
                    内容和已有资料完全相同，默认不导入。<Link to={`/sources/${it.duplicateOfSourceId}`}>看已有的那份</Link>
                  </Notice>
                ) : null}
                {it.revisionOfSourceId ? (
                  <Notice tone="warn">
                    同一编号的资料内容变了。确认后会存成新版本，旧版本保留，引用旧版的卡片会送回待核对。
                  </Notice>
                ) : null}
                {it.warnings.map((w) => (
                  <Notice tone="warn" key={w}>
                    {w}
                  </Notice>
                ))}
                <div className="fields" style={{ marginTop: "0.8rem" }}>
                  <TextInput label="标题" value={e.title} onChange={(ev) => patch(i, { title: ev.target.value })} />
                  <Field label="主题" htmlFor={`topic-${i}`}>
                    <input id={`topic-${i}`} className="input" list="topic-options-2" value={e.topicLabel} onChange={(ev) => patch(i, { topicLabel: ev.target.value })} />
                  </Field>
                  <TextInput
                    label="来源日期"
                    value={e.occurredAt}
                    onChange={(ev) => patch(i, { occurredAt: ev.target.value })}
                    placeholder="未知"
                    hint="聊天发生的日期，如 2026-09-05。不知道就留空，不会拿导入时间代替。"
                  />
                </div>
                <div className="preview-msgs">
                  {it.messages.map((m, j) => (
                    <div className="preview-msg" key={m.seq}>
                      <div>
                        <select
                          className="input input-sm"
                          aria-label={`第 ${j + 1} 段说话人`}
                          value={e.roles[j]}
                          onChange={(ev) => {
                            const roles = [...e.roles];
                            roles[j] = ev.target.value;
                            patch(i, { roles });
                          }}
                        >
                          {ROLE_OPTIONS.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                        <div className="orig">原文标签：{m.originalLabel}</div>
                      </div>
                      <div>
                        <div className="msg-text">{m.text}</div>
                        {m.warnings.map((w) => (
                          <p className="hint" key={w} style={{ color: "var(--warn)" }}>
                            {w}
                          </p>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Panel>
            );
          })}
          <datalist id="topic-options-2">
            {(topics.data?.topics ?? []).map((t) => (
              <option key={t.id} value={t.label} />
            ))}
          </datalist>
          <Panel className="flat">
            <div className="row-between">
              <span>
                将导入 <strong>{toImport}</strong> 份，跳过 {edits.length - toImport} 份。
              </span>
              <div className="row">
                <Button onClick={() => void cancel()}>取消，不导入</Button>
                <Button tone="primary" onClick={() => void confirm()} busy={act.busy} disabled={toImport === 0}>
                  确认导入
                </Button>
              </div>
            </div>
            <ErrorText>{act.error}</ErrorText>
          </Panel>
        </div>
      ) : null}

      {step === 3 && results ? (
        <Panel title="导入结果">
          <ul className="list">
            {results.map((r, i) => {
              const s = STATUS[r.status] ?? STATUS.failed;
              return (
                <li className="list-row" key={`${r.title}-${i}`}>
                  <div className="list-row-main">
                    {r.sourceId && r.status !== "failed" ? (
                      <Link className="list-row-title" to={`/sources/${r.sourceId}`}>
                        {r.title}
                      </Link>
                    ) : (
                      <span className="list-row-title">{r.title}</span>
                    )}
                    {r.reason ? <div className="list-row-meta">{r.reason}</div> : null}
                  </div>
                  <Badge tone={s.tone}>{s.label}</Badge>
                </li>
              );
            })}
          </ul>
          <div className="form-actions">
            {results.find((r) => r.sourceId && r.status !== "failed") ? (
              <Link className="btn btn-primary" to={`/sources/${results.find((r) => r.sourceId && r.status !== "failed")!.sourceId}`}>
                打开资料，开始整理
              </Link>
            ) : null}
            <Button onClick={reset}>再导入一份</Button>
            <Link className="btn btn-quiet" to="/sources">
              全部资料
            </Link>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
