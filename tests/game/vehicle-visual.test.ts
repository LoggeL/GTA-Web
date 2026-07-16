import {
  Box3,
  Mesh,
  Vector3,
} from 'three';
import type { BufferGeometry, Material, MeshStandardMaterial } from 'three';
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

function vehicleWheels(visual: VehicleVisual): Mesh[] {
  const wheels: Mesh[] = [];
  visual.root.traverse((object) => {
    if (object instanceof Mesh && object.name.startsWith('vehicle-wheel:')) {
      wheels.push(object);
    }
  });
  return wheels;
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

    expect(visual.root.position.toArray()).toEqual([4, 0.48, -8]);
    expect(visual.root.rotation.y).toBeCloseTo(0.7);
    expect(sportsWheels.every((wheel) => wheel.rotation.x !== 0)).toBe(true);
    expect(sportsWheels.filter((wheel) => wheel.userData.steerable).map((wheel) => wheel.rotation.y))
      .toEqual([-0.18, -0.18]);
    expect(sportsWheels.filter((wheel) => !wheel.userData.steerable).map((wheel) => wheel.rotation.y))
      .toEqual([0, 0]);

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
    const compactBody = visual.root.getObjectByName('vehicle-part:chassis') as Mesh;
    expect((compactBody.material as MeshStandardMaterial).color.getHex()).toBe(0xf0653b);
    expect(visual.root.userData.vehiclePaint).toBe('sunset-orange');

    visual.sync(createVehicleState({ x: 0, y: 0.48, z: 0 }, 'sedan'), 0);
    const sedanBody = visual.root.getObjectByName('vehicle-part:chassis') as Mesh;
    expect((sedanBody.material as MeshStandardMaterial).color.getHex()).toBe(0xf0653b);
    expect(visual.vehiclePaint).toBe('sunset-orange');

    expect(visual.setPaint('not-authored')).toBe('factory');
    expect((sedanBody.material as MeshStandardMaterial).color.getHex()).toBe(0xc58b45);
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
