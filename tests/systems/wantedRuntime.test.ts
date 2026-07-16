import { describe, expect, it } from 'vitest';

import type { ItemDefinition } from '../../src/data/types';
import type { RoadblockCandidate } from '../../src/systems/policeResponse';
import {
  WantedRuntime,
  searchRadiusForLevel,
  type WitnessReportInput,
  type WantedRuntimeSnapshot,
} from '../../src/systems/wantedRuntime';

const POSITION = { x: 10, z: 20 } as const;
const ROADBLOCKS: readonly RoadblockCandidate[] = [
  { id: 'north', position: { x: 10, z: 90 }, heading: 0 },
  { id: 'east', position: { x: 100, z: 20 }, heading: Math.PI / 2 },
  { id: 'south', position: { x: 10, z: -100 }, heading: Math.PI },
];

const PEDESTRIAN_REPORT: WitnessReportInput = {
  crimeId: 'crime-0001',
  witnessId: 'pedestrian-03',
  source: 'pedestrian',
  severity: 1,
  confidence: 1,
  suspectIdentified: false,
  position: POSITION,
};

const ITEMS: readonly ItemDefinition[] = [
  {
    id: 'contraband', name: 'Bonds', description: '', category: 'contraband',
    shape: { width: 1, height: 1 }, weightKg: 0.1, maximumStack: 5,
    baseValue: 100, hasDurability: false, discardable: true,
  },
  {
    id: 'quest', name: 'Ledger', description: '', category: 'quest',
    shape: { width: 1, height: 1 }, weightKg: 0, maximumStack: 1,
    baseValue: 0, hasDurability: false, discardable: false,
  },
];

describe('wanted runtime', () => {
  it('restores the compact core-save state and rebuilds the response deployment', () => {
    const runtime = new WantedRuntime({ seed: 'compact-restore', modifiers: { nerve: 2 } });
    const restored = runtime.restoreState({
      level: 3,
      phase: 'search',
      heat: 60,
      searchSecondsRemaining: 18,
    }, { x: 12, z: -8 }, [
      { id: 'safe-edge', position: { x: 90, z: -8 }, heading: Math.PI / 2 },
    ]);
    expect(restored.state).toEqual({
      level: 3,
      phase: 'search',
      heat: 60,
      searchSecondsRemaining: 18,
    });
    expect(restored.searchCenter).toEqual({ x: 12, z: -8 });
    expect(restored.police.roadblocks).toHaveLength(1);
  });

  it('starts with no response and only gains heat after a delivered witness report', () => {
    const runtime = new WantedRuntime({ seed: 'witness-flow', modifiers: { nerve: 1 } });
    expect(runtime.getSnapshot()).toEqual(expect.objectContaining({
      state: expect.objectContaining({ level: 0, phase: 'clear', heat: 0 }),
      searchRadius: 0,
    }));

    const reported = runtime.reportWitness(PEDESTRIAN_REPORT);
    expect(reported).toEqual(expect.objectContaining({
      accepted: true,
      heatAdded: 10,
      previousLevel: 0,
      state: expect.objectContaining({ level: 1, phase: 'investigating' }),
    }));
    expect(runtime.getSnapshot().police.capabilities).toEqual(['foot-patrols']);
  });

  it('deduplicates reports and promotes an investigation when police identify Alex', () => {
    const runtime = new WantedRuntime({ seed: 'dedupe', modifiers: { nerve: 1 } });
    runtime.reportWitness(PEDESTRIAN_REPORT);
    const duplicate = runtime.reportWitness(PEDESTRIAN_REPORT);
    expect(duplicate).toEqual(expect.objectContaining({
      accepted: false,
      reason: 'duplicate',
      state: expect.objectContaining({ heat: 10 }),
    }));

    runtime.reportWitness({
      ...PEDESTRIAN_REPORT,
      witnessId: 'officer-1',
      source: 'police',
      confidence: 0,
      suspectIdentified: false,
    });
    const snapshot = runtime.getSnapshot();
    expect(snapshot.state.phase).toBe('pursuit');
    expect(snapshot.lastKnownPosition).toEqual(POSITION);
    expect(snapshot.processedWitnessReports).toHaveLength(2);
  });

  it('exposes all five authored escalation levels, roadblocks, and tactical helicopter', () => {
    const runtime = new WantedRuntime({ seed: 'level-ladder', modifiers: { nerve: 1 } });
    const requiredCapability = {
      1: 'foot-patrols',
      2: 'cruisers',
      3: 'roadblocks',
      4: 'tactical-vans',
      5: 'helicopter-spotlight',
    } as const;

    for (const level of [1, 2, 3, 4, 5] as const) {
      const snapshot = runtime.escalate(level, POSITION, true, ROADBLOCKS);
      expect(snapshot.state.level).toBe(level);
      expect(snapshot.state.phase).toBe('pursuit');
      expect(snapshot.police.capabilities).toContain(requiredCapability[level]);
      expect(snapshot.searchRadius).toBe(searchRadiusForLevel(level));
    }

    const levelFive = runtime.getSnapshot();
    expect(levelFive.police.roadblocks).toHaveLength(3);
    expect(levelFive.police.roadblocks.every((roadblock) => roadblock.reinforced)).toBe(true);
    expect(levelFive.police.helicopter).toEqual(expect.objectContaining({
      active: true,
      mode: 'track',
      spotlight: 'tracking',
    }));
    expect(levelFive.police.capabilities).not.toContain('military');
  });

  it('switches from pursuit to bounded search and clears only while unseen', () => {
    const runtime = new WantedRuntime({ seed: 'search', modifiers: { nerve: 1 } });
    runtime.escalate(3, POSITION, true, ROADBLOCKS);

    const searching = runtime.tick(1, {
      playerPosition: POSITION,
      visibleToPolice: false,
      roadblockCandidates: ROADBLOCKS,
    });
    expect(searching.state).toEqual(expect.objectContaining({
      level: 3,
      phase: 'search',
      searchSecondsRemaining: 44,
    }));

    const reacquired = runtime.tick(10, {
      playerPosition: { x: 15, z: 25 },
      visibleToPolice: true,
      roadblockCandidates: ROADBLOCKS,
    });
    expect(reacquired.state).toEqual(expect.objectContaining({
      phase: 'pursuit',
      searchSecondsRemaining: 45,
    }));

    runtime.tick(0, {
      playerPosition: { x: 15, z: 25 },
      visibleToPolice: false,
      roadblockCandidates: ROADBLOCKS,
    });
    const cleared = runtime.tick(30, {
      playerPosition: { x: 500, z: 500 },
      visibleToPolice: false,
      roadblockCandidates: ROADBLOCKS,
    });
    expect(cleared.state).toEqual({
      level: 0, phase: 'clear', heat: 0, searchSecondsRemaining: 0,
    });
    expect(cleared.police.roadblocks).toEqual([]);
    expect(cleared.police.helicopter.active).toBe(false);
  });

  it('restores a deterministic pursuit snapshot and returns defensive copies', () => {
    const original = new WantedRuntime({ seed: 'restore-runtime', modifiers: { nerve: 2 } });
    original.reportWitness({
      ...PEDESTRIAN_REPORT,
      severity: 5,
      suspectIdentified: true,
    });
    original.escalate(5, POSITION, true, ROADBLOCKS);
    original.tick(2, {
      playerPosition: POSITION,
      visibleToPolice: true,
      roadblockCandidates: ROADBLOCKS,
    });
    const serialized = JSON.parse(JSON.stringify(original.getSnapshot())) as WantedRuntimeSnapshot;
    const restored = WantedRuntime.fromSnapshot(serialized);

    serialized.state.heat = 0;
    serialized.police.roadblocks[0]!.position.x = 999;
    expect(restored.getSnapshot().state.heat).toBeGreaterThan(0);
    expect(restored.getSnapshot().police.roadblocks[0]?.position.x).not.toBe(999);

    const nextTick = {
      playerPosition: { x: 200, z: 200 },
      visibleToPolice: false,
      roadblockCandidates: ROADBLOCKS,
    } as const;
    expect(restored.tick(1.5, nextTick)).toEqual(original.tick(1.5, nextTick));
  });

  it.each(['death', 'arrest'] as const)('applies the %s loss and atomically clears heat', (outcome) => {
    const runtime = new WantedRuntime({ seed: outcome, modifiers: { nerve: 1 } });
    runtime.escalate(4, POSITION, true, ROADBLOCKS);
    const result = runtime.resolveDefeat({
      cash: 1_234,
      inventory: {
        gridWidth: 2,
        gridHeight: 1,
        maxWeightKg: 10,
        items: [
          { instanceId: 'bonds', definitionId: 'contraband', quantity: 3, durability: 100, x: 0, y: 0, rotated: false },
          { instanceId: 'ledger', definitionId: 'quest', quantity: 1, durability: 100, x: 1, y: 0, rotated: false },
        ],
      },
    }, ITEMS, outcome);

    expect(result).toEqual(expect.objectContaining({
      cash: 1_111,
      cashLost: 123,
      contrabandRemoved: 3,
      respawn: outcome === 'death' ? 'clinic' : 'station',
      wanted: { level: 0, phase: 'clear', heat: 0, searchSecondsRemaining: 0 },
    }));
    expect(result.inventory.items.map((item) => item.definitionId)).toEqual(['quest']);
    expect(runtime.getSnapshot().state.level).toBe(0);
  });

  it('rejects corrupt snapshots and malformed reports', () => {
    const runtime = new WantedRuntime({ modifiers: { nerve: 1 } });
    const invalid = runtime.getSnapshot();
    invalid.state.level = 5;
    expect(() => WantedRuntime.fromSnapshot(invalid)).toThrow(RangeError);
    expect(() => runtime.reportWitness({
      ...PEDESTRIAN_REPORT,
      confidence: 2,
    })).toThrow(RangeError);
    expect(() => runtime.tick(Number.NaN, {
      playerPosition: POSITION,
      visibleToPolice: false,
    })).toThrow(RangeError);
  });
});
