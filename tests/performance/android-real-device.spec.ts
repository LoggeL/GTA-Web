import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  chromium,
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';

import { VEHICLE_SPAWN } from '../../src/game/city';
import {
  calculateTransitionWindows,
  evaluatePhysicalAcceptanceGates,
  evaluateReleaseIdentity,
  failedGateLabels,
  MINIMUM_PHYSICAL_DURATION_SECONDS,
  VERIFIED_ANDROID_RELEASE,
  type BooleanGate,
  type ReleaseFileEvidence,
} from './android-performance-evidence';
import {
  forwardChromeDevtools,
  inspectAndroidDevice,
  launchChrome,
  type AndroidDeviceConnection,
} from './android-device';
import {
  ADAPTATION_WARMUP_MILLISECONDS,
  areAdjacentCells,
  average,
  collectAdjacentTravelTelemetry,
  maximum,
  percentile,
  readRuntimeDiagnostics,
  type PerformanceWindow,
} from './runtime-performance-support';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_RELEASE_URL = `${VERIFIED_ANDROID_RELEASE.baseUrl}?qa=1`;

const configuredDuration = Number(process.env.HEATLINE_ANDROID_SECONDS ?? '120');
if (!Number.isFinite(configuredDuration) || configuredDuration < 10) {
  throw new Error('HEATLINE_ANDROID_SECONDS must be a finite number of at least 10.');
}
const durationSeconds = configuredDuration;

function slug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\w.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .toLowerCase();
}

async function connectToAndroidChrome(endpoint: string): Promise<Browser> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await chromium.connectOverCDP(endpoint, { timeout: 3_000 });
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw new Error(
    'Chrome did not expose chrome_devtools_remote. Complete Chrome onboarding, unlock the device, and keep Chrome visible.',
    { cause: lastError },
  );
}

function createRunUrl(configuredUrl: string, runId: string): string {
  const configured = new URL(configuredUrl);
  const verified = new URL(VERIFIED_ANDROID_RELEASE.baseUrl);
  if (
    configured.origin !== verified.origin
    || configured.pathname !== verified.pathname
    || configured.searchParams.get('qa') !== '1'
  ) {
    throw new Error(
      `Physical release evidence must run ${VERIFIED_ANDROID_RELEASE.baseUrl} with qa=1.`,
    );
  }
  configured.searchParams.set('androidRun', runId);
  return configured.toString();
}

async function readVerifiedReleaseFiles(page: Page): Promise<readonly ReleaseFileEvidence[]> {
  return page.evaluate(async ({ baseUrl, paths }) => {
    const toHex = (bytes: ArrayBuffer): string =>
      [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
    return Promise.all(paths.map(async (path) => {
      const response = await fetch(new URL(path, baseUrl), { cache: 'no-store' });
      const body = await response.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', body);
      return {
        path,
        ok: response.ok,
        status: response.status,
        bytes: body.byteLength,
        sha256: toHex(digest),
      };
    }));
  }, {
    baseUrl: VERIFIED_ANDROID_RELEASE.baseUrl,
    paths: Object.keys(VERIFIED_ANDROID_RELEASE.files),
  });
}

interface ErrorCapture {
  settleAndStop(): Promise<{
    readonly page: readonly string[];
    readonly console: readonly string[];
    readonly requests: readonly string[];
  }>;
}

function installErrorCapture(page: Page): ErrorCapture {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const requestFailures: string[] = [];
  const onPageError = (error: Error): void => {
    pageErrors.push(error.stack ?? error.message);
  };
  const onConsole = (message: { type(): string; text(): string }): void => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  };
  const onRequestFailed = (request: {
    method(): string;
    url(): string;
    failure(): { errorText: string } | null;
  }): void => {
    requestFailures.push(
      `${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'unknown failure'}`,
    );
  };
  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  page.on('requestfailed', onRequestFailed);

  return {
    settleAndStop: async () => {
      await page.waitForTimeout(750);
      page.off('pageerror', onPageError);
      page.off('console', onConsole);
      page.off('requestfailed', onRequestFailed);
      return {
        page: [...pageErrors],
        console: [...consoleErrors],
        requests: [...requestFailures],
      };
    },
  };
}

async function prepareFreshOrigin(page: Page, url: string): Promise<void> {
  if (process.env.HEATLINE_ANDROID_CLEAR_ORIGIN !== '1') return;
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Storage.clearDataForOrigin', {
      origin: new URL(url).origin,
      storageTypes: 'all',
    });
  } finally {
    await session.detach();
  }
}

async function startFreshGame(
  page: Page,
  url: string,
  onClaimSlot: (slot: number) => void,
): Promise<number> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Enter Solara' })).toBeVisible();
  await page.getByRole('button', { name: 'Enter Solara' }).click();
  await page.getByRole('navigation', { name: 'Main menu' })
    .getByRole('button', { name: 'Play' })
    .click();
  await expect(page.getByRole('heading', { level: 2, name: 'Choose a save' })).toBeVisible();

  for (const slot of [1, 2, 3] as const) {
    const card = page.locator(`[data-save-list] article[data-slot="${slot}"]`);
    const newGame = card.getByRole('button', { name: /^New game/u });
    if (!(await newGame.isVisible())) continue;
    onClaimSlot(slot);
    await newGame.click();
    await expect(page.getByRole('heading', { level: 2, name: 'Choose Alex' })).toBeVisible();
    await page.getByRole('button', { name: /^Masculine Alex/u }).click();
    await expect(page.getByLabel('Game HUD')).toBeVisible({ timeout: 75_000 });
    return slot;
  }

  throw new Error(
    'No empty save slot is available. Use a dedicated test profile or rerun with '
    + 'HEATLINE_ANDROID_CLEAR_ORIGIN=1 to erase only HEATLINE site data.',
  );
}

async function deleteCreatedSave(page: Page, slot: number, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Enter Solara' }).click();
  await page.getByRole('navigation', { name: 'Main menu' })
    .getByRole('button', { name: 'Play' })
    .click();
  const card = page.locator(`[data-save-list] article[data-slot="${slot}"]`);
  const status = await card.getAttribute('data-save-status');
  if (status === 'empty') return;
  await expect(card).toHaveAttribute(
    'data-save-status',
    /^(?:ready|recovered|corrupt|unsupported-version)$/u,
  );
  page.once('dialog', (dialog) => dialog.accept());
  await card.getByRole('button', { name: `Delete save slot ${slot}` }).click();
  await expect(card).toHaveAttribute('data-save-status', 'empty');
}

async function enterVehicleWithTouch(page: Page): Promise<{
  readonly stick: Locator;
  readonly pointer: {
    readonly pointerId: number;
    readonly pointerType: 'touch';
    readonly clientX: number;
    readonly clientY: number;
  };
}> {
  await page.waitForFunction(() => Boolean((window as PerformanceWindow).__HEATLINE_QA__));
  await page.evaluate(
    ({ x, z }) => (window as PerformanceWindow).__HEATLINE_QA__?.teleport(x, z),
    { x: VEHICLE_SPAWN.x, z: VEHICLE_SPAWN.z },
  );
  const controls = page.locator('[data-touch-layout]');
  await expect(controls).toHaveAttribute('data-touch-layout', 'on-foot');
  const interact = controls.locator('[data-touch-action="interact"]');
  await interact.dispatchEvent('pointerdown', { pointerId: 41, pointerType: 'touch' });
  await expect(page.getByLabel('3D game world')).toHaveAttribute('data-player-mode', 'vehicle');
  await interact.dispatchEvent('pointerup', { pointerId: 41, pointerType: 'touch' });
  await expect(controls).toHaveAttribute('data-touch-layout', 'vehicle');
  await page.evaluate(
    ({ x, z }) => (window as PerformanceWindow).__HEATLINE_QA__?.face(x, z),
    { x: VEHICLE_SPAWN.x, z: VEHICLE_SPAWN.z + 300 },
  );

  const stick = controls.getByRole('group', { name: 'Steering and throttle stick' });
  const bounds = await stick.boundingBox();
  if (!bounds) throw new Error('The vehicle touch stick has no visible bounds.');
  return {
    stick,
    pointer: {
      pointerId: 42,
      pointerType: 'touch',
      clientX: bounds.x + bounds.width / 2,
      clientY: bounds.y + bounds.height * 0.18,
    },
  };
}

async function collectEvidence(
  page: Page,
  connection: AndroidDeviceConnection,
  slot: number,
  measuredUrl: string,
  releaseFiles: readonly ReleaseFileEvidence[],
  errorCapture: ErrorCapture,
) {
  const beforeWarmup = await readRuntimeDiagnostics(page);
  const { stick, pointer } = await enterVehicleWithTouch(page);
  await page.waitForTimeout(ADAPTATION_WARMUP_MILLISECONDS);
  const afterWarmup = await readRuntimeDiagnostics(page);

  await stick.dispatchEvent('pointerdown', pointer);
  let telemetry;
  try {
    await expect.poll(() => page.evaluate(
      () => (window as PerformanceWindow).__HEATLINE_QA__?.snapshot()?.speedMetersPerSecond ?? 0,
    ), {
      timeout: 5_000,
      message: 'The physical vehicle touch throttle did not produce forward motion.',
    }).toBeGreaterThan(0.4);
    telemetry = await collectAdjacentTravelTelemetry(page, durationSeconds * 1_000);
  } finally {
    await stick.dispatchEvent('pointerup', pointer).catch(() => undefined);
  }
  const afterCourse = await readRuntimeDiagnostics(page);
  const errors = await errorCapture.settleAndStop();
  const averageMilliseconds = average(telemetry.frames);
  const p50Milliseconds = percentile(telemetry.frames, 0.5);
  const p95Milliseconds = percentile(telemetry.frames, 0.95);
  const p99Milliseconds = percentile(telemetry.frames, 0.99);
  const maximumMilliseconds = telemetry.frames.length > 0
    ? Math.max(...telemetry.frames)
    : 0;
  const estimatedFramesPerSecond = averageMilliseconds > 0 ? 1_000 / averageMilliseconds : 0;
  const transitionWindows = calculateTransitionWindows(
    telemetry.frameTimeline,
    telemetry.transitions,
  );
  const maximumTransition = transitionWindows.length > 0
    ? Math.max(...transitionWindows.map(({ maximumFrameMilliseconds }) =>
      maximumFrameMilliseconds))
    : 0;
  const trafficViolations = telemetry.samples.filter(
    ({ activeTraffic, trafficLimit }) => activeTraffic > trafficLimit,
  ).length;
  const pedestrianViolations = telemetry.samples.filter(
    ({ activePedestrians, pedestrianLimit }) => activePedestrians > pedestrianLimit,
  ).length;
  const visibilityState = await page.evaluate(() => document.visibilityState);
  const touchLayout = await page.locator('[data-touch-layout]').getAttribute('data-touch-layout');
  const releaseGates = evaluateReleaseIdentity(releaseFiles);

  const runnerGates: BooleanGate[] = [
    {
      label: 'verified v1.0.0 release bytes',
      passed: releaseGates.every(({ passed }) => passed),
      actual: failedGateLabels(releaseGates),
      expected: 'all immutable file hashes match',
    },
    {
      label: 'page remained visible',
      passed: visibilityState === 'visible',
      actual: visibilityState,
      expected: 'visible',
    },
    {
      label: 'landscape viewport',
      passed: afterCourse.viewport.width > afterCourse.viewport.height,
      actual: afterCourse.viewport,
      expected: 'width greater than height',
    },
    {
      label: 'real mobile touch layout',
      passed: await page.locator('[data-touch-layout="vehicle"]').isVisible(),
      actual: touchLayout,
      expected: 'visible vehicle layout',
    },
    {
      label: 'frame samples',
      passed: telemetry.frames.length > 0,
      actual: telemetry.frames.length,
      expected: 'at least one',
    },
    {
      label: 'ordinary adjacent transition',
      passed: telemetry.transitions.length > 0
        && telemetry.transitions.every(({ fromCell, toCell }) =>
          areAdjacentCells(fromCell, toCell)),
      actual: telemetry.transitions,
      expected: 'at least one, all adjacent',
    },
    {
      label: 'traffic pool',
      passed: trafficViolations === 0,
      actual: trafficViolations,
      expected: 'zero limit violations',
    },
    {
      label: 'pedestrian pool',
      passed: pedestrianViolations === 0,
      actual: pedestrianViolations,
      expected: 'zero limit violations',
    },
    {
      label: 'bounded world audio voices',
      passed: maximum(telemetry.samples, 'worldVoices') === 5,
      actual: maximum(telemetry.samples, 'worldVoices'),
      expected: 'exactly 5',
    },
    {
      label: 'page errors',
      passed: errors.page.length === 0,
      actual: errors.page,
      expected: 'none',
    },
    {
      label: 'console errors',
      passed: errors.console.length === 0,
      actual: errors.console,
      expected: 'none',
    },
    {
      label: 'request failures',
      passed: errors.requests.length === 0,
      actual: errors.requests,
      expected: 'none',
    },
  ];
  const acceptanceGates = evaluatePhysicalAcceptanceGates({
    emulatorSignals: connection.evidence.emulatorSignals,
    reviewedProfile: connection.reviewedProfile,
    durationSeconds,
    webglVersion: afterCourse.webglVersion,
    debugRendererInfoAvailable: afterCourse.debugRendererInfoAvailable,
    softwareRenderer: afterCourse.softwareRenderer,
    unmaskedRenderer: afterCourse.unmaskedRenderer,
    estimatedFramesPerSecond,
    averageMilliseconds,
    p95Milliseconds,
    transitionWindows,
    lifecycle: telemetry.lifecycle,
    releaseGates,
  });
  const runnerFailures = failedGateLabels(runnerGates);
  const acceptanceFailures = failedGateLabels([...runnerGates, ...acceptanceGates]);
  const measuredAt = new Date().toISOString();

  return {
    schemaVersion: 1,
    measuredAt,
    release: {
      tag: VERIFIED_ANDROID_RELEASE.tag,
      sourceSha: VERIFIED_ANDROID_RELEASE.sourceSha,
      url: measuredUrl,
      files: releaseFiles,
    },
    mode: connection.emulatorMode
      ? 'emulator-infrastructure-validation'
      : 'physical-mid-range-acceptance',
    acceptanceEligible: !connection.emulatorMode
      && connection.reviewedProfile !== null
      && releaseGates.every(({ passed }) => passed),
    runnerValidationPassed: runnerFailures.length === 0,
    passed: !connection.emulatorMode && acceptanceFailures.length === 0,
    runnerFailures,
    acceptanceFailures,
    device: connection.evidence,
    deviceClassification: connection.reviewedProfile
      ? {
        profileId: connection.reviewedProfile.id,
        classificationBasis: connection.reviewedProfile.classificationBasis,
      }
      : null,
    browser: {
      ...connection.browser,
      userAgent: afterCourse.userAgent,
      visibilityState,
    },
    course: {
      saveSlot: slot,
      usedTouchThrottle: true,
      warmupMilliseconds: ADAPTATION_WARMUP_MILLISECONDS,
      durationSeconds,
      elapsedMilliseconds: Number(telemetry.elapsedMilliseconds.toFixed(2)),
      frames: telemetry.frames.length,
      estimatedFramesPerSecond: Number(estimatedFramesPerSecond.toFixed(2)),
      averageMilliseconds: Number(averageMilliseconds.toFixed(2)),
      p50Milliseconds: Number(p50Milliseconds.toFixed(2)),
      p95Milliseconds: Number(p95Milliseconds.toFixed(2)),
      p99Milliseconds: Number(p99Milliseconds.toFixed(2)),
      maximumMilliseconds: Number(maximumMilliseconds.toFixed(2)),
      ordinaryCellTransitions: telemetry.transitions.length,
      maximumTransitionWindowFrameMilliseconds: Number(maximumTransition.toFixed(2)),
      visitedCells: telemetry.visitedCells,
      transitions: telemetry.transitions,
      transitionWindows,
      lifecycle: telemetry.lifecycle,
    },
    runtime: {
      poolMaximums: {
        residentCells: maximum(telemetry.samples, 'residentCells'),
        collisions: maximum(telemetry.samples, 'activeCollisions'),
        traffic: maximum(telemetry.samples, 'activeTraffic'),
        pedestrians: maximum(telemetry.samples, 'activePedestrians'),
        worldVoices: maximum(telemetry.samples, 'worldVoices'),
        speedMetersPerSecond: maximum(telemetry.samples, 'speedMetersPerSecond'),
      },
      startPosition: telemetry.samples[0]
        ? { x: telemetry.samples[0].playerX, z: telemetry.samples[0].playerZ }
        : null,
      endPosition: telemetry.samples.at(-1)
        ? {
          x: telemetry.samples.at(-1)!.playerX,
          z: telemetry.samples.at(-1)!.playerZ,
        }
        : null,
      trafficViolations,
      pedestrianViolations,
      heapSamplesAvailable: telemetry.samples.filter(({ heapBytes }) => heapBytes !== null).length,
    },
    diagnostics: { beforeWarmup, afterWarmup, afterCourse },
    gates: { runner: runnerGates, acceptance: acceptanceGates },
    errors,
  };
}

test('records physical Android 30 FPS release evidence', async ({ browserName: _browserName }, testInfo) => {
  test.setTimeout((durationSeconds + ADAPTATION_WARMUP_MILLISECONDS / 1_000 + 120) * 1_000);
  const configuredUrl = process.env.HEATLINE_ANDROID_URL?.trim() || DEFAULT_RELEASE_URL;
  const runUrl = createRunUrl(configuredUrl, randomUUID());
  const connection = await inspectAndroidDevice();
  if (!connection.emulatorMode && durationSeconds < MINIMUM_PHYSICAL_DURATION_SECONDS) {
    throw new Error(
      `Physical acceptance requires at least ${MINIMUM_PHYSICAL_DURATION_SECONDS} seconds; `
      + `received ${durationSeconds}.`,
    );
  }
  await launchChrome(connection);
  const forward = await forwardChromeDevtools(connection);
  let page: Page | undefined;
  let createdSlot: number | undefined;

  try {
    const browser = await connectToAndroidChrome(`http://127.0.0.1:${forward.port}`);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Android Chrome exposed no default browser context.');
    page = await test.step('create runner-owned Android Chrome tab', () => context.newPage());
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(60_000);
    const errorCapture = installErrorCapture(page);
    await test.step('open verified release URL', () =>
      page!.goto(runUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }));
    await page.bringToFront();
    await expect.poll(() => page!.evaluate(() => document.visibilityState), {
      timeout: 15_000,
      message: 'Keep Chrome visible and the Android device unlocked.',
    }).toBe('visible');
    await expect.poll(() => page!.evaluate(() => innerWidth > innerHeight), {
      timeout: 15_000,
      message: 'Rotate the Android device to landscape before measuring.',
    }).toBe(true);

    const releaseFiles = await test.step('hash immutable v1.0.0 release files', () =>
      readVerifiedReleaseFiles(page!));
    await test.step('prepare dedicated HEATLINE origin state', () =>
      prepareFreshOrigin(page!, runUrl));
    createdSlot = await test.step('start a fresh temporary save slot', () =>
      startFreshGame(page!, runUrl, (slot) => {
        createdSlot = slot;
      }));
    const evidence = await test.step('measure touch driving and collect evidence', () =>
      collectEvidence(
        page!,
        connection,
        createdSlot!,
        runUrl,
        releaseFiles,
        errorCapture,
      ));
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    await writeFile(testInfo.outputPath('android-performance-evidence.json'), serialized, 'utf8');
    await test.step('delete only the runner-created save slot', () =>
      deleteCreatedSave(page!, createdSlot!, runUrl));
    createdSlot = undefined;
    await testInfo.attach('android-performance-evidence.json', {
      body: serialized,
      contentType: 'application/json',
    });
    testInfo.annotations.push({
      type: connection.emulatorMode ? 'infrastructure-only' : 'physical-performance',
      description: JSON.stringify({
        model: connection.evidence.model,
        passed: evidence.passed,
        fps: evidence.course.estimatedFramesPerSecond,
        p95Milliseconds: evidence.course.p95Milliseconds,
        renderer: evidence.diagnostics.afterCourse.unmaskedRenderer,
      }),
    });

    expect(evidence.runnerFailures, 'Android runner infrastructure gates').toEqual([]);
    if (!connection.emulatorMode) {
      expect(evidence.acceptanceFailures, 'Physical Android 30 FPS acceptance gates').toEqual([]);
      const date = evidence.measuredAt.slice(0, 10);
      const fileName = `${date}-${slug(connection.evidence.model)}-${slug(evidence.release.tag)}.json`;
      const evidenceDirectory = join(PROJECT_ROOT, 'evidence', 'performance', 'android');
      await mkdir(evidenceDirectory, { recursive: true });
      const evidencePath = join(evidenceDirectory, fileName);
      await writeFile(evidencePath, serialized, 'utf8');
      const sha256 = createHash('sha256').update(serialized).digest('hex');
      await testInfo.attach('android-performance-evidence.sha256.txt', {
        body: `${sha256}  ${fileName}\n`,
        contentType: 'text/plain',
      });
    }
  } finally {
    if (page) {
      if (createdSlot !== undefined) {
        await Promise.race([
          deleteCreatedSave(page, createdSlot, runUrl).catch(() => undefined),
          delay(20_000),
        ]);
      }
      await Promise.race([
        page.close().catch(() => undefined),
        delay(2_000),
      ]);
    }
    await forward.remove();
  }
});
