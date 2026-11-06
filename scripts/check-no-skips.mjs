// Fails when a vitest JSON report holds skipped tests: the store job must run every store, not quietly skip one.
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const skipped = report.testResults.flatMap((file) =>
  file.assertionResults.filter((t) => t.status === "skipped" || t.status === "pending").map((t) => t.fullName),
);
if (skipped.length > 0) {
  console.error(`${skipped.length} store test(s) skipped; is REDIS_URL / DATABASE_URL set?`);
  for (const name of skipped) console.error(`  - ${name}`);
  process.exit(1);
}
console.log(`stores: ${report.numPassedTests} passed, none skipped`);
