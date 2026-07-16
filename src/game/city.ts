import { SeededRandom, hashSeed } from './random';
import type { DistrictId, Vec3Data, WorldQuality } from './types';

export const CITY_SIZE = 1_200;
export const CITY_HALF_SIZE = CITY_SIZE / 2;
export const DISTRICT_SIZE = CITY_SIZE / 2;
export const PLAYER_SPAWN: Readonly<Vec3Data> = Object.freeze({ x: -248, y: 0, z: 248 });
export const VEHICLE_SPAWN: Readonly<Vec3Data> = Object.freeze({ x: -248, y: 0.48, z: 243.5 });

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

export type PropKind = 'palm' | 'streetlight' | 'tree' | 'container' | 'bollard';

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
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
}

export interface CityLayout {
  seed: number;
  quality: WorldQuality;
  buildings: readonly BuildingRecipe[];
  roads: readonly RoadRecipe[];
  props: readonly PropRecipe[];
  collisions: readonly CollisionRect[];
}

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

function districtPropKind(district: DistrictId, rng: SeededRandom): PropKind {
  switch (district) {
    case 'neon-strand':
      return rng.next() > 0.28 ? 'palm' : 'streetlight';
    case 'alta-vista':
      return rng.next() > 0.45 ? 'streetlight' : 'tree';
    case 'arroyo-heights':
      return rng.next() > 0.3 ? 'tree' : 'streetlight';
    case 'breakwater':
      return rng.next() > 0.35 ? 'container' : 'bollard';
  }
}

function addDistrictRoads(district: DistrictBounds, roads: RoadRecipe[]): void {
  for (let index = 0; index < ROADS_PER_AXIS; index += 1) {
    const localOffset = LOCAL_ROAD_START + index * ROAD_SPACING;
    const x = district.minX + localOffset;
    const z = district.minZ + localOffset;
    const major = index === 2 || index === 3;
    const width = major ? ROAD_WIDTH + 8 : ROAD_WIDTH;

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
      const blockMinX = district.minX + LOCAL_ROAD_START + ROAD_WIDTH / 2 + blockX * ROAD_SPACING;
      const blockMinZ = district.minZ + LOCAL_ROAD_START + ROAD_WIDTH / 2 + blockZ * ROAD_SPACING;
      const blockExtent = ROAD_SPACING - ROAD_WIDTH;

      for (let plot = 0; plot < plotsPerBlock; plot += 1) {
        const isLeft = plot % 2 === 0;
        const isNear = plot < 2;
        const plotWidth = plotsPerBlock === 3 && plot === 2 ? blockExtent * 0.62 : blockExtent * 0.42;
        const plotDepth = plotsPerBlock === 3 && plot === 2 ? blockExtent * 0.34 : blockExtent * 0.43;
        const baseX = blockMinX + (isLeft ? blockExtent * 0.25 : blockExtent * 0.73);
        const baseZ = blockMinZ + (isNear ? blockExtent * 0.26 : blockExtent * 0.73);
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
        buildings.push({
          id: `${district.id}-building-${blockX}-${blockZ}-${plot}`,
          district: district.id,
          position: { x: baseX + jitterX, y: height / 2, z: baseZ + jitterZ },
          width,
          depth,
          height,
          color: rng.pick(district.buildingColors),
          roofStyle: landmark ? 'spire' : rng.pick(['flat', 'flat', 'step'] as const),
          landmark,
        });
      }
    }
  }
}

function addDistrictProps(
  district: DistrictBounds,
  rng: SeededRandom,
  quality: WorldQuality,
  props: PropRecipe[],
): void {
  const count = quality === 'high' ? 46 : 22;
  for (let index = 0; index < count; index += 1) {
    const verticalRoad = index % 2 === 0;
    const roadIndex = index % ROADS_PER_AXIS;
    const across = rng.range(25, DISTRICT_SIZE - 25);
    const curbOffset = (rng.next() > 0.5 ? 1 : -1) * (ROAD_WIDTH / 2 + 3.2);
    const x = verticalRoad
      ? district.minX + LOCAL_ROAD_START + roadIndex * ROAD_SPACING + curbOffset
      : district.minX + across;
    const z = verticalRoad
      ? district.minZ + across
      : district.minZ + LOCAL_ROAD_START + roadIndex * ROAD_SPACING + curbOffset;
    const kind = districtPropKind(district.id, rng);
    const color = kind === 'container'
      ? rng.pick([0xd25d3d, 0x298c91, 0xd4a736, 0x526b86])
      : 0xffffff;

    props.push({
      id: `${district.id}-prop-${index}`,
      district: district.id,
      kind,
      position: { x, y: 0, z },
      rotation: verticalRoad ? 0 : Math.PI / 2,
      scale: rng.range(0.82, 1.18),
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
    addDistrictProps(district, rng, quality, props);
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
    minX: building.position.x - building.width / 2,
    maxX: building.position.x + building.width / 2,
    minZ: building.position.z - building.depth / 2,
    maxZ: building.position.z + building.depth / 2,
    height: building.height,
  }));

  return {
    seed: numericSeed,
    quality,
    buildings,
    roads,
    props,
    collisions,
  };
}

export function districtAt(x: number, z: number): DistrictId {
  if (z < 0) {
    return x < 0 ? 'neon-strand' : 'alta-vista';
  }
  return x < 0 ? 'arroyo-heights' : 'breakwater';
}

export function districtDefinition(id: DistrictId): DistrictBounds {
  const definition = DISTRICTS.find((district) => district.id === id);
  if (!definition) {
    throw new Error(`Unknown district: ${id}`);
  }
  return definition;
}
