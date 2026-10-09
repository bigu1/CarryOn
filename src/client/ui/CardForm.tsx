import { useEffect, useState } from "react";
import { post } from "../api";
import { useAction } from "./hooks";
import { Button, Dialog, ErrorText, SelectField, TextArea, TextInput } from "./kit";
import { FAMILIES, typeLabel } from "./labels";

export function TypeOptions({ includeNote = true }: { includeNote?: boolean }) {
  return (
    <>
      {FAMILIES.filter((f) => includeNote || f.key !== "note").map((f) => (
        <optgroup key={f.key} label={f.label}>
          {f.types.map((t) => (
            <option key={t} value={t}>
              {typeLabel(t)}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

/** 从原文选中的一段建卡。引用由服务端按摘录重新定位并校验。 */
export function CardFormDialog({
  open,
  onClose,
  onSaved,
  topicId,
  messageId,
  quote,
  role,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (card: Record<string, any>) => void;
  topicId: string;
  messageId?: string;
  quote?: string;
  role?: string;
}) {
  const [type, setType] = useState("user_decision");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const act = useAction();

  useEffect(() => {
    if (!open) return;
    setType(!quote ? "user_note" : role === "assistant" ? "ai_suggestion" : role === "tool" ? "tool_report" : "user_decision");
    setTitle("");
    setBody(quote ?? "");
    act.setError("");
  }, [open, quote, role]); // eslint-disable-line react-hooks/exhaustive-deps

  const isNote = type === "user_note";

  async function save() {
    const r = await act.run(() =>
      post("/api/cards", {
        topicId,
        type,
        title,
        body,
        isUserNote: isNote,
        citations: !isNote && messageId && quote ? [{ messageId, quote }] : [],
      }),
    );
    if (r) onSaved(r.card);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={quote ? "用这段原文建卡" : "写一条备注"}
      wide
      actions={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button tone="primary" busy={act.busy} disabled={!title.trim() || !body.trim()} onClick={() => void save()}>
            保存卡片
          </Button>
        </>
      }
    >
      {quote ? (
        <div className="cite" style={{ marginBottom: "1rem" }}>
          <blockquote>{quote}</blockquote>
          <div className="cite-meta">
            {role === "assistant" ? "这句是 AI 说的。除非你后来明确采纳，否则应记成「AI 建议」。" : "引用会精确定位到这段原文。"}
          </div>
        </div>
      ) : null}
      <SelectField label="类型" value={type} onChange={(e) => setType(e.target.value)}>
        <TypeOptions includeNote />
      </SelectField>
      <TextInput label="标题" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="一句话概括，比如：首版只在本机保存" autoFocus />
      <TextArea label="内容" value={body} onChange={(e) => setBody(e.target.value)} hint="用自己的话概括。卡片保存后视为你已确认准确，可以随时修改。" />
      {isNote && quote ? <p className="hint">选了「用户备注」就不会附原文引用，它会标明不是从聊天提炼的事实。</p> : null}
      <ErrorText>{act.error}</ErrorText>
    </Dialog>
  );
}
