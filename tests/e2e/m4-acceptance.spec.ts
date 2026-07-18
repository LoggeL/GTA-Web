import type { Page } from '@playwright/test';

import { startNewGame } from './helpers';
import { expect, test } from './fixtures';

interface QaCombatant {
  id: string;
  role: string;
  state: string;
  tactic: string;
  awareness: number;
  health: number;
  heading: number;
  x: number;
  z: number;
}

interface QaApi {
  teleport(x: number, z: number): unknown;
  face(x: number, z: number): unknown;
  snapshot(): {
    position: { x: number; z: number };
    weaponAmmo: number;
    weaponDurability: number;
  } | null;
  pedestrians(): readonly { id: string; behavior: string; x: number; z: number }[];
  combatants(): readonly QaCombatant[];
  selectWeapon(weaponId: string): unknown;
  damageCombatant(targetId: string, amount: number): boolean;
  setMoney(value: number): number;
  setWantedLevel(level: number): { level: number; phase: string };
  advanceWanted(seconds: number, isVisible?: boolean, insideSearchArea?: boolean): {
    level: number;
    phase: string;
  };
  advanceWorld(seconds: number): { simulatedSeconds: number; wantedLevel: number };
  setPlayerCondition(health: number, armor: number): { health: number; armor: number };
  defeat(outcome: 'death' | 'arrest'): Promise<{ health: number; money: number; wantedLevel: number }>;
}

type QaWindow = Window & { __HEATLINE_QA__?: QaApi };

const WEAPONS = [
  'melee-tier-1', 'pistol-tier-1', 'smg-tier-1', 'shotgun-tier-1', 'rifle-tier-1',
  'melee-tier-2', 'pistol-tier-2', 'smg-tier-2', 'shotgun-tier-2', 'rifle-tier-2',
  'melee-tier-3', 'pistol-tier-3', 'smg-tier-3', 'shotgun-tier-3', 'rifle-tier-3',
] as const;

async function waitForQa(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as QaWindow).__HEATLINE_QA__));
}

async function placeBehindCombatant(page: Page, targetId: string): Promise<QaCombatant> {
  return page.evaluate((id) => {
    const api = (window as QaWindow).__HEATLINE_QA__;
    if (!api) throw new Error('HEATLINE QA API is unavailable');
    const target = api.combatants().find((candidate) => candidate.id === id);
    if (!target) throw new Error(`Missing combatant ${id}`);
    api.teleport(
      target.x + Math.sin(target.heading) * 1.4,
      target.z + Math.cos(target.heading) * 1.4,
    );
    api.face(target.x, target.z);
    return target;
  }, targetId);
}

test.describe('M4 combat, stealth, NPC, and wanted acceptance', () => {
  test('resolves stealth and loud encounters, all weapons, all roles, the heat ladder, and clinic recovery', async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), 'Desktop covers the full M4 state matrix; mobile has a focused combat course');
    test.setTimeout(60_000);
    await startNewGame(page, 1, 'Masculine Alex', '/?qa=1');
    await waitForQa(page);
    const world = page.getByLabel('3D game world');
    const canvas = page.locator('canvas.world-view__canvas');
    const canvasBox = await canvas.boundingBox();
    expect(canvasBox).not.toBeNull();
    const canvasCenter = {
      x: canvasBox!.x + canvasBox!.width / 2,
      y: canvasBox!.y + canvasBox!.height / 2,
    };

    const initialCombatants = await page.evaluate(() => (
      (window as QaWindow).__HEATLINE_QA__?.combatants() ?? []
    ));
    expect(new Set(initialCombatants.map(({ role }) => role))).toEqual(new Set([
      'brawler', 'gunner', 'flanker', 'heavy', 'marksman',
    ]));
    expect(Object.fromEntries(initialCombatants.map(({ role, tactic }) => [role, tactic]))).toEqual({
      brawler: 'rush',
      gunner: 'hold-range',
      flanker: 'flank',
      heavy: 'suppress',
      marksman: 'seek-distance',
    });

    for (const weaponId of WEAPONS) {
      await page.evaluate((id) => {
        const api = (window as QaWindow).__HEATLINE_QA__;
        if (!api) throw new Error('HEATLINE QA API is unavailable');
        api.selectWeapon(id);
      }, weaponId);
      await expect(world).toHaveAttribute('data-active-weapon-id', weaponId);
    }
    await page.evaluate(() => (window as QaWindow).__HEATLINE_QA__?.selectWeapon('pistol-tier-1'));
    await page.keyboard.press('Tab');
    await expect(world).toHaveAttribute('data-active-weapon-id', 'smg-tier-1');

    const stealthTarget = initialCombatants.find(({ role }) => role === 'gunner');
    if (!stealthTarget) throw new Error('Missing stealth target');
    await page.evaluate(() => (window as QaWindow).__HEATLINE_QA__?.selectWeapon('melee-tier-1'));
    // Crouch before entering the target's peripheral range so a loaded browser
    // cannot advance awareness past the contextual-takedown threshold between
    // the teleport and the next input event.
    await page.keyboard.down('c');
    await expect(world).toHaveAttribute('data-crouching', 'true');
    await placeBehindCombatant(page, stealthTarget.id);
    await page.mouse.move(canvasCenter.x, canvasCenter.y);
    await page.mouse.down({ button: 'left' });
    await page.waitForTimeout(90);
    await page.mouse.up({ button: 'left' });
    await expect.poll(async () => page.evaluate((id) => {
      const target = (window as QaWindow).__HEATLINE_QA__?.combatants()
        .find((candidate) => candidate.id === id);
      return target?.state ?? 'pooled';
    }, stealthTarget.id)).toMatch(/incapacitated|pooled/);
    await page.keyboard.up('c');
    await page.evaluate(() => (window as QaWindow).__HEATLINE_QA__?.setWantedLevel(0));

    const loudTarget = await page.evaluate(() => {
      const api = (window as QaWindow).__HEATLINE_QA__;
      if (!api) throw new Error('HEATLINE QA API is unavailable');
      const target = api.combatants().find((candidate) => candidate.role === 'heavy');
      if (!target) throw new Error('Missing loud target');
      api.teleport(target.x + 9, target.z);
      api.face(target.x, target.z);
      api.selectWeapon('rifle-tier-3');
      return target;
    });
    const loudBefore = await page.evaluate(() => (window as QaWindow).__HEATLINE_QA__?.snapshot());
    await page.mouse.move(canvasCenter.x, canvasCenter.y);
    await page.mouse.down({ button: 'left' });
    await page.waitForTimeout(100);
    await page.mouse.up({ button: 'left' });
    await expect.poll(async () => page.evaluate((id) => (
      (window as QaWindow).__HEATLINE_QA__?.combatants().find((candidate) => candidate.id === id)?.health
        ?? Number.POSITIVE_INFINITY
    ), loudTarget.id)).toBeLessThan(loudTarget.health);
    const loudAfter = await page.evaluate(() => (window as QaWindow).__HEATLINE_QA__?.snapshot());
    expect(loudAfter?.weaponAmmo).toBeLessThan(loudBefore?.weaponAmmo ?? Number.POSITIVE_INFINITY);
    expect(loudAfter?.weaponDurability).toBeLessThan(loudBefore?.weaponDurability ?? Number.POSITIVE_INFINITY);
    await expect.poll(async () => page.evaluate(() => (
      (window as QaWindow).__HEATLINE_QA__?.combatants()
        .some(({ state }) => !['patrol', 'incapacitated'].includes(state)) ?? false
    ))).toBe(true);

    const witnessShotBefore = await page.evaluate(() => {
      const api = (window as QaWindow).__HEATLINE_QA__;
      if (!api) throw new Error('HEATLINE QA API is unavailable');
      // The loud-combat contract above is already satisfied. Incapacitating
      // the remaining hostiles isolates this witness-report fixture from
      // unrelated combat damage while its fixed simulation clock advances.
      for (const combatant of api.combatants()) {
        if (combatant.state !== 'incapacitated') {
          api.damageCombatant(combatant.id, 10_000);
        }
      }
      api.setWantedLevel(0);
      const witness = api.pedestrians().find(({ behavior }) => behavior === 'wander');
      if (!witness) throw new Error('Missing calm pedestrian witness');
      // A non-zero separation gives the direct-threat flee path a stable
      // direction before its report, rather than relying on normalization of
      // an exact player/witness overlap.
      api.teleport(witness.x - 9, witness.z);
      api.face(witness.x, witness.z);
      api.selectWeapon('pistol-tier-1');
      return api.snapshot();
    });
    await page.mouse.move(canvasCenter.x, canvasCenter.y);
    await page.mouse.down({ button: 'left' });
    await page.waitForTimeout(80);
    await page.mouse.up({ button: 'left' });
    const witnessShotAfter = await page.evaluate(() => (
      (window as QaWindow).__HEATLINE_QA__?.snapshot()
    ));
    expect(witnessShotAfter?.weaponAmmo).toBeLessThan(
      witnessShotBefore?.weaponAmmo ?? Number.POSITIVE_INFINITY,
    );
    expect(witnessShotAfter?.weaponDurability).toBeLessThan(
      witnessShotBefore?.weaponDurability ?? Number.POSITIVE_INFINITY,
    );
    // Unsuppressed gunfire makes a nearby witness flee for four simulated
    // seconds before the authored report delay (at most 1.1 s). Drive that
    // existing state machine rather than making acceptance depend on RAF
    // throughput under concurrent software-rendered projects.
    const witnessResult = await page.evaluate(() => (
      (window as QaWindow).__HEATLINE_QA__?.advanceWorld(5.2)
    ));
    expect(witnessResult?.simulatedSeconds).toBeCloseTo(5.2, 5);
    expect(witnessResult?.wantedLevel).toBeGreaterThan(0);
    await expect(world).toHaveAttribute('data-wanted-level', /[1-5]/);

    for (const level of [1, 2, 3, 4, 5]) {
      await page.evaluate((nextLevel) => (
        (window as QaWindow).__HEATLINE_QA__?.setWantedLevel(nextLevel)
      ), level);
      await expect(world).toHaveAttribute('data-wanted-level', String(level));
      await expect(world).toHaveAttribute('data-police-roadblock', 'false');
      await expect(world).toHaveAttribute('data-police-helicopter', 'false');
      await expect(world).toHaveAttribute('data-police-roadblock-count', '0');
      await expect(world).toHaveAttribute('data-police-helicopter-mode', 'inactive');
    }
    const cleared = await page.evaluate(() => (
      (window as QaWindow).__HEATLINE_QA__?.advanceWanted(600, false, false)
    ));
    expect(cleared).toMatchObject({ level: 0, phase: 'clear' });
    await expect(world).toHaveAttribute('data-wanted-level', '0');

    const defeat = await page.evaluate(async () => {
      const api = (window as QaWindow).__HEATLINE_QA__;
      if (!api) throw new Error('HEATLINE QA API is unavailable');
      api.setMoney(1_000);
      api.setWantedLevel(2);
      api.setPlayerCondition(1, 0);
      return api.defeat('death');
    });
    expect(defeat).toEqual({ health: 100, money: 900, wantedLevel: 0 });
    const respawn = await page.evaluate(() => (window as QaWindow).__HEATLINE_QA__?.snapshot()?.position);
    expect(respawn?.x).toBeCloseTo(-84, 1);
    expect(respawn?.z).toBeCloseTo(102, 1);
  });

  test('mobile touch resolves a crouched takedown without spawning police response actors', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile-only M4 course');
    test.setTimeout(45_000);
    await startNewGame(page, 1, 'Feminine Alex', '/?qa=1');
    await waitForQa(page);
    const world = page.getByLabel('3D game world');
    const target = await page.evaluate(() => {
      const api = (window as QaWindow).__HEATLINE_QA__;
      if (!api) throw new Error('HEATLINE QA API is unavailable');
      const candidate = api.combatants().find((combatant) => combatant.role === 'brawler');
      if (!candidate) throw new Error('Missing mobile stealth target');
      api.selectWeapon('melee-tier-1');
      return candidate;
    });
    await placeBehindCombatant(page, target.id);
    const controls = page.locator('[data-touch-layout]');
    const crouch = controls.locator('[data-touch-action="crouch"]');
    const fire = controls.locator('[data-touch-action="fire"]');
    await crouch.dispatchEvent('pointerdown');
    await expect(world).toHaveAttribute('data-crouching', 'true');
    await fire.dispatchEvent('pointerdown');
    await page.waitForTimeout(100);
    await fire.dispatchEvent('pointerup');
    await expect.poll(async () => page.evaluate((id) => {
      const combatant = (window as QaWindow).__HEATLINE_QA__?.combatants()
        .find((candidate) => candidate.id === id);
      return combatant?.state ?? 'pooled';
    }, target.id)).toMatch(/incapacitated|pooled/);
    await crouch.dispatchEvent('pointerup');

    await page.evaluate(() => (window as QaWindow).__HEATLINE_QA__?.setWantedLevel(5));
    await expect(world).toHaveAttribute('data-wanted-level', '5');
    await expect(world).toHaveAttribute('data-police-roadblock', 'false');
    await expect(world).toHaveAttribute('data-police-helicopter', 'false');
    await expect(world).toHaveAttribute('data-police-roadblock-count', '0');
    await expect(world).toHaveAttribute('data-police-helicopter-mode', 'inactive');
  });
});
