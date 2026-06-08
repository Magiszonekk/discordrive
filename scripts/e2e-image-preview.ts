import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { setTimeout as delay } from "node:timers/promises";

const FRONTEND_URL = "http://127.0.0.1:3003";
const SCREENSHOT_PATH = resolve("tmp/e2e-shared-image-preview.png");
const DOWNLOADS_DIR = resolve("tmp/e2e-image-preview-downloads");

async function waitForApp() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${FRONTEND_URL}/register`, { method: "GET" });
      if (response.ok) return;
    } catch {
      // retry
    }
    await delay(1_000);
  }

  throw new Error("Frontend app did not become ready on time");
}

async function main() {
  await mkdir(resolve("tmp"), { recursive: true });
  await rm(DOWNLOADS_DIR, { recursive: true, force: true });
  await mkdir(DOWNLOADS_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    await waitForApp();
    await page.goto(`${FRONTEND_URL}/register`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3_000);
    console.log("register-body", await page.locator("body").textContent());
    await page.waitForSelector('input[type="email"]', { timeout: 60_000 });

    const unique = Date.now().toString();
    const email = `preview-${unique}@example.com`;
    const username = `preview_${unique}`;
    const password = "PreviewPass123!";

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").nth(0).fill(password);
    await page.getByLabel("Confirm Password").fill(password);
    await page.getByRole("button", { name: /create account/i }).click();
    await page.waitForURL(`${FRONTEND_URL}/`, { timeout: 60_000 });

    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1EAAAAASUVORK5CYII=",
      "base64",
    );
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: /upload files/i }).click();
    const chooser = await fileChooserPromise;
    await chooser.setFiles({
      name: "preview-test.png",
      mimeType: "image/png",
      buffer: imageBytes,
    });

    await page.waitForSelector('text="Upload complete"', { timeout: 60_000 });
    await page.waitForSelector('text="preview-test"', { timeout: 60_000 }).catch(() => page.waitForTimeout(5_000));

    await page.getByRole("button", { name: /share/i }).first().click();
    await page.waitForSelector('text="Create share link"', { timeout: 30_000 });
    await page.getByRole("button", { name: /^create share$/i }).click();
    await page.waitForSelector('text="Share link ready"', { timeout: 60_000 });
    const shareUrl = await page.locator('input[readonly]').inputValue();

    const sharePage = await context.newPage();
    await sharePage.goto(shareUrl, { waitUntil: "domcontentloaded" });
    await sharePage.waitForSelector('text="Shared file"', { timeout: 60_000 });
    await sharePage.waitForSelector('img[alt="preview-test.png"]', { timeout: 15_000 });

    const image = sharePage.locator('img[alt="preview-test.png"]');
    const src = await image.getAttribute("src");
    if (!src || !src.startsWith("blob:")) {
      throw new Error(`Expected blob preview src, got: ${src ?? "<null>"}`);
    }

    await sharePage.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    console.log(`shared-image-preview-ok:${SCREENSHOT_PATH}`);
  } finally {
    await browser.close();
    await rm(DOWNLOADS_DIR, { recursive: true, force: true });
  }
}

main().catch(async (error) => {
  console.error(error);
  try {
    const screenshot = await readFile(SCREENSHOT_PATH);
    await writeFile(SCREENSHOT_PATH, screenshot);
  } catch {
    // no-op
  }
  process.exitCode = 1;
});
