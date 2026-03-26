import { test, expect } from "@playwright/test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { generateTestUser, registerUser } from "./helpers/auth";
import { uploadTestFile, openFileContextMenu } from "./helpers/files";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");
const TEST_FILE = join(FIXTURES_DIR, "test-share.txt");

test.beforeAll(() => {
  if (!existsSync(FIXTURES_DIR)) {
    mkdirSync(FIXTURES_DIR, { recursive: true });
  }
  writeFileSync(TEST_FILE, "Share link test content. ".repeat(50));
});

test.afterAll(() => {
  if (existsSync(FIXTURES_DIR)) {
    rmSync(FIXTURES_DIR, { recursive: true, force: true });
  }
});

test.describe("Share Links", () => {
  test("should open share dialog via context menu", async ({ page }) => {
    test.setTimeout(120_000);

    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await uploadTestFile(page, TEST_FILE, "test-share.txt");

    await openFileContextMenu(page, "test-share.txt");
    await page.getByRole("button", { name: "Share" }).click();

    // ShareDialog should appear
    await expect(page.getByText("Share file")).toBeVisible();
    await expect(page.locator(".fixed.z-50").getByText("test-share.txt")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create Share Link" }),
    ).toBeVisible();
  });

  test("should create a share link", async ({ page }) => {
    test.setTimeout(120_000);

    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await uploadTestFile(page, TEST_FILE, "test-share.txt");

    await openFileContextMenu(page, "test-share.txt");
    await page.getByRole("button", { name: "Share" }).click();

    // Click Create Share Link
    await page.getByRole("button", { name: "Create Share Link" }).click();

    // Success message appears
    await expect(
      page.getByText("Link created and copied to clipboard!"),
    ).toBeVisible({ timeout: 15_000 });

    // Read-only input with the share URL is visible
    const urlInput = page.locator("input[readonly]");
    await expect(urlInput).toBeVisible();
    const urlValue = await urlInput.inputValue();
    expect(urlValue).toContain("/share/");
  });

  test("should create a share link with a custom label", async ({ page }) => {
    test.setTimeout(120_000);

    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await uploadTestFile(page, TEST_FILE, "test-share.txt");

    await openFileContextMenu(page, "test-share.txt");
    await page.getByRole("button", { name: "Share" }).click();

    // Fill label before creating
    await page.getByPlaceholder("Label (optional)").fill("My Link");
    await page.getByRole("button", { name: "Create Share Link" }).click();

    await expect(
      page.getByText("Link created and copied to clipboard!"),
    ).toBeVisible({ timeout: 15_000 });

    // The label appears in the Existing links section
    await expect(page.getByText("My Link")).toBeVisible({ timeout: 10_000 });
  });

  test("should delete a share link", async ({ page }) => {
    test.setTimeout(120_000);

    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await uploadTestFile(page, TEST_FILE, "test-share.txt");

    // Create a link first
    await openFileContextMenu(page, "test-share.txt");
    await page.getByRole("button", { name: "Share" }).click();
    await page.getByRole("button", { name: "Create Share Link" }).click();
    await expect(
      page.getByText("Link created and copied to clipboard!"),
    ).toBeVisible({ timeout: 15_000 });

    // Wait for Existing links to appear
    await expect(page.getByText(/Existing links/)).toBeVisible({ timeout: 10_000 });

    // Delete the link
    await page.getByRole("button", { name: "Delete" }).first().click();

    // Existing links section disappears (no more links)
    await expect(page.getByText(/Existing links/)).not.toBeVisible({ timeout: 10_000 });
  });

  test("should close share dialog with X button", async ({ page }) => {
    test.setTimeout(120_000);

    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await uploadTestFile(page, TEST_FILE, "test-share.txt");

    await openFileContextMenu(page, "test-share.txt");
    await page.getByRole("button", { name: "Share" }).click();

    await expect(page.getByText("Share file")).toBeVisible();

    // Close via the X button (first button in the dialog overlay)
    const dialog = page.locator(".fixed.z-50");
    await dialog.locator("button").first().click();

    await expect(page.getByText("Share file")).not.toBeVisible();
  });
});
