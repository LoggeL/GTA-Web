import { expect, test as base } from '@playwright/test';

interface SmokeFixtures {
  readonly mutedTestAudio: void;
  readonly uncaughtPageErrors: readonly string[];
}

export const test = base.extend<SmokeFixtures>({
  mutedTestAudio: [
    async ({ page }, use) => {
      await page.addInitScript(() => {
        Object.defineProperty(globalThis, '__HEATLINE_TEST_AUDIO_MUTED__', {
          configurable: false,
          enumerable: false,
          value: true,
          writable: false,
        });
      });
      await use();
    },
    { auto: true },
  ],
  uncaughtPageErrors: [
    async ({ page }, use, testInfo) => {
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      const requestFailures: string[] = [];
      page.on('pageerror', (error) => {
        pageErrors.push(error.stack ?? error.message);
      });
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('requestfailed', (request) => {
        requestFailures.push(
          `${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'unknown failure'}`,
        );
      });
      await use(pageErrors);

      const allowedConsoleErrors = testInfo.annotations
        .filter(({ type }) => type === 'allow-console-error')
        .map(({ description }) => description ?? '');
      const allowedRequestFailures = testInfo.annotations
        .filter(({ type }) => type === 'allow-request-failure')
        .map(({ description }) => description ?? '');
      const unexpectedConsoleErrors = consoleErrors.filter((message) =>
        !allowedConsoleErrors.some((allowed) => allowed.length > 0 && message.includes(allowed)));
      const unexpectedRequestFailures = requestFailures.filter((message) =>
        !allowedRequestFailures.some((allowed) => allowed.length > 0 && message.includes(allowed)));

      expect(pageErrors, 'The page emitted uncaught JavaScript errors').toEqual([]);
      expect(unexpectedConsoleErrors, 'The page emitted unexpected console errors').toEqual([]);
      expect(unexpectedRequestFailures, 'A local or remote asset request failed').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
