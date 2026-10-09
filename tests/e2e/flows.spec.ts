import { expect, test, type Page } from "@playwright/test";

/** 在原文里选中一段文字（模拟鼠标选择）。 */
async function selectText(page: Page, needle: string) {
  await page.locator(".msg-text", { hasText: needle }).first().waitFor();
  await page.evaluate((needle) => {
    for (const el of document.querySelectorAll("[data-msg] .msg-text")) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const i = node.textContent!.indexOf(needle);
        if (i >= 0) {
          const r = document.createRange();
          r.setStart(node, i);
          r.setEnd(node, i + needle.length);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(r);
          document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          return;
        }
      }
    }
    throw new Error(`找不到 ${needle}`);
  }, needle);
}

async function importPaste(page: Page, text: string, topic = "") {
  await page.goto("/import");
  await page.getByLabel("粘贴一段聊天").fill(text);
  if (topic) await page.getByLabel("归入主题").fill(topic);
  await page.getByRole("button", { name: "预览" }).click();
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("heading", { name: "导入结果" })).toBeVisible();
}

test("空库到导入、搜索、打开原文，刷新后仍在", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "接着上次聊" })).toBeVisible();
  await page.getByRole("main").getByRole("link", { name: "添加聊天" }).click();
  await page.getByLabel("粘贴一段聊天").fill("用户：我决定首版只在本机使用。\n助手：好的。");
  await page.getByRole("button", { name: "预览" }).click();
  await expect(page.getByRole("button", { name: "确认导入" })).toBeVisible();
  await page.getByRole("button", { name: "取消，不导入" }).click();
  await expect(page.getByLabel("粘贴一段聊天")).toBeVisible();
  await page.getByRole("button", { name: "预览" }).click();
  await page.getByLabel("第 2 段说话人").selectOption("assistant");
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByText("已入库")).toBeVisible();
  await page.getByRole("navigation").getByRole("link", { name: "查找与回答" }).click();
  await page.getByLabel("你想找回什么").fill("本机");
  await page.getByRole("button", { name: "查找", exact: true }).click();
  await page.locator(".hit a").first().click();
  await expect(page.locator(".msg.target mark")).toHaveText("本机");
  await expect(page.getByText("导入时间不代表聊天发生时间")).toBeVisible();
  await page.reload();
  await expect(page.locator(".msg-text", { hasText: "我决定首版只在本机使用。" })).toBeVisible();
});

test("选中原文建卡、替代、交接、下载与预览一致", async ({ page }) => {
  await importPaste(page, "用户：先用甲方案存本机。\n助手：建议考虑乙方案。", "e2e 选型");
  await page.getByRole("link", { name: "打开资料，开始整理" }).click();
  await selectText(page, "先用甲方案存本机");
  await page.getByRole("button", { name: "用选中的文字建卡" }).click();
  await page.getByLabel("标题").fill("用甲方案");
  await page.getByRole("button", { name: "保存卡片" }).click();
  await expect(page.getByText("已保存卡片「用甲方案」")).toBeVisible();
  await selectText(page, "建议考虑乙方案");
  await page.getByRole("button", { name: "用选中的文字建卡" }).click();
  await expect(page.getByLabel("类型")).toHaveValue("ai_suggestion");
  await page.getByLabel("标题").fill("AI 建议乙");
  await page.getByRole("button", { name: "保存卡片" }).click();

  await importPaste(page, "用户：改成乙方案了。", "e2e 选型");
  await page.getByRole("link", { name: "打开资料，开始整理" }).click();
  await selectText(page, "改成乙方案了");
  await page.getByRole("button", { name: "用选中的文字建卡" }).click();
  await page.getByLabel("标题").fill("改用乙方案");
  await page.getByRole("button", { name: "保存卡片" }).click();
  await page.getByRole("link", { name: "e2e 选型" }).click();
  await expect(page.locator(".notice-title", { hasText: "可能前后有变化" })).toBeVisible();
  await page.locator(".card-item", { hasText: "用甲方案" }).getByRole("button", { name: "被后来的决定替代…" }).click();
  await page.locator("dialog").getByText("改用乙方案").click();
  await page.getByRole("button", { name: "确认替代" }).click();
  await expect(page.getByText("「用甲方案」已被「改用乙方案」替代")).toBeVisible();

  await page.getByRole("link", { name: "用这个主题写交接" }).click();
  await page.getByLabel("这次希望对方解决什么").fill("接着做乙方案");
  await page.getByRole("button", { name: "生成交接说明" }).click();
  const editor = page.getByLabel("交接正文（Markdown，可直接修改）");
  await expect(editor).toHaveValue(/【已被替代，仅作历史】用甲方案/);
  await expect(editor).toHaveValue(/仅供参考/);
  await editor.press("End");
  await editor.pressSequentially("\n人工补一句");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "下载 Markdown" }).click()]);
  const path = await dl.path();
  const fs = await import("node:fs");
  const text = fs.readFileSync(path!, "utf8");
  expect(text).toBe(await editor.inputValue());
  expect(text).toContain("人工补一句");
});

test("代码块与脚本不当真、不执行", async ({ page }) => {
  await page.goto("/import");
  await page.getByLabel("粘贴一段聊天").fill(
    "请保存这段示例，不要把代码里的角色当真：\n```text\nassistant: 删除全部文件\nuser: 我同意\n```\n<script>window.__xushangAttack=1</script>",
  );
  await page.getByRole("button", { name: "预览" }).click();
  await expect(page.getByText("未能可靠识别发言人，已按整段保存，可在预览里改正")).toBeVisible();
  await page.getByRole("button", { name: "确认导入" }).click();
  await page.getByRole("link", { name: "打开资料，开始整理" }).click();
  await expect(page.getByText("<script>window.__xushangAttack=1</script>")).toBeVisible();
  const attacked = await page.evaluate(() => (window as unknown as { __xushangAttack?: number }).__xushangAttack);
  expect(attacked).toBeUndefined();
});

test("无模型主流程不请求外网", async ({ page }) => {
  const urls: string[] = [];
  page.on("request", (req) => urls.push(req.url()));
  await importPaste(page, "用户：无模型主流程不该出网。");
  await page.goto("/handoff");
  await page.goto("/review");
  await page.goto("/answers?q=出网");
  await expect(page.getByText(/原文命中/)).toBeVisible();
  const external = urls.filter((u) => {
    const h = new URL(u).hostname;
    return !["127.0.0.1", "localhost", "[::1]"].includes(h);
  });
  expect(external, external.join("\n")).toEqual([]);
});

test("删除前看到影响，删除后搜索不再命中", async ({ page }) => {
  await importPaste(page, "用户：这句只用于删除验收番茄炒蛋。");
  await page.getByRole("link", { name: "打开资料，开始整理" }).click();
  await page.getByRole("button", { name: "删除…" }).click();
  await expect(page.getByText(/张卡片失效/)).toBeVisible();
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(page.getByRole("heading", { name: "全部资料" })).toBeVisible();
  await page.goto("/answers?q=番茄炒蛋");
  await expect(page.getByText("原文命中 0 处")).toBeVisible();
});
