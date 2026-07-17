import { defineConfig, devices } from '@playwright/test';

const performanceMode = process.env.HEATLINE_PERFORMANCE === '1';
export default defineConfig({
  testDir: './tests',
  testMatch: performanceMode
    ? ['performance/**/*.spec.ts']
    : ['e2e/**/*.spec.ts'],
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    // Performance runs measure the page's frame cadence. Recording a trace
    // adds periodic screenshot encoding on the same host and can manufacture
    // scheduler stalls during a 20-minute soak, so keep it for functional
    // failures only.
    trace: performanceMode ? 'off' : 'retain-on-failure',
  },
  webServer: {
    command: 'npm run preview:e2e',
    port: 4173,
    reuseExistingServer: true,
  },
  projects: performanceMode
    ? [
      { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
      {
        name: 'chromium-mobile-landscape',
        use: {
          ...devices['Pixel 7'],
          viewport: { width: 844, height: 390 },
          isMobile: true,
          hasTouch: true,
        },
      },
    ]
    : [
      { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
      {
        name: 'chromium-mobile-landscape',
        use: {
          ...devices['Pixel 7'],
          viewport: { width: 844, height: 390 },
          isMobile: true,
          hasTouch: true,
        },
      },
      {
        name: 'firefox-desktop',
        testMatch: /e2e\/desktop-smoke\.spec\.ts/,
        use: { ...devices['Desktop Firefox'] },
      },
      {
        name: 'webkit-desktop',
        testMatch: /e2e\/desktop-smoke\.spec\.ts/,
        use: { ...devices['Desktop Safari'] },
      },
    ],
});
