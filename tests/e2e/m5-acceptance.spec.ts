import type { Locator, Page } from '@playwright/test';

import { enterMainMenu, startNewGame } from './helpers';
import { expect, test } from './fixtures';

interface QaInventoryState {
  itemCount: number;
  weightKg: number;
  quickLoadout: {
    firearms: [string | null, string | null];
    melee: string | null;
    consumables: [string | null, string | null];
  };
  unlockedRecipes: number;
}

interface QaApi {
  grantXp(amount: number): {
    level: number;
    xp: number;
    attributePoints: number;
    skillPoints: number;
  };
  inventoryState(): QaInventoryState;
  setMoney(value: number): number;
  accruePropertyPayouts(count?: number): Record<string, number>;
}

type QaWindow = Window & { __HEATLINE_QA__?: QaApi };
type PanelId = 'skills' | 'inventory' | 'properties';

async function waitForQa(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as QaWindow).__HEATLINE_QA__));
}

async function inventoryState(page: Page): Promise<QaInventoryState> {
  return page.evaluate(() => {
    const api = (window as QaWindow).__HEATLINE_QA__;
    if (!api) throw new Error('HEATLINE QA API is unavailable');
    return api.inventoryState();
  });
}

async function openHudPanel(page: Page, panelId: PanelId): Promise<Locator> {
  await page.getByLabel('Game HUD').locator(`[data-open-panel="${panelId}"]`).click();
  const panel = page.getByRole('region', { name: 'Game panel', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-panel', panelId);
  return panel;
}

async function openPausedTouchPanel(page: Page, panelId: PanelId): Promise<Locator> {
  const pause = page.getByLabel('Pause menu');
  await expect(pause).toBeVisible();
  await pause.locator(`[data-open-panel="${panelId}"]`).tap();
  const panel = page.getByRole('region', { name: 'Game panel', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-panel', panelId);
  return panel;
}

async function closePanel(panel: Locator, touch = false): Promise<void> {
  const close = panel.getByRole('button', { name: 'Close' });
  if (touch) await close.tap();
  else await close.click();
  await expect(panel).toBeHidden();
}

async function enterMorenoGarage(page: Page): Promise<void> {
  const world = page.getByLabel('3D game world');
  await world.locator('canvas').focus();
  await page.keyboard.press('e');
  await expect(world).toHaveAttribute('data-player-mode', 'vehicle');
  await page.keyboard.press('e');
  await expect(world).toHaveAttribute('data-player-mode', 'on-foot');
  await expect(world).toHaveAttribute('data-can-interact', 'true');
  await page.keyboard.press('e');
  await expect(world).toHaveAttribute('data-interior-phase', 'interior');
  await expect(world).toHaveAttribute('data-interior-id', 'moreno-garage');
}

async function itemShape(item: Locator): Promise<{ width: string; height: string }> {
  return item.evaluate((element) => ({
    width: getComputedStyle(element).getPropertyValue('--item-width').trim(),
    height: getComputedStyle(element).getPropertyValue('--item-height').trim(),
  }));
}

async function dispatchEconomyAction(
  page: Page,
  action: 'purchase-property' | 'collect-property',
  propertyId: string,
): Promise<void> {
  await page.evaluate(({ economyAction, id }) => {
    const card = document.querySelector(`.property-card[data-property-id="${id}"]`);
    if (!card) throw new Error(`Missing property card ${id}`);
    const button = document.createElement('button');
    button.dataset.economyAction = economyAction;
    button.dataset.propertyId = id;
    card.append(button);
    button.click();
  }, { economyAction: action, id: propertyId });
}

test.describe('M5 progression, inventory, economy, and persistence acceptance', () => {
  test('desktop build choices alter telemetry and the complete M5 loop survives continue', async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), 'Desktop covers the complete M5 transaction and persistence course');
    test.setTimeout(75_000);

    await startNewGame(page, 1, 'Masculine Alex', '/?qa=1');
    await waitForQa(page);
    const world = page.getByLabel('3D game world');
    await expect(world).toHaveAttribute('data-rpg-weapon-spread', '1.0000');
    await expect(world).toHaveAttribute('data-rpg-reload-time', '1.0000');

    const progression = await page.evaluate(() => {
      const api = (window as QaWindow).__HEATLINE_QA__;
      if (!api) throw new Error('HEATLINE QA API is unavailable');
      return api.grantXp(1_250);
    });
    expect(progression).toEqual({
      level: 3,
      xp: 1_250,
      attributePoints: 1,
      skillPoints: 2,
    });
    await expect(page.locator('[data-hud-level]')).toHaveText('LV 3');

    let panel = await openHudPanel(page, 'skills');
    await expect(panel.getByRole('heading', { level: 2, name: 'Level 3' })).toBeVisible();
    await expect(panel.locator('[data-attribute-points]')).toHaveText('1');
    await expect(panel.locator('[data-skill-points]')).toHaveText('2');
    await expect(panel.locator('li.skill-node')).toHaveCount(24);
    const aim = panel.locator('[data-attribute="aim"]');
    await expect(aim).toContainText('1 / 6');
    await aim.getByRole('button', { name: 'Increase Aim' }).click();
    await expect(panel.locator('[data-attribute="aim"]')).toContainText('2 / 6');
    await expect(panel.locator('[data-attribute-points]')).toHaveText('0');
    const fastHands = panel.locator('li[data-skill-id="combat-fast-hands"]');
    await fastHands.getByRole('button', { name: 'Unlock Fast Hands' }).click();
    await expect(panel.locator('li[data-skill-id="combat-fast-hands"]')).toHaveClass(/is-unlocked/);
    await expect(panel.locator('[data-skill-points]')).toHaveText('1');
    await closePanel(panel);
    await expect(world).toHaveAttribute('data-rpg-weapon-spread', '0.9500');
    await expect(world).toHaveAttribute('data-rpg-reload-time', '0.8245');

    const initialInventory = await inventoryState(page);
    expect(initialInventory).toMatchObject({
      itemCount: 11,
      quickLoadout: {
        firearms: ['starter-pistol', null],
        melee: 'starter-melee',
        consumables: ['starter-medkit', null],
      },
      unlockedRecipes: 9,
    });

    await enterMorenoGarage(page);
    panel = await openHudPanel(page, 'inventory');
    await expect(panel.locator('[data-inventory-grid]')).toBeVisible();
    await expect(panel.locator('[data-inventory-action="move"]')).toHaveCount(48);
    await expect(panel.getByText('Safehouse bench online', { exact: true })).toBeVisible();

    const pistol = panel.locator('[data-instance-id="starter-pistol"]');
    await pistol.click();
    await panel.getByRole('button', { name: 'Clear Firearm 1' }).click();
    expect((await inventoryState(page)).quickLoadout.firearms).toEqual([null, null]);
    await panel.getByRole('button', { name: 'Equip Firearm 1' }).click();
    expect((await inventoryState(page)).quickLoadout.firearms).toEqual(['starter-pistol', null]);

    let melee = panel.locator('[data-instance-id="starter-melee"]');
    await melee.click();
    await panel.getByRole('button', { name: 'Move selected item to column 6, row 4' }).click();
    await panel.getByRole('button', { name: 'Rotate' }).click();
    melee = panel.locator('[data-instance-id="starter-melee"]');
    await expect.poll(() => itemShape(melee)).toEqual({ width: '3', height: '1' });

    await panel.locator('[data-instance-id="starter-handgun-ammo"]').click();
    await panel.getByRole('button', { name: 'Split stack' }).click();
    expect((await inventoryState(page)).itemCount).toBe(12);
    await expect(panel.getByRole('button', { name: /Handgun Rounds, quantity 12/ })).toHaveCount(2);

    const armorRecipe = panel.locator('[data-recipe-id="craft-armor-repair-plate"]');
    await expect(armorRecipe.getByRole('button', { name: 'Craft' })).toBeEnabled();
    const weightBeforeCraft = (await inventoryState(page)).weightKg;
    await armorRecipe.getByRole('button', { name: 'Craft' }).click();
    const craftedInventory = await inventoryState(page);
    expect(craftedInventory.itemCount).toBe(13);
    expect(craftedInventory.weightKg).toBeGreaterThan(weightBeforeCraft);
    await expect(panel.getByRole('button', { name: /Armor Repair Plate, quantity 1/ })).toBeVisible();
    await closePanel(panel);

    await page.evaluate(() => {
      const api = (window as QaWindow).__HEATLINE_QA__;
      if (!api) throw new Error('HEATLINE QA API is unavailable');
      api.setMoney(100_000);
    });
    panel = await openHudPanel(page, 'properties');
    await expect(panel.locator('[data-shop-item]')).toHaveCount(15);
    await expect(panel.locator('.property-card[data-property-id]')).toHaveCount(5);
    await panel.locator('[data-shop-item="ammo-smg"]').getByRole('button').click();
    await expect(panel.locator('[data-economy-cash]')).toHaveAttribute('data-economy-cash', '99996');
    expect((await inventoryState(page)).itemCount).toBe(14);

    let warehouse = panel.locator('.property-card[data-property-id="breakwater-warehouse"]');
    await warehouse.getByRole('button', { name: 'Buy · $18,000' }).click();
    await expect(panel.locator('[data-economy-cash]')).toHaveAttribute('data-economy-cash', '81996');
    warehouse = panel.locator('.property-card[data-property-id="breakwater-warehouse"]');
    await expect(warehouse).toContainText('Owned');

    await dispatchEconomyAction(page, 'purchase-property', 'breakwater-warehouse');
    await expect(panel.locator('[data-economy-cash]')).toHaveAttribute('data-economy-cash', '81996');
    await expect(page.locator('[data-toast]')).toContainText('already owned');

    warehouse = panel.locator('.property-card[data-property-id="breakwater-warehouse"]');
    await warehouse.getByRole('button', { name: 'Upgrade · $9,000' }).click();
    await expect(panel.locator('[data-economy-cash]')).toHaveAttribute('data-economy-cash', '72996');
    await expect(panel.locator('.property-card[data-property-id="breakwater-warehouse"]')).toContainText('Upgraded');

    const payouts = await page.evaluate(() => {
      const api = (window as QaWindow).__HEATLINE_QA__;
      if (!api) throw new Error('HEATLINE QA API is unavailable');
      return api.accruePropertyPayouts(100);
    });
    expect(payouts['breakwater-warehouse']).toBe(3);
    await closePanel(panel);
    panel = await openHudPanel(page, 'properties');
    warehouse = panel.locator('.property-card[data-property-id="breakwater-warehouse"]');
    await expect(warehouse).toContainText('Payouts 3 / 3');
    await expect(warehouse).toContainText('$4,050');
    await warehouse.getByRole('button', { name: 'Collect', exact: true }).click();
    await expect(panel.locator('[data-economy-cash]')).toHaveAttribute('data-economy-cash', '77046');
    await expect(panel.locator('.property-card[data-property-id="breakwater-warehouse"]')).toContainText('Payouts 0 / 3');

    await dispatchEconomyAction(page, 'collect-property', 'breakwater-warehouse');
    await expect(panel.locator('[data-economy-cash]')).toHaveAttribute('data-economy-cash', '77046');
    await expect(page.locator('[data-toast]')).toContainText('No property income is ready');
    await closePanel(panel);

    await page.waitForTimeout(400);
    await world.locator('canvas').focus();
    await page.keyboard.press('Escape');
    const pause = page.getByLabel('Pause menu');
    await expect(pause).toBeVisible();
    await pause.getByRole('button', { name: 'Save and quit to menu' }).click();
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeVisible();

    await page.reload();
    await enterMainMenu(page);
    await page.getByRole('navigation', { name: 'Main menu' }).getByRole('button', { name: 'Play' }).click();
    const slot = page.locator('[data-save-list] article[data-slot="1"]');
    await slot.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByLabel('Game HUD')).toBeVisible({ timeout: 15_000 });
    await waitForQa(page);
    await expect(page.locator('[data-hud-level]')).toHaveText('LV 3');
    await expect(world).toHaveAttribute('data-rpg-weapon-spread', '0.9500');
    await expect(world).toHaveAttribute('data-rpg-reload-time', '0.8245');

    panel = await openHudPanel(page, 'skills');
    await expect(panel.locator('[data-attribute="aim"]')).toContainText('2 / 6');
    await expect(panel.locator('li[data-skill-id="combat-fast-hands"]')).toHaveClass(/is-unlocked/);
    await closePanel(panel);

    panel = await openHudPanel(page, 'inventory');
    expect(await inventoryState(page)).toMatchObject({
      itemCount: 14,
      quickLoadout: {
        firearms: ['starter-pistol', null],
        melee: 'starter-melee',
        consumables: ['starter-medkit', null],
      },
      unlockedRecipes: 9,
    });
    await expect.poll(() => itemShape(panel.locator('[data-instance-id="starter-melee"]')))
      .toEqual({ width: '3', height: '1' });
    await expect(panel.getByRole('button', { name: /Armor Repair Plate, quantity 1/ })).toBeVisible();
    await expect(panel.getByRole('button', { name: /SMG Rounds, quantity 1/ })).toBeVisible();
    await closePanel(panel);

    panel = await openHudPanel(page, 'properties');
    await expect(panel.locator('[data-economy-cash]')).toHaveAttribute('data-economy-cash', '77046');
    warehouse = panel.locator('.property-card[data-property-id="breakwater-warehouse"]');
    await expect(warehouse).toContainText('Upgraded');
    await expect(warehouse).toContainText('Payouts 0 / 3');
  });

  test('mobile touch can operate progression, loadout, and shop panels', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile-only M5 touch panel course');
    test.setTimeout(60_000);

    await startNewGame(page, 1, 'Feminine Alex', '/?qa=1');
    await waitForQa(page);
    const world = page.getByLabel('3D game world');
    const setup = await page.evaluate(() => {
      const api = (window as QaWindow).__HEATLINE_QA__;
      if (!api) throw new Error('HEATLINE QA API is unavailable');
      const progression = api.grantXp(500);
      api.setMoney(5_000);
      return progression;
    });
    expect(setup).toEqual({ level: 2, xp: 500, attributePoints: 1, skillPoints: 1 });

    await page.keyboard.press('Escape');
    let panel = await openPausedTouchPanel(page, 'skills');
    const panelBox = await panel.locator('.panel-card').boundingBox();
    expect(panelBox).not.toBeNull();
    expect(panelBox!.x).toBeGreaterThanOrEqual(0);
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(844);
    await panel.getByRole('button', { name: 'Increase Grit' }).tap();
    await panel.locator('li[data-skill-id="combat-steady-hands"]')
      .getByRole('button', { name: 'Unlock Steady Hands' }).tap();
    await expect(panel.locator('[data-attribute="grit"]')).toContainText('2 / 6');
    await expect(panel.locator('li[data-skill-id="combat-steady-hands"]')).toHaveClass(/is-unlocked/);
    await closePanel(panel, true);

    panel = await openPausedTouchPanel(page, 'inventory');
    await expect(panel.locator('[data-inventory-action="move"]')).toHaveCount(48);
    await panel.locator('[data-instance-id="starter-medkit"]').tap();
    await panel.getByRole('button', { name: 'Clear Utility 1' }).tap();
    expect((await inventoryState(page)).quickLoadout.consumables).toEqual([null, null]);
    await panel.getByRole('button', { name: 'Equip Utility 1' }).tap();
    expect((await inventoryState(page)).quickLoadout.consumables).toEqual(['starter-medkit', null]);
    await closePanel(panel, true);

    panel = await openPausedTouchPanel(page, 'properties');
    await expect(panel.locator('.property-card[data-property-id]')).toHaveCount(5);
    await panel.locator('[data-shop-item="ammo-smg"]').getByRole('button').tap();
    await expect(panel.locator('[data-economy-cash]')).toHaveAttribute('data-economy-cash', '4996');
    expect((await inventoryState(page)).itemCount).toBe(12);
    await closePanel(panel, true);

    const pause = page.getByLabel('Pause menu');
    await pause.getByRole('button', { name: 'Resume' }).tap();
    await expect(pause).toBeHidden();
    await expect(world).toHaveAttribute('data-rpg-maximum-health', '110.00');
    await expect(page.locator('[data-touch-layout="on-foot"]')).toBeVisible();
  });
});
