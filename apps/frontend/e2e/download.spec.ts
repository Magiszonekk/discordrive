import { test, expect } from "@playwright/test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { generateTestUser, registerUser } from "./helpers/auth";
import { uploadTestFile, openFileContextMenu } from "./helpers/files";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");
const TEST_FILE = join(FIXTURES_DIR, "test-download.txt");
const TEST_CONTENT = "Download test content! ".repeat(100);

test.beforeAll(() => {
  if (!existsSync(FIXTURES_DIR)) {
    mkdirSync(FIXTURES_DIR, { recursive: true });
  }
  writeFileSync(TEST_FILE, TEST_CONTENT);
});

test.afterAll(() => {
  if (existsSync(FIXTURES_DIR)) {
    rmSync(FIXTURES_DIR, { recursive: true, force: true });
  }
});

test.describe("File Download", () => {
  test("should upload a file then trigger download via blob URL", async ({ page }) => {
    test.setTimeout(120_000);

    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await uploadTestFile(page, TEST_FILE, "test-download.txt");

    // Intercept the programmatic <a> click by monitoring blob URL creation
    const downloadTriggered = page.evaluate(() => {
      return new Promise<string>((resolve) => {
        const origCreateElement = document.createElement.bind(document);
        document.createElement = function (tag: string, options?: ElementCreationOptions) {
          const el = origCreateElement(tag, options);
          if (tag === "a") {
            const origClick = el.click.bind(el);
            el.click = function () {
              const anchor = el as HTMLAnchorElement;
              if (anchor.href?.startsWith("blob:") && anchor.download) {
                resolve(anchor.download);
              }
              return origClick();
            };
          }
          return el;
        };
      });
    });

    // Open context menu via ⋮ button and click Download
    await openFileContextMenu(page, "test-download.txt");
    await page.getByRole("button", { name: "Download" }).click();

    // Verify download was triggered with correct filename
    const downloadedFileName = await downloadTriggered;
    expect(downloadedFileName).toBe("test-download.txt");
  });

  test("should show Download option in context menu for each file", async ({ page }) => {
    test.setTimeout(120_000);

    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await uploadTestFile(page, TEST_FILE, "test-download.txt");

    // Open context menu and verify Download option is present
    await openFileContextMenu(page, "test-download.txt");
    await expect(page.getByRole("button", { name: "Download" })).toBeVisible();
  });
});
