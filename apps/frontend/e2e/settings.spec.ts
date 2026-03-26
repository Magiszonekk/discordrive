import { test, expect } from "@playwright/test";
import { generateTestUser, registerUser } from "./helpers/auth";

test.describe("Settings", () => {
  test("should display user email", async ({ page }) => {
    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await page.locator("aside").getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL("/settings");

    await expect(page.locator("main").getByText(user.email)).toBeVisible();
  });

  test("should display storage usage", async ({ page }) => {
    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await page.locator("aside").getByRole("link", { name: "Settings" }).click();

    await expect(page.getByText("Storage Usage")).toBeVisible();
    await expect(page.getByText(/used/)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("main").getByText(/\d+ files/)).toBeVisible();
  });

  test("should logout from settings page", async ({ page }) => {
    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await page.locator("aside").getByRole("link", { name: "Settings" }).click();

    await page.locator("main").getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL("/login");
  });
});
