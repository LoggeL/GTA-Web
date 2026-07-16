export type DistrictId = 'neon-strand' | 'alta-vista' | 'arroyo-heights' | 'breakwater';

export type WorldQuality = 'low' | 'high';

export type CameraMode = 'follow' | 'aim' | 'vehicle';

export type PlayerMode = 'on-foot' | 'vehicle';

export type DayPhase = 'dawn' | 'day' | 'evening' | 'night';

export interface Vec3Data {
  x: number;
  y: number;
  z: number;
}

export interface WorldInputState {
  /** -1 is backwards, 1 is forwards. */
  moveForward: number;
  /** -1 is left, 1 is right. */
  moveRight: number;
  sprint: boolean;
  jump: boolean;
  crouch: boolean;
  aim: boolean;
  handbrake: boolean;
  /** One-shot interaction/vehicle toggle request. */
  interact: boolean;
  /** Radians to add during this simulation update. */
  cameraYawDelta: number;
  /** Radians to add during this simulation update. */
  cameraPitchDelta: number;
}

export interface WorldSnapshot {
  mode: PlayerMode;
  cameraMode: CameraMode;
  district: DistrictId;
  position: Vec3Data;
  heading: number;
  speedMetersPerSecond: number;
  speedKph: number;
  grounded: boolean;
  sprinting: boolean;
  crouching: boolean;
  timeOfDay: number;
  dayPhase: DayPhase;
  rainIntensity: number;
  vehicleHealth: number | null;
  prompt: string | null;
}

export interface EnvironmentUpdate {
  /** Normalized time in [0, 1), where 0.5 is noon. */
  timeOfDay?: number;
  /** Normalized intensity in [0, 1]. */
  rainIntensity?: number;
  /** In-game normalized days advanced per real second. */
  clockRate?: number;
}

export interface WorldViewOptions {
  mount: HTMLElement;
  seed?: number | string;
  initialPosition?: Vec3Data;
  initialHeading?: number;
  quality?: WorldQuality;
  timeOfDay?: number;
  rainIntensity?: number;
  clockRate?: number;
  enableDefaultControls?: boolean;
  reducedMotion?: boolean;
  onSnapshot?: (snapshot: WorldSnapshot) => void;
}

export function createWorldInputState(): WorldInputState {
  return {
    moveForward: 0,
    moveRight: 0,
    sprint: false,
    jump: false,
    crouch: false,
    aim: false,
    handbrake: false,
    interact: false,
    cameraYawDelta: 0,
    cameraPitchDelta: 0,
  };
}
