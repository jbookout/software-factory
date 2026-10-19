import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
const html = await readFile(new URL("./tasks.html", import.meta.url), "utf8");
test.beforeEach(async ({ context }) => {
  await context.route("http://fixture.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
});
test("saved task survives reload", async ({ page }) => {
  await page.goto("http://fixture.test/tasks/new");
  await page.getByLabel("Title").fill("Buy milk");
  await page.getByRole("button", { name: "Save" }).click();
  await page.reload();
  await expect(page.getByTestId("tasks")).toContainText("Buy milk");
});
test("done filter", async ({ page }) => {
  await page.goto("http://fixture.test/tasks?filter=done");
  await expect(page.getByRole("listitem")).toHaveCount(1);
  await expect(page.getByTestId("tasks")).toContainText("Completed task");
});
test("blank title is refused", async ({ page }) => {
  await page.goto("http://fixture.test/tasks/new");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toHaveText("Title required");
  await expect(page.getByTestId("success")).toBeHidden();
});
test("archived empty state finishes loading", async ({ page }) => {
  await page.goto("http://fixture.test/tasks?filter=archived");
  await expect(page.getByTestId("state")).toHaveText("No archived tasks");
  await expect(page.getByRole("listitem")).toHaveCount(0);
});
test("admin access is denied", async ({ page }) => {
  await page.goto("http://fixture.test/admin");
  await expect(page.getByRole("alert")).toHaveText("Permission denied");
  await expect(page.getByRole("button", { name: "Delete all tasks" })).toHaveCount(0);
});
test("help opens in a new tab", async ({ page }) => {
  await page.goto("http://fixture.test/tasks");
  const popup = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Help" }).click();
  await expect(await popup).toHaveURL("http://fixture.test/help");
  await expect(page).toHaveURL("http://fixture.test/tasks");
  await expect((await popup).getByRole("heading")).toHaveText("Task help");
});
