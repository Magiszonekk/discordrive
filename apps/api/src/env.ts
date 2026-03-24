// DiscorDrive v4 — Environment loader (must be imported FIRST)
// ESM hoists all imports before top-level code, so dotenv.config()
// must live in its own module to run before other imports.

import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../../../.env") });
