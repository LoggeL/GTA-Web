import { describe, expect, it } from 'vitest';

import { ACTIVITIES } from '../../src/data/economy';
import type { ActivityTypeId } from '../../src/data/types';
import {
  completeActivity,
  createActivityProgress,
  createActivityProgressSnapshot,
  createActivitySaveFields,
  restoreActivityProgress,
  restoreActivityProgressSnapshot,
  startActivity,
  type ActivityAccessContext,
  type StartActivityRequest,
} from '../../src/systems/activities';

const ALL_UNLOCKS = ACTIVITIES.map((activity) => activity.unlockFlag);

function request(
  activityId: ActivityTypeId,
  difficultyId: StartActivityRequest['difficultyId'] = 'rookie',
  nowMs = 1_000,
  level = 20,
): StartActivityRequest {
  return {
    activityId,
    difficultyId,
    worldSeed: 0x1234abcd,
    access: { level, nowMs, unlockedFlags: ALL_UNLOCKS },
    rewardContext: { hustleLevel: 3, sideHustle: true },
  };
}

describe('repeatable activity domain', () => {
  it('creates deterministic serialized variants for all five activities and three difficulties', () => {
    const state = createActivityProgress(ACTIVITIES);
    expect(Object.keys(state)).toHaveLength(5);

    for (const definition of ACTIVITIES) {
      for (const difficulty of definition.difficulties) {
        const input = request(definition.id, difficulty.id, 5_000, 20);
        const first = startActivity(state, ACTIVITIES, input);
        const second = startActivity(state, ACTIVITIES, input);
        expect(first).toEqual(second);
        expect(first.success).toBe(true);
        if (!first.success) continue;
        expect(first.run.variantIndex).toBeGreaterThanOrEqual(0);
        expect(first.run.variantIndex).toBeLessThan(definition.variantCount);
        expect(definition.districts).toContain(first.run.district);
        expect(first.run.targetMultiplier).toBe(difficulty.targetMultiplier);
        expect(first.run.reward.difficultyMultiplier).toBe(difficulty.rewardMultiplier);
        expect(JSON.parse(JSON.stringify(first.run))).toEqual(first.run);
      }
    }

    const seedA = startActivity(state, ACTIVITIES, request('street-race'));
    const seedB = startActivity(state, ACTIVITIES, {
      ...request('street-race'), worldSeed: 0x1234abce,
    });
    expect(seedA.success && seedB.success && seedA.run.seed).not.toBe(seedB.success && seedB.run.seed);
  });

  it('enforces unlock, level, cooldown, and a stale-run compare-and-swap token', () => {
    const state = createActivityProgress(ACTIVITIES);
    const locked = startActivity(state, ACTIVITIES, {
      ...request('street-race'), access: { level: 20, nowMs: 1_000, unlockedFlags: [] },
    });
    expect(locked).toEqual({ success: false, reason: 'locked', cooldownRemainingMs: 0 });

    const professional = request('street-race', 'professional', 1_000, 6);
    expect(startActivity(state, ACTIVITIES, professional)).toEqual({
      success: false, reason: 'level-required', cooldownRemainingMs: 0,
    });

    const firstRequest = request('street-race');
    const first = startActivity(state, ACTIVITIES, firstRequest);
    expect(first.success).toBe(true);
    if (!first.success) return;
    const completed = completeActivity(state, ACTIVITIES, {
      ...firstRequest,
      expectedRunId: first.run.runId,
      performance: { score: 600, timeSeconds: 72.25 },
    });
    expect(completed.success).toBe(true);
    if (!completed.success) return;
    expect(completed.progress).toEqual({
      completions: 1,
      cooldownUntil: 721_000,
      bestScore: 600,
      bestTimeSeconds: 72.25,
    });
    expect(completed.reward.firstCompletion).toBe(true);
    expect(completed.newBestScore).toBe(true);
    expect(completed.newBestTime).toBe(true);
    expect(state['street-race']?.completions).toBe(0);

    const duplicate = completeActivity(completed.state, ACTIVITIES, {
      ...firstRequest,
      expectedRunId: first.run.runId,
      performance: { score: 600, timeSeconds: 72.25 },
    });
    expect(duplicate.success).toBe(false);
    expect(duplicate.state).toEqual(completed.state);

    const expiredRequest = request('street-race', 'rookie', completed.progress.cooldownUntil);
    const second = startActivity(completed.state, ACTIVITIES, expiredRequest);
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.run.runId).not.toBe(first.run.runId);
    const stale = completeActivity(completed.state, ACTIVITIES, {
      ...expiredRequest,
      expectedRunId: first.run.runId,
      performance: { timeSeconds: 70 },
    });
    expect(stale.success).toBe(false);
    expect(stale.success ? '' : stale.reason).toContain('stale');
  });

  it('tracks improving time and score independently without overwriting better records', () => {
    let state = createActivityProgress(ACTIVITIES);
    let nowMs = 10_000;

    const runOnce = (score: number, timeSeconds: number): void => {
      const runRequest = request('courier-run', 'rookie', nowMs);
      const started = startActivity(state, ACTIVITIES, runRequest);
      expect(started.success).toBe(true);
      if (!started.success) return;
      const completed = completeActivity(state, ACTIVITIES, {
        ...runRequest,
        expectedRunId: started.run.runId,
        performance: { score, timeSeconds },
      });
      expect(completed.success).toBe(true);
      if (!completed.success) return;
      state = completed.state;
      nowMs = completed.progress.cooldownUntil;
    };

    runOnce(800, 80);
    runOnce(700, 75);
    runOnce(900, 78);
    expect(state['courier-run']).toEqual({
      completions: 3,
      cooldownUntil: 1_810_000,
      bestScore: 900,
      bestTimeSeconds: 75,
    });
  });

  it('round-trips save fields and strict snapshots while migrating an empty pre-M6 record', () => {
    const migrated = restoreActivityProgress({}, ACTIVITIES);
    expect(migrated.success).toBe(true);
    if (!migrated.success) return;
    expect(Object.keys(migrated.state)).toHaveLength(5);

    const source = createActivityProgress(ACTIVITIES);
    source['bounty-hunt'] = {
      completions: 4, cooldownUntil: 99_000, bestScore: 2_500, bestTimeSeconds: 64.2,
    };
    const fields = createActivitySaveFields(source, ACTIVITIES);
    expect(restoreActivityProgress(JSON.parse(JSON.stringify(fields)), ACTIVITIES))
      .toEqual({ success: true, state: fields });

    const snapshot = createActivityProgressSnapshot(source, ACTIVITIES);
    expect(restoreActivityProgressSnapshot(JSON.parse(JSON.stringify(snapshot)), ACTIVITIES))
      .toEqual({ success: true, state: fields });
    expect(restoreActivityProgress({ unknown: source['bounty-hunt'] }, ACTIVITIES)).toEqual({
      success: false,
      errors: ['activities.unknown is not an authored activity'],
    });
    expect(restoreActivityProgress({
      'street-race': { completions: -1, cooldownUntil: 0, bestScore: Number.NaN, bestTimeSeconds: null },
    }, ACTIVITIES).success).toBe(false);
  });

  it('rejects missing authoritative performance metrics without mutating progress', () => {
    const state = createActivityProgress(ACTIVITIES);
    const raceRequest = request('street-race');
    const race = startActivity(state, ACTIVITIES, raceRequest);
    expect(race.success).toBe(true);
    if (!race.success) return;
    const noTime = completeActivity(state, ACTIVITIES, {
      ...raceRequest, expectedRunId: race.run.runId, performance: { score: 1_000 },
    });
    expect(noTime.success).toBe(false);
    expect(noTime.state).toEqual(state);

    const invalidAccess: ActivityAccessContext = { level: 21, nowMs: 0, unlockedFlags: ALL_UNLOCKS };
    expect(startActivity(state, ACTIVITIES, { ...raceRequest, access: invalidAccess }).success).toBe(false);
  });
});
