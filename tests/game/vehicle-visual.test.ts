import {
  Box3,
  Color,
  DynamicDrawUsage,
  Euler,
  InstancedMesh,
  Matrix3,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Object3D,
  ShaderLib,
  Vector3,
} from 'three';
import type { BufferAttribute, BufferGeometry, Material } from 'three';
import { describe, expect, it } from 'vitest';

import type { VehicleClassId } from '../../src/data';
import { createVehicleState } from '../../src/game/vehicle';
import { VEHICLE_DRIVE_PROFILES } from '../../src/game/vehicleProfiles';
import { VehicleVisual } from '../../src/game/visuals';

const EXPECTED_FEATURE: Readonly<Record<VehicleClassId, string>> = {
  compact: 'vehicle-part:hatch',
  sedan: 'vehicle-part:trunk',
  muscle: 'vehicle-part:power-hood',
  sports: 'vehicle-part:rear-wing',
  van: 'vehicle-part:cargo-box',
  pickup: 'vehicle-part:bed-floor',
  'police-cruiser': 'vehicle-part:lightbar-red',
  motorcycle: 'vehicle-part:fuel-tank',
};

function vehicleWheels(visual: VehicleVisual): Object3D[] {
  const wheels: Object3D[] = [];
  visual.root.traverse((object) => {
    if (object.name.startsWith('vehicle-wheel:')) {
      wheels.push(object);
    }
  });
  return wheels;
}

function vehicleBatches(visual: VehicleVisual): Mesh[] {
  const batches: Mesh[] = [];
  visual.root.traverse((object) => {
    if (object instanceof Mesh && object.name.startsWith('vehicle-batch:')) {
      batches.push(object);
    }
  });
  return batches;
}

function vehiclePartColor(visual: VehicleVisual, partName: string): number {
  const marker = visual.root.getObjectByName(partName);
  const batchName = marker?.userData.vehicleBatchName;
  const batchIndex = marker?.userData.vehicleBatchIndex;
  const batch = typeof batchName === 'string'
    ? visual.root.getObjectByName(batchName)
    : null;
  if (batch instanceof InstancedMesh && Number.isSafeInteger(batchIndex)) {
    const color = new Color();
    batch.getColorAt(batchIndex as number, color);
    return color.getHex();
  }
  const vertexOffset = marker?.userData.vehicleVertexOffset;
  if (!(batch instanceof Mesh) || !Number.isSafeInteger(vertexOffset)) {
    throw new Error(`Missing batched color for ${partName}`);
  }
  const colors = batch.geometry.getAttribute('color');
  const color = new Color();
  color.setRGB(
    colors.getX(vertexOffset as number),
    colors.getY(vertexOffset as number),
    colors.getZ(vertexOffset as number),
  );
  return color.getHex();
}

function rotateX(value: Readonly<Vector3>, angle: number): Vector3 {
  const sine = Math.sin(angle);
  const cosine = Math.cos(angle);
  return new Vector3(
    value.x,
    cosine * value.y - sine * value.z,
    sine * value.y + cosine * value.z,
  );
}

function rotateY(value: Readonly<Vector3>, angle: number): Vector3 {
  const sine = Math.sin(angle);
  const cosine = Math.cos(angle);
  return new Vector3(
    cosine * value.x + sine * value.z,
    value.y,
    -sine * value.x + cosine * value.z,
  );
}

function vectorAt(attribute: BufferAttribute, index: number): Vector3 {
  return new Vector3(
    attribute.getX(index),
    attribute.getY(index),
    attribute.getZ(index),
  );
}

function resources(visual: VehicleVisual): {
  geometries: Set<BufferGeometry>;
  materials: Set<Material>;
} {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  visual.root.traverse((object) => {
    if (!(object instanceof Mesh)) {
      return;
    }
    geometries.add(object.geometry);
    if (Array.isArray(object.material)) {
      object.material.forEach((material) => materials.add(material));
    } else {
      materials.add(object.material);
    }
  });
  return { geometries, materials };
}

describe('class-aware vehicle visuals', () => {
  it('hot-swaps eight named procedural silhouettes on one stable root', () => {
    const visual = new VehicleVisual();
    const stableRoot = visual.root;
    const silhouetteSignatures = new Set<string>();

    for (const profile of VEHICLE_DRIVE_PROFILES) {
      const state = createVehicleState({ x: 0, y: 0.48, z: 0 }, profile.id);
      visual.sync(state, 0);

      expect(visual.root).toBe(stableRoot);
      expect(visual.vehicleClassId).toBe(profile.id);
      expect(visual.vehicleName).toBe(profile.name);
      expect(visual.root.name).toBe(`vehicle:${profile.id}`);
      expect(visual.root.userData.vehicleName).toBe(profile.name);
      expect(visual.root.getObjectByName(EXPECTED_FEATURE[profile.id])).toBeDefined();
      expect(vehicleWheels(visual)).toHaveLength(profile.id === 'motorcycle' ? 2 : 4);
      expect(vehicleBatches(visual)).toHaveLength(profile.id === 'motorcycle' ? 4 : 5);

      const size = new Box3().setFromObject(visual.root).getSize(new Vector3());
      expect(size.x).toBeGreaterThan(0.5);
      expect(size.y).toBeGreaterThan(0.8);
      expect(size.z).toBeGreaterThan(1.8);
      const partNames: string[] = [];
      visual.root.traverse((object) => {
        if (object.name.startsWith('vehicle-part:')) {
          partNames.push(object.name);
        }
      });
      silhouetteSignatures.add([
        size.x.toFixed(3),
        size.y.toFixed(3),
        size.z.toFixed(3),
        ...partNames.sort(),
      ].join('|'));
    }

    expect(silhouetteSignatures.size).toBe(8);
    visual.dispose();
  });

  it('uses one static shader-animated low vehicle draw only on the reduced path', () => {
    const visual = new VehicleVisual('sports', {
      quality: 'low',
      supportsMultiDraw: true,
    });
    const carrier = visual.root.getObjectByName('vehicle-batch:low-vehicle');
    const lowBoxes = visual.root.getObjectByName('vehicle-batch:low-boxes');
    const lowWheels = visual.root.getObjectByName('vehicle-batch:low-wheels');
    expect(carrier).toBeInstanceOf(Mesh);
    expect(carrier).not.toBeInstanceOf(InstancedMesh);
    expect(lowBoxes).toBe(carrier);
    expect(lowWheels).toBe(carrier);
    if (!(carrier instanceof Mesh)) {
      throw new Error('Expected one supported low-quality vehicle carrier');
    }
    expect(
      vehicleBatches(visual)
        .filter((mesh) => mesh.visible)
        .map((mesh) => mesh.name),
    ).toEqual(['vehicle-batch:low-vehicle']);
    const lowVehicleMaterial = carrier.material;
    expect(lowVehicleMaterial).toBeInstanceOf(MeshLambertMaterial);
    if (!(lowVehicleMaterial instanceof MeshLambertMaterial)) {
      throw new Error('Expected one Lambert low-quality vehicle material');
    }
    expect(lowVehicleMaterial.vertexColors).toBe(true);
    expect(lowVehicleMaterial.fog).toBe(true);
    expect(carrier.castShadow).toBe(false);
    expect(carrier.receiveShadow).toBe(true);
    expect(carrier.frustumCulled).toBe(false);
    const positions = carrier.geometry.getAttribute('position');
    const normals = carrier.geometry.getAttribute('normal');
    const colors = carrier.geometry.getAttribute('color');
    const wheelCenters = carrier.geometry.getAttribute('vehicleWheelCenter');
    const wheelRoles = carrier.geometry.getAttribute('vehicleWheelRole');
    expect(positions.count).toBeGreaterThan(0);
    expect(normals.count).toBe(positions.count);
    expect(colors.count).toBe(positions.count);
    expect(colors.usage).toBe(DynamicDrawUsage);
    expect(wheelCenters.count).toBe(positions.count);
    expect(wheelRoles.count).toBe(positions.count);
    expect(wheelRoles.itemSize).toBe(3);
    expect(carrier.userData.partNames).toContain('vehicle-part:wedge-hood');
    expect(carrier.userData.wheelPartNames).toContain('vehicle-wheel:front-left');
    expect(carrier.geometry.boundingBox?.isEmpty()).toBe(false);
    expect(Number.isFinite(carrier.geometry.boundingSphere?.radius)).toBe(true);

    const hood = visual.root.getObjectByName('vehicle-part:wedge-hood');
    const hoodVertexOffset = hood?.userData.vehicleVertexOffset;
    expect(hood?.userData.vehicleBatchName).toBe('vehicle-batch:low-boxes');
    expect(Number.isSafeInteger(hood?.userData.vehicleBatchIndex)).toBe(true);
    expect(Number.isSafeInteger(hoodVertexOffset)).toBe(true);
    expect(vehiclePartColor(visual, 'vehicle-part:wedge-hood')).toBe(0x328ad7);
    expect(wheelRoles.getX(hoodVertexOffset as number)).toBe(0);

    const frontWheel = visual.root.getObjectByName('vehicle-wheel:front-left');
    const tireVertexOffset = frontWheel?.userData.vehicleVertexOffset;
    expect(frontWheel?.userData.vehicleBatchName).toBe('vehicle-batch:low-wheels');
    expect(Number.isSafeInteger(frontWheel?.userData.vehicleBatchIndex)).toBe(true);
    expect(Number.isSafeInteger(tireVertexOffset)).toBe(true);
    expect(wheelRoles.getX(tireVertexOffset as number)).toBe(1);
    expect(wheelRoles.getY(tireVertexOffset as number)).toBe(1);
    expect(wheelRoles.getZ(tireVertexOffset as number))
      .toBeCloseTo(1 / (frontWheel?.userData.radius as number), 6);
    vectorAt(wheelCenters as BufferAttribute, tireVertexOffset as number)
      .toArray()
      .forEach((value, index) => {
        expect(value).toBeCloseTo(frontWheel?.position.toArray()[index] ?? 0, 6);
      });

    const uniformState = lowVehicleMaterial.userData.vehicleWheelUniforms as {
      readonly travel: { value: number };
      readonly steering: { value: number };
    };
    expect(uniformState.travel.value).toBe(0);
    expect(uniformState.steering.value).toBe(0);
    expect(lowVehicleMaterial.customProgramCacheKey())
      .toBe('vehicle-low-merged-wheel-v1');
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: ShaderLib.lambert.vertexShader,
    };
    lowVehicleMaterial.onBeforeCompile(shader as never, {} as never);
    expect(shader.uniforms.vehicleWheelTravel).toBe(uniformState.travel);
    expect(shader.uniforms.vehicleWheelSteering).toBe(uniformState.steering);
    expect(shader.vertexShader).toContain('attribute vec3 vehicleWheelCenter;');
    expect(shader.vertexShader).toContain('attribute vec3 vehicleWheelRole;');
    expect(shader.vertexShader).toContain(
      'vehicleRotateX( vehicleRotateY( value, steer ), spin )',
    );
    expect(shader.vertexShader.match(/#include <beginnormal_vertex>/g)).toHaveLength(1);
    expect(shader.vertexShader.match(/#include <begin_vertex>/g)).toHaveLength(1);

    const positionValues = Array.from(positions.array);
    const normalValues = Array.from(normals.array);
    const colorValues = Array.from(colors.array);
    const positionVersion = positions.version;
    const normalVersion = normals.version;
    const colorVersion = colors.version;
    const state = createVehicleState({ x: 3, y: 0.48, z: -4 }, 'sports');
    state.speed = 11;
    state.steering = 0.5;
    visual.sync(state, 0.25);
    expect(uniformState.travel.value).toBeCloseTo(-2.75);
    expect(uniformState.steering.value).toBe(0.5);
    expect(frontWheel?.rotation.y).toBeCloseTo(-0.18);
    expect(Array.from(positions.array)).toEqual(positionValues);
    expect(Array.from(normals.array)).toEqual(normalValues);
    expect(Array.from(colors.array)).toEqual(colorValues);
    expect(positions.version).toBe(positionVersion);
    expect(normals.version).toBe(normalVersion);
    expect(colors.version).toBe(colorVersion);

    let lowMaterialDisposals = 0;
    let lowGeometryDisposals = 0;
    lowVehicleMaterial.addEventListener('dispose', () => {
      lowMaterialDisposals += 1;
    });
    carrier.geometry.addEventListener('dispose', () => {
      lowGeometryDisposals += 1;
    });
    visual.dispose();
    visual.dispose();
    expect(lowMaterialDisposals).toBe(1);
    expect(lowGeometryDisposals).toBe(1);

    const unsupported = new VehicleVisual('sports', {
      quality: 'low',
      supportsMultiDraw: false,
    });
    expect(unsupported.root.getObjectByName('vehicle-batch:low-vehicle')).toBeUndefined();
    expect(unsupported.root.getObjectByName('vehicle-batch:low-boxes')).toBeUndefined();
    expect(unsupported.root.getObjectByName('vehicle-batch:low-wheels')).toBeUndefined();
    expect(vehicleBatches(unsupported).filter((mesh) => mesh.visible)).toHaveLength(5);
    for (const name of [
      'vehicle-batch:solid',
      'vehicle-batch:glass',
      'vehicle-batch:tires',
      'vehicle-batch:hubs',
    ]) {
      expect((unsupported.root.getObjectByName(name) as InstancedMesh).material)
        .toBeInstanceOf(MeshStandardMaterial);
    }
    unsupported.dispose();

    const high = new VehicleVisual('sports', {
      quality: 'high',
      supportsMultiDraw: true,
    });
    expect(high.root.getObjectByName('vehicle-batch:low-vehicle')).toBeUndefined();
    expect(high.root.getObjectByName('vehicle-batch:low-boxes')).toBeUndefined();
    expect(high.root.getObjectByName('vehicle-batch:low-wheels')).toBeUndefined();
    expect(vehicleBatches(high).filter((mesh) => mesh.visible)).toHaveLength(5);
    for (const name of [
      'vehicle-batch:solid',
      'vehicle-batch:glass',
      'vehicle-batch:tires',
      'vehicle-batch:hubs',
    ]) {
      expect((high.root.getObjectByName(name) as InstancedMesh).material)
        .toBeInstanceOf(MeshStandardMaterial);
    }
    high.dispose();
  });

  it('matches the r180 Euler wheel matrix for merged positions and normals', () => {
    const visual = new VehicleVisual('sports', {
      quality: 'low',
      supportsMultiDraw: true,
    });
    const carrier = visual.root.getObjectByName('vehicle-batch:low-vehicle');
    const wheel = visual.root.getObjectByName('vehicle-wheel:front-left');
    const hub = visual.root.getObjectByName('vehicle-wheel-hub:front-left');
    expect(carrier).toBeInstanceOf(Mesh);
    expect(wheel).toBeDefined();
    expect(hub).toBeDefined();
    if (!(carrier instanceof Mesh) || !wheel || !hub) {
      throw new Error('Expected merged front wheel geometry and markers');
    }

    const offset = wheel.userData.vehicleVertexOffset as number;
    const count = wheel.userData.vehicleVertexCount as number;
    const hubOffset = hub.userData.vehicleVertexOffset as number;
    const radius = wheel.userData.radius as number;
    const width = wheel.userData.width as number;
    const center = wheel.position.clone();
    const positions = carrier.geometry.getAttribute('position') as BufferAttribute;
    const normals = carrier.geometry.getAttribute('normal') as BufferAttribute;
    const roles = carrier.geometry.getAttribute('vehicleWheelRole') as BufferAttribute;
    expect(roles.getX(hubOffset)).toBe(1);
    expect(roles.getY(hubOffset)).toBe(1);
    expect(roles.getZ(hubOffset)).toBeCloseTo(1 / radius, 6);

    const rest = new Object3D();
    rest.position.copy(center);
    rest.rotation.set(0, 0, Math.PI / 2);
    rest.scale.set(radius, width, radius);
    rest.updateMatrix();
    const spin = 1.137;
    const steer = -0.18;
    const animated = new Object3D();
    animated.position.copy(center);
    animated.rotation.copy(new Euler(spin, steer, Math.PI / 2, 'XYZ'));
    animated.scale.copy(rest.scale);
    animated.updateMatrix();
    const inverseRest = rest.matrix.clone().invert();
    const inverseRestNormal = new Matrix3()
      .getNormalMatrix(rest.matrix)
      .invert();
    const animatedNormal = new Matrix3().getNormalMatrix(animated.matrix);

    for (const index of [
      offset,
      offset + Math.floor(count / 3),
      offset + count - 1,
    ]) {
      const restPosition = vectorAt(positions, index);
      const sourcePosition = restPosition.clone().applyMatrix4(inverseRest);
      const matrixPosition = sourcePosition.clone().applyMatrix4(animated.matrix);
      const shaderPosition = rotateX(
        rotateY(restPosition.clone().sub(center), steer),
        spin,
      ).add(center);
      expect(shaderPosition.distanceTo(matrixPosition)).toBeLessThan(1e-5);

      const restNormal = vectorAt(normals, index).normalize();
      const sourceNormal = restNormal
        .clone()
        .applyMatrix3(inverseRestNormal)
        .normalize();
      const matrixNormal = sourceNormal
        .clone()
        .applyMatrix3(animatedNormal)
        .normalize();
      const shaderNormal = rotateX(
        rotateY(restNormal, steer),
        spin,
      ).normalize();
      expect(shaderNormal.distanceTo(matrixNormal)).toBeLessThan(1e-5);
    }

    visual.dispose();
  });

  it('updates only paintable low vertex ranges and preserves them across hot swaps', () => {
    const visual = new VehicleVisual('sedan', {
      quality: 'low',
      supportsMultiDraw: true,
    });
    const carrier = visual.root.getObjectByName('vehicle-batch:low-vehicle');
    expect(carrier).toBeInstanceOf(Mesh);
    if (!(carrier instanceof Mesh)) {
      throw new Error('Expected the merged low sedan carrier');
    }
    const positions = carrier.geometry.getAttribute('position');
    const normals = carrier.geometry.getAttribute('normal');
    const colors = carrier.geometry.getAttribute('color');
    const positionVersion = positions.version;
    const normalVersion = normals.version;
    const factoryBody = vehiclePartColor(visual, 'vehicle-part:chassis');
    const factoryAccent = vehiclePartColor(visual, 'vehicle-part:waistline');
    const frontWheel = visual.root.getObjectByName('vehicle-wheel:front-left');
    const wheelOffset = frontWheel?.userData.vehicleVertexOffset as number;
    const wheelColor = new Color().setRGB(
      colors.getX(wheelOffset),
      colors.getY(wheelOffset),
      colors.getZ(wheelOffset),
    ).getHex();

    expect(visual.setPaint('sunset-orange')).toBe('sunset-orange');
    expect(vehiclePartColor(visual, 'vehicle-part:chassis')).toBe(0xf0653b);
    expect(vehiclePartColor(visual, 'vehicle-part:waistline')).toBe(factoryAccent);
    expect(new Color().setRGB(
      colors.getX(wheelOffset),
      colors.getY(wheelOffset),
      colors.getZ(wheelOffset),
    ).getHex()).toBe(wheelColor);
    expect(positions.version).toBe(positionVersion);
    expect(normals.version).toBe(normalVersion);
    expect(colors.updateRanges.length).toBeGreaterThan(0);

    const damaged = createVehicleState({ x: 0, y: 0.48, z: 0 }, 'sedan');
    damaged.integrity = { ...damaged.integrity, bodyHealth: 35 };
    visual.sync(damaged, 0);
    expect(vehiclePartColor(visual, 'vehicle-part:chassis')).not.toBe(factoryBody);
    expect(vehiclePartColor(visual, 'vehicle-part:chassis')).not.toBe(0xf0653b);
    expect(vehiclePartColor(visual, 'vehicle-part:waistline')).toBe(factoryAccent);
    expect(positions.version).toBe(positionVersion);
    expect(normals.version).toBe(normalVersion);

    const oldResources = resources(visual);
    let disposed = 0;
    for (const resource of [...oldResources.geometries, ...oldResources.materials]) {
      resource.addEventListener('dispose', () => {
        disposed += 1;
      });
    }
    const sports = createVehicleState({ x: 0, y: 0.48, z: 0 }, 'sports');
    sports.integrity = { ...sports.integrity, bodyHealth: 35 };
    visual.sync(sports, 0);
    expect(disposed).toBe(oldResources.geometries.size + oldResources.materials.size);
    expect(visual.vehiclePaint).toBe('sunset-orange');
    expect(vehiclePartColor(visual, 'vehicle-part:wedge-hood')).not.toBe(0x328ad7);
    expect(
      vehicleBatches(visual).filter((mesh) => mesh.visible).map((mesh) => mesh.name),
    ).toEqual(['vehicle-batch:low-vehicle']);

    visual.dispose();
  });

  it('disposes the previous class resources during a hot swap', () => {
    const visual = new VehicleVisual('compact');
    const oldModel = visual.root.children[0];
    const oldResources = resources(visual);
    let disposed = 0;
    for (const resource of [...oldResources.geometries, ...oldResources.materials]) {
      resource.addEventListener('dispose', () => {
        disposed += 1;
      });
    }

    visual.sync(createVehicleState({ x: 0, y: 0.48, z: 0 }, 'van'), 0);

    expect(oldModel?.parent).toBeNull();
    expect(disposed).toBe(oldResources.geometries.size + oldResources.materials.size);
    expect(visual.root.children).toHaveLength(1);
    expect(visual.root.children[0]?.name).toContain('vehicle-model:van:harborline-van');
    visual.dispose();
  });

  it('spins wheels and steers only the front axle for cars and motorcycles', () => {
    const visual = new VehicleVisual('sports');
    const sports = createVehicleState({ x: 4, y: 0.48, z: -8 }, 'sports');
    sports.heading = 0.7;
    sports.speed = 12;
    sports.steering = 0.5;
    visual.sync(sports, 0.25);
    const sportsWheels = vehicleWheels(visual);
    const tireBatch = visual.root.getObjectByName('vehicle-batch:tires') as InstancedMesh;
    const firstTireMatrix = new Matrix4();
    tireBatch.getMatrixAt(0, firstTireMatrix);

    expect(visual.root.position.toArray()).toEqual([4, 0.48, -8]);
    expect(visual.root.rotation.y).toBeCloseTo(0.7);
    expect(sportsWheels.every((wheel) => wheel.rotation.x !== 0)).toBe(true);
    expect(sportsWheels.filter((wheel) => wheel.userData.steerable).map((wheel) => wheel.rotation.y))
      .toEqual([-0.18, -0.18]);
    expect(sportsWheels.filter((wheel) => !wheel.userData.steerable).map((wheel) => wheel.rotation.y))
      .toEqual([0, 0]);
    expect(firstTireMatrix.equals(new Matrix4())).toBe(false);

    const motorcycle = createVehicleState({ x: 0, y: 0.48, z: 0 }, 'motorcycle');
    motorcycle.speed = 8;
    motorcycle.steering = -0.5;
    visual.sync(motorcycle, 0.25);
    const motorcycleWheels = vehicleWheels(visual);
    expect(motorcycleWheels).toHaveLength(2);
    expect(motorcycleWheels.find((wheel) => wheel.userData.steerable)?.rotation.y).toBeCloseTo(0.18);
    expect(motorcycleWheels.find((wheel) => !wheel.userData.steerable)?.rotation.y).toBe(0);
    visual.dispose();
  });

  it('applies authored paint immediately and preserves it across class swaps', () => {
    const visual = new VehicleVisual('compact');
    expect(visual.setPaint('sunset-orange')).toBe('sunset-orange');
    expect(vehiclePartColor(visual, 'vehicle-part:chassis')).toBe(0xf0653b);
    expect(visual.root.userData.vehiclePaint).toBe('sunset-orange');

    visual.sync(createVehicleState({ x: 0, y: 0.48, z: 0 }, 'sedan'), 0);
    expect(vehiclePartColor(visual, 'vehicle-part:chassis')).toBe(0xf0653b);
    expect(visual.vehiclePaint).toBe('sunset-orange');

    expect(visual.setPaint('not-authored')).toBe('factory');
    expect(vehiclePartColor(visual, 'vehicle-part:chassis')).toBe(0xc58b45);
    visual.dispose();
  });

  it('darkens only paintable body instances as authored body damage increases', () => {
    const visual = new VehicleVisual('sedan');
    const damaged = createVehicleState({ x: 0, y: 0.48, z: 0 }, 'sedan');
    const factoryBody = vehiclePartColor(visual, 'vehicle-part:chassis');
    const factoryAccent = vehiclePartColor(visual, 'vehicle-part:waistline');
    damaged.integrity = { ...damaged.integrity, bodyHealth: 35 };
    visual.sync(damaged, 0);

    expect(vehiclePartColor(visual, 'vehicle-part:chassis')).not.toBe(factoryBody);
    expect(vehiclePartColor(visual, 'vehicle-part:waistline')).toBe(factoryAccent);
    visual.dispose();
  });

  it('releases the active model exactly once', () => {
    const visual = new VehicleVisual('police-cruiser');
    const activeResources = resources(visual);
    let disposed = 0;
    for (const resource of [...activeResources.geometries, ...activeResources.materials]) {
      resource.addEventListener('dispose', () => {
        disposed += 1;
      });
    }

    visual.dispose();
    visual.dispose();

    expect(disposed).toBe(activeResources.geometries.size + activeResources.materials.size);
    expect(visual.root.children).toHaveLength(0);
  });
});
