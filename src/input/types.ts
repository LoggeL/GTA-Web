import type {
  BindingDevice as CoreBindingDevice,
  BindingMap as CoreBindingMap,
  InputAction as CoreInputAction,
  InputBinding as CoreInputBinding,
} from '../core/settings';

export type InputAction = CoreInputAction;
export type BindingDevice = CoreBindingDevice;
export type InputBinding = CoreInputBinding;
export type BindingMap = CoreBindingMap;
export type InputMode = 'on-foot' | 'vehicle';

export const INPUT_ACTIONS: readonly InputAction[] = [
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

export type ReadonlyBindingMap = Readonly<
  Record<InputAction, readonly Readonly<InputBinding>[]>
>;

export interface InputBindingSnapshot {
  readonly schemaVersion: 1;
  readonly bindings: ReadonlyBindingMap;
}

export interface BindingValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ButtonState {
  readonly pressed: boolean;
  readonly justPressed: boolean;
  readonly justReleased: boolean;
}

export type ActionStateMap = Readonly<Record<InputAction, ButtonState>>;

export interface AxisState {
  readonly value: number;
  readonly previousValue: number;
  readonly pressed: boolean;
  readonly justPressed: boolean;
  readonly justReleased: boolean;
}

export interface PointerDelta {
  readonly yaw: number;
  readonly pitch: number;
}

export type OnFootCommand =
  | 'fireOrLightAttack'
  | 'aim'
  | 'sprint'
  | 'jump'
  | 'crouch'
  | 'interact'
  | 'meleeContext'
  | 'reload'
  | 'shoulderSwap'
  | 'weaponRadial'
  | 'inventory'
  | 'map'
  | 'pause';

export type VehicleCommand =
  | 'vehiclePrimaryAction'
  | 'vehicleAim'
  | 'handbrake'
  | 'cameraToggle'
  | 'enterExit'
  | 'vehicleReset'
  | 'weaponRadial'
  | 'inventory'
  | 'map'
  | 'pause';

interface BaseInputFrame {
  readonly sequence: number;
  readonly actions: ActionStateMap;
  readonly pointerDelta: PointerDelta;
}

export interface OnFootInputFrame extends BaseInputFrame {
  readonly mode: 'on-foot';
  readonly axes: {
    readonly moveRight: AxisState;
    readonly moveForward: AxisState;
  };
  readonly commands: Readonly<Record<OnFootCommand, ButtonState>>;
}

export interface VehicleInputFrame extends BaseInputFrame {
  readonly mode: 'vehicle';
  readonly axes: {
    readonly steer: AxisState;
    readonly throttle: AxisState;
  };
  readonly commands: Readonly<Record<VehicleCommand, ButtonState>>;
}

export type InputFrame = OnFootInputFrame | VehicleInputFrame;

export type TouchControlAction =
  | 'fire'
  | 'aim'
  | 'sprint'
  | 'jump'
  | 'crouch'
  | 'interact'
  | 'melee'
  | 'reload'
  | 'shoulderSwap'
  | 'weaponRadial'
  | 'inventory'
  | 'map'
  | 'pause';
