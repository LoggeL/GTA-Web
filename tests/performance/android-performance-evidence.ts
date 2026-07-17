import type {
  CellTransitionTiming,
  FrameTiming,
  RuntimeLifecycleEvent,
} from './runtime-performance-support';

export interface BooleanGate {
  readonly label: string;
  readonly passed: boolean;
  readonly actual: unknown;
  readonly expected: string;
}

export interface ReviewedMidrangeProfile {
  readonly id: string;
  readonly manufacturer: RegExp;
  readonly model: RegExp;
  readonly device: RegExp;
  readonly classificationBasis: string;
}

export interface AndroidHardwareIdentity {
  readonly manufacturer: string;
  readonly model: string;
  readonly device: string;
  readonly socModel: string;
}

export interface ReleaseFileEvidence {
  readonly path: string;
  readonly ok: boolean;
  readonly status: number;
  readonly bytes: number;
  readonly sha256: string;
}

export interface TransitionWindowEvidence {
  readonly fromCell: string;
  readonly toCell: string;
  readonly atMilliseconds: number;
  readonly windowStartMilliseconds: number;
  readonly windowEndMilliseconds: number;
  readonly frameCount: number;
  readonly firstFrameAtMilliseconds: number | null;
  readonly lastFrameAtMilliseconds: number | null;
  readonly coversRequestedWindow: boolean;
  readonly maximumFrameMilliseconds: number;
}

export const VERIFIED_ANDROID_RELEASE = Object.freeze({
  tag: 'v1.0.0',
  sourceSha: '32a3aa9b619c52f4a7c15db4e1ec9225de490ce9',
  baseUrl: 'https://loggel.github.io/GTA-Web/',
  files: Object.freeze({
    'index.html': 'e1ca538089019bbf01eb1cc0bd2f63f34a285195cf9534194450b331d7bd8812',
    'assets/index-DIZf55Ac.js': 'd89ea8f74bd69d65faa5d6b820a12532c5fb809860b4dc97a060911a891c14cc',
    'assets/three-DUbjvPP5.js': '16abdc44475b161425f8e8a51a007d4f9790061c975744b981b75de2fc087ade',
    'assets/index-cuUGOPjv.css': 'd6388f2cada2daf0476bf55ad5ad30b1ca11e1273cbeb190da19c0cea6aaac25',
    'assets/splash/heatline-splash.webp':
      '183224d775ea65250899d85a9bca63f1e92296bdc3d93d3865429a98775cdad3',
    'assets/social/heatline-solara-social.jpg':
      '7f0fba175d0c9c5ad49a049d4812a20bbe6a077488b7d7bc75bd33091c5e6faa',
  }),
});

export const REVIEWED_MIDRANGE_PROFILES: readonly ReviewedMidrangeProfile[] = Object.freeze([
  {
    id: 'google-pixel-6a',
    manufacturer: /^Google$/iu,
    model: /^Pixel 6a$/u,
    device: /^bluejay$/u,
    classificationBasis: 'Google Pixel A-series mid-range handset; exact Pixel 6a/bluejay identity.',
  },
  {
    id: 'google-pixel-7a',
    manufacturer: /^Google$/iu,
    model: /^Pixel 7a$/u,
    device: /^lynx$/u,
    classificationBasis: 'Google Pixel A-series mid-range handset; exact Pixel 7a/lynx identity.',
  },
  {
    id: 'samsung-galaxy-a34-5g',
    manufacturer: /^samsung$/iu,
    model: /^SM-A346[A-Z0-9]*$/u,
    device: /^a34x/u,
    classificationBasis: 'Samsung Galaxy A3x mid-range family; exact SM-A346/a34x identity.',
  },
  {
    id: 'samsung-galaxy-a53-5g',
    manufacturer: /^samsung$/iu,
    model: /^SM-A536[A-Z0-9]*$/u,
    device: /^a53x/u,
    classificationBasis: 'Samsung Galaxy A5x mid-range family; exact SM-A536/a53x identity.',
  },
  {
    id: 'samsung-galaxy-a54-5g',
    manufacturer: /^samsung$/iu,
    model: /^SM-A546[A-Z0-9]*$/u,
    device: /^a54x/u,
    classificationBasis: 'Samsung Galaxy A5x mid-range family; exact SM-A546/a54x identity.',
  },
]);

export const MINIMUM_PHYSICAL_DURATION_SECONDS = 120;
export const MINIMUM_HARDWARE_FPS = 30;
export const MAXIMUM_AVERAGE_FRAME_MILLISECONDS = 1_000 / 30;
export const MAXIMUM_P95_FRAME_MILLISECONDS = 40;
export const MAXIMUM_TRANSITION_FRAME_MILLISECONDS = 250;
export const TRANSITION_WINDOW_BEFORE_MILLISECONDS = 500;
export const TRANSITION_WINDOW_AFTER_MILLISECONDS = 500;
export const TRANSITION_WINDOW_EDGE_TOLERANCE_MILLISECONDS = 50;

export function matchReviewedMidrangeProfile(
  identity: AndroidHardwareIdentity,
): ReviewedMidrangeProfile | null {
  return REVIEWED_MIDRANGE_PROFILES.find((profile) =>
    profile.manufacturer.test(identity.manufacturer)
    && profile.model.test(identity.model)
    && profile.device.test(identity.device)) ?? null;
}

export function failedGateLabels(gates: readonly BooleanGate[]): readonly string[] {
  return gates.filter(({ passed }) => !passed).map(
    ({ label, actual, expected }) => `${label}: got ${JSON.stringify(actual)}; expected ${expected}`,
  );
}

export function evaluateReleaseIdentity(
  actualFiles: readonly ReleaseFileEvidence[],
): readonly BooleanGate[] {
  const actualByPath = new Map(actualFiles.map((file) => [file.path, file]));
  return Object.entries(VERIFIED_ANDROID_RELEASE.files).map(([path, expectedHash]) => {
    const actual = actualByPath.get(path);
    return {
      label: `verified release file ${path}`,
      passed: actual?.ok === true && actual.sha256 === expectedHash,
      actual: actual ?? null,
      expected: `HTTP success and SHA-256 ${expectedHash}`,
    };
  });
}

export function calculateTransitionWindows(
  frames: readonly FrameTiming[],
  transitions: readonly CellTransitionTiming[],
): readonly TransitionWindowEvidence[] {
  return transitions.map((transition) => {
    const windowStartMilliseconds =
      transition.atMilliseconds - TRANSITION_WINDOW_BEFORE_MILLISECONDS;
    const windowEndMilliseconds =
      transition.atMilliseconds + TRANSITION_WINDOW_AFTER_MILLISECONDS;
    const windowFrames = frames.filter(({ atMilliseconds }) =>
      atMilliseconds >= windowStartMilliseconds && atMilliseconds <= windowEndMilliseconds);
    const firstFrameAtMilliseconds = windowFrames[0]?.atMilliseconds ?? null;
    const lastFrameAtMilliseconds = windowFrames.at(-1)?.atMilliseconds ?? null;
    const coversRequestedWindow = firstFrameAtMilliseconds !== null
      && lastFrameAtMilliseconds !== null
      && firstFrameAtMilliseconds
        <= windowStartMilliseconds + TRANSITION_WINDOW_EDGE_TOLERANCE_MILLISECONDS
      && lastFrameAtMilliseconds
        >= windowEndMilliseconds - TRANSITION_WINDOW_EDGE_TOLERANCE_MILLISECONDS;
    return {
      fromCell: transition.fromCell,
      toCell: transition.toCell,
      atMilliseconds: transition.atMilliseconds,
      windowStartMilliseconds,
      windowEndMilliseconds,
      frameCount: windowFrames.length,
      firstFrameAtMilliseconds,
      lastFrameAtMilliseconds,
      coversRequestedWindow,
      maximumFrameMilliseconds: windowFrames.length > 0
        ? Math.max(...windowFrames.map(({ frameMilliseconds }) => frameMilliseconds))
        : 0,
    };
  });
}

export function evaluatePhysicalAcceptanceGates(input: {
  readonly emulatorSignals: readonly string[];
  readonly reviewedProfile: ReviewedMidrangeProfile | null;
  readonly durationSeconds: number;
  readonly webglVersion: number;
  readonly debugRendererInfoAvailable: boolean;
  readonly softwareRenderer: boolean;
  readonly unmaskedRenderer: string;
  readonly estimatedFramesPerSecond: number;
  readonly averageMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly transitionWindows: readonly TransitionWindowEvidence[];
  readonly lifecycle: readonly RuntimeLifecycleEvent[];
  readonly releaseGates: readonly BooleanGate[];
}): readonly BooleanGate[] {
  const lifecycleVisible = input.lifecycle.length >= 2
    && input.lifecycle.every(({ visibilityState }) => visibilityState === 'visible');
  const lifecycleFocused = input.lifecycle.length >= 2
    && input.lifecycle.every(({ focused }) => focused);
  const lifecycleLandscape = input.lifecycle.length >= 2
    && input.lifecycle.every(({ viewport }) => viewport.width > viewport.height);
  const transitionFrames = input.transitionWindows.map(
    ({ maximumFrameMilliseconds }) => maximumFrameMilliseconds,
  );
  const transitionWindowsComplete = input.transitionWindows.length > 0
    && input.transitionWindows.every(({ frameCount, coversRequestedWindow }) =>
      frameCount > 0 && coversRequestedWindow);

  return [
    ...input.releaseGates,
    {
      label: 'physical device attestation',
      passed: input.emulatorSignals.length === 0,
      actual: input.emulatorSignals,
      expected: 'no emulator signals',
    },
    {
      label: 'reviewed representative mid-range profile',
      passed: input.reviewedProfile !== null,
      actual: input.reviewedProfile?.id ?? null,
      expected: 'a reviewed model/device profile',
    },
    {
      label: 'physical measurement duration',
      passed: input.durationSeconds >= MINIMUM_PHYSICAL_DURATION_SECONDS,
      actual: input.durationSeconds,
      expected: `at least ${MINIMUM_PHYSICAL_DURATION_SECONDS} seconds`,
    },
    {
      label: 'WebGL2',
      passed: input.webglVersion === 2,
      actual: input.webglVersion,
      expected: '2',
    },
    {
      label: 'debug renderer evidence',
      passed: input.debugRendererInfoAvailable,
      actual: input.debugRendererInfoAvailable,
      expected: 'true',
    },
    {
      label: 'hardware renderer',
      passed: !input.softwareRenderer && input.unmaskedRenderer.trim().length > 0,
      actual: input.unmaskedRenderer,
      expected: 'named non-software renderer',
    },
    {
      label: '30 FPS hardware target',
      passed: input.estimatedFramesPerSecond >= MINIMUM_HARDWARE_FPS,
      actual: Number(input.estimatedFramesPerSecond.toFixed(2)),
      expected: `at least ${MINIMUM_HARDWARE_FPS.toFixed(1)} FPS`,
    },
    {
      label: 'average frame budget',
      passed: input.averageMilliseconds <= MAXIMUM_AVERAGE_FRAME_MILLISECONDS,
      actual: Number(input.averageMilliseconds.toFixed(2)),
      expected: `at most ${MAXIMUM_AVERAGE_FRAME_MILLISECONDS.toFixed(2)} ms`,
    },
    {
      label: 'p95 frame budget',
      passed: input.p95Milliseconds <= MAXIMUM_P95_FRAME_MILLISECONDS,
      actual: Number(input.p95Milliseconds.toFixed(2)),
      expected: `at most ${MAXIMUM_P95_FRAME_MILLISECONDS} ms`,
    },
    {
      label: 'ordinary transition windows',
      passed: transitionWindowsComplete
        && transitionFrames.every((frameMilliseconds) =>
          frameMilliseconds < MAXIMUM_TRANSITION_FRAME_MILLISECONDS),
      actual: input.transitionWindows,
      expected: `at least one fully covered window and every maximum below ${MAXIMUM_TRANSITION_FRAME_MILLISECONDS} ms`,
    },
    {
      label: 'measurement remained visible',
      passed: lifecycleVisible,
      actual: input.lifecycle,
      expected: 'all lifecycle records visible',
    },
    {
      label: 'measurement remained focused',
      passed: lifecycleFocused,
      actual: input.lifecycle,
      expected: 'all lifecycle records focused',
    },
    {
      label: 'measurement remained landscape',
      passed: lifecycleLandscape,
      actual: input.lifecycle,
      expected: 'all lifecycle records landscape',
    },
  ];
}
