import { createHash } from "node:crypto";

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function contentHash(
  messages: Array<{ role: string; text: string }>,
): string {
  const payload = JSON.stringify(
    messages.map((m, seq) => ({ role: m.role, text: m.text, seq })),
  );
  return sha256(payload);
}
