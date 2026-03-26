import { type Page } from "@playwright/test";

let userCounter = 0;

export function generateTestUser() {
  userCounter++;
  const timestamp = Date.now();
  return {
    email: `test-${timestamp}-${userCounter}@e2e.test`,
    password: "TestPassword123!",
  };
}

export async function registerUser(
  page: Page,
  email: string,
  password: string,
) {
  await page.goto("/register");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("/", { timeout: 30_000 });
}

export async function loginUser(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL("/", { timeout: 30_000 });
}

export async function logout(page: Page) {
  await page.locator("aside").getByRole("link", { name: "Settings" }).click();
  await page.waitForURL("/settings");
  await page.getByRole("button", { name: "Log out" }).first().click();
  await page.waitForURL("/login");
}
