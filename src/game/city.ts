import { solaraDistrictAt } from '../core/districts';
import { SeededRandom, hashSeed } from './random';
import { AUTHORED_INTERIORS } from './InteriorRuntime';
import type { DistrictId, Vec3Data, WorldQuality } from './types';

export const CITY_SIZE = 1_200;
export const CITY_HALF_SIZE = CITY_SIZE / 2;
export const DISTRICT_SIZE = CITY_SIZE / 2;
export const PLAYER_SPAWN: Readonly<Vec3Data> = Object.freeze({ x: -208, y: 0, z: 244 });
export const VEHICLE_SPAWN: Readonly<Vec3Data> = Object.freeze({ x: -208, y: 0.48, z: 241 });
export const VEHICLE_SPAWN_HEADING = Math.PI / 2;

export interface DistrictBounds {
  id: DistrictId;
  label: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  groundColor: number;
  buildingColors: readonly number[];
  emissiveColor: number;
}

export interface BuildingRecipe {
  id: string;
  district: DistrictId;
  position: Vec3Data;
  width: number;
  depth: number;
  height: number;
  color: number;
  roofStyle: 'flat' | 'step' | 'spire';
  facadeStyle: 'art-deco' | 'glass-grid' | 'stucco-arcade' | 'warehouse-bay';
  storefrontStyle: 'awning' | 'lobby' | 'arcade' | 'loading-bay';
  roofFeature: 'neon-crown' | 'antenna' | 'terrace' | 'water-tank' | 'gantry' | 'vents';
  frontage: 'north' | 'east' | 'south' | 'west';
  accentColor: number;
  glassColor: number;
  landmark: boolean;
}

export interface RoadRecipe {
  id: string;
  district: DistrictId;
  position: Vec3Data;
  width: number;
  depth: number;
  major: boolean;
}

export type PropKind =
  | 'palm'
  | 'streetlight'
  | 'tree'
  | 'container'
  | 'bollard'
  | 'bench'
  | 'planter'
  | 'kiosk'
  | 'market-stall'
  | 'transit-shelter'
  | 'sculpture'
  | 'cargo-pallet'
  | 'pipe-stack';

export interface PropRecipe {
  id: string;
  district: DistrictId;
  kind: PropKind;
  position: Vec3Data;
  rotation: number;
  scale: number;
  color: number;
}

export interface CollisionRect {
  id?: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
  kind?: 'solid' | 'step' | 'vault';
}

export interface TraversalObstacleRecipe extends CollisionRect {
  id: string;
  kind: 'step' | 'vault';
  color: number;
}

export interface CityLayout {
  seed: number;
  quality: WorldQuality;
  buildings: readonly BuildingRecipe[];
  roads: readonly RoadRecipe[];
  props: readonly PropRecipe[];
  traversalObstacles: readonly TraversalObstacleRecipe[];
  collisions: readonly CollisionRect[];
}

/** Small authored course beside the Arroyo Heights spawn. */
export const TRAVERSAL_OBSTACLES: readonly TraversalObstacleRecipe[] = Object.freeze([
  {
    id: 'arroyo-course-step',
    minX: -237,
    maxX: -234,
    minZ: 246,
    maxZ: 250,
    height: 0.34,
    kind: 'step',
    color: 0xe6b65f,
  },
  {
    id: 'arroyo-course-vault',
    minX: -227,
    maxX: -224.8,
    minZ: 245,
    maxZ: 251,
    height: 0.92,
    kind: 'vault',
    color: 0xef7048,
  },
]);

export const DISTRICTS: readonly DistrictBounds[] = Object.freeze([
  {
    id: 'neon-strand',
    label: 'Neon Strand',
    minX: -600,
    maxX: 0,
    minZ: -600,
    maxZ: 0,
    groundColor: 0xb7aa75,
    buildingColors: [0x49b8b0, 0xff7356, 0xf5d76e, 0x8f6fb7],
    emissiveColor: 0xff4fa3,
  },
  {
    id: 'alta-vista',
    label: 'Alta Vista',
    minX: 0,
    maxX: 600,
    minZ: -600,
    maxZ: 0,
    groundColor: 0x768990,
    buildingColors: [0x6d8292, 0x9eb2b8, 0x6e7387, 0xd7aa67],
    emissiveColor: 0x5fc9ff,
  },
  {
    id: 'arroyo-heights',
    label: 'Arroyo Heights',
    minX: -600,
    maxX: 0,
    minZ: 0,
    maxZ: 600,
    groundColor: 0x7c9b6a,
    buildingColors: [0xe0a96d, 0xc86f54, 0xf0d29a, 0x7aa284],
    emissiveColor: 0xffa75c,
  },
  {
    id: 'breakwater',
    label: 'Breakwater',
    minX: 0,
    maxX: 600,
    minZ: 0,
    maxZ: 600,
    groundColor: 0x6f7772,
    buildingColors: [0x647078, 0x9b6c54, 0xc58c43, 0x586b68],
    emissiveColor: 0xffb12c,
  },
]);

const ROADS_PER_AXIS = 6;
const ROAD_SPACING = 100;
const LOCAL_ROAD_START = 50;
const ROAD_WIDTH = 18;
const MINIMUM_CURB_EDGE_CLEARANCE = 3.2;
const PEDESTRIAN_SIDEWALK_MAX_EDGE_CLEARANCE = 4.4;
const PEDESTRIAN_FOOTPRINT_RADIUS = 0.32;
const PEDESTRIAN_PROP_MARGIN = 0.18;
const BUILDING_ROAD_EDGE_SETBACK = 8.25;
const PROP_BUILDING_MARGIN = 0.2;
const PROP_PAIR_MARGIN = 0.15;
const PORTAL_BUILDING_MARGIN = 0.2;
const SAFE_EXTERIOR_PLAYER_RADIUS = 0.58;

const AUTHORED_EXTERIOR_CLEARANCE_ZONES = AUTHORED_INTERIORS.flatMap(
  (definition) => [
    {
      district: definition.portal.district,
      position: definition.portal.position,
      radius:
        definition.portal.interactionRadiusMeters + PORTAL_BUILDING_MARGIN,
    },
    {
      district: definition.portal.district,
      position: definition.portal.safeExteriorTransform.position,
      radius: SAFE_EXTERIOR_PLAYER_RADIUS + PORTAL_BUILDING_MARGIN,
    },
  ],
);

const AUTHORED_EXTERIOR_BUILDING_ZONES = AUTHORED_INTERIORS.map(
  (definition) => ({
    district: definition.portal.district,
    minX: definition.exteriorBuilding.position.x
      - definition.exteriorBuilding.width / 2,
    maxX: definition.exteriorBuilding.position.x
      + definition.exteriorBuilding.width / 2,
    minZ: definition.exteriorBuilding.position.z
      - definition.exteriorBuilding.depth / 2,
    maxZ: definition.exteriorBuilding.position.z
      + definition.exteriorBuilding.depth / 2,
  }),
);

function localRoadWidth(index: number): number {
  return index === 2 || index === 3 ? ROAD_WIDTH + 8 : ROAD_WIDTH;
}

const PROP_FOOTPRINT_HALF_EXTENTS = {
  palm: { along: 0.17, lateral: 0.17 },
  streetlight: { along: 0.065, lateral: 0.065 },
  tree: { along: 0.225, lateral: 0.225 },
  container: { along: 2.9, lateral: 1.225 },
  bollard: { along: 0.11, lateral: 0.11 },
  bench: { along: 1.2, lateral: 0.39 },
  planter: { along: 0.625, lateral: 0.625 },
  kiosk: { along: 1.45, lateral: 1.125 },
  'market-stall': { along: 1.7, lateral: 1.15 },
  'transit-shelter': { along: 2, lateral: 0.8 },
  sculpture: { along: 1.12, lateral: 1.12 },
  'cargo-pallet': { along: 1.175, lateral: 0.925 },
  'pipe-stack': { along: 1.35, lateral: 0.725 },
} as const satisfies Readonly<Record<
  PropKind,
  { readonly along: number; readonly lateral: number }
>>;

function propCurbEdgeClearance(kind: PropKind, scale: number): number {
  const pedestrianSafeClearance =
    PEDESTRIAN_SIDEWALK_MAX_EDGE_CLEARANCE
    + PEDESTRIAN_FOOTPRINT_RADIUS
    + PEDESTRIAN_PROP_MARGIN
    + PROP_FOOTPRINT_HALF_EXTENTS[kind].lateral * scale;
  return Math.max(MINIMUM_CURB_EDGE_CLEARANCE, pedestrianSafeClearance);
}

function stratifiedAcrossPosition(
  index: number,
  roadIndex: number,
  verticalRoad: boolean,
  count: number,
  rng: SeededRandom,
): number {
  const slotsPerPass = ROADS_PER_AXIS * 2;
  const strata = Math.max(1, Math.floor(count / slotsPerPass));
  const passIndex = Math.floor(index / slotsPerPass);
  const axisPhase = verticalRoad ? ROADS_PER_AXIS - 2 : ROADS_PER_AXIS - 1;
  const stratum = (passIndex + roadIndex + axisPhase) % strata;
  const usableLength = DISTRICT_SIZE - 50;
  const stratumWidth = usableLength / strata;
  const stratumCenter = 25 + (stratum + 0.5) * stratumWidth;
  const jitter = Math.min(18, stratumWidth * 0.1);
  return stratumCenter + rng.range(-jitter, jitter);
}

function propClearsPerpendicularRoads(
  across: number,
  kind: PropKind,
  scale: number,
): boolean {
  const halfAlong = PROP_FOOTPRINT_HALF_EXTENTS[kind].along * scale;
  for (let roadIndex = 0; roadIndex < ROADS_PER_AXIS; roadIndex += 1) {
    const roadCenter = LOCAL_ROAD_START + roadIndex * ROAD_SPACING;
    const pedestrianEnvelope =
      PEDESTRIAN_SIDEWALK_MAX_EDGE_CLEARANCE
      + PEDESTRIAN_FOOTPRINT_RADIUS
      + PEDESTRIAN_PROP_MARGIN;
    const requiredDistance =
      localRoadWidth(roadIndex) / 2 + pedestrianEnvelope + halfAlong;
    if (Math.abs(across - roadCenter) < requiredDistance) {
      return false;
    }
  }
  return across >= 25 && across <= DISTRICT_SIZE - 25;
}

function propClearsBuildings(
  x: number,
  z: number,
  verticalRoad: boolean,
  kind: PropKind,
  scale: number,
  buildings: readonly BuildingRecipe[],
): boolean {
  const footprint = PROP_FOOTPRINT_HALF_EXTENTS[kind];
  const halfX = (verticalRoad ? footprint.lateral : footprint.along) * scale;
  const halfZ = (verticalRoad ? footprint.along : footprint.lateral) * scale;
  return buildings.every((building) => (
    x + halfX + PROP_BUILDING_MARGIN <= building.position.x - building.width / 2
    || x - halfX - PROP_BUILDING_MARGIN >= building.position.x + building.width / 2
    || z + halfZ + PROP_BUILDING_MARGIN <= building.position.z - building.depth / 2
    || z - halfZ - PROP_BUILDING_MARGIN >= building.position.z + building.depth / 2
  ));
}

function propClearsPlacedProps(
  x: number,
  z: number,
  verticalRoad: boolean,
  kind: PropKind,
  scale: number,
  placedProps: readonly PropRecipe[],
): boolean {
  const footprint = PROP_FOOTPRINT_HALF_EXTENTS[kind];
  const halfX = (verticalRoad ? footprint.lateral : footprint.along) * scale;
  const halfZ = (verticalRoad ? footprint.along : footprint.lateral) * scale;
  return placedProps.every((placed) => {
    const placedFootprint = PROP_FOOTPRINT_HALF_EXTENTS[placed.kind];
    const placedVertical = placed.rotation === Math.PI / 2;
    const placedHalfX =
      (placedVertical ? placedFootprint.lateral : placedFootprint.along)
      * placed.scale;
    const placedHalfZ =
      (placedVertical ? placedFootprint.along : placedFootprint.lateral)
      * placed.scale;
    return (
      x + halfX + PROP_PAIR_MARGIN <= placed.position.x - placedHalfX
      || x - halfX - PROP_PAIR_MARGIN >= placed.position.x + placedHalfX
      || z + halfZ + PROP_PAIR_MARGIN <= placed.position.z - placedHalfZ
      || z - halfZ - PROP_PAIR_MARGIN >= placed.position.z + placedHalfZ
    );
  });
}

function findDistrictPropPosition(
  district: Readonly<DistrictBounds>,
  roadIndex: number,
  verticalRoad: boolean,
  preferredAcross: number,
  preferredSide: number,
  kind: PropKind,
  scale: number,
  buildings: readonly BuildingRecipe[],
  placedProps: readonly PropRecipe[],
): Vec3Data {
  const curbDistance =
    localRoadWidth(roadIndex) / 2 + propCurbEdgeClearance(kind, scale);
  const roadCenter =
    LOCAL_ROAD_START + roadIndex * ROAD_SPACING;
  const alongCandidates = [
    preferredAcross,
    ...Array.from({ length: 12 }, (_, index) => {
      const distance = (Math.floor(index / 2) + 1) * 12;
      return preferredAcross + (index % 2 === 0 ? -distance : distance);
    }),
    ...Array.from({ length: 5 }, (_, blockIndex) => 100 + blockIndex * ROAD_SPACING),
  ];
  const seenAcross = new Set<number>();
  for (const across of alongCandidates) {
    const roundedAcross = Math.round(across * 1_000_000) / 1_000_000;
    if (
      seenAcross.has(roundedAcross)
      || !propClearsPerpendicularRoads(across, kind, scale)
    ) {
      continue;
    }
    seenAcross.add(roundedAcross);
    for (const side of [preferredSide, -preferredSide]) {
      const lateral = roadCenter + side * curbDistance;
      const x = district.minX + (verticalRoad ? lateral : across);
      const z = district.minZ + (verticalRoad ? across : lateral);
      if (
        propClearsBuildings(x, z, verticalRoad, kind, scale, buildings)
        && propClearsPlacedProps(
          x,
          z,
          verticalRoad,
          kind,
          scale,
          placedProps,
        )
      ) {
        return { x, y: 0, z };
      }
    }
  }
  throw new Error(
    `Unable to place ${kind} beside ${district.id} road ${roadIndex}`,
  );
}

function districtHeightRange(district: DistrictId): readonly [number, number] {
  switch (district) {
    case 'neon-strand':
      return [12, 38];
    case 'alta-vista':
      return [34, 112];
    case 'arroyo-heights':
      return [8, 25];
    case 'breakwater':
      return [11, 44];
  }
}

const DISTRICT_PROP_KINDS = {
  'neon-strand': [
    'palm',
    'streetlight',
    'bench',
    'planter',
    'kiosk',
    'palm',
    'bench',
  ],
  'alta-vista': [
    'streetlight',
    'tree',
    'planter',
    'transit-shelter',
    'sculpture',
    'bench',
    'streetlight',
  ],
  'arroyo-heights': [
    'tree',
    'planter',
    'market-stall',
    'bench',
    'kiosk',
    'tree',
    'streetlight',
  ],
  breakwater: [
    'container',
    'bollard',
    'cargo-pallet',
    'pipe-stack',
    'streetlight',
    'container',
    'bollard',
  ],
} as const satisfies Readonly<Record<DistrictId, readonly PropKind[]>>;

function districtPropKind(
  district: DistrictId,
  rng: SeededRandom,
  index: number,
): PropKind {
  const palette = DISTRICT_PROP_KINDS[district];
  return index < palette.length ? palette[index] ?? rng.pick(palette) : rng.pick(palette);
}

function districtBuildingStyle(district: DistrictId): Pick<
  BuildingRecipe,
  'facadeStyle' | 'storefrontStyle'
> {
  switch (district) {
    case 'neon-strand':
      return { facadeStyle: 'art-deco', storefrontStyle: 'awning' };
    case 'alta-vista':
      return { facadeStyle: 'glass-grid', storefrontStyle: 'lobby' };
    case 'arroyo-heights':
      return { facadeStyle: 'stucco-arcade', storefrontStyle: 'arcade' };
    case 'breakwater':
      return { facadeStyle: 'warehouse-bay', storefrontStyle: 'loading-bay' };
  }
}

function districtRoofFeature(
  district: DistrictId,
  landmark: boolean,
  rng: SeededRandom,
): BuildingRecipe['roofFeature'] {
  if (landmark) {
    switch (district) {
      case 'neon-strand':
        return 'neon-crown';
      case 'alta-vista':
        return 'antenna';
      case 'arroyo-heights':
        return 'water-tank';
      case 'breakwater':
        return 'gantry';
    }
  }
  switch (district) {
    case 'neon-strand':
      return rng.pick(['neon-crown', 'terrace', 'vents'] as const);
    case 'alta-vista':
      return rng.pick(['antenna', 'terrace', 'vents'] as const);
    case 'arroyo-heights':
      return rng.pick(['terrace', 'water-tank', 'vents'] as const);
    case 'breakwater':
      return rng.pick(['gantry', 'vents', 'water-tank'] as const);
  }
}

function districtAccentColors(
  district: DistrictBounds,
  rng: SeededRandom,
): readonly [number, number] {
  switch (district.id) {
    case 'neon-strand':
      return [rng.pick([0xff4fa3, 0x28e0d1, 0xffd357]), rng.pick([0x203b62, 0x4d2468])];
    case 'alta-vista':
      return [rng.pick([0x71d9ff, 0xe5c27a, 0x91a6bc]), rng.pick([0x17384f, 0x284f67])];
    case 'arroyo-heights':
      return [rng.pick([0xdc6b45, 0xf1c06b, 0x5d9875]), rng.pick([0x476f74, 0x675047])];
    case 'breakwater':
      return [rng.pick([0xf0a727, 0xb64f3f, 0x4b8f91]), rng.pick([0x30434a, 0x4a3c38])];
  }
}

function addDistrictRoads(district: DistrictBounds, roads: RoadRecipe[]): void {
  for (let index = 0; index < ROADS_PER_AXIS; index += 1) {
    const localOffset = LOCAL_ROAD_START + index * ROAD_SPACING;
    const x = district.minX + localOffset;
    const z = district.minZ + localOffset;
    const major = index === 2 || index === 3;
    const width = localRoadWidth(index);

    roads.push(
      {
        id: `${district.id}-road-v-${index}`,
        district: district.id,
        position: { x, y: 0.04, z: (district.minZ + district.maxZ) / 2 },
        width,
        depth: DISTRICT_SIZE,
        major,
      },
      {
        id: `${district.id}-road-h-${index}`,
        district: district.id,
        position: { x: (district.minX + district.maxX) / 2, y: 0.045, z },
        width: DISTRICT_SIZE,
        depth: width,
        major,
      },
    );
  }
}

function buildingClearsAuthoredExteriorZones(
  district: DistrictId,
  x: number,
  z: number,
  width: number,
  depth: number,
): boolean {
  const minX = x - width / 2;
  const maxX = x + width / 2;
  const minZ = z - depth / 2;
  const maxZ = z + depth / 2;
  const clearsEntrances = AUTHORED_EXTERIOR_CLEARANCE_ZONES.every((zone) => {
    if (zone.district !== district) {
      return true;
    }
    const closestX = Math.max(minX, Math.min(zone.position.x, maxX));
    const closestZ = Math.max(minZ, Math.min(zone.position.z, maxZ));
    const deltaX = zone.position.x - closestX;
    const deltaZ = zone.position.z - closestZ;
    return deltaX * deltaX + deltaZ * deltaZ >= zone.radius * zone.radius;
  });
  return clearsEntrances && AUTHORED_EXTERIOR_BUILDING_ZONES.every((zone) => (
    zone.district !== district
    || maxX + PORTAL_BUILDING_MARGIN <= zone.minX
    || minX - PORTAL_BUILDING_MARGIN >= zone.maxX
    || maxZ + PORTAL_BUILDING_MARGIN <= zone.minZ
    || minZ - PORTAL_BUILDING_MARGIN >= zone.maxZ
  ));
}

function placeBuildingOutsideAuthoredZones(
  district: DistrictId,
  preferredX: number,
  preferredZ: number,
  width: number,
  depth: number,
  blockMinX: number,
  blockMaxX: number,
  blockMinZ: number,
  blockMaxZ: number,
): readonly [number, number] {
  const minimumX = blockMinX + width / 2;
  const maximumX = blockMaxX - width / 2;
  const minimumZ = blockMinZ + depth / 2;
  const maximumZ = blockMaxZ - depth / 2;
  const offsets = [0, 6, -6, 12, -12, 18, -18, 24, -24, 30, -30];
  const candidates = offsets
    .flatMap((offsetX) => offsets.map((offsetZ) => ({ offsetX, offsetZ })))
    .sort((left, right) => {
      const leftDistance =
        left.offsetX * left.offsetX + left.offsetZ * left.offsetZ;
      const rightDistance =
        right.offsetX * right.offsetX + right.offsetZ * right.offsetZ;
      return (
        leftDistance - rightDistance
        || left.offsetX - right.offsetX
        || left.offsetZ - right.offsetZ
      );
    });
  const visited = new Set<string>();
  for (const { offsetX, offsetZ } of candidates) {
    const x = Math.min(
      maximumX,
      Math.max(minimumX, preferredX + offsetX),
    );
    const z = Math.min(
      maximumZ,
      Math.max(minimumZ, preferredZ + offsetZ),
    );
    const key = `${x.toFixed(6)}:${z.toFixed(6)}`;
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);
    if (buildingClearsAuthoredExteriorZones(district, x, z, width, depth)) {
      return [x, z];
    }
  }
  throw new Error(`Unable to reserve authored exterior clearance in ${district}`);
}

function addDistrictBuildings(
  district: DistrictBounds,
  rng: SeededRandom,
  quality: WorldQuality,
  buildings: BuildingRecipe[],
): void {
  const [minimumHeight, maximumHeight] = districtHeightRange(district.id);
  const plotsPerBlock = quality === 'high' ? 3 : 2;

  for (let blockX = 0; blockX < 5; blockX += 1) {
    for (let blockZ = 0; blockZ < 5; blockZ += 1) {
      const leftRoadCenter =
        district.minX + LOCAL_ROAD_START + blockX * ROAD_SPACING;
      const rightRoadCenter = leftRoadCenter + ROAD_SPACING;
      const nearRoadCenter =
        district.minZ + LOCAL_ROAD_START + blockZ * ROAD_SPACING;
      const farRoadCenter = nearRoadCenter + ROAD_SPACING;
      const blockMinX =
        leftRoadCenter
        + localRoadWidth(blockX) / 2
        + BUILDING_ROAD_EDGE_SETBACK;
      const blockMaxX =
        rightRoadCenter
        - localRoadWidth(blockX + 1) / 2
        - BUILDING_ROAD_EDGE_SETBACK;
      const blockMinZ =
        nearRoadCenter
        + localRoadWidth(blockZ) / 2
        + BUILDING_ROAD_EDGE_SETBACK;
      const blockMaxZ =
        farRoadCenter
        - localRoadWidth(blockZ + 1) / 2
        - BUILDING_ROAD_EDGE_SETBACK;
      const blockWidth = blockMaxX - blockMinX;
      const blockDepth = blockMaxZ - blockMinZ;

      for (let plot = 0; plot < plotsPerBlock; plot += 1) {
        const isLeft = plot % 2 === 0;
        const isNear = plot < 2;
        const plotWidth =
          plotsPerBlock === 3 && plot === 2
            ? blockWidth * 0.62
            : blockWidth * 0.42;
        const plotDepth =
          plotsPerBlock === 3 && plot === 2
            ? blockDepth * 0.34
            : blockDepth * 0.43;
        const baseX =
          plot === 2
            ? (blockMinX + blockMaxX) / 2
            : blockMinX + (isLeft ? blockWidth * 0.25 : blockWidth * 0.73);
        const baseZ = blockMinZ + (isNear ? blockDepth * 0.26 : blockDepth * 0.73);
        const width = plotWidth * rng.range(0.72, 0.96);
        const depth = plotDepth * rng.range(0.72, 0.96);
        let height = rng.range(minimumHeight, maximumHeight);

        if (district.id === 'alta-vista' && (blockX === 2 || blockZ === 2)) {
          height *= 1.22;
        }
        if (district.id === 'breakwater') {
          height = Math.min(height, 30);
        }

        const landmark = blockX === 2 && blockZ === 2 && plot === 0;
        if (landmark) {
          height = district.id === 'alta-vista' ? 148 : Math.max(height, maximumHeight * 1.18);
        }

        const jitterX = rng.range(-3.5, 3.5);
        const jitterZ = rng.range(-3.5, 3.5);
        const preferredPositionX = Math.min(
          blockMaxX - width / 2,
          Math.max(blockMinX + width / 2, baseX + jitterX),
        );
        const preferredPositionZ = Math.min(
          blockMaxZ - depth / 2,
          Math.max(blockMinZ + depth / 2, baseZ + jitterZ),
        );
        const [positionX, positionZ] = placeBuildingOutsideAuthoredZones(
          district.id,
          preferredPositionX,
          preferredPositionZ,
          width,
          depth,
          blockMinX,
          blockMaxX,
          blockMinZ,
          blockMaxZ,
        );
        const [accentColor, glassColor] = districtAccentColors(district, rng);
        const buildingStyle = districtBuildingStyle(district.id);
        const frontage: BuildingRecipe['frontage'] =
          (blockX + blockZ) % 2 === 0
            ? isNear ? 'north' : 'south'
            : isLeft ? 'west' : 'east';
        buildings.push({
          id: `${district.id}-building-${blockX}-${blockZ}-${plot}`,
          district: district.id,
          position: { x: positionX, y: height / 2, z: positionZ },
          width,
          depth,
          height,
          color: rng.pick(district.buildingColors),
          roofStyle: landmark ? 'spire' : rng.pick(['flat', 'flat', 'step'] as const),
          ...buildingStyle,
          roofFeature: districtRoofFeature(district.id, landmark, rng),
          frontage,
          accentColor,
          glassColor,
          landmark,
        });
      }
    }
  }
}

const INTERIOR_HOST_REPLACEMENT_IDS: Readonly<Record<string, readonly string[]>> = {
  'interior-host:moreno-garage': [
    'arroyo-heights-building-3-1-2',
    'arroyo-heights-building-3-1-1',
  ],
  'interior-host:juno-grid': ['neon-strand-building-2-2-0'],
  'interior-host:malik-office': ['alta-vista-building-3-2-0'],
  'interior-host:priya-workshop': ['breakwater-building-3-3-0'],
  'interior-host:syndicate-tower': ['alta-vista-building-2-4-0'],
};

/**
 * Replaces one density-equivalent procedural plot per authored interior. The
 * host therefore participates in normal city collisions and streaming without
 * growing either low- or high-quality structure budgets.
 */
function embedAuthoredInteriorBuildings(
  district: DistrictId,
  buildings: BuildingRecipe[],
): void {
  for (const definition of AUTHORED_INTERIORS) {
    if (definition.portal.district !== district) continue;
    const replacementIds = INTERIOR_HOST_REPLACEMENT_IDS[
      definition.exteriorBuilding.id
    ];
    if (!replacementIds) {
      throw new Error(`Missing city plot for ${definition.exteriorBuilding.id}`);
    }
    let replacementIndex = -1;
    for (const replacementId of replacementIds) {
      replacementIndex = buildings.findIndex(({ id }) => id === replacementId);
      if (replacementIndex >= 0) break;
    }
    if (replacementIndex < 0) {
      throw new Error(`Unable to embed ${definition.exteriorBuilding.id} in ${district}`);
    }
    const host = definition.exteriorBuilding;
    buildings.splice(replacementIndex, 1, {
      id: host.id,
      district,
      position: { ...host.position },
      width: host.width,
      depth: host.depth,
      height: host.height,
      color: host.color,
      roofStyle: host.roofStyle,
      facadeStyle: host.facadeStyle,
      storefrontStyle: host.storefrontStyle,
      roofFeature: host.roofFeature,
      frontage: host.frontage,
      accentColor: host.accentColor,
      glassColor: host.glassColor,
      landmark: host.landmark,
    });
  }
}

function addDistrictProps(
  district: DistrictBounds,
  rng: SeededRandom,
  quality: WorldQuality,
  buildings: readonly BuildingRecipe[],
  props: PropRecipe[],
): void {
  const count = quality === 'high' ? 88 : 40;
  for (let index = 0; index < count; index += 1) {
    const verticalRoad = index % 2 === 0;
    const roadIndex = Math.floor(index / 2) % ROADS_PER_AXIS;
    const across = stratifiedAcrossPosition(
      index,
      roadIndex,
      verticalRoad,
      count,
      rng,
    );
    const curbSide = rng.next() > 0.5 ? 1 : -1;
    const kind = districtPropKind(district.id, rng, index);
    const color = (() => {
      switch (kind) {
        case 'container':
        case 'cargo-pallet':
        case 'pipe-stack':
          return rng.pick([0xd25d3d, 0x298c91, 0xd4a736, 0x526b86]);
        case 'bench':
        case 'kiosk':
        case 'market-stall':
        case 'transit-shelter':
        case 'sculpture':
          return rng.pick([...district.buildingColors, district.emissiveColor]);
        case 'planter':
          return rng.pick([0xb26745, 0xd5aa68, 0x587c72]);
        case 'palm':
        case 'streetlight':
        case 'tree':
        case 'bollard':
          return 0xffffff;
      }
    })();
    const scale = rng.range(0.82, 1.18);
    const position = findDistrictPropPosition(
      district,
      roadIndex,
      verticalRoad,
      across,
      curbSide,
      kind,
      scale,
      buildings,
      props,
    );

    props.push({
      id: `${district.id}-prop-${index}`,
      district: district.id,
      kind,
      position,
      rotation: verticalRoad ? Math.PI / 2 : 0,
      scale,
      color,
    });
  }
}

export function generateCity(seed: number | string = 'solara-v1', quality: WorldQuality = 'high'): CityLayout {
  const numericSeed = hashSeed(seed);
  const rng = new SeededRandom(numericSeed);
  const buildings: BuildingRecipe[] = [];
  const roads: RoadRecipe[] = [];
  const props: PropRecipe[] = [];

  for (const district of DISTRICTS) {
    addDistrictRoads(district, roads);
    addDistrictBuildings(district, rng, quality, buildings);
    embedAuthoredInteriorBuildings(district.id, buildings);
    addDistrictProps(district, rng, quality, buildings, props);
  }

  roads.push(
    {
      id: 'solara-spine-north-south',
      district: 'alta-vista',
      position: { x: 0, y: 0.05, z: 0 },
      width: 32,
      depth: CITY_SIZE,
      major: true,
    },
    {
      id: 'solara-spine-east-west',
      district: 'breakwater',
      position: { x: 0, y: 0.055, z: 0 },
      width: CITY_SIZE,
      depth: 32,
      major: true,
    },
  );

  const collisions: CollisionRect[] = buildings.map((building) => ({
    id: building.id,
    minX: building.position.x - building.width / 2,
    maxX: building.position.x + building.width / 2,
    minZ: building.position.z - building.depth / 2,
    maxZ: building.position.z + building.depth / 2,
    height: building.height,
    kind: 'solid',
  }));
  collisions.push(...TRAVERSAL_OBSTACLES.map((obstacle) => ({ ...obstacle })));

  return {
    seed: numericSeed,
    quality,
    buildings,
    roads,
    props,
    traversalObstacles: TRAVERSAL_OBSTACLES.map((obstacle) => ({ ...obstacle })),
    collisions,
  };
}

export function districtAt(x: number, z: number): DistrictId {
  return solaraDistrictAt(x, z);
}

export function districtDefinition(id: DistrictId): DistrictBounds {
  const definition = DISTRICTS.find((district) => district.id === id);
  if (!definition) {
    throw new Error(`Unknown district: ${id}`);
  }
  return definition;
}
