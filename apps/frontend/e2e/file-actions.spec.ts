import { test, expect } from "@playwright/test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { generateTestUser, registerUser } from "./helpers/auth";
import { uploadTestFile, openFileContextMenu } from "./helpers/files";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");
const TEST_FILE = join(FIXTURES_DIR, "test-actions.txt");

test.beforeAll(() => {
  if (!existsSync(FIXTURES_DIR)) {
    mkdirSync(FIXTURES_DIR, { recursive: true });
  }
  writeFileSync(TEST_FILE, "File actions test content. ".repeat(50));
});

test.afterAll(() => {
  if (existsSync(FIXTURES_DIR)) {
    rmSync(FIXTURES_DIR, { recursive: true, force: true });
  }
});

test.describe("File Actions", () => {
  test("should rename a file via context menu", async ({ page }) => {
    test.setTimeout(120_000);

    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await uploadTestFile(page, TEST_FILE, "test-actions.txt");

    // Open context menu and click Rename
    await openFileContextMenu(page, "test-actions.txt");
    await page.getByRole("button", { name: "Rename" }).click();

    // Inline input appears in the file row
    const renameInput = page.locator("tr input");
    await expect(renameInput).toBeVisible();
    await expect(renameInput).toHaveValue("test-actions.txt");

    // Clear and type new name
    await renameInput.clear();
    await renameInput.fill("renamed-file.txt");
    await renameInput.press("Tab"); // blur to submit

    // New name visible in table
    await expect(page.locator("tr", { hasText: "renamed-file.txt" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator("tr", { hasText: "test-actions.txt" })).not.toBeVisible();
  });

  test("should cancel rename with Escape key", async ({ page }) => {
    test.setTimeout(120_000);

    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await uploadTestFile(page, TEST_FILE, "test-actions.txt");

    await openFileContextMenu(page, "test-actions.txt");
    await page.getByRole("button", { name: "Rename" }).click();

    const renameInput = page.locator("tr input");
    await expect(renameInput).toBeVisible();

    await renameInput.fill("should-not-save.txt");
    await renameInput.press("Escape");

    // Original name still shown
    await expect(page.locator("tr", { hasText: "test-actions.txt" })).toBeVisible();
    await expect(page.locator("tr", { hasText: "should-not-save.txt" })).not.toBeVisible();
  });

  test("should cancel file deletion via Cancel button", async ({ page }) => {
    test.setTimeout(120_000);

    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await uploadTestFile(page, TEST_FILE, "test-actions.txt");

    await openFileContextMenu(page, "test-actions.txt");
    await page.getByRole("button", { name: "Delete" }).click();

    // ConfirmDialog appears
    await expect(page.getByText("Delete file")).toBeVisible();
    await expect(page.locator("p").filter({ hasText: "test-actions.txt" })).toBeVisible();

    // Cancel — file stays
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Delete file")).not.toBeVisible();
    await expect(page.locator("tr", { hasText: "test-actions.txt" })).toBeVisible();
  });

  test("should delete a file via context menu with confirmation", async ({ page }) => {
    test.setTimeout(120_000);

    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await uploadTestFile(page, TEST_FILE, "test-actions.txt");

    await openFileContextMenu(page, "test-actions.txt");
    await page.getByRole("button", { name: "Delete" }).click();

    // ConfirmDialog appears with file-specific title and message
    await expect(page.getByText("Delete file")).toBeVisible();
    await expect(page.locator("p").filter({ hasText: /test-actions\.txt/ })).toBeVisible();

    // Confirm deletion
    await page.getByRole("button", { name: "Delete" }).click();

    // File row disappears
    await expect(page.locator("tr", { hasText: "test-actions.txt" })).not.toBeVisible({
      timeout: 10_000,
    });
  });
});
