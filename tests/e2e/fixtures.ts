import { expect, test as base } from '@playwright/test';

interface SmokeFixtures {
  readonly uncaughtPageErrors: readonly string[];
}

export const test = base.extend<SmokeFixtures>({
  uncaughtPageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => {
        errors.push(error.stack ?? error.message);
      });
      await use(errors);
      expect(errors, 'The page emitted uncaught JavaScript errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
