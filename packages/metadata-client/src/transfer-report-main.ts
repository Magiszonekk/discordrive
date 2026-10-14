// `npm run transfer-report -- <log.jsonl> [--bucket 10] [--csv prefix]` (repo root).
import { runTransferReport } from "./transfer-report.js";

runTransferReport(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`transfer-report: ${(e as Error)?.message ?? e}`);
    process.exit(1);
  },
);
