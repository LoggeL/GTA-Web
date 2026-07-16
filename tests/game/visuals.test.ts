import {
  InstancedMesh,
  Mesh,
} from 'three';
import type { BufferAttribute, BufferGeometry, Group, Material } from 'three';
import { describe, expect, it } from 'vitest';

import { generateCity } from '../../src/game/city';
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
