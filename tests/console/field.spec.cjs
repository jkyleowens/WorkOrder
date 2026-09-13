const { test, expect } = require("@playwright/test");
async function account(browser, name) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  let token = (await (await context.request.get("/api/auth/csrf")).json())
    .csrf_token;
  const r = await context.request.post("/api/auth/register", {
    headers: { "X-CSRF-Token": token },
    data: {
      full_name: name,
      email: `field-${name}-${Date.now()}@example.com`,
      password: "test-password-123",
    },
  });
  const body = await r.json();
  token = body.csrf_token;
  const write = async (path, data = {}, method = "POST") => {
    const r = await context.request.fetch(`/api${path}`, {
      method,
      headers: { "X-CSRF-Token": token },
      data,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  return { context, page: await context.newPage(), write, user: body.user };
}
async function submit(page, name) {
  await page
    .getByRole("dialog")
    .getByRole("button", { name, exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}
async function work(browser) {
  const client = await account(browser, "Client"),
    worker = await account(browser, "Worker");
  const p = await client.write("/projects", {
    title: "Field trial",
    subdivisions: ["Rough framing", "Finish work"],
  });
  for (const s of p.subdivisions) {
    const b = await worker.write(`/subdivisions/${s.id}/bids`, {
      amount: 1000,
    });
    await client.write(`/bids/${b.id}/award`);
  }
  return { client, worker, p };
}
test("mobile field time survives a week offline, reloads, syncs once and surfaces conflicts", async ({
  browser,
}) => {
  const { client, worker, p } = await work(browser);
  const page = worker.page;
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto("/field");
    await expect(
      page.getByText("Time sync complete.", { exact: false }),
    ).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect(
      page.getByText("Time sync complete.", { exact: false }),
    ).toBeVisible();
    await worker.context.setOffline(true);
    for (let i = 1; i <= 7; i++) {
      await page.getByLabel("Work date", { exact: true }).fill(`2026-09-0${i}`);
      await page.getByLabel("Start time", { exact: true }).fill("08:00");
      await page.getByLabel("End time", { exact: true }).fill("16:00");
      await page.getByRole("button", { name: "Save time on device" }).click();
      await expect(page.locator(".queue-item")).toHaveCount(i);
    }
    await page.reload();
    await expect(page.locator(".queue-item")).toHaveCount(7);
    await page.getByRole("button", { name: "Clock in", exact: true }).click();
    await expect(
      page.getByText("Clock running since", { exact: false }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByText("Clock running since", { exact: false }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Correct running clock" }).click();
    await page.getByLabel("Clock-in date and time").fill("2026-09-08T08:00");
    await submit(page, "Save changes");
    // Avoid recording a multi-day current-time interval: exercise the real clock split helper deterministically.
    const intervals = await page.evaluate(async () => {
      const { clockEntries } = await import("/assets/field-store.js");
      return clockEntries("2026-09-08T22:00:00", "2026-09-09T02:00:00");
    });
    expect(intervals).toHaveLength(2);
    expect(intervals[0].end_time).toBe("00:00");
    await page.clock.setFixedTime(new Date("2026-09-08T09:00:00"));
    await page.getByRole("button", { name: "Clock out", exact: true }).click();
    await expect(page.locator(".queue-item")).toHaveCount(8);
    await expect(
      page.getByText("Clock running since", { exact: false }),
    ).toHaveCount(0);
    await worker.context.setOffline(false);
    await expect(page.locator(".queue-item")).toHaveCount(0);
    await page.getByRole("button", { name: "Sync time", exact: true }).click();
    await expect(
      page.getByText("Time sync complete.", { exact: false }),
    ).toBeVisible();
    const response = await worker.context.request.get(
      "/api/time?from=2026-09-01&to=2026-09-07",
    );
    const rows = await response.json();
    expect(rows.entries).toHaveLength(7);
    expect(rows.hours).toBe("56.00");
    await page.getByLabel("Work date", { exact: true }).fill("2026-09-01");
    await page.getByLabel("Start time", { exact: true }).fill("15:00");
    await page.getByLabel("End time", { exact: true }).fill("17:00");
    await page.getByRole("button", { name: "Save time on device" }).click();
    await expect(page.locator(".queue-item")).toContainText("Time conflict");
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
    expect(errors).toEqual([]);
  } finally {
    await client.context.close();
    await worker.context.close();
  }
});
test("field reports, award signatures, document versions and dependency edits work on a phone", async ({
  browser,
}) => {
  const { client, worker, p } = await work(browser);
  const page = worker.page;
  const errors = [];
  for (const p of [worker.page, client.page])
    p.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(`/console#billing/${p.subdivisions[0].id}`);
    await page.getByRole("link", { name: "Field reports & documents" }).click();
    await expect(
      page.getByText("Time sync complete.", { exact: false }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Daily reports", exact: true })
      .click();
    await page.getByRole("button", { name: "Add daily report" }).click();
    await page
      .getByLabel("Progress", { exact: true })
      .fill("North wall framing complete");
    await page.getByLabel("Weather", { exact: true }).fill("Clear");
    await page.getByLabel("Photos", { exact: false }).setInputFiles({
      name: "progress.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await submit(page, "Save daily report");
    await expect(
      page.getByText("North wall framing complete", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("img")).toBeVisible();
    await client.page.goto("/field");
    await expect(
      client.page.getByText("Time sync complete.", { exact: false }),
    ).toBeVisible();
    await client.page
      .getByRole("button", { name: "Daily reports", exact: true })
      .click();
    await expect(
      client.page.getByText("North wall framing complete", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Documents", exact: true }).click();
    await page.getByRole("button", { name: "Read document" }).click();
    await expect(
      page.getByText("Accepted bid: USD 1000", { exact: false }),
    ).toBeVisible();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Sign this version" }).click();
    await expect(
      page.getByText("signed · Worker for contractor", { exact: false }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Create new version" }).click();
    await page
      .getByLabel("Title", { exact: true })
      .fill("Updated framing agreement");
    await page
      .getByLabel("Document text")
      .fill("Framing scope with revised drawing reference.");
    await submit(page, "Save version");
    await expect(
      page.getByText("Updated framing agreement · v2", { exact: false }),
    ).toBeVisible();
    await client.page
      .getByRole("button", { name: "Schedule", exact: true })
      .click();
    await client.page
      .getByRole("button", { name: "Edit schedule" })
      .nth(0)
      .click();
    await client.page.getByLabel("Earliest start").fill("2026-09-01");
    await client.page.getByLabel("Duration (calendar days)").fill("3");
    await submit(client.page, "Save schedule");
    await client.page
      .getByRole("button", { name: "Edit schedule" })
      .nth(1)
      .click();
    await client.page
      .getByLabel("Predecessor")
      .selectOption(String(p.subdivisions[0].id));
    await submit(client.page, "Save schedule");
    await expect(client.page.locator(".schedule-row").nth(1)).toContainText(
      "2026-09-04",
    );
    await client.page
      .getByRole("button", { name: "Edit schedule" })
      .nth(0)
      .click();
    await client.page.getByLabel("Earliest start").fill("2026-09-08");
    await submit(client.page, "Save schedule");
    await expect(client.page.locator(".schedule-row").nth(1)).toContainText(
      "2026-09-11",
    );
    expect(errors).toEqual([]);
  } finally {
    await client.context.close();
    await worker.context.close();
  }
});
