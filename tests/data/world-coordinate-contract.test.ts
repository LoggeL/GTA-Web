import { describe, expect, it } from 'vitest';

import {
  SOLARA_DISTRICTS,
  SOLARA_DISTRICT_IDS,
  SOLARA_GAMEPLAY_ANCHORS,
  createInitialSaveGame,
  resolveSolaraActivityMarker,
  resolveSolaraActivityTarget,
  resolveSolaraMissionTarget,
  resolveSolaraRoadPosition,
  resolveSolaraSidewalkPosition,
  solaraDistrictAt,
} from '../../src/core';
import { ACTIVITIES, COLLECTIBLES, MISSIONS } from '../../src/data';
import type { DistrictId, MissionDefinition, ObjectiveDefinition } from '../../src/data/types';
import { districtAt, generateCity, PLAYER_SPAWN } from '../../src/game/city';
import { circleIntersectsBuildings } from '../../src/game/collision';
import type { CityLayout, PropKind, PropRecipe } from '../../src/game/city';
import { createActivityVariant } from '../../src/systems/activities';

const PRODUCTION_CITY_SEED = 'heatline-solara-world-v1';
const PLAYER_RADIUS = 0.58;

const PROP_FOOTPRINT_HALF_EXTENTS = {
  palm: { along: 0.17, lateral: 0.17 },
  streetlight: { along: 0.065, lateral: 0.065 },
  tree: { along: 0.225, lateral: 0.225 },
  container: { along: 2.9, lateral: 1.225 },
  bollard: { along: 0.11, lateral: 0.11 },
  bench: { along: 1.2, lateral: 0.39 },
  planter: { along: 0.625, lateral: 0.625 },
  kiosk: { along: 1.45, lateral: 1.125 },
  'market-stall': { along: 1.7, lateral: 1.15 },
  'transit-shelter': { along: 2, lateral: 0.8 },
  sculpture: { along: 1.12, lateral: 1.12 },
  'cargo-pallet': { along: 1.175, lateral: 0.925 },
  'pipe-stack': { along: 1.35, lateral: 0.725 },
} as const satisfies Readonly<Record<PropKind, {
  readonly along: number;
  readonly lateral: number;
}>>;

interface AuditedPoint {
  readonly id: string;
  readonly district: DistrictId;
  readonly x: number;
  readonly z: number;
}

function propIntersectsPlayer(point: Readonly<AuditedPoint>, prop: Readonly<PropRecipe>): boolean {
  const footprint = PROP_FOOTPRINT_HALF_EXTENTS[prop.kind];
  const vertical = Math.abs(Math.sin(prop.rotation)) > 0.5;
  const halfX = (vertical ? footprint.lateral : footprint.along) * prop.scale;
  const halfZ = (vertical ? footprint.along : footprint.lateral) * prop.scale;
  const closestX = Math.max(
    prop.position.x - halfX,
    Math.min(point.x, prop.position.x + halfX),
  );
  const closestZ = Math.max(
    prop.position.z - halfZ,
    Math.min(point.z, prop.position.z + halfZ),
  );
  return (point.x - closestX) ** 2 + (point.z - closestZ) ** 2
    < PLAYER_RADIUS ** 2;
}

function expectPointIsProductionSafe(
  point: Readonly<AuditedPoint>,
  layout: Readonly<CityLayout>,
): void {
  expect(Number.isFinite(point.x), point.id).toBe(true);
  expect(Number.isFinite(point.z), point.id).toBe(true);
  expect(point.x, point.id).toBeGreaterThanOrEqual(-600 + PLAYER_RADIUS);
  expect(point.x, point.id).toBeLessThanOrEqual(600 - PLAYER_RADIUS);
  expect(point.z, point.id).toBeGreaterThanOrEqual(-600 + PLAYER_RADIUS);
  expect(point.z, point.id).toBeLessThanOrEqual(600 - PLAYER_RADIUS);
  expect(solaraDistrictAt(point.x, point.z), point.id).toBe(point.district);
  expect(districtAt(point.x, point.z), point.id).toBe(point.district);
  expect(
    circleIntersectsBuildings(point.x, point.z, PLAYER_RADIUS, layout.collisions),
    `${point.id} intersects production collision`,
  ).toBe(false);
  expect(
    layout.props.some((prop) => propIntersectsPlayer(point, prop)),
    `${point.id} intersects production prop footprint`,
  ).toBe(false);
}

function checkpointForObjective(
  definition: Readonly<MissionDefinition>,
  objective: Readonly<ObjectiveDefinition>,
) {
  const objectiveIndex = Math.max(
    0,
    definition.objectives.findIndex((entry) => entry.id === objective.id),
  );
  const checkpointIndex = Math.min(
    definition.checkpoints.length - 1,
    Math.floor(
      objectiveIndex * definition.checkpoints.length
      / Math.max(1, definition.objectives.length),
    ),
  );
  return {
    objectiveIndex,
    checkpoint: definition.checkpoints[Math.max(0, checkpointIndex)],
  };
}

function missionTargetPoints(): readonly AuditedPoint[] {
  return MISSIONS.flatMap((definition) => definition.objectives
    .filter((objective) => objective.completion.kind !== 'choice-made'
      && objective.completion.kind !== 'composite')
    .flatMap((objective) => {
    const { objectiveIndex, checkpoint } = checkpointForObjective(definition, objective);
    const base = definition.id === 'past-due' && objectiveIndex === 0
      ? { x: PLAYER_SPAWN.x, z: PLAYER_SPAWN.z }
      : checkpoint?.respawn ?? SOLARA_GAMEPLAY_ANCHORS[definition.district];
    const district = checkpoint?.respawn.district ?? definition.district;
    const targetCount = objective.completion.kind === 'all-targets'
      ? objective.targetIds.length
      : objective.completion.kind === 'target-count'
        ? objective.completion.required
        : 1;
    return Array.from({ length: targetCount }, (_, targetIndex) => {
      const targetId = objective.targetIds[
        targetIndex % Math.max(1, objective.targetIds.length)
      ] ?? objective.id;
      return {
      id: `mission-target:${definition.id}:${objective.id}:${targetId}:${targetIndex}`,
      district,
      ...resolveSolaraMissionTarget({
        district,
        missionId: definition.id,
        objectiveId: objective.id,
        objectiveIndex,
        targetIndex,
        base,
      }),
      };
    });
  }));
}

function activityTargetPoints(): readonly AuditedPoint[] {
  const points: AuditedPoint[] = [];
  for (const slotId of [1, 2, 3] as const) {
    const worldSeed = createInitialSaveGame(slotId, 'masculine').trafficSeed;
    for (const definition of ACTIVITIES) {
      for (const difficulty of definition.difficulties) {
        for (let attempt = 0; attempt < definition.variantCount; attempt += 1) {
          const run = createActivityVariant(
            definition,
            difficulty.id,
            worldSeed,
            attempt,
          );
          for (let step = 0; step < run.objectiveTemplate.length; step += 1) {
            points.push({
              id: `activity-target:${slotId}:${run.runId}:${step}`,
              district: run.district,
              ...resolveSolaraActivityTarget(run.district, run.seed, step),
            });
          }
        }
      }
    }
  }
  return points;
}

describe('canonical Solara authored-coordinate contract', () => {
  it('owns one canonical quadrant and gameplay-anchor definition', () => {
    expect(SOLARA_DISTRICT_IDS).toEqual([
      'neon-strand',
      'alta-vista',
      'arroyo-heights',
      'breakwater',
    ]);
    for (const district of SOLARA_DISTRICT_IDS) {
      const definition = SOLARA_DISTRICTS[district];
      const anchor = SOLARA_GAMEPLAY_ANCHORS[district];
      expect(anchor).toBe(definition.gameplayAnchor);
      expect(solaraDistrictAt(anchor.x, anchor.z)).toBe(district);
      expect(districtAt(anchor.x, anchor.z)).toBe(district);
    }
  });

  it('normalizes road and sidewalk candidates deterministically into their declared district', () => {
    for (const district of SOLARA_DISTRICT_IDS) {
      const legacy = { x: 137.25, z: 219.75 };
      const road = resolveSolaraRoadPosition(district, legacy, 42);
      const sidewalk = resolveSolaraSidewalkPosition(district, legacy, 42);
      expect(resolveSolaraRoadPosition(district, legacy, 42)).toEqual(road);
      expect(resolveSolaraSidewalkPosition(district, legacy, 42)).toEqual(sidewalk);
      expect(solaraDistrictAt(road.x, road.z)).toBe(district);
      expect(solaraDistrictAt(sidewalk.x, sidewalk.z)).toBe(district);
      expect(road).not.toEqual(sidewalk);
    }
  });

  it('places all 60 seeded collectibles uniquely in their declared production-safe districts', () => {
    expect(COLLECTIBLES).toHaveLength(60);
    expect(new Set(COLLECTIBLES.map(
      (definition) => `${definition.position.x}:${definition.position.z}`,
    )).size).toBe(60);

    for (const quality of ['low', 'high'] as const) {
      const layout = generateCity(PRODUCTION_CITY_SEED, quality);
      for (const definition of COLLECTIBLES) {
        expect(definition.position.district).toBe(definition.district);
        expectPointIsProductionSafe({
          id: `collectible:${definition.id}:${quality}`,
          district: definition.district,
          x: definition.position.x,
          z: definition.position.z,
        }, layout);
      }
    }
  });

  it('places all 37 mission checkpoints in collision-clear same-district lanes', () => {
    const checkpoints = MISSIONS.flatMap((mission) => mission.checkpoints.map((checkpoint) => ({
      id: `checkpoint:${checkpoint.id}`,
      district: checkpoint.respawn.district,
      x: checkpoint.respawn.x,
      z: checkpoint.respawn.z,
    })));
    expect(checkpoints).toHaveLength(37);
    for (const quality of ['low', 'high'] as const) {
      const layout = generateCity(PRODUCTION_CITY_SEED, quality);
      for (const point of checkpoints) expectPointIsProductionSafe(point, layout);
    }
  });

  it('places every one of the 119 authored mission world targets safely', () => {
    const points = missionTargetPoints();
    expect(points).toHaveLength(119);
    for (const quality of ['low', 'high'] as const) {
      const layout = generateCity(PRODUCTION_CITY_SEED, quality);
      for (const point of points) expectPointIsProductionSafe(point, layout);
    }
  });

  it('places all five activity markers and 1,116 variant steps safely', () => {
    const markers = ACTIVITIES.map((definition, index) => {
      const district = definition.districts[0];
      if (district === undefined) throw new Error(`${definition.id} has no district`);
      return {
        id: `activity-marker:${definition.id}`,
        district,
        ...resolveSolaraActivityMarker(district, index),
      };
    });
    const targets = activityTargetPoints();
    expect(markers).toHaveLength(5);
    expect(targets).toHaveLength(1_116);
    for (const quality of ['low', 'high'] as const) {
      const layout = generateCity(PRODUCTION_CITY_SEED, quality);
      for (const point of [...markers, ...targets]) {
        expectPointIsProductionSafe(point, layout);
      }
    }
  });
});
