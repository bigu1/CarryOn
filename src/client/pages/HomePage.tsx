import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { post, switchLibrary } from "../api";
import { useShell } from "../ui/shell";
import { useAction, useLoad } from "../ui/hooks";
import { Badge, Button, Empty, ErrorText, LinkButton, Loading, Notice, PageHeader, Panel } from "../ui/kit";
import { formatTime, sourceDate } from "../ui/labels";

type Topic = Record<string, any>;

export function HomePage() {
  const nav = useNavigate();
  const shell = useShell();
  const { data, error, loading, reload } = useLoad("/api/home");
  const demo = useAction();
  const [q, setQ] = useState("");

  async function startDemo() {
    await demo.run(async () => {
      await switchLibrary("demo");
      shell.setLibrary("demo");
      await post("/api/imports/demo");
      shell.refresh();
      await reload();
      nav("/topics");
    });
  }

  if (loading && !data) return <Loading />;
  if (error) return <Notice tone="bad" title="读取失败">{error}</Notice>;
  const topics = (data?.topics ?? []) as Topic[];
  const sources = (data?.recentSources ?? []) as Array<Record<string, any>>;
  const counts = data?.counts ?? { sources: 0 };
  const pending = Number(data?.pending ?? 0);
  const empty = Number(counts.sources) === 0;

  return (
    <div className="page">
      <PageHeader
        title="接着上次聊"
        lead="把旧聊天整理成能回溯的决定、还没解决的问题，以及交给下一个 AI 的背景。资料只在这台电脑上，不连模型也能用。"
        actions={
          <>
            <LinkButton to="/import" tone="primary">
              添加聊天
            </LinkButton>
            {shell.library === "personal" ? (
              <Button onClick={() => void startDemo()} busy={demo.busy}>
                用演示资料体验
              </Button>
            ) : null}
          </>
        }
      />
      <ErrorText>{demo.error}</ErrorText>
      {shell.library === "demo" ? (
        <Notice tone="warn" title="你在演示库里">
          这里只有虚构的合成聊天，和你的个人资料分开保存。到「设置与数据」可以切回个人库。
        </Notice>
      ) : null}

      {empty ? (
        <Panel>
          <Empty
            title={shell.library === "demo" ? "演示库还是空的" : "个人库还是空的"}
            actions={
              <>
                <LinkButton to="/import" tone="primary">
                  粘贴或导入一段聊天
                </LinkButton>
                {shell.library === "demo" ? (
                  <Button busy={demo.busy} onClick={() => void startDemo()}>
                    写入演示资料
                  </Button>
                ) : null}
              </>
            }
          >
            续上不会自动读取 Codex、Cursor、ChatGPT 的聊天记录，也不会扫描硬盘。你主动贴进来或选中的文件才会被保存。
          </Empty>
        </Panel>
      ) : (
        <>
          <div className="tasks" style={{ marginTop: "0.5rem" }}>
            <Panel className="task">
              <h2>找回当时的决定</h2>
              <p>输入关键词，直接看到原话和相关卡片。</p>
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  nav(`/answers?q=${encodeURIComponent(q)}`);
                }}
              >
                <input className="input grow" aria-label="查找关键词" placeholder="比如：云同步" value={q} onChange={(e) => setQ(e.target.value)} />
                <Button type="submit" tone="primary">
                  查找
                </Button>
              </form>
            </Panel>
            <Panel className="task">
              <h2>核对整理出的卡片</h2>
              <p>{pending > 0 ? `有 ${pending} 条等你确认、修改或拒绝。` : "眼下没有待核对的卡片。可以在原文里选一段话建卡。"}</p>
              <div className="grow-space" />
              <div>
                <LinkButton to="/review" tone={pending > 0 ? "primary" : "default"}>
                  {pending > 0 ? `去核对 ${pending} 条` : "打开待核对"}
                </LinkButton>
              </div>
            </Panel>
            <Panel className="task">
              <h2>交给下一个 AI</h2>
              <p>选一个主题，写下这次要对方做什么，生成背景说明。</p>
              <div className="grow-space" />
              <div>
                <LinkButton to="/handoff">写交接说明</LinkButton>
              </div>
            </Panel>
          </div>

          <div className="layout-side" style={{ marginTop: "1.25rem" }}>
            <Panel title="最近的主题" actions={<LinkButton to="/topics" tone="quiet" small>全部主题</LinkButton>}>
              {topics.length === 0 ? (
                <Empty title="还没有主题" />
              ) : (
                <ul className="list">
                  {topics.slice(0, 8).map((t) => (
                    <li className="list-row" key={t.id}>
                      <div className="list-row-main">
                        <Link className="list-row-title" to={`/topics/${t.id}`}>
                          {t.label}
                        </Link>
                        <div className="list-row-meta">
                          <span>{t.source_count} 份资料</span>
                          <span>{t.confirmed_count} 条已确认</span>
                          {t.latest_occurred_at ? <span>资料截至 {sourceDate(t.latest_occurred_at)}</span> : <span>来源日期未知</span>}
                        </div>
                      </div>
                      <span className="badges">
                        {Number(t.open_count) > 0 ? <Badge tone="info">{t.open_count} 个未决问题</Badge> : null}
                        {Number(t.pending_count) > 0 ? <Badge tone="warn">{t.pending_count} 条待核对</Badge> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="最近导入" actions={<LinkButton to="/sources" tone="quiet" small>全部资料</LinkButton>}>
              <ul className="list">
                {sources.map((s) => (
                  <li className="list-row" key={s.id}>
                    <div className="list-row-main">
                      <Link className="list-row-title" to={`/sources/${s.id}`}>
                        {s.title}
                      </Link>
                      <div className="list-row-meta">
                        <span>{s.topic_label}</span>
                        <span>导入于 {formatTime(s.imported_at)}</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
