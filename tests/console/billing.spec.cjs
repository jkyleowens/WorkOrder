const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
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
async function submit(page, name) {
  await page
    .getByRole("dialog")
    .getByRole("button", { name, exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 20000 });
  await expect(page.locator("#main")).toHaveAttribute("aria-busy", "false");
}
test("scope billing delivers change approval, reviewable applications, payment records and exports", async ({
  browser,
}) => {
  const client = await account(browser, "Dana Whitfield", "billing-client");
  const contractor = await account(
    browser,
    "Tobias Reyes",
    "billing-contractor",
  );
  const errors = [];
  client.page.on("pageerror", (e) => errors.push(e.message));
  contractor.page.on("pageerror", (e) => errors.push(e.message));
  try {
    const project = await client.write("/projects", {
      title: "Maple Street Duplex",
      description:
        "Interior framing and finishes. A clear record from award to payment.",
      subdivisions: ["Interior wall layout and blocking"],
    });
    const scope = project.subdivisions[0];
    const bid = await contractor.write(`/subdivisions/${scope.id}/bids`, {
      amount: 4200,
    });
    await client.write(`/bids/${bid.id}/award`);
    await contractor.write("/me", { hourly_rate: 60 }, "PATCH");
    await contractor.write("/time", {
      subdivision_id: scope.id,
      date: "2026-01-10",
      hours: 8,
    });
    await contractor.page.goto(`/console#billing/${scope.id}`);
    await expect(
      contractor.page.getByRole("heading", { name: scope.scope, exact: true }),
    ).toBeVisible();
    await contractor.page
      .getByRole("button", { name: "Propose change", exact: true })
      .click();
    await contractor.page
      .getByLabel("Title", { exact: true })
      .fill("Added beam pocket");
    await contractor.page
      .getByLabel("Added or removed work")
      .fill("Frame the added beam pocket at unit B.");
    await contractor.page
      .getByLabel("Price change", { exact: false })
      .fill("600");
    await contractor.page
      .getByLabel("Schedule change", { exact: false })
      .fill("2");
    await submit(contractor.page, "Send proposal");
    await expect(
      contractor.page.getByRole("button", {
        name: "Accept change",
        exact: true,
      }),
    ).toHaveCount(0);
    await client.page.goto(`/console#billing/${scope.id}`);
    await client.page
      .getByRole("button", { name: "Accept change", exact: true })
      .click();
    await client.page.getByLabel("Decision note").fill("Approved for unit B");
    await submit(client.page, "Accept change");
    await expect(client.page.locator(".billing-stats")).toContainText(
      "USD 4,800.00",
    );
    await contractor.page.reload();
    await contractor.page
      .getByRole("button", { name: "Prepare application", exact: true })
      .click();
    await contractor.page.getByLabel("Period from").fill("2026-01-01");
    await contractor.page.getByLabel("Period to").fill("2026-01-31");
    await contractor.page
      .getByRole("button", { name: "Review figures", exact: true })
      .click();
    await expect(contractor.page.getByRole("dialog")).toBeVisible();
    await expect(contractor.page.locator("#application-preview")).toContainText(
      "USD 456.00",
    );
    await submit(contractor.page, "Submit application");
    await client.page.reload();
    await client.page
      .getByRole("button", { name: "Approve", exact: true })
      .click();
    await submit(client.page, "Approve application");
    await client.page
      .getByRole("button", { name: "Record payment", exact: true })
      .click();
    await client.page.getByLabel("Amount · USD", { exact: true }).fill("400");
    await client.page
      .getByLabel("Bank or check reference")
      .fill("BANK-2026-018");
    await submit(client.page, "Record payment");
    await expect(client.page.locator(".billing-stats")).toContainText(
      "USD 56.00",
    );
    await client.page.screenshot({
      path: "test-results/phase-one-billing-desktop.png",
      fullPage: true,
    });
    await client.page.reload();
    await expect(
      client.page.getByText("BANK-2026-018", { exact: true }),
    ).toBeVisible();
    await client.page
      .getByRole("link", { name: "View application", exact: true })
      .click();
    await expect(
      client.page.getByRole("heading", { name: "Supporting records" }),
    ).toBeVisible();
    await expect(client.page.locator(".application-document")).toContainText(
      "USD 456.00",
    );
    const downloadPromise = client.page.waitForEvent("download");
    await client.page.getByRole("button", { name: "Export CSV" }).click();
    const download = await downloadPromise;
    const csv = await fs.readFile(await download.path(), "utf8");
    expect(csv).toContain('"amount_due","456.00"');
    expect(csv).toContain("Tobias Reyes");
    await client.page.emulateMedia({ media: "print" });
    await expect(client.page.locator(".sidebar")).not.toBeVisible();
    await expect(client.page.locator(".application-document")).toBeVisible();
    await client.page.pdf({
      path: "test-results/phase-one-pay-application.pdf",
      format: "A4",
      printBackground: true,
    });
    await client.page.emulateMedia({ media: "screen" });
    await client.page.goto(`/console#billing/${scope.id}`);
    await client.page.setViewportSize({ width: 390, height: 844 });
    await expect(
      client.page.getByRole("heading", { name: scope.scope, exact: true }),
    ).toBeVisible();
    await client.page.screenshot({
      path: "test-results/phase-one-billing-mobile.png",
      fullPage: true,
    });
    expect(
      await client.page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390);
    await client.page
      .getByRole("button", { name: "Reverse record", exact: true })
      .click();
    await client.page
      .getByLabel("Reason for correction")
      .fill("Reference entered against the wrong application");
    await submit(client.page, "Reverse record");
    await expect(client.page.locator(".billing-stats")).toContainText(
      "USD 456.00",
    );
    expect(errors).toEqual([]);
  } finally {
    await client.context.close();
    await contractor.context.close();
  }
});
