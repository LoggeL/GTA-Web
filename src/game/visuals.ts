import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Points,
  PointsMaterial,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import type { VehicleClassId } from '../data/types';
import { cellIdAt, parseCellId } from '../navigation/cells';
import type { CellId } from '../navigation/types';
import { DISTRICTS, DISTRICT_SIZE } from './city';
import type {
  BuildingRecipe,
  CityLayout,
  PropRecipe,
  TraversalObstacleRecipe,
} from './city';
import type { DrawDensityLimits } from './CityStreamingController';
import type { PlayerSimulationState } from './player';
import { SeededRandom } from './random';
import type { Vec3Data, WorldQuality } from './types';
import type { VehicleSimulationState } from './vehicle';
import {
  DEFAULT_VEHICLE_CLASS_ID,
  requireVehicleDriveProfile,
} from './vehicleProfiles';

export interface CityVisualInstanceCounts {
  readonly visible: number;
  readonly capacity: number;
}

export interface CityVisualStreamingSnapshot {
  readonly activeCellIds: readonly CellId[];
  /** Cells represented by the immutable CPU recipe index. */
  readonly knownCellIds: readonly CellId[];
  /** Requested resident cells that contain indexed visual recipes. */
  readonly residentCellIds: readonly CellId[];
  /** Payload roots allocated during this transition. */
  readonly createdCellIds: readonly CellId[];
  /** Payload roots released during this transition. */
  readonly evictedCellIds: readonly CellId[];
  readonly visibleCellIds: readonly CellId[];
  readonly hiddenCellIds: readonly CellId[];
  readonly density: DrawDensityLimits;
  readonly structures: CityVisualInstanceCounts;
  readonly props: CityVisualInstanceCounts;
  readonly traversal: CityVisualInstanceCounts;
  readonly shadowCastingInstances: number;
}

export interface CityVisualBundle {
  root: Group;
  buildingMaterials: readonly MeshStandardMaterial[];
  roadMaterial: MeshStandardMaterial | MeshLambertMaterial;
  setRoadColor: (color: Readonly<Color>) => void;
  applyStreamingState: (
    renderableActiveCellIds: readonly CellId[],
    residentCellIds: readonly CellId[],
    drawDensity: Readonly<DrawDensityLimits>,
  ) => CityVisualStreamingSnapshot;
  dispose: () => void;
}

export interface VisualRenderCapabilities {
  readonly supportsMultiDraw: boolean;
}

export interface VehicleVisualOptions extends VisualRenderCapabilities {
  readonly quality: WorldQuality;
}

const DEFAULT_VISUAL_RENDER_CAPABILITIES: Readonly<VisualRenderCapabilities> = Object.freeze({
  supportsMultiDraw: false,
});

const DEFAULT_VEHICLE_VISUAL_OPTIONS: Readonly<VehicleVisualOptions> = Object.freeze({
  quality: 'high',
  supportsMultiDraw: false,
});

type CityDisposableMaterial =
  | MeshStandardMaterial
  | MeshLambertMaterial
  | MeshBasicMaterial;

interface DensityMeshRecord {
  readonly mesh: InstancedMesh;
  readonly capacity: number;
  /** Instances that form one complete density unit (for example one detailed building). */
  readonly instancesPerDensityUnit: number;
  readonly shadowCaster: boolean;
  readonly shadowKey: string;
}

interface CityCellVisualPayload {
  readonly cellId: CellId;
  readonly root: Group;
  readonly structures: DensityMeshRecord[];
  readonly props: DensityMeshRecord[];
  readonly traversal: DensityMeshRecord[];
}

interface CityBuildingVisualBatches {
  readonly solids: readonly InstancedMesh[];
  readonly facades: InstancedMesh;
  readonly lowQuality: readonly LowBuildingCellBatch[] | null;
  readonly lowQualityRoot: Group | null;
  readonly lowSharedBatch: LowSharedSurfaceBatch | null;
  readonly quality: WorldQuality;
  readonly dummy: Object3D;
}

interface LowBuildingCellBatch {
  readonly cellId: CellId;
  readonly mesh: InstancedMesh;
  readonly buildingCount: number;
}

type CityPropBatchKind =
  | 'boxes'
  | 'accents'
  | 'stems'
  | 'foliage'
  | 'lights'
  | 'sculptures';

interface CityPropVisualBatches {
  readonly boxes: InstancedMesh;
  readonly accents: InstancedMesh;
  readonly stems: InstancedMesh;
  readonly foliage: InstancedMesh;
  readonly lights: InstancedMesh;
  readonly sculptures: InstancedMesh;
  readonly merged: Mesh | null;
  readonly mergedSources: BufferGeometry[];
  readonly quality: WorldQuality;
  readonly matrix: Matrix4;
  readonly color: Color;
}

interface CityPropBatchCounts {
  boxes: number;
  accents: number;
  stems: number;
  foliage: number;
  lights: number;
  sculptures: number;
}

interface CityCellVisualRecipes {
  readonly buildings: readonly BuildingRecipe[];
  readonly props: readonly PropRecipe[];
  readonly traversal: readonly TraversalObstacleRecipe[];
}

interface CityVisualSharedResources {
  readonly buildingGeometry: BufferGeometry;
  readonly buildingMaterials: readonly MeshStandardMaterial[];
  readonly facadeGeometry: BufferGeometry;
  readonly facadeMaterial: MeshStandardMaterial;
  readonly accentMaterial: MeshStandardMaterial;
  readonly streetDetailGeometry: BufferGeometry;
  readonly streetDetailMaterial: MeshStandardMaterial;
  readonly stemGeometry: BufferGeometry;
  readonly stemMaterial: MeshStandardMaterial;
  readonly foliageGeometry: BufferGeometry;
  readonly foliageMaterial: MeshStandardMaterial;
  readonly lightGeometry: BufferGeometry;
  readonly lightMaterial: MeshStandardMaterial;
  readonly containerGeometry: BufferGeometry;
  readonly containerMaterial: MeshStandardMaterial;
  readonly traversalGeometry: BufferGeometry;
  readonly traversalMaterial: MeshStandardMaterial;
}

interface LowSharedSurfaceBatch {
  readonly surfaceMesh: InstancedMesh;
  readonly buildingGeometry: BufferGeometry;
  readonly buildingMaterial: MeshLambertMaterial;
  readonly dummy: Object3D;
  readonly color: Color;
  readonly fixedInstanceCount: number;
  readonly roadStartIndex: number;
  readonly roadInstanceCount: number;
  readonly sidewalkStartIndex: number;
  readonly groundStartIndex: number;
  readonly fixedMatrices: Array<Matrix4 | undefined>;
  readonly fixedColors: Array<Color | undefined>;
  writtenFixedInstances: number;
}

class AliasedInstancedMesh extends InstancedMesh {
  public constructor(
    geometry: BufferGeometry,
    material: CityDisposableMaterial,
    count: number,
    private readonly lookupAliases: readonly string[],
  ) {
    super(geometry, material, count);
  }

  public override getObjectByProperty(
    name: string,
    value: unknown,
  ): Object3D | undefined {
    if (
      name === 'name'
      && typeof value === 'string'
      && this.lookupAliases.includes(value)
    ) {
      return this;
    }
    return super.getObjectByProperty(name, value);
  }
}

class AliasedMesh extends Mesh<BufferGeometry, MeshLambertMaterial> {
  public constructor(
    geometry: BufferGeometry,
    material: MeshLambertMaterial,
    private readonly lookupAliases: readonly string[],
  ) {
    super(geometry, material);
  }

  public override getObjectByProperty(
    name: string,
    value: unknown,
  ): Object3D | undefined {
    if (
      name === 'name'
      && typeof value === 'string'
      && this.lookupAliases.includes(value)
    ) {
      return this;
    }
    return super.getObjectByProperty(name, value);
  }
}

function composeMatrix(
  target: Object3D,
  x: number,
  y: number,
  z: number,
  scaleX: number,
  scaleY: number,
  scaleZ: number,
  rotationY = 0,
): Matrix4 {
  target.position.set(x, y, z);
  target.rotation.set(0, rotationY, 0);
  target.scale.set(scaleX, scaleY, scaleZ);
  target.updateMatrix();
  return target.matrix;
}

function composeEulerMatrix(
  target: Object3D,
  position: readonly [number, number, number],
  rotation: readonly [number, number, number],
  scale: readonly [number, number, number],
): Matrix4 {
  target.position.set(...position);
  target.rotation.set(...rotation);
  target.scale.set(...scale);
  target.updateMatrix();
  return target.matrix;
}

function createLowSharedSurfaceBatch(
  root: Group,
  layout: Readonly<CityLayout>,
  geometries: BufferGeometry[],
  materials: CityDisposableMaterial[],
): LowSharedSurfaceBatch {
  const buildingGeometry = new BoxGeometry(1, 1, 1);
  const buildingMaterial = new MeshLambertMaterial({
    color: 0xffffff,
  });
  const surfaceGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
  const surfaceMaterial = new MeshBasicMaterial({
    color: 0xffffff,
    toneMapped: true,
  });
  const roadStartIndex = 0;
  const roadInstanceCount = layout.roads.length;
  const sidewalkStartIndex = roadInstanceCount;
  const groundStartIndex = roadInstanceCount + layout.roads.length * 2;
  const fixedInstanceCount = groundStartIndex + DISTRICTS.length;
  const surfaceMesh = new AliasedInstancedMesh(
    surfaceGeometry,
    surfaceMaterial,
    fixedInstanceCount,
    ['city-sidewalks', 'city-roads'],
  );
  // The fixed ground network keeps its exact authored top surfaces while
  // dropping the hidden undersides and tiny vertical walls of the former
  // boxes. Buildings render first through conservative cell clusters so their
  // depth rejects covered ground fragments early.
  surfaceMesh.name = 'city-surfaces-low-quality';
  surfaceMesh.userData.fixedInstanceCount = fixedInstanceCount;
  surfaceMesh.userData.roadStartIndex = roadStartIndex;
  surfaceMesh.userData.roadInstanceCount = roadInstanceCount;
  surfaceMesh.userData.sidewalkStartIndex = sidewalkStartIndex;
  surfaceMesh.userData.groundStartIndex = groundStartIndex;
  surfaceMesh.count = 0;
  surfaceMesh.frustumCulled = false;
  surfaceMesh.renderOrder = -1;
  surfaceMesh.receiveShadow = false;
  root.add(surfaceMesh);
  geometries.push(buildingGeometry, surfaceGeometry);
  materials.push(buildingMaterial, surfaceMaterial);
  return {
    surfaceMesh,
    buildingGeometry,
    buildingMaterial,
    dummy: new Object3D(),
    color: new Color(),
    fixedInstanceCount,
    roadStartIndex,
    roadInstanceCount,
    sidewalkStartIndex,
    groundStartIndex,
    fixedMatrices: new Array<Matrix4 | undefined>(fixedInstanceCount),
    fixedColors: new Array<Color | undefined>(fixedInstanceCount),
    writtenFixedInstances: 0,
  };
}

function setLowFixedInstance(
  sharedSurfaces: LowSharedSurfaceBatch,
  index: number,
  matrix: Readonly<Matrix4>,
  color: Readonly<Color>,
): void {
  let storedMatrix = sharedSurfaces.fixedMatrices[index];
  let storedColor = sharedSurfaces.fixedColors[index];
  if (!storedMatrix || !storedColor) {
    storedMatrix = new Matrix4();
    storedColor = new Color();
    sharedSurfaces.fixedMatrices[index] = storedMatrix;
    sharedSurfaces.fixedColors[index] = storedColor;
    sharedSurfaces.writtenFixedInstances += 1;
  }
  storedMatrix.copy(matrix);
  storedColor.copy(color);
}

function commitLowFixedInstances(sharedSurfaces: LowSharedSurfaceBatch): void {
  if (sharedSurfaces.writtenFixedInstances !== sharedSurfaces.fixedInstanceCount) {
    throw new Error('Low-quality shared city batch was not filled exactly');
  }
  for (let index = 0; index < sharedSurfaces.fixedInstanceCount; index += 1) {
    const matrix = sharedSurfaces.fixedMatrices[index];
    const color = sharedSurfaces.fixedColors[index];
    if (!matrix || !color) {
      throw new Error(`Missing low-quality fixed city instance ${index}`);
    }
    sharedSurfaces.surfaceMesh.setMatrixAt(index, matrix);
    sharedSurfaces.surfaceMesh.setColorAt(index, color);
  }
  sharedSurfaces.surfaceMesh.count = sharedSurfaces.fixedInstanceCount;
  sharedSurfaces.surfaceMesh.visible = true;
  finalizeInstances(sharedSurfaces.surfaceMesh);
}

function createDistrictGrounds(
  root: Group,
  geometries: BufferGeometry[],
  materials: CityDisposableMaterial[],
  sharedSurfaces: LowSharedSurfaceBatch | null,
  quality: WorldQuality,
): void {
  DISTRICTS.forEach((district, districtIndex) => {
    const x = (district.minX + district.maxX) / 2;
    const z = (district.minZ + district.maxZ) / 2;
    if (sharedSurfaces) {
      const anchor = new Object3D();
      anchor.name = `city-ground:${district.id}`;
      anchor.position.set(x, -0.08, z);
      anchor.scale.set(DISTRICT_SIZE, 0.12, DISTRICT_SIZE);
      anchor.userData.groundColor = district.groundColor;
      root.add(anchor);
      setLowFixedInstance(
        sharedSurfaces,
        sharedSurfaces.groundStartIndex + districtIndex,
        composeMatrix(
          sharedSurfaces.dummy,
          x,
          -0.02,
          z,
          DISTRICT_SIZE,
          1,
          DISTRICT_SIZE,
        ),
        sharedSurfaces.color.setHex(district.groundColor),
      );
      return;
    }
    const geometry = new BoxGeometry(DISTRICT_SIZE, 0.12, DISTRICT_SIZE);
    const material = new MeshStandardMaterial({
      color: district.groundColor,
      roughness: 0.94,
      metalness: 0,
    });
    const ground = new Mesh(geometry, material);
    ground.name = `city-ground:${district.id}`;
    ground.position.set(x, -0.08, z);
    ground.receiveShadow = true;
    root.add(ground);
    geometries.push(geometry);
    materials.push(material);
  });

  const oceanGeometry = new PlaneGeometry(300, 1_300, 1, 1);
  const oceanMaterial = quality === 'low'
    ? new MeshLambertMaterial({
      color: 0x197c9b,
      transparent: true,
      opacity: 0.9,
    })
    : new MeshStandardMaterial({
      color: 0x197c9b,
      roughness: 0.25,
      metalness: 0.05,
      transparent: true,
      opacity: 0.9,
    });
  const ocean = new Mesh(oceanGeometry, oceanMaterial);
  ocean.name = 'city-ocean';
  ocean.rotation.x = -Math.PI / 2;
  ocean.position.set(-748, -0.18, 0);
  root.add(ocean);
  geometries.push(oceanGeometry);
  materials.push(oceanMaterial);
}

function createRoads(
  root: Group,
  layout: CityLayout,
  geometries: BufferGeometry[],
  materials: CityDisposableMaterial[],
  sharedSurfaces: LowSharedSurfaceBatch | null,
): MeshStandardMaterial | MeshLambertMaterial {
  const geometry = sharedSurfaces ? null : new BoxGeometry(1, 1, 1);
  const material = layout.quality === 'low'
    ? new MeshLambertMaterial({
      color: 0x26313b,
    })
    : new MeshStandardMaterial({
      color: 0x26313b,
      roughness: 0.82,
      metalness: 0.05,
    });
  const mesh = sharedSurfaces?.surfaceMesh ?? new InstancedMesh(
    geometry!,
    material,
    layout.roads.length,
  );
  if (!sharedSurfaces) {
    mesh.name = 'city-roads';
  }
  const dummy = new Object3D();
  layout.roads.forEach((road, index) => {
    const instanceIndex = (sharedSurfaces?.roadStartIndex ?? 0) + index;
    if (sharedSurfaces) {
      setLowFixedInstance(
        sharedSurfaces,
        instanceIndex,
        composeMatrix(
          dummy,
          road.position.x,
          road.position.y + 0.05,
          road.position.z,
          road.width,
          1,
          road.depth,
        ),
        sharedSurfaces.color.setHex(0x26313b),
      );
    } else {
      mesh.setMatrixAt(
        instanceIndex,
        composeMatrix(
          dummy,
          road.position.x,
          road.position.y,
          road.position.z,
          road.width,
          0.1,
          road.depth,
        ),
      );
    }
  });
  mesh.receiveShadow = !sharedSurfaces;
  if (!sharedSurfaces && geometry) {
    root.add(mesh);
    geometries.push(geometry);
  }
  materials.push(material);

  const markingCount = layout.roads.reduce((count, road) => {
    const length = Math.max(road.width, road.depth);
    return count + Math.floor(length / 28);
  }, 0);
  const markingGeometry = layout.quality === 'low'
    ? new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2)
    : new BoxGeometry(1, 1, 1);
  const markingMaterial = layout.quality === 'low'
    ? new MeshBasicMaterial({
      color: 0xffd66b,
      toneMapped: true,
    })
    : new MeshStandardMaterial({
      color: 0xffd66b,
      emissive: 0x6d4817,
      emissiveIntensity: 0.12,
      roughness: 0.72,
    });
  const markings = new InstancedMesh(markingGeometry, markingMaterial, markingCount);
  markings.name = 'city-road-markings';
  let markingIndex = 0;
  for (const road of layout.roads) {
    const vertical = road.depth > road.width;
    const length = vertical ? road.depth : road.width;
    const dashCount = Math.floor(length / 28);
    for (let dash = 0; dash < dashCount; dash += 1) {
      const along = -length / 2 + 14 + dash * 28;
      const x = road.position.x + (vertical ? 0 : along);
      const z = road.position.z + (vertical ? along : 0);
      markings.setMatrixAt(
        markingIndex,
        composeMatrix(dummy, x, 0.105, z, vertical ? 0.18 : 7.5, 0.025, vertical ? 7.5 : 0.18),
      );
      markingIndex += 1;
    }
  }
  root.add(markings);
  geometries.push(markingGeometry);
  materials.push(markingMaterial);

  const sidewalkGeometry = sharedSurfaces ? null : new BoxGeometry(1, 1, 1);
  const sidewalkMaterial = sharedSurfaces
    ? null
    : new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.96,
      metalness: 0,
    });
  const sidewalks = sharedSurfaces?.surfaceMesh ?? new InstancedMesh(
    sidewalkGeometry!,
    sidewalkMaterial!,
    layout.roads.length * 2,
  );
  if (!sharedSurfaces) {
    sidewalks.name = 'city-sidewalks';
  }
  let sidewalkIndex = 0;
  const curbPalette: Readonly<Record<BuildingRecipe['district'], number>> = {
    'neon-strand': 0xe4d7bd,
    'alta-vista': 0x9faeb1,
    'arroyo-heights': 0xd2b789,
    breakwater: 0x89918a,
  };
  for (const road of layout.roads) {
    const vertical = road.depth > road.width;
    const curbOffset = (vertical ? road.width : road.depth) / 2 + 2.2;
    for (const side of [-1, 1] as const) {
      const x = road.position.x + (vertical ? side * curbOffset : 0);
      const z = road.position.z + (vertical ? 0 : side * curbOffset);
      const instanceIndex =
        (sharedSurfaces?.sidewalkStartIndex ?? 0) + sidewalkIndex;
      const matrix = composeMatrix(
        dummy,
        x,
        sharedSurfaces ? 0.22 : 0.13,
        z,
        vertical ? 3.6 : road.width,
        sharedSurfaces ? 1 : 0.18,
        vertical ? road.depth : 3.6,
      );
      if (sharedSurfaces) {
        setLowFixedInstance(
          sharedSurfaces,
          instanceIndex,
          matrix,
          sharedSurfaces.color.setHex(curbPalette[road.district]),
        );
      } else {
        sidewalks.setMatrixAt(instanceIndex, matrix);
        sidewalks.setColorAt(
          instanceIndex,
          new Color(curbPalette[road.district]),
        );
      }
      sidewalkIndex += 1;
    }
  }
  sidewalks.receiveShadow = !sharedSurfaces;
  if (sharedSurfaces) {
    commitLowFixedInstances(sharedSurfaces);
  } else {
    finalizeInstances(sidewalks);
  }
  if (!sharedSurfaces && sidewalkGeometry && sidewalkMaterial) {
    root.add(sidewalks);
    geometries.push(sidewalkGeometry);
    materials.push(sidewalkMaterial);
  }
  return material;
}

function groupByCell<T>(
  items: readonly T[],
  positionFor: (item: T) => { readonly x: number; readonly z: number },
): readonly (readonly [CellId, readonly T[]])[] {
  const grouped = new Map<CellId, T[]>();
  for (const item of items) {
    const cellId = cellIdAt(positionFor(item));
    const recipes = grouped.get(cellId) ?? [];
    recipes.push(item);
    grouped.set(cellId, recipes);
  }
  return [...grouped.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function indexCellRecipes(layout: CityLayout): ReadonlyMap<CellId, CityCellVisualRecipes> {
  const recipes = new Map<CellId, {
    buildings: BuildingRecipe[];
    props: PropRecipe[];
    traversal: TraversalObstacleRecipe[];
  }>();
  const ensure = (cellId: CellId) => {
    const existing = recipes.get(cellId);
    if (existing) {
      return existing;
    }
    const cellRecipes = { buildings: [], props: [], traversal: [] };
    recipes.set(cellId, cellRecipes);
    return cellRecipes;
  };

  for (const [cellId, buildings] of groupByCell(
    layout.buildings,
    (building) => building.position,
  )) {
    ensure(cellId).buildings.push(...buildings);
  }
  for (const [cellId, props] of groupByCell(
    layout.props,
    (prop) => prop.position,
  )) {
    ensure(cellId).props.push(...props);
  }
  for (const [cellId, traversal] of groupByCell(
    layout.traversalObstacles,
    (obstacle) => ({
      x: (obstacle.minX + obstacle.maxX) / 2,
      z: (obstacle.minZ + obstacle.maxZ) / 2,
    }),
  )) {
    ensure(cellId).traversal.push(...traversal);
  }
  return recipes;
}

function createSharedResources(
  geometries: BufferGeometry[],
  materials: CityDisposableMaterial[],
): CityVisualSharedResources {
  const buildingGeometry = new BoxGeometry(1, 1, 1);
  const buildingMaterials = DISTRICTS.map((district) =>
    new MeshStandardMaterial({
      color: 0xffffff,
      emissive: district.emissiveColor,
      emissiveIntensity: 0.08,
      roughness: 0.72,
      metalness: district.id === 'alta-vista' ? 0.18 : 0.04,
    }),
  );
  const facadeGeometry = new BoxGeometry(1, 1, 1);
  const facadeMaterial = new MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x10283c,
    emissiveIntensity: 0.34,
    roughness: 0.34,
    metalness: 0.22,
  });
  const accentMaterial = new MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x281018,
    emissiveIntensity: 0.28,
    roughness: 0.62,
    metalness: 0.06,
  });
  const streetDetailGeometry = new BoxGeometry(1, 1, 1);
  const streetDetailMaterial = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.8,
    metalness: 0.08,
  });
  const stemGeometry = new CylinderGeometry(0.5, 0.68, 1, 6);
  const stemMaterial = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.88,
  });
  const foliageGeometry = new ConeGeometry(1, 1, 6);
  const foliageMaterial = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.9,
  });
  const lightGeometry = new IcosahedronGeometry(0.32, 0);
  const lightMaterial = new MeshStandardMaterial({
    color: 0xfff2c3,
    emissive: 0xffb74f,
    emissiveIntensity: 2.2,
  });
  const containerGeometry = new BoxGeometry(1, 1, 1);
  const containerMaterial = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.78,
    metalness: 0.2,
  });
  const traversalGeometry = new BoxGeometry(1, 1, 1);
  const traversalMaterial = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.72,
  });
  geometries.push(
    buildingGeometry,
    facadeGeometry,
    streetDetailGeometry,
    stemGeometry,
    foliageGeometry,
    lightGeometry,
    containerGeometry,
    traversalGeometry,
  );
  materials.push(
    ...buildingMaterials,
    facadeMaterial,
    accentMaterial,
    streetDetailMaterial,
    stemMaterial,
    foliageMaterial,
    lightMaterial,
    containerMaterial,
    traversalMaterial,
  );
  return {
    buildingGeometry,
    buildingMaterials,
    facadeGeometry,
    facadeMaterial,
    accentMaterial,
    streetDetailGeometry,
    streetDetailMaterial,
    stemGeometry,
    stemMaterial,
    foliageGeometry,
    foliageMaterial,
    lightGeometry,
    lightMaterial,
    containerGeometry,
    containerMaterial,
    traversalGeometry,
    traversalMaterial,
  };
}

function createCellPayload(cellId: CellId): CityCellVisualPayload {
  const cellRoot = new Group();
  cellRoot.name = `city-payload:${cellId}`;
  return {
    cellId,
    root: cellRoot,
    structures: [],
    props: [],
    traversal: [],
  };
}

function finalizeInstances(mesh: InstancedMesh): void {
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) {
    mesh.instanceColor.needsUpdate = true;
  }
}

function setLowSharedRoadColor(
  sharedSurfaces: LowSharedSurfaceBatch | null,
  color: Readonly<Color>,
): void {
  if (!sharedSurfaces) {
    return;
  }
  const endIndex = sharedSurfaces.roadStartIndex + sharedSurfaces.roadInstanceCount;
  for (
    let index = sharedSurfaces.roadStartIndex;
    index < endIndex;
    index += 1
  ) {
    const storedColor = sharedSurfaces.fixedColors[index];
    if (!storedColor) {
      throw new Error(`Missing low-quality road color ${index}`);
    }
    storedColor.copy(color);
    sharedSurfaces.surfaceMesh.setColorAt(index, storedColor);
  }
  if (sharedSurfaces.surfaceMesh.instanceColor) {
    sharedSurfaces.surfaceMesh.instanceColor.needsUpdate = true;
  }
}

function recordDensityMesh(
  payload: CityCellVisualPayload,
  kind: 'structures' | 'props' | 'traversal',
  mesh: InstancedMesh,
  shadowCaster: boolean,
  shadowKey: string,
  instancesPerDensityUnit = 1,
): void {
  const capacity = mesh.count;
  if (
    !Number.isSafeInteger(instancesPerDensityUnit)
    || instancesPerDensityUnit <= 0
    || capacity % instancesPerDensityUnit !== 0
  ) {
    throw new RangeError('density unit size must evenly divide mesh capacity');
  }
  mesh.computeBoundingSphere();
  payload.root.add(mesh);
  payload[kind].push({
    mesh,
    capacity,
    instancesPerDensityUnit,
    shadowCaster,
    shadowKey: `${payload.cellId}:${shadowKey}`,
  });
}

function buildingFaceMatrix(
  dummy: Object3D,
  building: Readonly<BuildingRecipe>,
  face: 'front' | 'side',
  y: number,
  height: number,
  alongScale: number,
  thickness: number,
  outwardOffset = 0,
): Matrix4 {
  const facesZ = building.frontage === 'north' || building.frontage === 'south';
  const frontSign =
    building.frontage === 'north' || building.frontage === 'west' ? -1 : 1;
  if (face === 'front') {
    return facesZ
      ? composeMatrix(
        dummy,
        building.position.x,
        y,
        building.position.z + frontSign * (building.depth / 2 + outwardOffset),
        building.width * alongScale,
        height,
        thickness,
      )
      : composeMatrix(
        dummy,
        building.position.x + frontSign * (building.width / 2 + outwardOffset),
        y,
        building.position.z,
        thickness,
        height,
        building.depth * alongScale,
      );
  }
  return facesZ
    ? composeMatrix(
      dummy,
      building.position.x + building.width / 2 + 0.035,
      y,
      building.position.z,
      thickness,
      height,
      building.depth * alongScale,
    )
    : composeMatrix(
      dummy,
      building.position.x,
      y,
      building.position.z + building.depth / 2 + 0.035,
      building.width * alongScale,
      height,
      thickness,
    );
}

function facadeCoverage(building: Readonly<BuildingRecipe>): number {
  switch (building.facadeStyle) {
    case 'art-deco':
      return 0.54;
    case 'glass-grid':
      return 0.82;
    case 'stucco-arcade':
      return 0.62;
    case 'warehouse-bay':
      return 0.74;
  }
}

const BUILDING_SOLID_PARTS = 4;
const BUILDING_FACADE_PARTS = 5;

const BUILDING_SOLID_LAYERS = Object.freeze([
  'shell',
  'storefront',
  'roof-cap',
  'roof-feature',
] as const);

const BUILDING_FACADE_LAYERS = Object.freeze([
  'facade-front',
  'facade-side',
  'facade-accent',
  'window-band-low',
  'window-band-high',
] as const);

const buildingInstanceColor = new Color();

function setBuildingPart(
  mesh: InstancedMesh,
  index: number,
  matrix: Matrix4,
  color: number,
): void {
  mesh.setMatrixAt(index, matrix);
  mesh.setColorAt(index, buildingInstanceColor.setHex(color));
}

function buildingStorefrontMatrix(
  dummy: Object3D,
  building: Readonly<BuildingRecipe>,
): Matrix4 {
  const canopy =
    building.storefrontStyle === 'awning'
    || building.storefrontStyle === 'arcade';
  const height = canopy
    ? building.storefrontStyle === 'arcade' ? 0.42 : 0.28
    : building.storefrontStyle === 'loading-bay' ? 3.8 : 4.2;
  const thickness = canopy
    ? building.storefrontStyle === 'arcade' ? 1.6 : 1.35
    : 0.18;
  return buildingFaceMatrix(
    dummy,
    building,
    'front',
    canopy ? 3.15 : height / 2,
    height,
    building.storefrontStyle === 'loading-bay' ? 0.54 : 0.68,
    thickness,
    canopy ? thickness / 2 : 0.11,
  );
}

function buildingRoofCapMatrix(
  dummy: Object3D,
  building: Readonly<BuildingRecipe>,
): Matrix4 {
  const capHeight =
    building.roofStyle === 'step' ? Math.min(3.2, building.height * 0.12) : 0.28;
  const footprint = building.roofStyle === 'step' ? 0.68 : 0.9;
  return composeMatrix(
    dummy,
    building.position.x,
    building.height + capHeight / 2,
    building.position.z,
    building.width * footprint,
    capHeight,
    building.depth * footprint,
  );
}

function buildingRoofFeatureMatrix(
  dummy: Object3D,
  building: Readonly<BuildingRecipe>,
): Matrix4 {
  const baseY =
    building.height
    + (building.roofStyle === 'step' ? Math.min(3.2, building.height * 0.12) : 0.28);
  switch (building.roofFeature) {
    case 'neon-crown': {
      const height = building.landmark ? 7.5 : 3.5;
      return composeMatrix(
        dummy,
        building.position.x,
        baseY + height / 2,
        building.position.z,
        building.width * 0.56,
        height,
        0.38,
      );
    }
    case 'antenna': {
      const height = building.landmark ? 13 : 5.5;
      return composeMatrix(
        dummy,
        building.position.x,
        baseY + height / 2,
        building.position.z,
        0.34,
        height,
        0.34,
      );
    }
    case 'terrace':
      return composeMatrix(
        dummy,
        building.position.x,
        baseY + 0.9,
        building.position.z,
        building.width * 0.45,
        1.8,
        building.depth * 0.44,
      );
    case 'water-tank':
      return composeMatrix(
        dummy,
        building.position.x,
        baseY + 1.5,
        building.position.z,
        building.landmark ? 4.6 : 3.2,
        3,
        building.landmark ? 4.6 : 3.2,
      );
    case 'gantry': {
      const height = building.landmark ? 6.5 : 3.2;
      return composeMatrix(
        dummy,
        building.position.x,
        baseY + height / 2,
        building.position.z,
        building.width * 0.68,
        height,
        0.42,
      );
    }
    case 'vents':
      return composeMatrix(
        dummy,
        building.position.x + building.width * 0.18,
        baseY + 0.8,
        building.position.z - building.depth * 0.16,
        2.1,
        1.6,
        1.5,
      );
  }
}

function writeBuildingPartsToMeshes(
  solids: InstancedMesh,
  facades: InstancedMesh,
  building: Readonly<BuildingRecipe>,
  solidIndex: number,
  facadeIndex: number,
  dummy: Object3D,
): void {
  setBuildingPart(
    solids,
    solidIndex,
    composeMatrix(
      dummy,
      building.position.x,
      building.position.y,
      building.position.z,
      building.width,
      building.height,
      building.depth,
    ),
    building.color,
  );
  setBuildingPart(
    solids,
    solidIndex + 1,
    buildingStorefrontMatrix(dummy, building),
    building.accentColor,
  );
  setBuildingPart(
    solids,
    solidIndex + 2,
    buildingRoofCapMatrix(dummy, building),
    building.accentColor,
  );
  setBuildingPart(
    solids,
    solidIndex + 3,
    buildingRoofFeatureMatrix(dummy, building),
    building.accentColor,
  );

  const facadeHeight = Math.max(2.5, building.height * 0.54);
  setBuildingPart(
    facades,
    facadeIndex,
    buildingFaceMatrix(
      dummy,
      building,
      'front',
      building.height * 0.64,
      facadeHeight,
      facadeCoverage(building),
      0.12,
      0.065,
    ),
    building.glassColor,
  );
  setBuildingPart(
    facades,
    facadeIndex + 1,
    buildingFaceMatrix(
      dummy,
      building,
      'side',
      building.height * 0.66,
      Math.max(2.3, building.height * 0.46),
      Math.max(0.36, facadeCoverage(building) - 0.12),
      0.1,
    ),
    building.glassColor,
  );
  const horizontalAccent =
    building.facadeStyle === 'stucco-arcade'
    || building.facadeStyle === 'warehouse-bay';
  setBuildingPart(
    facades,
    facadeIndex + 2,
    buildingFaceMatrix(
      dummy,
      building,
      'front',
      horizontalAccent
        ? Math.min(building.height * 0.72, 5.6)
        : building.height * 0.58,
      horizontalAccent ? 0.34 : Math.max(2.6, building.height * 0.68),
      horizontalAccent ? 0.82 : 0.1,
      0.17,
      0.1,
    ),
    building.accentColor,
  );
  for (const [offset, heightRatio] of [
    [3, 0.38],
    [4, 0.72],
  ] as const) {
    setBuildingPart(
      facades,
      facadeIndex + offset,
      composeMatrix(
        dummy,
        building.position.x,
        Math.max(3.4, building.height * heightRatio),
        building.position.z,
        building.width + 0.14,
        building.facadeStyle === 'warehouse-bay' ? 0.32 : 0.48,
        building.depth + 0.14,
      ),
      building.glassColor,
    );
  }
}

function createLowBuildingCellBatches(
  root: Group,
  buildings: readonly BuildingRecipe[],
  sharedSurfaces: LowSharedSurfaceBatch,
): {
  readonly root: Group;
  readonly batches: readonly LowBuildingCellBatch[];
} {
  const lowQualityRoot = new Group();
  lowQualityRoot.name = 'city-buildings-low-quality';
  const dummy = new Object3D();
  const batches = groupByCell(
    buildings,
    (building) => building.position,
  ).map(([cellId, cellBuildings]) => {
    const mesh = new InstancedMesh(
      sharedSurfaces.buildingGeometry,
      sharedSurfaces.buildingMaterial,
      cellBuildings.length * (BUILDING_SOLID_PARTS + BUILDING_FACADE_PARTS),
    );
    mesh.name = `city-building-cluster:${cellId}`;
    mesh.userData.cellId = cellId;
    mesh.userData.visualLayers = [
      ...BUILDING_SOLID_LAYERS,
      ...BUILDING_FACADE_LAYERS,
    ];
    cellBuildings.forEach((building, buildingIndex) => {
      const solidIndex = buildingIndex * (
        BUILDING_SOLID_PARTS + BUILDING_FACADE_PARTS
      );
      writeBuildingPartsToMeshes(
        mesh,
        mesh,
        building,
        solidIndex,
        solidIndex + BUILDING_SOLID_PARTS,
        dummy,
      );
    });
    finalizeInstances(mesh);
    // Bounds include every density tier in the cell, so camera culling remains
    // conservative when adaptive density changes the visible prefix.
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = -2;
    lowQualityRoot.add(mesh);
    return {
      cellId,
      mesh,
      buildingCount: cellBuildings.length,
    };
  });
  root.add(lowQualityRoot);
  return { root: lowQualityRoot, batches };
}

function createBuildingBatches(
  root: Group,
  buildings: readonly BuildingRecipe[],
  quality: WorldQuality,
  resources: CityVisualSharedResources,
  lowSharedBatch: LowSharedSurfaceBatch | null,
): CityBuildingVisualBatches {
  const solids = DISTRICTS.map((district, districtIndex) => {
    const material = resources.buildingMaterials[districtIndex];
    if (!material) throw new Error(`City building material is unavailable for ${district.id}`);
    const capacity = buildings.filter((building) => building.district === district.id).length;
    const mesh = new InstancedMesh(
      resources.buildingGeometry,
      material,
      capacity * BUILDING_SOLID_PARTS,
    );
    mesh.name = `city-building-solids:${district.id}`;
    mesh.userData.visualLayers = BUILDING_SOLID_LAYERS;
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.castShadow = quality === 'high';
    mesh.receiveShadow = true;
    return mesh;
  });
  const facades = new InstancedMesh(
    resources.facadeGeometry,
    resources.facadeMaterial,
    buildings.length * BUILDING_FACADE_PARTS,
  );
  facades.name = 'city-building-facades';
  facades.userData.visualLayers = BUILDING_FACADE_LAYERS;
  facades.count = 0;
  facades.visible = false;
  // Active cells are compacted into these buffers whenever streaming changes.
  // Their world-space bounds therefore change too; disabling frustum culling
  // avoids a full-city bound and keeps transitions allocation-free.
  facades.frustumCulled = false;
  facades.receiveShadow = true;
  root.add(...solids, facades);
  const lowQuality = lowSharedBatch
    ? createLowBuildingCellBatches(root, buildings, lowSharedBatch)
    : null;
  return {
    solids,
    facades,
    lowQuality: lowQuality?.batches ?? null,
    lowQualityRoot: lowQuality?.root ?? null,
    lowSharedBatch,
    quality,
    dummy: new Object3D(),
  };
}

function propStemDimensions(prop: PropRecipe): readonly [number, number] {
  switch (prop.kind) {
    case 'palm':
      return [0.34 * prop.scale, 7.2 * prop.scale];
    case 'tree':
      return [0.45 * prop.scale, 4.4 * prop.scale];
    case 'streetlight':
      return [0.13 * prop.scale, 6.2 * prop.scale];
    case 'bollard':
      return [0.22 * prop.scale, 1.05 * prop.scale];
    case 'container':
    case 'bench':
    case 'planter':
    case 'kiosk':
    case 'market-stall':
    case 'transit-shelter':
    case 'sculpture':
    case 'cargo-pallet':
    case 'pipe-stack':
      return [0, 0];
  }
}

function createProps(
  payload: CityCellVisualPayload,
  cellProps: readonly PropRecipe[],
  resources: CityVisualSharedResources,
): void {
  const dummy = new Object3D();
  const vegetation = cellProps.filter(
    (prop) => prop.kind === 'palm' || prop.kind === 'tree',
  );
  if (vegetation.length > 0) {
    const stemMesh = new InstancedMesh(
      resources.stemGeometry,
      resources.stemMaterial,
      vegetation.length,
    );
    stemMesh.name = `city-vegetation-stems:${payload.cellId}`;
    const foliageMesh = new InstancedMesh(
      resources.foliageGeometry,
      resources.foliageMaterial,
      vegetation.length,
    );
    foliageMesh.name = `city-foliage:${payload.cellId}`;
    vegetation.forEach((prop, index) => {
      const [radius, height] = propStemDimensions(prop);
      stemMesh.setMatrixAt(
        index,
        composeMatrix(
          dummy,
          prop.position.x,
          height / 2,
          prop.position.z,
          radius,
          height,
          radius,
          prop.rotation,
        ),
      );
      stemMesh.setColorAt(index, new Color(0x755235));
      const palm = prop.kind === 'palm';
      foliageMesh.setMatrixAt(
        index,
        composeMatrix(
          dummy,
          prop.position.x,
          (palm ? 8.1 : 6.2) * prop.scale,
          prop.position.z,
          (palm ? 3.2 : 2.6) * prop.scale,
          (palm ? 4.2 : 4.8) * prop.scale,
          (palm ? 3.2 : 2.6) * prop.scale,
          prop.rotation,
        ),
      );
      foliageMesh.setColorAt(index, new Color(palm ? 0x2f9f6a : 0x4d8d50));
    });
    stemMesh.castShadow = true;
    foliageMesh.castShadow = true;
    finalizeInstances(stemMesh);
    finalizeInstances(foliageMesh);
    recordDensityMesh(payload, 'props', stemMesh, true, 'vegetation-stems');
    recordDensityMesh(payload, 'props', foliageMesh, true, 'foliage');
  }

  const lights = cellProps.filter((prop) => prop.kind === 'streetlight');
  if (lights.length > 0) {
    const stemMesh = new InstancedMesh(
      resources.stemGeometry,
      resources.stemMaterial,
      lights.length,
    );
    stemMesh.name = `city-light-stems:${payload.cellId}`;
    const lightMesh = new InstancedMesh(
      resources.lightGeometry,
      resources.lightMaterial,
      lights.length,
    );
    lightMesh.name = `city-lights:${payload.cellId}`;
    lights.forEach((prop, index) => {
      const [radius, height] = propStemDimensions(prop);
      stemMesh.setMatrixAt(
        index,
        composeMatrix(
          dummy,
          prop.position.x,
          height / 2,
          prop.position.z,
          radius,
          height,
          radius,
          prop.rotation,
        ),
      );
      stemMesh.setColorAt(index, new Color(0x46525a));
      lightMesh.setMatrixAt(
        index,
        composeMatrix(
          dummy,
          prop.position.x,
          6.25 * prop.scale,
          prop.position.z,
          1,
          1,
          1,
        ),
      );
    });
    stemMesh.castShadow = true;
    finalizeInstances(stemMesh);
    finalizeInstances(lightMesh);
    recordDensityMesh(payload, 'props', stemMesh, true, 'light-stems');
    recordDensityMesh(payload, 'props', lightMesh, false, 'light-heads');
  }

  const bollards = cellProps.filter((prop) => prop.kind === 'bollard');
  if (bollards.length > 0) {
    const mesh = new InstancedMesh(
      resources.stemGeometry,
      resources.stemMaterial,
      bollards.length,
    );
    mesh.name = `city-bollards:${payload.cellId}`;
    bollards.forEach((prop, index) => {
      const [radius, height] = propStemDimensions(prop);
      mesh.setMatrixAt(
        index,
        composeMatrix(
          dummy,
          prop.position.x,
          height / 2,
          prop.position.z,
          radius,
          height,
          radius,
          prop.rotation,
        ),
      );
      mesh.setColorAt(index, new Color(0x46525a));
    });
    mesh.castShadow = true;
    finalizeInstances(mesh);
    recordDensityMesh(payload, 'props', mesh, true, 'bollards');
  }

  const containers = cellProps.filter((prop) => prop.kind === 'container');
  if (containers.length > 0) {
    const mesh = new InstancedMesh(
      resources.containerGeometry,
      resources.containerMaterial,
      containers.length,
    );
    mesh.name = `city-containers:${payload.cellId}`;
    containers.forEach((prop, index) => {
      mesh.setMatrixAt(
        index,
        composeMatrix(
          dummy,
          prop.position.x,
          1.25 * prop.scale,
          prop.position.z,
          5.8 * prop.scale,
          2.5 * prop.scale,
          2.45 * prop.scale,
          prop.rotation,
        ),
      );
      mesh.setColorAt(index, new Color(prop.color));
    });
    mesh.castShadow = true;
    finalizeInstances(mesh);
    recordDensityMesh(payload, 'props', mesh, true, 'containers');
  }

  const planters = cellProps.filter((prop) => prop.kind === 'planter');
  if (planters.length > 0) {
    const pots = new InstancedMesh(
      resources.streetDetailGeometry,
      resources.streetDetailMaterial,
      planters.length,
    );
    pots.name = `city-planters:${payload.cellId}`;
    const crowns = new InstancedMesh(
      resources.foliageGeometry,
      resources.foliageMaterial,
      planters.length,
    );
    crowns.name = `city-planter-foliage:${payload.cellId}`;
    planters.forEach((prop, index) => {
      pots.setMatrixAt(
        index,
        composeMatrix(
          dummy,
          prop.position.x,
          0.42 * prop.scale,
          prop.position.z,
          1.25 * prop.scale,
          0.84 * prop.scale,
          1.25 * prop.scale,
          prop.rotation,
        ),
      );
      pots.setColorAt(index, new Color(prop.color));
      crowns.setMatrixAt(
        index,
        composeMatrix(
          dummy,
          prop.position.x,
          1.35 * prop.scale,
          prop.position.z,
          1.35 * prop.scale,
          1.5 * prop.scale,
          1.35 * prop.scale,
          prop.rotation,
        ),
      );
      crowns.setColorAt(index, new Color(0x3f8452));
    });
    finalizeInstances(pots);
    finalizeInstances(crowns);
    recordDensityMesh(payload, 'props', pots, true, 'planters');
    recordDensityMesh(payload, 'props', crowns, true, 'planter-foliage');
  }

  const furniture = cellProps.filter((prop) =>
    prop.kind === 'bench'
    || prop.kind === 'kiosk'
    || prop.kind === 'market-stall'
    || prop.kind === 'transit-shelter',
  );
  if (furniture.length > 0) {
    const bases = new InstancedMesh(
      resources.streetDetailGeometry,
      resources.streetDetailMaterial,
      furniture.length,
    );
    bases.name = `city-street-furniture:${payload.cellId}`;
    const tops = new InstancedMesh(
      resources.streetDetailGeometry,
      resources.accentMaterial,
      furniture.length,
    );
    tops.name = `city-street-furniture-accents:${payload.cellId}`;
    furniture.forEach((prop, index) => {
      switch (prop.kind) {
        case 'bench': {
          const backrestOffset = 0.31 * prop.scale;
          bases.setMatrixAt(
            index,
            composeMatrix(
              dummy,
              prop.position.x,
              0.55 * prop.scale,
              prop.position.z,
              2.4 * prop.scale,
              0.22 * prop.scale,
              0.72 * prop.scale,
              prop.rotation,
            ),
          );
          tops.setMatrixAt(
            index,
            composeMatrix(
              dummy,
              prop.position.x - Math.sin(prop.rotation) * backrestOffset,
              1.05 * prop.scale,
              prop.position.z - Math.cos(prop.rotation) * backrestOffset,
              2.4 * prop.scale,
              0.82 * prop.scale,
              0.16 * prop.scale,
              prop.rotation,
            ),
          );
          break;
        }
        case 'kiosk':
          bases.setMatrixAt(
            index,
            composeMatrix(
              dummy,
              prop.position.x,
              1.25 * prop.scale,
              prop.position.z,
              2.3 * prop.scale,
              2.5 * prop.scale,
              1.8 * prop.scale,
              prop.rotation,
            ),
          );
          tops.setMatrixAt(
            index,
            composeMatrix(
              dummy,
              prop.position.x,
              2.75 * prop.scale,
              prop.position.z,
              2.9 * prop.scale,
              0.28 * prop.scale,
              2.25 * prop.scale,
              prop.rotation,
            ),
          );
          break;
        case 'market-stall':
          bases.setMatrixAt(
            index,
            composeMatrix(
              dummy,
              prop.position.x,
              0.72 * prop.scale,
              prop.position.z,
              2.8 * prop.scale,
              1.44 * prop.scale,
              1.55 * prop.scale,
              prop.rotation,
            ),
          );
          tops.setMatrixAt(
            index,
            composeMatrix(
              dummy,
              prop.position.x,
              2.35 * prop.scale,
              prop.position.z,
              3.4 * prop.scale,
              0.3 * prop.scale,
              2.3 * prop.scale,
              prop.rotation,
            ),
          );
          break;
        case 'transit-shelter':
          bases.setMatrixAt(
            index,
            composeMatrix(
              dummy,
              prop.position.x,
              1.35 * prop.scale,
              prop.position.z,
              3.6 * prop.scale,
              2.7 * prop.scale,
              0.16 * prop.scale,
              prop.rotation,
            ),
          );
          tops.setMatrixAt(
            index,
            composeMatrix(
              dummy,
              prop.position.x,
              2.78 * prop.scale,
              prop.position.z,
              4 * prop.scale,
              0.22 * prop.scale,
              1.6 * prop.scale,
              prop.rotation,
            ),
          );
          break;
      }
      bases.setColorAt(index, new Color(prop.color));
      tops.setColorAt(index, new Color(prop.color));
    });
    bases.castShadow = true;
    tops.castShadow = true;
    finalizeInstances(bases);
    finalizeInstances(tops);
    recordDensityMesh(payload, 'props', bases, true, 'street-furniture');
    recordDensityMesh(payload, 'props', tops, true, 'street-furniture-accents');
  }

  const industrialDetails = cellProps.filter((prop) =>
    prop.kind === 'cargo-pallet' || prop.kind === 'pipe-stack',
  );
  if (industrialDetails.length > 0) {
    const mesh = new InstancedMesh(
      resources.streetDetailGeometry,
      resources.streetDetailMaterial,
      industrialDetails.length,
    );
    mesh.name = `city-industrial-clutter:${payload.cellId}`;
    industrialDetails.forEach((prop, index) => {
      const pipes = prop.kind === 'pipe-stack';
      mesh.setMatrixAt(
        index,
        composeMatrix(
          dummy,
          prop.position.x,
          (pipes ? 0.68 : 0.28) * prop.scale,
          prop.position.z,
          (pipes ? 2.7 : 2.35) * prop.scale,
          (pipes ? 1.36 : 0.56) * prop.scale,
          (pipes ? 1.45 : 1.85) * prop.scale,
          prop.rotation,
        ),
      );
      mesh.setColorAt(index, new Color(prop.color));
    });
    mesh.castShadow = true;
    finalizeInstances(mesh);
    recordDensityMesh(payload, 'props', mesh, true, 'industrial-clutter');
  }

  const sculptures = cellProps.filter((prop) => prop.kind === 'sculpture');
  if (sculptures.length > 0) {
    const plinths = new InstancedMesh(
      resources.streetDetailGeometry,
      resources.streetDetailMaterial,
      sculptures.length,
    );
    plinths.name = `city-sculpture-plinths:${payload.cellId}`;
    const forms = new InstancedMesh(
      resources.lightGeometry,
      resources.accentMaterial,
      sculptures.length,
    );
    forms.name = `city-sculptures:${payload.cellId}`;
    sculptures.forEach((prop, index) => {
      plinths.setMatrixAt(
        index,
        composeMatrix(
          dummy,
          prop.position.x,
          0.42 * prop.scale,
          prop.position.z,
          1.5 * prop.scale,
          0.84 * prop.scale,
          1.5 * prop.scale,
          prop.rotation,
        ),
      );
      plinths.setColorAt(index, new Color(0x9ba6aa));
      forms.setMatrixAt(
        index,
        composeMatrix(
          dummy,
          prop.position.x,
          2.25 * prop.scale,
          prop.position.z,
          3.5 * prop.scale,
          4.3 * prop.scale,
          3.5 * prop.scale,
          prop.rotation,
        ),
      );
      forms.setColorAt(index, new Color(prop.color));
    });
    plinths.castShadow = true;
    forms.castShadow = true;
    finalizeInstances(plinths);
    finalizeInstances(forms);
    recordDensityMesh(payload, 'props', plinths, true, 'sculpture-plinths');
    recordDensityMesh(payload, 'props', forms, true, 'sculptures');
  }
}

function createPropBatches(
  root: Group,
  propCapacity: number,
  quality: WorldQuality,
  resources: CityVisualSharedResources,
  lowQualityMaterial: MeshLambertMaterial | null,
): CityPropVisualBatches {
  const createBatch = (
    name: string,
    geometry: BufferGeometry,
    material: MeshStandardMaterial,
    capacity: number,
  ): InstancedMesh => {
    const mesh = new InstancedMesh(geometry, material, capacity);
    mesh.name = name;
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    root.add(mesh);
    return mesh;
  };
  const batches = {
    boxes: createBatch(
      'city-props-batch:boxes',
      resources.streetDetailGeometry,
      resources.streetDetailMaterial,
      propCapacity * 2,
    ),
    accents: createBatch(
      'city-props-batch:accents',
      resources.streetDetailGeometry,
      resources.accentMaterial,
      propCapacity,
    ),
    stems: createBatch(
      'city-props-batch:stems',
      resources.stemGeometry,
      resources.stemMaterial,
      propCapacity,
    ),
    foliage: createBatch(
      'city-props-batch:foliage',
      resources.foliageGeometry,
      resources.foliageMaterial,
      propCapacity,
    ),
    lights: createBatch(
      'city-props-batch:lights',
      resources.lightGeometry,
      resources.lightMaterial,
      propCapacity,
    ),
    sculptures: createBatch(
      'city-props-batch:sculptures',
      resources.lightGeometry,
      resources.accentMaterial,
      propCapacity,
    ),
    merged: lowQualityMaterial
      ? new Mesh(new BufferGeometry(), lowQualityMaterial)
      : null,
    mergedSources: [] as BufferGeometry[],
    quality,
    matrix: new Matrix4(),
    color: new Color(),
  };
  if (batches.merged) {
    batches.merged.name = 'city-props-merged';
    batches.merged.visible = false;
    batches.merged.frustumCulled = false;
    batches.merged.castShadow = false;
    batches.merged.receiveShadow = true;
    root.add(batches.merged);
  }
  return batches;
}

function createTraversalObstacles(
  payload: CityCellVisualPayload,
  obstacles: readonly TraversalObstacleRecipe[],
  resources: CityVisualSharedResources,
): void {
  if (obstacles.length === 0) {
    return;
  }
  const mesh = new InstancedMesh(
    resources.traversalGeometry,
    resources.traversalMaterial,
    obstacles.length,
  );
  mesh.name = `city-traversal:${payload.cellId}`;
  const dummy = new Object3D();
  obstacles.forEach((obstacle, index) => {
    const width = obstacle.maxX - obstacle.minX;
    const depth = obstacle.maxZ - obstacle.minZ;
    mesh.setMatrixAt(
      index,
      composeMatrix(
        dummy,
        (obstacle.minX + obstacle.maxX) / 2,
        obstacle.height / 2,
        (obstacle.minZ + obstacle.maxZ) / 2,
        width,
        obstacle.height,
        depth,
      ),
    );
    mesh.setColorAt(index, new Color(obstacle.color));
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  finalizeInstances(mesh);
  recordDensityMesh(payload, 'traversal', mesh, true, 'traversal');
}

function assertDrawDensity(drawDensity: Readonly<DrawDensityLimits>): void {
  if (drawDensity.roads !== 1) {
    throw new RangeError('road density must remain 1');
  }
  for (const [label, value] of [
    ['structure', drawDensity.structures],
    ['prop', drawDensity.props],
    ['actor', drawDensity.actors],
    ['shadow', drawDensity.shadows],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`${label} density must be between 0 and 1`);
    }
  }
}

function densityCount(capacity: number, density: number): number {
  return Math.min(capacity, Math.max(0, Math.floor(capacity * density)));
}

function propBatchKind(mesh: InstancedMesh): CityPropBatchKind {
  if (
    mesh.name.startsWith('city-vegetation-stems:')
    || mesh.name.startsWith('city-light-stems:')
    || mesh.name.startsWith('city-bollards:')
  ) {
    return 'stems';
  }
  if (
    mesh.name.startsWith('city-foliage:')
    || mesh.name.startsWith('city-planter-foliage:')
  ) {
    return 'foliage';
  }
  if (mesh.name.startsWith('city-lights:')) return 'lights';
  if (mesh.name.startsWith('city-sculptures:')) return 'sculptures';
  if (mesh.name.startsWith('city-street-furniture-accents:')) return 'accents';
  return 'boxes';
}

function appendMergedPropGeometry(
  record: Readonly<DensityMeshRecord>,
  index: number,
  batches: CityPropVisualBatches,
): void {
  record.mesh.getMatrixAt(index, batches.matrix);
  if (record.mesh.instanceColor) {
    record.mesh.getColorAt(index, batches.color);
  } else {
    batches.color.set(0xffffff);
  }
  const sourceGeometry = record.mesh.geometry;
  const geometry = sourceGeometry.index
    ? sourceGeometry.toNonIndexed()
    : sourceGeometry.clone();
  // MeshLambertMaterial only needs position, normal, and the generated color
  // in this low path. Removing optional primitive-specific attributes (for
  // example BoxGeometry UVs absent on an icosahedron) keeps mergeGeometries
  // structurally compatible across every authored prop kind.
  for (const attributeName of Object.keys(geometry.attributes)) {
    if (attributeName !== 'position' && attributeName !== 'normal') {
      geometry.deleteAttribute(attributeName);
    }
  }
  geometry.applyMatrix4(batches.matrix);
  const vertexCount = geometry.getAttribute('position').count;
  const colors = new Float32Array(vertexCount * 3);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const offset = vertex * 3;
    colors[offset] = batches.color.r;
    colors[offset + 1] = batches.color.g;
    colors[offset + 2] = batches.color.b;
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  batches.mergedSources.push(geometry);
}

function copyPropRecordsToBatches(
  records: readonly DensityMeshRecord[],
  density: number,
  cellVisible: boolean,
  batches: CityPropVisualBatches,
  counts: CityPropBatchCounts,
): { readonly visible: number; readonly capacity: number } {
  let visible = 0;
  let capacity = 0;
  for (const record of records) {
    const densityUnits = record.capacity / record.instancesPerDensityUnit;
    const count = densityCount(densityUnits, density) * record.instancesPerDensityUnit;
    record.mesh.count = count;
    // Resident payload meshes retain deterministic matrices and bounds as CPU/GPU
    // staging buffers, while only the five compact active batches are submitted.
    record.mesh.visible = false;
    record.mesh.castShadow = false;
    capacity += record.capacity;
    if (!cellVisible || count === 0) continue;

    const kind = propBatchKind(record.mesh);
    if (batches.merged) {
      for (let index = 0; index < count; index += 1) {
        appendMergedPropGeometry(record, index, batches);
      }
      counts[kind] += count;
      visible += count;
      continue;
    }

    const target = batches[kind];
    const firstTargetIndex = counts[kind];
    const targetCapacity = target.instanceMatrix.count;
    if (counts[kind] + count > targetCapacity) {
      throw new RangeError(`city prop ${kind} batch capacity exceeded`);
    }
    for (let index = 0; index < count; index += 1) {
      record.mesh.getMatrixAt(index, batches.matrix);
      target.setMatrixAt(firstTargetIndex + index, batches.matrix);
      if (record.mesh.instanceColor) {
        record.mesh.getColorAt(index, batches.color);
        target.setColorAt(firstTargetIndex + index, batches.color);
      }
    }
    counts[kind] += count;
    visible += count;
  }
  return { visible, capacity };
}

function finalizePropBatches(
  batches: CityPropVisualBatches,
  counts: Readonly<CityPropBatchCounts>,
  shadowDensity: number,
): number {
  if (batches.merged) {
    let totalCount = 0;
    for (const kind of [
      'boxes',
      'accents',
      'stems',
      'foliage',
      'lights',
      'sculptures',
    ] as const) {
      const count = counts[kind];
      totalCount += count;
      const fallback = batches[kind];
      fallback.count = 0;
      fallback.visible = false;
      fallback.castShadow = false;
    }
    const nextGeometry = batches.mergedSources.length > 0
      ? mergeGeometries(batches.mergedSources, false) as BufferGeometry | null
      : new BufferGeometry();
    if (!nextGeometry) {
      batches.mergedSources.forEach((geometry) => geometry.dispose());
      batches.mergedSources.length = 0;
      throw new Error('Low-quality prop geometry merge failed');
    }
    batches.mergedSources.forEach((geometry) => geometry.dispose());
    batches.mergedSources.length = 0;
    batches.merged.geometry.dispose();
    batches.merged.geometry = nextGeometry;
    batches.merged.visible = totalCount > 0;
    return 0;
  }

  let shadows = 0;
  for (const kind of [
    'boxes',
    'accents',
    'stems',
    'foliage',
    'lights',
    'sculptures',
  ] as const) {
    const mesh = batches[kind];
    const count = counts[kind];
    const sampledShadow =
      shadowDensity >= 1
      || (
        shadowDensity > 0
        && shadowSample(`city-props-batch:${kind}`) < shadowDensity
      );
    mesh.count = count;
    mesh.visible = count > 0;
    mesh.castShadow =
      batches.quality === 'high'
      && kind !== 'lights'
      && count > 0
      && sampledShadow;
    mesh.receiveShadow = kind !== 'lights';
    if (count > 0) finalizeInstances(mesh);
    if (mesh.castShadow) shadows += count;
  }
  return shadows;
}

function applyBuildingStreamingState(
  batches: CityBuildingVisualBatches,
  activeCellIds: readonly CellId[],
  recipeIndex: ReadonlyMap<CellId, CityCellVisualRecipes>,
  structureDensity: number,
  shadowDensity: number,
): { readonly visible: number; readonly shadows: number } {
  if (batches.lowQuality) {
    const active = new Set(activeCellIds);
    let visibleStructures = 0;
    for (const batch of batches.lowQuality) {
      const visibleBuildings = active.has(batch.cellId)
        ? densityCount(batch.buildingCount, structureDensity)
        : 0;
      const count = visibleBuildings * (
        BUILDING_SOLID_PARTS + BUILDING_FACADE_PARTS
      );
      batch.mesh.count = count;
      batch.mesh.visible = count > 0;
      batch.mesh.castShadow = false;
      visibleStructures += count;
    }
    batches.lowQualityRoot?.updateMatrixWorld(true);
    batches.solids.forEach((mesh) => {
      mesh.count = 0;
      mesh.visible = false;
      mesh.castShadow = false;
    });
    batches.facades.count = 0;
    batches.facades.visible = false;
    return {
      visible: visibleStructures,
      shadows: 0,
    };
  }

  let facadeBuildingIndex = 0;
  const solidBuildingCounts = DISTRICTS.map(() => 0);
  for (const cellId of activeCellIds) {
    const buildings = recipeIndex.get(cellId)?.buildings ?? [];
    const visibleBuildings = densityCount(buildings.length, structureDensity);
    for (let index = 0; index < visibleBuildings; index += 1) {
      const building = buildings[index];
      if (building) {
        const districtIndex = DISTRICTS.findIndex(
          (district) => district.id === building.district,
        );
        const districtBuildingIndex = solidBuildingCounts[districtIndex];
        if (districtBuildingIndex === undefined) {
          throw new Error(`Missing building count for ${building.district}`);
        }
        const solids = batches.solids[districtIndex];
        if (!solids) {
          throw new Error(`Missing building batch for ${building.district}`);
        }
        writeBuildingPartsToMeshes(
          solids,
          batches.facades,
          building,
          districtBuildingIndex * BUILDING_SOLID_PARTS,
          facadeBuildingIndex * BUILDING_FACADE_PARTS,
          batches.dummy,
        );
        solidBuildingCounts[districtIndex] = districtBuildingIndex + 1;
        facadeBuildingIndex += 1;
      }
    }
  }

  let solidCount = 0;
  let shadows = 0;
  batches.solids.forEach((mesh, districtIndex) => {
    const count = (solidBuildingCounts[districtIndex] ?? 0) * BUILDING_SOLID_PARTS;
    const sampledShadow =
      shadowDensity >= 1
      || (
        shadowDensity > 0
        && shadowSample(`city-building-solids:${DISTRICTS[districtIndex]?.id ?? districtIndex}`)
          < shadowDensity
      );
    mesh.count = count;
    mesh.visible = count > 0;
    mesh.castShadow = batches.quality === 'high' && count > 0 && sampledShadow;
    if (count > 0) finalizeInstances(mesh);
    solidCount += count;
    if (mesh.castShadow) shadows += count;
  });
  const facadeCount = facadeBuildingIndex * BUILDING_FACADE_PARTS;
  batches.facades.count = facadeCount;
  batches.facades.visible = facadeCount > 0;
  if (facadeBuildingIndex > 0) {
    finalizeInstances(batches.facades);
  }
  return {
    visible: solidCount + facadeCount,
    shadows,
  };
}

function shadowSample(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

function applyDensity(
  records: readonly DensityMeshRecord[],
  density: number,
  shadowDensity: number,
  cellVisible: boolean,
): { readonly visible: number; readonly capacity: number; readonly shadows: number } {
  let visible = 0;
  let capacity = 0;
  let shadows = 0;
  for (const record of records) {
    const densityUnits = record.capacity / record.instancesPerDensityUnit;
    const count = densityCount(densityUnits, density) * record.instancesPerDensityUnit;
    record.mesh.count = count;
    record.mesh.visible = count > 0;
    record.mesh.castShadow =
      cellVisible
      && count > 0
      && record.shadowCaster
      && (shadowDensity >= 1
        || (shadowDensity > 0 && shadowSample(record.shadowKey) < shadowDensity));
    capacity += record.capacity;
    if (cellVisible) {
      visible += count;
      if (record.mesh.castShadow) {
        shadows += count;
      }
    }
  }
  return { visible, capacity, shadows };
}

function instantiateCellPayload(
  root: Group,
  cellId: CellId,
  recipes: CityCellVisualRecipes,
  resources: CityVisualSharedResources,
): CityCellVisualPayload {
  const payload = createCellPayload(cellId);
  createProps(payload, recipes.props, resources);
  createTraversalObstacles(payload, recipes.traversal, resources);
  root.add(payload.root);
  return payload;
}

function releaseCellPayload(payload: CityCellVisualPayload): void {
  payload.root.traverse((object) => {
    if (object instanceof InstancedMesh) {
      object.dispose();
    }
  });
  payload.root.removeFromParent();
  payload.root.clear();
}

function applyStreamingState(
  root: Group,
  recipeIndex: ReadonlyMap<CellId, CityCellVisualRecipes>,
  payloads: Map<CellId, CityCellVisualPayload>,
  buildingBatches: CityBuildingVisualBatches,
  propBatches: CityPropVisualBatches,
  resources: CityVisualSharedResources,
  renderableActiveCellIds: readonly CellId[],
  requestedResidentCellIds: readonly CellId[],
  drawDensity: Readonly<DrawDensityLimits>,
): CityVisualStreamingSnapshot {
  assertDrawDensity(drawDensity);
  for (const cellId of [
    ...renderableActiveCellIds,
    ...requestedResidentCellIds,
  ]) {
    parseCellId(cellId);
  }
  const activeCellIds = [...new Set(renderableActiveCellIds)].sort((left, right) =>
    left.localeCompare(right),
  );
  const knownCellIds = [...recipeIndex.keys()].sort((left, right) =>
    left.localeCompare(right),
  );
  const residentCellIds = [...new Set(requestedResidentCellIds)]
    .filter((cellId) => recipeIndex.has(cellId))
    .sort((left, right) => left.localeCompare(right));
  const requestedResident = new Set(residentCellIds);
  const evictedCellIds = [...payloads.keys()]
    .filter((cellId) => !requestedResident.has(cellId))
    .sort((left, right) => left.localeCompare(right));
  for (const cellId of evictedCellIds) {
    const payload = payloads.get(cellId);
    if (payload) {
      releaseCellPayload(payload);
      payloads.delete(cellId);
    }
  }
  const createdCellIds: CellId[] = [];
  for (const cellId of residentCellIds) {
    if (payloads.has(cellId)) {
      continue;
    }
    const recipes = recipeIndex.get(cellId);
    if (!recipes) {
      continue;
    }
    payloads.set(
      cellId,
      instantiateCellPayload(root, cellId, recipes, resources),
    );
    createdCellIds.push(cellId);
  }
  const active = new Set(activeCellIds);
  const visibleCellIds: CellId[] = [];
  const hiddenCellIds: CellId[] = [];
  const buildingSnapshot = applyBuildingStreamingState(
    buildingBatches,
    activeCellIds,
    recipeIndex,
    drawDensity.structures,
    drawDensity.shadows,
  );
  const structuresVisible = buildingSnapshot.visible;
  const structuresCapacity = residentCellIds.reduce(
    (capacity, cellId) =>
      capacity + (recipeIndex.get(cellId)?.buildings.length ?? 0) * (
        BUILDING_SOLID_PARTS + BUILDING_FACADE_PARTS
      ),
    0,
  );
  let propsVisible = 0;
  let propsCapacity = 0;
  let traversalVisible = 0;
  let traversalCapacity = 0;
  let shadowCastingInstances = buildingSnapshot.shadows;
  const propBatchCounts: CityPropBatchCounts = {
    boxes: 0,
    accents: 0,
    stems: 0,
    foliage: 0,
    lights: 0,
    sculptures: 0,
  };
  propBatches.mergedSources.forEach((geometry) => geometry.dispose());
  propBatches.mergedSources.length = 0;

  for (const cellId of residentCellIds) {
    const payload = payloads.get(cellId);
    if (!payload) {
      continue;
    }
    const cellVisible = active.has(cellId);
    payload.root.visible = cellVisible;
    (cellVisible ? visibleCellIds : hiddenCellIds).push(cellId);

    const props = copyPropRecordsToBatches(
      payload.props,
      drawDensity.props,
      cellVisible,
      propBatches,
      propBatchCounts,
    );
    const traversal = applyDensity(
      payload.traversal,
      1,
      drawDensity.shadows,
      cellVisible,
    );
    propsVisible += props.visible;
    propsCapacity += props.capacity;
    traversalVisible += traversal.visible;
    traversalCapacity += traversal.capacity;
    shadowCastingInstances += traversal.shadows;
  }
  shadowCastingInstances += finalizePropBatches(
    propBatches,
    propBatchCounts,
    drawDensity.shadows,
  );

  return {
    activeCellIds,
    knownCellIds,
    residentCellIds,
    createdCellIds,
    evictedCellIds,
    visibleCellIds,
    hiddenCellIds,
    density: { ...drawDensity },
    structures: { visible: structuresVisible, capacity: structuresCapacity },
    props: { visible: propsVisible, capacity: propsCapacity },
    traversal: { visible: traversalVisible, capacity: traversalCapacity },
    shadowCastingInstances,
  };
}

export function createCityVisuals(
  layout: CityLayout,
  capabilities: Readonly<VisualRenderCapabilities> = DEFAULT_VISUAL_RENDER_CAPABILITIES,
): CityVisualBundle {
  const root = new Group();
  root.name = 'procedural-solara';
  const geometries: BufferGeometry[] = [];
  const materials: CityDisposableMaterial[] = [];
  const recipeIndex = indexCellRecipes(layout);
  const payloads = new Map<CellId, CityCellVisualPayload>();
  const useReducedLowPath = layout.quality === 'low' && capabilities.supportsMultiDraw;
  const sharedSurfaces = useReducedLowPath
    ? createLowSharedSurfaceBatch(root, layout, geometries, materials)
    : null;
  createDistrictGrounds(
    root,
    geometries,
    materials,
    sharedSurfaces,
    layout.quality,
  );
  const roadMaterial = createRoads(
    root,
    layout,
    geometries,
    materials,
    sharedSurfaces,
  );
  const resources = createSharedResources(geometries, materials);
  const lowPropMaterial = useReducedLowPath
    ? new MeshLambertMaterial({
      color: 0xffffff,
      vertexColors: true,
    })
    : null;
  if (lowPropMaterial) {
    materials.push(lowPropMaterial);
  }
  const buildingBatches = createBuildingBatches(
    root,
    layout.buildings,
    layout.quality,
    resources,
    sharedSurfaces,
  );
  const propBatches = createPropBatches(
    root,
    layout.props.length,
    layout.quality,
    resources,
    lowPropMaterial,
  );
  let disposed = false;

  return {
    root,
    buildingMaterials: resources.buildingMaterials,
    roadMaterial,
    setRoadColor: (color) => {
      if (disposed) {
        throw new Error('City visuals are disposed');
      }
      setLowSharedRoadColor(sharedSurfaces, color);
    },
    applyStreamingState: (
      renderableActiveCellIds,
      residentCellIds,
      drawDensity,
    ) => {
      if (disposed) {
        throw new Error('City visuals are disposed');
      }
      return applyStreamingState(
        root,
        recipeIndex,
        payloads,
        buildingBatches,
        propBatches,
        resources,
        renderableActiveCellIds,
        residentCellIds,
        drawDensity,
      );
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      root.removeFromParent();
      payloads.forEach((payload) => releaseCellPayload(payload));
      payloads.clear();
      propBatches.merged?.geometry.dispose();
      root.traverse((object) => {
        if (object instanceof InstancedMesh) {
          object.dispose();
        }
      });
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      root.clear();
    },
  };
}

export class AvatarVisual {
  public readonly root = new Group();

  private readonly leftArm: Mesh;
  private readonly rightArm: Mesh;
  private readonly leftLeg: Mesh;
  private readonly rightLeg: Mesh;
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: MeshStandardMaterial[] = [];

  public constructor() {
    this.root.name = 'alex-avatar';
    const jacketMaterial = new MeshStandardMaterial({ color: 0xff7045, roughness: 0.76 });
    const darkMaterial = new MeshStandardMaterial({ color: 0x182936, roughness: 0.84 });
    const skinMaterial = new MeshStandardMaterial({ color: 0xb97858, roughness: 0.92 });
    const shirtMaterial = new MeshStandardMaterial({ color: 0xf4c85a, roughness: 0.8 });
    const hairMaterial = new MeshStandardMaterial({ color: 0x251b1b, roughness: 0.95 });
    const shoeMaterial = new MeshStandardMaterial({ color: 0x101a23, roughness: 0.68 });
    this.materials.push(
      jacketMaterial,
      darkMaterial,
      skinMaterial,
      shirtMaterial,
      hairMaterial,
      shoeMaterial,
    );

    const torsoGeometry = new BoxGeometry(0.78, 0.95, 0.42);
    const headGeometry = new IcosahedronGeometry(0.31, 1);
    const limbGeometry = new BoxGeometry(0.24, 0.78, 0.24);
    const jacketHemGeometry = new BoxGeometry(0.9, 0.28, 0.46);
    const lapelGeometry = new BoxGeometry(0.18, 0.62, 0.07);
    const beltGeometry = new BoxGeometry(0.74, 0.1, 0.45);
    const handGeometry = new IcosahedronGeometry(0.15, 1);
    const shoeGeometry = new BoxGeometry(0.29, 0.2, 0.46);
    const hairGeometry = new ConeGeometry(0.34, 0.32, 7);
    const noseGeometry = new BoxGeometry(0.1, 0.1, 0.13);
    this.geometries.push(
      torsoGeometry,
      headGeometry,
      limbGeometry,
      jacketHemGeometry,
      lapelGeometry,
      beltGeometry,
      handGeometry,
      shoeGeometry,
      hairGeometry,
      noseGeometry,
    );

    const torso = new Mesh(torsoGeometry, jacketMaterial);
    torso.name = 'avatar-part:torso';
    torso.position.y = 1.42;
    torso.castShadow = true;
    const head = new Mesh(headGeometry, skinMaterial);
    head.name = 'avatar-part:head';
    head.position.y = 2.18;
    head.castShadow = true;
    const hair = new Mesh(hairGeometry, hairMaterial);
    hair.name = 'avatar-part:hair';
    hair.position.y = 2.44;
    hair.rotation.y = Math.PI / 7;
    hair.castShadow = true;
    const nose = new Mesh(noseGeometry, skinMaterial);
    nose.name = 'avatar-part:face';
    nose.position.set(0, 2.18, -0.31);
    nose.rotation.x = Math.PI / 4;
    const jacketHem = new Mesh(jacketHemGeometry, jacketMaterial);
    jacketHem.name = 'avatar-part:jacket-hem';
    jacketHem.position.y = 1.02;
    jacketHem.castShadow = true;
    const shirt = new Mesh(new BoxGeometry(0.34, 0.7, 0.08), shirtMaterial);
    shirt.name = 'avatar-part:shirt';
    shirt.position.set(0, 1.48, -0.24);
    this.geometries.push(shirt.geometry);
    const leftLapel = new Mesh(lapelGeometry, darkMaterial);
    leftLapel.name = 'avatar-part:lapel-left';
    leftLapel.position.set(-0.16, 1.52, -0.265);
    leftLapel.rotation.z = -0.22;
    const rightLapel = new Mesh(lapelGeometry, darkMaterial);
    rightLapel.name = 'avatar-part:lapel-right';
    rightLapel.position.set(0.16, 1.52, -0.265);
    rightLapel.rotation.z = 0.22;
    const belt = new Mesh(beltGeometry, darkMaterial);
    belt.name = 'avatar-part:belt';
    belt.position.y = 0.92;
    this.leftArm = new Mesh(limbGeometry, jacketMaterial);
    this.rightArm = new Mesh(limbGeometry, jacketMaterial);
    this.leftLeg = new Mesh(limbGeometry, darkMaterial);
    this.rightLeg = new Mesh(limbGeometry, darkMaterial);
    this.leftArm.position.set(-0.53, 1.4, 0);
    this.rightArm.position.set(0.53, 1.4, 0);
    this.leftLeg.position.set(-0.23, 0.52, 0);
    this.rightLeg.position.set(0.23, 0.52, 0);
    for (const limb of [this.leftArm, this.rightArm, this.leftLeg, this.rightLeg]) {
      limb.castShadow = true;
    }
    for (const [arm, side] of [
      [this.leftArm, 'left'],
      [this.rightArm, 'right'],
    ] as const) {
      const hand = new Mesh(handGeometry, skinMaterial);
      hand.name = `avatar-part:hand-${side}`;
      hand.position.y = -0.48;
      hand.castShadow = true;
      arm.add(hand);
    }
    for (const [leg, side] of [
      [this.leftLeg, 'left'],
      [this.rightLeg, 'right'],
    ] as const) {
      const shoe = new Mesh(shoeGeometry, shoeMaterial);
      shoe.name = `avatar-part:shoe-${side}`;
      shoe.position.set(0, -0.48, -0.11);
      shoe.castShadow = true;
      leg.add(shoe);
    }
    this.root.add(
      torso,
      jacketHem,
      shirt,
      leftLapel,
      rightLapel,
      belt,
      head,
      hair,
      nose,
      this.leftArm,
      this.rightArm,
      this.leftLeg,
      this.rightLeg,
    );
  }

  public sync(state: Readonly<PlayerSimulationState>): void {
    this.root.position.set(state.position.x, state.position.y, state.position.z);
    this.root.rotation.y = state.heading;
    this.root.scale.y = state.crouching ? 0.72 : 1;
    const horizontalSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    const walkAmount = Math.min(1, horizontalSpeed / 4.8);
    const swing = Math.sin(state.stride * 2.25) * 0.72 * walkAmount;
    this.leftArm.rotation.x = swing;
    this.rightArm.rotation.x = -swing;
    this.leftLeg.rotation.x = -swing;
    this.rightLeg.rotation.x = swing;
  }

  public dispose(): void {
    this.root.removeFromParent();
    this.geometries.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
  }
}

interface VehicleWheelVisual {
  readonly marker: Object3D;
  readonly position: readonly [number, number, number];
  readonly radius: number;
  readonly width: number;
  readonly steerable: boolean;
}

type VehicleBoxLayer = 'solid' | 'glass' | 'lamp';

interface VehiclePartAppearance {
  readonly layer: VehicleBoxLayer;
  readonly color: number;
  readonly paintable?: boolean;
}

interface VehicleModelMaterials {
  readonly body: VehiclePartAppearance;
  readonly accent: VehiclePartAppearance;
  readonly glass: VehiclePartAppearance;
  readonly tire: VehiclePartAppearance;
  readonly hub: VehiclePartAppearance;
  readonly headlight: VehiclePartAppearance;
  readonly taillight: VehiclePartAppearance;
}

interface VehicleBoxVisualRecipe {
  readonly marker: Object3D;
  readonly name: string;
  readonly size: readonly [number, number, number];
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number];
  readonly appearance: VehiclePartAppearance;
  batchIndex: number;
  lowVertexOffset: number;
  lowVertexCount: number;
}

interface VehicleLowWheelUniforms {
  readonly travel: { value: number };
  readonly steering: { value: number };
}

interface VehicleBatchMeshes {
  readonly solid: InstancedMesh | null;
  readonly glass: InstancedMesh | null;
  readonly lamps: InstancedMesh | null;
  readonly tires: InstancedMesh;
  readonly hubs: InstancedMesh;
  readonly lowMerged: Mesh<BufferGeometry, MeshLambertMaterial> | null;
  readonly lowWheelUniforms: VehicleLowWheelUniforms | null;
}

interface VehicleVisualPalette {
  readonly body: number;
  readonly accent: number;
  readonly glass: number;
}

const VEHICLE_VISUAL_PALETTES: Readonly<Record<VehicleClassId, VehicleVisualPalette>> = {
  compact: { body: 0x19b7a6, accent: 0xf2b84b, glass: 0x17384a },
  sedan: { body: 0xc58b45, accent: 0x5f3025, glass: 0x1d3443 },
  muscle: { body: 0xc84f34, accent: 0x20252b, glass: 0x182e3b },
  sports: { body: 0x328ad7, accent: 0x102b45, glass: 0x102c3d },
  van: { body: 0x396d7a, accent: 0xe6b64d, glass: 0x18313d },
  pickup: { body: 0x71834b, accent: 0x27372d, glass: 0x1c3540 },
  'police-cruiser': { body: 0xe1e4df, accent: 0x162431, glass: 0x122b3a },
  motorcycle: { body: 0xb94370, accent: 0x20252b, glass: 0x1b3442 },
};
const VEHICLE_TIRE_COLOR = new Color(0x0e1215);
const VEHICLE_HUB_COLOR = new Color(0x85929a);
const VEHICLE_LOW_WHEEL_SHADER_KEY = 'vehicle-low-merged-wheel-v1';

interface VehicleMergedWheelAttributes {
  readonly center: readonly [number, number, number];
  readonly inverseRadius: number;
  readonly steerable: boolean;
}

function createVehicleMergedPartGeometry(
  source: BufferGeometry,
  matrix: Readonly<Matrix4>,
  color: Readonly<Color>,
  wheel: Readonly<VehicleMergedWheelAttributes> | null,
): BufferGeometry {
  const geometry = source.clone();
  geometry.applyMatrix4(matrix);
  const vertexCount = geometry.getAttribute('position').count;
  const colors = new Float32Array(vertexCount * 3);
  const wheelCenters = new Float32Array(vertexCount * 3);
  const wheelRoles = new Float32Array(vertexCount * 3);
  for (let index = 0; index < vertexCount; index += 1) {
    color.toArray(colors, index * 3);
    if (wheel) {
      wheelCenters[index * 3] = wheel.center[0];
      wheelCenters[index * 3 + 1] = wheel.center[1];
      wheelCenters[index * 3 + 2] = wheel.center[2];
      wheelRoles[index * 3] = 1;
      wheelRoles[index * 3 + 1] = wheel.steerable ? 1 : 0;
      wheelRoles[index * 3 + 2] = wheel.inverseRadius;
    }
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setAttribute(
    'vehicleWheelCenter',
    new Float32BufferAttribute(wheelCenters, 3),
  );
  geometry.setAttribute(
    'vehicleWheelRole',
    new Float32BufferAttribute(wheelRoles, 3),
  );
  return geometry;
}

function replaceVehicleShaderChunk(
  source: string,
  chunk: string,
  replacement: string,
): string {
  if (!source.includes(chunk)) {
    throw new Error(`Vehicle shader chunk is unavailable: ${chunk}`);
  }
  return source.replace(chunk, replacement);
}

function configureLowVehicleWheelShader(
  material: MeshLambertMaterial,
  uniforms: VehicleLowWheelUniforms,
): void {
  material.userData.vehicleWheelUniforms = uniforms;
  material.customProgramCacheKey = () => VEHICLE_LOW_WHEEL_SHADER_KEY;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.vehicleWheelTravel = uniforms.travel;
    shader.uniforms.vehicleWheelSteering = uniforms.steering;
    shader.vertexShader = replaceVehicleShaderChunk(
      shader.vertexShader,
      '#include <common>',
      `#include <common>
attribute vec3 vehicleWheelCenter;
attribute vec3 vehicleWheelRole;
uniform float vehicleWheelTravel;
uniform float vehicleWheelSteering;

vec3 vehicleRotateX( vec3 value, float angle ) {
  float sine = sin( angle );
  float cosine = cos( angle );
  return vec3(
    value.x,
    cosine * value.y - sine * value.z,
    sine * value.y + cosine * value.z
  );
}

vec3 vehicleRotateY( vec3 value, float angle ) {
  float sine = sin( angle );
  float cosine = cos( angle );
  return vec3(
    cosine * value.x + sine * value.z,
    value.y,
    -sine * value.x + cosine * value.z
  );
}

vec3 vehicleAnimateWheelDirection( vec3 value ) {
  if ( vehicleWheelRole.x <= 0.0 ) return value;
  float steer = -vehicleWheelSteering * 0.36 * vehicleWheelRole.y;
  float spin = vehicleWheelTravel * vehicleWheelRole.z;
  return vehicleRotateX( vehicleRotateY( value, steer ), spin );
}

vec3 vehicleAnimateWheelPosition( vec3 value ) {
  if ( vehicleWheelRole.x <= 0.0 ) return value;
  vec3 local = value - vehicleWheelCenter;
  return vehicleAnimateWheelDirection( local ) + vehicleWheelCenter;
}`,
    );
    shader.vertexShader = replaceVehicleShaderChunk(
      shader.vertexShader,
      '#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
objectNormal = vehicleAnimateWheelDirection( objectNormal );`,
    );
    shader.vertexShader = replaceVehicleShaderChunk(
      shader.vertexShader,
      '#include <begin_vertex>',
      `#include <begin_vertex>
transformed = vehicleAnimateWheelPosition( transformed );`,
    );
  };
}

export const VEHICLE_VISUAL_PAINTS = {
  'coastal-teal': 0x14b8a6,
  'sunset-orange': 0xf0653b,
  'midnight-indigo': 0x272b59,
} as const;

export type VehicleVisualPaint = 'factory' | keyof typeof VEHICLE_VISUAL_PAINTS;

function isVehicleVisualPaint(value: string): value is VehicleVisualPaint {
  return value === 'factory' || Object.hasOwn(VEHICLE_VISUAL_PAINTS, value);
}

export class VehicleVisual {
  public readonly root = new Group();

  private wheels: VehicleWheelVisual[] = [];
  private boxParts: VehicleBoxVisualRecipe[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: (
    MeshStandardMaterial
    | MeshLambertMaterial
    | MeshBasicMaterial
  )[] = [];
  private readonly wheelDummy = new Object3D();
  private readonly options: Readonly<VehicleVisualOptions>;
  private modelRoot: Group | null = null;
  private batches: VehicleBatchMeshes | null = null;
  private activeClassId: VehicleClassId;
  private activePaint: VehicleVisualPaint = 'factory';
  private bodyHealth = 100;
  private wheelTravel = 0;
  private disposed = false;

  public constructor(
    initialClassId: VehicleClassId = DEFAULT_VEHICLE_CLASS_ID,
    options: Readonly<VehicleVisualOptions> = DEFAULT_VEHICLE_VISUAL_OPTIONS,
  ) {
    this.options = options;
    this.activeClassId = initialClassId;
    this.rebuild(initialClassId);
  }

  public get vehicleClassId(): VehicleClassId {
    return this.activeClassId;
  }

  public get vehicleName(): string {
    return requireVehicleDriveProfile(this.activeClassId).name;
  }

  public get vehiclePaint(): VehicleVisualPaint {
    return this.activePaint;
  }

  public setPaint(paint: string): VehicleVisualPaint {
    const normalized = isVehicleVisualPaint(paint) ? paint : 'factory';
    this.activePaint = normalized;
    this.updateBodyInstanceColors();
    this.root.userData.vehiclePaint = normalized;
    return normalized;
  }

  private createMaterials(classId: VehicleClassId): VehicleModelMaterials {
    const palette = VEHICLE_VISUAL_PALETTES[classId];
    return {
      body: { layer: 'solid', color: palette.body, paintable: true },
      accent: { layer: 'solid', color: palette.accent },
      glass: { layer: 'glass', color: palette.glass },
      tire: { layer: 'solid', color: 0x0e1215 },
      hub: { layer: 'solid', color: 0x85929a },
      headlight: { layer: 'lamp', color: 0xfff1bd },
      taillight: { layer: 'lamp', color: 0xff3e39 },
    };
  }

  private addBox(
    parent: Group,
    name: string,
    size: readonly [number, number, number],
    position: readonly [number, number, number],
    appearance: VehiclePartAppearance,
    rotation: readonly [number, number, number] = [0, 0, 0],
  ): Object3D {
    const marker = new Object3D();
    marker.name = name;
    marker.position.set(...position);
    marker.rotation.set(...rotation);
    marker.userData.vehiclePartSize = [...size];
    marker.userData.vehiclePartLayer = appearance.layer;
    parent.add(marker);
    this.boxParts.push({
      marker,
      name,
      size,
      position,
      rotation,
      appearance,
      batchIndex: -1,
      lowVertexOffset: -1,
      lowVertexCount: 0,
    });
    return marker;
  }

  private addCabin(
    parent: Group,
    size: readonly [number, number, number],
    position: readonly [number, number, number],
    materials: VehicleModelMaterials,
  ): void {
    this.addBox(parent, 'vehicle-part:cabin-glass', size, position, materials.glass);
    this.addBox(
      parent,
      'vehicle-part:cabin-roof',
      [size[0] * 1.03, 0.12, size[2] * 0.92],
      [position[0], position[1] + size[1] / 2 + 0.06, position[2]],
      materials.accent,
    );
  }

  private addWheel(
    parent: Group,
    role: string,
    position: readonly [number, number, number],
    radius: number,
    width: number,
    steerable: boolean,
    _materials: VehicleModelMaterials,
  ): void {
    const marker = new Object3D();
    marker.name = `vehicle-wheel:${role}`;
    marker.position.set(...position);
    marker.rotation.z = Math.PI / 2;
    marker.userData.steerable = steerable;
    marker.userData.radius = radius;
    marker.userData.width = width;
    const hubMarker = new Object3D();
    hubMarker.name = `vehicle-wheel-hub:${role}`;
    marker.add(hubMarker);
    parent.add(marker);
    this.wheels.push({ marker, position, radius, width, steerable });
  }

  private addFourWheels(
    parent: Group,
    halfTrack: number,
    frontZ: number,
    rearZ: number,
    radius: number,
    width: number,
    materials: VehicleModelMaterials,
  ): void {
    this.addWheel(parent, 'front-left', [-halfTrack, 0, frontZ], radius, width, true, materials);
    this.addWheel(parent, 'front-right', [halfTrack, 0, frontZ], radius, width, true, materials);
    this.addWheel(parent, 'rear-left', [-halfTrack, 0, rearZ], radius, width, false, materials);
    this.addWheel(parent, 'rear-right', [halfTrack, 0, rearZ], radius, width, false, materials);
  }

  private addLightPairs(
    parent: Group,
    halfSpacing: number,
    y: number,
    frontZ: number,
    rearZ: number,
    materials: VehicleModelMaterials,
  ): void {
    this.addBox(parent, 'vehicle-light:front-left', [0.4, 0.17, 0.08], [-halfSpacing, y, frontZ], materials.headlight);
    this.addBox(parent, 'vehicle-light:front-right', [0.4, 0.17, 0.08], [halfSpacing, y, frontZ], materials.headlight);
    this.addBox(parent, 'vehicle-light:rear-left', [0.36, 0.16, 0.08], [-halfSpacing, y, rearZ], materials.taillight);
    this.addBox(parent, 'vehicle-light:rear-right', [0.36, 0.16, 0.08], [halfSpacing, y, rearZ], materials.taillight);
  }

  private buildCompact(parent: Group, materials: VehicleModelMaterials): void {
    this.addBox(parent, 'vehicle-part:chassis', [1.86, 0.52, 3.35], [0, 0.31, 0], materials.body);
    this.addBox(parent, 'vehicle-part:hood', [1.72, 0.28, 0.88], [0, 0.62, -1.25], materials.body);
    this.addCabin(parent, [1.55, 0.7, 1.48], [0, 0.92, 0.16], materials);
    this.addBox(parent, 'vehicle-part:hatch', [1.62, 0.5, 0.55], [0, 0.63, 1.39], materials.body);
    this.addBox(parent, 'vehicle-part:front-bumper', [1.94, 0.17, 0.16], [0, 0.25, -1.72], materials.accent);
    this.addFourWheels(parent, 0.96, -1.12, 1.12, 0.42, 0.34, materials);
    this.addLightPairs(parent, 0.56, 0.55, -1.7, 1.7, materials);
  }

  private buildSedan(parent: Group, materials: VehicleModelMaterials): void {
    this.addBox(parent, 'vehicle-part:chassis', [1.96, 0.52, 4.42], [0, 0.32, 0], materials.body);
    this.addBox(parent, 'vehicle-part:hood', [1.84, 0.3, 1.18], [0, 0.61, -1.59], materials.body);
    this.addCabin(parent, [1.68, 0.72, 1.9], [0, 0.93, -0.03], materials);
    this.addBox(parent, 'vehicle-part:trunk', [1.82, 0.3, 0.86], [0, 0.61, 1.78], materials.body);
    this.addBox(parent, 'vehicle-part:waistline', [2.02, 0.14, 3.2], [0, 0.61, 0], materials.accent);
    this.addFourWheels(parent, 1.02, -1.48, 1.45, 0.44, 0.36, materials);
    this.addLightPairs(parent, 0.62, 0.56, -2.24, 2.24, materials);
  }

  private buildMuscle(parent: Group, materials: VehicleModelMaterials): void {
    this.addBox(parent, 'vehicle-part:wide-chassis', [2.18, 0.54, 4.58], [0, 0.33, 0], materials.body);
    this.addBox(parent, 'vehicle-part:power-hood', [2.06, 0.34, 1.76], [0, 0.65, -1.35], materials.body);
    this.addBox(parent, 'vehicle-part:hood-stripe', [0.38, 0.04, 1.66], [0, 0.84, -1.35], materials.accent);
    this.addCabin(parent, [1.78, 0.6, 1.58], [0, 0.87, 0.66], materials);
    this.addBox(parent, 'vehicle-part:rear-deck', [2.02, 0.28, 0.74], [0, 0.59, 1.86], materials.body);
    this.addFourWheels(parent, 1.14, -1.5, 1.52, 0.47, 0.43, materials);
    this.addLightPairs(parent, 0.67, 0.57, -2.32, 2.32, materials);
  }

  private buildSports(parent: Group, materials: VehicleModelMaterials): void {
    this.addBox(parent, 'vehicle-part:low-chassis', [2.02, 0.4, 4.25], [0, 0.26, 0], materials.body);
    this.addBox(parent, 'vehicle-part:wedge-hood', [1.9, 0.22, 1.44], [0, 0.51, -1.4], materials.body, [-0.045, 0, 0]);
    this.addCabin(parent, [1.58, 0.58, 1.48], [0, 0.78, 0.23], materials);
    this.addBox(parent, 'vehicle-part:rear-deck', [1.9, 0.22, 0.82], [0, 0.5, 1.69], materials.body);
    this.addBox(parent, 'vehicle-part:wing-left-support', [0.1, 0.42, 0.1], [-0.61, 0.81, 1.82], materials.accent);
    this.addBox(parent, 'vehicle-part:wing-right-support', [0.1, 0.42, 0.1], [0.61, 0.81, 1.82], materials.accent);
    this.addBox(parent, 'vehicle-part:rear-wing', [1.92, 0.11, 0.34], [0, 1.02, 1.82], materials.accent);
    this.addFourWheels(parent, 1.03, -1.38, 1.38, 0.43, 0.4, materials);
    this.addLightPairs(parent, 0.62, 0.47, -2.16, 2.16, materials);
  }

  private buildVan(parent: Group, materials: VehicleModelMaterials): void {
    this.addBox(parent, 'vehicle-part:van-chassis', [2.08, 0.54, 4.5], [0, 0.34, 0], materials.accent);
    this.addBox(parent, 'vehicle-part:cargo-box', [2.02, 1.72, 2.76], [0, 1.08, 0.63], materials.body);
    this.addBox(parent, 'vehicle-part:cab-shell', [2, 1.42, 1.48], [0, 0.94, -1.47], materials.body);
    this.addBox(parent, 'vehicle-part:van-windshield', [1.72, 0.66, 0.08], [0, 1.22, -2.22], materials.glass, [-0.08, 0, 0]);
    this.addBox(parent, 'vehicle-part:cargo-roof', [2.08, 0.12, 2.82], [0, 2, 0.64], materials.accent);
    this.addBox(parent, 'vehicle-part:rear-door-seam', [0.07, 1.42, 0.04], [0, 1.08, 2.03], materials.accent);
    this.addFourWheels(parent, 1.08, -1.42, 1.5, 0.49, 0.4, materials);
    this.addLightPairs(parent, 0.66, 0.55, -2.28, 2.29, materials);
  }

  private buildPickup(parent: Group, materials: VehicleModelMaterials): void {
    this.addBox(parent, 'vehicle-part:truck-chassis', [2.08, 0.54, 4.5], [0, 0.33, 0], materials.accent);
    this.addBox(parent, 'vehicle-part:pickup-hood', [1.98, 0.42, 1.22], [0, 0.65, -1.59], materials.body);
    this.addCabin(parent, [1.82, 1.12, 1.35], [0, 0.91, -0.38], materials);
    this.addBox(parent, 'vehicle-part:bed-floor', [1.9, 0.2, 1.72], [0, 0.57, 1.34], materials.body);
    this.addBox(parent, 'vehicle-part:bed-left-rail', [0.15, 0.56, 1.75], [-0.88, 0.78, 1.34], materials.body);
    this.addBox(parent, 'vehicle-part:bed-right-rail', [0.15, 0.56, 1.75], [0.88, 0.78, 1.34], materials.body);
    this.addBox(parent, 'vehicle-part:tailgate', [1.9, 0.54, 0.14], [0, 0.77, 2.16], materials.body);
    this.addFourWheels(parent, 1.09, -1.47, 1.49, 0.49, 0.41, materials);
    this.addLightPairs(parent, 0.64, 0.58, -2.28, 2.25, materials);
  }

  private buildPoliceCruiser(parent: Group, materials: VehicleModelMaterials): void {
    this.addBox(parent, 'vehicle-part:cruiser-chassis', [2.02, 0.54, 4.58], [0, 0.33, 0], materials.body);
    this.addBox(parent, 'vehicle-part:cruiser-hood', [1.9, 0.3, 1.3], [0, 0.63, -1.61], materials.body);
    this.addCabin(parent, [1.72, 0.73, 1.86], [0, 0.94, -0.01], materials);
    this.addBox(parent, 'vehicle-part:cruiser-trunk', [1.9, 0.32, 0.88], [0, 0.63, 1.85], materials.body);
    this.addBox(parent, 'vehicle-part:door-band', [2.05, 0.28, 2.04], [0, 0.57, 0.16], materials.accent);
    this.addBox(parent, 'vehicle-part:pushbar-cross', [2.12, 0.13, 0.12], [0, 0.42, -2.4], materials.accent);
    this.addBox(parent, 'vehicle-part:pushbar-left', [0.12, 0.5, 0.12], [-0.75, 0.53, -2.38], materials.accent);
    this.addBox(parent, 'vehicle-part:pushbar-right', [0.12, 0.5, 0.12], [0.75, 0.53, -2.38], materials.accent);
    const redBeacon: VehiclePartAppearance = { layer: 'lamp', color: 0xff3038 };
    const blueBeacon: VehiclePartAppearance = { layer: 'lamp', color: 0x328cff };
    this.addBox(parent, 'vehicle-part:lightbar-base', [1.42, 0.09, 0.22], [0, 1.42, 0], materials.accent);
    this.addBox(parent, 'vehicle-part:lightbar-red', [0.64, 0.16, 0.2], [-0.35, 1.52, 0], redBeacon);
    this.addBox(parent, 'vehicle-part:lightbar-blue', [0.64, 0.16, 0.2], [0.35, 1.52, 0], blueBeacon);
    this.addFourWheels(parent, 1.05, -1.5, 1.48, 0.45, 0.39, materials);
    this.addLightPairs(parent, 0.64, 0.57, -2.32, 2.32, materials);
  }

  private buildMotorcycle(parent: Group, materials: VehicleModelMaterials): void {
    this.addWheel(parent, 'front', [0, 0, -0.98], 0.48, 0.19, true, materials);
    this.addWheel(parent, 'rear', [0, 0, 0.98], 0.48, 0.23, false, materials);
    this.addBox(parent, 'vehicle-part:motorcycle-frame', [0.2, 0.2, 1.46], [0, 0.35, 0], materials.accent);
    this.addBox(parent, 'vehicle-part:engine-block', [0.52, 0.5, 0.54], [0, 0.48, 0.25], materials.accent);
    this.addBox(parent, 'vehicle-part:fuel-tank', [0.6, 0.46, 0.72], [0, 0.72, -0.22], materials.body, [-0.08, 0, 0]);
    this.addBox(parent, 'vehicle-part:saddle', [0.44, 0.17, 0.67], [0, 0.77, 0.48], materials.tire);
    this.addBox(parent, 'vehicle-part:front-fork-left', [0.08, 0.88, 0.08], [-0.16, 0.46, -0.88], materials.hub, [0.18, 0, 0]);
    this.addBox(parent, 'vehicle-part:front-fork-right', [0.08, 0.88, 0.08], [0.16, 0.46, -0.88], materials.hub, [0.18, 0, 0]);
    this.addBox(parent, 'vehicle-part:handlebar', [0.78, 0.08, 0.08], [0, 0.99, -0.79], materials.hub);
    this.addBox(parent, 'vehicle-part:motorcycle-headlight', [0.3, 0.28, 0.12], [0, 0.82, -1.08], materials.headlight);
    this.addBox(parent, 'vehicle-light:rear', [0.26, 0.17, 0.1], [0, 0.68, 0.92], materials.taillight);
  }

  private createLowMergedBatch(
    parent: Group,
    boxGeometry: BufferGeometry,
    tireGeometry: BufferGeometry,
    hubGeometry: BufferGeometry,
    material: MeshLambertMaterial,
  ): {
    readonly mesh: Mesh<BufferGeometry, MeshLambertMaterial>;
    readonly uniforms: VehicleLowWheelUniforms;
  } {
    const sources: BufferGeometry[] = [];
    const dummy = new Object3D();
    const color = new Color();
    let vertexOffset = 0;
    this.boxParts.forEach((part, index) => {
      const geometry = createVehicleMergedPartGeometry(
        boxGeometry,
        composeEulerMatrix(dummy, part.position, part.rotation, part.size),
        color.setHex(part.appearance.color),
        null,
      );
      const vertexCount = geometry.getAttribute('position').count;
      part.batchIndex = index;
      part.lowVertexOffset = vertexOffset;
      part.lowVertexCount = vertexCount;
      part.marker.userData.vehicleBatchName = 'vehicle-batch:low-boxes';
      part.marker.userData.vehicleBatchIndex = index;
      part.marker.userData.vehicleVertexOffset = vertexOffset;
      part.marker.userData.vehicleVertexCount = vertexCount;
      vertexOffset += vertexCount;
      sources.push(geometry);
    });

    const wheelPartNames: string[] = [];
    this.wheels.forEach((wheel, index) => {
      dummy.position.set(...wheel.position);
      dummy.rotation.set(0, 0, Math.PI / 2);
      dummy.scale.set(wheel.radius, wheel.width, wheel.radius);
      dummy.updateMatrix();
      const tire = createVehicleMergedPartGeometry(
        tireGeometry,
        dummy.matrix,
        VEHICLE_TIRE_COLOR,
        {
          center: wheel.position,
          inverseRadius: 1 / wheel.radius,
          steerable: wheel.steerable,
        },
      );
      const tireVertexCount = tire.getAttribute('position').count;
      wheel.marker.userData.vehicleBatchName = 'vehicle-batch:low-wheels';
      wheel.marker.userData.vehicleBatchIndex = index;
      wheel.marker.userData.vehicleVertexOffset = vertexOffset;
      wheel.marker.userData.vehicleVertexCount = tireVertexCount;
      wheelPartNames.push(wheel.marker.name);
      vertexOffset += tireVertexCount;
      sources.push(tire);

      dummy.scale.set(
        wheel.radius * 0.48,
        wheel.width + 0.015,
        wheel.radius * 0.48,
      );
      dummy.updateMatrix();
      const hub = createVehicleMergedPartGeometry(
        hubGeometry,
        dummy.matrix,
        VEHICLE_HUB_COLOR,
        {
          center: wheel.position,
          inverseRadius: 1 / wheel.radius,
          steerable: wheel.steerable,
        },
      );
      const hubVertexCount = hub.getAttribute('position').count;
      const hubMarker = wheel.marker.getObjectByName(
        wheel.marker.name.replace('vehicle-wheel:', 'vehicle-wheel-hub:'),
      );
      if (hubMarker) {
        hubMarker.userData.vehicleBatchName = 'vehicle-batch:low-wheels';
        hubMarker.userData.vehicleBatchIndex = this.wheels.length + index;
        hubMarker.userData.vehicleVertexOffset = vertexOffset;
        hubMarker.userData.vehicleVertexCount = hubVertexCount;
        wheelPartNames.push(hubMarker.name);
      }
      vertexOffset += hubVertexCount;
      sources.push(hub);
    });

    const geometry = mergeGeometries(sources, false);
    sources.forEach((source) => source.dispose());
    if (!geometry) {
      throw new Error('Low-quality vehicle geometry merge failed');
    }
    (geometry.getAttribute('color') as Float32BufferAttribute)
      .setUsage(DynamicDrawUsage);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    this.geometries.push(geometry);

    const uniforms: VehicleLowWheelUniforms = {
      travel: { value: this.wheelTravel },
      steering: { value: 0 },
    };
    configureLowVehicleWheelShader(material, uniforms);
    const mesh = new AliasedMesh(
      geometry,
      material,
      ['vehicle-batch:low-boxes', 'vehicle-batch:low-wheels'],
    );
    mesh.name = 'vehicle-batch:low-vehicle';
    mesh.userData.partNames = this.boxParts.map((part) => part.name);
    mesh.userData.wheelPartNames = wheelPartNames;
    mesh.userData.vehicleWheelUniforms = uniforms;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    parent.add(mesh);
    return { mesh, uniforms };
  }

  private createBatches(parent: Group): VehicleBatchMeshes {
    const boxGeometry = new BoxGeometry(1, 1, 1);
    const tireGeometry = new CylinderGeometry(1, 1, 1, 12);
    const hubGeometry = new CylinderGeometry(1, 1, 1, 10);
    const solidMaterial = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.54,
      metalness: 0.2,
    });
    const glassMaterial = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.16,
      metalness: 0.5,
      transparent: true,
      opacity: 0.9,
    });
    const lampMaterial = new MeshBasicMaterial({ color: 0xffffff });
    const tireMaterial = new MeshStandardMaterial({ color: 0x0e1215, roughness: 0.96 });
    const hubMaterial = new MeshStandardMaterial({
      color: 0x85929a,
      roughness: 0.38,
      metalness: 0.72,
    });
    const lowQualityMaterial = this.options.quality === 'low'
      && this.options.supportsMultiDraw
      ? new MeshLambertMaterial({
        color: 0xffffff,
        vertexColors: true,
      })
      : null;
    this.geometries.push(boxGeometry, tireGeometry, hubGeometry);
    this.materials.push(
      solidMaterial,
      glassMaterial,
      lampMaterial,
      tireMaterial,
      hubMaterial,
    );
    if (lowQualityMaterial) this.materials.push(lowQualityMaterial);

    const dummy = new Object3D();
    const color = new Color();
    const createBoxBatch = (
      layer: VehicleBoxLayer,
      name: string,
      material: MeshStandardMaterial | MeshBasicMaterial,
    ): InstancedMesh | null => {
      const parts = this.boxParts.filter((part) => part.appearance.layer === layer);
      if (parts.length === 0) return null;
      const mesh = new InstancedMesh(boxGeometry, material, parts.length);
      mesh.name = name;
      mesh.userData.partNames = parts.map((part) => part.name);
      parts.forEach((part, index) => {
        part.batchIndex = index;
        part.marker.userData.vehicleBatchName = name;
        part.marker.userData.vehicleBatchIndex = index;
        mesh.setMatrixAt(
          index,
          composeEulerMatrix(dummy, part.position, part.rotation, part.size),
        );
        mesh.setColorAt(index, color.setHex(part.appearance.color));
      });
      mesh.castShadow = material instanceof MeshStandardMaterial && layer !== 'glass';
      mesh.receiveShadow = material instanceof MeshStandardMaterial;
      finalizeInstances(mesh);
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      parent.add(mesh);
      return mesh;
    };

    const solid = createBoxBatch('solid', 'vehicle-batch:solid', solidMaterial);
    const glass = createBoxBatch('glass', 'vehicle-batch:glass', glassMaterial);
    const lamps = createBoxBatch('lamp', 'vehicle-batch:lamps', lampMaterial);
    const tires = new InstancedMesh(tireGeometry, tireMaterial, this.wheels.length);
    tires.name = 'vehicle-batch:tires';
    tires.castShadow = true;
    tires.receiveShadow = true;
    const hubs = new InstancedMesh(hubGeometry, hubMaterial, this.wheels.length);
    hubs.name = 'vehicle-batch:hubs';
    hubs.castShadow = true;
    hubs.receiveShadow = true;
    parent.add(tires, hubs);
    const low = lowQualityMaterial
      ? this.createLowMergedBatch(
        parent,
        boxGeometry,
        tireGeometry,
        hubGeometry,
        lowQualityMaterial,
      )
      : null;
    if (low) {
      if (solid) solid.visible = false;
      if (glass) glass.visible = false;
      if (lamps) lamps.visible = false;
      tires.visible = false;
      hubs.visible = false;
    }
    const batches = {
      solid,
      glass,
      lamps,
      tires,
      hubs,
      lowMerged: low?.mesh ?? null,
      lowWheelUniforms: low?.uniforms ?? null,
    };
    this.batches = batches;
    this.updateWheelBatches(0);
    tires.computeBoundingSphere();
    hubs.computeBoundingSphere();
    return batches;
  }

  private updateBodyInstanceColors(): void {
    const batches = this.batches;
    if (!batches) return;
    const base = this.activePaint === 'factory'
      ? VEHICLE_VISUAL_PALETTES[this.activeClassId].body
      : VEHICLE_VISUAL_PAINTS[this.activePaint];
    const damageAmount = Math.min(0.58, Math.max(0, (100 - this.bodyHealth) / 100) * 0.58);
    const color = new Color(base).lerp(new Color(0x332b2c), damageAmount);
    if (batches.lowMerged) {
      const colors = batches.lowMerged.geometry.getAttribute(
        'color',
      ) as Float32BufferAttribute;
      colors.clearUpdateRanges();
      for (const part of this.boxParts) {
        if (
          !part.appearance.paintable
          || part.lowVertexOffset < 0
          || part.lowVertexCount <= 0
        ) {
          continue;
        }
        const end = part.lowVertexOffset + part.lowVertexCount;
        for (let index = part.lowVertexOffset; index < end; index += 1) {
          colors.setXYZ(index, color.r, color.g, color.b);
        }
        colors.addUpdateRange(part.lowVertexOffset * 3, part.lowVertexCount * 3);
      }
      colors.needsUpdate = true;
      return;
    }
    const carrier = batches.solid;
    if (!carrier) return;
    for (const part of this.boxParts) {
      if (part.appearance.paintable && part.batchIndex >= 0) {
        carrier.setColorAt(part.batchIndex, color);
      }
    }
    if (carrier instanceof InstancedMesh && carrier.instanceColor) {
      carrier.instanceColor.needsUpdate = true;
    }
  }

  private updateWheelBatches(steering: number): void {
    const batches = this.batches;
    if (!batches) return;
    for (let index = 0; index < this.wheels.length; index += 1) {
      const wheel = this.wheels[index];
      if (!wheel) continue;
      const spin = this.wheelTravel / wheel.radius;
      const steer = wheel.steerable ? -steering * 0.36 : 0;
      wheel.marker.rotation.set(spin, steer, Math.PI / 2);
    }
    if (batches.lowMerged && batches.lowWheelUniforms) {
      batches.lowWheelUniforms.travel.value = this.wheelTravel;
      batches.lowWheelUniforms.steering.value = steering;
      return;
    }
    const dummy = this.wheelDummy;
    for (let index = 0; index < this.wheels.length; index += 1) {
      const wheel = this.wheels[index];
      if (!wheel) continue;
      const spin = this.wheelTravel / wheel.radius;
      const steer = wheel.steerable ? -steering * 0.36 : 0;
      dummy.position.set(...wheel.position);
      dummy.rotation.set(spin, steer, Math.PI / 2);
      dummy.scale.set(wheel.radius, wheel.width, wheel.radius);
      dummy.updateMatrix();
      batches.tires.setMatrixAt(index, dummy.matrix);
      dummy.scale.set(wheel.radius * 0.48, wheel.width + 0.015, wheel.radius * 0.48);
      dummy.updateMatrix();
      batches.hubs.setMatrixAt(index, dummy.matrix);
    }
    finalizeInstances(batches.tires);
    finalizeInstances(batches.hubs);
  }

  private rebuild(classId: VehicleClassId): void {
    const profile = requireVehicleDriveProfile(classId);
    this.releaseModel();
    const model = new Group();
    const slug = profile.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    model.name = `vehicle-model:${classId}:${slug}`;
    const materials = this.createMaterials(classId);
    switch (classId) {
      case 'compact': this.buildCompact(model, materials); break;
      case 'sedan': this.buildSedan(model, materials); break;
      case 'muscle': this.buildMuscle(model, materials); break;
      case 'sports': this.buildSports(model, materials); break;
      case 'van': this.buildVan(model, materials); break;
      case 'pickup': this.buildPickup(model, materials); break;
      case 'police-cruiser': this.buildPoliceCruiser(model, materials); break;
      case 'motorcycle': this.buildMotorcycle(model, materials); break;
    }
    this.activeClassId = classId;
    this.modelRoot = model;
    this.wheelTravel = 0;
    this.createBatches(model);
    this.root.name = `vehicle:${classId}`;
    this.root.userData.vehicleClassId = classId;
    this.root.userData.vehicleName = profile.name;
    this.root.userData.vehicleDescription = profile.description;
    this.setPaint(this.activePaint);
    this.root.add(model);
  }

  private releaseModel(): void {
    this.modelRoot?.traverse((object) => {
      if (object instanceof InstancedMesh) {
        object.dispose();
      }
    });
    this.modelRoot?.removeFromParent();
    this.modelRoot?.clear();
    this.modelRoot = null;
    this.batches = null;
    this.geometries.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
    this.geometries.length = 0;
    this.materials.length = 0;
    this.boxParts = [];
    this.wheels = [];
  }

  public sync(state: Readonly<VehicleSimulationState>, deltaSeconds: number): void {
    if (this.disposed) {
      return;
    }
    if (state.vehicleClassId !== this.activeClassId) {
      this.rebuild(state.vehicleClassId);
    }
    this.root.position.set(state.position.x, state.position.y, state.position.z);
    this.root.rotation.set(state.pitch ?? 0, state.heading, state.roll ?? 0);
    this.wheelTravel -= state.speed * Math.max(0, deltaSeconds);
    this.updateWheelBatches(state.steering);
    if (state.integrity.bodyHealth !== this.bodyHealth) {
      this.bodyHealth = state.integrity.bodyHealth;
      this.updateBodyInstanceColors();
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.root.removeFromParent();
    this.releaseModel();
    this.root.clear();
  }
}

export class RainField {
  public readonly points: Points<BufferGeometry, PointsMaterial>;

  private readonly positions: Float32Array;
  private readonly geometry: BufferGeometry;
  private readonly material: PointsMaterial;
  private readonly count: number;

  public constructor(seed: number, quality: WorldQuality) {
    this.count = quality === 'high' ? 1_200 : 520;
    const positions = new Float32Array(this.count * 3);
    const rng = new SeededRandom(seed ^ 0xa17c93);
    for (let index = 0; index < this.count; index += 1) {
      const offset = index * 3;
      positions[offset] = rng.range(-72, 72);
      positions[offset + 1] = rng.range(2, 72);
      positions[offset + 2] = rng.range(-72, 72);
    }
    this.geometry = new BufferGeometry();
    const positionAttribute = new Float32BufferAttribute(positions, 3);
    this.geometry.setAttribute('position', positionAttribute);
    this.positions = positionAttribute.array as Float32Array;
    this.material = new PointsMaterial({
      color: 0xccecff,
      size: quality === 'high' ? 0.17 : 0.23,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.points = new Points(this.geometry, this.material);
    this.points.name = 'local-rain';
    this.points.frustumCulled = false;
  }

  public update(deltaSeconds: number, intensity: number, center: Readonly<Vec3Data>): void {
    const normalizedIntensity = Math.max(0, Math.min(1, intensity));
    this.points.visible = normalizedIntensity > 0.005;
    if (normalizedIntensity === 0) {
      this.geometry.setDrawRange(0, 0);
      return;
    }
    this.points.position.set(center.x, 0, center.z);
    this.material.opacity = 0.2 + normalizedIntensity * 0.58;
    this.geometry.setDrawRange(0, Math.ceil(this.count * normalizedIntensity));
    const fallDistance = deltaSeconds * (28 + normalizedIntensity * 36);
    for (let index = 1; index < this.positions.length; index += 3) {
      const current = this.positions[index];
      if (current === undefined) {
        continue;
      }
      const next = current - fallDistance;
      this.positions[index] = next < 0.5 ? 70 : next;
    }
    const positionAttribute = this.geometry.getAttribute('position');
    positionAttribute.needsUpdate = true;
  }

  public dispose(): void {
    this.points.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
