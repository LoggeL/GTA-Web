import { describe, expect, it } from 'vitest';

import { generateCity } from '../../src/game/city';
import { buildRoadGraph } from '../../src/navigation/road-graph';
import { distance2d } from '../../src/simulation/math';
import { SimulationRandom } from '../../src/simulation/random';
import { TrafficSystem } from '../../src/simulation/traffic';
import type {
  SimulationRoadRecipe,
  SimulationVec3,
} from '../../src/simulation/types';

function roadPairKey(firstId: string, secondId: string): string {
  return firstId < secondId ? `${firstId}|${secondId}` : `${secondId}|${firstId}`;
}

function roadIsVertical(road: Readonly<SimulationRoadRecipe>): boolean {
  return road.depth > road.width;
}

function sharedJunctions(
  roads: readonly SimulationRoadRecipe[],
): ReadonlyMap<string, readonly SimulationVec3[]> {
  const graph = buildRoadGraph({
    roads: roads.map((road) => ({
      ...road,
      district: road.district ?? 'arroyo-heights',
      major: Boolean(road.major),
    })),
  });
  const byPair = new Map<string, SimulationVec3[]>();
  for (const node of graph.nodes) {
    for (let firstIndex = 0; firstIndex < node.roadIds.length; firstIndex += 1) {
      const firstId = node.roadIds[firstIndex];
      if (!firstId) continue;
      for (let secondIndex = firstIndex + 1; secondIndex < node.roadIds.length; secondIndex += 1) {
        const secondId = node.roadIds[secondIndex];
        if (!secondId) continue;
        const key = roadPairKey(firstId, secondId);
        const points = byPair.get(key) ?? [];
        points.push({ x: node.position.x, y: 0, z: node.position.z });
        byPair.set(key, points);
      }
    }
  }
  return byPair;
}

describe('Solara lane-graph traffic route', () => {
  it('routes the fixed pool through connected roads without deadlock for five minutes', () => {
    const city = generateCity('m3-real-solara-traffic-route', 'high');
    const traffic = new TrafficSystem(
      new SimulationRandom('m3-real-solara-traffic-route'),
      'high',
      city.roads,
    );
    const deterministicTwin = new TrafficSystem(
      new SimulationRandom('m3-real-solara-traffic-route'),
      'high',
      [...city.roads].reverse(),
    );
    const roadsById = new Map(traffic.roads.map((road) => [road.id, road]));
    const junctionsByRoadPair = sharedJunctions(traffic.roads);
    const initial = traffic.getSnapshot();
    const expectedIds = initial.map(({ id }) => id);
    const initialClassById = new Map(initial.map(({ id, classId }) => [id, classId]));
    const previousById = new Map(initial.map((vehicle) => [vehicle.id, vehicle]));
    const stationarySeconds = new Map<string, number>();
    const maximumStationarySeconds = new Map<string, number>();
    const recoverySeconds = new Map<string, number>();
    const maximumRecoverySeconds = new Map<string, number>();
    const distanceTravelled = new Map<string, number>();
    const roadsVisitedById = new Map(
      initial.map(({ id, roadId }) => [id, new Set([roadId])]),
    );
    const allVisitedRoads = new Set(initial.map(({ roadId }) => roadId));

    let poolStayedInvariant = true;
    let classesStayedInvariant = true;
    let allValuesStayedFinite = true;
    let allPositionsStayedInCity = true;
    let allTransitionsWereConnected = true;
    let allTransitionsReachedTheirJunction = true;
    let maximumFrameDisplacement = 0;
    let connectedTransitions = 0;
    let perpendicularTransitions = 0;
    let sawIntersectionYield = false;
    let globalStationarySeconds = 0;
    let maximumGlobalStationarySeconds = 0;

    for (let frame = 0; frame < 3_000; frame += 1) {
      const tick = {
        deltaSeconds: 0.1,
        sirenPosition: null,
        sirenRadius: 0,
        obstructions: [],
      } as const;
      traffic.tick(tick);
      deterministicTwin.tick(tick);
      const snapshot = traffic.getSnapshot();
      poolStayedInvariant &&= snapshot.length === 42
        && snapshot.map(({ id }) => id).every((id, index) => id === expectedIds[index]);

      let frameDistance = 0;
      for (const vehicle of snapshot) {
        const previous = previousById.get(vehicle.id);
        if (!previous) {
          poolStayedInvariant = false;
          continue;
        }
        const frameDisplacement = distance2d(previous.position, vehicle.position);
        frameDistance += frameDisplacement;
        maximumFrameDisplacement = Math.max(maximumFrameDisplacement, frameDisplacement);
        distanceTravelled.set(
          vehicle.id,
          (distanceTravelled.get(vehicle.id) ?? 0) + frameDisplacement,
        );
        classesStayedInvariant &&= vehicle.classId === initialClassById.get(vehicle.id);
        allValuesStayedFinite &&= [
          vehicle.position.x,
          vehicle.position.y,
          vehicle.position.z,
          vehicle.heading,
          vehicle.speed,
          vehicle.panicRemaining,
        ].every(Number.isFinite);
        allPositionsStayedInCity &&= Math.abs(vehicle.position.x) <= 601
          && Math.abs(vehicle.position.z) <= 601;
        sawIntersectionYield ||= vehicle.behavior === 'intersection-yield';

        const stationary = Math.abs(vehicle.speed) < 0.1
          ? (stationarySeconds.get(vehicle.id) ?? 0) + 0.1
          : 0;
        stationarySeconds.set(vehicle.id, stationary);
        maximumStationarySeconds.set(
          vehicle.id,
          Math.max(maximumStationarySeconds.get(vehicle.id) ?? 0, stationary),
        );
        const recovering = vehicle.behavior === 'recover'
          ? (recoverySeconds.get(vehicle.id) ?? 0) + 0.1
          : 0;
        recoverySeconds.set(vehicle.id, recovering);
        maximumRecoverySeconds.set(
          vehicle.id,
          Math.max(maximumRecoverySeconds.get(vehicle.id) ?? 0, recovering),
        );

        roadsVisitedById.get(vehicle.id)?.add(vehicle.roadId);
        allVisitedRoads.add(vehicle.roadId);
        if (vehicle.roadId !== previous.roadId) {
          connectedTransitions += 1;
          const previousRoad = roadsById.get(previous.roadId);
          const currentRoad = roadsById.get(vehicle.roadId);
          const shared = junctionsByRoadPair.get(roadPairKey(previous.roadId, vehicle.roadId));
          allTransitionsWereConnected &&= previousRoad !== undefined
            && currentRoad !== undefined
            && shared !== undefined
            && shared.length > 0;
          if (previousRoad && currentRoad && roadIsVertical(previousRoad) !== roadIsVertical(currentRoad)) {
            perpendicularTransitions += 1;
          }
          allTransitionsReachedTheirJunction &&= shared?.some((junction) =>
            distance2d(previous.position, junction) <= 16
            && distance2d(vehicle.position, junction) <= 16) ?? false;
        }
        previousById.set(vehicle.id, vehicle);
      }

      globalStationarySeconds = frameDistance < 0.01 ? globalStationarySeconds + 0.1 : 0;
      maximumGlobalStationarySeconds = Math.max(
        maximumGlobalStationarySeconds,
        globalStationarySeconds,
      );
      if (frame % 300 === 299) {
        expect(deterministicTwin.getSnapshot()).toEqual(snapshot);
      }
    }

    expect(poolStayedInvariant).toBe(true);
    expect(classesStayedInvariant).toBe(true);
    expect(allValuesStayedFinite).toBe(true);
    expect(allPositionsStayedInCity).toBe(true);
    expect(allTransitionsWereConnected).toBe(true);
    expect(allTransitionsReachedTheirJunction).toBe(true);
    expect(maximumFrameDisplacement).toBeLessThan(3);
    expect(connectedTransitions).toBeGreaterThan(100);
    expect(perpendicularTransitions).toBeGreaterThan(20);
    expect(sawIntersectionYield).toBe(true);
    expect(allVisitedRoads.size).toBeGreaterThan(30);
    expect(Math.min(...[...roadsVisitedById.values()].map((roads) => roads.size))).toBeGreaterThan(1);
    expect(Math.min(...distanceTravelled.values())).toBeGreaterThan(500);
    expect(Math.max(...maximumStationarySeconds.values())).toBeLessThan(3);
    expect(Math.max(...maximumRecoverySeconds.values())).toBeLessThanOrEqual(1);
    expect(maximumGlobalStationarySeconds).toBeLessThan(1);
  });
});
