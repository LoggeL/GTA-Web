import { Group } from 'three';
import { describe, expect, it } from 'vitest';

import {
  PoliceResponseVisual,
  type PoliceVisualLevel,
} from '../../src/game/PoliceResponseVisual';

const DISABLED_SNAPSHOT = {
  level: 0,
  officers: false,
  cruisers: false,
  roadblock: false,
  tacticalVan: false,
  helicopter: false,
  spotlight: false,
} as const;

describe('PoliceResponseVisual disabled adapter', () => {
  it('allocates no response actors, geometry, materials, or collisions', () => {
    const visual = new PoliceResponseVisual();

    expect(visual.root.name).toBe('police-response-disabled');
    expect(visual.root.visible).toBe(false);
    expect(visual.root.children).toEqual([]);
    expect(visual.collisions).toEqual([]);
    expect(Object.isFrozen(visual.collisions)).toBe(true);
    expect(visual.snapshot()).toEqual(DISABLED_SNAPSHOT);
    expect(Object.isFrozen(visual.snapshot())).toBe(true);

    visual.dispose();
  });

  it('stays inert across every wanted level, phase, and world transition input', () => {
    const visual = new PoliceResponseVisual();
    const firstSnapshot = visual.snapshot();
    const firstCollisions = visual.collisions;
    const phases = ['clear', 'investigating', 'pursuit', 'search'] as const;

    for (let level = 0; level <= 5; level += 1) {
      visual.update({
        playerPosition: { x: level * 17, y: level, z: -level * 23 },
        level: level as PoliceVisualLevel,
        phase: phases[level % phases.length] ?? 'clear',
        elapsedSeconds: level * 10,
        reducedMotion: level % 2 === 0,
        responsePlan: null,
        navigationGraph: null,
        renderableCellIds: new Set(),
        groundHeightAt: () => 99,
      });

      expect(visual.root.visible).toBe(false);
      expect(visual.root.children).toHaveLength(0);
      expect(visual.snapshot()).toBe(firstSnapshot);
      expect(visual.snapshot()).toEqual(DISABLED_SNAPSHOT);
      expect(visual.collisions).toBe(firstCollisions);
      expect(visual.collisions).toHaveLength(0);
    }

    visual.dispose();
  });

  it('detaches its inert root cleanly without creating disposal resources', () => {
    const scene = new Group();
    const visual = new PoliceResponseVisual();
    scene.add(visual.root);

    expect(scene.children).toContain(visual.root);
    visual.dispose();
    expect(scene.children).not.toContain(visual.root);
    expect(visual.root.visible).toBe(false);
    expect(visual.root.children).toHaveLength(0);
  });
});
