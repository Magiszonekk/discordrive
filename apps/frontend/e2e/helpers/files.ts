import { type Page, expect } from "@playwright/test";

/**
 * Upload a file via the hidden file input and wait for it to appear in the file table.
 */
export async function uploadTestFile(
  page: Page,
  filePath: string,
  fileName: string,
  timeout = 60_000,
): Promise<void> {
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(filePath);
  await expect(page.locator("tr", { hasText: fileName })).toBeVisible({
    timeout,
  });
}

/**
 * Open the ⋮ context menu for a file or folder row in the FileTable.
 * The ⋮ button uses `opacity-0 group-hover:opacity-100`, so we force-click it.
 */
export async function openFileContextMenu(
  page: Page,
  itemName: string,
): Promise<void> {
  const row = page.locator("tr", { hasText: itemName });
  await row.locator("button").last().click({ force: true });
}

/**
 * Open the ⋮ context menu for a folder in the sidebar.
 * The button is nested inside the folder link and is also opacity-0 until hover.
 */
export async function openSidebarFolderMenu(
  page: Page,
  folderName: string,
): Promise<void> {
  const folderLink = page
    .locator("aside")
    .locator("a", { hasText: folderName });
  await folderLink.locator("button").click({ force: true });
}
