import type { VehicleClassId, WeaponClassId, WeaponTier } from '../data/types';
import type {
  CrimeEvent,
  EnemyDamageEvent,
  PlayerDamageEvent,
  WitnessReportEvent,
} from '../simulation/types';
import type { PoliceResponseVisualSnapshot } from './PoliceResponseVisual';
import type { VehicleIntegrityState } from './vehicleIntegrity';

export type DistrictId = 'neon-strand' | 'alta-vista' | 'arroyo-heights' | 'breakwater';

export type WorldQuality = 'low' | 'high';

export type CameraMode = 'follow' | 'aim' | 'vehicle';

export type ShoulderSide = 'left' | 'right';

export type TraversalMode = 'grounded' | 'airborne' | 'stepping' | 'vaulting';

export type PlayerMode = 'on-foot' | 'vehicle';

export type WorldInteriorPhase = 'exterior' | 'loading-enter' | 'interior' | 'loading-exit';

export type DayPhase = 'dawn' | 'day' | 'evening' | 'night';

export interface Vec3Data {
  x: number;
  y: number;
  z: number;
}

export interface VehicleUpgradeLevels {
  engine: number;
  brakes: number;
  grip: number;
  armor: number;
}

export interface WorldVehicleInitialization {
  instanceId: string;
  classId: VehicleClassId;
  registered: boolean;
  paint?: string;
  integrity?: VehicleIntegrityState;
  upgrades?: VehicleUpgradeLevels;
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
  /** Held primary attack input; firearm cadence is enforced by the combat runtime. */
  fire: boolean;
  /** One-shot heavy melee/context attack request. */
  melee: boolean;
  /** Held charge state for the heavy melee/context action. */
  heavyAttackHeld: boolean;
  /** One-shot release that commits the accumulated heavy attack charge. */
  heavyAttackReleased: boolean;
  /** One-shot reload request. */
  reload: boolean;
  /** One-shot request to cycle the quick weapon loadout. */
  weaponCycle: boolean;
  /** One-shot evasive step requested while blocking/aiming. */
  dodge: boolean;
  /** One-shot camera shoulder toggle request. */
  shoulderSwap: boolean;
  handbrake: boolean;
  /** Held contextual action while driving, including the police-cruiser siren. */
  vehiclePrimaryAction: boolean;
  /** One-shot request to toggle between the two vehicle chase distances. */
  vehicleCameraToggle: boolean;
  /** One-shot request to upright or move the occupied vehicle to nearby safe ground. */
  vehicleReset: boolean;
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
  velocity: Vec3Data;
  heading: number;
  speedMetersPerSecond: number;
  speedKph: number;
  grounded: boolean;
  sprinting: boolean;
  crouching: boolean;
  verticalSpeed: number;
  traversalMode: TraversalMode;
  cameraYaw: number;
  cameraPitch: number;
  shoulderSide: ShoulderSide;
  paused: boolean;
  focused: boolean;
  running: boolean;
  interactionTarget: WorldInteractionSnapshot | null;
  canInteract: boolean;
  canExitVehicle: boolean;
  interiorId: string | null;
  interiorLabel: string | null;
  interiorPhase: WorldInteriorPhase;
  timeOfDay: number;
  dayPhase: DayPhase;
  rainIntensity: number;
  vehicleHealth: number | null;
  vehicleInstanceId: string;
  vehicleClassId: VehicleClassId;
  vehicleName: string;
  vehicleRegistered: boolean;
  vehiclePosition: Vec3Data;
  vehicleIntegrity: VehicleIntegrityState;
  vehicleUpgrades: VehicleUpgradeLevels;
  vehiclePaint: string;
  vehicleSirenActive: boolean;
  vehicleCameraView: 'chase' | 'close';
  activeWeaponId: string;
  activeWeaponName: string;
  activeWeaponClassId: WeaponClassId;
  activeWeaponTier: WeaponTier;
  weaponAmmo: number;
  weaponAmmoReserve: number;
  weaponDurability: number;
  weaponReloading: boolean;
  meleeStamina: number;
  meleeBlocking: boolean;
  softCoverEngaged: boolean;
  softCoverPeeking: boolean;
  softCoverExposure: number;
  aimTargetId: string | null;
  activeCombatants: number;
  policeResponse: PoliceResponseVisualSnapshot;
  policePhase: 'clear' | 'investigating' | 'pursuit' | 'search';
  prompt: string | null;
}

export type WorldInteractionKind = 'vehicle' | 'world';

export interface WorldInteractionSnapshot {
  id: string;
  kind: WorldInteractionKind;
  prompt: string;
  distanceMeters: number;
  position: Vec3Data;
}

export interface EnvironmentUpdate {
  /** Normalized time in [0, 1), where 0.5 is noon. */
  timeOfDay?: number;
  /** Normalized intensity in [0, 1]. */
  rainIntensity?: number;
  /** In-game normalized days advanced per real second. */
  clockRate?: number;
}

/** Measured RPG modifiers consumed by the live world simulation. */
export interface WorldProgressionModifiers {
  meleeDamageMultiplier: number;
  weaponSpreadMultiplier: number;
  reloadTimeMultiplier: number;
  vehicleStabilityMultiplier: number;
  vehicleBrakingMultiplier: number;
  vehicleDurabilityMultiplier: number;
  enemySuspicionTimeMultiplier: number;
  crouchedNoiseMultiplier: number;
}

export interface WorldViewOptions {
  mount: HTMLElement;
  seed?: number | string;
  initialPosition?: Vec3Data;
  initialHeading?: number;
  initialVehicle?: WorldVehicleInitialization;
  reservedVehicleInstanceIds?: readonly string[];
  quality?: WorldQuality;
  timeOfDay?: number;
  rainIntensity?: number;
  clockRate?: number;
  enableDefaultControls?: boolean;
  /** Optional app-owned input source consumed once per simulation update. */
  inputProvider?: () => Partial<WorldInputState>;
  reducedMotion?: boolean;
  resolutionScale?: number;
  aimAssistLevel?: 'off' | 'low' | 'medium' | 'high';
  aimAssistDevice?: 'desktop' | 'mobile';
  desktopSoftLockEnabled?: boolean;
  progressionModifiers?: Partial<WorldProgressionModifiers>;
  onFrame?: (frameMilliseconds: number) => void;
  onSnapshot?: (snapshot: WorldSnapshot) => void;
  onCrime?: (event: CrimeEvent) => void;
  onWitnessReport?: (event: WitnessReportEvent) => void;
  onEnemyDamage?: (event: EnemyDamageEvent) => void;
  onPlayerDamage?: (event: PlayerDamageEvent) => void;
}

export function createWorldInputState(): WorldInputState {
  return {
    moveForward: 0,
    moveRight: 0,
    sprint: false,
    jump: false,
    crouch: false,
    aim: false,
    fire: false,
    melee: false,
    heavyAttackHeld: false,
    heavyAttackReleased: false,
    reload: false,
    weaponCycle: false,
    dodge: false,
    shoulderSwap: false,
    handbrake: false,
    vehiclePrimaryAction: false,
    vehicleCameraToggle: false,
    vehicleReset: false,
    interact: false,
    cameraYawDelta: 0,
    cameraPitchDelta: 0,
  };
}
