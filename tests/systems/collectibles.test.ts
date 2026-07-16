import { describe, expect, it } from 'vitest';

import {
  COLLECTIBLES,
  COLLECTIBLE_SETS,
} from '../../src/data/collectibles';
import type { CollectibleCategoryId, CollectibleDefinition } from '../../src/data/types';
import {
  completeCollectible,
  createCollectibleProgress,
  createCollectibleProgressSnapshot,
  createCollectibleSaveFields,
  getCollectibleCategoryProgress,
  restoreCollectibleProgressSnapshot,
  restoreCollectibleSaveFields,
  revealCollectibles,
  visibleCollectibles,
  type CollectibleProgressState,
} from '../../src/systems/collectibles';

function requireCollectible(category: CollectibleCategoryId, ordinal = 1): CollectibleDefinition {
  const definition = COLLECTIBLES.find((entry) => entry.category === category && entry.ordinal === ordinal);
  if (!definition) throw new Error(`missing ${category} ${ordinal}`);
  return definition;
}

describe('collectible reveal and persistence domain', () => {
  it('migrates the original save keys and persists canonical reveal state without schema changes', () => {
    const migrated = restoreCollectibleSaveFields({ salvage: [], stunts: [], signals: [] }, COLLECTIBLES);
    expect(migrated).toEqual({ success: true, state: createCollectibleProgress() });
    if (!migrated.success) return;
    expect(createCollectibleSaveFields(migrated.state, COLLECTIBLES)).toEqual({
      salvage: [], stunts: [], signals: [], revealed: [],
    });

    const salvage = requireCollectible('salvage-cache');
    const legacy = restoreCollectibleSaveFields({ salvage: [salvage.id], stunts: [], signals: [] }, COLLECTIBLES);
    expect(legacy.success).toBe(true);
    if (!legacy.success) return;
    expect(legacy.state).toEqual({ revealedIds: [salvage.id], completedIds: [salvage.id] });
  });

  it('applies nearby, road-survey, and scanner-gated signal reveal rules idempotently', () => {
    const salvage = requireCollectible('salvage-cache');
    const stunt = requireCollectible('stunt-jump');
    const signal = requireCollectible('signal-node');
    let state = createCollectibleProgress();

    const nearby = revealCollectibles(state, COLLECTIBLES, {
      kind: 'nearby', district: salvage.district, x: salvage.position.x, z: salvage.position.z,
    });
    expect(nearby.newlyRevealedIds).toContain(salvage.id);
    expect(nearby.newlyRevealedIds.every((id) =>
      COLLECTIBLES.find((entry) => entry.id === id)?.revealRule === 'nearby')).toBe(true);
    state = nearby.state;

    const surveyed = revealCollectibles(state, COLLECTIBLES, {
      kind: 'road-survey', district: stunt.district,
    });
    const districtStunts = COLLECTIBLES.filter((entry) =>
      entry.district === stunt.district && entry.category === 'stunt-jump').map((entry) => entry.id);
    expect(surveyed.newlyRevealedIds).toEqual(districtStunts);
    state = surveyed.state;

    const lockedScan = revealCollectibles(state, COLLECTIBLES, {
      kind: 'signal-scan', district: signal.district,
      x: signal.position.x, z: signal.position.z, scannerUnlocked: false,
    });
    expect(lockedScan.newlyRevealedIds).toEqual([]);
    const unlockedScan = revealCollectibles(lockedScan.state, COLLECTIBLES, {
      kind: 'signal-scan', district: signal.district,
      x: signal.position.x, z: signal.position.z, scannerUnlocked: true,
    });
    expect(unlockedScan.newlyRevealedIds).toContain(signal.id);
    const repeated = revealCollectibles(unlockedScan.state, COLLECTIBLES, {
      kind: 'signal-scan', district: signal.district,
      x: signal.position.x, z: signal.position.z, scannerUnlocked: true,
    });
    expect(repeated.newlyRevealedIds).toEqual([]);
    expect(repeated.state).toEqual(unlockedScan.state);
    expect(visibleCollectibles(repeated.state, COLLECTIBLES).map((entry) => entry.id))
      .toEqual(repeated.state.revealedIds);
  });

  it('awards a revealed collectible exactly once and keeps the input immutable', () => {
    const salvage = requireCollectible('salvage-cache');
    const initial = createCollectibleProgress();
    const hidden = completeCollectible(initial, COLLECTIBLES, COLLECTIBLE_SETS, salvage.id);
    expect(hidden.success).toBe(false);
    expect(hidden.state).toEqual(initial);

    const revealed = revealCollectibles(initial, COLLECTIBLES, {
      kind: 'nearby', district: salvage.district, x: salvage.position.x, z: salvage.position.z,
    }).state;
    const completed = completeCollectible(revealed, COLLECTIBLES, COLLECTIBLE_SETS, salvage.id);
    expect(completed.success).toBe(true);
    if (!completed.success) return;
    expect(completed.transactionId).toBe(`collectible:${salvage.id}`);
    expect(completed.reward).toEqual({
      xp: salvage.reward.xp,
      cash: salvage.reward.cash,
      items: salvage.reward.items,
      unlockFlags: [],
    });
    expect(completed.categoryCompleted).toBe(false);
    expect(revealed.completedIds).not.toContain(salvage.id);

    const duplicate = completeCollectible(completed.state, COLLECTIBLES, COLLECTIBLE_SETS, salvage.id);
    expect(duplicate.success).toBe(false);
    expect(duplicate.state).toEqual(completed.state);
  });

  it('adds the category reward once on the final item and applies salvage modifiers deterministically', () => {
    const salvageDefinitions = COLLECTIBLES.filter((entry) => entry.category === 'salvage-cache');
    const final = requireCollectible('salvage-cache', 30);
    const state: CollectibleProgressState = {
      revealedIds: salvageDefinitions.map((entry) => entry.id),
      completedIds: salvageDefinitions.slice(0, -1).map((entry) => entry.id),
    };
    const completed = completeCollectible(state, COLLECTIBLES, COLLECTIBLE_SETS, final.id, {
      additionalSalvageComponents: 1,
      salvageYieldMultiplier: 1.2,
    });
    expect(completed.success).toBe(true);
    if (!completed.success) return;
    expect(completed.categoryCompleted).toBe(true);
    expect(completed.categoryProgress).toEqual({ completed: 30, total: 30 });
    expect(completed.reward).toEqual({
      xp: final.reward.xp + 1_000,
      cash: final.reward.cash + 1_200,
      items: [{ itemId: 'component-powder', quantity: 4 }],
      unlockFlags: ['salvage-cache-set-complete'],
    });
  });

  it('completes all 60 records with three and only three set bonuses', () => {
    let state: CollectibleProgressState = {
      revealedIds: COLLECTIBLES.map((entry) => entry.id),
      completedIds: [],
    };
    const transactions = new Set<string>();
    const completedCategories: string[] = [];
    let awardedCash = 0;
    let awardedXp = 0;
    for (const definition of COLLECTIBLES) {
      const completion = completeCollectible(state, COLLECTIBLES, COLLECTIBLE_SETS, definition.id);
      expect(completion.success).toBe(true);
      if (!completion.success) continue;
      state = completion.state;
      transactions.add(completion.transactionId);
      awardedCash += completion.reward.cash;
      awardedXp += completion.reward.xp;
      if (completion.categoryCompleted) completedCategories.push(definition.category);
    }
    expect(state.completedIds).toHaveLength(60);
    expect(transactions.size).toBe(60);
    expect(completedCategories).toEqual(['salvage-cache', 'stunt-jump', 'signal-node']);
    for (const set of COLLECTIBLE_SETS) {
      expect(getCollectibleCategoryProgress(state, COLLECTIBLES, set.category))
        .toEqual({ completed: set.count, total: set.count });
    }
    expect(awardedCash).toBe(
      COLLECTIBLES.reduce((sum, entry) => sum + entry.reward.cash, 0)
      + COLLECTIBLE_SETS.reduce((sum, set) => sum + set.completionReward.cash, 0),
    );
    expect(awardedXp).toBe(
      COLLECTIBLES.reduce((sum, entry) => sum + entry.reward.xp, 0)
      + COLLECTIBLE_SETS.reduce((sum, set) => sum + set.completionReward.xp, 0),
    );
  });

  it('round-trips save fields and snapshots and rejects wrong-category, duplicate, and unknown ids', () => {
    const salvage = requireCollectible('salvage-cache');
    const signal = requireCollectible('signal-node');
    const state: CollectibleProgressState = {
      revealedIds: [salvage.id, signal.id],
      completedIds: [salvage.id],
    };
    const saveFields = createCollectibleSaveFields(state, COLLECTIBLES);
    expect(restoreCollectibleSaveFields(JSON.parse(JSON.stringify(saveFields)), COLLECTIBLES))
      .toEqual({ success: true, state });

    const snapshot = createCollectibleProgressSnapshot(state, COLLECTIBLES);
    expect(restoreCollectibleProgressSnapshot(JSON.parse(JSON.stringify(snapshot)), COLLECTIBLES))
      .toEqual({ success: true, state });
    expect(restoreCollectibleSaveFields({ salvage: [signal.id] }, COLLECTIBLES).success).toBe(false);
    expect(restoreCollectibleSaveFields({ salvage: [salvage.id, salvage.id] }, COLLECTIBLES).success).toBe(false);
    expect(restoreCollectibleSaveFields({ revealed: ['not-real'] }, COLLECTIBLES).success).toBe(false);
    expect(restoreCollectibleSaveFields({ mystery: [] }, COLLECTIBLES).success).toBe(false);
  });
});
