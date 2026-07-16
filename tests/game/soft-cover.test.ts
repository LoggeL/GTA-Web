import { describe, expect, it } from 'vitest';

import { resolveSoftCover } from '../../src/game/softCover';
import type { SoftCoverSurface } from '../../src/game/softCover';

const highWall: SoftCoverSurface = {
  id: 'high-wall', minX: -5, maxX: 5, minZ: -0.5, maxZ: 0.5, heightMeters: 1.6,
};

describe('soft cover geometry', () => {
  it('uses crouch near ordinary collision geometry without snapping the player', () => {
    const result = resolveSoftCover({
      position: { x: 0, z: -1 }, surfaces: [highWall], crouching: true,
      aiming: false, shoulder: 'right', threatDirection: { x: 0, z: 1 },
    });
    expect(result).toMatchObject({
      engaged: true,
      coverId: highWall.id,
      coverHeight: 'high',
      peeking: false,
      exposure: 0.1,
      positionCorrection: null,
    });
    expect(result.distanceMeters).toBeCloseTo(0.5);
    expect(result.normal).toEqual({ x: 0, z: -1 });
  });

  it('does not engage while standing or when cover is out of reach', () => {
    expect(resolveSoftCover({
      position: { x: 0, z: -1 }, surfaces: [highWall], crouching: false,
      aiming: false, shoulder: 'right',
    }).engaged).toBe(false);
    expect(resolveSoftCover({
      position: { x: 0, z: -3 }, surfaces: [highWall], crouching: true,
      aiming: false, shoulder: 'right',
    }).engaged).toBe(false);
  });

  it('increases exposure while aiming and exposes fully to an uncovered flank', () => {
    const aimed = resolveSoftCover({
      position: { x: 0, z: -1 }, surfaces: [highWall], crouching: true,
      aiming: true, shoulder: 'right', threatDirection: { x: 0, z: 1 },
    });
    expect(aimed.exposure).toBe(0.34);

    const flanked = resolveSoftCover({
      position: { x: 0, z: -1 }, surfaces: [highWall], crouching: true,
      aiming: false, shoulder: 'right', threatDirection: { x: 0, z: -1 },
    });
    expect(flanked.engaged).toBe(true);
    expect(flanked.incomingDamageMultiplier).toBe(1);
  });

  it('requires shoulder-corner alignment for a deliberate corner peek', () => {
    const matching = resolveSoftCover({
      position: { x: -4.7, z: -1 }, surfaces: [highWall], crouching: true,
      aiming: true, shoulder: 'left', requestPeek: true, threatDirection: { x: 0, z: 1 },
    });
    expect(matching).toMatchObject({ corner: 'left', peeking: true, exposure: 0.62 });

    const swapped = resolveSoftCover({
      position: { x: -4.7, z: -1 }, surfaces: [highWall], crouching: true,
      aiming: true, shoulder: 'right', requestPeek: true, threatDirection: { x: 0, z: 1 },
    });
    expect(swapped).toMatchObject({ corner: 'left', peeking: false, exposure: 0.34 });
  });

  it('distinguishes low cover and picks the nearest eligible surface deterministically', () => {
    const lowBarrier: SoftCoverSurface = {
      id: 'low-barrier', minX: -2, maxX: 2, minZ: -0.4, maxZ: 0.4, heightMeters: 0.85,
    };
    const farWall: SoftCoverSurface = {
      id: 'far-wall', minX: -2, maxX: 2, minZ: 0.7, maxZ: 1, heightMeters: 1.5,
    };
    const result = resolveSoftCover({
      position: { x: 0, z: -0.9 }, surfaces: [farWall, lowBarrier], crouching: true,
      aiming: false, shoulder: 'right', threatDirection: { x: 0, z: 1 },
    });
    expect(result).toMatchObject({ coverId: lowBarrier.id, coverHeight: 'low', exposure: 0.28 });
  });
});
