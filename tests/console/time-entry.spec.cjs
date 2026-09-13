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
    await form.getByLabel("Start time").fill("08:30");
    await form.getByLabel("End time").fill("10:30");
    await form.getByRole("button", { name: "Add another date" }).click();
    await form.getByLabel("Date worked").nth(1).fill("2026-09-08");
    await form.getByLabel("Start time").nth(1).fill("13:00");
    await form.getByLabel("End time").nth(1).fill("16:30");
    await expect(form.locator("[data-time-total]")).toContainText("5.50 hours");
    await form.getByRole("button", { name: "Save time entries" }).click();
    await expect(worker.page.locator(".stat").first()).toContainText("5.50");
    await expect(form.getByLabel("Hours", { exact: true })).toHaveValue("");
    await expect(worker.page.locator(".timeline-block").first()).toHaveCSS(
      "top",
      "125px",
    );
    await worker.page.reload();
    await expect(worker.page.locator(".timeline-block").first()).toContainText(
      "08:30–10:30",
    );
    const timeRow = worker.page
      .getByRole("row")
      .filter({ hasText: "08:30 – 10:30" });
    await timeRow.getByRole("button", { name: "Edit", exact: true }).click();
    const dialog = worker.page.getByRole("dialog");
    await expect(dialog.getByLabel("Start time")).toHaveValue("08:30");
    await dialog.getByLabel("End time").fill("11:00");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(worker.page.locator(".stat").first()).toContainText("6.00");
    await form.getByLabel("Date worked").fill("2026-09-07");
    await form.getByLabel("Entry type").selectOption("duration");
    await form.getByLabel("Hours", { exact: true }).fill("24");
    await form.getByRole("button", { name: "Save time entries" }).click();
    await expect(form.getByRole("alert")).toContainText(
      "Daily time exceeds 24 hours",
    );
    await expect(form.getByLabel("Hours", { exact: true })).toHaveValue("24");
    await worker.write("/time", {
      subdivision_id: scope.id,
      date: "2026-09-09",
      hours: 1,
      note: "Old entry",
    });
    await worker.page.reload();
    await expect(worker.page.locator(".timeline-unplaced")).toContainText(
      "1.00 h",
    );
    const oldRow = worker.page
      .getByRole("row")
      .filter({ hasText: "Old entry" });
    await oldRow.getByRole("button", { name: "Edit", exact: true }).click();
    await dialog.getByLabel("Start time (optional)").fill("12:00");
    await dialog.getByLabel("End time (optional)").fill("13:00");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(oldRow).toContainText("12:00 – 13:00");
    await expect(worker.page.locator(".timeline-unplaced")).toHaveCount(0);
    await worker.page.setViewportSize({ width: 390, height: 844 });
    expect(
      await worker.page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390);
  } finally {
    await client.context.close();
    await worker.context.close();
  }
});
