import { describe, expect, it } from 'vitest';

import {
  calculateTransitionWindows,
  evaluatePhysicalAcceptanceGates,
  evaluateReleaseIdentity,
  matchReviewedMidrangeProfile,
  VERIFIED_ANDROID_RELEASE,
  type BooleanGate,
  type ReleaseFileEvidence,
} from './android-performance-evidence';

function passingReleaseFiles(): readonly ReleaseFileEvidence[] {
  return Object.entries(VERIFIED_ANDROID_RELEASE.files).map(([path, sha256]) => ({
    path,
    ok: true,
    status: 200,
    bytes: 1,
    sha256,
  }));
}

function passingReleaseGates(): readonly BooleanGate[] {
  return evaluateReleaseIdentity(passingReleaseFiles());
}

function gateMap(overrides: Partial<Parameters<typeof evaluatePhysicalAcceptanceGates>[0]> = {}) {
  return new Map(evaluatePhysicalAcceptanceGates({
    emulatorSignals: [],
    reviewedProfile: {
      id: 'fixture-midrange',
      manufacturer: /^Fixture$/u,
      model: /^Phone$/u,
      device: /^device$/u,
      classificationBasis: 'test fixture',
    },
    durationSeconds: 120,
    webglVersion: 2,
    debugRendererInfoAvailable: true,
    softwareRenderer: false,
    unmaskedRenderer: 'Adreno 642L',
    estimatedFramesPerSecond: 30,
    averageMilliseconds: 1_000 / 30,
    p95Milliseconds: 40,
    transitionWindows: [{
      fromCell: 'cell:0:0',
      toCell: 'cell:0:1',
      atMilliseconds: 1_000,
      windowStartMilliseconds: 500,
      windowEndMilliseconds: 1_500,
      frameCount: 60,
      firstFrameAtMilliseconds: 500,
      lastFrameAtMilliseconds: 1_500,
      coversRequestedWindow: true,
      maximumFrameMilliseconds: 249.99,
    }],
    lifecycle: [
      {
        reason: 'start',
        atMilliseconds: 0,
        visibilityState: 'visible',
        focused: true,
        viewport: { width: 844, height: 390 },
      },
      {
        reason: 'end',
        atMilliseconds: 120_000,
        visibilityState: 'visible',
        focused: true,
        viewport: { width: 844, height: 390 },
      },
    ],
    releaseGates: passingReleaseGates(),
    ...overrides,
  }).map((gate) => [gate.label, gate]));
}

describe('Android physical performance evidence gates', () => {
  it('attests every immutable release file and rejects a single byte-identity mismatch', () => {
    expect(evaluateReleaseIdentity(passingReleaseFiles()).every(({ passed }) => passed)).toBe(true);
    const mismatched = passingReleaseFiles().map((file, index) =>
      index === 1 ? { ...file, sha256: '0'.repeat(64) } : file);
    const gates = evaluateReleaseIdentity(mismatched);
    expect(gates.filter(({ passed }) => !passed)).toHaveLength(1);
    expect(gates.find(({ passed }) => !passed)?.label).toContain(mismatched[1]!.path);
  });

  it('accepts only reviewed mid-range model/device identities', () => {
    expect(matchReviewedMidrangeProfile({
      manufacturer: 'Google',
      model: 'Pixel 6a',
      device: 'bluejay',
      socModel: 'GS101',
    })?.id).toBe('google-pixel-6a');
    expect(matchReviewedMidrangeProfile({
      manufacturer: 'Google',
      model: 'Pixel 8 Pro',
      device: 'husky',
      socModel: 'Tensor G3',
    })).toBeNull();
  });

  it('uses a one-second transition window rather than only the boundary frame', () => {
    const windows = calculateTransitionWindows([
      { atMilliseconds: 499, frameMilliseconds: 9 },
      { atMilliseconds: 500, frameMilliseconds: 41 },
      { atMilliseconds: 1_000, frameMilliseconds: 17 },
      { atMilliseconds: 1_500, frameMilliseconds: 82 },
      { atMilliseconds: 1_501, frameMilliseconds: 11 },
    ], [{
      fromCell: 'cell:0:0',
      toCell: 'cell:0:1',
      atMilliseconds: 1_000,
      frameMilliseconds: 17,
    }]);
    expect(windows).toMatchObject([{
      windowStartMilliseconds: 500,
      windowEndMilliseconds: 1_500,
      frameCount: 3,
      firstFrameAtMilliseconds: 500,
      lastFrameAtMilliseconds: 1_500,
      coversRequestedWindow: true,
      maximumFrameMilliseconds: 82,
    }]);
  });

  it('passes exact strict boundaries and rejects each weaker proof independently', () => {
    expect([...gateMap().values()].every(({ passed }) => passed)).toBe(true);

    const cases: readonly [
      string,
      Partial<Parameters<typeof evaluatePhysicalAcceptanceGates>[0]>,
    ][] = [
      ['physical device attestation', { emulatorSignals: ['serial'] }],
      ['reviewed representative mid-range profile', { reviewedProfile: null }],
      ['physical measurement duration', { durationSeconds: 119.99 }],
      ['WebGL2', { webglVersion: 1 }],
      ['debug renderer evidence', { debugRendererInfoAvailable: false }],
      ['hardware renderer', { softwareRenderer: true }],
      ['hardware renderer', { unmaskedRenderer: '' }],
      ['30 FPS hardware target', { estimatedFramesPerSecond: 29.99 }],
      ['average frame budget', { averageMilliseconds: 33.34 }],
      ['p95 frame budget', { p95Milliseconds: 40.01 }],
      ['ordinary transition windows', { transitionWindows: [] }],
      ['ordinary transition windows', {
        transitionWindows: [{
          fromCell: 'cell:0:0',
          toCell: 'cell:0:1',
          atMilliseconds: 1_000,
          windowStartMilliseconds: 500,
          windowEndMilliseconds: 1_500,
          frameCount: 60,
          firstFrameAtMilliseconds: 500,
          lastFrameAtMilliseconds: 1_500,
          coversRequestedWindow: true,
          maximumFrameMilliseconds: 250,
        }],
      }],
      ['ordinary transition windows', {
        transitionWindows: [{
          fromCell: 'cell:0:0',
          toCell: 'cell:0:1',
          atMilliseconds: 100,
          windowStartMilliseconds: -400,
          windowEndMilliseconds: 600,
          frameCount: 0,
          firstFrameAtMilliseconds: null,
          lastFrameAtMilliseconds: null,
          coversRequestedWindow: false,
          maximumFrameMilliseconds: 0,
        }],
      }],
      ['ordinary transition windows', {
        transitionWindows: [{
          fromCell: 'cell:0:0',
          toCell: 'cell:0:1',
          atMilliseconds: 100,
          windowStartMilliseconds: -400,
          windowEndMilliseconds: 600,
          frameCount: 35,
          firstFrameAtMilliseconds: 16,
          lastFrameAtMilliseconds: 600,
          coversRequestedWindow: false,
          maximumFrameMilliseconds: 17,
        }],
      }],
      ['ordinary transition windows', {
        transitionWindows: [{
          fromCell: 'cell:0:0',
          toCell: 'cell:0:1',
          atMilliseconds: 119_900,
          windowStartMilliseconds: 119_400,
          windowEndMilliseconds: 120_400,
          frameCount: 35,
          firstFrameAtMilliseconds: 119_400,
          lastFrameAtMilliseconds: 119_984,
          coversRequestedWindow: false,
          maximumFrameMilliseconds: 17,
        }],
      }],
      ['measurement remained visible', {
        lifecycle: [{
          reason: 'start',
          atMilliseconds: 0,
          visibilityState: 'hidden',
          focused: true,
          viewport: { width: 844, height: 390 },
        }, {
          reason: 'end',
          atMilliseconds: 120_000,
          visibilityState: 'visible',
          focused: true,
          viewport: { width: 844, height: 390 },
        }],
      }],
      ['measurement remained focused', {
        lifecycle: [{
          reason: 'start',
          atMilliseconds: 0,
          visibilityState: 'visible',
          focused: false,
          viewport: { width: 844, height: 390 },
        }, {
          reason: 'end',
          atMilliseconds: 120_000,
          visibilityState: 'visible',
          focused: true,
          viewport: { width: 844, height: 390 },
        }],
      }],
      ['measurement remained landscape', {
        lifecycle: [{
          reason: 'start',
          atMilliseconds: 0,
          visibilityState: 'visible',
          focused: true,
          viewport: { width: 390, height: 844 },
        }, {
          reason: 'end',
          atMilliseconds: 120_000,
          visibilityState: 'visible',
          focused: true,
          viewport: { width: 844, height: 390 },
        }],
      }],
    ];

    for (const [label, overrides] of cases) {
      expect(gateMap(overrides).get(label)?.passed, label).toBe(false);
    }
  });
});
