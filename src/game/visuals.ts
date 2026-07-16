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

export class VehicleVisual {
  public readonly root = new Group();

  private readonly wheels: readonly Mesh[];
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: (MeshStandardMaterial | MeshBasicMaterial)[] = [];
  private wheelSpin = 0;

  public constructor() {
    this.root.name = 'arcade-sports-car';
    const bodyMaterial = new MeshStandardMaterial({ color: 0x16b8a9, roughness: 0.42, metalness: 0.28 });
    const glassMaterial = new MeshStandardMaterial({ color: 0x163248, roughness: 0.2, metalness: 0.48 });
    const tireMaterial = new MeshStandardMaterial({ color: 0x101418, roughness: 0.94 });
    const headlightMaterial = new MeshBasicMaterial({ color: 0xfff1bd });
    this.materials.push(bodyMaterial, glassMaterial, tireMaterial, headlightMaterial);

    const lowerGeometry = new BoxGeometry(2.15, 0.62, 4.35);
    const cabinGeometry = new BoxGeometry(1.72, 0.68, 2.05);
    const bumperGeometry = new BoxGeometry(2.28, 0.24, 0.38);
    const wheelGeometry = new CylinderGeometry(0.43, 0.43, 0.38, 10);
    const lightGeometry = new BoxGeometry(0.42, 0.18, 0.08);
    this.geometries.push(lowerGeometry, cabinGeometry, bumperGeometry, wheelGeometry, lightGeometry);

    const lower = new Mesh(lowerGeometry, bodyMaterial);
    lower.position.y = 0.78;
    lower.castShadow = true;
    const cabin = new Mesh(cabinGeometry, glassMaterial);
    cabin.position.set(0, 1.37, -0.18);
    cabin.castShadow = true;
    const frontBumper = new Mesh(bumperGeometry, bodyMaterial);
    frontBumper.position.set(0, 0.58, -2.18);
    const rearBumper = new Mesh(bumperGeometry, bodyMaterial);
    rearBumper.position.set(0, 0.58, 2.18);

    const wheelPositions: readonly (readonly [number, number, number])[] = [
      [-1.08, 0.52, -1.42],
      [1.08, 0.52, -1.42],
      [-1.08, 0.52, 1.42],
      [1.08, 0.52, 1.42],
    ];
    this.wheels = wheelPositions.map(([x, y, z]) => {
      const wheel = new Mesh(wheelGeometry, tireMaterial);
      wheel.position.set(x, y, z);
      wheel.rotation.z = Math.PI / 2;
      wheel.castShadow = true;
      return wheel;
    });

    const leftHeadlight = new Mesh(lightGeometry, headlightMaterial);
    const rightHeadlight = new Mesh(lightGeometry, headlightMaterial);
    leftHeadlight.position.set(-0.63, 0.85, -2.2);
    rightHeadlight.position.set(0.63, 0.85, -2.2);
    this.root.add(
      lower,
      cabin,
      frontBumper,
      rearBumper,
      ...this.wheels,
      leftHeadlight,
      rightHeadlight,
    );
  }

  public sync(state: Readonly<VehicleSimulationState>, deltaSeconds: number): void {
    this.root.position.set(state.position.x, state.position.y, state.position.z);
    this.root.rotation.y = state.heading;
    this.wheelSpin -= state.speed * deltaSeconds / 0.43;
    this.wheels.forEach((wheel, index) => {
      wheel.rotation.x = this.wheelSpin;
      wheel.rotation.y = index < 2 ? -state.steering * 0.32 : 0;
    });
  }

  public dispose(): void {
    this.root.removeFromParent();
    this.geometries.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
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
