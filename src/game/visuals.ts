import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Points,
  PointsMaterial,
} from 'three';
import type { Matrix4 } from 'three';

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
  roadMaterial: MeshStandardMaterial;
  applyStreamingState: (
    renderableActiveCellIds: readonly CellId[],
    residentCellIds: readonly CellId[],
    drawDensity: Readonly<DrawDensityLimits>,
  ) => CityVisualStreamingSnapshot;
  dispose: () => void;
}

interface DensityMeshRecord {
  readonly mesh: InstancedMesh;
  readonly capacity: number;
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

interface CityCellVisualRecipes {
  readonly buildings: readonly BuildingRecipe[];
  readonly props: readonly PropRecipe[];
  readonly traversal: readonly TraversalObstacleRecipe[];
}

interface CityVisualSharedResources {
  readonly buildingGeometry: BufferGeometry;
  readonly buildingMaterials: readonly MeshStandardMaterial[];
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

function createDistrictGrounds(root: Group, geometries: BufferGeometry[], materials: MeshStandardMaterial[]): void {
  for (const district of DISTRICTS) {
    const geometry = new BoxGeometry(DISTRICT_SIZE, 0.12, DISTRICT_SIZE);
    const material = new MeshStandardMaterial({
      color: district.groundColor,
      roughness: 0.94,
      metalness: 0,
    });
    const ground = new Mesh(geometry, material);
    ground.name = `city-ground:${district.id}`;
    ground.position.set(
      (district.minX + district.maxX) / 2,
      -0.08,
      (district.minZ + district.maxZ) / 2,
    );
    ground.receiveShadow = true;
    root.add(ground);
    geometries.push(geometry);
    materials.push(material);
  }

  const oceanGeometry = new PlaneGeometry(300, 1_300, 1, 1);
  const oceanMaterial = new MeshStandardMaterial({
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
  materials: MeshStandardMaterial[],
): MeshStandardMaterial {
  const geometry = new BoxGeometry(1, 1, 1);
  const material = new MeshStandardMaterial({
    color: 0x26313b,
    roughness: 0.82,
    metalness: 0.05,
  });
  const mesh = new InstancedMesh(geometry, material, layout.roads.length);
  mesh.name = 'city-roads';
  const dummy = new Object3D();
  layout.roads.forEach((road, index) => {
    mesh.setMatrixAt(
      index,
      composeMatrix(dummy, road.position.x, road.position.y, road.position.z, road.width, 0.1, road.depth),
    );
  });
  mesh.receiveShadow = true;
  root.add(mesh);
  geometries.push(geometry);
  materials.push(material);

  const markingCount = layout.roads.reduce((count, road) => {
    const length = Math.max(road.width, road.depth);
    return count + Math.floor(length / 28);
  }, 0);
  const markingGeometry = new BoxGeometry(1, 1, 1);
  const markingMaterial = new MeshStandardMaterial({
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
  materials: MeshStandardMaterial[],
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
    stemGeometry,
    foliageGeometry,
    lightGeometry,
    containerGeometry,
    traversalGeometry,
  );
  materials.push(
    ...buildingMaterials,
    stemMaterial,
    foliageMaterial,
    lightMaterial,
    containerMaterial,
    traversalMaterial,
  );
  return {
    buildingGeometry,
    buildingMaterials,
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

function recordDensityMesh(
  payload: CityCellVisualPayload,
  kind: 'structures' | 'props' | 'traversal',
  mesh: InstancedMesh,
  shadowCaster: boolean,
  shadowKey: string,
): void {
  payload.root.add(mesh);
  payload[kind].push({
    mesh,
    capacity: mesh.count,
    shadowCaster,
    shadowKey: `${payload.cellId}:${shadowKey}`,
  });
}

function createBuildings(
  payload: CityCellVisualPayload,
  buildings: readonly BuildingRecipe[],
  quality: WorldQuality,
  resources: CityVisualSharedResources,
): void {
  for (const [districtIndex, district] of DISTRICTS.entries()) {
    const recipes = buildings.filter(
      (building) => building.district === district.id,
    );
    const material = resources.buildingMaterials[districtIndex];
    if (recipes.length === 0 || !material) {
      continue;
    }
    const mesh = new InstancedMesh(
      resources.buildingGeometry,
      material,
      recipes.length,
    );
    mesh.name = `city-buildings:${payload.cellId}:${district.id}`;
    const dummy = new Object3D();
    recipes.forEach((building, index) => {
      mesh.setMatrixAt(
        index,
        composeMatrix(
          dummy,
          building.position.x,
          building.position.y,
          building.position.z,
          building.width,
          building.height,
          building.depth,
        ),
      );
      mesh.setColorAt(index, new Color(building.color));
    });
    mesh.castShadow = quality === 'high';
    mesh.receiveShadow = true;
    finalizeInstances(mesh);
    recordDensityMesh(
      payload,
      'structures',
      mesh,
      quality === 'high',
      `buildings:${district.id}`,
    );
  }
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
    const count = densityCount(record.capacity, density);
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
  quality: WorldQuality,
  resources: CityVisualSharedResources,
): CityCellVisualPayload {
  const payload = createCellPayload(cellId);
  createBuildings(payload, recipes.buildings, quality, resources);
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
  resources: CityVisualSharedResources,
  quality: WorldQuality,
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
      instantiateCellPayload(root, cellId, recipes, quality, resources),
    );
    createdCellIds.push(cellId);
  }
  const active = new Set(activeCellIds);
  const visibleCellIds: CellId[] = [];
  const hiddenCellIds: CellId[] = [];
  let structuresVisible = 0;
  let structuresCapacity = 0;
  let propsVisible = 0;
  let propsCapacity = 0;
  let traversalVisible = 0;
  let traversalCapacity = 0;
  let shadowCastingInstances = 0;

  for (const cellId of residentCellIds) {
    const payload = payloads.get(cellId);
    if (!payload) {
      continue;
    }
    const cellVisible = active.has(cellId);
    payload.root.visible = cellVisible;
    (cellVisible ? visibleCellIds : hiddenCellIds).push(cellId);

    const structures = applyDensity(
      payload.structures,
      drawDensity.structures,
      drawDensity.shadows,
      cellVisible,
    );
    const props = applyDensity(
      payload.props,
      drawDensity.props,
      drawDensity.shadows,
      cellVisible,
    );
    const traversal = applyDensity(
      payload.traversal,
      1,
      drawDensity.shadows,
      cellVisible,
    );
    structuresVisible += structures.visible;
    structuresCapacity += structures.capacity;
    propsVisible += props.visible;
    propsCapacity += props.capacity;
    traversalVisible += traversal.visible;
    traversalCapacity += traversal.capacity;
    shadowCastingInstances +=
      structures.shadows + props.shadows + traversal.shadows;
  }

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

export function createCityVisuals(layout: CityLayout): CityVisualBundle {
  const root = new Group();
  root.name = 'procedural-solara';
  const geometries: BufferGeometry[] = [];
  const materials: MeshStandardMaterial[] = [];
  const recipeIndex = indexCellRecipes(layout);
  const payloads = new Map<CellId, CityCellVisualPayload>();
  createDistrictGrounds(root, geometries, materials);
  const roadMaterial = createRoads(root, layout, geometries, materials);
  const resources = createSharedResources(geometries, materials);
  let disposed = false;

  return {
    root,
    buildingMaterials: resources.buildingMaterials,
    roadMaterial,
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
        resources,
        layout.quality,
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
    this.materials.push(jacketMaterial, darkMaterial, skinMaterial);

    const torsoGeometry = new BoxGeometry(0.78, 0.95, 0.42);
    const headGeometry = new IcosahedronGeometry(0.31, 1);
    const limbGeometry = new BoxGeometry(0.24, 0.78, 0.24);
    this.geometries.push(torsoGeometry, headGeometry, limbGeometry);

    const torso = new Mesh(torsoGeometry, jacketMaterial);
    torso.position.y = 1.42;
    torso.castShadow = true;
    const head = new Mesh(headGeometry, skinMaterial);
    head.position.y = 2.18;
    head.castShadow = true;
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
    this.root.add(torso, head, this.leftArm, this.rightArm, this.leftLeg, this.rightLeg);
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
  readonly mesh: Mesh;
  readonly radius: number;
  readonly steerable: boolean;
}

interface VehicleModelMaterials {
  readonly body: MeshStandardMaterial;
  readonly accent: MeshStandardMaterial;
  readonly glass: MeshStandardMaterial;
  readonly tire: MeshStandardMaterial;
  readonly hub: MeshStandardMaterial;
  readonly headlight: MeshBasicMaterial;
  readonly taillight: MeshBasicMaterial;
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
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: (MeshStandardMaterial | MeshBasicMaterial)[] = [];
  private modelRoot: Group | null = null;
  private bodyMaterial: MeshStandardMaterial | null = null;
  private activeClassId: VehicleClassId;
  private activePaint: VehicleVisualPaint = 'factory';
  private wheelTravel = 0;
  private disposed = false;

  public constructor(initialClassId: VehicleClassId = DEFAULT_VEHICLE_CLASS_ID) {
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
    const color = normalized === 'factory'
      ? VEHICLE_VISUAL_PALETTES[this.activeClassId].body
      : VEHICLE_VISUAL_PAINTS[normalized];
    this.bodyMaterial?.color.setHex(color);
    this.root.userData.vehiclePaint = normalized;
    return normalized;
  }

  private createMaterials(classId: VehicleClassId): VehicleModelMaterials {
    const palette = VEHICLE_VISUAL_PALETTES[classId];
    const body = new MeshStandardMaterial({ color: palette.body, roughness: 0.48, metalness: 0.2 });
    const accent = new MeshStandardMaterial({ color: palette.accent, roughness: 0.58, metalness: 0.18 });
    const glass = new MeshStandardMaterial({
      color: palette.glass,
      roughness: 0.16,
      metalness: 0.5,
      transparent: true,
      opacity: 0.9,
    });
    const tire = new MeshStandardMaterial({ color: 0x0e1215, roughness: 0.96 });
    const hub = new MeshStandardMaterial({ color: 0x85929a, roughness: 0.38, metalness: 0.72 });
    const headlight = new MeshBasicMaterial({ color: 0xfff1bd });
    const taillight = new MeshBasicMaterial({ color: 0xff3e39 });
    this.bodyMaterial = body;
    this.materials.push(body, accent, glass, tire, hub, headlight, taillight);
    return { body, accent, glass, tire, hub, headlight, taillight };
  }

  private addBox(
    parent: Group,
    name: string,
    size: readonly [number, number, number],
    position: readonly [number, number, number],
    material: MeshStandardMaterial | MeshBasicMaterial,
    rotation: readonly [number, number, number] = [0, 0, 0],
  ): Mesh {
    const geometry = new BoxGeometry(...size);
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    mesh.castShadow = material instanceof MeshStandardMaterial;
    mesh.receiveShadow = material instanceof MeshStandardMaterial;
    parent.add(mesh);
    this.geometries.push(geometry);
    return mesh;
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
    materials: VehicleModelMaterials,
  ): void {
    const wheelGeometry = new CylinderGeometry(radius, radius, width, 12);
    const wheel = new Mesh(wheelGeometry, materials.tire);
    wheel.name = `vehicle-wheel:${role}`;
    wheel.position.set(...position);
    wheel.rotation.z = Math.PI / 2;
    wheel.castShadow = true;
    wheel.userData.steerable = steerable;
    const hubGeometry = new CylinderGeometry(radius * 0.48, radius * 0.48, width + 0.015, 10);
    const hub = new Mesh(hubGeometry, materials.hub);
    hub.name = `vehicle-wheel-hub:${role}`;
    wheel.add(hub);
    parent.add(wheel);
    this.geometries.push(wheelGeometry, hubGeometry);
    this.wheels.push({ mesh: wheel, radius, steerable });
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
    const redBeacon = new MeshBasicMaterial({ color: 0xff3038 });
    const blueBeacon = new MeshBasicMaterial({ color: 0x328cff });
    this.materials.push(redBeacon, blueBeacon);
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
    this.root.name = `vehicle:${classId}`;
    this.root.userData.vehicleClassId = classId;
    this.root.userData.vehicleName = profile.name;
    this.root.userData.vehicleDescription = profile.description;
    this.setPaint(this.activePaint);
    this.root.add(model);
  }

  private releaseModel(): void {
    this.modelRoot?.removeFromParent();
    this.modelRoot?.clear();
    this.modelRoot = null;
    this.bodyMaterial = null;
    this.geometries.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
    this.geometries.length = 0;
    this.materials.length = 0;
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
    this.wheels.forEach((wheel) => {
      wheel.mesh.rotation.x = this.wheelTravel / wheel.radius;
      wheel.mesh.rotation.y = wheel.steerable ? -state.steering * 0.36 : 0;
    });
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
    this.positions = new Float32Array(this.count * 3);
    const rng = new SeededRandom(seed ^ 0xa17c93);
    for (let index = 0; index < this.count; index += 1) {
      const offset = index * 3;
      this.positions[offset] = rng.range(-72, 72);
      this.positions[offset + 1] = rng.range(2, 72);
      this.positions[offset + 2] = rng.range(-72, 72);
    }
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
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
