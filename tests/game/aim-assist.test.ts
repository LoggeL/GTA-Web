import { describe, expect, it } from 'vitest';

import { resolveAimAssist } from '../../src/game/aimAssist';
import type { AimAssistTarget } from '../../src/game/aimAssist';

const origin = { x: 0, y: 1.5, z: 0 };
const forward = { x: 0, y: 0, z: -1 };

function targetAtAngle(id: string, angleDegrees: number, distance = 20): AimAssistTarget {
  const angle = angleDegrees * Math.PI / 180;
  return {
    id,
    position: {
      x: Math.sin(angle) * distance,
      y: origin.y,
      z: -Math.cos(angle) * distance,
    },
    radiusMeters: 0.45,
    active: true,
    hostile: true,
    visible: true,
  };
}

describe('desktop and mobile aim assist', () => {
  it('preserves desktop free aim unless optional soft lock is enabled', () => {
    const target = targetAtAngle('target', 3);
    const free = resolveAimAssist({
      device: 'desktop', level: 'high', origin, inputDirection: forward,
      targets: [target], maximumRangeMeters: 60,
    });
    expect(free).toMatchObject({ targetId: null, correctionRadians: 0, strength: 0, snapped: false });
    expect(free.direction).toEqual(forward);

    const assisted = resolveAimAssist({
      device: 'desktop', level: 'high', origin, inputDirection: forward,
      targets: [target], maximumRangeMeters: 60, desktopSoftLockEnabled: true,
    });
    expect(assisted.targetId).toBe(target.id);
    expect(assisted.correctionRadians).toBeGreaterThan(0);
    expect(assisted.strength).toBeLessThan(0.5);
    expect(assisted.snapped).toBe(false);
  });

  it('provides a generous configurable mobile cone and explicit target snap', () => {
    const target = targetAtAngle('mobile-target', 6);
    const snapped = resolveAimAssist({
      device: 'mobile', level: 'high', origin, inputDirection: forward,
      targets: [target], maximumRangeMeters: 60, allowTargetSnap: true,
    });
    expect(snapped).toMatchObject({ targetId: target.id, strength: 1, snapped: true, candidateCount: 1 });
    expect(snapped.correctionRadians).toBeCloseTo(6 * Math.PI / 180, 3);

    const off = resolveAimAssist({
      device: 'mobile', level: 'off', origin, inputDirection: forward,
      targets: [target], maximumRangeMeters: 60, allowTargetSnap: true,
    });
    expect(off).toMatchObject({ targetId: null, strength: 0, snapped: false });
  });

  it('ignores inactive, friendly, occluded, out-of-range, and out-of-cone targets', () => {
    const ignored: AimAssistTarget[] = [
      { ...targetAtAngle('inactive', 1), active: false },
      { ...targetAtAngle('friendly', 1), hostile: false },
      { ...targetAtAngle('occluded', 1), visible: false },
      targetAtAngle('distant', 1, 100),
      targetAtAngle('outside-cone', 30),
    ];
    const result = resolveAimAssist({
      device: 'mobile', level: 'high', origin, inputDirection: forward,
      targets: ignored, maximumRangeMeters: 60, allowTargetSnap: true,
    });
    expect(result).toMatchObject({ targetId: null, candidateCount: 0, correctionRadians: 0 });
  });

  it('uses current-target hysteresis for stable selection', () => {
    const closerToCrosshair = targetAtAngle('new-target', 2.6);
    const current = targetAtAngle('current-target', 3.3);
    const result = resolveAimAssist({
      device: 'mobile', level: 'medium', origin, inputDirection: forward,
      targets: [closerToCrosshair, current], maximumRangeMeters: 60,
      currentTargetId: current.id,
    });
    expect(result.targetId).toBe(current.id);
    expect(result.candidateCount).toBe(2);
  });

  it('leads a moving target using caller-supplied projectile speed', () => {
    const moving: AimAssistTarget = {
      ...targetAtAngle('moving', 0, 30),
      velocity: { x: 6, y: 0, z: 0 },
    };
    const result = resolveAimAssist({
      device: 'mobile', level: 'high', origin, inputDirection: forward,
      targets: [moving], maximumRangeMeters: 60, projectileSpeedMetersPerSecond: 60,
    });
    expect(result.targetId).toBe(moving.id);
    expect(result.predictedTargetPosition?.x).toBeCloseTo(3, 1);
    expect(result.direction.x).toBeGreaterThan(0);
  });
});
