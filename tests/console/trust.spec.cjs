const { test, expect } = require("@playwright/test");
async function account(browser, name) {
  const context = await browser.newContext();
  let token = (await (await context.request.get("/api/auth/csrf")).json())
    .csrf_token;
  const r = await context.request.post("/api/auth/register", {
    headers: { "X-CSRF-Token": token },
    data: {
      full_name: name,
      email: `trust-${name}-${Date.now()}@example.com`,
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
  return { context, write, user: body.user, page: await context.newPage() };
}
async function submit(page, name) {
  await page
    .getByRole("dialog")
    .getByRole("button", { name, exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}
test("credentials, completed-work ratings and dispute evidence are accessible in the console", async ({
  browser,
}) => {
  const client = await account(browser, "Client"),
    worker = await account(browser, "Worker");
  const errors = [];
  for (const p of [client.page, worker.page])
    p.on("pageerror", (e) => errors.push(e.message));
  try {
    await worker.page.goto("/console#credentials");
    await worker.page
      .getByRole("button", { name: "Add credential", exact: true })
      .click();
    await worker.page
      .getByLabel("Title", { exact: true })
      .fill("Electrical license");
    await worker.page.getByLabel("Issuer", { exact: true }).fill("State board");
    await worker.page.getByLabel("License or policy number").fill("EL-12345");
    await worker.page.getByLabel("Expiry date").fill("2099-01-01");
    await worker.page.getByLabel("Supporting document").setInputFiles({
      name: "license.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7 test"),
    });
    await submit(worker.page, "Submit credential");
    await expect(
      worker.page.getByText("Electrical license", { exact: true }),
    ).toBeVisible();
    await expect(
      worker.page.getByRole("link", { name: "Download document" }),
    ).toBeVisible();
    const project = await client.write("/projects", {
      title: "Trust workflow",
      subdivisions: ["Finish carpentry"],
    });
    const scope = project.subdivisions[0];
    await client.page.goto(`/console#project/${project.id}`);
    await client.page
      .getByRole("button", { name: "Required credentials" })
      .click();
    await client.page
      .getByLabel("Trade license", { exact: true })
      .selectOption("yes");
    await submit(client.page, "Save changes");
    const bid = await worker.write(`/subdivisions/${scope.id}/bids`, {
      amount: 900,
    });
    await client.write(`/bids/${bid.id}/award`);
    await client.page.goto(`/console#billing/${scope.id}`);
    await client.page.getByRole("link", { name: "Reviews & disputes" }).click();
    await client.page
      .getByRole("button", { name: "Open dispute", exact: true })
      .click();
    await client.page
      .getByLabel("Reason", { exact: true })
      .fill("Closeout paperwork is missing");
    await submit(client.page, "Place hold");
    await expect(
      client.page.getByRole("button", { name: "Download dated packet" }),
    ).toBeVisible();
    await client.page
      .getByRole("button", { name: "Add evidence or note" })
      .click();
    await client.page
      .getByLabel("Note", { exact: true })
      .fill("Requested the missing paperwork today.");
    await submit(client.page, "Add to record");
    await expect(
      client.page.getByText("Requested the missing paperwork today.", {
        exact: true,
      }),
    ).toBeVisible();
    const download = client.page.waitForEvent("download");
    await client.page
      .getByRole("button", { name: "Download dated packet" })
      .click();
    expect((await download).suggestedFilename()).toMatch(
      /dispute-\d+-packet.json/,
    );
    await client.page
      .getByRole("button", { name: "Withdraw dispute", exact: true })
      .click();
    await submit(client.page, "Confirm");
    await worker.page.goto(`/console#scope-trust/${scope.id}`);
    await worker.page
      .getByRole("button", { name: "Open dispute", exact: true })
      .click();
    await worker.page
      .getByLabel("Reason", { exact: true })
      .fill("Agree the remaining closeout obligations");
    await submit(worker.page, "Place hold");
    await expect(
      worker.page.getByRole("button", { name: "Propose split" }),
    ).toBeVisible();
    const disputeUrl = worker.page.url();
    await worker.page.getByRole("button", { name: "Propose split" }).click();
    await worker.page
      .getByLabel("Resolution note")
      .fill("Paperwork delivered; no money remains held.");
    await submit(worker.page, "Send proposal");
    await expect(
      worker.page.getByRole("button", { name: "Accept split", exact: true }),
    ).toHaveCount(0);
    await client.page.goto(disputeUrl);
    await client.page
      .getByRole("button", { name: "Accept split", exact: true })
      .click();
    await submit(client.page, "Confirm");
    await expect(
      client.page.getByRole("heading", { name: "Agreed resolution" }),
    ).toBeVisible();
    const disputeId = disputeUrl.split("/").at(-1);
    const packetResponse = await client.context.request.get(
      `/api/disputes/${disputeId}/packet`,
    );
    const packet = await packetResponse.json();
    expect(packet.frozen).toBe(true);
    expect(packet.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(packet.packet.record.at(-1).kind).toBe("resolved");
    await worker.write(
      `/subdivisions/${scope.id}`,
      { status: "completed" },
      "PATCH",
    );
    await client.page.goto(`/console#scope-trust/${scope.id}`);
    await client.page
      .getByRole("button", { name: "Rate completed work" })
      .click();
    await client.page
      .getByLabel("Comment", { exact: true })
      .fill("Excellent finish and communication.");
    await submit(client.page, "Publish review");
    await client.page.goto(`/console#trust-profile/${worker.user.id}`);
    await expect(
      client.page.getByText("Excellent finish and communication.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      client.page.getByText("5.00 / 5", { exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await client.context.close();
    await worker.context.close();
  }
});
