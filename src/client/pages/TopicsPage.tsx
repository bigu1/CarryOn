import { useState } from "react";
import { Link } from "react-router-dom";
import { post } from "../api";
import { useAction, useLoad } from "../ui/hooks";
import { Badge, Button, Empty, ErrorText, LinkButton, Loading, Notice, PageHeader, Panel } from "../ui/kit";
import { sourceDate } from "../ui/labels";

export function TopicsPage() {
  const { data, error, loading, reload } = useLoad<{ topics: Array<Record<string, any>> }>("/api/topics");
  const [label, setLabel] = useState("");
  const act = useAction();
  const topics = data?.topics ?? [];

  async function add() {
    const r = await act.run(() => post("/api/topics", { label }));
    if (r) {
      setLabel("");
      await reload();
    }
  }

  return (
    <div className="page">
      <PageHeader title="主题" lead="同一件事的多段聊天放在一个主题下，决定、问题和交接都按主题整理。" />
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <Panel>
        {loading && !data ? (
          <Loading />
        ) : topics.length === 0 ? (
          <Empty title="还没有主题" actions={<LinkButton to="/import" tone="primary">添加聊天</LinkButton>}>
            导入聊天时会自动建主题，也可以在下面先建一个。
          </Empty>
        ) : (
          <ul className="list">
            {topics.map((t) => (
              <li className="list-row" key={t.id}>
                <div className="list-row-main">
                  <Link className="list-row-title" to={`/topics/${t.id}`}>
                    {t.label}
                  </Link>
                  <div className="list-row-meta">
                    <span>{t.source_count} 份资料</span>
                    <span>{t.confirmed_count} 条已确认</span>
                    <span>{t.latest_occurred_at ? `资料截至 ${sourceDate(t.latest_occurred_at)}` : "来源日期未知"}</span>
                  </div>
                </div>
                <span className="badges">
                  {Number(t.open_count) > 0 ? <Badge tone="info">{t.open_count} 个未决问题</Badge> : null}
                  {Number(t.pending_count) > 0 ? <Badge tone="warn">待核对 {t.pending_count}</Badge> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="新建主题">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input className="input grow" style={{ maxWidth: "24rem" }} aria-label="新主题名称" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="比如：资料保存方式" />
          <Button type="submit" busy={act.busy} disabled={!label.trim()}>
            添加
          </Button>
        </form>
        <ErrorText>{act.error}</ErrorText>
      </Panel>
    </div>
  );
}
