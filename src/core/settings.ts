export const SETTINGS_VERSION = 1 as const;

export type InputAction =
  | 'moveForward'
  | 'moveBackward'
  | 'moveLeft'
  | 'moveRight'
  | 'primaryAction'
  | 'aim'
  | 'sprint'
  | 'jumpHandbrake'
  | 'crouchCamera'
  | 'interactEnterExit'
  | 'meleeContext'
  | 'reloadVehicleReset'
  | 'shoulderSwap'
  | 'weaponRadial'
  | 'inventory'
  | 'map'
  | 'pause';

export type BindingDevice = 'keyboard' | 'mouse';

export interface InputBinding {
  device: BindingDevice;
  code: string;
}

export type BindingMap = Record<InputAction, InputBinding[]>;

export interface GameSettings {
  schemaVersion: typeof SETTINGS_VERSION;
  controls: {
    mouseSensitivity: number;
    touchSensitivity: number;
    invertY: boolean;
    softLock: boolean;
    aimAssist: 'off' | 'low' | 'medium' | 'high';
    touchControlScale: number;
    touchControlOpacity: number;
    bindings: BindingMap;
  };
  accessibility: {
    reducedMotion: boolean;
    cameraShake: number;
    subtitleSize: 'small' | 'medium' | 'large';
    subtitleBackground: boolean;
    highContrastIndicators: boolean;
    uiScale: number;
  };
  audio: {
    master: number;
    music: number;
    sfx: number;
    ui: number;
    ambience: number;
  };
  video: {
    quality: 'auto' | 'low' | 'high';
    resolutionScale: number;
  };
}

const ACTIONS: readonly InputAction[] = [
  'moveForward',
  'moveBackward',
  'moveLeft',
  'moveRight',
  'primaryAction',
  'aim',
  'sprint',
  'jumpHandbrake',
  'crouchCamera',
  'interactEnterExit',
  'meleeContext',
  'reloadVehicleReset',
  'shoulderSwap',
  'weaponRadial',
  'inventory',
  'map',
  'pause',
];

const DEFAULT_BINDING_DATA: Readonly<Record<InputAction, readonly InputBinding[]>> = {
  moveForward: [{ device: 'keyboard', code: 'KeyW' }],
  moveBackward: [{ device: 'keyboard', code: 'KeyS' }],
  moveLeft: [{ device: 'keyboard', code: 'KeyA' }],
  moveRight: [{ device: 'keyboard', code: 'KeyD' }],
  primaryAction: [{ device: 'mouse', code: 'Mouse0' }],
  aim: [{ device: 'mouse', code: 'Mouse2' }],
  sprint: [{ device: 'keyboard', code: 'ShiftLeft' }],
  jumpHandbrake: [{ device: 'keyboard', code: 'Space' }],
  crouchCamera: [{ device: 'keyboard', code: 'KeyC' }],
  interactEnterExit: [{ device: 'keyboard', code: 'KeyE' }],
  meleeContext: [{ device: 'keyboard', code: 'KeyF' }],
  reloadVehicleReset: [{ device: 'keyboard', code: 'KeyR' }],
  shoulderSwap: [{ device: 'keyboard', code: 'KeyQ' }],
  weaponRadial: [{ device: 'keyboard', code: 'Tab' }],
  inventory: [{ device: 'keyboard', code: 'KeyI' }],
  map: [{ device: 'keyboard', code: 'KeyM' }],
  pause: [{ device: 'keyboard', code: 'Escape' }],
};

export function createDefaultBindings(): BindingMap {
  const bindings = {} as BindingMap;
  for (const action of ACTIONS) {
    bindings[action] = DEFAULT_BINDING_DATA[action].map((binding) => ({ ...binding }));
  }
  return bindings;
}

export function createDefaultSettings(): GameSettings {
  return {
    schemaVersion: SETTINGS_VERSION,
    controls: {
      mouseSensitivity: 1,
      touchSensitivity: 1,
      invertY: false,
      softLock: true,
      aimAssist: 'medium',
      touchControlScale: 1,
      touchControlOpacity: 0.75,
      bindings: createDefaultBindings(),
    },
    accessibility: {
      reducedMotion: false,
      cameraShake: 1,
      subtitleSize: 'medium',
      subtitleBackground: true,
      highContrastIndicators: false,
      uiScale: 1,
    },
    audio: {
      master: 1,
      music: 0.75,
      sfx: 0.85,
      ui: 0.8,
      ambience: 0.8,
    },
    video: {
      quality: 'auto',
      resolutionScale: 1,
    },
  };
}

export function validateGameSettings(value: unknown): value is GameSettings {
  if (!isRecord(value) || value.schemaVersion !== SETTINGS_VERSION) {
    return false;
  }

  const controls = value.controls;
  const accessibility = value.accessibility;
  const audio = value.audio;
  const video = value.video;
  if (!isRecord(controls) || !isRecord(accessibility) || !isRecord(audio) || !isRecord(video)) {
    return false;
  }

  return isInRange(controls.mouseSensitivity, 0.1, 3)
    && isInRange(controls.touchSensitivity, 0.1, 3)
    && typeof controls.invertY === 'boolean'
    && typeof controls.softLock === 'boolean'
    && isOneOf(controls.aimAssist, ['off', 'low', 'medium', 'high'])
    && isInRange(controls.touchControlScale, 0.75, 1.5)
    && isInRange(controls.touchControlOpacity, 0.25, 1)
    && validateBindings(controls.bindings)
    && typeof accessibility.reducedMotion === 'boolean'
    && isInRange(accessibility.cameraShake, 0, 1)
    && isOneOf(accessibility.subtitleSize, ['small', 'medium', 'large'])
    && typeof accessibility.subtitleBackground === 'boolean'
    && typeof accessibility.highContrastIndicators === 'boolean'
    && isInRange(accessibility.uiScale, 0.75, 1.5)
    && isUnitInterval(audio.master)
    && isUnitInterval(audio.music)
    && isUnitInterval(audio.sfx)
    && isUnitInterval(audio.ui)
    && isUnitInterval(audio.ambience)
    && isOneOf(video.quality, ['auto', 'low', 'high'])
    && isInRange(video.resolutionScale, 0.5, 1);
}

function validateBindings(value: unknown): value is BindingMap {
  if (!isRecord(value)) {
    return false;
  }

  return ACTIONS.every((action) => {
    const bindings = value[action];
    return Array.isArray(bindings)
      && bindings.length > 0
      && bindings.every((binding: unknown) => isRecord(binding)
        && isOneOf(binding.device, ['keyboard', 'mouse'])
        && typeof binding.code === 'string'
        && binding.code.length > 0);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnitInterval(value: unknown): value is number {
  return isInRange(value, 0, 1);
}

function isInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isOneOf<const Value extends string>(value: unknown, choices: readonly Value[]): value is Value {
  return typeof value === 'string' && choices.includes(value as Value);
}
