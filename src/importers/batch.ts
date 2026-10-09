import { LIMITS } from "../shared/limits.js";
import { id, nowIso } from "../shared/ids.js";
import type { ImportPreview, PreviewConversation } from "../domain/types.js";
import type { Store } from "../storage/db.js";
import { documentToPreviews, parseJsonV1 } from "./json.js";
import { looksBinary, parseUtf8Text } from "./text.js";

export interface ImportInput {
  paste?: string;
  pasteTitle?: string;
  pasteAsWhole?: boolean;
  files?: Array<{ name: string; text?: string; base64?: string; asWhole?: boolean }>;
  /** 这一批统一归入的主题；为空时每份资料用自己的标题当主题 */
  defaultTopic?: string;
}

/**
 * 把一批输入变成预览。只读库（查重复 / 修订），不写库。
 * 失败项逐份列在 rejected，不会因为一份坏文件拖累整批。
 */
export function previewBatch(st: Store, body: ImportInput): ImportPreview | { error: string } {
  const items: PreviewConversation[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];
  const files = body.files ?? [];
  if (files.length > LIMITS.filesPerBatch) return { error: `一次最多 ${LIMITS.filesPerBatch} 个文件` };
  let total = 0;

  if (body.paste?.trim()) {
    const bytes = Buffer.byteLength(body.paste, "utf8");
    total += bytes;
    if (bytes > LIMITS.fileBytes) {
      rejected.push({ name: "粘贴文本", reason: `超过单份 ${LIMITS.fileBytes} 字节，不会静默截断` });
    } else {
      const parsed = parseUtf8Text(body.paste, {
        title: body.pasteTitle?.trim() ?? "",
        sourceType: "paste",
        asWhole: body.pasteAsWhole,
      });
      if ("error" in parsed) rejected.push({ name: "粘贴文本", reason: parsed.error });
      else items.push(parsed);
    }
  }

  for (const f of files) {
    let text = f.text ?? "";
    const buf = f.base64 ? Buffer.from(f.base64, "base64") : Buffer.from(text, "utf8");
    if (buf.length > LIMITS.fileBytes) {
      rejected.push({ name: f.name, reason: `超过单文件 ${LIMITS.fileBytes} 字节，不会静默截断` });
      continue;
    }
    if (looksBinary(buf)) {
      rejected.push({ name: f.name, reason: "看起来是二进制或乱码，已拒绝" });
      continue;
    }
    total += buf.length;
    if (f.base64) text = buf.toString("utf8");
    if (total > LIMITS.batchBytes) {
      rejected.push({ name: f.name, reason: `超过单次合计 ${LIMITS.batchBytes} 字节` });
      continue;
    }
    const lower = f.name.toLowerCase();
    if (lower.endsWith(".json")) {
      const parsed = parseJsonV1(text);
      if (!parsed.ok) {
        rejected.push({ name: f.name, reason: parsed.reason });
        continue;
      }
      items.push(...documentToPreviews(parsed.doc, "json", f.name));
    } else if (lower.endsWith(".md") || lower.endsWith(".txt") || !f.name.includes(".")) {
      const parsed = parseUtf8Text(text, {
        title: f.name.replace(/\.(md|txt)$/i, "") || "未命名",
        sourceType: lower.endsWith(".md") ? "md" : "txt",
        asWhole: f.asWhole,
        filename: f.name,
      });
      if ("error" in parsed) rejected.push({ name: f.name, reason: parsed.error });
      else items.push(parsed);
    } else {
      rejected.push({ name: f.name, reason: "未知格式。首版支持粘贴、.txt、.md 和续上 JSON v1" });
    }
  }

  const kept: PreviewConversation[] = [];
  for (const it of items) {
    if (it.messages.some((m) => m.text.includes("\u0000"))) {
      rejected.push({ name: it.filename ?? it.title, reason: "含有空字符，已拒绝，不会留下半份资料" });
      continue;
    }
    if (it.messages.some((m) => m.text.length > LIMITS.messageChars)) {
      rejected.push({ name: it.filename ?? it.title, reason: `单条消息超过 ${LIMITS.messageChars} 字，不会静默截断` });
      continue;
    }
    const topic = body.defaultTopic?.trim();
    it.topicLabel = topic || it.topicLabel || it.title;
    const dup = st.findActiveByHash(it.contentHash);
    if (dup) it.duplicateOfSourceId = String(dup.id);
    if (it.externalId) {
      const ext = st.findActiveByExternal(it.externalId);
      if (ext && String(ext.content_hash) !== it.contentHash) {
        it.revisionOfSourceId = String(ext.id);
        it.warnings.push("同一资料有内容更新，确认后会保留新版本，旧引用会标为需重新核对");
      }
    }
    kept.push(it);
  }
  return { id: id(), createdAt: nowIso(), items: kept, rejected };
}
