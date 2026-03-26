import { test, expect } from "@playwright/test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import { generateTestUser, registerUser } from "./helpers/auth";
import { uploadTestFile } from "./helpers/files";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");
const FILE_200MB = join(FIXTURES_DIR, "test-200mb.bin");
const FILE_2GB = join(FIXTURES_DIR, "test-2gb.bin");

function generateFixture(path: string, sizeMB: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!existsSync(FIXTURES_DIR)) {
      mkdirSync(FIXTURES_DIR, { recursive: true });
    }
    const stream = createWriteStream(path);
    const chunkSize = 1024 * 1024; // 1MB blocks
    let written = 0;

    function write() {
      let ok = true;
      while (written < sizeMB && ok) {
        const buf = Buffer.alloc(chunkSize, written % 256);
        ok = stream.write(buf);
        written++;
      }
      if (written < sizeMB) {
        stream.once("drain", write);
      } else {
        stream.end(resolve);
      }
    }

    stream.on("error", reject);
    write();
  });
}

test.describe("Large File Upload", () => {
  test.beforeAll(async () => {
    if (!existsSync(FILE_200MB)) {
      await generateFixture(FILE_200MB, 200);
    }
  });

  test("should upload a 200MB file", async ({ page }) => {
    test.setTimeout(120_000);

    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await uploadTestFile(page, FILE_200MB, "test-200mb.bin", 120_000);

    await expect(page.locator("tr", { hasText: "test-200mb.bin" })).toBeVisible();
  });

  test("should upload a 2GB file", async ({ page }) => {
    test.skip(!process.env.TEST_LARGE_UPLOAD, "Set TEST_LARGE_UPLOAD=1 to run");
    test.setTimeout(600_000);

    if (!existsSync(FILE_2GB)) {
      await generateFixture(FILE_2GB, 2048);
    }

    const user = generateTestUser();
    await registerUser(page, user.email, user.password);

    await uploadTestFile(page, FILE_2GB, "test-2gb.bin", 600_000);

    await expect(page.locator("tr", { hasText: "test-2gb.bin" })).toBeVisible();
  });
});
