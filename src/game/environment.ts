import type { DayPhase, EnvironmentUpdate } from './types';

const DEFAULT_CLOCK_RATE = 1 / (24 * 60);

export interface EnvironmentState {
  timeOfDay: number;
  rainIntensity: number;
  clockRate: number;
}

export interface EnvironmentPalette {
  sky: number;
  fog: number;
  hemisphereSky: number;
  hemisphereGround: number;
  sun: number;
  sunIntensity: number;
  hemisphereIntensity: number;
  buildingEmissiveIntensity: number;
}

interface PaletteKeyframe extends EnvironmentPalette {
  time: number;
}

const PALETTE_KEYFRAMES: readonly PaletteKeyframe[] = [
  {
    time: 0,
    sky: 0x06101f,
    fog: 0x0a1422,
    hemisphereSky: 0x24345e,
    hemisphereGround: 0x101721,
    sun: 0x8198d9,
    sunIntensity: 0.18,
    hemisphereIntensity: 0.54,
    buildingEmissiveIntensity: 0.72,
  },
  {
    time: 0.22,
    sky: 0x14223d,
    fog: 0x1d2938,
    hemisphereSky: 0x526485,
    hemisphereGround: 0x2a3035,
    sun: 0xffa878,
    sunIntensity: 0.32,
    hemisphereIntensity: 0.68,
    buildingEmissiveIntensity: 0.48,
  },
  {
    time: 0.29,
    sky: 0xff966b,
    fog: 0xd78368,
    hemisphereSky: 0xffc58f,
    hemisphereGround: 0x6c5140,
    sun: 0xffd09a,
    sunIntensity: 1.25,
    hemisphereIntensity: 1.1,
    buildingEmissiveIntensity: 0.18,
  },
  {
    time: 0.38,
    sky: 0x55bde3,
    fog: 0x8bc5d1,
    hemisphereSky: 0xa9e4f6,
    hemisphereGround: 0x6d7c63,
    sun: 0xfff0c2,
    sunIntensity: 2.15,
    hemisphereIntensity: 1.34,
    buildingEmissiveIntensity: 0.04,
  },
  {
    time: 0.68,
    sky: 0x47aeda,
    fog: 0x82becb,
    hemisphereSky: 0x9edcf0,
    hemisphereGround: 0x69785f,
    sun: 0xffefc0,
    sunIntensity: 2.05,
    hemisphereIntensity: 1.3,
    buildingEmissiveIntensity: 0.05,
  },
  {
    time: 0.78,
    sky: 0xf47d68,
    fog: 0xb96f6d,
    hemisphereSky: 0xffa778,
    hemisphereGround: 0x55404a,
    sun: 0xff9e65,
    sunIntensity: 1.1,
    hemisphereIntensity: 0.88,
    buildingEmissiveIntensity: 0.34,
  },
  {
    time: 0.86,
    sky: 0x101937,
    fog: 0x172035,
    hemisphereSky: 0x38456d,
    hemisphereGround: 0x161b27,
    sun: 0x9ba7de,
    sunIntensity: 0.22,
    hemisphereIntensity: 0.58,
    buildingEmissiveIntensity: 0.68,
  },
  {
    time: 1,
    sky: 0x06101f,
    fog: 0x0a1422,
    hemisphereSky: 0x24345e,
    hemisphereGround: 0x101721,
    sun: 0x8198d9,
    sunIntensity: 0.18,
    hemisphereIntensity: 0.54,
    buildingEmissiveIntensity: 0.72,
  },
];

function wrapTime(value: number): number {
  return ((value % 1) + 1) % 1;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function interpolateNumber(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function interpolateColor(from: number, to: number, amount: number): number {
  const fromRed = (from >> 16) & 0xff;
  const fromGreen = (from >> 8) & 0xff;
  const fromBlue = from & 0xff;
  const toRed = (to >> 16) & 0xff;
  const toGreen = (to >> 8) & 0xff;
  const toBlue = to & 0xff;
  const red = Math.round(interpolateNumber(fromRed, toRed, amount));
  const green = Math.round(interpolateNumber(fromGreen, toGreen, amount));
  const blue = Math.round(interpolateNumber(fromBlue, toBlue, amount));
  return (red << 16) | (green << 8) | blue;
}

export function createEnvironmentState(update: EnvironmentUpdate = {}): EnvironmentState {
  return {
    timeOfDay: wrapTime(update.timeOfDay ?? 0.7),
    rainIntensity: clamp01(update.rainIntensity ?? 0.12),
    clockRate: Math.max(0, update.clockRate ?? DEFAULT_CLOCK_RATE),
  };
}

export function updateEnvironment(
  state: EnvironmentState,
  update: EnvironmentUpdate,
): void {
  if (update.timeOfDay !== undefined) {
    state.timeOfDay = wrapTime(update.timeOfDay);
  }
  if (update.rainIntensity !== undefined) {
    state.rainIntensity = clamp01(update.rainIntensity);
  }
  if (update.clockRate !== undefined) {
    state.clockRate = Math.max(0, update.clockRate);
  }
}

export function advanceEnvironment(state: EnvironmentState, deltaSeconds: number): void {
  state.timeOfDay = wrapTime(state.timeOfDay + Math.max(0, deltaSeconds) * state.clockRate);
}

export function dayPhaseAt(timeOfDay: number): DayPhase {
  const time = wrapTime(timeOfDay);
  if (time >= 0.22 && time < 0.32) {
    return 'dawn';
  }
  if (time >= 0.32 && time < 0.72) {
    return 'day';
  }
  if (time >= 0.72 && time < 0.84) {
    return 'evening';
  }
  return 'night';
}

export function environmentPaletteAt(timeOfDay: number, rainIntensity = 0): EnvironmentPalette {
  const time = wrapTime(timeOfDay);
  let from = PALETTE_KEYFRAMES[0];
  let to = PALETTE_KEYFRAMES[PALETTE_KEYFRAMES.length - 1];
  if (!from || !to) {
    throw new Error('Environment palette keyframes are missing');
  }

  for (let index = 1; index < PALETTE_KEYFRAMES.length; index += 1) {
    const candidate = PALETTE_KEYFRAMES[index];
    if (candidate && time <= candidate.time) {
      to = candidate;
      from = PALETTE_KEYFRAMES[index - 1] ?? candidate;
      break;
    }
  }

  const range = Math.max(0.000001, to.time - from.time);
  const amount = (time - from.time) / range;
  const rain = clamp01(rainIntensity);
  const rainSky = 0x35434d;
  const rainFog = 0x4c5960;

  return {
    sky: interpolateColor(interpolateColor(from.sky, to.sky, amount), rainSky, rain * 0.62),
    fog: interpolateColor(interpolateColor(from.fog, to.fog, amount), rainFog, rain * 0.7),
    hemisphereSky: interpolateColor(from.hemisphereSky, to.hemisphereSky, amount),
    hemisphereGround: interpolateColor(from.hemisphereGround, to.hemisphereGround, amount),
    sun: interpolateColor(from.sun, to.sun, amount),
    sunIntensity: interpolateNumber(from.sunIntensity, to.sunIntensity, amount) * (1 - rain * 0.55),
    hemisphereIntensity: interpolateNumber(from.hemisphereIntensity, to.hemisphereIntensity, amount)
      * (1 - rain * 0.24),
    buildingEmissiveIntensity: interpolateNumber(
      from.buildingEmissiveIntensity,
      to.buildingEmissiveIntensity,
      amount,
    ),
  };
}

