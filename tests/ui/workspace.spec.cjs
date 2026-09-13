const { test, expect } = require("@playwright/test");
test("project checklist and persistence", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your work, in order." }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/overview.png", fullPage: true });
  await page.getByRole("button", { name: "＋ New project" }).click();
  await page.getByLabel("Project name", { exact: true }).fill("Test build");
  await page
    .getByLabel("Description", { exact: true })
    .fill("A persistent project");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page
    .locator("nav")
    .getByRole("button", { name: "Projects", exact: false })
    .click();
  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name: "Test build" }) })
    .click();
  await page.getByPlaceholder("Add a task…").fill("Measure materials");
  await page.getByRole("button", { name: "＋ Add", exact: true }).click();
  await page.getByLabel("Measure materials").check();
  await page.getByLabel("Project status").selectOption("Completed");
  await page.getByLabel("Close dialog").click();
  await page.reload();
  await page
    .locator("nav")
    .getByRole("button", { name: "Projects", exact: false })
    .click();
  await expect(
    page
      .getByRole("button")
      .filter({ has: page.getByRole("heading", { name: "Test build" }) }),
  ).toContainText("Completed");
});
test("inventory movements reject negative stock and save valid changes", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator("nav")
    .getByRole("button", { name: /Inventory/ })
    .click();
  const row = page.getByRole("row").filter({ hasText: "White oak boards" });
  await row.getByRole("button", { name: "Adjust", exact: true }).click();
  await page.getByLabel("Movement").selectOption("-1");
  await page.getByLabel("Quantity", { exact: true }).fill("1000");
  await page.getByRole("button", { name: "Save movement" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("status")).toContainText("not enough stock");
  await page.getByLabel("Quantity", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Save movement" }).click();
  await expect(row).toContainText("40 boards");
  await page.reload();
  await page
    .locator("nav")
    .getByRole("button", { name: /Inventory/ })
    .click();
  await expect(
    page.getByRole("row").filter({ hasText: "White oak boards" }),
  ).toContainText("40 boards");
});
test("employee sorting and timer recovery", async ({ page }) => {
  await page.goto("/");
  await page
    .locator("nav")
    .getByRole("button", { name: /Employees/ })
    .click();
  await page.locator("#employee-sort").selectOption("contributions");
  await expect(page.locator("tbody tr").first()).toContainText("Jamie Chen");
  await page
    .locator("nav")
    .getByRole("button", { name: /Time tracking/ })
    .click();
  await page.getByRole("button", { name: "▷ Start timer" }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "■ Stop & save session" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "■ Stop & save session" }).click();
  await page
    .locator("nav")
    .getByRole("button", { name: /Time tracking/ })
    .click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
});
