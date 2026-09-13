const { test, expect } = require("@playwright/test");

test("daily timeline renders durations, pans across dates and zooms to seconds", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/login");
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const { timeGrid, mountTimeGrid } = await import("/assets/time-grid.js");
    document.querySelector("#app").innerHTML =
      `<main style="padding:24px">${timeGrid()}</main>`;
    mountTimeGrid(
      document.querySelector("main"),
      {
        assignments: [{ id: 1, scope: "Foundation" }],
        entries: [
          {
            id: 4,
            subdivision_id: 1,
            date: "2026-09-08",
            hours: 4,
            note: "Legacy hours",
          },
          {
            id: 1,
            subdivision_id: 1,
            date: "2026-09-07",
            hours: 2,
            start_time: "00:00:00",
            end_time: "02:00:00",
            note: "Morning work",
          },
          {
            id: 2,
            subdivision_id: 1,
            date: "2026-09-07",
            hours: 1.5,
            start_time: "02:00:00",
            end_time: "03:30:00",
            note: "Finishing",
          },
          {
            id: 3,
            subdivision_id: 1,
            date: "2026-09-18",
            hours: 1,
            start_time: "00:00:00",
            end_time: "01:00:00",
            note: "Later date",
          },
        ],
      },
      { from: "2026-09-07", to: "2026-09-20" },
    );
  });
  const blocks = page.locator(".timeline-block");
  await expect(blocks).toHaveCount(2);
  await expect(page.locator(".timeline-unplaced")).toContainText("4 h");
  await expect(page.locator(".timeline-day").first()).toContainText(
    "3.50 h worked",
  );
  const a = await blocks.nth(0).boundingBox();
  const b = await blocks.nth(1).boundingBox();
  expect(a.height).toBe(120);
  expect(b.y).toBe(a.y + a.height);
  await blocks.first().click();
  await expect(page.locator(".timeline-detail")).toContainText("Morning work");
  await page.getByLabel("Timeline scale").selectOption("6");
  await page.getByLabel("Go to time").fill("00:00:00");
  await page.getByLabel("Go to time").dispatchEvent("change");
  await expect(page.locator(".timeline-tick").nth(1)).toHaveText("00:00:01");
  expect(await page.locator(".timeline-tick").count()).toBeLessThan(30);
  const grid = page.getByRole("region", { name: "Daily time grid" });
  await grid.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".timeline-status")).not.toContainText(
    "00:00:00 –",
  );
  await page.getByRole("button", { name: "Reset view" }).click();
  const box = await grid.boundingBox();
  await page.mouse.move(box.x + 700, box.y + 400);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 200, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator(".timeline-status")).not.toContainText(
    "00:00:00 –",
  );
  await grid.focus();
  for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Home");
  await expect(page.getByRole("button", { name: /Later date/ })).toBeVisible();
  await page.getByRole("button", { name: "Reset view" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(grid).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  expect(errors).toEqual([]);
});
