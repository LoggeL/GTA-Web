import { InstancedMesh } from 'three';
import { describe, expect, it } from 'vitest';

import { TrafficSignalVisual } from '../../src/game/TrafficSignalVisual';
import type { CollisionRect } from '../../src/game/city';
import { createVehicleState } from '../../src/game/vehicle';
import type { VehicleSimulationState } from '../../src/game/vehicle';
import {
  createVehicleCollisionBox,
  vehicleCollisionBoxIntersectsRect,
} from '../../src/game/vehicleDynamics';
import { requireVehicleDriveProfile } from '../../src/game/vehicleProfiles';
import { WorldView } from '../../src/game/WorldView';
import type { CellId } from '../../src/navigation/types';
import type {
  ExternalTrafficCollisionResult,
  ExternalTrafficVehicleState,
} from '../../src/simulation';
import type {
  TrafficSignalJunctionSnapshot,
  TrafficSignalSystemSnapshot,
} from '../../src/simulation/traffic-signals';

function signal(
  id: string,
  x: number,
  horizontalAspect: TrafficSignalJunctionSnapshot['horizontalAspect'] = 'green',
  verticalAspect: TrafficSignalJunctionSnapshot['verticalAspect'] = 'red',
): TrafficSignalJunctionSnapshot {
  return {
    id,
    position: { x, y: 0, z: 20 },
    horizontalRoadIds: [`${id}-horizontal`],
    verticalRoadIds: [`${id}-vertical`],
    offsetSeconds: 0,
    cyclePositionSeconds: 0,
    phase: horizontalAspect === 'green' ? 'horizontal-green' : 'vertical-green',
    horizontalAspect,
    verticalAspect,
    secondsUntilChange: 12,
  };
}

function signalSnapshot(
  junctions: readonly TrafficSignalJunctionSnapshot[],
): TrafficSignalSystemSnapshot {
  return {
    cycleClockSeconds: 0,
    cycleSeconds: 30,
    junctions,
  };
}

interface SignalHarness {
  readonly trafficSignalVisual: TrafficSignalVisual;
  readonly layout: { readonly quality: 'low' | 'high' };
  readonly player: { readonly position: { readonly x: number; readonly z: number } };
  readonly vehicle: {
    readonly occupied: boolean;
    readonly position: { readonly x: number; readonly z: number };
  };
  readonly citySimulation: {
    getTrafficSignalSnapshot(): TrafficSignalSystemSnapshot;
  };
  readonly interiorRuntime: { phase: 'exterior' | 'interior' };
  trafficSignalVisualElapsed: number;
  renderableTrafficSignalCellIds: ReadonlySet<CellId> | null;
  refreshTrafficSignalVisual(force: boolean): void;
}

interface CollisionHarness {
  readonly vehicle: VehicleSimulationState;
  readonly citySimulation: {
    resolveTrafficVehicleCollision(
      state: Readonly<ExternalTrafficVehicleState>,
    ): ExternalTrafficCollisionResult;
  };
  readonly progressionModifiers: {
    readonly vehicleDurabilityMultiplier: number;
  };
  activeCollisions(): readonly CollisionRect[];
  getExternalTrafficVehicleState(): ExternalTrafficVehicleState | null;
  resolveTrafficVehicleCollision(
    previousPosition: Readonly<{ x: number; y: number; z: number }>,
  ): boolean;
}

function layer(visual: TrafficSignalVisual, name: string): InstancedMesh {
  const object = visual.root.getObjectByName(name);
  if (!(object instanceof InstancedMesh)) {
    throw new Error(`Missing traffic signal layer ${name}`);
  }
  return object;
}

describe('WorldView traffic integration', () => {
  it('filters signal geometry to streamed cells and refreshes it at a bounded cadence', () => {
    const visual = new TrafficSignalVisual(2, 'low');
    let snapshot = signalSnapshot([
      signal('near', 100),
      signal('far', 300, 'red', 'green'),
    ]);
    const harness = Object.create(WorldView.prototype) as unknown as SignalHarness;
    Object.assign(harness, {
      trafficSignalVisual: visual,
      layout: { quality: 'low' },
      player: { position: { x: 0, z: 20 } },
      vehicle: { occupied: false, position: { x: 500, z: 20 } },
      citySimulation: {
        getTrafficSignalSnapshot: () => snapshot,
      },
      interiorRuntime: { phase: 'exterior' },
      trafficSignalVisualElapsed: Number.POSITIVE_INFINITY,
      renderableTrafficSignalCellIds: new Set<CellId>(['cell:0:0']),
    });

    harness.refreshTrafficSignalVisual(true);
    expect(layer(visual, 'traffic-signal-structures').count).toBe(1);
    expect(visual.root.visible).toBe(true);

    snapshot = signalSnapshot([signal('far', 300, 'red', 'green')]);
    harness.trafficSignalVisualElapsed = 0.099;
    harness.refreshTrafficSignalVisual(false);
    expect(layer(visual, 'traffic-signal-structures').count).toBe(1);

    harness.trafficSignalVisualElapsed = 0.1;
    harness.refreshTrafficSignalVisual(false);
    expect(layer(visual, 'traffic-signal-structures').count).toBe(0);
    expect(visual.root.visible).toBe(false);

    snapshot = signalSnapshot([signal('same-cell-but-too-distant', 151)]);
    harness.renderableTrafficSignalCellIds = null;
    harness.refreshTrafficSignalVisual(true);
    expect(layer(visual, 'traffic-signal-structures').count).toBe(0);

    harness.interiorRuntime.phase = 'interior';
    harness.refreshTrafficSignalVisual(true);
    expect(visual.root.visible).toBe(false);
    visual.dispose();
  });

  it('applies corrected traffic contact state and deterministic dynamic impact damage', () => {
    const vehicle = createVehicleState({ x: 2, y: 0, z: 4 }, 'compact');
    vehicle.speed = 16;
    let supplied: Readonly<ExternalTrafficVehicleState> | null = null;
    const collision: ExternalTrafficCollisionResult = {
      collided: true,
      position: { x: 1.2, y: 0, z: 3.4 },
      speed: 5.5,
      lateralSpeed: -1.25,
      impactSpeed: 11,
      impactNormal: { x: 0, z: -1 },
      primaryAmbientVehicleId: 'traffic-007',
      ambientVehicleIds: ['traffic-007'],
      pairChecks: 12,
    };
    const harness = Object.create(WorldView.prototype) as unknown as CollisionHarness;
    Object.assign(harness, {
      vehicle,
      citySimulation: {
        resolveTrafficVehicleCollision: (state: Readonly<ExternalTrafficVehicleState>) => {
          supplied = state;
          return collision;
        },
      },
      progressionModifiers: {
        vehicleDurabilityMultiplier: 1,
      },
      activeCollisions: () => [],
    });

    expect(harness.resolveTrafficVehicleCollision({ x: 0, y: 0, z: 4 })).toBe(true);
    expect(supplied).toMatchObject({
      previousPosition: { x: 0, y: 0, z: 4 },
      position: { x: 2, y: 0, z: 4 },
      speed: 16,
      lateralSpeed: 0,
      radius: requireVehicleDriveProfile('compact').arcadeHandling.collisionRadiusMeters,
    });
    expect(vehicle.position).toEqual(collision.position);
    expect(vehicle.speed).toBe(5.5);
    expect(vehicle.lateralSpeed).toBe(-1.25);
    expect(vehicle.lastImpact).toMatchObject({
      collisionId: 'traffic:traffic-007',
      normalSpeedMetersPerSecond: 11,
    });
    expect(vehicle.integrity.bodyHealth).toBeLessThan(100);
  });

  it('exposes only occupied vehicles to ambient anticipation with the authored footprint', () => {
    const vehicle = createVehicleState({ x: 8, y: 0.48, z: -12 }, 'van');
    vehicle.heading = 0.72;
    vehicle.speed = 13.5;
    vehicle.lateralSpeed = -1.4;
    const harness = Object.create(WorldView.prototype) as unknown as CollisionHarness;
    Object.assign(harness, {
      vehicle,
    });

    expect(harness.getExternalTrafficVehicleState()).toBeNull();
    vehicle.occupied = true;
    expect(harness.getExternalTrafficVehicleState()).toEqual({
      position: { x: 8, y: 0.48, z: -12 },
      heading: 0.72,
      speed: 13.5,
      lateralSpeed: -1.4,
      radius: requireVehicleDriveProfile('van').arcadeHandling.collisionRadiusMeters,
    });
  });

  it('constrains ambient correction against a static wall without discarding impact evidence', () => {
    const vehicle = createVehicleState({ x: 0, y: 0.48, z: 0 }, 'compact');
    vehicle.occupied = true;
    vehicle.speed = 14;
    const wall: CollisionRect = {
      id: 'sandwich-wall',
      minX: 1.05,
      maxX: 2.5,
      minZ: -3,
      maxZ: 3,
      height: 4,
      kind: 'solid',
    };
    const collision: ExternalTrafficCollisionResult = {
      collided: true,
      position: { x: 0.55, y: 0.48, z: 0 },
      speed: 4.5,
      lateralSpeed: -0.8,
      impactSpeed: 9.5,
      impactNormal: { x: 1, z: 0 },
      primaryAmbientVehicleId: 'traffic-left',
      ambientVehicleIds: ['traffic-left'],
      pairChecks: 6,
    };
    const harness = Object.create(WorldView.prototype) as unknown as CollisionHarness;
    Object.assign(harness, {
      vehicle,
      citySimulation: {
        resolveTrafficVehicleCollision: () => collision,
      },
      progressionModifiers: {
        vehicleDurabilityMultiplier: 1,
      },
      activeCollisions: () => [wall],
    });

    const bodyHealthBefore = vehicle.integrity.bodyHealth;
    expect(harness.resolveTrafficVehicleCollision({ ...vehicle.position })).toBe(true);
    expect(vehicle.position).toEqual({ x: 0, y: 0.48, z: 0 });
    expect(vehicleCollisionBoxIntersectsRect(createVehicleCollisionBox(vehicle), wall)).toBe(false);
    expect(vehicle.speed).toBe(4.5);
    expect(vehicle.lateralSpeed).toBe(-0.8);
    expect(vehicle.lastImpact).toMatchObject({
      collisionId: 'traffic:traffic-left',
      normalSpeedMetersPerSecond: 9.5,
    });
    expect(vehicle.integrity.bodyHealth).toBeLessThan(bodyHealthBefore);
  });
});
