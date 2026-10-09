import { expect, test } from "@playwright/test";

const viewports = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "390x844", width: 390, height: 844 },
] as const;

const overflow = () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2;

for (const vp of viewports) {
  test(`主要页面在 ${vp.name} 无横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const path of ["/", "/import", "/answers", "/topics", "/review", "/handoff", "/sources", "/settings"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await page.evaluate(overflow), path).toBe(false);
    }
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
