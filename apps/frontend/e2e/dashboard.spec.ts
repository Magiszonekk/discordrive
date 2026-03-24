import { test, expect } from "@playwright/test";
import { generateTestUser, registerUser } from "./helpers/auth";

test.describe("Dashboard", () => {
  test("should show empty state for new user", async ({ page }) => {
    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await expect(page.getByText("No files in this folder yet")).toBeVisible();
    await expect(page.getByText("Upload a file to get started")).toBeVisible();
  });

  test("should show sidebar with navigation links", async ({ page }) => {
    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    const sidebar = page.locator("aside");
    await expect(sidebar.getByRole("link", { name: "All Files" })).toBeVisible();
    await expect(page.locator('a[title="Settings"]')).toBeVisible();
  });

  test("should show Upload Files button", async ({ page }) => {
    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await expect(page.getByRole("button", { name: "Upload Files" })).toBeVisible();
  });

  test("should show New Folder button in sidebar", async ({ page }) => {
    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await expect(page.getByRole("button", { name: "New Folder" })).toBeVisible();
  });

  test("should navigate to settings and back", async ({ page }) => {
    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await page.locator('a[title="Settings"]').click();
    await expect(page).toHaveURL("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    await page.locator("aside").getByRole("link", { name: "All Files" }).click();
    await expect(page).toHaveURL("/");
  });
});
