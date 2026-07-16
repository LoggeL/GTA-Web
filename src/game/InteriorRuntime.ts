import { cellIdAt } from '../navigation/cells';
import type { CellId, ChunkInteriorPortal } from '../navigation/types';
import type { CollisionRect } from './city';
import type { DistrictId, PlayerMode, Vec3Data } from './types';

export const INTERIOR_RUNTIME_SNAPSHOT_VERSION = 1 as const;
export const DEFAULT_INTERIOR_TRANSITION_MILLISECONDS = 180;

export type InteriorId =
  | 'moreno-garage'
  | 'juno-grid'
  | 'malik-office'
  | 'priya-workshop'
  | 'syndicate-tower';

export type InteriorRuntimePhase =
  | 'exterior'
  | 'loading-enter'
  | 'interior'
  | 'loading-exit';

export interface InteriorTransform {
  readonly position: Vec3Data;
  readonly heading: number;
}

export interface InteriorActorState {
  readonly position: Vec3Data;
  readonly heading: number;
  readonly mode: PlayerMode;
  readonly grounded: boolean;
  /**
   * Last collision-safe exterior transform. When omitted, the portal's
   * authored safe return transform is used instead.
   */
  readonly safeExteriorTransform?: InteriorTransform;
}

export interface InteriorVisualRecipe {
  readonly id: string;
  readonly primitive: 'box' | 'plane' | 'cylinder';
  readonly position: Vec3Data;
  readonly size: Vec3Data;
  readonly rotationY: number;
  readonly color: number;
  readonly emissiveColor?: number;
}

export interface InteriorSceneRecipe {
  readonly id: InteriorId;
  readonly label: string;
  readonly bounds: {
    readonly width: number;
    readonly depth: number;
    readonly height: number;
  };
  readonly entrySpawn: InteriorTransform;
  readonly exitPosition: Vec3Data;
  readonly exitInteractionRadiusMeters: number;
  readonly collisions: readonly CollisionRect[];
  readonly visuals: readonly InteriorVisualRecipe[];
}

export interface InteriorPortalDefinition extends ChunkInteriorPortal {
  readonly interiorId: InteriorId;
  readonly label: string;
  readonly prompt: string;
  readonly district: DistrictId;
  readonly cellId: CellId;
  readonly interactionRadiusMeters: number;
  readonly safeExteriorTransform: InteriorTransform;
}

export interface InteriorDefinition {
  readonly id: InteriorId;
  readonly portal: InteriorPortalDefinition;
  readonly scene: InteriorSceneRecipe;
}

export type InteriorEligibilityReason =
  | 'eligible'
  | 'unknown-portal'
  | 'busy'
  | 'already-inside'
  | 'not-inside'
  | 'wrong-interior'
  | 'vehicle'
  | 'airborne'
  | 'too-far'
  | 'locked'
  | 'invalid-actor';

export interface InteriorInteractionEligibility {
  readonly eligible: boolean;
  readonly reason: InteriorEligibilityReason;
  readonly portalId: string | null;
  readonly interiorId: InteriorId | null;
  readonly prompt: string | null;
  readonly distanceMeters: number | null;
}

export interface InteriorRuntimeSnapshotV1 {
  readonly schemaVersion: typeof INTERIOR_RUNTIME_SNAPSHOT_VERSION;
  readonly phase: InteriorRuntimePhase;
  readonly currentInteriorId: InteriorId | null;
  readonly activePortalId: string | null;
  readonly exteriorReturnTransform: InteriorTransform | null;
  readonly lastError: string | null;
}

export type InteriorLoadDirection = 'enter' | 'exit';

export interface InteriorLoadRequest {
  readonly direction: InteriorLoadDirection;
  readonly definition: InteriorDefinition;
}

export type InteriorSceneLoader = (
  request: Readonly<InteriorLoadRequest>,
) => Promise<void>;

export type InteriorTransitionWait = (milliseconds: number) => Promise<void>;

export interface InteriorRuntimeOptions {
  readonly definitions?: readonly InteriorDefinition[];
  readonly loadScene?: InteriorSceneLoader;
  readonly wait?: InteriorTransitionWait;
  readonly minimumTransitionMilliseconds?: number;
  readonly isPortalUnlocked?: (
    definition: Readonly<InteriorDefinition>,
  ) => boolean;
}

export type InteriorTransitionFailureReason =
  | Exclude<InteriorEligibilityReason, 'eligible'>
  | 'load-failed'
  | 'interrupted';

export type InteriorTransitionResult =
  | {
    readonly success: true;
    readonly phase: 'interior' | 'exterior';
    readonly interiorId: InteriorId | null;
    readonly transform: InteriorTransform;
    readonly recovered: false;
  }
  | {
    readonly success: false;
    readonly phase: InteriorRuntimePhase;
    readonly interiorId: InteriorId | null;
    readonly reason: InteriorTransitionFailureReason;
    readonly error: string | null;
    readonly recoveryTransform: InteriorTransform | null;
    readonly recovered: boolean;
  };

export type InteriorRestoreResult =
  | {
    readonly success: true;
    readonly recovered: boolean;
    readonly recoveryTransform: InteriorTransform | null;
  }
  | {
    readonly success: false;
    readonly reason: string;
    readonly recovered: false;
    readonly recoveryTransform: null;
  };

interface FixtureRecipe {
  readonly id: string;
  readonly primitive?: InteriorVisualRecipe['primitive'];
  readonly position: Vec3Data;
  readonly size: Vec3Data;
  readonly color: number;
  readonly emissiveColor?: number;
  readonly collision?: boolean;
}

interface SceneAuthoring {
  readonly id: InteriorId;
  readonly label: string;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly floorColor: number;
  readonly wallColor: number;
  readonly accentColor: number;
  readonly fixtures: readonly FixtureRecipe[];
}

const WALL_THICKNESS = 0.45;

function visual(
  id: string,
  primitive: InteriorVisualRecipe['primitive'],
  position: Vec3Data,
  size: Vec3Data,
  color: number,
  emissiveColor?: number,
): InteriorVisualRecipe {
  return {
    id,
    primitive,
    position: { ...position },
    size: { ...size },
    rotationY: 0,
    color,
    ...(emissiveColor === undefined ? {} : { emissiveColor }),
  };
}

function roomCollisions(
  id: InteriorId,
  width: number,
  depth: number,
  height: number,
): CollisionRect[] {
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  return [
    {
      id: `${id}:wall-west`,
      minX: -halfWidth - WALL_THICKNESS,
      maxX: -halfWidth,
      minZ: -halfDepth,
      maxZ: halfDepth,
      height,
      kind: 'solid',
    },
    {
      id: `${id}:wall-east`,
      minX: halfWidth,
      maxX: halfWidth + WALL_THICKNESS,
      minZ: -halfDepth,
      maxZ: halfDepth,
      height,
      kind: 'solid',
    },
    {
      id: `${id}:wall-north`,
      minX: -halfWidth,
      maxX: halfWidth,
      minZ: -halfDepth - WALL_THICKNESS,
      maxZ: -halfDepth,
      height,
      kind: 'solid',
    },
    {
      id: `${id}:wall-south-left`,
      minX: -halfWidth,
      maxX: -1.4,
      minZ: halfDepth,
      maxZ: halfDepth + WALL_THICKNESS,
      height,
      kind: 'solid',
    },
    {
      id: `${id}:wall-south-right`,
      minX: 1.4,
      maxX: halfWidth,
      minZ: halfDepth,
      maxZ: halfDepth + WALL_THICKNESS,
      height,
      kind: 'solid',
    },
  ];
}

function buildScene(authoring: Readonly<SceneAuthoring>): InteriorSceneRecipe {
  const halfWidth = authoring.width / 2;
  const halfDepth = authoring.depth / 2;
  const collisions = roomCollisions(
    authoring.id,
    authoring.width,
    authoring.depth,
    authoring.height,
  );
  const visuals: InteriorVisualRecipe[] = [
    visual(
      `${authoring.id}:floor`,
      'box',
      { x: 0, y: -0.1, z: 0 },
      { x: authoring.width, y: 0.2, z: authoring.depth },
      authoring.floorColor,
    ),
    visual(
      `${authoring.id}:wall-west`,
      'box',
      { x: -halfWidth, y: authoring.height / 2, z: 0 },
      { x: WALL_THICKNESS, y: authoring.height, z: authoring.depth },
      authoring.wallColor,
    ),
    visual(
      `${authoring.id}:wall-east`,
      'box',
      { x: halfWidth, y: authoring.height / 2, z: 0 },
      { x: WALL_THICKNESS, y: authoring.height, z: authoring.depth },
      authoring.wallColor,
    ),
    visual(
      `${authoring.id}:wall-north`,
      'box',
      { x: 0, y: authoring.height / 2, z: -halfDepth },
      { x: authoring.width, y: authoring.height, z: WALL_THICKNESS },
      authoring.wallColor,
    ),
    visual(
      `${authoring.id}:accent`,
      'plane',
      { x: 0, y: authoring.height - 0.5, z: -halfDepth + 0.24 },
      { x: authoring.width * 0.55, y: 0.18, z: 1 },
      authoring.accentColor,
      authoring.accentColor,
    ),
  ];

  for (const fixture of authoring.fixtures) {
    visuals.push(visual(
      `${authoring.id}:${fixture.id}`,
      fixture.primitive ?? 'box',
      fixture.position,
      fixture.size,
      fixture.color,
      fixture.emissiveColor,
    ));
    if (fixture.collision === true) {
      collisions.push({
        id: `${authoring.id}:${fixture.id}`,
        minX: fixture.position.x - fixture.size.x / 2,
        maxX: fixture.position.x + fixture.size.x / 2,
        minZ: fixture.position.z - fixture.size.z / 2,
        maxZ: fixture.position.z + fixture.size.z / 2,
        height: fixture.position.y + fixture.size.y / 2,
        kind: 'solid',
      });
    }
  }

  return {
    id: authoring.id,
    label: authoring.label,
    bounds: {
      width: authoring.width,
      depth: authoring.depth,
      height: authoring.height,
    },
    entrySpawn: {
      position: { x: 0, y: 0, z: halfDepth - 2.1 },
      heading: 0,
    },
    exitPosition: { x: 0, y: 0, z: halfDepth - 1.05 },
    exitInteractionRadiusMeters: 1.65,
    collisions,
    visuals,
  };
}

const SCENES: Readonly<Record<InteriorId, InteriorSceneRecipe>> = {
  'moreno-garage': buildScene({
    id: 'moreno-garage',
    label: 'Moreno Garage',
    width: 20,
    depth: 16,
    height: 5.4,
    floorColor: 0x273137,
    wallColor: 0x52656a,
    accentColor: 0xef7048,
    fixtures: [
      { id: 'workbench', position: { x: -6.5, y: 0.65, z: -5.2 }, size: { x: 4.2, y: 1.3, z: 1.2 }, color: 0xb86d42, collision: true },
      { id: 'lift', position: { x: 4.8, y: 0.18, z: -1 }, size: { x: 5.2, y: 0.36, z: 7 }, color: 0xd3a544 },
      { id: 'office', position: { x: -6.6, y: 1.4, z: 2 }, size: { x: 4.5, y: 2.8, z: 3.8 }, color: 0x2e8d91, collision: true },
    ],
  }),
  'juno-grid': buildScene({
    id: 'juno-grid',
    label: "Juno's Grid",
    width: 16,
    depth: 13,
    height: 4.8,
    floorColor: 0x1d2930,
    wallColor: 0x334b55,
    accentColor: 0xff4fa3,
    fixtures: [
      { id: 'route-table', position: { x: 0, y: 0.75, z: -1.2 }, size: { x: 4.6, y: 1.5, z: 2.4 }, color: 0x235d6d, emissiveColor: 0x3fd8e3, collision: true },
      { id: 'server-west', position: { x: -6.2, y: 1.5, z: -3.8 }, size: { x: 1.3, y: 3, z: 2.1 }, color: 0x713f78, collision: true },
      { id: 'server-east', position: { x: 6.2, y: 1.5, z: -3.8 }, size: { x: 1.3, y: 3, z: 2.1 }, color: 0x713f78, collision: true },
    ],
  }),
  'malik-office': buildScene({
    id: 'malik-office',
    label: "Malik's Office",
    width: 15,
    depth: 12,
    height: 4.4,
    floorColor: 0x453b34,
    wallColor: 0x776b61,
    accentColor: 0xf2bd63,
    fixtures: [
      { id: 'desk', position: { x: 0, y: 0.7, z: -3.4 }, size: { x: 4.5, y: 1.4, z: 1.8 }, color: 0x71472e, collision: true },
      { id: 'ledger-case', position: { x: 5.8, y: 1.1, z: -2.2 }, size: { x: 1.5, y: 2.2, z: 3 }, color: 0x2c3335, emissiveColor: 0xe5b15d, collision: true },
      { id: 'meeting-table', position: { x: -3.7, y: 0.65, z: 0.6 }, size: { x: 3.1, y: 1.3, z: 2.2 }, color: 0x624735, collision: true },
    ],
  }),
  'priya-workshop': buildScene({
    id: 'priya-workshop',
    label: "Priya's Workshop",
    width: 17,
    depth: 14,
    height: 5,
    floorColor: 0x263a3b,
    wallColor: 0x476a69,
    accentColor: 0x4ce0c1,
    fixtures: [
      { id: 'electronics-bench', position: { x: -5.6, y: 0.7, z: -3.8 }, size: { x: 3.7, y: 1.4, z: 1.4 }, color: 0x2c6970, emissiveColor: 0x45d5cf, collision: true },
      { id: 'signal-console', position: { x: 3.8, y: 1.1, z: -4.8 }, size: { x: 4.2, y: 2.2, z: 1.1 }, color: 0x314e58, emissiveColor: 0x56bdf0, collision: true },
      { id: 'antenna-rig', primitive: 'cylinder', position: { x: 5.9, y: 1.5, z: 1.2 }, size: { x: 1.8, y: 3, z: 1.8 }, color: 0xa7b9ad, collision: true },
    ],
  }),
  'syndicate-tower': buildScene({
    id: 'syndicate-tower',
    label: 'Syndicate Command Tower',
    width: 19,
    depth: 15,
    height: 5.8,
    floorColor: 0x20272e,
    wallColor: 0x46535f,
    accentColor: 0xff6d4f,
    fixtures: [
      { id: 'security-desk', position: { x: 0, y: 0.75, z: 0.4 }, size: { x: 5.5, y: 1.5, z: 2 }, color: 0x333e48, emissiveColor: 0xef7048, collision: true },
      { id: 'lift-bank', position: { x: 0, y: 1.9, z: -6.2 }, size: { x: 6.5, y: 3.8, z: 0.8 }, color: 0x667581, emissiveColor: 0xf5b45d, collision: true },
      { id: 'terminal-west', position: { x: -7.2, y: 1.1, z: -2.8 }, size: { x: 1.7, y: 2.2, z: 2.6 }, color: 0x293944, emissiveColor: 0x54c9e8, collision: true },
      { id: 'terminal-east', position: { x: 7.2, y: 1.1, z: -2.8 }, size: { x: 1.7, y: 2.2, z: 2.6 }, color: 0x293944, emissiveColor: 0x54c9e8, collision: true },
    ],
  }),
};

interface PortalAuthoring {
  readonly id: string;
  readonly interiorId: InteriorId;
  readonly label: string;
  readonly prompt: string;
  readonly district: DistrictId;
  readonly position: Vec3Data;
  readonly safePosition: Vec3Data;
  readonly safeHeading: number;
}

const PORTAL_AUTHORING: readonly PortalAuthoring[] = [
  {
    id: 'moreno-garage-entry',
    interiorId: 'moreno-garage',
    label: 'Moreno Garage',
    prompt: 'Enter Moreno Garage',
    district: 'arroyo-heights',
    position: { x: -243.7, y: 0, z: 244.7 },
    safePosition: { x: -245.5, y: 0, z: 244.7 },
    safeHeading: -Math.PI / 2,
  },
  {
    id: 'juno-grid-entry',
    interiorId: 'juno-grid',
    label: "Juno's Grid",
    prompt: "Enter Juno's Grid",
    district: 'neon-strand',
    position: { x: -350, y: 0, z: -350 },
    safePosition: { x: -350, y: 0, z: -347.5 },
    safeHeading: 0,
  },
  {
    id: 'malik-office-entry',
    interiorId: 'malik-office',
    label: "Malik's Office",
    prompt: "Enter Malik's Office",
    district: 'alta-vista',
    position: { x: 350, y: 0, z: -350 },
    safePosition: { x: 347.5, y: 0, z: -350 },
    safeHeading: -Math.PI / 2,
  },
  {
    id: 'priya-workshop-entry',
    interiorId: 'priya-workshop',
    label: "Priya's Workshop",
    prompt: "Enter Priya's Workshop",
    district: 'breakwater',
    position: { x: 350, y: 0, z: 350 },
    safePosition: { x: 350, y: 0, z: 347.5 },
    safeHeading: 0,
  },
  {
    id: 'syndicate-command-tower-entry',
    interiorId: 'syndicate-tower',
    label: 'Syndicate Command Tower',
    prompt: 'Enter the command tower',
    district: 'alta-vista',
    position: { x: 284, y: 0, z: -126 },
    safePosition: { x: 281.5, y: 0, z: -126 },
    safeHeading: -Math.PI / 2,
  },
] as const;

function buildDefinition(authoring: Readonly<PortalAuthoring>): InteriorDefinition {
  const portal: InteriorPortalDefinition = {
    id: authoring.id,
    interiorId: authoring.interiorId,
    label: authoring.label,
    prompt: authoring.prompt,
    district: authoring.district,
    position: { ...authoring.position },
    cellId: cellIdAt(authoring.position),
    interactionRadiusMeters: 2.4,
    safeExteriorTransform: {
      position: { ...authoring.safePosition },
      heading: authoring.safeHeading,
    },
  };
  return {
    id: authoring.interiorId,
    portal,
    scene: SCENES[authoring.interiorId],
  };
}

/** Authored in stable story order for deterministic map and chunk integration. */
export const AUTHORED_INTERIORS: readonly InteriorDefinition[] = Object.freeze(
  PORTAL_AUTHORING.map(buildDefinition),
);

function cloneTransform(transform: Readonly<InteriorTransform>): InteriorTransform {
  return {
    position: { ...transform.position },
    heading: transform.heading,
  };
}

function distanceXZ(left: Readonly<Vec3Data>, right: Readonly<Vec3Data>): number {
  return Math.hypot(right.x - left.x, right.z - left.z);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteVec3(value: unknown): value is Vec3Data {
  return isRecord(value)
    && typeof value.x === 'number'
    && Number.isFinite(value.x)
    && typeof value.y === 'number'
    && Number.isFinite(value.y)
    && typeof value.z === 'number'
    && Number.isFinite(value.z);
}

function isTransform(value: unknown): value is InteriorTransform {
  return isRecord(value)
    && isFiniteVec3(value.position)
    && typeof value.heading === 'number'
    && Number.isFinite(value.heading);
}

function isActorValid(actor: Readonly<InteriorActorState>): boolean {
  return isFiniteVec3(actor.position)
    && Number.isFinite(actor.heading)
    && (actor.mode === 'on-foot' || actor.mode === 'vehicle')
    && typeof actor.grounded === 'boolean'
    && (actor.safeExteriorTransform === undefined
      || isTransform(actor.safeExteriorTransform));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function emptyEligibility(
  reason: InteriorEligibilityReason,
): InteriorInteractionEligibility {
  return {
    eligible: false,
    reason,
    portalId: null,
    interiorId: null,
    prompt: null,
    distanceMeters: null,
  };
}

function validateSnapshot(
  value: unknown,
  definitionsById: ReadonlyMap<InteriorId, InteriorDefinition>,
  definitionsByPortal: ReadonlyMap<string, InteriorDefinition>,
): { success: true; snapshot: InteriorRuntimeSnapshotV1 } | { success: false; reason: string } {
  if (!isRecord(value) || value.schemaVersion !== INTERIOR_RUNTIME_SNAPSHOT_VERSION) {
    return { success: false, reason: 'interior snapshot version is unsupported' };
  }
  const phases: readonly InteriorRuntimePhase[] = [
    'exterior',
    'loading-enter',
    'interior',
    'loading-exit',
  ];
  if (!phases.includes(value.phase as InteriorRuntimePhase)) {
    return { success: false, reason: 'interior snapshot phase is invalid' };
  }
  if (value.lastError !== null && typeof value.lastError !== 'string') {
    return { success: false, reason: 'interior snapshot error is invalid' };
  }

  const phase = value.phase as InteriorRuntimePhase;
  const currentInteriorId = value.currentInteriorId as InteriorId | null;
  const activePortalId = value.activePortalId as string | null;
  const exteriorReturnTransform = value.exteriorReturnTransform;
  const isExterior = phase === 'exterior';
  if (isExterior) {
    if (
      currentInteriorId !== null
      || activePortalId !== null
      || exteriorReturnTransform !== null
    ) {
      return { success: false, reason: 'exterior snapshot contains interior transition state' };
    }
  } else {
    if (typeof activePortalId !== 'string' || !definitionsByPortal.has(activePortalId)) {
      return { success: false, reason: 'interior snapshot portal is unknown' };
    }
    if (!isTransform(exteriorReturnTransform)) {
      return { success: false, reason: 'interior snapshot return transform is invalid' };
    }
    const definition = definitionsByPortal.get(activePortalId);
    if (!definition) {
      return { success: false, reason: 'interior snapshot portal is unknown' };
    }
    if (phase === 'loading-enter') {
      if (currentInteriorId !== null) {
        return { success: false, reason: 'enter snapshot cannot already be inside' };
      }
    } else if (
      typeof currentInteriorId !== 'string'
      || !definitionsById.has(currentInteriorId)
      || definition.id !== currentInteriorId
    ) {
      return { success: false, reason: 'interior snapshot scene and portal do not match' };
    }
  }

  return {
    success: true,
    snapshot: {
      schemaVersion: INTERIOR_RUNTIME_SNAPSHOT_VERSION,
      phase,
      currentInteriorId,
      activePortalId,
      exteriorReturnTransform: isTransform(exteriorReturnTransform)
        ? cloneTransform(exteriorReturnTransform)
        : null,
      lastError: value.lastError as string | null,
    },
  };
}

/**
 * Deterministic interior transition state. The caller owns Three.js scene
 * creation and player teleportation; this runtime owns eligibility, loading,
 * safe recovery, and persistence.
 */
export class InteriorRuntime {
  readonly definitions: readonly InteriorDefinition[];
  readonly #definitionsById = new Map<InteriorId, InteriorDefinition>();
  readonly #definitionsByPortal = new Map<string, InteriorDefinition>();
  readonly #loadScene: InteriorSceneLoader;
  readonly #wait: InteriorTransitionWait;
  readonly #minimumTransitionMilliseconds: number;
  readonly #isPortalUnlocked: (
    definition: Readonly<InteriorDefinition>,
  ) => boolean;
  #phase: InteriorRuntimePhase = 'exterior';
  #currentInteriorId: InteriorId | null = null;
  #activePortalId: string | null = null;
  #exteriorReturnTransform: InteriorTransform | null = null;
  #lastError: string | null = null;
  #transitionRevision = 0;

  public constructor(options: InteriorRuntimeOptions = {}) {
    const definitions = options.definitions ?? AUTHORED_INTERIORS;
    if (definitions.length === 0) {
      throw new RangeError('InteriorRuntime requires at least one definition');
    }
    this.definitions = [...definitions];
    for (const definition of definitions) {
      if (
        this.#definitionsById.has(definition.id)
        || this.#definitionsByPortal.has(definition.portal.id)
      ) {
        throw new Error(`Duplicate interior definition: ${definition.id}`);
      }
      if (definition.id !== definition.scene.id || definition.id !== definition.portal.interiorId) {
        throw new Error(`Interior definition identity mismatch: ${definition.id}`);
      }
      this.#definitionsById.set(definition.id, definition);
      this.#definitionsByPortal.set(definition.portal.id, definition);
    }
    const duration = options.minimumTransitionMilliseconds
      ?? DEFAULT_INTERIOR_TRANSITION_MILLISECONDS;
    if (!Number.isFinite(duration) || duration < 0) {
      throw new RangeError('minimumTransitionMilliseconds must be finite and non-negative');
    }
    this.#minimumTransitionMilliseconds = duration;
    this.#loadScene = options.loadScene ?? (async () => undefined);
    this.#wait = options.wait ?? defaultWait;
    this.#isPortalUnlocked = options.isPortalUnlocked ?? (() => true);
  }

  public get phase(): InteriorRuntimePhase {
    return this.#phase;
  }

  public get currentInteriorId(): InteriorId | null {
    return this.#currentInteriorId;
  }

  public get currentDefinition(): InteriorDefinition | null {
    return this.#currentInteriorId
      ? (this.#definitionsById.get(this.#currentInteriorId) ?? null)
      : null;
  }

  public definitionForPortal(portalId: string): InteriorDefinition | null {
    return this.#definitionsByPortal.get(portalId) ?? null;
  }

  public evaluatePortal(
    portalId: string,
    actor: Readonly<InteriorActorState>,
  ): InteriorInteractionEligibility {
    const definition = this.#definitionsByPortal.get(portalId);
    if (!definition) return emptyEligibility('unknown-portal');
    return this.#evaluateDefinition(definition, actor);
  }

  public nearestEligiblePortal(
    actor: Readonly<InteriorActorState>,
    maximumDistanceMeters = Number.POSITIVE_INFINITY,
  ): InteriorInteractionEligibility | null {
    if (maximumDistanceMeters < 0 || Number.isNaN(maximumDistanceMeters)) {
      throw new RangeError('maximumDistanceMeters must be non-negative');
    }
    const eligible = this.definitions
      .map((definition) => this.#evaluateDefinition(definition, actor))
      .filter((result) => result.eligible
        && result.distanceMeters !== null
        && result.distanceMeters <= maximumDistanceMeters)
      .sort((left, right) => (
        (left.distanceMeters ?? 0) - (right.distanceMeters ?? 0)
        || (left.portalId ?? '').localeCompare(right.portalId ?? '')
      ));
    return eligible[0] ?? null;
  }

  public evaluateExit(
    actor: Readonly<InteriorActorState>,
  ): InteriorInteractionEligibility {
    if (this.#phase === 'loading-enter' || this.#phase === 'loading-exit') {
      return emptyEligibility('busy');
    }
    if (this.#phase !== 'interior' || !this.#currentInteriorId || !this.#activePortalId) {
      return emptyEligibility('not-inside');
    }
    if (!isActorValid(actor)) return emptyEligibility('invalid-actor');
    const definition = this.#definitionsById.get(this.#currentInteriorId);
    if (!definition) return emptyEligibility('wrong-interior');
    const distanceMeters = distanceXZ(actor.position, definition.scene.exitPosition);
    const base = {
      portalId: definition.portal.id,
      interiorId: definition.id,
      prompt: `Exit ${definition.scene.label}`,
      distanceMeters,
    };
    if (actor.mode === 'vehicle') return { ...base, eligible: false, reason: 'vehicle' };
    if (!actor.grounded) return { ...base, eligible: false, reason: 'airborne' };
    if (distanceMeters > definition.scene.exitInteractionRadiusMeters) {
      return { ...base, eligible: false, reason: 'too-far' };
    }
    return { ...base, eligible: true, reason: 'eligible' };
  }

  public async enter(
    portalId: string,
    actor: Readonly<InteriorActorState>,
  ): Promise<InteriorTransitionResult> {
    const eligibility = this.evaluatePortal(portalId, actor);
    if (!eligibility.eligible && eligibility.reason !== 'eligible') {
      return this.#eligibilityFailure(eligibility.reason);
    }
    const definition = this.#definitionsByPortal.get(portalId);
    if (!definition) return this.#eligibilityFailure('unknown-portal');

    const returnTransform = cloneTransform(
      actor.safeExteriorTransform ?? definition.portal.safeExteriorTransform,
    );
    this.#transitionRevision += 1;
    const revision = this.#transitionRevision;
    this.#phase = 'loading-enter';
    this.#activePortalId = portalId;
    this.#currentInteriorId = null;
    this.#exteriorReturnTransform = returnTransform;
    this.#lastError = null;

    const failure = await this.#runTransition('enter', definition);
    if (revision !== this.#transitionRevision) {
      return this.#interruptedFailure(returnTransform);
    }
    if (failure !== null) {
      this.#lastError = failure;
      this.#toExterior();
      return {
        success: false,
        phase: 'exterior',
        interiorId: null,
        reason: 'load-failed',
        error: failure,
        recoveryTransform: returnTransform,
        recovered: true,
      };
    }

    this.#phase = 'interior';
    this.#currentInteriorId = definition.id;
    return {
      success: true,
      phase: 'interior',
      interiorId: definition.id,
      transform: cloneTransform(definition.scene.entrySpawn),
      recovered: false,
    };
  }

  public async exit(
    actor: Readonly<InteriorActorState>,
  ): Promise<InteriorTransitionResult> {
    const eligibility = this.evaluateExit(actor);
    if (!eligibility.eligible && eligibility.reason !== 'eligible') {
      return this.#eligibilityFailure(eligibility.reason);
    }
    const definition = this.currentDefinition;
    const returnTransform = this.#exteriorReturnTransform
      ? cloneTransform(this.#exteriorReturnTransform)
      : null;
    if (!definition || !returnTransform) {
      return this.#eligibilityFailure('wrong-interior');
    }

    this.#transitionRevision += 1;
    const revision = this.#transitionRevision;
    this.#phase = 'loading-exit';
    const failure = await this.#runTransition('exit', definition);
    if (revision !== this.#transitionRevision) {
      return this.#interruptedFailure(returnTransform);
    }

    this.#lastError = failure;
    this.#toExterior();
    if (failure !== null) {
      return {
        success: false,
        phase: 'exterior',
        interiorId: null,
        reason: 'load-failed',
        error: failure,
        recoveryTransform: returnTransform,
        recovered: true,
      };
    }
    return {
      success: true,
      phase: 'exterior',
      interiorId: null,
      transform: returnTransform,
      recovered: false,
    };
  }

  public snapshot(): InteriorRuntimeSnapshotV1 {
    return {
      schemaVersion: INTERIOR_RUNTIME_SNAPSHOT_VERSION,
      phase: this.#phase,
      currentInteriorId: this.#currentInteriorId,
      activePortalId: this.#activePortalId,
      exteriorReturnTransform: this.#exteriorReturnTransform
        ? cloneTransform(this.#exteriorReturnTransform)
        : null,
      lastError: this.#lastError,
    };
  }

  public restore(value: unknown): InteriorRestoreResult {
    const validation = validateSnapshot(
      value,
      this.#definitionsById,
      this.#definitionsByPortal,
    );
    if (!validation.success) {
      return {
        success: false,
        reason: validation.reason,
        recovered: false,
        recoveryTransform: null,
      };
    }

    this.#transitionRevision += 1;
    const snapshot = validation.snapshot;
    if (snapshot.phase === 'loading-enter' || snapshot.phase === 'loading-exit') {
      const recoveryTransform = snapshot.exteriorReturnTransform
        ? cloneTransform(snapshot.exteriorReturnTransform)
        : null;
      this.#lastError = 'Interrupted interior transition recovered during restore';
      this.#toExterior();
      return { success: true, recovered: true, recoveryTransform };
    }

    this.#phase = snapshot.phase;
    this.#currentInteriorId = snapshot.currentInteriorId;
    this.#activePortalId = snapshot.activePortalId;
    this.#exteriorReturnTransform = snapshot.exteriorReturnTransform
      ? cloneTransform(snapshot.exteriorReturnTransform)
      : null;
    this.#lastError = snapshot.lastError;
    return { success: true, recovered: false, recoveryTransform: null };
  }

  #evaluateDefinition(
    definition: Readonly<InteriorDefinition>,
    actor: Readonly<InteriorActorState>,
  ): InteriorInteractionEligibility {
    const distanceMeters = isFiniteVec3(actor.position)
      ? distanceXZ(actor.position, definition.portal.position)
      : null;
    const base = {
      portalId: definition.portal.id,
      interiorId: definition.id,
      prompt: definition.portal.prompt,
      distanceMeters,
    };
    if (this.#phase === 'loading-enter' || this.#phase === 'loading-exit') {
      return { ...base, eligible: false, reason: 'busy' };
    }
    if (this.#phase === 'interior') {
      return { ...base, eligible: false, reason: 'already-inside' };
    }
    if (!isActorValid(actor)) return { ...base, eligible: false, reason: 'invalid-actor' };
    if (!this.#isPortalUnlocked(definition)) {
      return { ...base, eligible: false, reason: 'locked' };
    }
    if (actor.mode === 'vehicle') return { ...base, eligible: false, reason: 'vehicle' };
    if (!actor.grounded) return { ...base, eligible: false, reason: 'airborne' };
    if (distanceMeters === null || distanceMeters > definition.portal.interactionRadiusMeters) {
      return { ...base, eligible: false, reason: 'too-far' };
    }
    return { ...base, eligible: true, reason: 'eligible' };
  }

  async #runTransition(
    direction: InteriorLoadDirection,
    definition: InteriorDefinition,
  ): Promise<string | null> {
    const results = await Promise.allSettled([
      this.#wait(this.#minimumTransitionMilliseconds),
      this.#loadScene({ direction, definition }),
    ]);
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    return failed ? errorMessage(failed.reason) : null;
  }

  #toExterior(): void {
    this.#phase = 'exterior';
    this.#currentInteriorId = null;
    this.#activePortalId = null;
    this.#exteriorReturnTransform = null;
  }

  #eligibilityFailure(
    reason: Exclude<InteriorEligibilityReason, 'eligible'>,
  ): InteriorTransitionResult {
    return {
      success: false,
      phase: this.#phase,
      interiorId: this.#currentInteriorId,
      reason,
      error: null,
      recoveryTransform: null,
      recovered: false,
    };
  }

  #interruptedFailure(
    recoveryTransform: InteriorTransform,
  ): InteriorTransitionResult {
    return {
      success: false,
      phase: this.#phase,
      interiorId: this.#currentInteriorId,
      reason: 'interrupted',
      error: 'Interior transition was superseded by restored state',
      recoveryTransform,
      recovered: this.#phase === 'exterior',
    };
  }
}
