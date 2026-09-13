const { test, expect } = require("@playwright/test");
async function account(browser, name, suffix) {
  const context = await browser.newContext();
  let token = (await (await context.request.get("/api/auth/csrf")).json())
    .csrf_token;
  const response = await context.request.post("/api/auth/register", {
    headers: { "X-CSRF-Token": token },
    data: {
      full_name: name,
      email: `${suffix}-${Date.now()}@example.com`,
      password: "test-password-123",
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  token = body.csrf_token;
  const write = async (path, data = {}, method = "POST") => {
    const res = await context.request.fetch(`/api${path}`, {
      method,
      headers: { "X-CSRF-Token": token },
      data,
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    return res.json();
  };
  return { context, write, page: await context.newPage() };
}

test("project shortcut opens inline multi-date logging and saves into reports", async ({
  browser,
}) => {
  const client = await account(browser, "Time Client", "time-client");
  const worker = await account(browser, "Time Worker", "time-worker");
  try {
    const project = await client.write("/projects", {
      title: "Multi-date project",
    });
    const scope = project.subdivisions[0];
    const bid = await worker.write(`/subdivisions/${scope.id}/bids`, {
      amount: 3000,
    });
    await client.write(`/bids/${bid.id}/award`);
    await worker.page.goto(`/console#project/${project.id}`);
    await worker.page
      .getByRole("button", { name: "Log time", exact: true })
      .click();
    const form = worker.page.locator("#time-entry-form");
    await expect(form).toBeVisible();
    await expect(worker.page.getByRole("dialog")).not.toBeVisible();
    await expect(form.getByLabel("Project / assignment")).toHaveValue(
      String(scope.id),
    );
    await form.getByLabel("Date worked").fill("2026-09-07");
    await form.getByLabel("Hours", { exact: true }).fill("2");
    await form.getByRole("button", { name: "Add another date" }).click();
    await form.getByLabel("Date worked").nth(1).fill("2026-09-08");
    await form.getByLabel("Hours", { exact: true }).nth(1).fill("3.5");
    await expect(form.locator("[data-time-total]")).toContainText("5.50 hours");
    await form.getByRole("button", { name: "Save time entries" }).click();
    await expect(worker.page.locator(".stat").first()).toContainText("5.50");
    await expect(form.getByLabel("Hours", { exact: true })).toHaveValue("");
    await form.getByLabel("Date worked").fill("2026-09-07");
    await form.getByLabel("Hours", { exact: true }).fill("24");
    await form.getByRole("button", { name: "Save time entries" }).click();
    await expect(form.getByRole("alert")).toContainText(
      "Daily time exceeds 24 hours",
    );
    await expect(form.getByLabel("Hours", { exact: true })).toHaveValue("24");
    await worker.page.setViewportSize({ width: 390, height: 844 });
    expect(
      await worker.page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390);
  } finally {
    await client.context.close();
    await worker.context.close();
  }
});
