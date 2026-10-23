import { defineConfig } from '@playwright/test'

// F16a picture-store benchmark: run on its own (`npx playwright test --config=playwright.bench.config.js`),
// ideally in the Playwright Docker image; it is not part of the regular suites.
export default defineConfig({
  testDir: './tests/bench',
  outputDir: './test-results-bench',
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  projects: [{ name: 'webkit' }, { name: 'chromium' }],
})
