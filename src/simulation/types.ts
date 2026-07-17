import type { Scene } from 'three';

import type { VehicleClassId } from '../data/types';
import type { DistrictId } from '../game/types';

export type SimulationQuality = 'low' | 'high';

/**
 * Runtime population ceilings. The shape intentionally matches the actor
 * limits emitted by CityStreamingController so callers can pass them through
 * without translating field names (an extra `total` field is harmless).
 */
export interface ActorPopulationLimits {
  readonly traffic: number;
  readonly pedestrians: number;
  readonly combat: number;
}

export interface SimulationVec3 {
  x: number;
  y: number;
  z: number;
}

export interface SimulationRoadRecipe {
  id: string;
  district?: DistrictId;
  position: SimulationVec3;
  width: number;
  depth: number;
  major?: boolean;
}

export interface SimulationObstacle {
  x: number;
  z: number;
  radius: number;
}

export type TrafficBehavior = 'cruise' | 'yield' | 'intersection-yield' | 'recover' | 'panic' | 'siren-yield';

export interface TrafficVehicleSnapshot {
  id: string;
  classId: VehicleClassId;
  position: SimulationVec3;
  heading: number;
  speed: number;
  behavior: TrafficBehavior;
  roadId: string;
  panicRemaining: number;
}

export type PedestrianBehavior = 'wander' | 'flee' | 'witness-report';

export interface PedestrianSnapshot {
  id: string;
  position: SimulationVec3;
  heading: number;
  speed: number;
  behavior: PedestrianBehavior;
  pendingCrimeId: string | null;
}

export type CombatRole = 'brawler' | 'gunner' | 'flanker' | 'heavy' | 'marksman';

export type CombatBehavior =
  | 'patrol'
  | 'investigate'
  | 'suspicious'
  | 'engage'
  | 'reposition'
  | 'flee'
  | 'defeated';

export interface CombatantSnapshot {
  id: string;
  role: CombatRole;
  position: SimulationVec3;
  heading: number;
  health: number;
  maxHealth: number;
  behavior: CombatBehavior;
  alertness: number;
}

export type WeaponType = 'melee' | 'pistol' | 'smg' | 'shotgun' | 'rifle';

export interface WeaponDefinition {
  type: WeaponType;
  damage: number;
  range: number;
  cooldownSeconds: number;
  spreadRadians: number;
  pellets: number;
}

export interface WeaponHit {
  targetId: string;
  damage: number;
  distance: number;
}

export interface WeaponFireResult {
  weapon: WeaponType;
  fired: boolean;
  cooldownRemaining: number;
  hits: readonly WeaponHit[];
}

export type CrimeKind = 'assault' | 'weapon-fire' | 'vehicle-theft' | 'hit-and-run';

export interface CrimeEvent {
  id: string;
  kind: CrimeKind;
  sourceId: string;
  position: SimulationVec3;
  severity: number;
  simulationTime: number;
}

export interface CrimeReportInput {
  id?: string;
  kind: CrimeKind;
  sourceId: string;
  position: SimulationVec3;
  severity: number;
}

export interface WitnessReportEvent {
  crimeId: string;
  witnessId: string;
  position: SimulationVec3;
  confidence: number;
  simulationTime: number;
}

export interface EnemyDamageEvent {
  targetId: string;
  sourceId: string;
  amount: number;
  remainingHealth: number;
  defeated: boolean;
  effect: 'abstract-impact-flash';
}

export interface PlayerDamageEvent {
  sourceId: string;
  role: CombatRole;
  amount: number;
  attack: 'melee' | 'projectile';
}

export interface SimulationPlayerInput {
  fire?: boolean;
  weapon?: WeaponType;
  aimDirection?: SimulationVec3;
  threatening?: boolean;
  sirenActive?: boolean;
  triggerPanic?: boolean;
}

export interface CitySimulationTick {
  deltaSeconds: number;
  playerPosition: SimulationVec3;
  playerHeading: number;
  /** Perception inputs for the authored NPC AI. Omitted values use visible, standing defaults. */
  playerCrouching?: boolean;
  playerLightLevel?: number;
  playerCoverExposure?: number;
  playerMovement?: number;
  playerNoise?: number;
  input?: SimulationPlayerInput;
  obstructions?: readonly SimulationObstacle[];
}

export interface CitySimulationSnapshot {
  simulationTime: number;
  quality: SimulationQuality;
  traffic: readonly TrafficVehicleSnapshot[];
  pedestrians: readonly PedestrianSnapshot[];
  combatants: readonly CombatantSnapshot[];
  /** Effective ceilings after both quality and adaptive limits are applied. */
  actorLimits: ActorPopulationLimits;
  /** Fixed preallocated pool capacities; adaptive changes never grow these. */
  poolCapacity: {
    traffic: number;
    pedestrians: number;
    combatants: number;
  };
  lastCrimeId: string | null;
}

export interface CitySimulationTickResult {
  snapshot: CitySimulationSnapshot;
  weaponFire: WeaponFireResult | null;
}

export interface SimulationVisualCapabilities {
  readonly supportsMultiDraw: boolean;
}

export interface CitySimulationOptions {
  seed?: number | string;
  quality?: SimulationQuality;
  actorLimits?: ActorPopulationLimits;
  roads?: readonly SimulationRoadRecipe[];
  seedCombatants?: boolean;
  onCrime?: (event: CrimeEvent) => void;
  onWitnessReport?: (event: WitnessReportEvent) => void;
  onEnemyDamage?: (event: EnemyDamageEvent) => void;
  onPlayerDamage?: (event: PlayerDamageEvent) => void;
}

export interface CitySimulationApi {
  attach(scene: Scene, capabilities?: Readonly<SimulationVisualCapabilities>): void;
  detach(): void;
  setVisible(visible: boolean): void;
  setQuality(quality: SimulationQuality): void;
  setActorLimits(limits: Readonly<ActorPopulationLimits>): ActorPopulationLimits;
  claimTrafficVehicle(id: string): TrafficVehicleSnapshot | null;
  despawnEnemy(targetId: string): boolean;
  tick(context: CitySimulationTick): CitySimulationTickResult;
  advance(context: CitySimulationTick): WeaponFireResult | null;
  getSnapshot(): CitySimulationSnapshot;
  dispose(): void;
}
