import { createServer } from "node:http";

const port = Number(process.env.MOCK_AI_PORT ?? 43991);
const delay = Number(process.env.MOCK_AI_DELAY_MS ?? 0);
const mode = process.env.MOCK_AI_MODE ?? "ok";

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200).end("ok");
    return;
  }
  if (req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  let raw = "";
  req.on("data", (c) => {
    raw += c;
  });
  req.on("end", () => {
    const finish = () => {
      if (mode === "redirect") {
        res.writeHead(302, { location: "https://example.invalid/steal" }).end();
        return;
      }
      if (mode === "unauth") {
        res.writeHead(401).end("{}");
        return;
      }
      if (mode === "empty") {
        res.writeHead(200).end("");
        return;
      }
      if (mode === "badjson") {
        res.writeHead(200).end("{not-json");
        return;
      }
      if (mode === "huge") {
        res.writeHead(200).end(JSON.stringify({ choices: [{ message: { content: "x".repeat(30_000) } }] }));
        return;
      }
      let messageId = "unknown";
      try {
        const body = JSON.parse(raw) as { messages?: Array<{ role?: string; content?: string }> };
        const user = body.messages?.find((m) => m.role === "user");
        const parsed = user?.content ? JSON.parse(user.content) : {};
        messageId = parsed.messages?.[0]?.messageId ?? messageId;
        const firstText = parsed.messages?.[0]?.text ?? "";
        const content = JSON.stringify({
          claims: [
            {
              type: firstText.includes("建议") ? "ai_suggestion" : "user_decision",
              title: "候选",
              body: "来自模拟服务的待审核候选",
              evidence: [{ messageId, quote: firstText.slice(0, 12) || "x" }],
            },
          ],
          points: [
            {
              text: "仅根据给定材料作答",
              support: [{ messageId, quote: firstText.slice(0, 12) || "x" }],
            },
          ],
          insufficient: firstText.includes("部署地点"),
          conflicts: [],
          body: parsed.handoffBody ?? "润色后的正文，未添加新事实。",
        });
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ model: "mock-carryon", choices: [{ message: { content } }] }),
        );
      } catch {
        res.writeHead(500).end("{}");
      }
    };
    if (delay) setTimeout(finish, delay);
    else finish();
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`mock-ai ${mode} http://127.0.0.1:${port}`);
});
