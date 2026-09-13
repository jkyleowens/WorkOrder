const { test, expect } = require("@playwright/test");
const password = "test-password-123";
async function register(page, name, email) {
  await page.goto("/register");
  await page.getByLabel("Full name", { exact: true }).fill(name);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(
    page.getByRole("heading", { name: `Welcome back, ${name.split(" ")[0]}.` }),
  ).toBeVisible();
}
async function nav(page, name) {
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name, exact: true })
    .click();
  await expect(page.locator("#main")).toHaveAttribute("aria-busy", "false");
}
async function submit(page, name) {
  await page
    .getByRole("dialog")
    .getByRole("button", { name, exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator("#main")).toHaveAttribute("aria-busy", "false");
}
async function confirm(page, trigger, confirmation = trigger) {
  await page.getByRole("button", { name: trigger, exact: true }).click();
  await submit(page, confirmation);
}
async function organization(page, destination) {
  await nav(page, "Organizations");
  await page
    .getByRole("link", { name: "View organization", exact: true })
    .click();
  if (destination)
    await page.getByRole("link", { name: destination, exact: true }).click();
}
async function createProject(page, title, scopes) {
  await nav(page, "Projects");
  await page
    .getByRole("button", { name: "Post a project", exact: true })
    .first()
    .click();
  await page.getByLabel("Project title").fill(title);
  await page
    .getByLabel("Description", { exact: true })
    .fill("A shared construction project, built with care.");
  await page
    .getByLabel("Subdivisions (one scope per line, optional)")
    .fill(scopes);
  await submit(page, "Post project");
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
}
async function project(page, title) {
  await nav(page, "Projects");
  await page
    .getByRole("heading", { name: title, exact: true })
    .getByRole("link")
    .click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await expect(page.locator("#main")).toHaveAttribute("aria-busy", "false");
}
async function profile(page, rate) {
  await nav(page, "My profile");
  await page.getByRole("button", { name: "Edit profile" }).click();
  await page
    .getByLabel("Skills (one per line)")
    .fill("Paving\nProject management");
  await page.getByLabel("Hourly rate").fill(String(rate));
  await submit(page, "Save changes");
}
async function logTime(page, assignment, hours) {
  await nav(page, "Time & reports");
  await page
    .getByRole("button", { name: "Log time", exact: true })
    .first()
    .click();
  await page
    .getByLabel("Project / assignment", { exact: true })
    .selectOption({ label: assignment });
  await page.getByLabel("Entry type").selectOption("duration");
  await page.getByLabel("Hours", { exact: true }).fill(String(hours));
  await page.getByRole("button", { name: "Save time entries" }).click();
  await expect(page.locator("#main")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByLabel("Hours", { exact: true })).toHaveValue("");
}

test("registration, validation, profile persistence, logout and login", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/register");
  await expect(
    page.getByRole("heading", { name: "Create your account" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/register-desktop.png",
    fullPage: true,
  });
  await register(page, "Avery Stone", "avery-console@example.com");
  await profile(page, 42.5);
  await page.reload();
  await expect(page.getByText("42.50 / hour")).toBeVisible();
  await expect(page.getByText("Paving", { exact: true })).toBeVisible();
  await page
    .locator("#main")
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await submit(page, "Sign out");
  await expect(
    page.getByRole("heading", { name: "Welcome back", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Email address").fill("avery-console@example.com");
  await page.getByLabel("Password", { exact: true }).fill("incorrect-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Invalid email or password",
  );
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back, Avery." }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Welcome back, Avery." }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("three users hire, award mixed work, record resources, and verify live rollups", async ({
  browser,
}) => {
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ]);
  const [client, owner, worker] = await Promise.all(
    contexts.map((c) => c.newPage()),
  );
  const errors = [];
  for (const p of [client, owner, worker])
    p.on("pageerror", (e) => errors.push(e.message));
  try {
    await register(client, "Casey Client", "casey-console@example.com");
    await register(owner, "Morgan Builder", "morgan-console@example.com");
    await register(worker, "Riley Worker", "riley-console@example.com");
    await nav(owner, "Organizations");
    await owner
      .getByRole("button", { name: "Create organization", exact: true })
      .first()
      .click();
    await owner.getByLabel("Organization name").fill("Acme Builders");
    await owner.getByLabel("Trade or focus").fill("Construction");
    await submit(owner, "Create organization");
    await organization(owner);
    await expect(
      owner.getByRole("button", { name: "Edit organization" }),
    ).toBeVisible();
    await owner.getByRole("button", { name: "Edit organization" }).click();
    await owner.getByLabel("Trade or focus").fill("Construction & site work");
    await submit(owner, "Save changes");
    await expect(owner.locator(".page-heading")).toContainText(
      "Construction & site work",
    );
    await nav(owner, "Employment");
    await owner
      .getByRole("button", { name: "Post a job", exact: true })
      .first()
      .click();
    await owner.getByLabel("Act as").selectOption({ label: "Acme Builders" });
    await owner.getByLabel("Job title").fill("Paving specialist");
    await owner
      .getByLabel("Description", { exact: true })
      .fill("Join our construction team.");
    await owner.getByLabel("Advertised hourly pay").fill("30");
    await submit(owner, "Post job");
    await nav(worker, "Employment");
    await worker
      .getByRole("article")
      .filter({
        has: worker.getByRole("heading", { name: "Paving specialist" }),
      })
      .getByRole("link", { name: "View role" })
      .click();
    await confirm(worker, "Apply for this role", "Apply");
    await owner.reload();
    await confirm(owner, "Make offer");
    await nav(worker, "Employment");
    await worker
      .getByRole("link", { name: "My applications", exact: true })
      .click();
    await confirm(worker, "Accept offer");
    await expect(
      worker
        .getByLabel("Your context")
        .locator("option", { hasText: "Acme Builders" }),
    ).toHaveCount(0);
    await nav(owner, "Organizations");
    await owner.getByRole("link", { name: "View organization" }).click();
    await expect(
      owner.getByRole("cell").filter({ hasText: "Riley Worker" }),
    ).toBeVisible();
    await createProject(client, "Driveway renovation", "Paving\nSite cleanup");
    await project(owner, "Driveway renovation");
    let paving = owner.locator(".subdivision").filter({
      has: owner.getByRole("heading", { name: "Paving", exact: true }),
    });
    await paving.getByRole("button", { name: "Submit a bid" }).click();
    await owner.getByLabel("Act as").selectOption({ label: "Acme Builders" });
    await owner.getByLabel("Bid amount").fill("1200");
    await submit(owner, "Submit bid");
    await project(worker, "Driveway renovation");
    let cleanup = worker.locator(".subdivision").filter({
      has: worker.getByRole("heading", { name: "Site cleanup", exact: true }),
    });
    await cleanup.getByRole("button", { name: "Submit a bid" }).click();
    await worker.getByLabel("Bid amount").fill("200");
    await submit(worker, "Submit bid");
    await client.reload();
    for (const title of ["Paving", "Site cleanup"]) {
      const section = client.locator(".subdivision").filter({
        has: client.getByRole("heading", { name: title, exact: true }),
      });
      await section.getByRole("button", { name: "Award bid" }).click();
      await submit(client, "Award bid");
    }
    await profile(worker, 90);
    await logTime(worker, "Driveway renovation · Paving (Acme Builders)", 4);
    await logTime(
      worker,
      "Driveway renovation · Site cleanup (independent)",
      2,
    );
    await expect(
      worker.locator(".stat").filter({ hasText: "Total hours" }),
    ).toContainText("6.00");
    await organization(owner, "Shared inventory");
    await owner
      .getByRole("button", { name: "Add inventory", exact: true })
      .first()
      .click();
    await owner.getByLabel("Item name").fill("Paving stone");
    await owner.getByLabel("Opening stock").fill("20");
    await owner.getByLabel("Unit cost").fill("2.50");
    await submit(owner, "Add item");
    await owner.getByRole("button", { name: "Receive stock" }).click();
    await owner.getByLabel("Quantity received").fill("5");
    await owner.getByLabel("Reason").fill("Morning delivery");
    await submit(owner, "Receive stock");
    await project(worker, "Driveway renovation");
    paving = worker.locator(".subdivision").filter({
      has: worker.getByRole("heading", { name: "Paving", exact: true }),
    });
    await paving.getByRole("button", { name: "Use materials" }).click();
    await worker.getByLabel("Quantity to use").fill("7");
    await submit(worker, "Record usage");
    await organization(owner, "Team reports");
    await expect(
      owner.locator(".stat").filter({ hasText: "Total hours" }),
    ).toContainText("4.00");
    await expect(
      owner.locator(".stat").filter({ hasText: "Labor cost" }),
    ).toContainText("120.00");
    await expect(
      owner.locator(".stat").filter({ hasText: "Material cost" }),
    ).toContainText("17.50");
    await nav(owner, "Overview");
    await owner.screenshot({
      path: "test-results/console-desktop.png",
      fullPage: true,
    });
    await organization(owner, "Shared inventory");
    await expect(
      owner.getByRole("row").filter({ hasText: "Paving stone" }),
    ).toContainText("18");
    await owner.getByRole("button", { name: "History" }).click();
    await expect(owner.getByRole("dialog")).toContainText("Morning delivery");
    await owner.getByRole("button", { name: "Close dialog" }).click();
    await nav(worker, "Time & reports");
    const timeRow = worker.getByRole("row").filter({ hasText: "Site cleanup" });
    await timeRow.getByRole("button", { name: "Edit", exact: true }).click();
    await worker.getByRole("dialog").getByLabel("Hours", { exact: true }).fill("3");
    await submit(worker, "Save changes");
    await expect(
      worker.locator(".stat").filter({ hasText: "Total hours" }),
    ).toContainText("7.00");
    await project(client, "Driveway renovation");
    await expect(
      client.locator(".subdivision").filter({
        has: client.getByRole("heading", { name: "Paving", exact: true }),
      }),
    ).toContainText("17.50");
    for (const title of ["Paving", "Site cleanup"]) {
      const section = client.locator(".subdivision").filter({
        has: client.getByRole("heading", { name: title, exact: true }),
      });
      await section.getByRole("button", { name: "Complete work" }).click();
      await submit(client, "Complete work");
    }
    await expect(client.locator(".page-heading .status")).toHaveText(
      "completed",
    );
    await client.reload();
    await expect(client.locator(".page-heading .status")).toHaveText(
      "completed",
    );
    expect(errors).toEqual([]);
  } finally {
    await Promise.allSettled(contexts.map((c) => c.close()));
  }
});

test("mobile console, empty states and safe rendering of profile text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await register(page, "Mobile Person", "mobile-console@example.com");
  await nav(page, "My profile");
  await page.getByRole("button", { name: "Edit profile" }).click();
  await page
    .getByLabel("Skills (one per line)")
    .fill("<img src=x onerror=alert(1)>");
  await submit(page, "Save changes");
  await expect(
    page.getByText("<img src=x onerror=alert(1)>", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("img[src=x]")).toHaveCount(0);
  await nav(page, "Time & reports");
  await page
    .getByRole("button", { name: "Log time", exact: true })
    .first()
    .click();
  await expect(page.locator("#main")).toContainText("No active assignments");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await nav(page, "Overview");
  await page.screenshot({
    path: "test-results/console-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("project work breakdown supports nested scopes without switching workspaces", async ({
  page,
}) => {
  await register(page, "Project Planner", "planner@example.com");
  await expect(page.getByLabel("Your context")).toHaveCount(0);
  await createProject(page, "Workshop build", "Structure");
  await page
    .getByRole("button", { name: "Add child scopes", exact: true })
    .click();
  await page.getByLabel("Scopes (one per line)").fill("Roofing");
  await submit(page, "Save changes");
  const child = page.locator(".subdivision").filter({
    has: page.getByRole("heading", { name: "Roofing", exact: true }),
  });
  await expect(child).toContainText("Scope 1.1");
  await child.getByRole("button", { name: "Add child scopes" }).click();
  await page.getByLabel("Scopes (one per line)").fill("Flashing");
  await submit(page, "Save changes");
  await expect(
    page.locator(".subdivision").filter({
      has: page.getByRole("heading", { name: "Flashing", exact: true }),
    }),
  ).toContainText("Scope 1.1.1");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Flashing", exact: true }),
  ).toBeVisible();
});

test("company roles, negotiated pay and member overrides stay connected", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext(),
    workerContext = await browser.newContext();
  const owner = await ownerContext.newPage(),
    worker = await workerContext.newPage();
  const errors = [];
  owner.on("pageerror", (e) => errors.push(e.message));
  worker.on("pageerror", (e) => errors.push(e.message));
  try {
    await register(owner, "Pay Administrator", "pay-admin@example.com");
    await register(worker, "Skilled Installer", "pay-worker@example.com");
    await nav(owner, "Organizations");
    await owner
      .getByRole("button", { name: "Create organization", exact: true })
      .first()
      .click();
    await owner.getByLabel("Organization name").fill("Pay Builders");
    await submit(owner, "Create organization");
    await organization(owner);
    await owner.getByRole("button", { name: "Create company role" }).click();
    await owner.getByLabel("Role name").fill("Installer");
    await owner
      .getByLabel("Responsibilities")
      .fill("Install and inspect fixtures");
    await owner
      .getByLabel("Required skills (one per line)")
      .fill("Installation\nInspection");
    await owner.getByLabel("Base hourly pay").fill("30");
    await submit(owner, "Save changes");
    await owner
      .getByRole("button", { name: "Post a job", exact: true })
      .click();
    await owner
      .getByLabel("Company role (optional)")
      .selectOption({ label: "Installer" });
    await expect(owner.getByLabel("Advertised hourly pay")).toHaveValue(
      "30.00",
    );
    await submit(owner, "Post job");
    await nav(worker, "Employment");
    await worker
      .getByRole("article")
      .filter({
        has: worker.getByRole("heading", { name: "Installer", exact: true }),
      })
      .getByRole("link", { name: "View role" })
      .click();
    await worker.getByRole("button", { name: "Apply for this role" }).click();
    await worker.getByLabel("Desired hourly pay").fill("35");
    await worker
      .getByLabel("Message to employer")
      .fill("Five years of experience");
    await submit(worker, "Apply");
    await owner.reload();
    await owner
      .getByRole("button", { name: "Make offer", exact: true })
      .click();
    await owner.getByLabel("Offered hourly pay").fill("32");
    await submit(owner, "Make offer");
    await nav(worker, "Employment");
    await worker
      .getByRole("link", { name: "My applications", exact: true })
      .click();
    await worker.getByRole("button", { name: "Negotiate pay" }).click();
    await worker.getByLabel("Desired hourly pay").fill("34");
    await worker
      .getByLabel("Message to employer")
      .fill("Could we agree on 34?");
    await submit(worker, "Send request");
    await expect(
      worker.getByRole("button", { name: "Accept offer" }),
    ).toHaveCount(0);
    await owner.reload();
    await owner.getByRole("button", { name: "Pay discussion" }).click();
    await expect(owner.getByRole("dialog")).toContainText(
      "Could we agree on 34?",
    );
    await owner.getByRole("button", { name: "Close dialog" }).click();
    await confirm(owner, "Make offer");
    await worker.reload();
    await confirm(worker, "Accept offer");
    await organization(owner);
    const roster = owner
      .getByRole("row")
      .filter({ hasText: "Skilled Installer" });
    await expect(roster).toContainText("34.00 / hour");
    await expect(roster).toContainText("Individual agreement");
    await owner.getByRole("button", { name: "Edit company role" }).click();
    await owner.getByLabel("Role name").fill("Senior installer");
    await owner.getByLabel("Base hourly pay").fill("40");
    await submit(owner, "Save changes");
    await expect(roster).toContainText("Senior installer");
    await expect(roster).toContainText("34.00 / hour");
    await roster.getByRole("button", { name: "Role & pay" }).click();
    await owner.getByLabel("Individual hourly pay (optional)").fill("");
    await submit(owner, "Save changes");
    await expect(roster).toContainText("40.00 / hour");
    await expect(roster).toContainText("Role base pay");
    await owner.reload();
    await expect(roster).toContainText("40.00 / hour");
    await owner.screenshot({
      path: "test-results/company-pay.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await ownerContext.close();
    await workerContext.close();
  }
});

test("organization types and notification inbox persist across refresh", async ({
  browser,
}) => {
  const employerContext = await browser.newContext(),
    applicantContext = await browser.newContext();
  const employer = await employerContext.newPage(),
    applicant = await applicantContext.newPage();
  try {
    await register(employer, "Inbox Employer", "inbox-employer@example.com");
    await register(applicant, "Inbox Applicant", "inbox-applicant@example.com");
    await nav(employer, "Organizations");
    await employer
      .getByRole("button", { name: "Create organization", exact: true })
      .first()
      .click();
    await employer.getByLabel("Organization name").fill("United Trades");
    await employer.getByLabel("Supplier", { exact: true }).check();
    await employer.getByLabel("Labor union", { exact: true }).check();
    await submit(employer, "Create organization");
    await employer.reload();
    await expect(employer.locator(".organization-types")).toContainText(
      "Supplier",
    );
    await organization(employer);
    await employer.getByRole("button", { name: "Edit organization" }).click();
    await expect(
      employer.getByLabel("Labor union", { exact: true }),
    ).toBeChecked();
    await employer.getByLabel("Contractor", { exact: true }).check();
    await submit(employer, "Save changes");
    await employer
      .getByRole("button", { name: "Post a job", exact: true })
      .click();
    await employer.getByLabel("Job title").fill("Inbox installer");
    await employer
      .getByLabel("Description", { exact: true })
      .fill("Install equipment");
    await employer.getByLabel("Advertised hourly pay").fill("30");
    await submit(employer, "Post job");
    await nav(applicant, "Employment");
    await applicant
      .getByRole("article")
      .filter({ hasText: "Inbox installer" })
      .getByRole("link", { name: "View role" })
      .click();
    await confirm(applicant, "Apply for this role", "Apply");
    await nav(employer, "Inbox");
    await expect(
      employer.getByRole("heading", { name: "New application", exact: true }),
    ).toBeVisible();
    await employer.screenshot({
      path: "test-results/inbox-desktop.png",
      fullPage: true,
    });
    await employer
      .getByRole("link", { name: "View details", exact: true })
      .click();
    await confirm(employer, "Make offer");
    await nav(applicant, "Inbox");
    await expect(
      applicant.getByRole("heading", { name: "Application offered" }),
    ).toBeVisible();
    await applicant
      .getByRole("button", { name: "Mark as read", exact: true })
      .click();
    await expect(applicant.locator(".notification.is-unread")).toHaveCount(0);
    await applicant.reload();
    await expect(applicant.locator(".notification-meta")).toContainText("READ");
    await applicant
      .getByRole("link", { name: "Unread (0)", exact: true })
      .click();
    await expect(
      applicant.getByRole("heading", { name: "You’re all caught up" }),
    ).toBeVisible();
    await employer.setViewportSize({ width: 390, height: 844 });
    await nav(employer, "Inbox");
    await employer.screenshot({
      path: "test-results/inbox-mobile.png",
      fullPage: true,
    });
    expect(
      await employer.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await employer
      .getByRole("button", { name: "Mark all as read", exact: true })
      .click();
    await expect(employer.locator(".notification.is-unread")).toHaveCount(0);
  } finally {
    await employerContext.close();
    await applicantContext.close();
  }
});
