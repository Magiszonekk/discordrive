import { test, expect } from "@playwright/test";
import { generateTestUser, registerUser } from "./helpers/auth";
import { openFileContextMenu, openSidebarFolderMenu } from "./helpers/files";

test.describe("Folder Management", () => {
  test("should create a folder via sidebar New Folder button", async ({ page }) => {
    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await page.getByRole("button", { name: "New Folder" }).click();

    const input = page.getByPlaceholder("Folder name");
    await expect(input).toBeVisible();
    await input.fill("My Test Folder");
    await input.press("Enter");

    // Folder appears in sidebar
    await expect(
      page.locator("aside").getByRole("link", { name: "My Test Folder" }),
    ).toBeVisible({ timeout: 10_000 });

    // Folder appears in file table
    await expect(
      page.locator("tr", { hasText: "My Test Folder" }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("should cancel folder creation when input is left empty", async ({ page }) => {
    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await page.getByRole("button", { name: "New Folder" }).click();
    await expect(page.getByPlaceholder("Folder name")).toBeVisible();

    // Blur without typing — form should close
    await page.keyboard.press("Escape");
    await expect(page.getByPlaceholder("Folder name")).not.toBeVisible();
    await expect(page.getByRole("button", { name: "New Folder" })).toBeVisible();
  });

  test("should navigate into a folder on row click", async ({ page }) => {
    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    // Create a folder
    await page.getByRole("button", { name: "New Folder" }).click();
    await page.getByPlaceholder("Folder name").fill("Navigate Folder");
    await page.getByPlaceholder("Folder name").press("Enter");
    await expect(page.locator("tr", { hasText: "Navigate Folder" })).toBeVisible({
      timeout: 10_000,
    });

    // Click folder row
    await page.locator("tr", { hasText: "Navigate Folder" }).click();
    await expect(page).toHaveURL(/\/folder\/.+/, { timeout: 10_000 });

    // Empty state inside the folder
    await expect(page.getByText("No files in this folder yet")).toBeVisible();
  });

  test("should rename a folder via sidebar context menu", async ({ page }) => {
    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await page.getByRole("button", { name: "New Folder" }).click();
    await page.getByPlaceholder("Folder name").fill("Old Name");
    await page.getByPlaceholder("Folder name").press("Enter");
    await expect(page.locator("aside").getByRole("link", { name: "Old Name" })).toBeVisible({
      timeout: 10_000,
    });

    // Open context menu and rename
    await openSidebarFolderMenu(page, "Old Name");
    await page.getByRole("button", { name: "Rename" }).click();

    const renameInput = page.locator("aside").locator("input");
    await renameInput.clear();
    await renameInput.fill("New Name");
    await renameInput.press("Tab"); // blur to submit

    await expect(page.locator("aside").getByRole("link", { name: "New Name" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.locator("aside").getByRole("link", { name: "Old Name" }),
    ).not.toBeVisible();
  });

  test("should delete an empty folder via sidebar context menu", async ({ page }) => {
    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await page.getByRole("button", { name: "New Folder" }).click();
    await page.getByPlaceholder("Folder name").fill("Delete Me");
    await page.getByPlaceholder("Folder name").press("Enter");
    await expect(page.locator("aside").getByRole("link", { name: "Delete Me" })).toBeVisible({
      timeout: 10_000,
    });

    // Open context menu and delete
    await openSidebarFolderMenu(page, "Delete Me");
    await page.getByRole("button", { name: "Delete" }).click();

    // Confirm dialog should appear
    await expect(page.getByText("Delete folder")).toBeVisible();
    await page.getByRole("button", { name: "Delete" }).click();

    // Folder gone from sidebar
    await expect(
      page.locator("aside").getByRole("link", { name: "Delete Me" }),
    ).not.toBeVisible({ timeout: 10_000 });
  });

  test("should rename a folder via FileTable context menu", async ({ page }) => {
    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await page.getByRole("button", { name: "New Folder" }).click();
    await page.getByPlaceholder("Folder name").fill("Table Rename");
    await page.getByPlaceholder("Folder name").press("Enter");
    await expect(page.locator("tr", { hasText: "Table Rename" })).toBeVisible({
      timeout: 10_000,
    });

    await openFileContextMenu(page, "Table Rename");
    await page.getByRole("button", { name: "Rename" }).click();

    const renameInput = page.locator("tr input");
    await renameInput.clear();
    await renameInput.fill("Table Renamed");
    await renameInput.press("Tab");

    await expect(page.locator("tr", { hasText: "Table Renamed" })).toBeVisible({
      timeout: 10_000,
    });
  });

  test("should delete an empty folder via FileTable context menu", async ({ page }) => {
    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await page.getByRole("button", { name: "New Folder" }).click();
    await page.getByPlaceholder("Folder name").fill("Table Delete");
    await page.getByPlaceholder("Folder name").press("Enter");
    await expect(page.locator("tr", { hasText: "Table Delete" })).toBeVisible({
      timeout: 10_000,
    });

    await openFileContextMenu(page, "Table Delete");
    await page.getByRole("button", { name: "Delete" }).click();

    await expect(page.getByText("Delete folder")).toBeVisible();
    await page.getByRole("button", { name: "Delete" }).click();

    await expect(page.locator("tr", { hasText: "Table Delete" })).not.toBeVisible({
      timeout: 10_000,
    });
  });
});
