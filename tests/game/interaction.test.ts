import { describe, expect, it } from 'vitest';

import type { CollisionRect } from '../../src/game/city';
import { findNearestInteractionTarget } from '../../src/game/interaction';

describe('nearest interaction targeting', () => {
  it('selects the nearest enabled visible target with deterministic ties', () => {
    const result = findNearestInteractionTarget({
      origin: { x: 0, y: 0, z: 0 },
      heading: 0,
      maximumDistance: 6,
      candidates: [
        { id: 'z-far', kind: 'world', position: { x: 0, y: 0, z: -5 }, prompt: 'Far' },
        { id: 'b-near', kind: 'vehicle', position: { x: 0.5, y: 0, z: -3 }, prompt: 'Near' },
        { id: 'a-disabled', kind: 'world', position: { x: 0, y: 0, z: -1 }, prompt: 'No', enabled: false },
      ],
    });
    expect(result?.id).toBe('b-near');
    expect(result?.distanceMeters).toBeCloseTo(Math.hypot(0.5, 3));
  });

  it('rejects targets well behind the player or hidden by a solid obstacle', () => {
    const wall: CollisionRect = { minX: -1, maxX: 1, minZ: -2, maxZ: -1, height: 4 };
    expect(findNearestInteractionTarget({
      origin: { x: 0, y: 0, z: 0 },
      heading: 0,
      maximumDistance: 6,
      collisions: [wall],
      candidates: [{ id: 'blocked', kind: 'world', position: { x: 0, y: 0, z: -4 }, prompt: 'Blocked' }],
    })).toBeNull();
    expect(findNearestInteractionTarget({
      origin: { x: 0, y: 0, z: 0 },
      heading: 0,
      maximumDistance: 6,
      candidates: [{ id: 'behind', kind: 'world', position: { x: 0, y: 0, z: 4 }, prompt: 'Behind' }],
    })).toBeNull();
  });

  it('accounts for target radius when measuring interaction reach', () => {
    const result = findNearestInteractionTarget({
      origin: { x: 0, y: 0, z: 0 },
      heading: 0,
      maximumDistance: 5,
      candidates: [{
        id: 'large-vehicle', kind: 'vehicle', position: { x: 0, y: 0, z: -6 }, radius: 1.5, prompt: 'Drive',
      }],
    });
    expect(result?.distanceMeters).toBe(4.5);
  });
});
