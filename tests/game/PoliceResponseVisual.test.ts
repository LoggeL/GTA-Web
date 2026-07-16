import { describe, expect, it } from 'vitest';

import { PoliceResponseVisual } from '../../src/game/PoliceResponseVisual';
import { PoliceResponseDirector } from '../../src/systems/policeResponse';

describe('PoliceResponseVisual', () => {
  it('reveals the authored response ladder without a military tier', () => {
    const visual = new PoliceResponseVisual();
    const playerPosition = { x: 40, y: 0, z: -20 };

    visual.update({ playerPosition, level: 1, phase: 'investigating', elapsedSeconds: 1, reducedMotion: false });
    expect(visual.snapshot()).toEqual({
      level: 1,
      officers: true,
      cruisers: false,
      roadblock: false,
      tacticalVan: false,
      helicopter: false,
      spotlight: false,
    });

    visual.update({ playerPosition, level: 3, phase: 'pursuit', elapsedSeconds: 2, reducedMotion: false });
    expect(visual.snapshot()).toEqual(expect.objectContaining({
      level: 3,
      cruisers: true,
      roadblock: true,
      tacticalVan: false,
      helicopter: false,
    }));

    visual.update({ playerPosition, level: 5, phase: 'search', elapsedSeconds: 3, reducedMotion: false });
    expect(visual.snapshot()).toEqual(expect.objectContaining({
      level: 5,
      tacticalVan: true,
      helicopter: true,
      spotlight: true,
    }));
    expect(visual.root.position.toArray()).toEqual([40, 0, -20]);
    visual.dispose();
  });

  it('hides the entire response at zero heat and accepts reduced motion', () => {
    const visual = new PoliceResponseVisual();
    visual.update({
      playerPosition: { x: 0, y: 0, z: 0 },
      level: 5,
      phase: 'pursuit',
      elapsedSeconds: 10,
      reducedMotion: true,
    });
    expect(visual.root.visible).toBe(true);

    visual.update({
      playerPosition: { x: 0, y: 0, z: 0 },
      level: 0,
      phase: 'clear',
      elapsedSeconds: 11,
      reducedMotion: true,
    });
    expect(visual.root.visible).toBe(false);
    expect(visual.snapshot().level).toBe(0);
    visual.dispose();
  });

  it('exposes deterministic world-space blockers only while roadblocks are visible', () => {
    const visual = new PoliceResponseVisual();

    visual.update({
      playerPosition: { x: 40, y: 0, z: -20 },
      level: 2,
      phase: 'pursuit',
      elapsedSeconds: 1,
      reducedMotion: false,
    });
    expect(visual.collisions).toEqual([]);

    visual.update({
      playerPosition: { x: 40, y: 0, z: -20 },
      level: 3,
      phase: 'pursuit',
      elapsedSeconds: 2,
      reducedMotion: false,
    });
    expect(visual.collisions).toEqual([
      {
        id: 'police-roadblock-barrier-1',
        minX: 35.900000000000006,
        maxX: 38.5,
        minZ: -40.21,
        maxZ: -39.79,
        height: 0.71,
        kind: 'solid',
      },
      {
        id: 'police-roadblock-barrier-2',
        minX: 38.7,
        maxX: 41.3,
        minZ: -40.21,
        maxZ: -39.79,
        height: 0.71,
        kind: 'solid',
      },
      {
        id: 'police-roadblock-barrier-3',
        minX: 41.5,
        maxX: 44.099999999999994,
        minZ: -40.21,
        maxZ: -39.79,
        height: 0.71,
        kind: 'solid',
      },
    ]);

    visual.update({
      playerPosition: { x: -12, y: 0, z: 18 },
      level: 3,
      phase: 'search',
      elapsedSeconds: 3,
      reducedMotion: true,
    });
    expect(visual.collisions).toHaveLength(3);
    expect(visual.collisions[1]).toEqual(expect.objectContaining({
      minX: -13.3,
      maxX: -10.7,
      minZ: -12.21,
      maxZ: -11.79,
    }));

    visual.update({
      playerPosition: { x: -12, y: 0, z: 18 },
      level: 0,
      phase: 'clear',
      elapsedSeconds: 4,
      reducedMotion: true,
    });
    expect(visual.collisions).toEqual([]);
    visual.dispose();
  });

  it('anchors planned roadblocks to the road graph instead of following the player', () => {
    const director = new PoliceResponseDirector('visual-plan');
    const plan = director.tick(0, 3, 'pursuit', {
      suspectPosition: { x: 0, z: 0 },
      lastKnownPosition: { x: 0, z: 0 },
      suspectVisible: true,
      roadblockCandidates: [
        { id: 'east-road', position: { x: 90, z: 0 }, heading: Math.PI / 2 },
      ],
    });
    const visual = new PoliceResponseVisual();
    visual.update({
      playerPosition: { x: 0, y: 0, z: 0 },
      level: 3,
      phase: 'pursuit',
      elapsedSeconds: 1,
      reducedMotion: false,
      responsePlan: plan,
    });
    const anchored = visual.collisions.map((collision) => ({ ...collision }));
    expect(anchored).toHaveLength(3);
    expect(anchored[1]?.minX).toBeCloseTo(89.79, 5);
    expect(anchored[1]?.maxX).toBeCloseTo(90.21, 5);
    expect(anchored[1]?.minZ).toBeCloseTo(-1.3, 5);
    expect(anchored[1]?.maxZ).toBeCloseTo(1.3, 5);

    visual.update({
      playerPosition: { x: 40, y: 0, z: 40 },
      level: 3,
      phase: 'search',
      elapsedSeconds: 2,
      reducedMotion: true,
      responsePlan: plan,
    });
    expect(visual.collisions).toEqual(anchored);
    visual.dispose();
  });
});
