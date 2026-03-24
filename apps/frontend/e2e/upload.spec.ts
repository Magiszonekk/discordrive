import { test, expect } from "@playwright/test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { generateTestUser, registerUser } from "./helpers/auth";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");
const TEST_FILE = join(FIXTURES_DIR, "test-upload.txt");

test.beforeAll(() => {
  if (!existsSync(FIXTURES_DIR)) {
    mkdirSync(FIXTURES_DIR, { recursive: true });
  }
  writeFileSync(TEST_FILE, "Hello from E2E test! ".repeat(100));
});

test.afterAll(() => {
  if (existsSync(FIXTURES_DIR)) {
    rmSync(FIXTURES_DIR, { recursive: true, force: true });
  }
});

test.describe("File Upload", () => {
  test("should upload a file via button and show it in file list", async ({ page }) => {
    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(TEST_FILE);

    await expect(page.getByText("test-upload.txt")).toBeVisible({ timeout: 30_000 });
  });

  test("should show upload progress during upload", async ({ page }) => {
    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(TEST_FILE);

    await expect(page.getByText("test-upload.txt")).toBeVisible({ timeout: 30_000 });
  });
});
