/**
 * Run all test suites sequentially.
 *
 * Usage:
 *   npx tsx test/all.test.ts
 *   docker compose -f docker-compose.test.yml run --rm all-tests
 */

import { execSync } from 'node:child_process';

const suites = [
  { name: 'Unit Tests', script: 'test/unit.test.ts' },
  { name: 'E2E Tests', script: 'test/e2e.test.ts' },
];

let allPassed = true;

for (const suite of suites) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Running: ${suite.name}`);
  console.log(`${'═'.repeat(60)}\n`);

  try {
    execSync(`npx tsx ${suite.script}`, { stdio: 'inherit', timeout: 60_000 });
  } catch {
    allPassed = false;
    console.log(`\n  \x1b[31m${suite.name} FAILED\x1b[0m\n`);
  }
}

console.log(`\n${'═'.repeat(60)}`);
if (allPassed) {
  console.log(`\x1b[32m  All test suites passed\x1b[0m`);
} else {
  console.log(`\x1b[31m  Some test suites failed\x1b[0m`);
}
console.log(`${'═'.repeat(60)}\n`);

process.exit(allPassed ? 0 : 1);
