import { test, expect } from "@playwright/test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { generateTestUser, registerUser } from "./helpers/auth";
import { uploadTestFile } from "./helpers/files";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");
const FILE_ALPHA = join(FIXTURES_DIR, "alpha-file.txt");
const FILE_BETA = join(FIXTURES_DIR, "beta-file.txt");

test.beforeAll(() => {
  if (!existsSync(FIXTURES_DIR)) {
    mkdirSync(FIXTURES_DIR, { recursive: true });
  }
  writeFileSync(FILE_ALPHA, "Alpha file content. ".repeat(30));
  writeFileSync(FILE_BETA, "Beta file content. ".repeat(30));
});

test.afterAll(() => {
  if (existsSync(FIXTURES_DIR)) {
    rmSync(FIXTURES_DIR, { recursive: true, force: true });
  }
});

test.describe("Search and Filter", () => {
  test("should filter files by name", async ({ page }) => {
    test.setTimeout(120_000);

    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    // Upload two files
    await uploadTestFile(page, FILE_ALPHA, "alpha-file.txt");
    await uploadTestFile(page, FILE_BETA, "beta-file.txt");

    const searchInput = page.getByPlaceholder("Search files...");

    // Type a query matching only the first file
    await searchInput.fill("alpha");
    await expect(page.locator("tr", { hasText: "alpha-file.txt" })).toBeVisible();
    await expect(page.locator("tr", { hasText: "beta-file.txt" })).not.toBeVisible();

    // Clear search — both files visible again
    await searchInput.clear();
    await expect(page.locator("tr", { hasText: "alpha-file.txt" })).toBeVisible();
    await expect(page.locator("tr", { hasText: "beta-file.txt" })).toBeVisible();
  });

  test("should filter files case-insensitively", async ({ page }) => {
    test.setTimeout(120_000);

    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await uploadTestFile(page, FILE_ALPHA, "alpha-file.txt");

    // Search with uppercase
    await page.getByPlaceholder("Search files...").fill("ALPHA");
    await expect(page.locator("tr", { hasText: "alpha-file.txt" })).toBeVisible();
  });

  test("should show no rows when search matches nothing", async ({ page }) => {
    test.setTimeout(120_000);

    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await uploadTestFile(page, FILE_ALPHA, "alpha-file.txt");

    await page.getByPlaceholder("Search files...").fill("zzznomatch");

    // No file rows visible
    await expect(page.locator("tr", { hasText: "alpha-file.txt" })).not.toBeVisible();
  });

  test("should filter folders by name", async ({ page }) => {
    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    // Create two folders
    await page.getByRole("button", { name: "New Folder" }).click();
    await page.getByPlaceholder("Folder name").fill("AlphaFolder");
    await page.getByPlaceholder("Folder name").press("Enter");
    await expect(page.locator("tr", { hasText: "AlphaFolder" })).toBeVisible({
      timeout: 10_000,
    });

    await page.getByRole("button", { name: "New Folder" }).click();
    await page.getByPlaceholder("Folder name").fill("BetaFolder");
    await page.getByPlaceholder("Folder name").press("Enter");
    await expect(page.locator("tr", { hasText: "BetaFolder" })).toBeVisible({
      timeout: 10_000,
    });

    // Filter by "alpha"
    await page.getByPlaceholder("Search files...").fill("alpha");
    await expect(page.locator("tr", { hasText: "AlphaFolder" })).toBeVisible();
    await expect(page.locator("tr", { hasText: "BetaFolder" })).not.toBeVisible();

    // Clear filter
    await page.getByPlaceholder("Search files...").clear();
    await expect(page.locator("tr", { hasText: "AlphaFolder" })).toBeVisible();
    await expect(page.locator("tr", { hasText: "BetaFolder" })).toBeVisible();
  });
});
