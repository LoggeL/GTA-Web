import type { SolaraDistrictId } from '../core/districts';

export type DistrictId = SolaraDistrictId;

export type ContactId = 'garage' | 'juno' | 'malik' | 'priya' | 'all-contacts';

export type MissionId =
  | 'past-due'
  | 'coastline-burn'
  | 'rolling-stock'
  | 'bridge-run'
  | 'last-call'
  | 'glass-house'
  | 'container-zero'
  | 'dead-air'
  | 'night-train'
  | 'black-grid'
  | 'full-account'
  | 'freehold';

export type ObjectiveType =
  | 'reach'
  | 'interact'
  | 'collect'
  | 'race-checkpoint'
  | 'escort'
  | 'defend'
  | 'eliminate'
  | 'evade'
  | 'stealth-hack'
  | 'choice'
  | 'composite';

export interface WorldPosition {
  readonly district: DistrictId;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type CompletionCondition =
  | { readonly kind: 'all-targets' }
  | { readonly kind: 'target-count'; readonly required: number }
  | { readonly kind: 'reach-destination'; readonly radiusMeters: number }
  | { readonly kind: 'survive'; readonly durationSeconds: number }
  | { readonly kind: 'lose-wanted'; readonly maximumLevel: number }
  | { readonly kind: 'choice-made'; readonly choices: readonly string[] }
  | { readonly kind: 'composite'; readonly requiredObjectiveIds: readonly string[] };

export interface ObjectiveFallback {
  readonly mode: 'continue' | 'alternate-objective' | 'restart-checkpoint';
  readonly objectiveId?: string;
  readonly description: string;
}

export interface ObjectiveDefinition {
  readonly id: string;
  readonly type: ObjectiveType;
  readonly title: string;
  readonly description: string;
  readonly targetIds: readonly string[];
  readonly completion: CompletionCondition;
  /** Authored response level applied when a lose-wanted objective becomes active. */
  readonly initialWantedLevel?: 1 | 2 | 3 | 4 | 5;
  readonly optional: boolean;
  readonly timeoutSeconds?: number;
  readonly fallback: ObjectiveFallback;
  readonly nextObjectiveIds: readonly string[];
  readonly activation?: {
    readonly choiceObjectiveId: string;
    readonly choice: string;
  };
}

export interface CheckpointDefinition {
  readonly id: string;
  readonly label: string;
  readonly afterObjectiveId: string | null;
  readonly respawn: WorldPosition;
  readonly restore: {
    readonly healthPercent: number;
    readonly armorPercent: number;
    readonly vehicleHealthPercent?: number;
    readonly refillMissionItems: boolean;
  };
}

export interface ItemGrant {
  readonly itemId: string;
  readonly quantity: number;
}

export interface MissionReward {
  readonly id: string;
  readonly cash: number;
  readonly xp: number;
  readonly reputation: Readonly<Partial<Record<Exclude<ContactId, 'garage' | 'all-contacts'>, number>>>;
  readonly items: readonly ItemGrant[];
  readonly unlockFlags: readonly string[];
}

export interface MissionBranchReward {
  readonly choice: 'rule' | 'expose';
  readonly unlockFlag: string;
  readonly modifiers: readonly {
    readonly stat: string;
    readonly percent: number;
  }[];
}

export interface MissionDefinition {
  readonly id: MissionId;
  readonly number: number;
  readonly title: string;
  readonly subtitle: string;
  readonly contact: ContactId;
  readonly district: DistrictId;
  readonly prerequisites: readonly MissionId[];
  readonly reputationGate?: {
    readonly contact: Exclude<ContactId, 'garage' | 'all-contacts'>;
    readonly minimum: number;
  };
  readonly levelGate: number;
  readonly startTrigger: {
    readonly kind: 'world-marker' | 'phone' | 'automatic';
    readonly targetId: string;
  };
  readonly objectives: readonly ObjectiveDefinition[];
  readonly checkpoints: readonly CheckpointDefinition[];
  /** Authored equipment restored when a mission checkpoint requests an item refill. */
  readonly missionItems?: readonly ItemGrant[];
  readonly rewards: MissionReward;
  readonly branchRewards?: readonly MissionBranchReward[];
  readonly dialogueKeys: readonly string[];
  readonly failRestart: {
    readonly onPlayerDefeat: 'latest-checkpoint';
    readonly onCriticalActorLost: 'latest-checkpoint';
    readonly onAbandon: 'mission-start';
  };
  readonly timeOverride?: 'dawn' | 'day' | 'evening' | 'night';
  readonly weatherOverride?: 'clear' | 'rain';
  readonly cleanupFlags: readonly string[];
}

export interface DialogueEntry {
  readonly key: string;
  readonly missionId: MissionId;
  readonly speaker: 'alex' | 'juno' | 'malik' | 'priya' | 'dispatch' | 'system';
  readonly channel: 'conversation' | 'phone' | 'radio' | 'subtitle' | 'mission-log';
  readonly text: string;
  /** Optional authored branch guard. Unguarded entries belong to every story path. */
  readonly branch?: 'rule' | 'expose';
}

export type AttributeId = 'grit' | 'aim' | 'handling' | 'nerve' | 'hustle';

export interface AttributeDefinition {
  readonly id: AttributeId;
  readonly name: string;
  readonly description: string;
  readonly minimum: 1;
  readonly maximum: 6;
  readonly effectsPerAddedPoint: readonly {
    readonly stat: string;
    readonly amount: number;
    readonly unit: 'flat' | 'percent';
  }[];
}

export type SkillTreeId = 'combat' | 'driving' | 'streetcraft';

export interface SkillEffect {
  readonly stat: string;
  readonly operation: 'add' | 'multiply' | 'unlock';
  readonly value: number | string;
}

export interface SkillNodeDefinition {
  readonly id: string;
  readonly tree: SkillTreeId;
  readonly name: string;
  readonly description: string;
  readonly tier: 1 | 2 | 3;
  readonly cost: 1;
  readonly requiredNodesInTree: 0 | 2 | 5;
  readonly capstone: boolean;
  readonly exclusiveWith: string | null;
  readonly effects: readonly SkillEffect[];
}

export type VehicleClassId =
  | 'compact'
  | 'sedan'
  | 'muscle'
  | 'sports'
  | 'van'
  | 'pickup'
  | 'police-cruiser'
  | 'motorcycle';

export interface VehicleArcadeHandlingDefinition {
  /** Maximum authored reverse speed. Forward speed remains `topSpeedKph`. */
  readonly reverseSpeedKph: number;
  readonly brakeDecelerationMetersPerSecondSquared: number;
  readonly handbrakeDecelerationMetersPerSecondSquared: number;
  /** Rate at which steering input approaches the requested value. */
  readonly steeringResponsePerSecond: number;
  readonly turnRateRadiansPerSecond: number;
  /** Steering authority retained at maximum speed, in the range (0, 1]. */
  readonly highSpeedSteeringFactor: number;
  readonly handbrakeTurnMultiplier: number;
  readonly collisionRadiusMeters: number;
  readonly collisionWidthMeters: number;
  readonly collisionLengthMeters: number;
  readonly wheelbaseMeters: number;
  readonly trackWidthMeters: number;
  readonly rideHeightMeters: number;
  readonly suspensionTravelMeters: number;
}

export interface VehicleDefinition {
  readonly id: VehicleClassId;
  readonly name: string;
  readonly description: string;
  readonly accelerationMetersPerSecondSquared: number;
  readonly topSpeedKph: number;
  readonly massKg: number;
  readonly grip: number;
  readonly turnResponse: number;
  readonly durability: number;
  readonly arcadeHandling: VehicleArcadeHandlingDefinition;
  readonly cargoGrid: { readonly columns: number; readonly rows: number };
  readonly seats: number;
  readonly registerable: boolean;
  readonly baseValue: number;
  readonly trafficWeightByDistrict: Readonly<Record<DistrictId, number>>;
}

export type WeaponClassId = 'melee' | 'pistol' | 'smg' | 'shotgun' | 'rifle';
export type WeaponTier = 1 | 2 | 3;
export type AmmoCaliberId = 'handgun-rounds' | 'smg-rounds' | 'shotgun-shells' | 'rifle-rounds';

export interface WeaponDefinition {
  readonly id: string;
  readonly classId: WeaponClassId;
  readonly tier: WeaponTier;
  readonly name: string;
  readonly description: string;
  readonly damage: number;
  readonly recoil: number;
  readonly capacity: number;
  readonly durability: number;
  readonly value: number;
  readonly fireRatePerSecond: number;
  readonly rangeMeters: number;
  readonly ammoCaliber: AmmoCaliberId | null;
  readonly suppressed: boolean;
}

export type ItemCategory =
  | 'weapon'
  | 'ammo'
  | 'armor'
  | 'consumable'
  | 'component'
  | 'attachment'
  | 'contraband'
  | 'quest';

export interface ItemDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: ItemCategory;
  readonly shape: { readonly width: number; readonly height: number };
  readonly weightKg: number;
  readonly maximumStack: number;
  readonly baseValue: number;
  readonly hasDurability: boolean;
  readonly discardable: boolean;
  readonly weaponId?: string;
  readonly ammoCaliber?: AmmoCaliberId;
}

export interface RecipeIngredient {
  readonly itemId: string;
  readonly quantity: number;
}

export interface RecipeDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly bench: 'safehouse';
  readonly ingredients: readonly RecipeIngredient[];
  readonly output: ItemGrant;
  readonly craftSeconds: number;
}

export type PropertyId =
  | 'breakwater-warehouse'
  | 'neon-strand-club'
  | 'alta-vista-print-shop'
  | 'arroyo-diner'
  | 'coastline-car-wash';

export interface PropertyDefinition {
  readonly id: PropertyId;
  readonly name: string;
  readonly district: DistrictId;
  readonly description: string;
  readonly purchasePrice: number;
  readonly basePayout: number;
  readonly payoutCap: 3;
  readonly upgrade: {
    readonly name: string;
    readonly cost: number;
    readonly payoutMultiplier: 1.5;
    readonly perkMultiplier: 1.5;
  };
  readonly perks: readonly {
    readonly stat: string;
    readonly amount: number;
    readonly unit: 'flat' | 'percent';
    readonly description: string;
  }[];
}

export type ActivityTypeId =
  | 'street-race'
  | 'courier-run'
  | 'vehicle-theft-list'
  | 'bounty-hunt'
  | 'property-defense';

export interface ActivityDifficulty {
  readonly id: 'rookie' | 'professional' | 'legend';
  readonly levelRequirement: number;
  readonly rewardMultiplier: number;
  readonly targetMultiplier: number;
}

export interface ActivityDefinition {
  readonly id: ActivityTypeId;
  readonly name: string;
  readonly description: string;
  /** Mission/world flag that makes this activity available in free roam. */
  readonly unlockFlag: `activity-${ActivityTypeId}`;
  readonly scoring: 'lowest-time' | 'highest-score';
  readonly baseCash: number;
  readonly baseXp: number;
  readonly cooldownMinutes: number;
  readonly variantSeedSalt: number;
  /** Number of deterministic layouts addressable by the activity seed. */
  readonly variantCount: number;
  readonly districts: readonly DistrictId[];
  readonly difficulties: readonly ActivityDifficulty[];
  readonly objectiveTemplate: readonly ObjectiveType[];
}

export type CollectibleCategoryId = 'salvage-cache' | 'stunt-jump' | 'signal-node';

export interface CollectibleDefinition {
  readonly id: string;
  readonly category: CollectibleCategoryId;
  readonly ordinal: number;
  readonly name: string;
  readonly district: DistrictId;
  readonly position: WorldPosition;
  readonly revealRule: 'nearby' | 'road-survey' | 'signal-scan';
  readonly reward: {
    readonly xp: number;
    readonly cash: number;
    readonly items: readonly ItemGrant[];
  };
}

export interface CollectibleSetDefinition {
  readonly category: CollectibleCategoryId;
  readonly count: number;
  readonly completionReward: {
    readonly xp: number;
    readonly cash: number;
    readonly unlockFlag: string;
  };
}

export interface RadioTrackDefinition {
  readonly id: string;
  readonly title: string;
  readonly bpm: number;
  readonly durationSeconds: number;
  readonly seed: number;
  readonly scale: string;
  readonly layers: readonly string[];
}

export interface RadioStationDefinition {
  readonly id: string;
  readonly name: string;
  readonly genre: 'electronic' | 'beat' | 'garage-rock';
  readonly description: string;
  readonly tracks: readonly RadioTrackDefinition[];
}
