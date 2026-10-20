import { expect, test, type Page } from "@playwright/test";

const widths = [360, 768, 1280] as const;

async function open(page: Page, query: Record<string, string> = {}) {
  await page.request.post("/e2e/reset");
  await page.goto(`/e2e/host.html?${new URLSearchParams(query).toString()}`);
  await page.waitForFunction(() => "host" in window && (window.host.ready || window.host.error !== undefined));
  expect(await page.evaluate(() => window.host.error)).toBeUndefined();
  return page.frameLocator("iframe[title=view]");
}

for (const width of widths) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("renders the invoice list and detail without horizontal overflow", async ({ page }, info) => {
      const view = await open(page);
      await expect(view.locator("button.row")).toHaveCount(2);
      await expect(view.locator(".detail h2")).toHaveText("inv_2");
      const overflow = await view.locator("body").evaluate((b) => b.scrollWidth - b.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await page.screenshot({ path: info.outputPath(`browser-${width}.png`), fullPage: true });
    });
  });
}

test("shares the selection between list, detail and the embedded badge", async ({ page }) => {
  const view = await open(page);
  await view.locator("button.row[data-id=inv_1]").click();
  await expect(view.locator(".detail h2")).toHaveText("inv_1");
  await expect(view.locator(".badge .name")).toHaveText("Acme Corp");
  // /mcp/invoices does not serve the customers app, so the badge shows the name alone.
  await expect(view.locator(".badge .tier")).toHaveCount(0);
});

test("the embedded badge calls its own app where both apps are served", async ({ page }) => {
  const view = await open(page, { endpoint: "/mcp", tool: "invoices_list" });
  await view.locator("button.row[data-id=inv_1]").click();
  await expect(view.locator(".badge .tier")).toHaveText("gold");
  await expect(view.locator(".badge .email")).toHaveText("ap@acme.test");
});

test("asks for confirmation inside the view, though the host rejects questions, then refreshes", async ({ page }) => {
  const view = await open(page);
  await view.locator("button.row[data-id=inv_1]").click();
  await view.getByRole("button", { name: "Send invoice" }).click();
  const dialog = view.getByRole("dialog");
  await expect(dialog).toContainText("Send invoice inv_1 for $1200.00 to Acme Corp?");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(view.locator(".detail .status")).toHaveText("sent");
  await expect(view.getByRole("button", { name: "Send invoice" })).toHaveCount(0);
  await expect(view.locator("button.row[data-id=inv_1] .status")).toHaveText("sent");
  await expect(dialog).toHaveCount(0);
  // The question never went to the host, which would have declined it unseen.
  expect(await page.evaluate(() => window.host.elicited)).toEqual([]);
});

test("declining in the view leaves the invoice a draft and says why", async ({ page }) => {
  const view = await open(page);
  await view.locator("button.row[data-id=inv_1]").click();
  await view.getByRole("button", { name: "Send invoice" }).click();
  await view.getByRole("dialog").getByRole("button", { name: "Decline" }).click();
  await expect(view.locator(".detail [role=alert]")).toContainText(/declined/i);
  await expect(view.locator(".detail .status")).toHaveText("draft");
});

test("a host that does not declare MCP Apps is asked itself, as before", async ({ page }) => {
  const view = await open(page, { apps: "0" });
  await view.locator("button.row[data-id=inv_1]").click();
  await view.getByRole("button", { name: "Send invoice" }).click();
  // The server refuses the view channel, the view calls send directly, and this host declines the question.
  await expect(view.locator(".detail [role=alert]")).toContainText(/declined/i);
  expect(await page.evaluate(() => window.host.elicited)).toEqual(["Send invoice inv_1 for $1200.00 to Acme Corp?"]);
  await expect(view.getByRole("dialog")).toHaveCount(0);
});

test("a component binding renders only the detail part", async ({ page }) => {
  const view = await open(page, { tool: "get", args: JSON.stringify({ id: "inv_1" }) });
  await expect(view.locator(".detail h2")).toHaveText("inv_1");
  await expect(view.locator("button.row")).toHaveCount(0);
});

test("follows the host's dark theme", async ({ page }) => {
  const view = await open(page, { theme: "dark" });
  await expect(view.locator("html")).toHaveAttribute("data-theme", "dark");
  const background = await view.locator("body").evaluate((b) => getComputedStyle(b).backgroundColor);
  expect(background).toBe("rgb(22, 22, 21)");
});
