import { describe, expect, it } from 'vitest';

import { PoliceResponseVisual } from '../../src/game/PoliceResponseVisual';
import { cellIdAt } from '../../src/navigation/cells';
import type { RoadGraph } from '../../src/navigation/types';
import { PoliceResponseDirector } from '../../src/systems/policeResponse';

const LINE_GRAPH: RoadGraph = {
  nodes: [
    {
      id: 'line:a',
      position: { x: 30, z: -20 },
      district: 'arroyo-heights',
      roadIds: ['line'],
    },
    {
      id: 'line:b',
      position: { x: 50, z: -20 },
      district: 'arroyo-heights',
      roadIds: ['line'],
    },
    {
      id: 'line:c',
      position: { x: 70, z: -20 },
      district: 'arroyo-heights',
      roadIds: ['line'],
    },
  ],
  edges: [
    {
      id: 'line:ab',
      fromNodeId: 'line:a',
      toNodeId: 'line:b',
      roadId: 'line',
      distanceMeters: 20,
      major: false,
    },
    {
      id: 'line:bc',
      fromNodeId: 'line:b',
      toNodeId: 'line:c',
      roadId: 'line',
      distanceMeters: 20,
      major: false,
    },
  ],
};

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
    expect(visual.root.position.toArray()).toEqual([0, 0, 0]);
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
    const anchored = visual.collisions.map((collision) => ({ ...collision }));
    expect(anchored).toEqual([
      {
        id: 'police-roadblock-barrier-1',
        minX: 35.900000000000006,
        maxX: 38.5,
        minZ: -50.21,
        maxZ: -49.79,
        height: 0.71,
        kind: 'solid',
      },
      {
        id: 'police-roadblock-barrier-2',
        minX: 38.7,
        maxX: 41.3,
        minZ: -50.21,
        maxZ: -49.79,
        height: 0.71,
        kind: 'solid',
      },
      {
        id: 'police-roadblock-barrier-3',
        minX: 41.5,
        maxX: 44.099999999999994,
        minZ: -50.21,
        maxZ: -49.79,
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
    expect(visual.collisions).toEqual(anchored);
    expect(visual.root.position.toArray()).toEqual([0, 0, 0]);

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
      groundHeightAt: () => 2.5,
    });
    const anchored = visual.collisions.map((collision) => ({ ...collision }));
    expect(anchored).toHaveLength(3);
    expect(visual.root.getObjectByName('police-roadblock')?.position.y).toBe(2.5);
    expect(anchored.every((collision) => collision.height === 3.21)).toBe(true);
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
      groundHeightAt: () => 2.5,
    });
    expect(visual.collisions).toEqual(anchored);
    visual.dispose();
  });

  it('only exposes collisions for the one planned roadblock that is actually rendered', () => {
    const director = new PoliceResponseDirector('visible-roadblock-only');
    const plan = director.tick(0, 5, 'pursuit', {
      suspectPosition: { x: 0, z: 0 },
      lastKnownPosition: { x: 0, z: 0 },
      suspectVisible: true,
      roadblockCandidates: [
        { id: 'north', position: { x: 0, z: -92 }, heading: 0 },
        { id: 'east', position: { x: 92, z: 0 }, heading: Math.PI / 2 },
        { id: 'south', position: { x: 0, z: 92 }, heading: Math.PI },
      ],
    });
    expect(plan.roadblocks).toHaveLength(3);
    const visual = new PoliceResponseVisual();
    visual.update({
      playerPosition: { x: 0, y: 0, z: 0 },
      level: 5,
      phase: 'pursuit',
      elapsedSeconds: 1,
      reducedMotion: false,
      responsePlan: plan,
    });

    const visibleRoadblockId = plan.roadblocks[0]?.id;
    expect(visual.collisions).toHaveLength(3);
    expect(visual.collisions.every((collision) =>
      collision.id?.startsWith(`police-roadblock-${visibleRoadblockId}-`),
    )).toBe(true);
    visual.dispose();
  });

  it('moves a planned helicopter at a bounded world-space speed when the suspect moves', () => {
    const director = new PoliceResponseDirector('bounded-planned-helicopter');
    const visual = new PoliceResponseVisual();
    const initialPlan = director.tick(0, 5, 'pursuit', {
      suspectPosition: { x: 0, z: 0 },
      lastKnownPosition: { x: 0, z: 0 },
      suspectVisible: true,
    });
    visual.update({
      playerPosition: { x: 0, y: 0, z: 0 },
      level: 5,
      phase: 'pursuit',
      elapsedSeconds: 1,
      reducedMotion: false,
      responsePlan: initialPlan,
    });
    const helicopter = visual.root.getObjectByName('police-helicopter')!;
    const start = helicopter.position.clone();

    const movedPlan = director.tick(0.1, 5, 'pursuit', {
      suspectPosition: { x: 100, z: 0 },
      lastKnownPosition: { x: 100, z: 0 },
      suspectVisible: true,
    });
    visual.update({
      playerPosition: { x: 100, y: 0, z: 0 },
      level: 5,
      phase: 'pursuit',
      elapsedSeconds: 1.1,
      reducedMotion: false,
      responsePlan: movedPlan,
    });

    expect(helicopter.position.distanceTo(start)).toBeGreaterThan(0);
    expect(helicopter.position.distanceTo(start)).toBeLessThanOrEqual(2.21);
    expect(helicopter.position.distanceTo(start)).toBeLessThan(
      movedPlan.helicopter.position.x - initialPlan.helicopter.position.x,
    );
    expect(visual.root.position.toArray()).toEqual([0, 0, 0]);
    visual.dispose();
  });

  it('moves ground units through road-graph nodes at bounded speeds instead of inheriting player motion', () => {
    const visual = new PoliceResponseVisual();
    const groundHeightAt = (x: number): number => x / 100;
    visual.update({
      playerPosition: { x: 40, y: 9, z: -20 },
      level: 5,
      phase: 'pursuit',
      elapsedSeconds: 1,
      reducedMotion: false,
      navigationGraph: LINE_GRAPH,
      groundHeightAt,
    });

    const officers = visual.root.getObjectByName('police-foot-patrols');
    const cruisers = visual.root.getObjectByName('police-cruisers');
    const tacticalVan = visual.root.getObjectByName('police-tactical-van');
    const helicopter = visual.root.getObjectByName('police-helicopter');
    expect(officers).toBeDefined();
    expect(cruisers).toBeDefined();
    expect(tacticalVan).toBeDefined();
    expect(helicopter).toBeDefined();
    const officerStart = officers!.position.clone();
    const cruiserStart = cruisers!.position.clone();
    const helicopterStart = helicopter!.position.clone();
    expect(officerStart.y).toBeCloseTo(groundHeightAt(officerStart.x), 6);
    expect(cruiserStart.y).toBeCloseTo(groundHeightAt(cruiserStart.x), 6);

    visual.update({
      playerPosition: { x: 80, y: 17, z: -20 },
      level: 5,
      phase: 'pursuit',
      elapsedSeconds: 1.1,
      reducedMotion: false,
      navigationGraph: LINE_GRAPH,
      groundHeightAt,
    });

    const officerMovement = officers!.position.distanceTo(officerStart);
    const cruiserMovement = cruisers!.position.distanceTo(cruiserStart);
    const helicopterMovement = helicopter!.position.distanceTo(helicopterStart);
    expect(officerMovement).toBeGreaterThan(0);
    expect(officerMovement).toBeLessThanOrEqual(0.53);
    expect(cruiserMovement).toBeGreaterThan(0);
    expect(cruiserMovement).toBeLessThanOrEqual(1.61);
    expect(helicopterMovement).toBeGreaterThan(0);
    expect(helicopterMovement).toBeLessThanOrEqual(2.21);
    expect(officers!.position.x - officerStart.x).not.toBeCloseTo(40, 3);
    expect(cruisers!.position.x - cruiserStart.x).not.toBeCloseTo(40, 3);
    expect(helicopter!.position.x - helicopterStart.x).not.toBeCloseTo(40, 3);
    expect(officers!.position.y).toBeCloseTo(groundHeightAt(officers!.position.x), 6);
    expect(visual.root.position.toArray()).toEqual([0, 0, 0]);
    visual.dispose();
  });

  it('reanchors streamed responses on navigable ground after a district teleport and resets across interiors', () => {
    const graph: RoadGraph = {
      nodes: [
        {
          id: 'near:a',
          position: { x: 40, z: 40 },
          district: 'arroyo-heights',
          roadIds: ['near'],
        },
        {
          id: 'near:b',
          position: { x: 80, z: 40 },
          district: 'arroyo-heights',
          roadIds: ['near'],
        },
        {
          id: 'far:a',
          position: { x: 520, z: 40 },
          district: 'breakwater',
          roadIds: ['far'],
        },
        {
          id: 'far:b',
          position: { x: 560, z: 40 },
          district: 'breakwater',
          roadIds: ['far'],
        },
      ],
      edges: [
        {
          id: 'near:edge',
          fromNodeId: 'near:a',
          toNodeId: 'near:b',
          roadId: 'near',
          distanceMeters: 40,
          major: false,
        },
        {
          id: 'far:edge',
          fromNodeId: 'far:a',
          toNodeId: 'far:b',
          roadId: 'far',
          distanceMeters: 40,
          major: true,
        },
      ],
    };
    const nearCells = new Set([cellIdAt({ x: 40, z: 40 })]);
    const farCells = new Set([cellIdAt({ x: 520, z: 40 })]);
    const groundHeightAt = (x: number): number => x >= 500 ? 2.5 : 0.25;
    const visual = new PoliceResponseVisual();

    visual.update({
      playerPosition: { x: 60, y: 0, z: 60 },
      level: 4,
      phase: 'pursuit',
      elapsedSeconds: 1,
      reducedMotion: false,
      navigationGraph: graph,
      renderableCellIds: nearCells,
      groundHeightAt,
    });
    const officers = visual.root.getObjectByName('police-foot-patrols')!;
    expect(cellIdAt(officers.position)).toBe(cellIdAt({ x: 40, z: 40 }));
    expect(officers.position.y).toBe(0.25);

    visual.update({
      playerPosition: { x: 540, y: 14, z: 60 },
      level: 4,
      phase: 'search',
      elapsedSeconds: 1.1,
      reducedMotion: true,
      navigationGraph: graph,
      renderableCellIds: farCells,
      groundHeightAt,
    });
    expect(cellIdAt(officers.position)).toBe(cellIdAt({ x: 520, z: 40 }));
    expect(officers.position.y).toBe(2.5);
    expect(officers.visible).toBe(true);
    expect(visual.root.position.toArray()).toEqual([0, 0, 0]);

    visual.update({
      playerPosition: { x: 540, y: 14, z: 60 },
      level: 0,
      phase: 'clear',
      elapsedSeconds: 1.2,
      reducedMotion: true,
      navigationGraph: graph,
      renderableCellIds: farCells,
      groundHeightAt,
    });
    expect(visual.root.visible).toBe(false);
    expect(officers.visible).toBe(false);

    visual.update({
      playerPosition: { x: 540, y: 14, z: 60 },
      level: 4,
      phase: 'search',
      elapsedSeconds: 1.3,
      reducedMotion: true,
      navigationGraph: graph,
      renderableCellIds: farCells,
      groundHeightAt,
    });
    expect(officers.visible).toBe(true);
    expect(cellIdAt(officers.position)).toBe(cellIdAt({ x: 520, z: 40 }));
    expect(officers.position.y).toBe(2.5);
    visual.dispose();
  });
});
