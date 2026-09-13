const { test, expect } = require("@playwright/test");
const { randomUUID } = require("node:crypto");
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
  token = (await response.json()).csrf_token;
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
test("contractors sign lien waivers and clients print the project waiver chain", async ({
  browser,
}) => {
  const client = await account(browser, "Dana Whitfield", "waiver-client");
  const contractor = await account(browser, "Tobias Reyes", "waiver-contractor");
  const errors = [];
  for (const p of [client.page, contractor.page])
    p.on("pageerror", (e) => errors.push(e.message));
  try {
    const project = await client.write("/projects", {
      title: "Maple Street Duplex",
      subdivisions: ["Stair rebuild"],
    });
    const scope = project.subdivisions[0];
    const bid = await contractor.write(`/subdivisions/${scope.id}/bids`, {
      amount: 3000,
    });
    await client.write(`/bids/${bid.id}/award`);
    await contractor.write("/me", { hourly_rate: 50 }, "PATCH");
    await contractor.write("/time", {
      subdivision_id: scope.id,
      date: "2026-01-12",
      hours: 8,
    });
    const period = {
      from: "2026-01-01",
      to: "2026-01-31",
      stored_materials: 0,
      retainage_percent: 5,
    };
    const preview = await contractor.write(
      `/subdivisions/${scope.id}/pay-applications/preview`,
      period,
    );
    const application = await contractor.write(
      `/subdivisions/${scope.id}/pay-applications`,
      { ...period, expected: preview.fingerprint },
    );
    await contractor.page.goto(`/console#billing/${scope.id}`);
    await expect(
      contractor.page.getByText("Online funding is not enabled on this server"),
    ).toBeVisible();
    const waivers = contractor.page
      .locator("section.panel")
      .filter({ has: contractor.page.getByRole("heading", { name: "Lien waivers" }) });
    await expect(waivers).toContainText("Conditional waiver and release on progress payment");
    await waivers.getByRole("button", { name: "Sign waiver", exact: true }).click();
    await expect(contractor.page.getByRole("dialog")).toContainText("Upon receipt by Tobias Reyes");
    await contractor.page.getByLabel("Title or role").fill("Owner");
    await contractor.page.getByLabel(/I am authorized to sign/).check();
    await submit(contractor.page, "Sign waiver");
    await expect(waivers).toContainText("Tobias Reyes");
    await expect(waivers.getByRole("button", { name: "Sign waiver" })).toHaveCount(0);
    await client.write(`/pay-applications/${application.id}`, { status: "approved", note: "" }, "PATCH");
    await client.write(`/pay-applications/${application.id}/payments`, {
      amount: Number(application.amount_due),
      paid_on: "2026-02-02",
      reference: "ACH-7781",
      note: "",
      request_key: randomUUID(),
    });
    await client.page.goto(`/console#project/${project.id}`);
    await client.page.getByRole("link", { name: "Lien waiver chain", exact: true }).click();
    await expect(
      client.page.getByRole("heading", { name: "Lien waiver chain", exact: true }),
    ).toBeVisible();
    const document = client.page.locator(".application-document");
    await expect(document).toContainText("Unconditional waiver and release on progress payment");
    await expect(document).toContainText("The chain is incomplete");
    await expect(client.page.getByRole("button", { name: "Sign waiver" })).toHaveCount(0);
    await client.page.getByRole("link", { name: "View waiver" }).first().click();
    await expect(client.page.locator(".signature-block")).toContainText("Owner");
    await expect(client.page.locator(".hash")).toContainText(/SHA-256 [0-9a-f]{64}/);
    await client.page.emulateMedia({ media: "print" });
    await expect(client.page.locator(".sidebar")).not.toBeVisible();
    await client.page.emulateMedia({ media: "screen" });
    await client.page.goto(`/console#waivers/${project.id}`);
    await client.page.setViewportSize({ width: 390, height: 844 });
    await expect(document).toBeVisible();
    expect(
      await client.page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390);
    expect(errors).toEqual([]);
  } finally {
    await client.context.close();
    await contractor.context.close();
  }
});
