import { readFile } from 'node:fs/promises';

import type { Page } from '@playwright/test';

import {
  SAVE_CHECKSUM_ALGORITHM,
  SAVE_EXPORT_FORMAT,
  SAVE_EXPORT_FORMAT_VERSION,
  SAVE_GAME_VERSION,
  computeChecksum,
  createInitialSaveGame,
  createSaveEnvelope,
  parseSaveGame,
} from '../../src/core';
import {
  enterMainMenu,
  openApplication,
  startNewGame,
} from './helpers';
import { expect, test } from './fixtures';

interface StoredSlotRow {
  readonly slotId: 1 | 2 | 3;
  readonly active: unknown;
  readonly backup: unknown | null;
}

const DATABASE_NAME = 'heatline-solara';
const DATABASE_VERSION = 1;
const SLOT_STORE = 'save-slots';

const slotCard = (page: Page, slot: 1 | 2 | 3) => page.locator(
  `[data-save-list] article[data-slot="${slot}"]`,
);

async function openSaveSlots(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Main menu' })
    .getByRole('button', { name: 'Play' })
    .click();
  await expect(page.getByRole('heading', { level: 2, name: 'Choose a save' })).toBeVisible();
  await expect(page.locator('[data-save-list] article[data-slot]')).toHaveCount(3);
}

async function seedSlotRows(page: Page, rows: readonly StoredSlotRow[]): Promise<void> {
  await page.evaluate(async ({ databaseName, databaseVersion, slotStore, seedRows }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(databaseName, databaseVersion);
      request.addEventListener('success', () => {
        const database = request.result;
        const transaction = database.transaction(slotStore, 'readwrite');
        const store = transaction.objectStore(slotStore);
        for (const row of seedRows) store.put(row);
        transaction.addEventListener('complete', () => {
          database.close();
          resolve();
        });
        transaction.addEventListener('abort', () => {
          database.close();
          reject(transaction.error ?? new Error('Seed transaction aborted'));
        });
        transaction.addEventListener('error', () => {
          database.close();
          reject(transaction.error ?? new Error('Seed transaction failed'));
        });
      });
      request.addEventListener('error', () => {
        reject(request.error ?? new Error('Could not open the save database'));
      });
    });
  }, {
    databaseName: DATABASE_NAME,
    databaseVersion: DATABASE_VERSION,
    slotStore: SLOT_STORE,
    seedRows: rows,
  });
}

async function readSlotRow(page: Page, slotId: 1 | 2 | 3): Promise<StoredSlotRow | null> {
  return page.evaluate(async ({ databaseName, databaseVersion, slotStore, requestedSlot }) => (
    new Promise<StoredSlotRow | null>((resolve, reject) => {
      const request = indexedDB.open(databaseName, databaseVersion);
      request.addEventListener('success', () => {
        const database = request.result;
        const transaction = database.transaction(slotStore, 'readonly');
        const getRequest = transaction.objectStore(slotStore).get(requestedSlot);
        getRequest.addEventListener('success', () => {
          const result = getRequest.result as StoredSlotRow | undefined;
          database.close();
          resolve(result ?? null);
        });
        getRequest.addEventListener('error', () => {
          database.close();
          reject(getRequest.error ?? new Error('Could not read the save slot'));
        });
      });
      request.addEventListener('error', () => {
        reject(request.error ?? new Error('Could not open the save database'));
      });
    })
  ), {
    databaseName: DATABASE_NAME,
    databaseVersion: DATABASE_VERSION,
    slotStore: SLOT_STORE,
    requestedSlot: slotId,
  });
}

async function readDownload(downloadPath: string | null): Promise<string> {
  if (downloadPath === null) throw new Error('Playwright did not expose the downloaded file');
  return readFile(downloadPath, 'utf8');
}

function createTransferEnvelope(slot: 1 | 2 | 3 = 1) {
  const save = createInitialSaveGame(slot, 'feminine', {
    timestamp: 1_720_000_000_000,
    label: 'Neon transfer',
    seed: 'm8-transfer',
  });
  save.player.level = 7;
  save.player.money = 4_250;
  save.activeDistrict = 'neon-strand';
  save.playtimeSeconds = 3_721;
  return createSaveEnvelope(save);
}

function createFutureEnvelope(slot: 1 | 2 | 3) {
  const save = createInitialSaveGame(slot, 'masculine', {
    timestamp: 1_730_000_000_000,
    label: 'Future build save',
    seed: 'm8-future',
  });
  save.player.level = 11;
  const payload = JSON.parse(JSON.stringify(save)) as unknown as Record<string, unknown>;
  payload.schemaVersion = SAVE_GAME_VERSION + 1;
  return {
    format: SAVE_EXPORT_FORMAT,
    formatVersion: SAVE_EXPORT_FORMAT_VERSION,
    checksum: {
      algorithm: SAVE_CHECKSUM_ALGORITHM,
      value: computeChecksum(payload),
    },
    payload,
  };
}

test.describe('M8 save persistence acceptance', () => {
  test.skip(({ isMobile }) => Boolean(isMobile), 'Persistence behavior is engine-independent; run the focused desktop course');

  test('three slots support new game, explicit save-and-quit, reload, and continue', async ({ page }) => {
    test.setTimeout(120_000);
    await openApplication(page);
    await enterMainMenu(page);
    await openSaveSlots(page);

    for (const slot of [1, 2, 3] as const) {
      const card = slotCard(page, slot);
      await expect(card).toHaveAttribute('data-save-status', 'empty');
      await expect(card.getByRole('button')).toHaveText(['New game']);
    }

    await slotCard(page, 2).getByRole('button', { name: 'New game' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Choose Alex' })).toBeVisible();
    await page.getByRole('button', { name: /^Feminine Alex/ }).click();
    await expect(page.getByLabel('Game HUD')).toBeVisible({ timeout: 75_000 });

    await page.getByRole('navigation', { name: 'Game panels' })
      .getByRole('button', { name: 'Pause Esc' })
      .click();
    const pause = page.getByLabel('Pause menu');
    await expect(pause).toBeVisible();
    await pause.getByRole('button', { name: 'Save and quit to menu' }).click();
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeVisible({ timeout: 20_000 });

    await page.reload();
    await enterMainMenu(page);
    await openSaveSlots(page);

    const saved = slotCard(page, 2);
    await expect(saved).toHaveAttribute('data-save-status', 'ready');
    await expect(saved.getByText('Ready', { exact: true })).toBeVisible();
    await expect(saved.getByRole('heading', { level: 3 })).toContainText('Level 1 · Past Due');
    await expect(saved.getByRole('button')).toHaveText(['Continue', 'Export', 'Delete']);
    await saved.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByLabel('Game HUD')).toBeVisible({ timeout: 75_000 });
    await expect(page.locator('[data-toast]')).toHaveText('Welcome back to Solara');
  });

  test('exported JSON is reviewed and imported only into the chosen destination', async ({ page }) => {
    test.setTimeout(90_000);
    await openApplication(page);
    const sourceEnvelope = createTransferEnvelope(1);
    await seedSlotRows(page, [{ slotId: 1, active: sourceEnvelope, backup: null }]);
    await enterMainMenu(page);
    await openSaveSlots(page);

    const downloadPromise = page.waitForEvent('download');
    await slotCard(page, 1).getByRole('button', { name: 'Export' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('heatline-solara-slot-1.json');
    const exported = await readDownload(await download.path());
    const inspection = parseSaveGame(exported);
    expect(inspection.success).toBe(true);
    if (!inspection.success) throw new Error(inspection.errors.join('; '));
    expect(inspection.save.slot.id).toBe(1);
    expect(inspection.save.player.level).toBe(7);
    expect(inspection.save.player.money).toBe(4_250);

    await page.locator('[data-save-import-file]').setInputFiles({
      name: download.suggestedFilename(),
      mimeType: 'application/json',
      buffer: Buffer.from(exported),
    });
    const review = page.locator('[data-save-import-review]');
    await expect(review).toHaveAttribute('data-state', 'valid');
    await expect(review.locator('[data-save-import-title]')).toHaveText('Level 7 · Neon transfer');
    await expect(review.locator('[data-save-import-detail]')).toContainText('Neon Strand · Feminine Alex · 1h 2m');
    await expect(review.locator('[data-save-import-facts]')).toContainText('Source slot 1');

    const destination = page.locator('[data-save-import-destination]');
    await expect(destination).toBeEnabled();
    await expect(destination.locator('option').nth(0)).toHaveText('Slot 1 — Ready');
    await expect(destination.locator('option').nth(1)).toHaveText('Slot 2 — Empty');
    await expect(destination.locator('option').nth(2)).toHaveText('Slot 3 — Empty');
    await destination.selectOption('3');
    await page.getByRole('button', { name: 'Import save' }).click();

    const imported = slotCard(page, 3);
    await expect(imported).toHaveAttribute('data-save-status', 'ready');
    await expect(imported.getByRole('heading', { level: 3 })).toContainText('Level 7 · Neon transfer');
    await expect(slotCard(page, 1)).toHaveAttribute('data-save-status', 'ready');

    await page.reload();
    await enterMainMenu(page);
    await openSaveSlots(page);
    await slotCard(page, 3).getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByLabel('Game HUD')).toBeVisible({ timeout: 75_000 });
    await expect(page.locator('[data-hud-level]')).toHaveText('LV 7');
  });

  test('corrupt and future-version slots expose only the safe actions and preserve future raw JSON', async ({ page }) => {
    await openApplication(page);
    const futureEnvelope = createFutureEnvelope(2);
    const futureSerialized = JSON.stringify(futureEnvelope, null, 2);
    await seedSlotRows(page, [
      { slotId: 1, active: { format: 'not-a-save' }, backup: null },
      { slotId: 2, active: futureEnvelope, backup: null },
    ]);
    await enterMainMenu(page);
    await openSaveSlots(page);

    const corrupt = slotCard(page, 1);
    await expect(corrupt).toHaveAttribute('data-save-status', 'corrupt');
    await expect(corrupt.getByText('Damaged save', { exact: true })).toBeVisible();
    await expect(corrupt.getByRole('button')).toHaveText(['Delete']);

    const future = slotCard(page, 2);
    await expect(future).toHaveAttribute('data-save-status', 'unsupported-version');
    await expect(future.getByText('Newer game version', { exact: true })).toBeVisible();
    await expect(future.getByRole('button')).toHaveText(['Export', 'Delete']);

    const downloadPromise = page.waitForEvent('download');
    await future.getByRole('button', { name: 'Export' }).click();
    const download = await downloadPromise;
    const exportedFuture = await readDownload(await download.path());
    expect(exportedFuture).toBe(futureSerialized);

    const validImport = JSON.stringify(createTransferEnvelope(3), null, 2);
    await page.locator('[data-save-import-file]').setInputFiles({
      name: 'valid-current-save.json',
      mimeType: 'application/json',
      buffer: Buffer.from(validImport),
    });
    const destination = page.locator('[data-save-import-destination]');
    await expect(destination).toBeEnabled();
    expect(await destination.locator('option').evaluateAll((options) => options.map(
      (option) => (option as HTMLOptionElement).disabled,
    ))).toEqual([true, true, false]);
    await expect(destination).toHaveValue('3');
  });

  test('a quota-style write failure keeps the game playable and offers a valid emergency export', async ({ page }) => {
    test.info().annotations.push({
      type: 'allow-console-error',
      description: 'browser storage quota was exceeded',
    });
    test.setTimeout(90_000);
    await page.addInitScript(() => {
      const originalPut = IDBObjectStore.prototype.put;
      Object.defineProperty(IDBObjectStore.prototype, 'put', {
        configurable: true,
        value(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
          if (this.name === 'save-slots' || this.name === 'settings') {
            throw new DOMException('M8 injected storage limit', 'QuotaExceededError');
          }
          return key === undefined
            ? originalPut.call(this, value)
            : originalPut.call(this, value, key);
        },
      });
    });

    await startNewGame(page, 1, 'Masculine Alex');
    await expect(page.getByLabel('Game HUD')).toBeVisible();
    const warning = page.locator('[data-persistence-warning]');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('Browser storage is full');
    const emergencyButton = warning.getByRole('button', { name: 'Export emergency save' });
    await expect(emergencyButton).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await emergencyButton.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('heatline-emergency-slot-1.json');
    const emergencySerialized = await readDownload(await download.path());
    const emergency = parseSaveGame(emergencySerialized);
    expect(emergency.success).toBe(true);
    if (!emergency.success) throw new Error(emergency.errors.join('; '));
    expect(emergency.save.slot.id).toBe(1);
    expect(emergency.save.player.money).toBe(850);
    expect(await readSlotRow(page, 1)).toBeNull();

    await page.getByLabel('3D game world').locator('canvas').focus();
    await page.keyboard.press('Escape');
    const pause = page.getByLabel('Pause menu');
    await expect(pause).toBeVisible();
    await pause.getByRole('button', { name: 'Settings' }).click();
    await page.locator('[data-setting="audio.master"]').fill('42');
    await page.waitForTimeout(250);
    await expect(warning).toContainText('Browser storage is full');
    await expect(emergencyButton).toBeVisible();

    await page.getByRole('button', { name: 'Close' }).click();
    await expect(pause).toBeVisible();
    await pause.getByRole('button', { name: 'Save and quit to menu' }).click();
    await expect(pause).toBeVisible();
    await expect(pause.locator('[data-quit-save-status]')).toContainText('Progress was not saved');
    await expect(pause.getByRole('button', { name: 'Save and quit to menu' })).toBeEnabled();
    await expect(pause.getByRole('button', { name: 'Export emergency save' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeHidden();
  });

  test('a transient slot-read failure locks unknown slots without destructive actions', async ({ page }) => {
    test.info().annotations.push({
      type: 'allow-console-error',
      description: 'M8 injected transient read failure',
    });
    await page.addInitScript(() => {
      const originalGet = IDBObjectStore.prototype.get;
      Object.defineProperty(IDBObjectStore.prototype, 'get', {
        configurable: true,
        value(this: IDBObjectStore, key: IDBValidKey) {
          const failureEnabled = Boolean((globalThis as typeof globalThis & {
            __M8_FAIL_SLOT_READ__?: boolean;
          }).__M8_FAIL_SLOT_READ__);
          if (failureEnabled && this.name === 'save-slots') {
            throw new DOMException('M8 injected transient read failure', 'UnknownError');
          }
          return originalGet.call(this, key);
        },
      });
    });

    await openApplication(page);
    await page.evaluate(() => {
      (globalThis as typeof globalThis & { __M8_FAIL_SLOT_READ__?: boolean })
        .__M8_FAIL_SLOT_READ__ = true;
    });
    await enterMainMenu(page);
    await openSaveSlots(page);

    const locked = page.locator('[data-save-list] article[data-save-status="unavailable"]');
    await expect(locked).toHaveCount(3);
    await expect(locked.getByRole('button')).toHaveCount(0);
    await expect(page.locator('[data-persistence-warning]')).toContainText(
      'Save slots could not be read. They are locked to prevent accidental replacement.',
    );
  });

  test('a fresh successful slot list clears a stale per-slot read warning', async ({ page }) => {
    test.info().annotations.push({
      type: 'allow-console-error',
      description: 'M8 injected one-shot read failure',
    });
    await page.addInitScript(() => {
      const originalGet = IDBObjectStore.prototype.get;
      Object.defineProperty(IDBObjectStore.prototype, 'get', {
        configurable: true,
        value(this: IDBObjectStore, key: IDBValidKey) {
          const state = globalThis as typeof globalThis & {
            __M8_FAIL_NEXT_SLOT_READ__?: boolean;
          };
          if (state.__M8_FAIL_NEXT_SLOT_READ__ && this.name === 'save-slots') {
            state.__M8_FAIL_NEXT_SLOT_READ__ = false;
            throw new DOMException('M8 injected one-shot read failure', 'UnknownError');
          }
          return originalGet.call(this, key);
        },
      });
    });

    await openApplication(page);
    await seedSlotRows(page, [{ slotId: 1, active: createTransferEnvelope(1), backup: null }]);
    await enterMainMenu(page);
    await openSaveSlots(page);
    await expect(slotCard(page, 1)).toHaveAttribute('data-save-status', 'ready');

    await page.evaluate(() => {
      (globalThis as typeof globalThis & { __M8_FAIL_NEXT_SLOT_READ__?: boolean })
        .__M8_FAIL_NEXT_SLOT_READ__ = true;
    });
    await slotCard(page, 1).getByRole('button', { name: 'Continue' }).click();

    await expect(page.locator('#save-slots')).toHaveAttribute('aria-busy', 'false');
    await expect(slotCard(page, 1)).toHaveAttribute('data-save-status', 'ready');
    await expect(page.locator('[data-persistence-warning]')).toBeHidden();
  });

  test('unavailable IndexedDB is disclosed as a persistent session-only warning', async ({ page }) => {
    test.info().annotations.push({
      type: 'allow-console-error',
      description: 'M8 injected unavailable database',
    });
    await page.addInitScript(() => {
      Object.defineProperty(IDBFactory.prototype, 'open', {
        configurable: true,
        value() {
          throw new DOMException('M8 injected unavailable database', 'InvalidStateError');
        },
      });
    });

    await openApplication(page);
    const warning = page.locator('[data-persistence-warning]');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(
      'Browser storage is unavailable. This session can be played, but progress will be lost when the tab closes.',
    );
    await expect(warning.getByRole('button', { name: 'Export emergency save' })).toBeHidden();

    await enterMainMenu(page);
    await openSaveSlots(page);
    await expect(warning).toBeVisible();
    await expect(page.locator('[data-save-list] article[data-save-status="empty"]')).toHaveCount(3);
  });
});
