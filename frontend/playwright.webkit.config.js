import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/visual',
  outputDir: './test-results-webkit',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      maxDiffPixelRatio: 0.03,
    },
  },
  use: {
    baseURL: 'http://127.0.0.1:4174',
    colorScheme: 'dark',
  },
  projects: [
    {
      name: 'webkit-desktop',
      testMatch: 'card-system-webkit.spec.js',
      use: { browserName: 'webkit', viewport: { width: 1280, height: 1000 } },
    },
    {
      // The iPhone shell (docs/IOS_UI_DESIGN.md §12): tabs, back targets and the Scan overlay on iPhone WebKit.
      name: 'webkit-iphone',
      testMatch: ['shell.spec.js', 'holo-viewer.spec.js', 'unlock-sheet.spec.js', 'today-card.spec.js'],
      use: { ...devices['iPhone 13'], browserName: 'webkit' },
    },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4174',
    url: 'http://127.0.0.1:4174/__card-system',
    reuseExistingServer: !process.env.CI,
  },
})
