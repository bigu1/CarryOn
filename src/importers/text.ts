import { contentHash } from "../shared/hash.js";
import { LIMITS } from "../shared/limits.js";
import type { PreviewConversation, PreviewMessage, Role, SourceType } from "../domain/types.js";

const ROLE_LINE =
  /^(用户|我|老大|User|user|USER|助手|助理|AI|assistant|Assistant|ASSISTANT|tool|Tool|系统|System)[:：]\s*(.*)$/;

function mapLabel(label: string): Role {
  const l = label.toLowerCase();
  if (["用户", "我", "老大", "user"].includes(l)) return "user";
  if (["助手", "助理", "ai", "assistant"].includes(l)) return "assistant";
  if (["tool"].includes(l)) return "tool";
  return "unknown";
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function looksBinary(buf: Buffer): boolean {
  if (buf.includes(0)) return true;
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  let weird = 0;
  for (const b of sample) {
    if (b < 9 || (b > 13 && b < 32)) weird++;
  }
  return weird > sample.length * 0.3;
}

export function parseUtf8Text(
  raw: string,
  opts: { title: string; sourceType: SourceType; asWhole?: boolean; filename?: string },
): PreviewConversation | { error: string } {
  const text = stripBom(raw);
  if (!text.trim()) return { error: "空文件，没有可导入的内容" };
  if (text.includes("\u0000")) return { error: "文件含有空字符，已拒绝" };
  if (Array.from(text).length > LIMITS.messageChars && opts.asWhole) {
    return { error: `整段超过 ${LIMITS.messageChars} 字，不会静默截断` };
  }

  const warnings: string[] = [];
  let messages: PreviewMessage[];

  if (opts.asWhole) {
    messages = [
      {
        seq: 0,
        role: "unknown",
        originalLabel: "整段",
        text,
        occurredAt: null,
        warnings: ["按整段导入，角色记为不确定，可在预览里改正"],
      },
    ];
  } else {
    messages = splitConservatively(text);
    if (messages.length === 1 && messages[0].role === "unknown") {
      warnings.push("未能可靠识别发言人，已按整段保存，可在预览里改正");
    }
  }

  for (const m of messages) {
    if (m.text.length > LIMITS.messageChars) {
      return { error: `单条消息超过 ${LIMITS.messageChars} 字，不会静默截断` };
    }
  }

  return {
    title: opts.title || guessTitle(messages),
    sourceType: opts.sourceType,
    occurredAt: null,
    occurredAtPrecision: "unknown",
    topicLabel: "",
    messages,
    contentHash: contentHash(messages),
    warnings: [...warnings, "来源日期未知，不会用导入时间冒充"],
    filename: opts.filename,
  };
}

/** 粘贴的文字没有标题时，用第一句话的开头当标题，比「粘贴的聊天」好认。 */
export function guessTitle(messages: PreviewMessage[]): string {
  const first = messages.find((m) => m.text.trim())?.text ?? "";
  const line = first
    .split("\n")
    .map((x) => x.replace(/^[#>*\-\s`]+/, "").trim())
    .find((x) => x && !x.startsWith("```")) ?? "";
  const cps = Array.from(line);
  if (!cps.length) return "未命名的聊天";
  return cps.length > 28 ? cps.slice(0, 28).join("") + "…" : line;
}

function splitConservatively(text: string): PreviewMessage[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: PreviewMessage[] = [];
  let inFence = false;
  let current: { role: Role; label: string; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const body = current.lines.join("\n").trimEnd();
    if (body.length) {
      out.push({
        seq: out.length,
        role: current.role,
        originalLabel: current.label,
        text: body,
        occurredAt: null,
        warnings: [],
      });
    }
    current = null;
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      if (current) current.lines.push(line);
      else {
        current = { role: "unknown", label: "未标明", lines: [line] };
      }
      continue;
    }
    if (!inFence && !/^\s{0,3}>/.test(line)) {
      const m = line.match(ROLE_LINE);
      if (m) {
        flush();
        current = { role: mapLabel(m[1]), label: m[1], lines: [m[2] ?? ""] };
        continue;
      }
    }
    if (!current) current = { role: "unknown", label: "未标明", lines: [] };
    current.lines.push(line);
  }
  flush();

  if (out.length === 0) {
    return [
      {
        seq: 0,
        role: "unknown",
        originalLabel: "未标明",
        text,
        occurredAt: null,
        warnings: [],
      },
    ];
  }
  return out;
}
