import { expectPlayableWorldShell, startNewGame } from './helpers';
import { expect, test } from './fixtures';

test.describe('M0 mobile landscape browser smoke', () => {
  test.skip(({ isMobile }) => !isMobile, 'Mobile-only smoke coverage');

  test('landscape gameplay exposes touch controls and portrait shows the rotate blocker', async ({ page }) => {
    await startNewGame(page, 1, 'Feminine Alex');
    await expectPlayableWorldShell(page);

    const touchControls = page.getByLabel('Touch controls');
    await expect(touchControls).toBeVisible();
    await expect(touchControls.getByRole('button', { name: 'Interact' })).toBeVisible();
    await expect(touchControls.getByRole('button', { name: 'Sprint' })).toBeVisible();
    await expect(touchControls.getByRole('button', { name: 'Jump or handbrake' })).toBeVisible();
    await expect(touchControls.getByRole('button', { name: 'Aim' })).toBeVisible();
    await expect(touchControls.getByRole('button', { name: 'Fire or attack' })).toBeVisible();

    const interact = touchControls.getByRole('button', { name: 'Interact' });
    await interact.dispatchEvent('pointerdown');
    await expect(interact).toHaveClass(/is-active/);
    await interact.dispatchEvent('pointerup');
    await expect(interact).not.toHaveClass(/is-active/);

    const rotateMessage = page.getByText('Rotate to landscape', { exact: true });
    await expect(rotateMessage).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(rotateMessage).toBeVisible();
    await expect(page.getByText('HEATLINE is designed for a wide screen.', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(rotateMessage).toBeHidden();
    await expect(touchControls).toBeVisible();
  });
});
