// Fails when a vitest JSON report holds tests that did not pass (skipped, todo, disabled, pending): the store job must
// run every store, not quietly skip one.
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const unrun = report.testResults.flatMap((file) =>
  file.assertionResults
    .filter((t) => t.status !== "passed" && t.status !== "failed")
    .map((t) => `${t.status}: ${t.fullName}`),
);
if (unrun.length > 0) {
  console.error(`${unrun.length} store test(s) did not run; is REDIS_URL / DATABASE_URL set?`);
  for (const name of unrun) console.error(`  - ${name}`);
  process.exit(1);
}
if (report.numTotalTests === 0) {
  console.error("No store tests ran.");
  process.exit(1);
}
console.log(`stores: ${report.numPassedTests} passed, none skipped`);
