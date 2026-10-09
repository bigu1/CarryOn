import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useLoad } from "../ui/hooks";
import { Empty, LinkButton, Loading, Notice, PageHeader, Panel } from "../ui/kit";
import { formatTime, sourceDate } from "../ui/labels";

const TYPE: Record<string, string> = { paste: "粘贴", txt: "TXT", md: "Markdown", json: "JSON", synthetic: "合成" };

export function SourcesPage() {
  const { data, error, loading } = useLoad<{ sources: Array<Record<string, any>> }>("/api/sources");
  const topics = useLoad<{ topics: Array<{ id: string; label: string }> }>("/api/topics");
  const [filter, setFilter] = useState("");
  const [topicId, setTopicId] = useState("");

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (data?.sources ?? []).filter(
      (s) => (!topicId || s.topic_id === topicId) && (!f || String(s.title).toLowerCase().includes(f)),
    );
  }, [data, filter, topicId]);

  return (
    <div className="page">
      <PageHeader
        title="全部资料"
        lead="你导入过的每一段聊天。按标题筛选；要搜原文内容请用「查找与回答」。"
        actions={
          <>
            <LinkButton to="/answers">搜原文</LinkButton>
            <LinkButton to="/import" tone="primary">
              添加聊天
            </LinkButton>
          </>
        }
      />
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <Panel>
        <div className="fields" style={{ marginBottom: "0.9rem" }}>
          <input className="input" aria-label="按标题筛选" placeholder="按标题筛选" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <select className="input select" aria-label="按主题筛选" value={topicId} onChange={(e) => setTopicId(e.target.value)}>
            <option value="">全部主题</option>
            {(topics.data?.topics ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        {loading && !data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty
            title={(data?.sources ?? []).length ? "没有符合筛选的资料" : "还没有资料"}
            actions={(data?.sources ?? []).length ? null : <LinkButton to="/import" tone="primary">添加聊天</LinkButton>}
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>标题</th>
                  <th>主题</th>
                  <th>来源日期</th>
                  <th>段数</th>
                  <th>导入时间</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link to={`/sources/${s.id}`}>{s.title}</Link>
                      <div className="hint">{TYPE[s.source_type] ?? s.source_type}</div>
                    </td>
                    <td>
                      <Link to={`/topics/${s.topic_id}`}>{s.topic_label}</Link>
                    </td>
                    <td>{sourceDate(s.occurred_at)}</td>
                    <td>{s.message_count}</td>
                    <td className="hint">{formatTime(s.imported_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
