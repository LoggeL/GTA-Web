import { describe, expect, it } from 'vitest';

import {
  PoliceResponseDirector,
  policeUnitQuotasForLevel,
  roadblockCountForLevel,
  type RoadblockCandidate,
} from '../../src/systems/policeResponse';

const CANDIDATES: readonly RoadblockCandidate[] = [
  { id: 'road-north', position: { x: 0, z: 70 }, heading: 0 },
  { id: 'road-east', position: { x: 92, z: 0 }, heading: Math.PI / 2 },
  { id: 'road-south', position: { x: 0, z: -118 }, heading: Math.PI },
  { id: 'road-west', position: { x: -160, z: 0 }, heading: -Math.PI / 2 },
];

const CONTEXT = {
  suspectPosition: { x: 4, z: 6 },
  lastKnownPosition: { x: 0, z: 0 },
  suspectVisible: true,
  roadblockCandidates: CANDIDATES,
} as const;

describe('police response director', () => {
  it('maps all five wanted levels to cumulative non-military response budgets', () => {
    expect(policeUnitQuotasForLevel(1)).toEqual(expect.objectContaining({
      footPatrols: 2,
      armedOfficers: 0,
      cruisers: 0,
    }));
    expect(policeUnitQuotasForLevel(2)).toEqual(expect.objectContaining({
      armedOfficers: 4,
      cruisers: 2,
    }));
    expect(policeUnitQuotasForLevel(3)).toEqual(expect.objectContaining({
      flankCars: 2,
    }));
    expect(policeUnitQuotasForLevel(4)).toEqual(expect.objectContaining({
      tacticalVans: 2,
      armoredHeavies: 2,
      marksmen: 2,
    }));
    expect(policeUnitQuotasForLevel(5)).toEqual(expect.objectContaining({
      tacticalVans: 3,
      armoredHeavies: 3,
      marksmen: 4,
    }));
    expect([0, 0, 0, 1, 2, 3]).toEqual(
      ([0, 1, 2, 3, 4, 5] as const).map(roadblockCountForLevel),
    );
  });

  it('deploys stable roadblocks at level three and reinforces them by level five', () => {
    const director = new PoliceResponseDirector('roadblock-seed');
    const levelThree = director.tick(0, 3, 'pursuit', CONTEXT);
    expect(levelThree.roadblocks).toHaveLength(1);
    expect(levelThree.roadblocks[0]).toEqual(expect.objectContaining({
      tireStrip: true,
      reinforced: false,
    }));
    const repeated = director.tick(1, 3, 'pursuit', CONTEXT);
    expect(repeated.roadblocks).toEqual(levelThree.roadblocks);

    const levelFive = director.tick(0, 5, 'pursuit', CONTEXT);
    expect(levelFive.roadblocks).toHaveLength(3);
    expect(levelFive.roadblocks.every((roadblock) => roadblock.reinforced)).toBe(true);
    expect(new Set(levelFive.roadblocks.map((roadblock) => roadblock.anchorId)).size).toBe(3);
    expect(levelFive.capabilities).toEqual(expect.arrayContaining([
      'helicopter-spotlight',
      'reinforced-roadblocks',
      'aggressive-vehicle-tactics',
    ]));
    const withoutFreshGraphCandidates = director.tick(1, 5, 'pursuit', {
      suspectPosition: CONTEXT.suspectPosition,
      lastKnownPosition: CONTEXT.lastKnownPosition,
      suspectVisible: true,
    });
    expect(withoutFreshGraphCandidates.roadblocks).toEqual(levelFive.roadblocks);
  });

  it('tracks visible suspects and sweeps the last-known area during search', () => {
    const director = new PoliceResponseDirector('helicopter-seed');
    const tracking = director.tick(1, 5, 'pursuit', CONTEXT);
    expect(tracking.helicopter).toEqual(expect.objectContaining({
      active: true,
      mode: 'track',
      spotlight: 'tracking',
      target: CONTEXT.suspectPosition,
    }));

    const searching = director.tick(2, 5, 'search', {
      ...CONTEXT,
      suspectPosition: { x: 500, z: 500 },
      suspectVisible: false,
    });
    expect(searching.helicopter.mode).toBe('search');
    expect(searching.helicopter.spotlight).toBe('sweeping');
    expect(searching.helicopter.target).toEqual(CONTEXT.lastKnownPosition);
    expect(searching.helicopter.orbitRadians).toBeGreaterThan(tracking.helicopter.orbitRadians);

    const lowerLevel = director.tick(0, 4, 'search', CONTEXT);
    expect(lowerLevel.helicopter).toEqual(expect.objectContaining({
      active: false,
      mode: 'inactive',
      spotlight: 'off',
    }));
  });

  it('continues deterministically after JSON snapshot restore', () => {
    const original = new PoliceResponseDirector('restore-seed');
    original.tick(3, 5, 'pursuit', CONTEXT);
    const serialized = JSON.parse(JSON.stringify(original.getSnapshot())) as ReturnType<typeof original.getSnapshot>;
    const restored = PoliceResponseDirector.fromSnapshot(serialized);

    const nextContext = {
      ...CONTEXT,
      suspectPosition: { x: 12, z: -9 },
      lastKnownPosition: { x: 8, z: -5 },
      suspectVisible: false,
    };
    expect(restored.tick(1.25, 5, 'search', nextContext)).toEqual(
      original.tick(1.25, 5, 'search', nextContext),
    );
  });

  it('clears deployments and rejects inconsistent restored snapshots', () => {
    const director = new PoliceResponseDirector('clear-seed');
    director.tick(0, 5, 'pursuit', CONTEXT);
    expect(director.clear()).toEqual(expect.objectContaining({
      level: 0,
      phase: 'clear',
      roadblocks: [],
    }));

    const invalid = director.getSnapshot();
    invalid.level = 5;
    expect(() => PoliceResponseDirector.fromSnapshot(invalid)).toThrow(RangeError);
    const invalidUnits = director.getSnapshot();
    invalidUnits.units.cruisers = 999;
    expect(() => PoliceResponseDirector.fromSnapshot(invalidUnits)).toThrow(RangeError);
    expect(() => director.tick(-1, 0, 'clear', CONTEXT)).toThrow(RangeError);
  });
});
