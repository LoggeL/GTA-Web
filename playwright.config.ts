import { defineConfig, devices } from '@playwright/test';

const performanceMode = process.env.HEATLINE_PERFORMANCE === '1';
const isCi = process.env.CI === 'true';

export default defineConfig({
  testDir: './tests',
  testMatch: performanceMode
    ? ['performance/**/*.spec.ts']
    : ['e2e/**/*.spec.ts'],
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
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
        // GitHub's headless Firefox runner uses a software WebGL renderer. Keep
        // it on the shipped low-density path while local desktop Firefox also
        // exercises the default high-density path through `test:e2e:release`.
        use: {
          ...devices['Desktop Firefox'],
          ...(isCi ? { viewport: { width: 896, height: 720 } } : {}),
        },
      },
      {
        name: 'webkit-desktop',
        testMatch: /e2e\/desktop-smoke\.spec\.ts/,
        use: { ...devices['Desktop Safari'] },
      },
    ],
});
