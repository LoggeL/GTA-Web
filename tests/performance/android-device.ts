import { execFile, type ExecFileException } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import {
  matchReviewedMidrangeProfile,
  type ReviewedMidrangeProfile,
} from './android-performance-evidence';

const EMULATOR_MARKERS = [
  'generic',
  'emulator',
  'sdk_gphone',
  'goldfish',
  'ranchu',
  'vbox',
] as const;

const CHROME_PACKAGES = [
  'com.android.chrome',
  'com.chrome.beta',
  'com.chrome.dev',
  'com.chrome.canary',
  'org.chromium.chrome',
] as const;

export interface ListedAndroidDevice {
  readonly serial: string;
  readonly state: string;
  readonly details: string;
}

export interface AndroidDeviceEvidence {
  readonly serialRedacted: true;
  readonly manufacturer: string;
  readonly model: string;
  readonly product: string;
  readonly device: string;
  readonly androidVersion: string;
  readonly sdk: string;
  readonly abi: string;
  readonly hardware: string;
  readonly socModel: string;
  readonly buildFingerprint: string;
  readonly physicalDisplay: string;
  readonly physicalDensity: string;
  readonly refreshRateHz: number | null;
  readonly battery: {
    readonly levelPercent: number | null;
    readonly temperatureCelsius: number | null;
    readonly status: string | null;
  };
  readonly thermalStatus: number | null;
  readonly emulatorSignals: readonly string[];
}

export interface AndroidBrowserEvidence {
  readonly packageName: string;
  readonly versionName: string;
  readonly viewActivity: string;
  readonly launcherActivity: string;
}

export interface AndroidDeviceConnection {
  readonly adbPath: string;
  readonly serial: string;
  readonly evidence: AndroidDeviceEvidence;
  readonly browser: AndroidBrowserEvidence;
  readonly emulatorMode: boolean;
  readonly reviewedProfile: ReviewedMidrangeProfile | null;
}

function execute(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error) {
          reject(new Error(
            `${file} ${args.join(' ')} failed: ${stderr.trim() || error.message}`,
            { cause: error },
          ));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

async function executableExists(candidate: string): Promise<boolean> {
  if (!candidate.includes('/')) return true;
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function resolveAdbPath(): Promise<string> {
  const configured = process.env.HEATLINE_ADB?.trim();
  const androidHome = process.env.ANDROID_HOME?.trim();
  const candidates = [
    configured,
    androidHome ? join(androidHome, 'platform-tools', 'adb') : undefined,
    '/opt/homebrew/bin/adb',
    'adb',
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (!(await executableExists(candidate))) continue;
    try {
      await execute(candidate, ['version']);
      return candidate;
    } catch {
      // Continue to the next explicit or conventional adb location.
    }
  }
  throw new Error(
    'Android Debug Bridge was not found. Set HEATLINE_ADB or ANDROID_HOME.',
  );
}

async function adb(
  adbPath: string,
  serial: string,
  args: readonly string[],
): Promise<string> {
  return execute(adbPath, ['-s', serial, ...args]);
}

export function parseConnectedDevices(output: string): readonly ListedAndroidDevice[] {
  return output
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\S+)\s+(\S+)(?:\s+(.*))?$/u.exec(line);
      if (!match) throw new Error(`Could not parse adb device row: ${line}`);
      return {
        serial: match[1]!,
        state: match[2]!,
        details: match[3] ?? '',
      };
    });
}

export function selectListedDevice(
  devices: readonly ListedAndroidDevice[],
  configuredSerial?: string,
): ListedAndroidDevice {
  const selected = configuredSerial
    ? devices.find(({ serial }) => serial === configuredSerial)
    : devices.length === 1
      ? devices[0]
      : undefined;

  if (!selected) {
    if (configuredSerial) {
      throw new Error(
        `HEATLINE_ANDROID_SERIAL does not name a connected adb device (${devices.length} found).`,
      );
    }
    throw new Error(
      `Expected exactly one adb device, found ${devices.length}; set HEATLINE_ANDROID_SERIAL.`,
    );
  }
  if (selected.state !== 'device') {
    throw new Error(
      `The selected Android device is ${selected.state}; unlock it and accept the USB debugging prompt.`,
    );
  }
  return selected;
}

async function selectDevice(adbPath: string): Promise<ListedAndroidDevice> {
  const devices = parseConnectedDevices(await execute(adbPath, ['devices', '-l']));
  return selectListedDevice(devices, process.env.HEATLINE_ANDROID_SERIAL?.trim());
}

async function getProperty(
  adbPath: string,
  serial: string,
  name: string,
): Promise<string> {
  return adb(adbPath, serial, ['shell', 'getprop', name]);
}

function parseNumber(output: string, pattern: RegExp): number | null {
  const value = Number(pattern.exec(output)?.[1]);
  return Number.isFinite(value) ? value : null;
}

export interface EmulatorIdentityProperties {
  readonly fingerprint: string;
  readonly product: string;
  readonly device: string;
  readonly model: string;
  readonly hardware: string;
  readonly kernelQemu?: string;
  readonly bootQemu?: string;
  readonly virtualDevice?: string;
}

export function detectEmulatorSignals(
  selected: ListedAndroidDevice,
  properties: EmulatorIdentityProperties,
): readonly string[] {
  const signals: string[] = [];
  if (/^(?:emulator-|localhost:|127\.0\.0\.1:)/u.test(selected.serial)) {
    signals.push('serial');
  }
  if (properties.kernelQemu === '1') signals.push('ro.kernel.qemu');
  if (properties.bootQemu === '1') signals.push('ro.boot.qemu');
  if (/^(?:1|true)$/iu.test(properties.virtualDevice ?? '')) {
    signals.push('ro.hardware.virtual_device');
  }
  const identity = [
    properties.fingerprint,
    properties.product,
    properties.device,
    properties.model,
    properties.hardware,
    selected.details,
  ].join(' ').toLowerCase();
  for (const marker of EMULATOR_MARKERS) {
    if (identity.includes(marker)) signals.push(marker);
  }
  return [...new Set(signals)];
}

async function findChromePackage(
  adbPath: string,
  serial: string,
): Promise<AndroidBrowserEvidence> {
  for (const packageName of CHROME_PACKAGES) {
    try {
      const path = await adb(adbPath, serial, ['shell', 'pm', 'path', packageName]);
      if (!path.startsWith('package:')) continue;
      const packageDump = await adb(
        adbPath,
        serial,
        ['shell', 'dumpsys', 'package', packageName],
      );
      const versionName = /^\s*versionName=(\S+)/mu.exec(packageDump)?.[1] ?? 'unknown';
      const resolvedActivity = await adb(adbPath, serial, [
        'shell',
        'cmd',
        'package',
        'resolve-activity',
        '--brief',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        'https://loggel.github.io/GTA-Web/',
        '-p',
        packageName,
      ]);
      const viewActivity = [...resolvedActivity.split(/\r?\n/u)]
        .reverse()
        .find((line) => /^\S+\/\S+$/u.test(line.trim()))
        ?.trim();
      if (!viewActivity) {
        throw new Error(`Could not resolve a VIEW activity for ${packageName}.`);
      }
      const resolvedLauncher = await adb(adbPath, serial, [
        'shell',
        'cmd',
        'package',
        'resolve-activity',
        '--brief',
        '-a',
        'android.intent.action.MAIN',
        '-c',
        'android.intent.category.LAUNCHER',
        '-p',
        packageName,
      ]);
      const launcherActivity = [...resolvedLauncher.split(/\r?\n/u)]
        .reverse()
        .find((line) => /^\S+\/\S+$/u.test(line.trim()))
        ?.trim();
      if (!launcherActivity) {
        throw new Error(`Could not resolve a launcher activity for ${packageName}.`);
      }
      return { packageName, versionName, viewActivity, launcherActivity };
    } catch {
      // Try the next stable/beta/dev/Chromium package.
    }
  }
  throw new Error('No supported Chrome or Chromium package is installed on the Android device.');
}

export async function inspectAndroidDevice(): Promise<AndroidDeviceConnection> {
  const adbPath = await resolveAdbPath();
  const selected = await selectDevice(adbPath);
  const propertyNames = {
    manufacturer: 'ro.product.manufacturer',
    model: 'ro.product.model',
    product: 'ro.product.name',
    device: 'ro.product.device',
    androidVersion: 'ro.build.version.release',
    sdk: 'ro.build.version.sdk',
    abi: 'ro.product.cpu.abi',
    hardware: 'ro.hardware',
    socModel: 'ro.soc.model',
    fingerprint: 'ro.build.fingerprint',
    kernelQemu: 'ro.kernel.qemu',
    bootQemu: 'ro.boot.qemu',
    virtualDevice: 'ro.hardware.virtual_device',
  } as const;
  const propertyEntries = await Promise.all(
    Object.entries(propertyNames).map(async ([key, property]) => [
      key,
      await getProperty(adbPath, selected.serial, property),
    ] as const),
  );
  const properties = Object.fromEntries(propertyEntries) as Record<
    keyof typeof propertyNames,
    string
  >;
  const [physicalDisplay, physicalDensity, displayDump, batteryDump, thermalDump, browser] =
    await Promise.all([
      adb(adbPath, selected.serial, ['shell', 'wm', 'size']),
      adb(adbPath, selected.serial, ['shell', 'wm', 'density']),
      adb(adbPath, selected.serial, ['shell', 'dumpsys', 'display']),
      adb(adbPath, selected.serial, ['shell', 'dumpsys', 'battery']),
      adb(adbPath, selected.serial, ['shell', 'dumpsys', 'thermalservice'])
        .catch(() => ''),
      findChromePackage(adbPath, selected.serial),
    ]);
  const signals = detectEmulatorSignals(selected, properties);
  const emulatorMode = signals.length > 0;
  const allowEmulator = process.env.HEATLINE_ALLOW_EMULATOR === '1';

  if (emulatorMode && !allowEmulator) {
    throw new Error(
      `The selected target is an emulator (${signals.join(', ')}). `
      + 'Physical acceptance refuses emulators; HEATLINE_ALLOW_EMULATOR=1 is only for runner validation.',
    );
  }
  const reviewedProfile = emulatorMode
    ? null
    : matchReviewedMidrangeProfile({
      manufacturer: properties.manufacturer,
      model: properties.model,
      device: properties.device,
      socModel: properties.socModel,
    });
  if (!emulatorMode) {
    const expectedModel = process.env.HEATLINE_ANDROID_EXPECT_MODEL?.trim();
    if (!expectedModel) {
      throw new Error(
        'Set HEATLINE_ANDROID_EXPECT_MODEL to the exact model shown by adb.',
      );
    }
    if (properties.model !== expectedModel) {
      throw new Error(
        `Connected model "${properties.model}" does not match HEATLINE_ANDROID_EXPECT_MODEL "${expectedModel}".`,
      );
    }
    if (!reviewedProfile) {
      throw new Error(
        `Physical model "${properties.model}" / device "${properties.device}" is not in the reviewed `
        + 'representative mid-range allowlist. Add a sourced, reviewed profile before acceptance.',
      );
    }
  }

  return {
    adbPath,
    serial: selected.serial,
    browser,
    emulatorMode,
    reviewedProfile,
    evidence: {
      serialRedacted: true,
      manufacturer: properties.manufacturer,
      model: properties.model,
      product: properties.product,
      device: properties.device,
      androidVersion: properties.androidVersion,
      sdk: properties.sdk,
      abi: properties.abi,
      hardware: properties.hardware,
      socModel: properties.socModel,
      buildFingerprint: properties.fingerprint,
      physicalDisplay,
      physicalDensity,
      refreshRateHz: parseNumber(displayDump, /renderFrameRate=([\d.]+)/u),
      battery: {
        levelPercent: parseNumber(batteryDump, /^\s*level:\s*(\d+)/mu),
        temperatureCelsius: (() => {
          const tenths = parseNumber(batteryDump, /^\s*temperature:\s*(\d+)/mu);
          return tenths === null ? null : tenths / 10;
        })(),
        status: /^\s*status:\s*(\S+)/mu.exec(batteryDump)?.[1] ?? null,
      },
      thermalStatus: parseNumber(
        thermalDump,
        /(?:Thermal Status|Status):\s*(\d+)/iu,
      ),
      emulatorSignals: signals,
    },
  };
}

export async function launchChrome(
  connection: AndroidDeviceConnection,
): Promise<void> {
  await adb(connection.adbPath, connection.serial, [
    'shell',
    'am',
    'start',
    '-W',
    '-n',
    connection.browser.launcherActivity,
  ]);
}

export async function forwardChromeDevtools(
  connection: AndroidDeviceConnection,
): Promise<{ readonly port: number; remove(): Promise<void> }> {
  const output = await adb(connection.adbPath, connection.serial, [
    'forward',
    'tcp:0',
    'localabstract:chrome_devtools_remote',
  ]);
  const port = Number(output);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`adb returned an invalid dynamic CDP port: ${output}`);
  }
  return {
    port,
    remove: async () => {
      await adb(
        connection.adbPath,
        connection.serial,
        ['forward', '--remove', `tcp:${port}`],
      ).catch(() => undefined);
    },
  };
}
