import { test, expect } from "@playwright/test";
import { generateTestUser, registerUser, loginUser, logout } from "./helpers/auth";

test.describe("Authentication", () => {
  test("should register a new user and redirect to dashboard", async ({ page }) => {
    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await expect(page).toHaveURL("/");
    await expect(page.getByText("DiscorDrive")).toBeVisible();
    await expect(page.getByText(user.email)).toBeVisible();
  });

  test("should show error for password mismatch on register", async ({ page }) => {
    await page.goto("/register");
    await page.getByLabel("Email").fill("mismatch@e2e.test");
    await page.getByLabel("Password", { exact: true }).fill("Password123!");
    await page.getByLabel("Confirm Password").fill("DifferentPassword!");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByText("Passwords do not match")).toBeVisible();
  });

  test("should show error for short password on register", async ({ page }) => {
    await page.goto("/register");
    await page.getByLabel("Email").fill("short@e2e.test");
    await page.getByLabel("Password", { exact: true }).fill("Short1!");
    await page.getByLabel("Confirm Password").fill("Short1!");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByText("Password must be at least 8 characters")).toBeVisible();
  });

  test("should login with valid credentials", async ({ page }) => {
    const user = generateTestUser();
    await registerUser(page, user.email, user.password);
    await logout(page);

    await loginUser(page, user.email, user.password);

    await expect(page).toHaveURL("/");
    await expect(page.getByText(user.email)).toBeVisible();
  });

  test("should show error for invalid credentials", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("nonexistent@e2e.test");
    await page.getByLabel("Password").fill("WrongPassword123!");
    await page.getByRole("button", { name: "Log in" }).click();

    await expect(page.getByText(/invalid|failed/i)).toBeVisible({ timeout: 10_000 });
  });

  test("should logout and redirect to login", async ({ page }) => {
    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await logout(page);

    await expect(page).toHaveURL("/login");
  });

  test("should redirect unauthenticated user to login", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL("/login");
  });

  test("should redirect unauthenticated user from settings to login", async ({ page }) => {
    await page.goto("/settings");
    await expect(page).toHaveURL("/login");
  });

  test("should navigate between login and register pages", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: "Register" }).click();
    await expect(page).toHaveURL("/register");

    await page.getByRole("link", { name: "Log in" }).click();
    await expect(page).toHaveURL("/login");
  });
});
