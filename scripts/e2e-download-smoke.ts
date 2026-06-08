import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { setTimeout as delay } from "node:timers/promises";

const rootDir = process.cwd();
const downloadDir = resolve(rootDir, ".tmp/e2e-downloads");
const baseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3003";

type DownloadSignal = { fileName: string; bytes: number } | null;

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, message: string) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return;
    await delay(250);
  }
  throw new Error(message);
}

async function readDownloadSignal(page: import("playwright").Page): Promise<DownloadSignal> {
  return page.evaluate(() => {
    return (window as unknown as { __ddv4DownloadSignal?: { fileName: string; bytes: number } }).__ddv4DownloadSignal ?? null;
  });
}

async function main() {
  await rm(downloadDir, { recursive: true, force: true });
  await mkdir(downloadDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  const unique = Date.now();
  const email = `e2e+${unique}@discordrive.local`;
  const username = `e2e_${unique}`;
  const password = "StrongPass123!Test";
  const expectedContent = `hello secure files e2e ${unique}\n`;

  try {
    await page.goto(`${baseUrl}/register`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('text="Create Account"', { timeout: 15_000 });
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="text"]').fill(username);
    await page.locator('input[type="password"]').nth(0).fill(password);
    await page.locator('input[type="password"]').nth(1).fill(password);
    await page.getByRole("button", { name: "Create account" }).click();

    await page.waitForURL((url: URL) => url.pathname === "/", { timeout: 15_000 });
    await page.waitForSelector('text="Upload Files"');

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload Files" }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: "e2e-download.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(expectedContent, "utf8"),
    });

    await waitFor(
      async () => (await page.locator('button[title="Share"]').count()) > 0,
      20_000,
      "Share button did not appear after upload",
    );

    await page.locator('button[title="Share"]').first().click();
    await page.getByRole("button", { name: "Create share link" }).click();
    const shareUrl = await page.locator('input[readonly]').inputValue();
    if (!shareUrl.includes("#")) {
      throw new Error("Share URL missing fragment secret");
    }

    await page.getByRole("button", { name: "Done" }).click();
    await page.locator('button[title="Share"]').first().waitFor({ timeout: 15_000 });

    await page.evaluate(() => {
      delete (window as unknown as { __ddv4DownloadSignal?: unknown }).__ddv4DownloadSignal;
    });

    const ownerDownloadPromise = page.waitForEvent("download", { timeout: 15_000 }).catch(() => null);
    await page.locator('button[title="Download"]').first().click();
    const ownerDownload = await ownerDownloadPromise;

    const ownerConsoleMessages = await page.consoleMessages();
    console.log("ownerConsoleMessages", ownerConsoleMessages.map((msg) => msg.text()));

    await waitFor(
      async () => {
        const signal = await readDownloadSignal(page);
        return !!signal?.fileName;
      },
      15_000,
      "Owner download success signal did not appear",
    );

    const ownerSignal = await readDownloadSignal(page);
    if (!ownerSignal || ownerSignal.bytes !== Buffer.byteLength(expectedContent)) {
      throw new Error(`Owner download signal invalid: ${JSON.stringify(ownerSignal)}`);
    }

    if (!ownerDownload) {
      throw new Error("Owner browser download event did not fire");
    }

    const ownerDownloadFile = resolve(downloadDir, `owner-${await ownerDownload.suggestedFilename()}`);
    await ownerDownload.saveAs(ownerDownloadFile);
    const ownerDownloadedContent = await readFile(ownerDownloadFile, "utf8");
    if (ownerDownloadedContent !== expectedContent) {
      throw new Error(`Owner downloaded file mismatch: ${JSON.stringify(ownerDownloadedContent)}`);
    }

    const sharePage = await context.newPage();
    await sharePage.goto(shareUrl, { waitUntil: "domcontentloaded" });
    await sharePage.waitForSelector('text="Shared file"');

    await sharePage.evaluate(() => {
      delete (window as unknown as { __ddv4DownloadSignal?: unknown }).__ddv4DownloadSignal;
    });

    const shareDownloadPromise = sharePage.waitForEvent("download", { timeout: 15_000 }).catch(() => null);
    await sharePage.getByRole("button", { name: "Download" }).click();
    const shareDownload = await shareDownloadPromise;

    await waitFor(
      async () => {
        const signal = await readDownloadSignal(sharePage);
        return !!signal?.fileName;
      },
      15_000,
      "Shared download success signal did not appear",
    );

    const shareSignal = await readDownloadSignal(sharePage);
    if (!shareSignal || shareSignal.bytes !== Buffer.byteLength(expectedContent)) {
      throw new Error(`Shared download signal invalid: ${JSON.stringify(shareSignal)}`);
    }

    if (!shareDownload) {
      throw new Error("Shared browser download event did not fire");
    }

    const shareDownloadFile = resolve(downloadDir, `share-${await shareDownload.suggestedFilename()}`);
    await shareDownload.saveAs(shareDownloadFile);
    const shareDownloadedContent = await readFile(shareDownloadFile, "utf8");
    if (shareDownloadedContent !== expectedContent) {
      throw new Error(`Shared downloaded file mismatch: ${JSON.stringify(shareDownloadedContent)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      baseUrl,
      shareUrl,
      ownerSignal,
      shareSignal,
      verifiedBytes: Buffer.byteLength(expectedContent),
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
