import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { get, post } from "../api";
import { useShell } from "./shell";
import { useAction } from "./hooks";
import { Button, ErrorText, Notice } from "./kit";

export type Scope = Record<string, any>;

/** 未连接模型时的统一说明：给出不用模型的替代做法，不放假按钮。 */
export function NeedsModel({ alt }: { alt: ReactNode }) {
  return (
    <Notice tone="info" title="需要连接模型">
      这一步要用你自己的模型服务，地址、模型名和凭据在 <Link to="/settings">设置与数据</Link> 里填，只保存在本次运行中。{alt}
    </Notice>
  );
}

/** 发送前的范围确认：先看要发什么、发到哪，再由用户点发送；发送中可以取消。 */
export function AiSend({
  kind,
  request,
  onDone,
  sendLabel,
  previewLabel = "先看要发送的范围",
}: {
  kind: "extract" | "answer" | "polish";
  request: Record<string, unknown>;
  onDone: (result: Record<string, any>) => void;
  sendLabel: string;
  previewLabel?: string;
}) {
  const shell = useShell();
  const [scope, setScope] = useState<Scope | null>(null);
  const [sending, setSending] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const act = useAction();
  const requestKey = JSON.stringify(request);
  useEffect(() => { setScope(null); setCancelled(false); }, [requestKey, kind]);

  async function preview() {
    setCancelled(false);
    const d = await act.run(() => post("/api/ai/preview-scope", { ...request, kind }));
    if (d) setScope(d);
  }

  async function send() {
    setSending(true);
    setCancelled(false);
    const r = await act.run(() => post(`/api/ai/${kind}`, { ...request, previewToken: scope?.previewToken, confirmSend: true }));
    setSending(false);
    if (r) {
      setScope(null);
      onDone(r);
    }
    shell.refresh();
  }

  async function cancel() {
    const r = await get("/api/ai/jobs/running").catch(() => null);
    if (r?.job?.id) await post(`/api/ai/jobs/${r.job.id}/cancel`).catch(() => {});
    setCancelled(true);
  }

  if (!shell.modelConfigured) return null;
  const canSend = scope && Number(scope.segments) > 0;

  return (
    <div className="stack">
      {!scope ? (
        <div className="row">
          <Button onClick={() => void preview()} busy={act.busy && !sending}>
            {previewLabel}
          </Button>
        </div>
      ) : (
        <Notice tone={canSend ? "info" : "warn"} title={canSend ? `将发送到 ${scope.target}（${scope.model}）` : "这次没有可以发送的内容"}>
          <ul style={{ paddingLeft: "1.1rem" }}>
            {kind === "polish" ? (
              <li>只发送当前交接正文，共 {scope.sendChars} 字；不发送原始聊天。</li>
            ) : (
              <>
                <li>
                  范围：{scope.scopeMode === "all" ? "全部已导入资料" : scope.scopeMode === "topic" ? "这个主题的资料" : "选中的资料"}，共{" "}
                  {scope.sources?.length ?? 0} 份、{scope.messageCount} 段。
                </li>
                <li>
                  实际发送：{scope.sendMessageCount} 段原文
                  {scope.sendCardCount ? `、${scope.sendCardCount} 张卡片` : ""}，约 {scope.sendChars} 字
                  {kind === "extract" && scope.segments > 1 ? `，分 ${scope.segments} 次发送` : ""}。
                </li>
                {scope.sources?.length ? (
                  <li>
                    涉及：
                    {scope.sources
                      .filter((s: Record<string, any>) => s.sendCount > 0)
                      .map((s: Record<string, any>) => `${s.title}（${s.sendCount} 段）`)
                      .join("、") || "无"}
                  </li>
                ) : null}
              </>
            )}
            {scope.note ? <li>{scope.note}</li> : null}
            <li>费用未知，按你的服务计费。失败最多自动重试一次。</li>
          </ul>
          <div className="notice-actions">
            {canSend ? (
              <Button tone="primary" busy={sending} onClick={() => void send()}>
                {sendLabel}
              </Button>
            ) : null}
            {sending ? (
              <Button tone="danger" onClick={() => void cancel()}>
                取消发送
              </Button>
            ) : (
              <Button onClick={() => setScope(null)}>不发送</Button>
            )}
          </div>
        </Notice>
      )}
      {cancelled ? <Notice tone="warn">已请求取消。迟到的结果不会写入。</Notice> : null}
      <ErrorText>{act.error}</ErrorText>
    </div>
  );
}
