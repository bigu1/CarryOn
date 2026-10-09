import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("模拟模型：预览、提炼、人工核对、回答、润色，再核对编辑状态", async ({ page }) => {
  const sent: Array<Record<string, any>> = [];
  const mock = createServer((req, res) => {
    let raw = ""; req.on("data", (v) => raw += v);
    req.on("end", () => {
      const input = JSON.parse(raw); const data = JSON.parse(input.messages[1].content); sent.push(data);
      const m = data.messages?.find((x: any) => x.role === "user");
      const value = data.handoffBody ? { body: data.handoffBody + "\n<!-- 已检查合成润色 -->" } :
        input.messages[0].content.includes('"claims"') ? { claims: [{ type: "user_decision", title: "合成模型候选", body: "先保存在本机", evidence: [{ messageId: m.messageId, quote: m.text }] }] } :
        { points: [{ kind: "decision", text: "先保存在本机", support: [{ messageId: m.messageId, quote: m.text }] }], insufficient: false, conflicts: [] };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
    });
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  try {
    await page.goto("/import");
    await page.getByLabel("粘贴一段聊天").fill("用户：模型页面验收先保存在本机。");
    await page.getByLabel("归入主题").fill("模型页面合成主题");
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await page.getByRole("button", { name: "确认导入" }).click();
    await page.getByRole("link", { name: "打开资料，开始整理" }).click();
    await page.getByRole("link", { name: "模型页面合成主题", exact: true }).click();
    const topicUrl = page.url(); const topicId = topicUrl.split("/").at(-1)!;
    await page.goto("/settings");
    await page.getByLabel("服务地址", { exact: true }).fill(`http://127.0.0.1:${(mock.address() as AddressInfo).port}`);
    await page.getByLabel("模型名", { exact: true }).fill("synthetic-ui");
    await page.getByLabel("凭据", { exact: true }).fill("synthetic-ui-only");
    await page.getByRole("button", { name: "连接", exact: true }).click();
    await expect(page.getByText("已连接（只在本次运行中有效）")).toBeVisible();
    await page.goto(topicUrl); await page.getByRole("tab", { name: /^资料/ }).click();
    await page.getByRole("button", { name: "先看要发送的范围" }).click();
    expect(sent).toHaveLength(0);
    await page.getByRole("button", { name: "确认发送，开始提炼" }).click();
    await expect(page.getByText("新增 1 条候选", { exact: false })).toBeVisible();
    await page.getByRole("link", { name: "去核对", exact: true }).click();
    await expect(page.getByRole("heading", { name: "合成模型候选" })).toBeVisible();
    await page.getByRole("button", { name: "确认准确", exact: true }).click();
    await expect(page.getByText("已确认「合成模型候选」。")).toBeVisible();
    await page.goto("/answers");
    await page.getByLabel("限定主题").selectOption(topicId);
    await page.getByLabel("你想找回什么").fill("本机");
    await page.getByRole("button", { name: "让模型回答（先看发送范围）" }).click();
    await page.getByRole("button", { name: "确认发送，请模型回答" }).click();
    await expect(page.getByText("已确认的历史决定", { exact: true })).toBeVisible();
    await page.goto(`/handoff?topic=${topicId}`);
    await page.getByLabel("这次希望对方解决什么").fill("继续甲方案");
    await page.getByRole("button", { name: "生成交接说明" }).click();
    await page.getByRole("button", { name: "先看要发送的范围" }).click();
    await page.getByRole("button", { name: "确认发送，润色正文" }).click();
    await expect(page.getByLabel("交接正文（Markdown，可直接修改）")).toHaveValue(/已检查合成润色/);
    expect(sent).toHaveLength(3); expect(sent[2].messages).toBeUndefined();
    await page.getByLabel("这次希望对方解决什么").fill("继续乙方案");
    await expect(page.getByRole("button", { name: "下载 Markdown" })).toBeDisabled();
    await expect(page.getByText(/主题、目标或卡片选择已变化/)).toBeVisible();
  } finally {
    await page.goto("/settings");
    const clear = page.getByRole("button", { name: "清除凭据" }); if (await clear.isVisible()) await clear.click();
    await new Promise<void>((r) => mock.close(() => r()));
  }
});

test("备份下载、恢复至演示库、再下载正文往返且个人库保留", async ({ page }) => {
  await page.goto("/import");
  await page.getByLabel("粘贴一段聊天").fill("用户：合成备份往返；编程正文含 apiKey 和 Authorization。");
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await page.getByRole("button", { name: "确认导入" }).click();
  await page.goto("/settings");
  const [backup] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "下载当前库的备份" }).click()]);
  const path = (await backup.path())!; const before = JSON.parse(readFileSync(path, "utf8"));
  await page.getByRole("button", { name: "切到演示库" }).click();
  await page.getByLabel("选择备份文件").setInputFiles(path);
  await page.getByRole("button", { name: "恢复…", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "用备份替换当前库？" })).toBeVisible();
  await page.getByRole("button", { name: "确认恢复", exact: true }).click();
  await expect(page.getByText(/^已恢复：/)).toBeVisible();
  const [restored] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "下载当前库的备份" }).click()]);
  const after = JSON.parse(readFileSync((await restored.path())!, "utf8"));
  expect(after.data).toEqual(before.data);
  await page.getByRole("button", { name: "切回个人库" }).click();
  await page.goto("/answers?q=合成备份往返");
  await expect(page.getByText("原文命中 1 处")).toBeVisible();
});
