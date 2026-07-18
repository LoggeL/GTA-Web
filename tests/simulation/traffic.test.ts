import { describe, expect, it } from 'vitest';

import { VEHICLES } from '../../src/data/vehicles';
import { PLAYER_SPAWN, generateCity } from '../../src/game/city';
import {
  directionFromHeading,
  distance2d,
  headingFromDirection,
} from '../../src/simulation/math';
import { SimulationRandom, simulationSeed } from '../../src/simulation/random';
import {
  TRAFFIC_AVOIDANCE_PAIR_BUDGET_PER_TICK,
  TRAFFIC_EXTERNAL_COLLISION_PAIR_BUDGET_PER_CALL,
  TRAFFIC_RELEVANCE_RADII,
  TrafficSystem,
  chooseTrafficVehicleClass,
} from '../../src/simulation/traffic';
import {
  TRAFFIC_SIGNAL_STOP_LINE_DISTANCE,
  TRAFFIC_SIGNAL_TIMING,
} from '../../src/simulation/traffic-signals';
import type {
  SimulationRoadRecipe,
  SimulationVec3,
} from '../../src/simulation/types';

const road: SimulationRoadRecipe = {
  id: 'test-road',
  position: { x: 0, y: 0, z: 0 },
  width: 18,
  depth: 600,
};

const PRODUCTION_WORLD_SEED = 'heatline-solara-world-v1';
const TRAFFIC_RANDOM_SALT = 0x4f219a;

function vehicleCollisionRadius(classId: string): number {
  return VEHICLES.find(({ id }) => id === classId)
    ?.arcadeHandling.collisionRadiusMeters
    ?? 1.48;
}

interface TrafficJunctionHarness {
  readonly id: string;
  readonly position: SimulationVec3;
  readonly roadIndices: readonly number[];
}

interface TrafficAgentHarness {
  readonly id: string;
  active: boolean;
  position: SimulationVec3;
  heading: number;
  speed: number;
  cruiseSpeed: number;
  behavior: string;
  roadIndex: number;
  laneOffset: number;
  direction: 1 | -1;
  intersectionWaitSeconds: number;
  intersectionPriorityRemaining: number;
  intersectionTicket: number;
  transitionWaitSeconds: number;
  routeStep: number;
  lastJunction: TrafficJunctionHarness | null;
  plannedTransition: {
    readonly roadIndex: number;
    readonly direction: 1 | -1;
    readonly kind: 'continue' | 'left' | 'right';
    readonly junction: TrafficJunctionHarness;
    readonly triggerAhead: number;
  } | null;
  collisionRadius: number;
  signalSpeedCap: number;
  signalPriority: -1 | 0 | 1;
  permissiveLeftYield: boolean;
}

function trafficHarness(traffic: TrafficSystem): {
  readonly agents: TrafficAgentHarness[];
  readonly junctionsByRoad: readonly (readonly TrafficJunctionHarness[])[];
} {
  return traffic as unknown as {
    readonly agents: TrafficAgentHarness[];
    readonly junctionsByRoad: readonly (readonly TrafficJunctionHarness[])[];
  };
}

describe('adaptive traffic pool', () => {
  it('uses the locked low/high active counts and deterministic placement', () => {
    const first = new TrafficSystem(new SimulationRandom('traffic-seed'), 'low', [road]);
    const second = new TrafficSystem(new SimulationRandom('traffic-seed'), 'low', [road]);
    expect(first.getSnapshot()).toEqual(second.getSnapshot());
    expect(first.getSnapshot()).toHaveLength(18);
    first.setQuality('high');
    expect(first.getSnapshot()).toHaveLength(42);
    first.setQuality('low');
    expect(first.getSnapshot()).toHaveLength(18);
  });

  it('yields to an obstruction, reverses, and recovers onto a road', () => {
    const traffic = new TrafficSystem(new SimulationRandom('obstruction-seed'), 'low', [road]);
    let first = traffic.getSnapshot()[0];
    expect(first).toBeDefined();

    for (let frame = 0; frame < 17; frame += 1) {
      first = traffic.getSnapshot()[0];
      if (!first) {
        throw new Error('Missing traffic agent');
      }
      const direction = directionFromHeading(first.heading);
      traffic.tick({
        deltaSeconds: 0.1,
        sirenPosition: null,
        sirenRadius: 0,
        obstructions: [{ x: first.position.x + direction.x * 3, z: first.position.z + direction.z * 3, radius: 2 }],
      });
    }
    expect(traffic.getSnapshot()[0]?.behavior).toBe('recover');

    for (let frame = 0; frame < 10; frame += 1) {
      traffic.tick({ deltaSeconds: 0.1, sirenPosition: null, sirenRadius: 0, obstructions: [] });
    }
    expect(traffic.getSnapshot()[0]?.behavior).toBe('cruise');
  });

  it('supports panic and emergency-siren yielding hooks', () => {
    const traffic = new TrafficSystem(new SimulationRandom('hooks-seed'), 'low', [road]);
    const first = traffic.getSnapshot()[0];
    if (!first) {
      throw new Error('Missing traffic agent');
    }
    traffic.tick({
      deltaSeconds: 0.1,
      sirenPosition: first.position,
      sirenRadius: 20,
      obstructions: [],
    });
    expect(traffic.getSnapshot()[0]?.behavior).toBe('siren-yield');

    traffic.triggerPanic(first.position, 20, 2);
    traffic.tick({ deltaSeconds: 0.1, sirenPosition: first.position, sirenRadius: 20, obstructions: [] });
    expect(traffic.getSnapshot()[0]?.behavior).toBe('panic');
  });

  it('expires panic and recovery clocks while higher pooled slots are throttled', () => {
    const panicTraffic = new TrafficSystem(
      new SimulationRandom('throttled-panic-traffic'),
      'high',
      [road],
    );
    const panicVehicle = panicTraffic.getSnapshot().at(-1);
    if (!panicVehicle) throw new Error('Missing throttled panic vehicle');
    panicTraffic.triggerPanic(panicVehicle.position, 0.1, 0.5);
    panicTraffic.tick({
      deltaSeconds: 0.1,
      sirenPosition: null,
      sirenRadius: 0,
      obstructions: [],
    });
    expect(panicTraffic.getSnapshot().find(({ id }) => id === panicVehicle.id)?.behavior)
      .toBe('panic');
    panicTraffic.setActorLimit(5);
    for (let frame = 0; frame < 10; frame += 1) {
      panicTraffic.tick({
        deltaSeconds: 0.1,
        sirenPosition: null,
        sirenRadius: 0,
        obstructions: [],
      });
    }
    panicTraffic.setActorLimit(42);
    expect(panicTraffic.getSnapshot().find(({ id }) => id === panicVehicle.id)).toMatchObject({
      behavior: 'cruise',
      panicRemaining: 0,
    });

    const recoveryTraffic = new TrafficSystem(
      new SimulationRandom('throttled-recovery-traffic'),
      'high',
      [road],
    );
    const recoveryVehicle = recoveryTraffic.getSnapshot().at(-1);
    if (!recoveryVehicle) throw new Error('Missing throttled recovery vehicle');
    for (let frame = 0; frame < 17; frame += 1) {
      const current = recoveryTraffic.getSnapshot().find(({ id }) => id === recoveryVehicle.id);
      if (!current) throw new Error('Missing recovery vehicle');
      const direction = directionFromHeading(current.heading);
      recoveryTraffic.tick({
        deltaSeconds: 0.1,
        sirenPosition: null,
        sirenRadius: 0,
        obstructions: [{
          x: current.position.x + direction.x * 3,
          z: current.position.z + direction.z * 3,
          radius: 2,
        }],
      });
    }
    expect(recoveryTraffic.getSnapshot().find(({ id }) => id === recoveryVehicle.id)?.behavior)
      .toBe('recover');
    recoveryTraffic.setActorLimit(5);
    for (let frame = 0; frame < 10; frame += 1) {
      recoveryTraffic.tick({
        deltaSeconds: 0.1,
        sirenPosition: null,
        sirenRadius: 0,
        obstructions: [],
      });
    }
    recoveryTraffic.setActorLimit(42);
    expect(recoveryTraffic.getSnapshot().find(({ id }) => id === recoveryVehicle.id)?.behavior)
      .toBe('cruise');
  });

  it('uses deterministic district-weighted vehicle classes', () => {
    const sample = (district: 'neon-strand' | 'alta-vista' | 'arroyo-heights' | 'breakwater') => {
      const random = new SimulationRandom(`traffic-classes:${district}`);
      const counts = new Map<string, number>();
      for (let index = 0; index < 2_000; index += 1) {
        const classId = chooseTrafficVehicleClass(random, district);
        counts.set(classId, (counts.get(classId) ?? 0) + 1);
      }
      return counts;
    };
    const neon = sample('neon-strand');
    const alta = sample('alta-vista');
    const breakwater = sample('breakwater');
    expect(neon.get('compact') ?? 0).toBeGreaterThan(neon.get('van') ?? 0);
    expect(alta.get('sedan') ?? 0).toBeGreaterThan(alta.get('pickup') ?? 0);
    expect((breakwater.get('van') ?? 0) + (breakwater.get('pickup') ?? 0)).toBeGreaterThan(
      (breakwater.get('sports') ?? 0) + (breakwater.get('compact') ?? 0),
    );
  });

  it('claims and recycles a pooled vehicle without shrinking the traffic budget', () => {
    const traffic = new TrafficSystem(new SimulationRandom('claim-traffic'), 'low', [road]);
    const before = traffic.getSnapshot();
    const target = before[0];
    if (!target) throw new Error('Missing traffic claim target');
    const claimed = traffic.claimVehicle(target.id);
    expect(claimed).toEqual(target);
    const after = traffic.getSnapshot();
    expect(after).toHaveLength(before.length);
    expect(after.find((vehicle) => vehicle.id === target.id)?.position).not.toEqual(target.position);
    expect(traffic.claimVehicle('missing-traffic-id')).toBeNull();
  });

  it('clears transient junction authority when a claimed actor is recycled', () => {
    const traffic = new TrafficSystem(
      new SimulationRandom('recycle-junction-authority'),
      'low',
      [road],
    );
    traffic.setActorLimit(1);
    const agent = trafficHarness(traffic).agents[0];
    if (!agent) throw new Error('Missing recycle authority target');
    const junction: TrafficJunctionHarness = {
      id: 'stale-junction',
      position: { ...agent.position },
      roadIndices: [0],
    };
    agent.intersectionWaitSeconds = 4;
    agent.intersectionPriorityRemaining = 8;
    agent.intersectionTicket = 91;
    agent.transitionWaitSeconds = 6;
    agent.lastJunction = junction;
    agent.plannedTransition = {
      roadIndex: 0,
      direction: agent.direction,
      kind: 'continue',
      junction,
      triggerAhead: 0,
    };
    agent.signalSpeedCap = 0;
    agent.signalPriority = 1;
    agent.permissiveLeftYield = true;

    expect(traffic.claimVehicle(agent.id)).not.toBeNull();
    expect(agent).toMatchObject({
      intersectionWaitSeconds: 0,
      intersectionPriorityRemaining: 0,
      intersectionTicket: 0,
      transitionWaitSeconds: 0,
      lastJunction: null,
      plannedTransition: null,
      signalSpeedCap: Number.POSITIVE_INFINITY,
      signalPriority: 0,
      permissiveLeftYield: false,
    });
  });

  it('resolves a deterministic rear impact with two-way momentum transfer', () => {
    const traffic = new TrafficSystem(
      new SimulationRandom('external-rear-impact'),
      'low',
      [road],
    );
    traffic.setActorLimit(1);
    const target = traffic.getSnapshot()[0];
    if (!target) throw new Error('Missing rear-impact target');
    const direction = directionFromHeading(target.heading);
    const externalSpeed = target.speed + 10;
    const result = traffic.resolveExternalVehicleCollision({
      position: {
        x: target.position.x - direction.x * 2,
        y: 0,
        z: target.position.z - direction.z * 2,
      },
      heading: target.heading,
      speed: externalSpeed,
    });
    const impactedTarget = traffic.getSnapshot()[0];

    expect(result).toMatchObject({
      collided: true,
      primaryAmbientVehicleId: target.id,
      ambientVehicleIds: [target.id],
      pairChecks: 2,
    });
    expect(result.impactSpeed).toBeGreaterThan(9);
    expect(result.speed).toBeLessThan(externalSpeed);
    expect(impactedTarget?.speed).toBeGreaterThan(target.speed);
    expect(distance2d(result.position, impactedTarget?.position ?? target.position))
      .toBeGreaterThanOrEqual(1.35 + vehicleCollisionRadius(target.classId) - 0.01);
    expect(result.pairChecks).toBeLessThanOrEqual(
      TRAFFIC_EXTERNAL_COLLISION_PAIR_BUDGET_PER_CALL,
    );
  });

  it('stops tunneling through a deterministic head-on external impact', () => {
    const traffic = new TrafficSystem(
      new SimulationRandom('external-head-on-impact'),
      'low',
      [road],
    );
    traffic.setActorLimit(1);
    traffic.tick({
      deltaSeconds: 0.1,
      sirenPosition: null,
      sirenRadius: 0,
      obstructions: [],
    });
    const target = traffic.getSnapshot()[0];
    if (!target) throw new Error('Missing head-on target');
    const direction = directionFromHeading(target.heading);
    const result = traffic.resolveExternalVehicleCollision({
      position: {
        x: target.position.x - direction.x,
        y: 0,
        z: target.position.z - direction.z,
      },
      previousPosition: {
        x: target.position.x + direction.x * 7,
        y: 0,
        z: target.position.z + direction.z * 7,
      },
      heading: target.heading + Math.PI,
      speed: 12,
    });
    const impactedTarget = traffic.getSnapshot()[0];
    const normal = result.impactNormal;

    expect(result.collided).toBe(true);
    expect(result.primaryAmbientVehicleId).toBe(target.id);
    expect(result.impactSpeed).toBeGreaterThan(12);
    expect(Math.abs(result.speed)).toBeLessThan(12);
    expect(normal).not.toBeNull();
    expect((normal?.x ?? 0) * direction.x + (normal?.z ?? 0) * direction.z)
      .toBeLessThan(-0.9);
    expect(
      (result.position.x - (impactedTarget?.position.x ?? target.position.x))
        * direction.x
      + (result.position.z - (impactedTarget?.position.z ?? target.position.z))
        * direction.z,
    ).toBeGreaterThan(0);
    expect(distance2d(result.position, impactedTarget?.position ?? target.position))
      .toBeGreaterThanOrEqual(1.35 + vehicleCollisionRadius(target.classId) - 0.01);
  });

  it('predictively yields to a parked external vehicle before combined-radius contact', () => {
    const traffic = new TrafficSystem(
      new SimulationRandom('parked-external-vehicle'),
      'low',
      [road],
    );
    traffic.setActorLimit(1);
    const agent = trafficHarness(traffic).agents[0];
    if (!agent) throw new Error('Missing parked-external follower');
    agent.position = { x: -4.14, y: 0, z: -20 };
    agent.direction = 1;
    agent.laneOffset = -4.14;
    agent.heading = headingFromDirection(0, 1);
    agent.speed = 12;
    agent.cruiseSpeed = 12;
    agent.behavior = 'cruise';
    agent.lastJunction = null;
    agent.plannedTransition = null;
    const externalRadius = 1.5;
    const externalPosition = { x: -4.14, y: 0, z: 0 };
    const combinedRadius = agent.collisionRadius + externalRadius;
    let minimumDistance = Number.POSITIVE_INFINITY;
    let firstYieldDistance = Number.NaN;

    for (let frame = 0; frame < 50; frame += 1) {
      traffic.tick({
        deltaSeconds: 0.1,
        externalVehicle: {
          position: externalPosition,
          heading: agent.heading,
          speed: 0,
          radius: externalRadius,
        },
        sirenPosition: null,
        sirenRadius: 0,
        obstructions: [],
      });
      const current = traffic.getSnapshot()[0];
      if (!current) throw new Error('Missing parked-external follower snapshot');
      const centerDistance = distance2d(current.position, externalPosition);
      minimumDistance = Math.min(minimumDistance, centerDistance);
      if (!Number.isFinite(firstYieldDistance) && current.behavior === 'yield') {
        firstYieldDistance = centerDistance;
      }
      expect(traffic.getAvoidanceDiagnostics().lastTickPairChecks)
        .toBeLessThanOrEqual(TRAFFIC_AVOIDANCE_PAIR_BUDGET_PER_TICK);
      expect(traffic.getAvoidanceDiagnostics().lastTickCollisionResolutions).toBe(0);
    }

    expect(firstYieldDistance).toBeGreaterThan(combinedRadius + 10);
    expect(minimumDistance).toBeGreaterThanOrEqual(combinedRadius - 0.01);
    expect(traffic.getSnapshot()[0]?.speed).toBeLessThan(1);
  });

  it('returns a stable normal and primary actor for a side impact', () => {
    const traffic = new TrafficSystem(
      new SimulationRandom('external-side-impact'),
      'low',
      [road],
    );
    traffic.setActorLimit(1);
    const target = traffic.getSnapshot()[0];
    if (!target) throw new Error('Missing side-impact target');
    const direction = directionFromHeading(target.heading);
    const right = { x: -direction.z, z: direction.x };
    const result = traffic.resolveExternalVehicleCollision({
      position: {
        x: target.position.x + right.x * 2,
        y: 0,
        z: target.position.z + right.z * 2,
      },
      heading: headingFromDirection(-right.x, -right.z),
      speed: 12,
    });
    const normal = result.impactNormal;

    expect(result.collided).toBe(true);
    expect(result.primaryAmbientVehicleId).toBe(target.id);
    expect(result.impactSpeed).toBeGreaterThan(11.5);
    expect(normal).not.toBeNull();
    expect((normal?.x ?? 0) * -right.x + (normal?.z ?? 0) * -right.z)
      .toBeGreaterThan(0.9);
  });

  it('separates adversarial ambient contacts within the fixed pair budget', () => {
    const narrowRoad: SimulationRoadRecipe = {
      id: 'adversarial-narrow-road',
      position: { x: 0, y: 0, z: 0 },
      width: 2.2,
      depth: 240,
    };
    const first = new TrafficSystem(
      new SimulationRandom('collision-0'),
      'low',
      [narrowRoad],
    );
    const second = new TrafficSystem(
      new SimulationRandom('collision-0'),
      'low',
      [narrowRoad],
    );
    let sawResolution = false;

    for (let frame = 0; frame < 120; frame += 1) {
      const context = {
        deltaSeconds: 0.1,
        sirenPosition: null,
        sirenRadius: 0,
        obstructions: [],
      } as const;
      first.tick(context);
      second.tick(context);
      const snapshot = first.getSnapshot();
      expect(second.getSnapshot()).toEqual(snapshot);
      const diagnostics = first.getAvoidanceDiagnostics();
      sawResolution ||= diagnostics.lastTickCollisionResolutions > 0;
      expect(diagnostics.lastTickPairChecks).toBeLessThanOrEqual(
        TRAFFIC_AVOIDANCE_PAIR_BUDGET_PER_TICK,
      );
      for (let firstIndex = 0; firstIndex < snapshot.length; firstIndex += 1) {
        for (
          let secondIndex = firstIndex + 1;
          secondIndex < snapshot.length;
          secondIndex += 1
        ) {
          const firstVehicle = snapshot[firstIndex];
          const secondVehicle = snapshot[secondIndex];
          if (!firstVehicle || !secondVehicle) continue;
          expect(distance2d(firstVehicle.position, secondVehicle.position))
            .toBeGreaterThanOrEqual(
              vehicleCollisionRadius(firstVehicle.classId)
                + vehicleCollisionRadius(secondVehicle.classId)
                - 0.02,
            );
        }
      }
    }
    expect(sawResolution).toBe(true);
  });

  it('brakes for distant obstacles and reverses route after repeated blockage', () => {
    const traffic = new TrafficSystem(
      new SimulationRandom('blocked-route-recovery'),
      'low',
      [road],
    );
    traffic.setActorLimit(1);
    for (let frame = 0; frame < 30; frame += 1) {
      traffic.tick({
        deltaSeconds: 0.1,
        sirenPosition: null,
        sirenRadius: 0,
        obstructions: [],
      });
    }
    const cruising = traffic.getSnapshot()[0];
    if (!cruising) throw new Error('Missing blocked-route target');
    const cruisingDirection = directionFromHeading(cruising.heading);
    const proactiveObstacleDistance = Math.max(
      10.5,
      ((cruising.speed - 1) ** 2) / 6.4 + 3.4,
    );
    traffic.tick({
      deltaSeconds: 0.1,
      sirenPosition: null,
      sirenRadius: 0,
      obstructions: [{
        x: cruising.position.x + cruisingDirection.x * proactiveObstacleDistance,
        z: cruising.position.z + cruisingDirection.z * proactiveObstacleDistance,
        radius: 2,
      }],
    });
    const braking = traffic.getSnapshot()[0];
    expect(braking?.behavior).toBe('yield');
    expect(braking?.speed).toBeGreaterThan(0);
    expect(braking?.speed).toBeLessThan(cruising.speed);

    const initialHeading = braking?.heading ?? cruising.heading;
    let recoveredHeading = initialHeading;
    for (let frame = 0; frame < 60; frame += 1) {
      const current = traffic.getSnapshot()[0];
      if (!current) throw new Error('Missing recovering traffic actor');
      const direction = directionFromHeading(current.heading);
      traffic.tick({
        deltaSeconds: 0.1,
        sirenPosition: null,
        sirenRadius: 0,
        obstructions: [{
          x: current.position.x + direction.x * 3,
          z: current.position.z + direction.z * 3,
          radius: 2,
        }],
      });
      recoveredHeading = traffic.getSnapshot()[0]?.heading ?? recoveredHeading;
      if (Math.cos(recoveredHeading - initialHeading) < -0.9) break;
    }
    expect(Math.cos(recoveredHeading - initialHeading)).toBeLessThan(-0.9);
  });

  it('keeps a dense deterministic road population around a moving player without close pop-in', () => {
    const roads = generateCity('ambient-traffic-locality', 'high').roads;
    const first = new TrafficSystem(
      new SimulationRandom('ambient-traffic-locality'),
      'high',
      roads,
    );
    const second = new TrafficSystem(
      new SimulationRandom('ambient-traffic-locality'),
      'high',
      [...roads].reverse(),
    );
    const playerPositions = [
      { x: -250, y: 0, z: -250 },
      { x: 250, y: 0, z: -250 },
      { x: 250, y: 0, z: 250 },
      { x: -250, y: 0, z: 250 },
    ] as const;
    let previous = new Map(first.getSnapshot().map((vehicle) => [vehicle.id, vehicle]));

    for (const playerPosition of playerPositions) {
      const context = {
        deltaSeconds: 0.01,
        playerPosition,
        sirenPosition: null,
        sirenRadius: 0,
        obstructions: [],
      } as const;
      first.tick(context);
      second.tick(context);
      const snapshot = first.getSnapshot();
      expect(second.getSnapshot()).toEqual(snapshot);
      expect(snapshot).toHaveLength(42);
      expect(snapshot.filter((vehicle) => (
        distance2d(vehicle.position, playerPosition)
          <= TRAFFIC_RELEVANCE_RADII.recycleBeyondDistance + 0.2
      )).length).toBeGreaterThanOrEqual(38);

      const relocated = snapshot.filter((vehicle) => {
        const prior = previous.get(vehicle.id);
        return prior !== undefined && distance2d(prior.position, vehicle.position) > 10;
      });
      for (const vehicle of relocated) {
        expect(distance2d(vehicle.position, playerPosition))
          .toBeGreaterThanOrEqual(TRAFFIC_RELEVANCE_RADII.minimumSpawnDistance - 0.2);
      }
      for (let firstIndex = 0; firstIndex < snapshot.length; firstIndex += 1) {
        for (let secondIndex = firstIndex + 1; secondIndex < snapshot.length; secondIndex += 1) {
          const firstVehicle = snapshot[firstIndex];
          const secondVehicle = snapshot[secondIndex];
          if (!firstVehicle || !secondVehicle) continue;
          expect(distance2d(firstVehicle.position, secondVehicle.position))
            .toBeGreaterThanOrEqual(TRAFFIC_RELEVANCE_RADII.minimumVehicleSpacing - 0.2);
        }
      }
      previous = new Map(snapshot.map((vehicle) => [vehicle.id, vehicle]));
    }
  });

  it('yields deterministically at intersections and avoids deadlock in a five-minute soak', () => {
    const crossingRoads: readonly SimulationRoadRecipe[] = [
      {
        id: 'major-vertical', district: 'arroyo-heights',
        position: { x: 0, y: 0, z: 0 }, width: 18, depth: 600, major: true,
      },
      {
        id: 'local-horizontal', district: 'arroyo-heights',
        position: { x: 0, y: 0, z: 0 }, width: 600, depth: 18,
      },
    ];
    const traffic = new TrafficSystem(new SimulationRandom('five-minute-traffic-soak'), 'low', crossingRoads);
    const stationarySeconds = new Map<string, number>();
    const maximumStationarySeconds = new Map<string, number>();
    const signalStationarySeconds = new Map<string, number>();
    let maximumSignalStationarySeconds = 0;
    let longestNonSignalStop: unknown = null;
    let sawIntersectionYield = false;
    let sawSignalYield = false;
    for (let frame = 0; frame < 3_000; frame += 1) {
      const playerPosition = {
        x: Math.sin(frame / 180) * 80,
        y: 0,
        z: 0,
      };
      traffic.tick({
        deltaSeconds: 0.1,
        playerPosition,
        sirenPosition: null,
        sirenRadius: 0,
        obstructions: [],
      });
      for (const vehicle of traffic.getSnapshot()) {
        sawIntersectionYield ||= vehicle.behavior === 'intersection-yield';
        sawSignalYield ||= vehicle.behavior === 'signal-yield';
        const signalStationary = (
          vehicle.behavior === 'signal-yield'
          && Math.abs(vehicle.speed) < 0.1
        )
          ? (signalStationarySeconds.get(vehicle.id) ?? 0) + 0.1
          : 0;
        signalStationarySeconds.set(vehicle.id, signalStationary);
        maximumSignalStationarySeconds = Math.max(
          maximumSignalStationarySeconds,
          signalStationary,
        );
        const stationary = (
          vehicle.behavior !== 'signal-yield'
          && Math.abs(vehicle.speed) < 0.1
        )
          ? (stationarySeconds.get(vehicle.id) ?? 0) + 0.1
          : 0;
        stationarySeconds.set(vehicle.id, stationary);
        maximumStationarySeconds.set(
          vehicle.id,
          Math.max(maximumStationarySeconds.get(vehicle.id) ?? 0, stationary),
        );
        if (
          stationary
            >= Math.max(...maximumStationarySeconds.values())
        ) {
          longestNonSignalStop = {
            frame,
            stationary,
            vehicle,
            nearby: traffic.getSnapshot(),
            signal: traffic.getTrafficSignalSnapshot().junctions[0],
          };
        }
        expect(Number.isFinite(vehicle.position.x)).toBe(true);
        expect(Number.isFinite(vehicle.position.z)).toBe(true);
      }
    }
    expect(sawIntersectionYield).toBe(true);
    expect(sawSignalYield).toBe(true);
    expect(
      Math.max(...maximumStationarySeconds.values()),
      JSON.stringify(longestNonSignalStop),
    ).toBeLessThan(3);
    expect(maximumSignalStationarySeconds)
      .toBeLessThan(TRAFFIC_SIGNAL_TIMING.cycleSeconds);
  });

  it('stops on red before the bar and releases the same traffic on green', () => {
    const crossingRoads: readonly SimulationRoadRecipe[] = [
      {
        id: 'signal-vertical', district: 'alta-vista',
        position: { x: 0, y: 0, z: 0 }, width: 18, depth: 600, major: true,
      },
      {
        id: 'signal-horizontal', district: 'alta-vista',
        position: { x: 0, y: 0, z: 0 }, width: 600, depth: 18,
      },
    ];
    const traffic = new TrafficSystem(
      new SimulationRandom('signal-obedience'),
      'low',
      crossingRoads,
    );
    const stoppedVehicleIds = new Set<string>();
    let sawReleasedVehicle = false;
    let closestSignalYield = Number.POSITIVE_INFINITY;
    let slowestSignalYield = Number.POSITIVE_INFINITY;

    for (let frame = 0; frame < 900; frame += 1) {
      traffic.tick({
        deltaSeconds: 0.1,
        sirenPosition: null,
        sirenRadius: 0,
        obstructions: [],
      });
      const signal = traffic.getTrafficSignalSnapshot().junctions[0];
      if (!signal) throw new Error('Missing deterministic signal junction');
      expect(
        signal.horizontalAspect === 'green' && signal.verticalAspect === 'green',
      ).toBe(false);

      for (const vehicle of traffic.getSnapshot()) {
        const forward = directionFromHeading(vehicle.heading);
        const ahead = (
          signal.position.x - vehicle.position.x
        ) * forward.x + (
          signal.position.z - vehicle.position.z
        ) * forward.z;
        const aspect = vehicle.roadId === 'signal-horizontal'
          ? signal.horizontalAspect
          : signal.verticalAspect;
        if (vehicle.behavior === 'signal-yield' && ahead > 0) {
          closestSignalYield = Math.min(closestSignalYield, ahead);
          slowestSignalYield = Math.min(slowestSignalYield, Math.abs(vehicle.speed));
        }
        if (
          vehicle.behavior === 'signal-yield'
          && aspect !== 'green'
          && ahead > 0
          && ahead <= 36
        ) {
          expect(ahead).toBeGreaterThanOrEqual(
            TRAFFIC_SIGNAL_STOP_LINE_DISTANCE - 0.03,
          );
          if (Math.abs(vehicle.speed) <= 0.35) {
            stoppedVehicleIds.add(vehicle.id);
          }
        }
        if (
          stoppedVehicleIds.has(vehicle.id)
          && aspect === 'green'
          && vehicle.behavior !== 'signal-yield'
          && vehicle.speed > 1
        ) {
          sawReleasedVehicle = true;
        }
      }
    }

    expect(
      stoppedVehicleIds.size,
      JSON.stringify({ closestSignalYield, slowestSignalYield }),
    ).toBeGreaterThan(0);
    expect(sawReleasedVehicle).toBe(true);
  });

  it('gives opposing through traffic deterministic priority before a permissive left', () => {
    const crossingRoads: readonly SimulationRoadRecipe[] = [
      {
        id: 'left-horizontal',
        position: { x: 0, y: 0, z: 0 },
        width: 600,
        depth: 18,
      },
      {
        id: 'left-vertical',
        position: { x: 0, y: 0, z: 0 },
        width: 18,
        depth: 600,
      },
    ];
    const createScenario = () => {
      const traffic = new TrafficSystem(
        new SimulationRandom('permissive-left-priority'),
        'low',
        crossingRoads,
      );
      traffic.setActorLimit(2);
      const harness = trafficHarness(traffic);
      const horizontalRoadIndex = traffic.roads
        .findIndex(({ id }) => id === 'left-horizontal');
      const verticalRoadIndex = traffic.roads
        .findIndex(({ id }) => id === 'left-vertical');
      const junction = harness.junctionsByRoad[horizontalRoadIndex]?.find(
        ({ position }) => Math.abs(position.x) < 0.01 && Math.abs(position.z) < 0.01,
      );
      const left = harness.agents[0];
      const through = harness.agents[1];
      if (!junction || !left || !through) {
        throw new Error('Missing deterministic permissive-left scenario');
      }
      Object.assign(left, {
        position: { x: -15, y: 0, z: 4.14 },
        roadIndex: horizontalRoadIndex,
        direction: 1,
        laneOffset: 4.14,
        heading: headingFromDirection(1, 0),
        speed: 6,
        cruiseSpeed: 10,
        behavior: 'cruise',
        intersectionWaitSeconds: 0,
        intersectionPriorityRemaining: 0,
        intersectionTicket: 0,
        transitionWaitSeconds: 0,
        lastJunction: null,
        signalPriority: 0,
        permissiveLeftYield: false,
      });
      left.plannedTransition = {
        roadIndex: verticalRoadIndex,
        direction: -1,
        kind: 'left',
        junction,
        triggerAhead: -4.14,
      };
      Object.assign(through, {
        position: { x: 20, y: 0, z: -4.14 },
        roadIndex: horizontalRoadIndex,
        direction: -1,
        laneOffset: -4.14,
        heading: headingFromDirection(-1, 0),
        speed: 8,
        cruiseSpeed: 8,
        behavior: 'cruise',
        intersectionWaitSeconds: 0,
        intersectionPriorityRemaining: 0,
        intersectionTicket: 0,
        transitionWaitSeconds: 0,
        lastJunction: junction,
        plannedTransition: null,
        signalPriority: 0,
        permissiveLeftYield: false,
      });
      return { traffic, junction, leftId: left.id, throughId: through.id };
    };
    const first = createScenario();
    const second = createScenario();
    let sawLeftYield = false;
    let sawThroughClear = false;
    let sawLeftReleaseAfterClear = false;

    for (let frame = 0; frame < 100; frame += 1) {
      const context = {
        deltaSeconds: 0.1,
        sirenPosition: null,
        sirenRadius: 0,
        obstructions: [],
      } as const;
      first.traffic.tick(context);
      second.traffic.tick(context);
      const snapshot = first.traffic.getSnapshot();
      expect(second.traffic.getSnapshot()).toEqual(snapshot);
      expect(first.traffic.getAvoidanceDiagnostics().lastTickCollisionResolutions)
        .toBe(0);
      const left = snapshot.find(({ id }) => id === first.leftId);
      const through = snapshot.find(({ id }) => id === first.throughId);
      if (!left || !through) throw new Error('Missing permissive-left actors');
      const leftDirection = directionFromHeading(left.heading);
      const throughDirection = directionFromHeading(through.heading);
      const leftAhead = (
        first.junction.position.x - left.position.x
      ) * leftDirection.x + (
        first.junction.position.z - left.position.z
      ) * leftDirection.z;
      const throughAhead = (
        first.junction.position.x - through.position.x
      ) * throughDirection.x + (
        first.junction.position.z - through.position.z
      ) * throughDirection.z;
      sawLeftYield ||= left.behavior === 'signal-yield';
      sawThroughClear ||= throughAhead < -3.6;
      if (!sawThroughClear) {
        expect(leftAhead).toBeGreaterThanOrEqual(
          TRAFFIC_SIGNAL_STOP_LINE_DISTANCE - 0.1,
        );
      } else if (
        left.roadId === 'left-vertical'
        || leftAhead < TRAFFIC_SIGNAL_STOP_LINE_DISTANCE - 0.5
      ) {
        sawLeftReleaseAfterClear = true;
      }
    }

    expect(sawLeftYield).toBe(true);
    expect(sawThroughClear).toBe(true);
    expect(sawLeftReleaseAfterClear).toBe(true);
  });

  it.each(['low', 'high'] as const)(
    'keeps the exact production-seed %s pool collision-free for five minutes',
    (quality) => {
      const layout = generateCity(PRODUCTION_WORLD_SEED, quality);
      const citySeed = simulationSeed(`${layout.seed}:city-life`);
      const createTraffic = (roads: readonly SimulationRoadRecipe[]) => new TrafficSystem(
        new SimulationRandom((citySeed ^ TRAFFIC_RANDOM_SALT) >>> 0),
        quality,
        roads,
      );
      const first = createTraffic(layout.roads);
      const second = createTraffic([...layout.roads].reverse());
      const previousPositions = new Map(first.getSnapshot().map((vehicle) => [
        vehicle.id,
        { ...vehicle.position },
      ]));
      const stationarySeconds = new Map<string, number>();
      let maximumStationarySeconds = 0;
      const signalStationarySeconds = new Map<string, number>();
      let maximumSignalStationarySeconds = 0;
      let minimumPairClearance = Number.POSITIVE_INFINITY;
      let maximumPairChecks = 0;
      let closestPair = '';
      let longestNonSignalStop = '';

      for (let frame = 0; frame < 3_000; frame += 1) {
        const context = {
          deltaSeconds: 0.1,
          playerPosition: PLAYER_SPAWN,
          sirenPosition: null,
          sirenRadius: 0,
          obstructions: [],
        } as const;
        first.tick(context);
        second.tick(context);
        const snapshot = first.getSnapshot();
        maximumPairChecks = Math.max(
          maximumPairChecks,
          first.getAvoidanceDiagnostics().lastTickPairChecks,
        );

        for (let firstIndex = 0; firstIndex < snapshot.length; firstIndex += 1) {
          const vehicle = snapshot[firstIndex];
          if (!vehicle) continue;
          const previous = previousPositions.get(vehicle.id);
          const signalStationary = (
            vehicle.behavior === 'signal-yield'
            && previous
            && distance2d(previous, vehicle.position) < 0.01
          )
            ? (signalStationarySeconds.get(vehicle.id) ?? 0) + 0.1
            : 0;
          signalStationarySeconds.set(vehicle.id, signalStationary);
          maximumSignalStationarySeconds = Math.max(
            maximumSignalStationarySeconds,
            signalStationary,
          );
          const stationary = (
            vehicle.behavior !== 'signal-yield'
            && previous
            && distance2d(previous, vehicle.position) < 0.01
          )
            ? (stationarySeconds.get(vehicle.id) ?? 0) + 0.1
            : 0;
          stationarySeconds.set(vehicle.id, stationary);
          if (stationary > maximumStationarySeconds) {
            maximumStationarySeconds = stationary;
            longestNonSignalStop = JSON.stringify({
              frame,
              stationary,
              vehicle,
              nearby: snapshot.filter((other) => (
                distance2d(other.position, vehicle.position) < 18
              )),
              nearestSignal: first.getTrafficSignalSnapshot().junctions
                .map((signal) => ({
                  signal,
                  distance: distance2d(signal.position, vehicle.position),
                }))
                .sort((left, right) => left.distance - right.distance)[0],
            });
          }
          previousPositions.set(vehicle.id, { ...vehicle.position });

          for (let secondIndex = firstIndex + 1; secondIndex < snapshot.length; secondIndex += 1) {
            const other = snapshot[secondIndex];
            if (!other) continue;
            const pairDistance = distance2d(vehicle.position, other.position);
            const pairClearance = pairDistance
              - vehicleCollisionRadius(vehicle.classId)
              - vehicleCollisionRadius(other.classId);
            if (pairClearance < minimumPairClearance) {
              minimumPairClearance = pairClearance;
              closestPair = JSON.stringify({
                time: (frame + 1) * 0.1,
                distance: pairDistance,
                clearance: pairClearance,
                first: vehicle,
                second: other,
              });
            }
          }
        }
        if (frame % 300 === 299) expect(second.getSnapshot()).toEqual(snapshot);
      }

      expect(minimumPairClearance, closestPair).toBeGreaterThanOrEqual(-0.02);
      expect(maximumStationarySeconds, longestNonSignalStop).toBeLessThan(5);
      expect(maximumSignalStationarySeconds)
        .toBeLessThan(TRAFFIC_SIGNAL_TIMING.cycleSeconds);
      expect(maximumPairChecks).toBeLessThanOrEqual(
        TRAFFIC_AVOIDANCE_PAIR_BUDGET_PER_TICK,
      );
    },
  );
});
