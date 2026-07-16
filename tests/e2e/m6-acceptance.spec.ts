import type { Locator, Page } from '@playwright/test';

import { enterMainMenu, startNewGame } from './helpers';
import { expect, test } from './fixtures';

type EndingChoice = 'rule' | 'expose';

interface CampaignQaSnapshot {
  activeMissionId: string | null;
  activeMissionStatus: string | null;
  activeObjectiveIds: readonly string[];
  availableMissionIds: readonly string[];
  completedMissionIds: readonly string[];
  checkpointId: string | null;
  wantedLevel: number;
  contacts: Readonly<Record<string, number>>;
  ending: EndingChoice | null;
  storyComplete: boolean;
  postgameFreeRoam: boolean;
  reviewedDialogueKeys: readonly string[];
}

interface ContentQaSnapshot {
  activeActivityId: string | null;
  activityStep: number;
  activities: Readonly<Record<string, number>>;
  revealedCollectibles: number;
  completedCollectibles: number;
  collectibleCategories: Readonly<Record<string, { completed: number; total: number }>>;
}

interface QaApi {
  snapshot(): {
    vehicleIntegrity: {
      bodyHealth: number;
      engineHealth: number;
      tireHealth: readonly [number, number, number, number];
    };
  } | null;
  setActiveVehicleCondition(bodyHealth: number, engineHealth: number): unknown;
  grantXp(amount: number): { level: number; xp: number };
  campaignState(): CampaignQaSnapshot;
  startMission(missionId: string): CampaignQaSnapshot;
  advanceMissionObjective(choice?: EndingChoice): CampaignQaSnapshot;
  failMission(reason?: string): CampaignQaSnapshot;
  retryMission(): CampaignQaSnapshot;
  completeMission(choice?: EndingChoice): CampaignQaSnapshot;
  startActivity(activityId: string, difficultyId?: string): ContentQaSnapshot;
  completeActivity(): ContentQaSnapshot;
  collectCollectible(collectibleId: string): ContentQaSnapshot;
  contentState(): ContentQaSnapshot;
}

type QaWindow = Window & { __HEATLINE_QA__?: QaApi };

const STORY_MISSIONS = [
  'past-due',
  'coastline-burn',
  'rolling-stock',
  'bridge-run',
  'last-call',
  'glass-house',
  'container-zero',
  'dead-air',
  'night-train',
  'black-grid',
  'full-account',
  'freehold',
] as const;

// Each contact chain stays internally ordered while the three contacts remain interleaved.
const OPEN_CONTACT_ORDER_BEFORE_LEVEL_SEVEN = [
  'coastline-burn',
  'last-call',
  'dead-air',
  'rolling-stock',
  'glass-house',
  'night-train',
] as const;

const OPEN_CONTACT_ORDER_LEVEL_SEVEN = [
  'bridge-run',
  'container-zero',
  'black-grid',
] as const;

const EARLY_ACTIVITIES = [
  'street-race',
  'courier-run',
  'vehicle-theft-list',
  'property-defense',
] as const;

const ALL_ACTIVITIES = [...EARLY_ACTIVITIES, 'bounty-hunt'] as const;

const COLLECTIBLE_IDS = [
  ...Array.from({ length: 30 }, (_, index) => `salvage-cache-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 20 }, (_, index) => `stunt-jump-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 10 }, (_, index) => `signal-node-${String(index + 1).padStart(2, '0')}`),
];

async function waitForQa(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as QaWindow).__HEATLINE_QA__));
}

async function campaignState(page: Page): Promise<CampaignQaSnapshot> {
  return page.evaluate(() => {
    const api = (window as QaWindow).__HEATLINE_QA__;
    if (!api) throw new Error('HEATLINE QA API is unavailable');
    return api.campaignState();
  });
}

async function contentState(page: Page): Promise<ContentQaSnapshot> {
  return page.evaluate(() => {
    const api = (window as QaWindow).__HEATLINE_QA__;
    if (!api) throw new Error('HEATLINE QA API is unavailable');
    return api.contentState();
  });
}

async function completeAvailableMission(
  page: Page,
  missionId: string,
  choice: EndingChoice = 'rule',
): Promise<CampaignQaSnapshot> {
  const before = await campaignState(page);
  expect(before.activeMissionId, `No other job may be active before ${missionId}`).toBeNull();
  expect(before.availableMissionIds, `${missionId} must be legally available`).toContain(missionId);

  const result = await page.evaluate(({ id, ending }) => {
    const api = (window as QaWindow).__HEATLINE_QA__;
    if (!api) throw new Error('HEATLINE QA API is unavailable');
    const started = api.startMission(id);
    if (started.activeMissionId !== id || started.activeMissionStatus !== 'active') {
      throw new Error(`Mission ${id} did not enter its active state`);
    }
    return api.completeMission(ending);
  }, { id: missionId, ending: choice });

  expect(result.activeMissionId).toBeNull();
  expect(result.completedMissionIds).toContain(missionId);
  return result;
}

async function completeActivities(
  page: Page,
  activityIds: readonly string[],
): Promise<ContentQaSnapshot> {
  return page.evaluate((ids) => {
    const api = (window as QaWindow).__HEATLINE_QA__;
    if (!api) throw new Error('HEATLINE QA API is unavailable');
    let state = api.contentState();
    for (const id of ids) {
      state = api.startActivity(id, 'rookie');
      if (state.activeActivityId !== id) throw new Error(`Activity ${id} did not start`);
      state = api.completeActivity();
      if (state.activeActivityId !== null || state.activities[id] !== 1) {
        throw new Error(`Activity ${id} did not complete exactly once`);
      }
    }
    return state;
  }, [...activityIds]);
}

async function collectEveryDiscovery(page: Page): Promise<ContentQaSnapshot> {
  return page.evaluate((ids) => {
    const api = (window as QaWindow).__HEATLINE_QA__;
    if (!api) throw new Error('HEATLINE QA API is unavailable');
    let state = api.contentState();
    for (const id of ids) state = api.collectCollectible(id);
    return state;
  }, COLLECTIBLE_IDS);
}

async function openCampaignPanel(page: Page, touch = false): Promise<Locator> {
  const launcher = page.getByLabel('Game HUD').locator('[data-open-panel="missions"]');
  if (touch) await launcher.tap();
  else await launcher.click();
  const panel = page.getByRole('region', { name: 'Game panel', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-panel', 'missions');
  return panel;
}

async function closeCampaignPanel(panel: Locator, touch = false): Promise<void> {
  const close = panel.getByRole('button', { name: 'Close' });
  if (touch) await close.tap();
  else await close.click();
  await expect(panel).toBeHidden();
}

async function expectCompletedCampaignPanel(
  panel: Locator,
  ending: EndingChoice,
): Promise<void> {
  await expect(panel.locator('.mission-card')).toHaveCount(12);
  await expect(panel.locator('.mission-card--complete')).toHaveCount(12);
  await expect(panel.locator('.active-mission--empty')).toContainText('Free roam');
  await expect(panel.locator(`[data-ending="${ending}"]`)).toHaveText(
    ending === 'rule' ? 'Rule ending' : 'Expose ending',
  );
  for (const activityId of ALL_ACTIVITIES) {
    await expect(panel.locator(`.activity-card[data-activity-id="${activityId}"]`)).toContainText('1 clears');
  }
  await expect(panel.locator('[data-collectible-set="salvage-cache"]')).toContainText('30 / 30');
  await expect(panel.locator('[data-collectible-set="stunt-jump"]')).toContainText('20 / 20');
  await expect(panel.locator('[data-collectible-set="signal-node"]')).toContainText('10 / 10');
  await expect(panel.locator('.mission-log li')).toHaveCount(49);
  await expect(panel.locator(`[data-dialogue-key="freehold.${ending}"]`)).toBeVisible();
  await expect(panel.locator(`[data-dialogue-key="freehold.${ending === 'rule' ? 'expose' : 'rule'}"]`))
    .toHaveCount(0);
}

async function saveQuitAndContinue(page: Page, slot: 1 | 2 | 3): Promise<void> {
  // Mission/content transactions autosave; let their final IndexedDB write settle before
  // invoking the explicit save-and-quit boundary exercised by this acceptance course.
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  const pause = page.getByLabel('Pause menu');
  await expect(pause).toBeVisible();
  await pause.getByRole('button', { name: 'Save and quit to menu' }).click();
  await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeVisible();

  await page.reload();
  await enterMainMenu(page);
  await page.getByRole('navigation', { name: 'Main menu' }).getByRole('button', { name: 'Play' }).click();
  const slotCard = page.locator(`[data-save-list] article[data-slot="${slot}"]`);
  await slotCard.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByLabel('Game HUD')).toBeVisible({ timeout: 15_000 });
  await waitForQa(page);
}

test.describe('M6 campaign, activities, exploration, and persistence acceptance', () => {
  test('desktop clean save completes every system through Rule and survives continue', async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), 'Desktop covers the complete M6 campaign and content persistence course');
    test.setTimeout(90_000);

    await startNewGame(page, 1, 'Masculine Alex', '/?qa=1');
    await waitForQa(page);

    const initial = await campaignState(page);
    expect(initial).toMatchObject({
      activeMissionId: 'past-due',
      activeMissionStatus: 'active',
      checkpointId: 'past-due:start',
      completedMissionIds: [],
      ending: null,
    });
    expect(initial.reviewedDialogueKeys).toEqual(['past-due.intro']);

    const recovery = await page.evaluate(() => {
      const api = (window as QaWindow).__HEATLINE_QA__;
      if (!api) throw new Error('HEATLINE QA API is unavailable');
      let reached = api.campaignState();
      for (let step = 0; step < 16 && reached.checkpointId !== 'past-due:chase'; step += 1) {
        reached = api.advanceMissionObjective();
      }
      if (reached.checkpointId !== 'past-due:chase') {
        throw new Error('Past Due never reached its tow-truck checkpoint');
      }
      const midObjective = api.advanceMissionObjective();
      api.setActiveVehicleCondition(5, 4);
      const failed = api.failMission('Acceptance checkpoint drill');
      const retried = api.retryMission();
      return { reached, midObjective, failed, retried, vehicle: api.snapshot()?.vehicleIntegrity };
    });
    expect(recovery.reached.activeObjectiveIds).toEqual(['past-due:chase-tow-truck']);
    expect(recovery.midObjective.activeObjectiveIds).toEqual(['past-due:chase-tow-truck']);
    expect(recovery.failed).toMatchObject({
      activeMissionId: 'past-due',
      activeMissionStatus: 'failed',
      checkpointId: 'past-due:chase',
    });
    expect(recovery.retried).toMatchObject({
      activeMissionId: 'past-due',
      activeMissionStatus: 'active',
      checkpointId: 'past-due:chase',
      activeObjectiveIds: ['past-due:chase-tow-truck'],
    });
    expect(recovery.vehicle).toEqual({
      bodyHealth: 100,
      engineHealth: 100,
      tireHealth: [100, 100, 100, 100],
    });

    const prologue = await page.evaluate(() => {
      const api = (window as QaWindow).__HEATLINE_QA__;
      if (!api) throw new Error('HEATLINE QA API is unavailable');
      return api.completeMission('rule');
    });
    expect(prologue.completedMissionIds).toEqual(['past-due']);
    expect(prologue.availableMissionIds).toEqual(expect.arrayContaining([
      'coastline-burn',
      'last-call',
      'dead-air',
    ]));
    expect(prologue.reviewedDialogueKeys).toEqual(expect.arrayContaining([
      'past-due.intro',
      'past-due.chase',
      'past-due.recovery',
      'past-due.complete',
    ]));

    for (const missionId of OPEN_CONTACT_ORDER_BEFORE_LEVEL_SEVEN) {
      if (missionId !== 'rolling-stock') {
        await completeAvailableMission(page, missionId);
        continue;
      }
      const escape = await page.evaluate(() => {
        const api = (window as QaWindow).__HEATLINE_QA__;
        if (!api) throw new Error('HEATLINE QA API is unavailable');
        api.startMission('rolling-stock');
        let state = api.campaignState();
        for (let step = 0; step < 16 && state.activeObjectiveIds[0] !== 'rolling-stock:lose-police'; step += 1) {
          state = api.advanceMissionObjective();
        }
        return state;
      });
      expect(escape).toMatchObject({
        activeMissionId: 'rolling-stock',
        activeObjectiveIds: ['rolling-stock:lose-police'],
        wantedLevel: 2,
      });
      const escaped = await page.evaluate(() => {
        const api = (window as QaWindow).__HEATLINE_QA__;
        if (!api) throw new Error('HEATLINE QA API is unavailable');
        return api.advanceMissionObjective();
      });
      expect(escaped.activeMissionId).toBeNull();
      expect(escaped.completedMissionIds).toContain('rolling-stock');
      expect(escaped.wantedLevel).toBe(0);
    }

    // The four unlocked rookie activities naturally supply the remaining XP for the
    // level-seven contact finales; this keeps the clean-save path legal without cheats.
    let content = await completeActivities(page, EARLY_ACTIVITIES);
    expect(content.activities).toMatchObject({
      'street-race': 1,
      'courier-run': 1,
      'vehicle-theft-list': 1,
      'property-defense': 1,
      'bounty-hunt': 0,
    });

    for (const missionId of OPEN_CONTACT_ORDER_LEVEL_SEVEN) {
      await completeAvailableMission(page, missionId);
    }
    content = await completeActivities(page, ['bounty-hunt']);
    expect(content.activities).toEqual({
      'street-race': 1,
      'courier-run': 1,
      'vehicle-theft-list': 1,
      'bounty-hunt': 1,
      'property-defense': 1,
    });

    content = await collectEveryDiscovery(page);
    expect(COLLECTIBLE_IDS).toHaveLength(60);
    expect(content).toMatchObject({
      activeActivityId: null,
      revealedCollectibles: 60,
      completedCollectibles: 60,
      collectibleCategories: {
        'salvage-cache': { completed: 30, total: 30 },
        'stunt-jump': { completed: 20, total: 20 },
        'signal-node': { completed: 10, total: 10 },
      },
    });

    await completeAvailableMission(page, 'full-account');
    const finished = await completeAvailableMission(page, 'freehold', 'rule');
    expect([...finished.completedMissionIds].sort()).toEqual([...STORY_MISSIONS].sort());
    expect(finished).toMatchObject({
      activeMissionId: null,
      activeMissionStatus: null,
      availableMissionIds: [],
      contacts: { juno: 15, malik: 15, priya: 15 },
      ending: 'rule',
      storyComplete: true,
      postgameFreeRoam: true,
    });
    expect(finished.reviewedDialogueKeys).toHaveLength(49);
    expect(finished.reviewedDialogueKeys).toContain('freehold.rule');
    expect(finished.reviewedDialogueKeys).not.toContain('freehold.expose');
    const world = page.getByLabel('3D game world');
    await expect(world).toHaveAttribute('data-campaign-ending', 'rule');
    await expect(world).toHaveAttribute('data-rpg-heat-gain', '1.1000');

    let panel = await openCampaignPanel(page);
    await expectCompletedCampaignPanel(panel, 'rule');
    await closeCampaignPanel(panel);

    await saveQuitAndContinue(page, 1);
    const restoredCampaign = await campaignState(page);
    const restoredContent = await contentState(page);
    expect(restoredCampaign).toEqual(finished);
    expect(restoredContent).toEqual(content);

    panel = await openCampaignPanel(page);
    await expectCompletedCampaignPanel(panel, 'rule');
    await closeCampaignPanel(panel);
  });

  test('desktop second clean save reaches the mutually exclusive Expose postgame', async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), 'Desktop runs the second full branching-campaign path');
    test.setTimeout(60_000);

    await startNewGame(page, 2, 'Feminine Alex', '/?qa=1');
    await waitForQa(page);
    await page.evaluate(() => {
      const api = (window as QaWindow).__HEATLINE_QA__;
      if (!api) throw new Error('HEATLINE QA API is unavailable');
      api.grantXp(20_000);
      api.completeMission('expose');
    });
    for (const missionId of [
      ...OPEN_CONTACT_ORDER_BEFORE_LEVEL_SEVEN,
      ...OPEN_CONTACT_ORDER_LEVEL_SEVEN,
      'full-account',
    ]) {
      await completeAvailableMission(page, missionId, 'expose');
    }
    const exposed = await completeAvailableMission(page, 'freehold', 'expose');
    expect([...exposed.completedMissionIds].sort()).toEqual([...STORY_MISSIONS].sort());
    expect(exposed).toMatchObject({
      ending: 'expose',
      storyComplete: true,
      postgameFreeRoam: true,
    });
    expect(exposed.reviewedDialogueKeys).toHaveLength(49);
    expect(exposed.reviewedDialogueKeys).toContain('freehold.expose');
    expect(exposed.reviewedDialogueKeys).not.toContain('freehold.rule');

    const panel = await openCampaignPanel(page);
    await expect(panel.locator('[data-ending="expose"]')).toHaveText('Expose ending');
    await expect(panel.locator('[data-dialogue-key="freehold.expose"]')).toBeVisible();
    await expect(panel.locator('[data-dialogue-key="freehold.rule"]')).toHaveCount(0);
    await closeCampaignPanel(panel);
  });

  test('mobile touch presents a bounded campaign board with the live prologue', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile-only M6 touch campaign-board course');
    test.setTimeout(45_000);

    await startNewGame(page, 1, 'Feminine Alex', '/?qa=1');
    await waitForQa(page);
    await page.keyboard.press('Escape');
    const pause = page.getByLabel('Pause menu');
    await expect(pause).toBeVisible();
    await pause.getByRole('button', { name: 'Jobs & mission log' }).tap();
    const panel = page.getByRole('region', { name: 'Game panel', exact: true });
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-panel', 'missions');
    const panelBox = await panel.locator('.panel-card').boundingBox();
    expect(panelBox).not.toBeNull();
    expect(panelBox!.x).toBeGreaterThanOrEqual(0);
    expect(panelBox!.y).toBeGreaterThanOrEqual(0);
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(844);
    expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(390);
    await expect(panel.locator('.mission-card')).toHaveCount(12);
    await expect(panel.locator('[data-active-mission-id="past-due"]')).toContainText('Past Due');
    await expect(panel.locator('[data-dialogue-key="past-due.intro"]')).toBeVisible();
    await expect(panel.locator('.activity-card')).toHaveCount(5);
    await expect(panel.locator('[data-collectible-set]')).toHaveCount(3);
    await closeCampaignPanel(panel, true);
    await pause.getByRole('button', { name: 'Resume' }).tap();
    await expect(page.locator('[data-touch-layout="on-foot"]')).toBeVisible();
  });
});
