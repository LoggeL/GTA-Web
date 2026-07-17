import {
  Box3,
  Color,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Object3D,
} from 'three';
import type { BufferAttribute, BufferGeometry, Group, Material } from 'three';
import { describe, expect, it } from 'vitest';

import { DISTRICTS, DISTRICT_SIZE, generateCity } from '../../src/game/city';
import type { CityLayout } from '../../src/game/city';
import { RainField, createCityVisuals } from '../../src/game/visuals';
import { cellIdAt } from '../../src/navigation/cells';
import type { CellId } from '../../src/navigation/types';

const FULL_DENSITY = {
  roads: 1,
  structures: 1,
  props: 1,
  actors: 1,
  shadows: 1,
} as const;

describe('weather visuals', () => {
  it('skips particle mutation and GPU uploads throughout dry frames', () => {
    const rain = new RainField(42, 'low');
    const positions = rain.points.geometry.getAttribute('position') as BufferAttribute;
    const initialValues = Array.from(positions.array);

    rain.update(1 / 60, 0, { x: 10, y: 0, z: -20 });

    expect(rain.points.visible).toBe(false);
    expect(rain.points.geometry.drawRange).toEqual({ start: 0, count: 0 });
    expect(positions.version).toBe(0);
    expect(Array.from(positions.array)).toEqual(initialValues);

    rain.update(1 / 60, 0.5, { x: 10, y: 0, z: -20 });
    expect(rain.points.visible).toBe(true);
    expect(positions.version).toBe(1);
    expect(Array.from(positions.array)).not.toEqual(initialValues);

    rain.update(1 / 60, 0, { x: 50, y: 0, z: 30 });
    expect(positions.version).toBe(1);

    rain.dispose();
  });
});

function contentCellIds(layout: CityLayout): CellId[] {
  return [...new Set([
    ...layout.buildings.map((building) => cellIdAt(building.position)),
    ...layout.props.map((prop) => cellIdAt(prop.position)),
    ...layout.traversalObstacles.map((obstacle) => cellIdAt({
      x: (obstacle.minX + obstacle.maxX) / 2,
      z: (obstacle.minZ + obstacle.maxZ) / 2,
    })),
  ])].sort((left, right) => left.localeCompare(right));
}

function payloadRoots(root: Group): Group[] {
  return root.children.filter(
    (child): child is Group => child.name.startsWith('city-payload:'),
  );
}

function payloadSignature(root: Group, cellId: CellId): readonly unknown[] {
  const signature: unknown[] = [];
  root.getObjectByName(`city-payload:${cellId}`)?.traverse((object) => {
    if (!(object instanceof InstancedMesh)) {
      return;
    }
    signature.push({
      name: object.name,
      capacity: object.count,
      matrices: Array.from(object.instanceMatrix.array),
      colors: object.instanceColor
        ? Array.from(object.instanceColor.array)
        : null,
    });
  });
  return signature;
}

function instanceSignature(matrix: Matrix4, color: Color): string {
  return [
    ...matrix.elements.map((value) => value.toFixed(5)),
    color.r.toFixed(5),
    color.g.toFixed(5),
    color.b.toFixed(5),
  ].join(',');
}

function composeMatrixForTest(
  target: Object3D,
  x: number,
  y: number,
  z: number,
  scaleX: number,
  scaleY: number,
  scaleZ: number,
): Matrix4 {
  target.position.set(x, y, z);
  target.rotation.set(0, 0, 0);
  target.scale.set(scaleX, scaleY, scaleZ);
  target.updateMatrix();
  return target.matrix.clone();
}

function visibleInstanceSignatures(
  meshes: readonly InstancedMesh[],
  firstMeshOffset = 0,
  firstMeshCount?: number,
): string[] {
  const matrix = new Matrix4();
  const color = new Color();
  const signatures: string[] = [];
  meshes.forEach((mesh, meshIndex) => {
    const startIndex = meshIndex === 0 ? firstMeshOffset : 0;
    const endIndex = meshIndex === 0 && firstMeshCount !== undefined
      ? Math.min(mesh.count, startIndex + firstMeshCount)
      : mesh.count;
    for (let index = startIndex; index < endIndex; index += 1) {
      mesh.getMatrixAt(index, matrix);
      if (mesh.instanceColor) {
        mesh.getColorAt(index, color);
      } else {
        color.set(0xffffff);
      }
      signatures.push(instanceSignature(matrix, color));
    }
  });
  return signatures.sort();
}

function expandedInstanceColors(meshes: readonly InstancedMesh[]): string[] {
  const color = new Color();
  const colors: string[] = [];
  for (const mesh of meshes) {
    const vertexCount = mesh.geometry.index?.count
      ?? mesh.geometry.getAttribute('position').count;
    for (let index = 0; index < mesh.count; index += 1) {
      if (mesh.instanceColor) mesh.getColorAt(index, color);
      else color.set(0xffffff);
      const signature = [color.r, color.g, color.b]
        .map((value) => value.toFixed(5))
        .join(',');
      for (let vertex = 0; vertex < vertexCount; vertex += 1) colors.push(signature);
    }
  }
  return colors.sort();
}

function geometryColors(geometry: BufferGeometry): string[] {
  const attribute = geometry.getAttribute('color');
  const colors: string[] = [];
  for (let index = 0; index < attribute.count; index += 1) {
    colors.push([
      attribute.getX(index),
      attribute.getY(index),
      attribute.getZ(index),
    ].map((value) => value.toFixed(5)).join(','));
  }
  return colors.sort();
}

function transformedInstanceBounds(meshes: readonly InstancedMesh[]): Box3 {
  const result = new Box3();
  const matrix = new Matrix4();
  for (const mesh of meshes) {
    mesh.geometry.computeBoundingBox();
    const local = mesh.geometry.boundingBox;
    if (!local) continue;
    for (let index = 0; index < mesh.count; index += 1) {
      mesh.getMatrixAt(index, matrix);
      result.union(local.clone().applyMatrix4(matrix));
    }
  }
  return result;
}

describe('streamed city visuals', () => {
  it('lazily creates only requested content cells and reports bounded residency', () => {
    const layout = generateCity('visual-streaming', 'high');
    const knownCellIds = contentCellIds(layout);
    const firstCellId = knownCellIds[0];
    const middleCellId = knownCellIds[Math.floor(knownCellIds.length / 2)];
    const lastCellId = knownCellIds.at(-1);
    expect(firstCellId).toBeDefined();
    expect(middleCellId).toBeDefined();
    expect(lastCellId).toBeDefined();
    const residentCellIds = [firstCellId, middleCellId, lastCellId].filter(
      (cellId): cellId is CellId => cellId !== undefined,
    );
    const visuals = createCityVisuals(layout);

    expect(payloadRoots(visuals.root)).toHaveLength(0);
    const snapshot = visuals.applyStreamingState(
      firstCellId ? [firstCellId] : [],
      residentCellIds,
      FULL_DENSITY,
    );

    expect(snapshot.knownCellIds).toEqual(knownCellIds);
    expect(snapshot.residentCellIds).toEqual(residentCellIds);
    expect(snapshot.createdCellIds).toEqual(residentCellIds);
    expect(snapshot.evictedCellIds).toEqual([]);
    expect(snapshot.visibleCellIds).toEqual(firstCellId ? [firstCellId] : []);
    expect(snapshot.hiddenCellIds).toEqual(residentCellIds.slice(1));
    expect(payloadRoots(visuals.root)).toHaveLength(residentCellIds.length);
    expect(visuals.root.getObjectByName('city-roads')?.visible).toBe(true);
    expect(visuals.root.getObjectByName('city-road-markings')?.visible).toBe(true);
    expect(visuals.root.getObjectByName('city-ocean')?.visible).toBe(true);

    const unchanged = visuals.applyStreamingState(
      firstCellId ? [firstCellId] : [],
      residentCellIds,
      FULL_DENSITY,
    );
    expect(unchanged.createdCellIds).toEqual([]);
    expect(unchanged.evictedCellIds).toEqual([]);
    expect(payloadRoots(visuals.root)).toHaveLength(residentCellIds.length);

    visuals.dispose();
  });

  it('evicts roots, releases instances, and deterministically recreates far cells', () => {
    const layout = generateCity('visual-traversal', 'high');
    const knownCellIds = contentCellIds(layout);
    const firstCellId = knownCellIds[0];
    const secondCellId = knownCellIds[Math.floor(knownCellIds.length / 3)];
    const thirdCellId = knownCellIds[Math.floor(knownCellIds.length * 2 / 3)];
    const lastCellId = knownCellIds.at(-1);
    expect(firstCellId).toBeDefined();
    expect(secondCellId).toBeDefined();
    expect(thirdCellId).toBeDefined();
    expect(lastCellId).toBeDefined();
    if (!firstCellId || !secondCellId || !thirdCellId || !lastCellId) {
      throw new Error('Expected city content across several cells');
    }
    const visuals = createCityVisuals(layout);
    visuals.applyStreamingState(
      [firstCellId],
      [firstCellId, secondCellId],
      FULL_DENSITY,
    );
    const firstRoot = visuals.root.getObjectByName(`city-payload:${firstCellId}`);
    expect(firstRoot).toBeDefined();
    const firstSignature = payloadSignature(visuals.root, firstCellId);
    expect(firstSignature.length).toBeGreaterThan(0);
    let releasedInstances = 0;
    firstRoot?.traverse((object) => {
      if (object instanceof InstancedMesh) {
        object.addEventListener('dispose', () => {
          releasedInstances += 1;
        });
      }
    });

    const moved = visuals.applyStreamingState(
      [thirdCellId],
      [secondCellId, thirdCellId, lastCellId],
      FULL_DENSITY,
    );
    expect(moved.residentCellIds).toEqual(
      [secondCellId, thirdCellId, lastCellId].sort((left, right) =>
        left.localeCompare(right),
      ),
    );
    expect(moved.visibleCellIds).toEqual([thirdCellId]);
    expect(moved.evictedCellIds).toEqual([firstCellId]);
    expect(moved.createdCellIds).toEqual(
      [thirdCellId, lastCellId].sort((left, right) => left.localeCompare(right)),
    );
    expect(releasedInstances).toBeGreaterThan(0);
    expect(visuals.root.getObjectByName(`city-payload:${firstCellId}`)).toBeUndefined();
    expect(payloadRoots(visuals.root)).toHaveLength(3);

    const returned = visuals.applyStreamingState(
      [firstCellId],
      [firstCellId, lastCellId],
      FULL_DENSITY,
    );
    expect(returned.residentCellIds).toEqual(
      [firstCellId, lastCellId].sort((left, right) => left.localeCompare(right)),
    );
    expect(returned.createdCellIds).toEqual([firstCellId]);
    expect(returned.evictedCellIds).toEqual(
      [secondCellId, thirdCellId].sort((left, right) => left.localeCompare(right)),
    );
    expect(payloadSignature(visuals.root, firstCellId)).toEqual(firstSignature);
    expect(payloadRoots(visuals.root)).toHaveLength(2);

    visuals.dispose();
  });

  it('applies density to resident payloads without hiding traversal or surfaces', () => {
    const layout = generateCity('visual-density', 'high');
    const obstacle = layout.traversalObstacles[0];
    expect(obstacle).toBeDefined();
    const activeCellId = cellIdAt({
      x: ((obstacle?.minX ?? 0) + (obstacle?.maxX ?? 0)) / 2,
      z: ((obstacle?.minZ ?? 0) + (obstacle?.maxZ ?? 0)) / 2,
    });
    const visuals = createCityVisuals(layout);
    const full = visuals.applyStreamingState(
      [activeCellId],
      [activeCellId],
      FULL_DENSITY,
    );
    const sparse = visuals.applyStreamingState(
      [activeCellId],
      [activeCellId],
      {
        roads: 1,
        structures: 0,
        props: 0,
        actors: 0.5,
        shadows: 0,
      },
    );

    expect(full.traversal.visible).toBeGreaterThan(0);
    expect(sparse.structures.visible).toBe(0);
    expect(sparse.props.visible).toBe(0);
    expect(sparse.traversal.visible).toBe(full.traversal.visible);
    expect(sparse.shadowCastingInstances).toBe(0);
    const cellRoot = visuals.root.getObjectByName(`city-payload:${activeCellId}`);
    const streamedMeshes: InstancedMesh[] = [];
    cellRoot?.traverse((object) => {
      if (object instanceof InstancedMesh) {
        streamedMeshes.push(object);
      }
    });
    expect(streamedMeshes.some((mesh) => mesh.name.startsWith('city-traversal'))).toBe(
      true,
    );
    expect(streamedMeshes.every((mesh) => !mesh.castShadow)).toBe(true);
    expect(visuals.root.getObjectByName('city-roads')?.visible).toBe(true);

    visuals.dispose();
  });

  it('submits all nine building layers in five global district-aware batches', () => {
    const layout = generateCity('visual-building-batches', 'high');
    const activeCellId = cellIdAt(layout.buildings[0]!.position);
    const buildingCount = layout.buildings.filter(
      (building) => cellIdAt(building.position) === activeCellId,
    ).length;
    const visuals = createCityVisuals(layout);
    const full = visuals.applyStreamingState(
      [activeCellId],
      [activeCellId],
      FULL_DENSITY,
    );
    const structureMeshes: InstancedMesh[] = [];
    visuals.root.traverse((object) => {
      if (object instanceof InstancedMesh && object.name.startsWith('city-building-')) {
        structureMeshes.push(object);
      }
    });

    expect(structureMeshes).toHaveLength(5);
    expect(structureMeshes.every((mesh) => !mesh.frustumCulled)).toBe(true);
    const districtBuildingCounts = [...new Set(layout.buildings.map((building) => building.district))]
      .map((district) => layout.buildings.filter((building) => building.district === district).length);
    expect(structureMeshes.map((mesh) => mesh.instanceMatrix.count).sort((a, b) => a - b))
      .toEqual([
        ...districtBuildingCounts.map((count) => count * 4),
        layout.buildings.length * 5,
      ].sort((a, b) => a - b));
    expect(structureMeshes.map((mesh) => mesh.count).sort((a, b) => a - b))
      .toEqual([0, 0, 0, buildingCount * 4, buildingCount * 5]);
    expect(
      structureMeshes.every(
        (mesh) =>
          mesh.count === 0
          || mesh.instanceColor?.count === mesh.instanceMatrix.count,
      ),
    ).toBe(true);
    expect(full.structures.visible).toBe(buildingCount * 9);
    const solids = structureMeshes.filter((mesh) => mesh.name.startsWith('city-building-solids:'));
    expect(solids.map((mesh) => mesh.material)).toEqual(visuals.buildingMaterials);
    const solid = solids.find((mesh) => mesh.count > 0);
    expect(solid).toBeDefined();
    expect(visuals.buildingMaterials).toContain(solid?.material);

    const reduced = visuals.applyStreamingState(
      [activeCellId],
      [activeCellId],
      { ...FULL_DENSITY, structures: 0.72 },
    );
    expect(reduced.structures.visible).toBe(Math.floor(buildingCount * 0.72) * 9);
    expect(structureMeshes.map((mesh) => mesh.count).sort((a, b) => a - b))
      .toEqual([
        0,
        0,
        0,
        Math.floor(buildingCount * 0.72) * 4,
        Math.floor(buildingCount * 0.72) * 5,
      ]);

    visuals.buildingMaterials.forEach((material) => {
      material.emissiveIntensity = 0.61;
    });
    expect(solid?.material).toBeInstanceOf(MeshStandardMaterial);
    expect((solid?.material as MeshStandardMaterial).emissiveIntensity).toBe(0.61);

    visuals.dispose();
  });

  it('compacts active prop payloads into six material-aware draw batches without changing counts', () => {
    const layout = generateCity('visual-prop-batches', 'high');
    const activeCellId = cellIdAt(layout.props[0]!.position);
    const visuals = createCityVisuals(layout);
    const full = visuals.applyStreamingState(
      [activeCellId],
      [activeCellId],
      FULL_DENSITY,
    );
    const sourceMeshes: InstancedMesh[] = [];
    visuals.root.getObjectByName(`city-payload:${activeCellId}`)?.traverse((object) => {
      if (object instanceof InstancedMesh && !object.name.startsWith('city-traversal:')) {
        sourceMeshes.push(object);
      }
    });
    const batches: InstancedMesh[] = [];
    visuals.root.traverse((object) => {
      if (object instanceof InstancedMesh && object.name.startsWith('city-props-batch:')) {
        batches.push(object);
      }
    });

    expect(batches).toHaveLength(6);
    expect(batches.every((mesh) => !mesh.frustumCulled)).toBe(true);
    const sourceAccent = sourceMeshes.find((mesh) =>
      mesh.name.startsWith('city-street-furniture-accents:')
    );
    const accentBatch = batches.find((mesh) => mesh.name === 'city-props-batch:accents');
    if (sourceAccent) {
      expect(accentBatch?.material).toBe(sourceAccent.material);
    }
    expect(sourceMeshes.length).toBeGreaterThan(0);
    expect(sourceMeshes.every((mesh) => !mesh.visible && !mesh.castShadow)).toBe(true);
    expect(full.props.visible).toBe(
      sourceMeshes.reduce((count, mesh) => count + mesh.instanceMatrix.count, 0),
    );
    expect(batches.reduce((count, mesh) => count + mesh.count, 0)).toBe(full.props.visible);

    const fractionalShadows = visuals.applyStreamingState(
      [activeCellId],
      [activeCellId],
      { ...FULL_DENSITY, shadows: 0.5 },
    );
    expect(fractionalShadows.shadowCastingInstances).toBeGreaterThan(0);
    expect(fractionalShadows.shadowCastingInstances).toBeLessThan(
      full.shadowCastingInstances,
    );

    const reduced = visuals.applyStreamingState(
      [activeCellId],
      [activeCellId],
      { ...FULL_DENSITY, props: 0.5, shadows: 0 },
    );
    expect(reduced.props.visible).toBe(
      sourceMeshes.reduce(
        (count, mesh) => count + Math.floor(mesh.instanceMatrix.count * 0.5),
        0,
      ),
    );
    expect(batches.reduce((count, mesh) => count + mesh.count, 0)).toBe(reduced.props.visible);
    expect(batches.every((mesh) => !mesh.castShadow)).toBe(true);

    visuals.dispose();
  });

  it('uses true low-quality instance and geometry merges only on supported drivers', () => {
    const layout = generateCity('visual-supported-multidraw', 'low');
    const buildingCells = new Set(
      layout.buildings.map((building) => cellIdAt(building.position)),
    );
    const activeCellId = layout.props
      .map((prop) => cellIdAt(prop.position))
      .find((cellId) => buildingCells.has(cellId));
    expect(activeCellId).toBeDefined();
    if (!activeCellId) throw new Error('Expected a cell containing buildings and props');

    const supported = createCityVisuals(layout, { supportsMultiDraw: true });
    const fallback = createCityVisuals(layout, { supportsMultiDraw: false });
    const supportedSnapshot = supported.applyStreamingState(
      [activeCellId],
      [activeCellId],
      FULL_DENSITY,
    );
    const fallbackSnapshot = fallback.applyStreamingState(
      [activeCellId],
      [activeCellId],
      FULL_DENSITY,
    );
    expect(supportedSnapshot.structures).toEqual(fallbackSnapshot.structures);
    expect(supportedSnapshot.props).toEqual(fallbackSnapshot.props);

    const buildingRoot = supported.root.getObjectByName('city-buildings-low-quality');
    const propBatch = supported.root.getObjectByName('city-props-merged');
    expect(buildingRoot).toBeDefined();
    expect(propBatch).toBeInstanceOf(Mesh);
    if (!buildingRoot || !(propBatch instanceof Mesh)) {
      throw new Error('Expected both supported low-quality city carrier roots');
    }
    const buildingBatches = buildingRoot.children.filter(
      (object): object is InstancedMesh => object instanceof InstancedMesh,
    );
    const visibleBuildingBatches = buildingBatches.filter((mesh) => mesh.visible);
    expect(buildingBatches.length).toBeGreaterThan(1);
    expect(visibleBuildingBatches).toHaveLength(1);
    expect(propBatch.visible).toBe(true);
    expect(
      buildingBatches.every((mesh) => mesh.material instanceof MeshLambertMaterial),
    ).toBe(true);
    expect(buildingBatches.every((mesh) => mesh.frustumCulled)).toBe(true);
    expect(
      buildingBatches.every((mesh) => Number.isFinite(mesh.boundingSphere?.radius)),
    ).toBe(true);
    expect(propBatch.material).toBeInstanceOf(MeshLambertMaterial);
    expect((buildingBatches[0]?.material as MeshLambertMaterial).fog).toBe(true);
    expect((propBatch.material as MeshLambertMaterial).fog).toBe(true);
    expect((propBatch.material as MeshLambertMaterial).vertexColors).toBe(true);
    expect(buildingBatches[0]?.geometry.getAttribute('normal').count)
      .toBe(buildingBatches[0]?.geometry.getAttribute('position').count);
    const fixedInstanceCount = DISTRICTS.length + layout.roads.length * 3;
    const surfaceBatch = supported.root.getObjectByName('city-sidewalks');
    expect(surfaceBatch).toBeInstanceOf(InstancedMesh);
    expect(surfaceBatch).not.toBe(buildingRoot);
    expect(surfaceBatch?.userData.fixedInstanceCount).toBe(fixedInstanceCount);
    expect(buildingBatches.reduce((count, mesh) => count + mesh.count, 0)).toBe(
      supportedSnapshot.structures.visible,
    );
    const unifiedCarriers: InstancedMesh[] = [];
    supported.root.traverse((object) => {
      if (
        object instanceof InstancedMesh
        && (
          object.name.startsWith('city-building-cluster:')
          || object.name === 'city-surfaces-low-quality'
          || object.name === 'city-roads'
        )
      ) {
        unifiedCarriers.push(object);
      }
    });
    expect(unifiedCarriers).toHaveLength(buildingBatches.length + 1);

    const supportedFallbacks: InstancedMesh[] = [];
    supported.root.traverse((object) => {
      if (
          object instanceof InstancedMesh
          && (
          object.name.startsWith('city-building-solids:')
          || object.name === 'city-building-facades'
          || object.name.startsWith('city-props-batch:')
        )
      ) {
        supportedFallbacks.push(object);
      }
    });
    expect(supportedFallbacks).toHaveLength(11);
    expect(
      supportedFallbacks.every((mesh) => mesh.count === 0 && !mesh.visible),
    ).toBe(true);
    expect(
      supportedFallbacks.every((mesh) => mesh.material instanceof MeshStandardMaterial),
    ).toBe(true);

    const fallbackBuildings: InstancedMesh[] = [];
    const fallbackProps: InstancedMesh[] = [];
    fallback.root.traverse((object) => {
      if (!(object instanceof InstancedMesh)) return;
      if (
        object.name.startsWith('city-building-solids:')
        || object.name === 'city-building-facades'
      ) {
        fallbackBuildings.push(object);
      }
      if (object.name.startsWith('city-props-batch:')) fallbackProps.push(object);
    });
    expect(
      [...fallbackBuildings, ...fallbackProps]
        .every((mesh) => mesh.material instanceof MeshStandardMaterial),
    ).toBe(true);
    expect(visibleInstanceSignatures(
      visibleBuildingBatches,
    )).toEqual(
      visibleInstanceSignatures(fallbackBuildings),
    );
    const expectedPropVertices = fallbackProps.reduce(
      (count, mesh) => count + mesh.count * (
        mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count
      ),
      0,
    );
    expect(propBatch.geometry.getAttribute('position').count).toBe(expectedPropVertices);
    expect(propBatch.geometry.getAttribute('normal').count).toBe(expectedPropVertices);
    expect(geometryColors(propBatch.geometry)).toEqual(
      expandedInstanceColors(fallbackProps),
    );
    propBatch.geometry.computeBoundingBox();
    const expectedBounds = transformedInstanceBounds(fallbackProps);
    const actualMin = propBatch.geometry.boundingBox?.min.toArray() ?? [];
    const actualMax = propBatch.geometry.boundingBox?.max.toArray() ?? [];
    expectedBounds.min.toArray().forEach((value, index) => {
      expect(actualMin[index]).toBeCloseTo(value, 4);
    });
    expectedBounds.max.toArray().forEach((value, index) => {
      expect(actualMax[index]).toBeCloseTo(value, 4);
    });

    const allPropCells = [...new Set(
      layout.props.map((prop) => cellIdAt(prop.position)),
    )];
    const allProps = supported.applyStreamingState(
      allPropCells,
      allPropCells,
      FULL_DENSITY,
    );
    expect(allProps.props.visible).toBeGreaterThanOrEqual(layout.props.length);
    expect(propBatch.geometry.getAttribute('position').count).toBeGreaterThan(0);

    const reduced = supported.applyStreamingState(
      [activeCellId],
      [activeCellId],
      { ...FULL_DENSITY, structures: 0.5, props: 0.5 },
    );
    expect(buildingBatches.reduce((count, mesh) => count + mesh.count, 0)).toBe(
      reduced.structures.visible,
    );
    expect(propBatch.visible).toBe(reduced.props.visible > 0);
    expect(propBatch.geometry.getAttribute('position').count).toBeLessThanOrEqual(
      expectedPropVertices,
    );

    expect(fallback.root.getObjectByName('city-buildings-low-quality')).toBeUndefined();
    expect(fallback.root.getObjectByName('city-props-merged')).toBeUndefined();
    expect(supported.roadMaterial).toBeInstanceOf(MeshLambertMaterial);
    expect(fallback.roadMaterial).toBeInstanceOf(MeshLambertMaterial);
    expect((supported.root.getObjectByName('city-road-markings') as Mesh).material)
      .toBeInstanceOf(MeshBasicMaterial);
    expect((supported.root.getObjectByName('city-ocean') as Mesh).material)
      .toBeInstanceOf(MeshLambertMaterial);
    supported.dispose();
    fallback.dispose();

    const high = createCityVisuals(
      generateCity('visual-high-multidraw-capability', 'high'),
      { supportsMultiDraw: true },
    );
    expect(high.root.getObjectByName('city-buildings-low-quality')).toBeUndefined();
    expect(high.root.getObjectByName('city-props-merged')).toBeUndefined();
    expect(high.roadMaterial).toBeInstanceOf(MeshStandardMaterial);
    expect((high.root.getObjectByName('city-road-markings') as Mesh).material)
      .toBeInstanceOf(MeshStandardMaterial);
    expect((high.root.getObjectByName('city-ocean') as Mesh).material)
      .toBeInstanceOf(MeshStandardMaterial);
    high.dispose();
  });

  it('separates top-only low surfaces from conservative frustum-cullable building clusters', () => {
    const layout = generateCity('visual-low-shared-surfaces', 'low');
    const supported = createCityVisuals(layout, { supportsMultiDraw: true });
    const fallback = createCityVisuals(layout, { supportsMultiDraw: false });
    const surfaceCarrier = supported.root.getObjectByName('city-sidewalks');
    const buildingRoot = supported.root.getObjectByName('city-buildings-low-quality');
    const fallbackSidewalks = fallback.root.getObjectByName('city-sidewalks');
    expect(surfaceCarrier).toBeInstanceOf(InstancedMesh);
    expect(buildingRoot).toBeDefined();
    expect(fallbackSidewalks).toBeInstanceOf(InstancedMesh);
    if (
      !(surfaceCarrier instanceof InstancedMesh)
      || !buildingRoot
      || !(fallbackSidewalks instanceof InstancedMesh)
    ) {
      throw new Error('Expected split low surface/building and fallback carriers');
    }
    const buildingBatches = buildingRoot.children.filter(
      (object): object is InstancedMesh => object instanceof InstancedMesh,
    );

    const fixedInstanceCount = DISTRICTS.length + layout.roads.length * 3;
    expect(surfaceCarrier.count).toBe(fixedInstanceCount);
    expect(surfaceCarrier.frustumCulled).toBe(false);
    expect(surfaceCarrier.geometry.index?.count).toBe(6);
    expect(surfaceCarrier.geometry.getAttribute('position').count).toBe(4);
    const surfaceMaterial = surfaceCarrier.material;
    expect(surfaceMaterial).toBeInstanceOf(MeshBasicMaterial);
    if (!(surfaceMaterial instanceof MeshBasicMaterial)) {
      throw new Error('Expected one Basic top-surface material');
    }
    expect(surfaceMaterial.color.getHex()).toBe(0xffffff);
    expect(surfaceMaterial.fog).toBe(true);
    expect(surfaceMaterial.toneMapped).toBe(true);
    expect(supported.roadMaterial).toBeInstanceOf(MeshLambertMaterial);
    expect(supported.roadMaterial).not.toBe(surfaceMaterial);
    expect(supported.roadMaterial.color.getHex()).toBe(0x26313b);
    expect(supported.root.getObjectByName('city-roads')).toBe(surfaceCarrier);
    expect(surfaceCarrier.name).toBe('city-surfaces-low-quality');
    expect(buildingBatches.length).toBeGreaterThan(1);
    for (const mesh of buildingBatches) {
      expect(mesh.name).toMatch(/^city-building-cluster:cell:/);
      expect(mesh.material).toBeInstanceOf(MeshLambertMaterial);
      expect(mesh.geometry.index?.count).toBe(36);
      expect(mesh.frustumCulled).toBe(true);
      expect(mesh.boundingBox?.isEmpty()).toBe(false);
      expect(Number.isFinite(mesh.boundingSphere?.radius)).toBe(true);
      expect(mesh.renderOrder).toBeLessThan(surfaceCarrier.renderOrder);
    }

    const actualMatrix = new Matrix4();
    const expectedDummy = new Object3D();
    const actualColor = new Color();
    const groundStartIndex = layout.roads.length * 3;
    DISTRICTS.forEach((district, index) => {
      surfaceCarrier.getMatrixAt(groundStartIndex + index, actualMatrix);
      const expectedMatrix = composeMatrixForTest(
        expectedDummy,
        (district.minX + district.maxX) / 2,
        -0.02,
        (district.minZ + district.maxZ) / 2,
        DISTRICT_SIZE,
        1,
        DISTRICT_SIZE,
      );
      expectedMatrix.elements.forEach((value, elementIndex) => {
        expect(actualMatrix.elements[elementIndex]).toBeCloseTo(value, 6);
      });
      surfaceCarrier.getColorAt(groundStartIndex + index, actualColor);
      expect(actualColor.getHex()).toBe(district.groundColor);
      const anchor = supported.root.getObjectByName(`city-ground:${district.id}`);
      expect(anchor).toBeDefined();
      expect(anchor).not.toBeInstanceOf(Mesh);
      expect(anchor?.position.toArray()).toEqual([
        (district.minX + district.maxX) / 2,
        -0.08,
        (district.minZ + district.maxZ) / 2,
      ]);
    });

    const fixedSignatures = visibleInstanceSignatures([surfaceCarrier]);
    const activeCellId = cellIdAt(layout.buildings[0]!.position);
    const streamed = supported.applyStreamingState(
      [activeCellId],
      [activeCellId],
      FULL_DENSITY,
    );
    expect(streamed.structures.visible).toBeGreaterThan(0);
    expect(buildingBatches.reduce((count, mesh) => count + mesh.count, 0)).toBe(
      streamed.structures.visible,
    );
    expect(buildingBatches.filter((mesh) => mesh.visible)).toHaveLength(1);
    expect(visibleInstanceSignatures([surfaceCarrier])).toEqual(fixedSignatures);
    expect(surfaceCarrier.userData.roadStartIndex).toBe(0);
    expect(surfaceCarrier.userData.sidewalkStartIndex).toBe(layout.roads.length);
    expect(surfaceCarrier.userData.groundStartIndex).toBe(layout.roads.length * 3);

    const empty = supported.applyStreamingState([], [], FULL_DENSITY);
    expect(empty.structures.visible).toBe(0);
    expect(buildingBatches.every((mesh) => mesh.count === 0 && !mesh.visible)).toBe(true);
    expect(surfaceCarrier.count).toBe(fixedInstanceCount);
    expect(surfaceCarrier.visible).toBe(true);
    for (const district of DISTRICTS) {
      const ground = fallback.root.getObjectByName(`city-ground:${district.id}`);
      expect(ground).toBeInstanceOf(Mesh);
      expect((ground as Mesh).material).toBeInstanceOf(MeshStandardMaterial);
      expect(((ground as Mesh).material as MeshStandardMaterial).roughness).toBe(0.94);
      expect(((ground as Mesh).material as MeshStandardMaterial).color.getHex())
        .toBe(district.groundColor);
    }
    expect((fallbackSidewalks.material as MeshStandardMaterial).roughness).toBe(0.96);
    expect(fallbackSidewalks.count).toBe(layout.roads.length * 2);

    let geometryDisposals = 0;
    let materialDisposals = 0;
    let roadMaterialDisposals = 0;
    surfaceCarrier.geometry.addEventListener('dispose', () => {
      geometryDisposals += 1;
    });
    surfaceMaterial.addEventListener('dispose', () => {
      materialDisposals += 1;
    });
    supported.roadMaterial.addEventListener('dispose', () => {
      roadMaterialDisposals += 1;
    });
    supported.dispose();
    supported.dispose();
    expect(geometryDisposals).toBe(1);
    expect(materialDisposals).toBe(1);
    expect(roadMaterialDisposals).toBe(1);
    expect(() => supported.setRoadColor(new Color(0x26313b))).toThrow(/disposed/);
    fallback.dispose();

    const highLayout = generateCity('visual-high-shared-surfaces', 'high');
    const high = createCityVisuals(highLayout, { supportsMultiDraw: true });
    const highSidewalks = high.root.getObjectByName('city-sidewalks');
    expect(highSidewalks).toBeInstanceOf(InstancedMesh);
    if (!(highSidewalks instanceof InstancedMesh)) {
      throw new Error('Expected the high-quality sidewalk carrier');
    }
    expect(highSidewalks.count).toBe(highLayout.roads.length * 2);
    expect(highSidewalks.material).toBeInstanceOf(MeshStandardMaterial);
    expect((highSidewalks.material as MeshStandardMaterial).roughness).toBe(0.96);
    for (const district of DISTRICTS) {
      expect(high.root.getObjectByName(`city-ground:${district.id}`)).toBeInstanceOf(Mesh);
    }
    high.dispose();
  });

  it('uses exact two-triangle marking quads only in low quality', () => {
    const lowLayout = generateCity('visual-low-marking-quads', 'low');
    const low = createCityVisuals(lowLayout, { supportsMultiDraw: true });
    const lowFallback = createCityVisuals(lowLayout, { supportsMultiDraw: false });
    const highLayout = generateCity('visual-high-marking-boxes', 'high');
    const high = createCityVisuals(highLayout, { supportsMultiDraw: true });
    const lowMarkings = low.root.getObjectByName('city-road-markings');
    const lowFallbackMarkings = lowFallback.root.getObjectByName('city-road-markings');
    const highMarkings = high.root.getObjectByName('city-road-markings');
    expect(lowMarkings).toBeInstanceOf(InstancedMesh);
    expect(lowFallbackMarkings).toBeInstanceOf(InstancedMesh);
    expect(highMarkings).toBeInstanceOf(InstancedMesh);
    if (
      !(lowMarkings instanceof InstancedMesh)
      || !(lowFallbackMarkings instanceof InstancedMesh)
      || !(highMarkings instanceof InstancedMesh)
    ) {
      throw new Error('Expected instanced road-marking carriers');
    }

    const expectedCount = lowLayout.roads.reduce(
      (count, road) => count + Math.floor(Math.max(road.width, road.depth) / 28),
      0,
    );
    expect(lowMarkings.name).toBe('city-road-markings');
    expect(lowMarkings.count).toBe(expectedCount);
    expect(lowFallbackMarkings.count).toBe(expectedCount);
    expect(lowMarkings.geometry.index?.count).toBe(6);
    expect(lowFallbackMarkings.geometry.index?.count).toBe(6);
    expect(highMarkings.geometry.index?.count).toBe(36);
    lowMarkings.geometry.computeBoundingBox();
    const lowBounds = lowMarkings.geometry.boundingBox;
    expect(lowBounds).not.toBeNull();
    expect((lowBounds?.max.x ?? 0) - (lowBounds?.min.x ?? 0)).toBeCloseTo(1, 6);
    expect((lowBounds?.max.y ?? 0) - (lowBounds?.min.y ?? 0)).toBeCloseTo(0, 6);
    expect((lowBounds?.max.z ?? 0) - (lowBounds?.min.z ?? 0)).toBeCloseTo(1, 6);

    const lowMaterial = lowMarkings.material;
    expect(lowMaterial).toBeInstanceOf(MeshBasicMaterial);
    if (!(lowMaterial instanceof MeshBasicMaterial)) {
      throw new Error('Expected a basic low-quality road-marking material');
    }
    expect(lowMaterial.color.getHex()).toBe(0xffd66b);
    expect(lowMaterial.toneMapped).toBe(true);
    expect(lowFallbackMarkings.material).toBeInstanceOf(MeshBasicMaterial);
    const highMaterial = highMarkings.material;
    expect(highMaterial).toBeInstanceOf(MeshStandardMaterial);
    if (!(highMaterial instanceof MeshStandardMaterial)) {
      throw new Error('Expected the authored high-quality marking material');
    }
    expect(highMaterial.color.getHex()).toBe(0xffd66b);
    expect(highMaterial.emissive.getHex()).toBe(0x6d4817);
    expect(highMaterial.emissiveIntensity).toBe(0.12);

    expect(low.roadMaterial).toBeInstanceOf(MeshLambertMaterial);
    expect(lowFallback.roadMaterial).toBeInstanceOf(MeshLambertMaterial);
    expect(low.roadMaterial.color.getHex()).toBe(0x26313b);
    expect(high.roadMaterial).toBeInstanceOf(MeshStandardMaterial);
    const lowRoads = low.root.getObjectByName('city-roads');
    const lowFallbackRoads = lowFallback.root.getObjectByName('city-roads');
    const highRoads = high.root.getObjectByName('city-roads');
    expect(lowRoads).not.toBe(low.root.getObjectByName('city-buildings-low-quality'));
    expect(lowRoads).toBeInstanceOf(InstancedMesh);
    expect(lowFallbackRoads).toBeInstanceOf(InstancedMesh);
    expect(highRoads).toBeInstanceOf(InstancedMesh);
    if (
      !(lowRoads instanceof InstancedMesh)
      || !(lowFallbackRoads instanceof InstancedMesh)
      || !(highRoads instanceof InstancedMesh)
    ) {
      throw new Error('Expected top-only low and authored fallback road carriers');
    }
    expect(lowRoads.material).toBeInstanceOf(MeshBasicMaterial);
    expect(lowRoads.geometry.index?.count).toBe(6);
    expect(lowFallbackRoads.material).toBe(lowFallback.roadMaterial);
    expect(highRoads.material).toBe(high.roadMaterial);
    const roadStartIndex = 0;
    expect(lowRoads.userData.roadStartIndex).toBe(roadStartIndex);
    expect(lowRoads.userData.roadInstanceCount).toBe(lowLayout.roads.length);
    const lowRoadMatrix = new Matrix4();
    const fallbackRoadMatrix = new Matrix4();
    const roadColor = new Color();
    lowLayout.roads.forEach((_road, index) => {
      lowRoads.getMatrixAt(roadStartIndex + index, lowRoadMatrix);
      lowFallbackRoads.getMatrixAt(index, fallbackRoadMatrix);
      expect(lowRoadMatrix.elements[0]).toBeCloseTo(fallbackRoadMatrix.elements[0]!, 6);
      expect(lowRoadMatrix.elements[10]).toBeCloseTo(fallbackRoadMatrix.elements[10]!, 6);
      expect(lowRoadMatrix.elements[12]).toBeCloseTo(fallbackRoadMatrix.elements[12]!, 6);
      expect(lowRoadMatrix.elements[13]).toBeCloseTo(
        (fallbackRoadMatrix.elements[13] ?? 0) + 0.05,
        6,
      );
      expect(lowRoadMatrix.elements[14]).toBeCloseTo(fallbackRoadMatrix.elements[14]!, 6);
      lowRoads.getColorAt(roadStartIndex + index, roadColor);
      expect(roadColor.getHex()).toBe(0x26313b);
    });
    const groundColor = new Color();
    const groundStartIndex = lowLayout.roads.length * 3;
    lowRoads.getColorAt(groundStartIndex, groundColor);
    const stableGroundColor = groundColor.getHex();
    low.setRoadColor(new Color(0x141c24));
    lowLayout.roads.forEach((_road, index) => {
      lowRoads.getColorAt(roadStartIndex + index, roadColor);
      expect(roadColor.getHex()).toBe(0x141c24);
    });
    lowRoads.getColorAt(groundStartIndex, groundColor);
    expect(groundColor.getHex()).toBe(stableGroundColor);
    low.setRoadColor(new Color(0x26313b));
    lowLayout.roads.forEach((_road, index) => {
      lowRoads.getColorAt(roadStartIndex + index, roadColor);
      expect(roadColor.getHex()).toBe(0x26313b);
    });
    const lowOcean = low.root.getObjectByName('city-ocean');
    const highOcean = high.root.getObjectByName('city-ocean');
    expect(lowOcean).toBeInstanceOf(Mesh);
    expect(highOcean).toBeInstanceOf(Mesh);
    if (!(lowOcean instanceof Mesh) || !(highOcean instanceof Mesh)) {
      throw new Error('Expected low- and high-quality ocean meshes');
    }
    expect(lowOcean.material).toBeInstanceOf(MeshLambertMaterial);
    expect(highOcean.material).toBeInstanceOf(MeshStandardMaterial);
    const lowOceanMaterial = lowOcean.material as MeshLambertMaterial;
    const highOceanMaterial = highOcean.material as MeshStandardMaterial;
    expect(lowOceanMaterial.color.getHex()).toBe(0x197c9b);
    expect(lowOceanMaterial.transparent).toBe(true);
    expect(lowOceanMaterial.opacity).toBe(0.9);
    expect(lowOceanMaterial.fog).toBe(true);
    expect(highOceanMaterial.color.getHex()).toBe(0x197c9b);
    expect(highOceanMaterial.transparent).toBe(true);
    expect(highOceanMaterial.opacity).toBe(0.9);
    expect(highOceanMaterial.roughness).toBe(0.25);
    expect(highOceanMaterial.metalness).toBe(0.05);

    const actualMatrix = new Matrix4();
    const expectedDummy = new Object3D();
    let markingIndex = 0;
    for (const road of lowLayout.roads) {
      const vertical = road.depth > road.width;
      const length = vertical ? road.depth : road.width;
      const dashCount = Math.floor(length / 28);
      for (let dash = 0; dash < dashCount; dash += 1) {
        const along = -length / 2 + 14 + dash * 28;
        const x = road.position.x + (vertical ? 0 : along);
        const z = road.position.z + (vertical ? along : 0);
        lowMarkings.getMatrixAt(markingIndex, actualMatrix);
        const expectedMatrix = composeMatrixForTest(
          expectedDummy,
          x,
          0.105,
          z,
          vertical ? 0.18 : 7.5,
          0.025,
          vertical ? 7.5 : 0.18,
        );
        expectedMatrix.elements.forEach((value, elementIndex) => {
          expect(actualMatrix.elements[elementIndex]).toBeCloseTo(value, 6);
        });
        markingIndex += 1;
      }
    }
    expect(markingIndex).toBe(expectedCount);

    low.dispose();
    lowFallback.dispose();
    high.dispose();
  });

  it('disposes each shared GPU resource and resident instance exactly once', () => {
    const layout = generateCity('visual-disposal', 'low');
    const activeCellId = contentCellIds(layout)[0];
    expect(activeCellId).toBeDefined();
    if (!activeCellId) {
      throw new Error('Expected at least one city content cell');
    }
    const visuals = createCityVisuals(layout);
    visuals.applyStreamingState(
      [activeCellId],
      [activeCellId],
      FULL_DENSITY,
    );
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    const instances = new Set<InstancedMesh>();
    visuals.root.traverse((object) => {
      if (!(object instanceof Mesh)) {
        return;
      }
      geometries.add(object.geometry);
      if (Array.isArray(object.material)) {
        object.material.forEach((material) => materials.add(material));
      } else {
        materials.add(object.material);
      }
      if (object instanceof InstancedMesh) {
        instances.add(object);
      }
    });
    let resourceDisposeEvents = 0;
    let instanceDisposeEvents = 0;
    for (const resource of [...geometries, ...materials]) {
      resource.addEventListener('dispose', () => {
        resourceDisposeEvents += 1;
      });
    }
    for (const instance of instances) {
      instance.addEventListener('dispose', () => {
        instanceDisposeEvents += 1;
      });
    }

    visuals.dispose();
    visuals.dispose();

    expect(resourceDisposeEvents).toBe(geometries.size + materials.size);
    expect(instanceDisposeEvents).toBe(instances.size);
    expect(visuals.root.children).toHaveLength(0);
    expect(() =>
      visuals.applyStreamingState([], [], FULL_DENSITY),
    ).toThrow(/disposed/);
  });

  it('validates both cell sets and density before mutating residency', () => {
    const layout = generateCity('visual-validation', 'low');
    const activeCellId = contentCellIds(layout)[0];
    expect(activeCellId).toBeDefined();
    if (!activeCellId) {
      throw new Error('Expected at least one city content cell');
    }
    const visuals = createCityVisuals(layout);

    expect(() =>
      visuals.applyStreamingState(
        ['invalid-cell' as CellId],
        [activeCellId],
        FULL_DENSITY,
      ),
    ).toThrow(/Invalid cell id/);
    expect(() =>
      visuals.applyStreamingState(
        [activeCellId],
        ['invalid-cell' as CellId],
        FULL_DENSITY,
      ),
    ).toThrow(/Invalid cell id/);
    expect(() =>
      visuals.applyStreamingState(
        [activeCellId],
        [activeCellId],
        { ...FULL_DENSITY, props: 1.1 },
      ),
    ).toThrow(/prop density/);
    expect(payloadRoots(visuals.root)).toHaveLength(0);
    expect(visuals.root.getObjectByName('city-roads')?.visible).toBe(true);

    visuals.dispose();
  });
});
