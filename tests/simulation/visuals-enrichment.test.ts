import {
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix3,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Scene,
  Vector3,
} from 'three';
import type { BufferAttribute, BufferGeometry, Material } from 'three';
import { describe, expect, it } from 'vitest';

import type { VehicleClassId } from '../../src/data/types';
import { COMBAT_CAPACITY } from '../../src/simulation/combat';
import { PEDESTRIAN_CAPACITY } from '../../src/simulation/pedestrians';
import { TRAFFIC_CAPACITY } from '../../src/simulation/traffic';
import type {
  CitySimulationSnapshot,
  CombatantSnapshot,
  PedestrianSnapshot,
  TrafficVehicleSnapshot,
} from '../../src/simulation/types';
import { SimulationVisualLayer } from '../../src/simulation/visuals';

const TRAFFIC: TrafficVehicleSnapshot = {
  id: 'traffic-visual-00',
  classId: 'sports',
  position: { x: 4, y: 0, z: -3 },
  heading: 0.35,
  speed: 9,
  behavior: 'cruise',
  roadId: 'road-visual',
  panicRemaining: 0,
};

const PEDESTRIAN: PedestrianSnapshot = {
  id: 'pedestrian-visual-00',
  position: { x: -2, y: 0, z: 6 },
  heading: -0.4,
  speed: 1.4,
  behavior: 'wander',
  pendingCrimeId: null,
  motion: { kind: 'grounded' },
};

const COMBATANT: CombatantSnapshot = {
  id: 'combatant-visual-00',
  role: 'gunner',
  position: { x: 8, y: 0, z: 2 },
  heading: 0.8,
  health: 70,
  maxHealth: 100,
  behavior: 'patrol',
  alertness: 0.2,
};

const VEHICLE_CLASSES: readonly VehicleClassId[] = [
  'compact',
  'sedan',
  'muscle',
  'sports',
  'van',
  'pickup',
  'police-cruiser',
  'motorcycle',
];
const MULTI_DRAW_CAPABILITIES = Object.freeze({ supportsMultiDraw: true });

function snapshot(
  simulationTime = 0,
  traffic: readonly TrafficVehicleSnapshot[] = [TRAFFIC],
  pedestrians: readonly PedestrianSnapshot[] = [PEDESTRIAN],
  combatants: readonly CombatantSnapshot[] = [COMBATANT],
  quality: 'low' | 'high' = 'high',
): CitySimulationSnapshot {
  return {
    simulationTime,
    quality,
    traffic,
    pedestrians,
    combatants,
    actorLimits: {
      traffic: traffic.length,
      pedestrians: pedestrians.length,
      combat: combatants.length,
    },
    poolCapacity: {
      traffic: TRAFFIC_CAPACITY.high,
      pedestrians: PEDESTRIAN_CAPACITY.high,
      combatants: COMBAT_CAPACITY.high,
    },
    lastCrimeId: null,
  };
}

function namedMesh(layer: SimulationVisualLayer, name: string): InstancedMesh {
  const object = layer.root.getObjectByName(name);
  if (!(object instanceof InstancedMesh)) {
    throw new Error(`Missing instanced mesh ${name}`);
  }
  return object;
}

function namedMergedMesh(layer: SimulationVisualLayer, name: string): Mesh {
  const object = layer.root.getObjectByName(name);
  if (!(object instanceof Mesh) || object instanceof InstancedMesh) {
    throw new Error(`Missing merged mesh ${name}`);
  }
  return object;
}

function instanceMatrix(mesh: InstancedMesh, index = 0): Matrix4 {
  const matrix = new Matrix4();
  mesh.getMatrixAt(index, matrix);
  return matrix;
}

function instanceScale(mesh: InstancedMesh, index = 0): Vector3 {
  return new Vector3().setFromMatrixScale(instanceMatrix(mesh, index));
}

function instancePosition(mesh: InstancedMesh, index = 0): Vector3 {
  return new Vector3().setFromMatrixPosition(instanceMatrix(mesh, index));
}

function matrixElements(mesh: InstancedMesh, index = 0): readonly number[] {
  return [...instanceMatrix(mesh, index).elements];
}

function highActorMeshes(layer: SimulationVisualLayer): InstancedMesh[] {
  return layer.root.children.filter((child): child is InstancedMesh => (
    child instanceof InstancedMesh && !child.name.startsWith('low-quality-')
  ));
}

function lowActorMeshes(layer: SimulationVisualLayer): Mesh[] {
  return layer.root.children.filter((child): child is Mesh => (
    child instanceof Mesh
    && !(child instanceof InstancedMesh)
    && child.name.startsWith('low-quality-')
  ));
}

function rounded(value: number): string {
  return (Math.abs(value) < 0.000_5 ? 0 : value).toFixed(3);
}

/** Observable render output: every drawn vertex, world normal, and effective base color. */
function renderedVertexSignatures(meshes: readonly Mesh[]): string[] {
  const matrix = new Matrix4();
  const normalMatrix = new Matrix3();
  const scale = new Vector3();
  const point = new Vector3();
  const normal = new Vector3();
  const instanceColor = new Color();
  const signatures: string[] = [];
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute('position');
    const normals = mesh.geometry.getAttribute('normal');
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const materialColor = material && 'color' in material && material.color instanceof Color
      ? material.color
      : new Color(0xffffff);
    if (mesh instanceof InstancedMesh) {
      const sourceIndex = mesh.geometry.index;
      const renderedVertexCount = sourceIndex?.count ?? position.count;
      for (let instance = 0; instance < mesh.count; instance += 1) {
        mesh.getMatrixAt(instance, matrix);
        scale.setFromMatrixScale(matrix);
        if (scale.lengthSq() < 0.000_000_01) continue;
        normalMatrix.getNormalMatrix(matrix);
        instanceColor.set(0xffffff);
        if (mesh.instanceColor) mesh.getColorAt(instance, instanceColor);
        const red = materialColor.r * instanceColor.r;
        const green = materialColor.g * instanceColor.g;
        const blue = materialColor.b * instanceColor.b;
        for (let renderedVertex = 0; renderedVertex < renderedVertexCount; renderedVertex += 1) {
          const vertex = sourceIndex?.getX(renderedVertex) ?? renderedVertex;
          point.fromBufferAttribute(position, vertex).applyMatrix4(matrix);
          normal.fromBufferAttribute(normals, vertex).applyNormalMatrix(normalMatrix);
          signatures.push([
            rounded(point.x),
            rounded(point.y),
            rounded(point.z),
            rounded(normal.x),
            rounded(normal.y),
            rounded(normal.z),
            rounded(red),
            rounded(green),
            rounded(blue),
          ].join(':'));
        }
      }
      continue;
    }
    const colors = mesh.geometry.getAttribute('color');
    const start = mesh.geometry.drawRange.start;
    const count = mesh.geometry.drawRange.count;
    mesh.updateMatrixWorld(true);
    normalMatrix.getNormalMatrix(mesh.matrixWorld);
    for (let vertex = start; vertex < start + count; vertex += 1) {
      point.fromBufferAttribute(position, vertex).applyMatrix4(mesh.matrixWorld);
      normal.fromBufferAttribute(normals, vertex).applyNormalMatrix(normalMatrix);
      const red = materialColor.r * colors.getX(vertex);
      const green = materialColor.g * colors.getY(vertex);
      const blue = materialColor.b * colors.getZ(vertex);
        signatures.push([
          rounded(point.x),
          rounded(point.y),
          rounded(point.z),
          rounded(normal.x),
          rounded(normal.y),
          rounded(normal.z),
          rounded(red),
          rounded(green),
          rounded(blue),
        ].join(':'));
    }
  }
  return signatures.sort();
}

function stableStringHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function pedestrianIdFor(
  label: string,
  predicate: (hash: number) => boolean,
): string {
  const id = Array.from({ length: 500 }, (_, index) => `${label}-${index}`)
    .find((candidate) => predicate(stableStringHash(candidate)));
  if (!id) throw new Error(`Unable to find deterministic pedestrian style ${label}`);
  return id;
}

describe('enriched pooled simulation visuals', () => {
  it('builds named fixed-capacity layers for readable vehicles, pedestrians, and combatants', () => {
    const scene = new Scene();
    const layer = new SimulationVisualLayer(scene, MULTI_DRAW_CAPABILITIES);
    layer.update(snapshot());

    const expectedNames = [
      'traffic-body-shells',
      'traffic-cabins',
      'traffic-hoods',
      'traffic-rear-decks',
      'traffic-bumpers',
      'traffic-wheels',
      'traffic-wheel-hubs',
      'traffic-headlights',
      'traffic-taillights',
      'traffic-police-red-lights',
      'traffic-police-blue-lights',
      'pedestrian-torsos',
      'pedestrian-legs',
      'pedestrian-arms',
      'pedestrian-heads',
      'pedestrian-hair',
      'pedestrian-hats',
      'pedestrian-backpacks',
      'combatant-torsos',
      'combatant-legs',
      'combatant-arms',
      'combatant-heads',
      'combatant-role-gear',
      'combatant-weapons',
    ] as const;
    const expectedLowNames = [
      'low-quality-actors-merged',
    ] as const;

    expect(layer.root.name).toBe('city-simulation-visuals');
    expect(layer.root.children).toHaveLength(expectedNames.length + expectedLowNames.length);
    expect(layer.root.children.filter((child) => child instanceof InstancedMesh))
      .toHaveLength(expectedNames.length);
    for (const name of expectedNames) {
      const mesh = namedMesh(layer, name);
      expect(mesh.instanceMatrix.usage).toBe(DynamicDrawUsage);
      expect(mesh.material).toBeInstanceOf(MeshStandardMaterial);
    }
    for (const name of expectedLowNames) {
      const mesh = namedMergedMesh(layer, name);
      expect(mesh.visible).toBe(false);
      expect(mesh.frustumCulled).toBe(false);
      expect(mesh.castShadow).toBe(false);
      expect(mesh.receiveShadow).toBe(false);
      expect(mesh.geometry.drawRange.count).toBe(0);
      expect((mesh.geometry.getAttribute('position') as BufferAttribute).usage)
        .toBe(DynamicDrawUsage);
      expect((mesh.geometry.getAttribute('normal') as BufferAttribute).usage)
        .toBe(DynamicDrawUsage);
      expect((mesh.geometry.getAttribute('color') as BufferAttribute).usage)
        .toBe(DynamicDrawUsage);
      expect(mesh.material).toBeInstanceOf(MeshLambertMaterial);
      expect('vertexColors' in mesh.material && mesh.material.vertexColors).toBe(true);
    }

    expect(namedMesh(layer, 'traffic-body-shells').count).toBe(TRAFFIC_CAPACITY.high);
    expect(namedMesh(layer, 'traffic-wheels').count).toBe(TRAFFIC_CAPACITY.high * 4);
    expect(namedMesh(layer, 'traffic-wheel-hubs').count).toBe(TRAFFIC_CAPACITY.high * 4);
    expect(namedMesh(layer, 'traffic-headlights').count).toBe(TRAFFIC_CAPACITY.high * 2);
    expect(namedMesh(layer, 'pedestrian-torsos').count).toBe(PEDESTRIAN_CAPACITY.high);
    expect(namedMesh(layer, 'pedestrian-legs').count).toBe(PEDESTRIAN_CAPACITY.high * 2);
    expect(namedMesh(layer, 'pedestrian-arms').count).toBe(PEDESTRIAN_CAPACITY.high * 2);
    expect(namedMesh(layer, 'combatant-torsos').count).toBe(COMBAT_CAPACITY.high);
    expect(namedMesh(layer, 'combatant-legs').count).toBe(COMBAT_CAPACITY.high * 2);
    expect(namedMesh(layer, 'combatant-arms').count).toBe(COMBAT_CAPACITY.high * 2);

    expect(instanceScale(namedMesh(layer, 'traffic-body-shells')).length()).toBeGreaterThan(0);
    expect(instanceScale(namedMesh(layer, 'pedestrian-torsos')).length()).toBeGreaterThan(0);
    expect(instanceScale(namedMesh(layer, 'combatant-torsos')).length()).toBeGreaterThan(0);
    expect(instanceScale(namedMesh(layer, 'traffic-body-shells'), 1).length()).toBe(0);
    expect(instanceScale(namedMesh(layer, 'pedestrian-torsos'), 1).length()).toBe(0);
    expect(instanceScale(namedMesh(layer, 'combatant-torsos'), 1).length()).toBe(0);

    layer.dispose();
  });

  it('collapses low quality to one exact merged draw without changing geometry, normals, colors, or poses', () => {
    const scene = new Scene();
    const layer = new SimulationVisualLayer(scene, MULTI_DRAW_CAPABILITIES);
    const traffic = VEHICLE_CLASSES.map((classId, index) => ({
      ...TRAFFIC,
      id: `traffic-parity-${classId}`,
      classId,
      position: { x: index * 7 - 21, y: 0, z: index * -5 + 16 },
      heading: index * 0.37 - 0.8,
    }));
    const pedestrians: PedestrianSnapshot[] = [
      {
        ...PEDESTRIAN,
        id: pedestrianIdFor('hair-style', (hash) => hash % 7 !== 0 && hash % 6 !== 0),
        behavior: 'wander',
        position: { x: -8, y: 0, z: 12 },
      },
      {
        ...PEDESTRIAN,
        id: pedestrianIdFor('hat-style', (hash) => hash % 7 === 0),
        behavior: 'flee',
        speed: 3.4,
        position: { x: -3, y: 0, z: 11 },
      },
      {
        ...PEDESTRIAN,
        id: pedestrianIdFor('backpack-style', (hash) => hash % 5 === 0),
        behavior: 'witness-report',
        speed: 0,
        pendingCrimeId: 'crime-parity',
        position: { x: 3, y: 0, z: 10 },
      },
      {
        ...PEDESTRIAN,
        id: 'comedic-tumble-parity',
        behavior: 'flee',
        speed: 0,
        position: { x: 8, y: 2.1, z: 9 },
        motion: {
          kind: 'comedic-tumble',
          pitchRadians: 1.35,
          rollRadians: -0.72,
          flailPhaseRadians: 2.4,
          impactSpeed: 16,
        },
      },
    ];
    const combatants: CombatantSnapshot[] = [
      { ...COMBATANT, id: 'combat-patrol', role: 'brawler', behavior: 'patrol' },
      {
        ...COMBATANT,
        id: 'combat-engage',
        role: 'gunner',
        behavior: 'engage',
        position: { x: 12, y: 0, z: 2 },
      },
      {
        ...COMBATANT,
        id: 'combat-flee',
        role: 'heavy',
        behavior: 'flee',
        position: { x: 16, y: 0, z: 5 },
      },
      {
        ...COMBATANT,
        id: 'combat-defeated',
        role: 'marksman',
        behavior: 'defeated',
        health: 0,
        position: { x: 20, y: 0, z: 8 },
      },
    ];
    const highSnapshot = snapshot(0.4, traffic, pedestrians, combatants, 'high');
    layer.update(highSnapshot);
    const highSignatures = renderedVertexSignatures(highActorMeshes(layer));

    layer.update(snapshot(0.4, traffic, pedestrians, combatants, 'low'));
    expect(lowActorMeshes(layer).filter((mesh) => mesh.visible)).toHaveLength(1);
    expect(highActorMeshes(layer).filter((mesh) => mesh.visible)).toHaveLength(0);
    const lowSignatures = renderedVertexSignatures(lowActorMeshes(layer));
    expect(lowSignatures).toEqual(highSignatures);
    expect(lowActorMeshes(layer).reduce(
      (total, mesh) => total + mesh.geometry.drawRange.count,
      0,
    )).toBe(highSignatures.length);

    layer.update(highSnapshot);
    expect(highActorMeshes(layer).filter((mesh) => mesh.visible)).toHaveLength(24);
    expect(lowActorMeshes(layer).filter((mesh) => mesh.visible)).toHaveLength(0);
    layer.dispose();
  });

  it('uses the same one-draw low path when multi-draw is unavailable', () => {
    const scene = new Scene();
    const layer = new SimulationVisualLayer(scene, { supportsMultiDraw: false });
    layer.update(snapshot(0.4, [TRAFFIC], [PEDESTRIAN], [COMBATANT], 'low'));

    expect(layer.root.children).toHaveLength(25);
    expect(lowActorMeshes(layer).filter((mesh) => mesh.visible)).toHaveLength(1);
    expect(highActorMeshes(layer).filter((mesh) => mesh.visible)).toHaveLength(0);
    expect(renderedVertexSignatures(lowActorMeshes(layer)).length).toBeGreaterThan(0);

    layer.dispose();
  });

  it('updates every high-quality slot at the production actor ceilings', () => {
    expect(TRAFFIC_CAPACITY.high).toBe(42);
    expect(PEDESTRIAN_CAPACITY.high).toBe(72);
    expect(COMBAT_CAPACITY.high).toBe(20);
    const traffic = Array.from({ length: TRAFFIC_CAPACITY.high }, (_, index) => ({
      ...TRAFFIC,
      id: `traffic-capacity-${index}`,
      classId: VEHICLE_CLASSES[index % VEHICLE_CLASSES.length] ?? 'sedan',
      position: { x: index * 3, y: 0, z: index * -2 },
      heading: index * 0.07,
    }));
    const pedestrians = Array.from({ length: PEDESTRIAN_CAPACITY.high }, (_, index) => ({
      ...PEDESTRIAN,
      id: `pedestrian-capacity-${index}`,
      position: { x: index * -1.2, y: 0, z: index * 1.4 },
      heading: index * -0.05,
      behavior: index % 3 === 0 ? 'flee' as const : 'wander' as const,
    }));
    const combatants = Array.from({ length: COMBAT_CAPACITY.high }, (_, index) => ({
      ...COMBATANT,
      id: `combatant-capacity-${index}`,
      position: { x: index * 2, y: 0, z: index * 2.5 },
      heading: index * 0.11,
      role: index % 2 === 0 ? 'heavy' as const : 'gunner' as const,
    }));
    const scene = new Scene();
    const layer = new SimulationVisualLayer(scene);

    expect(() => layer.update(
      snapshot(3.2, traffic, pedestrians, combatants, 'high'),
    )).not.toThrow();
    expect(instanceScale(
      namedMesh(layer, 'traffic-body-shells'),
      TRAFFIC_CAPACITY.high - 1,
    ).length()).toBeGreaterThan(0);
    expect(instanceScale(
      namedMesh(layer, 'traffic-wheels'),
      (TRAFFIC_CAPACITY.high - 1) * 4 + 3,
    ).length()).toBeGreaterThan(0);
    expect(instanceScale(
      namedMesh(layer, 'pedestrian-torsos'),
      PEDESTRIAN_CAPACITY.high - 1,
    ).length()).toBeGreaterThan(0);
    expect(instanceScale(
      namedMesh(layer, 'pedestrian-arms'),
      (PEDESTRIAN_CAPACITY.high - 1) * 2 + 1,
    ).length()).toBeGreaterThan(0);
    expect(instanceScale(
      namedMesh(layer, 'combatant-torsos'),
      COMBAT_CAPACITY.high - 1,
    ).length()).toBeGreaterThan(0);
    expect(instanceScale(
      namedMesh(layer, 'combatant-legs'),
      (COMBAT_CAPACITY.high - 1) * 2 + 1,
    ).length()).toBeGreaterThan(0);
    layer.dispose();
  });

  it('compacts empty, one-actor, and full low pools without stale vertices', () => {
    const scene = new Scene();
    const layer = new SimulationVisualLayer(scene);
    const merged = () => lowActorMeshes(layer);

    layer.update(snapshot(0, [], [], [], 'low'));
    expect(merged().map((mesh) => mesh.geometry.drawRange.count)).toEqual([0]);
    expect(renderedVertexSignatures(merged())).toEqual([]);

    layer.update(snapshot(0.2, [TRAFFIC], [PEDESTRIAN], [COMBATANT], 'low'));
    const oneActorCounts = merged().map((mesh) => mesh.geometry.drawRange.count);
    expect(oneActorCounts.every((count) => count > 0)).toBe(true);

    const traffic = Array.from({ length: TRAFFIC_CAPACITY.low }, (_, index) => ({
      ...TRAFFIC,
      id: `traffic-low-capacity-${index}`,
      classId: VEHICLE_CLASSES[index % VEHICLE_CLASSES.length] ?? 'sedan',
      position: { x: index * 4, y: 0, z: index * -3 },
      heading: index * 0.13,
    }));
    const pedestrians = Array.from({ length: PEDESTRIAN_CAPACITY.low }, (_, index) => ({
      ...PEDESTRIAN,
      id: `pedestrian-low-capacity-${index}`,
      position: { x: index * -1.4, y: 0, z: index * 1.1 },
      behavior: index % 3 === 0 ? 'flee' as const : 'wander' as const,
    }));
    const combatants = Array.from({ length: COMBAT_CAPACITY.low }, (_, index) => ({
      ...COMBATANT,
      id: `combatant-low-capacity-${index}`,
      role: index % 2 === 0 ? 'heavy' as const : 'gunner' as const,
      position: { x: index * 2.2, y: 0, z: index * 2.6 },
    }));
    layer.update(snapshot(1.2, traffic, pedestrians, combatants, 'low'));
    const fullCounts = merged().map((mesh) => mesh.geometry.drawRange.count);
    expect(fullCounts.every((count, index) => count > (oneActorCounts[index] ?? 0))).toBe(true);
    for (const mesh of merged()) {
      expect(mesh.geometry.drawRange.count)
        .toBeLessThanOrEqual(mesh.geometry.getAttribute('position').count);
    }

    const pedestrianOnly = snapshot(1.25, [], [pedestrians[0] ?? PEDESTRIAN], [], 'high');
    layer.update(pedestrianOnly);
    const pedestrianOnlySignatures = renderedVertexSignatures(highActorMeshes(layer));
    layer.update({ ...pedestrianOnly, quality: 'low' });
    expect(renderedVertexSignatures(merged())).toEqual(pedestrianOnlySignatures);
    expect(merged()[0]?.geometry.drawRange.count).toBeLessThan(fullCounts[0] ?? 0);

    layer.update(snapshot(1.2, [TRAFFIC], [PEDESTRIAN], [COMBATANT], 'high'));
    expect(merged().every((mesh) => !mesh.visible)).toBe(true);
    layer.update(snapshot(1.3, [], [], [], 'low'));
    expect(merged().map((mesh) => mesh.geometry.drawRange.count)).toEqual([0]);
    expect(renderedVertexSignatures(merged())).toEqual([]);
    layer.dispose();
  });

  it('uses distinct class silhouettes, two-wheel motorcycle anatomy, and police lighting', () => {
    const scene = new Scene();
    const layer = new SimulationVisualLayer(scene);
    const cabins = namedMesh(layer, 'traffic-cabins');
    const wheels = namedMesh(layer, 'traffic-wheels');
    const policeRed = namedMesh(layer, 'traffic-police-red-lights');

    layer.update(snapshot(0, [{ ...TRAFFIC, classId: 'sports' }], [], []));
    const sportsCabinScale = instanceScale(cabins);
    expect(instanceScale(policeRed).length()).toBe(0);

    layer.update(snapshot(0, [{ ...TRAFFIC, classId: 'van' }], [], []));
    const vanCabinScale = instanceScale(cabins);
    expect(vanCabinScale.y).toBeGreaterThan(sportsCabinScale.y * 2);
    expect(vanCabinScale.z).toBeGreaterThan(sportsCabinScale.z);

    layer.update(snapshot(0, [{ ...TRAFFIC, classId: 'motorcycle' }], [], []));
    expect(instanceScale(wheels, 0).length()).toBeGreaterThan(0);
    expect(instanceScale(wheels, 1).length()).toBeGreaterThan(0);
    expect(instanceScale(wheels, 2).length()).toBe(0);
    expect(instanceScale(wheels, 3).length()).toBe(0);

    layer.update(snapshot(0, [{ ...TRAFFIC, classId: 'police-cruiser' }], [], []));
    expect(instanceScale(policeRed).length()).toBeGreaterThan(0);
    expect(instanceScale(namedMesh(layer, 'traffic-police-blue-lights')).length()).toBeGreaterThan(0);

    const bodyColor = new Color();
    namedMesh(layer, 'traffic-body-shells').getColorAt(0, bodyColor);
    expect(bodyColor.getHex()).toBe(0xe7edf2);
    layer.dispose();
  });

  it('keeps fronts on local -Z, lamps on their correct ends, and carried gear behind actors', () => {
    const scene = new Scene();
    const layer = new SimulationVisualLayer(scene);
    const vehicle = {
      ...TRAFFIC,
      classId: 'sedan' as const,
      position: { x: 10, y: 0, z: 20 },
      heading: 0,
    };
    const backpackId = Array.from(
      { length: 100 },
      (_, index) => `pedestrian-backpack-${index}`,
    ).find((id) => stableStringHash(id) % 5 === 0);
    if (!backpackId) throw new Error('Expected a deterministic backpack identity');
    const pedestrian = {
      ...PEDESTRIAN,
      id: backpackId,
      position: { x: -5, y: 0, z: 8 },
      heading: 0,
    };
    const combatant = {
      ...COMBATANT,
      position: { x: 4, y: 0, z: -6 },
      heading: 0,
      behavior: 'engage' as const,
    };
    layer.update(snapshot(0.4, [vehicle], [pedestrian], [combatant]));

    const body = instancePosition(namedMesh(layer, 'traffic-body-shells'));
    const hood = instancePosition(namedMesh(layer, 'traffic-hoods'));
    const deck = instancePosition(namedMesh(layer, 'traffic-rear-decks'));
    const frontLeft = instancePosition(namedMesh(layer, 'traffic-headlights'), 0);
    const frontRight = instancePosition(namedMesh(layer, 'traffic-headlights'), 1);
    const rearLeft = instancePosition(namedMesh(layer, 'traffic-taillights'), 0);
    const rearRight = instancePosition(namedMesh(layer, 'traffic-taillights'), 1);
    const frontBumper = instancePosition(namedMesh(layer, 'traffic-bumpers'), 0);
    const rearBumper = instancePosition(namedMesh(layer, 'traffic-bumpers'), 1);
    expect(hood.z).toBeLessThan(body.z);
    expect(deck.z).toBeGreaterThan(body.z);
    expect(frontBumper.x).toBeCloseTo(body.x);
    expect(rearBumper.x).toBeCloseTo(body.x);
    expect(frontBumper.z).toBeLessThan(body.z);
    expect(rearBumper.z).toBeGreaterThan(body.z);
    expect(frontLeft.z).toBeLessThan(body.z);
    expect(frontRight.z).toBeLessThan(body.z);
    expect(frontLeft.x).toBeLessThan(body.x);
    expect(frontRight.x).toBeGreaterThan(body.x);
    expect(frontLeft.z).toBeCloseTo(frontRight.z);
    expect(rearLeft.z).toBeGreaterThan(body.z);
    expect(rearRight.z).toBeGreaterThan(body.z);
    expect(rearLeft.x).toBeLessThan(body.x);
    expect(rearRight.x).toBeGreaterThan(body.x);
    expect(rearLeft.z).toBeCloseTo(rearRight.z);
    expect(instancePosition(namedMesh(layer, 'traffic-wheels'), 0).z).toBeLessThan(body.z);
    expect(instancePosition(namedMesh(layer, 'traffic-wheels'), 1).z).toBeLessThan(body.z);
    expect(instancePosition(namedMesh(layer, 'traffic-wheels'), 2).z).toBeGreaterThan(body.z);
    expect(instancePosition(namedMesh(layer, 'traffic-wheels'), 3).z).toBeGreaterThan(body.z);

    const pedestrianTorso = instancePosition(namedMesh(layer, 'pedestrian-torsos'));
    const backpack = instancePosition(namedMesh(layer, 'pedestrian-backpacks'));
    expect(instanceScale(namedMesh(layer, 'pedestrian-backpacks')).length()).toBeGreaterThan(0);
    expect(backpack.z).toBeGreaterThan(pedestrianTorso.z);

    const combatantTorso = instancePosition(namedMesh(layer, 'combatant-torsos'));
    expect(instancePosition(namedMesh(layer, 'combatant-role-gear')).z).toBeGreaterThan(
      combatantTorso.z,
    );
    expect(instancePosition(namedMesh(layer, 'combatant-weapons')).z).toBeLessThan(
      combatantTorso.z,
    );

    layer.update(snapshot(0.4, [{ ...vehicle, heading: Math.PI / 2 }], [], []));
    const turnedBody = instancePosition(namedMesh(layer, 'traffic-body-shells'));
    expect(instancePosition(namedMesh(layer, 'traffic-hoods')).x).toBeLessThan(turnedBody.x);
    expect(instancePosition(namedMesh(layer, 'traffic-rear-decks')).x).toBeGreaterThan(
      turnedBody.x,
    );
    layer.dispose();
  });

  it('never gives brawlers a weapon, including after they are defeated', () => {
    const scene = new Scene();
    const layer = new SimulationVisualLayer(scene);
    const weapons = namedMesh(layer, 'combatant-weapons');
    layer.update(snapshot(0, [], [], [{ ...COMBATANT, role: 'gunner' }]));
    expect(instanceScale(weapons).length()).toBeGreaterThan(0);

    layer.update(snapshot(0, [], [], [{ ...COMBATANT, role: 'brawler' }]));
    expect(instanceScale(weapons).length()).toBe(0);
    layer.update(snapshot(0, [], [], [{
      ...COMBATANT,
      role: 'brawler',
      behavior: 'defeated',
      health: 0,
    }]));
    expect(instanceScale(weapons).length()).toBe(0);
    layer.dispose();
  });

  it('animates deterministic walk, flee, witness, aiming, and defeated poses from snapshots', () => {
    const scene = new Scene();
    const layer = new SimulationVisualLayer(scene);
    const pedestrianLegs = namedMesh(layer, 'pedestrian-legs');
    const pedestrianArms = namedMesh(layer, 'pedestrian-arms');
    const pedestrianTorsos = namedMesh(layer, 'pedestrian-torsos');
    const combatantArms = namedMesh(layer, 'combatant-arms');
    const combatantTorsos = namedMesh(layer, 'combatant-torsos');

    layer.update(snapshot(0.1));
    const earlyWalk = matrixElements(pedestrianLegs);
    layer.update(snapshot(0.45));
    const laterWalk = matrixElements(pedestrianLegs);
    expect(laterWalk).not.toEqual(earlyWalk);

    layer.update(snapshot(0.45));
    expect(matrixElements(pedestrianLegs)).toEqual(laterWalk);

    const wanderArms = matrixElements(pedestrianArms);
    layer.update(snapshot(0.45, [TRAFFIC], [{
      ...PEDESTRIAN,
      behavior: 'witness-report',
      pendingCrimeId: 'crime-visual',
      speed: 0,
    }], [COMBATANT]));
    const witnessArms = matrixElements(pedestrianArms);
    expect(witnessArms).not.toEqual(wanderArms);

    const witnessTorso = matrixElements(pedestrianTorsos);
    layer.update(snapshot(0.45, [TRAFFIC], [{
      ...PEDESTRIAN,
      behavior: 'flee',
      speed: 3.4,
    }], [COMBATANT]));
    expect(matrixElements(pedestrianTorsos)).not.toEqual(witnessTorso);

    const patrolArms = matrixElements(combatantArms);
    layer.update(snapshot(0.45, [TRAFFIC], [PEDESTRIAN], [{
      ...COMBATANT,
      behavior: 'engage',
      alertness: 1,
    }]));
    expect(matrixElements(combatantArms)).not.toEqual(patrolArms);

    const engagedTorso = matrixElements(combatantTorsos);
    const standingTorsoScale = instanceScale(combatantTorsos);
    layer.update(snapshot(0.45, [TRAFFIC], [PEDESTRIAN], [{
      ...COMBATANT,
      behavior: 'defeated',
      health: 0,
    }]));
    expect(matrixElements(combatantTorsos)).not.toEqual(engagedTorso);
    const defeatedTorsoScale = instanceScale(combatantTorsos);
    expect(defeatedTorsoScale.x).toBeCloseTo(standingTorsoScale.x);
    expect(defeatedTorsoScale.y).toBeCloseTo(standingTorsoScale.y);
    expect(defeatedTorsoScale.z).toBeCloseTo(standingTorsoScale.z);
    layer.dispose();
  });

  it('poses the complete pedestrian as one coherent Low/High comedic tumble', () => {
    const scene = new Scene();
    const layer = new SimulationVisualLayer(scene);
    const torsos = namedMesh(layer, 'pedestrian-torsos');
    const heads = namedMesh(layer, 'pedestrian-heads');
    const arms = namedMesh(layer, 'pedestrian-arms');

    layer.update(snapshot(0.2, [], [PEDESTRIAN], [], 'high'));
    const standingTorsoMatrix = matrixElements(torsos);
    const standingHeadDistance = instancePosition(heads).distanceTo(instancePosition(torsos));
    const tumble: PedestrianSnapshot = {
      ...PEDESTRIAN,
      behavior: 'flee',
      speed: 0,
      position: { x: 4, y: 2.2, z: -7 },
      motion: {
        kind: 'comedic-tumble',
        pitchRadians: 1.4,
        rollRadians: -0.78,
        flailPhaseRadians: 2.6,
        impactSpeed: 18,
      },
    };
    const tumbleSnapshot = snapshot(0.2, [], [tumble], [], 'high');
    layer.update(tumbleSnapshot);

    expect(matrixElements(torsos)).not.toEqual(standingTorsoMatrix);
    expect(instancePosition(torsos).y).toBeGreaterThan(2);
    expect(instancePosition(heads).distanceTo(instancePosition(torsos)))
      .toBeCloseTo(standingHeadDistance, 6);
    expect(matrixElements(arms, 0)).not.toEqual(matrixElements(arms, 1));
    const highSignatures = renderedVertexSignatures(highActorMeshes(layer));

    layer.update({ ...tumbleSnapshot, quality: 'low' });
    expect(renderedVertexSignatures(lowActorMeshes(layer))).toEqual(highSignatures);
    layer.dispose();
  });

  it('detaches and disposes every shared geometry and material exactly once', () => {
    const scene = new Scene();
    const layer = new SimulationVisualLayer(scene, MULTI_DRAW_CAPABILITIES);
    layer.update(snapshot());
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    const meshes = new Set<InstancedMesh>();
    for (const child of layer.root.children) {
      if (!(child instanceof Mesh)) continue;
      if (child instanceof InstancedMesh) meshes.add(child);
      geometries.add(child.geometry);
      if (Array.isArray(child.material)) {
        child.material.forEach((material) => materials.add(material));
      } else {
        materials.add(child.material);
      }
    }
    expect(geometries.size).toBeGreaterThanOrEqual(21);
    expect(materials.size).toBeGreaterThanOrEqual(15);

    const geometryDisposals = new Map<BufferGeometry, number>();
    const materialDisposals = new Map<Material, number>();
    const meshDisposals = new Map<InstancedMesh, number>();
    for (const geometry of geometries) {
      geometryDisposals.set(geometry, 0);
      geometry.addEventListener('dispose', () => {
        geometryDisposals.set(geometry, (geometryDisposals.get(geometry) ?? 0) + 1);
      });
    }
    for (const material of materials) {
      materialDisposals.set(material, 0);
      material.addEventListener('dispose', () => {
        materialDisposals.set(material, (materialDisposals.get(material) ?? 0) + 1);
      });
    }
    for (const mesh of meshes) {
      meshDisposals.set(mesh, 0);
      mesh.addEventListener('dispose', () => {
        meshDisposals.set(mesh, (meshDisposals.get(mesh) ?? 0) + 1);
      });
    }

    layer.dispose();
    layer.dispose();
    expect(scene.getObjectByName('city-simulation-visuals')).toBeUndefined();
    expect(layer.root.children).toHaveLength(0);
    expect([...geometryDisposals.values()].every((count) => count === 1)).toBe(true);
    expect([...materialDisposals.values()].every((count) => count === 1)).toBe(true);
    expect([...meshDisposals.values()].every((count) => count === 1)).toBe(true);
  });
});
