import { expect, test } from "@playwright/test";

const viewports = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "390x844", width: 390, height: 844 },
] as const;

const overflow = () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2;

for (const vp of viewports) {
  test(`主要页面在 ${vp.name} 无横向溢出`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/");
    const origin = new URL(page.url()).origin;
    const session = await (await page.request.get("/api/session")).json();
    const headers = { origin, "x-xushang-csrf": session.csrf };
    const text = `合成视口 ${vp.name}。` + "这是一份合成资料：决定首版只在本机保存。先核对原文，再交给下一次讨论。".repeat(8);
    const preview = await (await page.request.post("/api/imports/preview", { headers, data: {
      paste: `用户：${text}`, defaultTopic: `视口合成主题 ${vp.name}`, pasteTitle: "合成原文：本机决定与后续核对",
    } })).json();
    const imported = await (await page.request.post("/api/imports/confirm", { headers, data: { previewId: preview.preview.id } })).json();
    const sourceId = imported.results[0].sourceId;
    const detail = await (await page.request.get(`/api/sources/${sourceId}`)).json();
    const topicId = detail.source.topic_id;
    const card = await page.request.post("/api/cards", { headers, data: {
      topicId, type: "user_decision", title: "首版先在本机保存，下一次讨论需要核对引用和未解决问题", body: text,
      citations: [{ messageId: detail.messages[0].id, quote: text, startCp: 0, endCp: Array.from(text).length }],
    } });
    expect(card.ok()).toBe(true);
    for (const path of ["/", "/import", "/answers", "/topics", "/review", "/handoff", "/sources", "/settings"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await page.evaluate(overflow), path).toBe(false);
    }
    for (const path of [`/sources/${sourceId}`, `/topics/${topicId}`]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await page.evaluate(overflow), path).toBe(false);
    }
    const screenshot = testInfo.outputPath(`topic-${vp.name}.png`);
    await page.screenshot({ path: screenshot });
    await testInfo.attach(`主题页面-${vp.name}`, { path: screenshot, contentType: "image/png" });
  });
}

test("键盘能到达导航并看到焦点", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.locator("body").click();
  await page.keyboard.press("Tab");
  const tag = await page.evaluate(() => document.activeElement?.tagName ?? "");
  expect(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"]).toContain(tag);
  await expect(page.locator(":focus")).toBeVisible();
});
