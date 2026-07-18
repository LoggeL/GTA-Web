import { InstancedMesh, Matrix4 } from 'three';
import { describe, expect, it } from 'vitest';

import {
  DISTRICTS,
  PLAYER_SPAWN,
  generateCity,
} from '../../src/game/city';
import type {
  BuildingRecipe,
  PropKind,
  PropRecipe,
} from '../../src/game/city';
import { circleIntersectsBuildings } from '../../src/game/collision';
import { AUTHORED_INTERIORS } from '../../src/game/InteriorRuntime';
import { PLAYER_RADIUS } from '../../src/game/player';
import { AvatarVisual, createCityVisuals } from '../../src/game/visuals';
import { cellIdAt } from '../../src/navigation/cells';
import { PedestrianSystem } from '../../src/simulation/pedestrians';
import { SimulationRandom, simulationSeed } from '../../src/simulation/random';

const FULL_DENSITY = {
  roads: 1,
  structures: 1,
  props: 1,
  actors: 1,
  shadows: 1,
} as const;

const LONG_X_PROP_KINDS = new Set<PropKind>([
  'container',
  'bench',
  'market-stall',
  'transit-shelter',
]);

const PRODUCTION_WORLD_SEED = 'heatline-solara-world-v1';
const SAVE_SLOT_WORLD_SEEDS = [
  PRODUCTION_WORLD_SEED,
  'slot-1-1721300400000',
  'slot-2-1721300400001',
  'slot-3-1721300400002',
  // Formerly overlapped the command-tower host in low quality.
  'shop-audit-133',
] as const;
const PEDESTRIAN_SIDEWALK_MAX_EDGE_CLEARANCE = 4.4;
const PEDESTRIAN_FOOTPRINT_RADIUS = 0.32;
const PEDESTRIAN_PROP_MARGIN = 0.18;
const WIDE_SOLID_PROP_KINDS = new Set<PropKind>([
  'container',
  'bench',
  'market-stall',
  'transit-shelter',
]);
const PROP_FOOTPRINTS = {
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
} as const satisfies Readonly<Record<
  PropKind,
  { readonly along: number; readonly lateral: number }
>>;

function propIndex(propId: string): number {
  const index = Number(propId.slice(propId.lastIndexOf('-') + 1));
  if (!Number.isInteger(index)) {
    throw new Error(`Expected a numeric prop index in ${propId}`);
  }
  return index;
}

function propRoadSlot(propId: string): {
  readonly verticalRoad: boolean;
  readonly roadIndex: number;
} {
  const index = propIndex(propId);
  return {
    verticalRoad: index % 2 === 0,
    roadIndex: Math.floor(index / 2) % 6,
  };
}

function propIntersectsPedestrian(
  prop: Readonly<PropRecipe>,
  pedestrian: { readonly position: { readonly x: number; readonly z: number } },
): boolean {
  const { verticalRoad } = propRoadSlot(prop.id);
  const footprint = PROP_FOOTPRINTS[prop.kind];
  const deltaX = Math.abs(pedestrian.position.x - prop.position.x);
  const deltaZ = Math.abs(pedestrian.position.z - prop.position.z);
  const along = verticalRoad ? deltaZ : deltaX;
  const lateral = verticalRoad ? deltaX : deltaZ;
  return (
    along < footprint.along * prop.scale + PEDESTRIAN_FOOTPRINT_RADIUS
    && lateral < footprint.lateral * prop.scale + PEDESTRIAN_FOOTPRINT_RADIUS
  );
}

const ALL_LOCAL_ROAD_SLOTS = Array.from(
  { length: 6 },
  (_, roadIndex) => [`h-${roadIndex}`, `v-${roadIndex}`] as const,
).flat().sort();

const DISTRICT_SIGNATURES = {
  'neon-strand': {
    facade: 'art-deco',
    storefront: 'awning',
    landmarkRoof: 'neon-crown',
    props: ['palm', 'streetlight', 'bench', 'planter', 'kiosk'],
  },
  'alta-vista': {
    facade: 'glass-grid',
    storefront: 'lobby',
    landmarkRoof: 'antenna',
    props: ['streetlight', 'tree', 'planter', 'transit-shelter', 'sculpture', 'bench'],
  },
  'arroyo-heights': {
    facade: 'stucco-arcade',
    storefront: 'arcade',
    landmarkRoof: 'water-tank',
    props: ['tree', 'planter', 'market-stall', 'bench', 'kiosk', 'streetlight'],
  },
  breakwater: {
    facade: 'warehouse-bay',
    storefront: 'loading-bay',
    landmarkRoof: 'gantry',
    props: ['container', 'bollard', 'cargo-pallet', 'pipe-stack', 'streetlight'],
  },
} as const satisfies Readonly<Record<
  BuildingRecipe['district'],
  {
    readonly facade: BuildingRecipe['facadeStyle'];
    readonly storefront: BuildingRecipe['storefrontStyle'];
    readonly landmarkRoof: BuildingRecipe['roofFeature'];
    readonly props: readonly PropKind[];
  }
>>;

describe('district city enrichment', () => {
  it('keeps enriched architecture and street dressing deterministic', () => {
    const first = generateCity('district-enrichment', 'high');
    const second = generateCity('district-enrichment', 'high');
    const different = generateCity('district-enrichment-alt', 'high');

    expect(first.buildings).toEqual(second.buildings);
    expect(first.props).toEqual(second.props);
    expect(first.buildings).not.toEqual(different.buildings);
    expect(first.props).not.toEqual(different.props);
  });

  it('gives every district a readable façade, roof, storefront, and prop identity', () => {
    const layout = generateCity('district-signatures', 'high');

    for (const district of DISTRICTS) {
      const signature = DISTRICT_SIGNATURES[district.id];
      const buildings = layout.buildings.filter(
        (building) => building.district === district.id,
      );
      const props = layout.props.filter((prop) => prop.district === district.id);
      const propKinds = new Set(props.map((prop) => prop.kind));
      const landmark = buildings.find((building) => building.landmark);

      expect(buildings).toHaveLength(75);
      expect(new Set(buildings.map((building) => building.facadeStyle))).toEqual(
        new Set([signature.facade]),
      );
      expect(new Set(buildings.map((building) => building.storefrontStyle))).toEqual(
        new Set([signature.storefront]),
      );
      expect(new Set(buildings.map((building) => building.roofStyle)).size).toBeGreaterThanOrEqual(3);
      expect(new Set(buildings.map((building) => building.roofFeature)).size).toBeGreaterThanOrEqual(3);
      expect(new Set(buildings.map((building) => building.frontage)).size).toBe(4);
      expect(new Set(buildings.map((building) => building.accentColor)).size).toBeGreaterThan(1);
      expect(new Set(buildings.map((building) => building.glassColor)).size).toBeGreaterThan(1);
      expect(landmark?.roofFeature).toBe(signature.landmarkRoof);
      expect(props).toHaveLength(88);
      for (const expectedKind of signature.props) {
        expect(propKinds).toContain(expectedKind);
      }
    }
  });

  it.each(['low', 'high'] as const)(
    'keeps every production %s building outside road and sidewalk envelopes',
    (quality) => {
      const layout = generateCity(PRODUCTION_WORLD_SEED, quality);
      const roadEnvelope =
        PEDESTRIAN_SIDEWALK_MAX_EDGE_CLEARANCE
        + PEDESTRIAN_FOOTPRINT_RADIUS
        + PEDESTRIAN_PROP_MARGIN;
      const overlaps: string[] = [];

      for (const building of layout.buildings) {
        const buildingMinX = building.position.x - building.width / 2;
        const buildingMaxX = building.position.x + building.width / 2;
        const buildingMinZ = building.position.z - building.depth / 2;
        const buildingMaxZ = building.position.z + building.depth / 2;
        for (const road of layout.roads) {
          const roadMinX = road.position.x - road.width / 2 - roadEnvelope;
          const roadMaxX = road.position.x + road.width / 2 + roadEnvelope;
          const roadMinZ = road.position.z - road.depth / 2 - roadEnvelope;
          const roadMaxZ = road.position.z + road.depth / 2 + roadEnvelope;
          if (
            buildingMaxX > roadMinX
            && buildingMinX < roadMaxX
            && buildingMaxZ > roadMinZ
            && buildingMinZ < roadMaxZ
          ) {
            overlaps.push(`${building.id}:${road.id}`);
          }
        }
      }

      expect(overlaps).toEqual([]);
    },
  );

  it.each(['low', 'high'] as const)(
    'embeds every authored production %s entrance in its collision-backed host building',
    (quality) => {
      const layout = generateCity(PRODUCTION_WORLD_SEED, quality);

      for (const definition of AUTHORED_INTERIORS) {
        const host = layout.buildings.find(
          ({ id }) => id === definition.portal.attachment.hostBuildingId,
        );
        expect(host, `${definition.portal.id} host building`).toBeDefined();
        expect(host).toMatchObject(definition.exteriorBuilding);
        if (!host) continue;
        const hostMinX = host.position.x - host.width / 2;
        const hostMaxX = host.position.x + host.width / 2;
        const hostMinZ = host.position.z - host.depth / 2;
        const hostMaxZ = host.position.z + host.depth / 2;
        expect(layout.buildings.filter((candidate) => (
          candidate.id !== host.id
          && candidate.position.x + candidate.width / 2 > hostMinX
          && candidate.position.x - candidate.width / 2 < hostMaxX
          && candidate.position.z + candidate.depth / 2 > hostMinZ
          && candidate.position.z - candidate.depth / 2 < hostMaxZ
        )), `${definition.portal.id} overlapping buildings`).toEqual([]);

        const facade = definition.portal.attachment.position;
        const onHostFrontage = host.frontage === 'north'
          ? facade.z === host.position.z - host.depth / 2
          : host.frontage === 'south'
            ? facade.z === host.position.z + host.depth / 2
            : host.frontage === 'west'
              ? facade.x === host.position.x - host.width / 2
              : facade.x === host.position.x + host.width / 2;
        expect(onHostFrontage, `${definition.portal.id} facade`).toBe(true);
        expect(
          circleIntersectsBuildings(
            definition.portal.position.x,
            definition.portal.position.z,
            PLAYER_RADIUS,
            layout.collisions,
          ),
          `${definition.portal.id} actor footprint`,
        ).toBe(false);
        expect(
          circleIntersectsBuildings(
            definition.portal.safeExteriorTransform.position.x,
            definition.portal.safeExteriorTransform.position.z,
            PLAYER_RADIUS,
            layout.collisions,
          ),
          `${definition.portal.id} safe transform`,
        ).toBe(false);
      }
    },
  );

  it.each(['low', 'high'] as const)(
    'reserves every authored %s host footprint across save-slot world seeds',
    (quality) => {
      for (const seed of SAVE_SLOT_WORLD_SEEDS) {
        const layout = generateCity(seed, quality);
        for (const definition of AUTHORED_INTERIORS) {
          const host = layout.buildings.find(
            ({ id }) => id === definition.exteriorBuilding.id,
          );
          expect(host, `${seed}:${definition.id}`).toBeDefined();
          if (!host) continue;
          const hostMinX = host.position.x - host.width / 2;
          const hostMaxX = host.position.x + host.width / 2;
          const hostMinZ = host.position.z - host.depth / 2;
          const hostMaxZ = host.position.z + host.depth / 2;
          const overlaps = layout.buildings.filter((candidate) => (
            candidate.id !== host.id
            && candidate.position.x + candidate.width / 2 > hostMinX
            && candidate.position.x - candidate.width / 2 < hostMaxX
            && candidate.position.z + candidate.depth / 2 > hostMinZ
            && candidate.position.z - candidate.depth / 2 < hostMaxZ
          ));
          expect(overlaps, `${seed}:${definition.id} overlaps`).toEqual([]);
          expect(layout.collisions).toContainEqual({
            id: host.id,
            minX: hostMinX,
            maxX: hostMaxX,
            minZ: hostMinZ,
            maxZ: hostMaxZ,
            height: host.height,
            kind: 'solid',
          });
        }
      }
    },
  );

  it('keeps curb props 3.2 metres beyond both minor and major local-road edges', () => {
    const layouts = (['high', 'low'] as const).map((quality) =>
      generateCity(`district-prop-clearance-${quality}`, quality),
    );
    const coveredRoadClasses = new Set<'major' | 'minor'>();
    const wideKindsSetFartherBack = new Set<PropKind>();

    for (const layout of layouts) {
      for (const prop of layout.props) {
        const district = DISTRICTS.find((candidate) => candidate.id === prop.district);
        expect(district).toBeDefined();
        if (!district) {
          continue;
        }

        const { roadIndex, verticalRoad } = propRoadSlot(prop.id);
        const road = layout.roads.find(
          (candidate) =>
            candidate.id
            === `${prop.district}-road-${verticalRoad ? 'v' : 'h'}-${roadIndex}`,
        );
        expect(road).toBeDefined();
        if (!road) {
          continue;
        }

        const lateralDistance = verticalRoad
          ? Math.abs(prop.position.x - road.position.x)
          : Math.abs(prop.position.z - road.position.z);
        const asphaltHalfWidth = verticalRoad ? road.width / 2 : road.depth / 2;
        const edgeClearance = lateralDistance - asphaltHalfWidth;
        const expectedClearance = Math.max(
          3.2,
          PEDESTRIAN_SIDEWALK_MAX_EDGE_CLEARANCE
            + PEDESTRIAN_FOOTPRINT_RADIUS
            + PEDESTRIAN_PROP_MARGIN
            + PROP_FOOTPRINTS[prop.kind].lateral * prop.scale,
        );

        expect(edgeClearance).toBeGreaterThanOrEqual(3.2 - 1e-9);
        expect(edgeClearance).toBeCloseTo(expectedClearance, 10);
        if (WIDE_SOLID_PROP_KINDS.has(prop.kind)) {
          expect(edgeClearance).toBeGreaterThan(3.2);
          wideKindsSetFartherBack.add(prop.kind);
        }
        coveredRoadClasses.add(road.major ? 'major' : 'minor');
      }
    }

    expect(coveredRoadClasses).toEqual(new Set(['major', 'minor']));
    expect(wideKindsSetFartherBack).toEqual(WIDE_SOLID_PROP_KINDS);
  });

  it.each(['high', 'low'] as const)(
    'dresses all six horizontal and vertical local roads at %s quality',
    (quality) => {
      const layout = generateCity(`district-prop-road-coverage-${quality}`, quality);

      for (const district of DISTRICTS) {
        const roadSlots = new Set(
          layout.props
            .filter((prop) => prop.district === district.id)
            .map((prop) => {
              const { roadIndex, verticalRoad } = propRoadSlot(prop.id);
              return `${verticalRoad ? 'v' : 'h'}-${roadIndex}`;
            }),
        );

        expect([...roadSlots].sort()).toEqual(ALL_LOCAL_ROAD_SLOTS);
        expect(roadSlots).toContain('v-3');
        expect(roadSlots).toContain('h-2');
      }
    },
  );

  it.each(['low', 'high'] as const)(
    'anchors the production %s spawn to the authored Moreno Garage forecourt',
    (quality) => {
      const layout = generateCity(PRODUCTION_WORLD_SEED, quality);
      const garage = AUTHORED_INTERIORS.find(({ id }) => id === 'moreno-garage');
      const host = layout.buildings.find(
        ({ id }) => id === garage?.portal.attachment.hostBuildingId,
      );

      expect(garage).toBeDefined();
      expect(host).toBeDefined();
      expect(Math.hypot(
        (host?.position.x ?? 0) - PLAYER_SPAWN.x,
        (host?.position.z ?? 0) - PLAYER_SPAWN.z,
      )).toBeLessThan(30);
      expect(host).toMatchObject({
        facadeStyle: 'stucco-arcade',
        storefrontStyle: 'arcade',
        roofFeature: 'water-tank',
      });
    },
  );

  it.each(['low', 'high'] as const)(
    'keeps production %s props clear of the pedestrian navigation lane',
    (quality) => {
      const layout = generateCity(PRODUCTION_WORLD_SEED, quality);

      for (const prop of layout.props) {
        const { roadIndex, verticalRoad } = propRoadSlot(prop.id);
        const road = layout.roads.find(
          (candidate) =>
            candidate.id
            === `${prop.district}-road-${verticalRoad ? 'v' : 'h'}-${roadIndex}`,
        );
        expect(road).toBeDefined();
        if (!road) {
          continue;
        }

        const centerDistance = verticalRoad
          ? Math.abs(prop.position.x - road.position.x)
          : Math.abs(prop.position.z - road.position.z);
        const asphaltHalfWidth = verticalRoad ? road.width / 2 : road.depth / 2;
        const footprintInnerEdge =
          centerDistance
          - asphaltHalfWidth
          - PROP_FOOTPRINTS[prop.kind].lateral * prop.scale;
        const clearanceFromPedestrianCenter =
          footprintInnerEdge - PEDESTRIAN_SIDEWALK_MAX_EDGE_CLEARANCE;

        expect(clearanceFromPedestrianCenter).toBeGreaterThanOrEqual(
          PEDESTRIAN_FOOTPRINT_RADIUS + PEDESTRIAN_PROP_MARGIN - 1e-9,
        );
      }
    },
  );

  it.each(['low', 'high'] as const)(
    'avoids production %s pedestrian/prop footprint intersections after 0.30 seconds',
    (quality) => {
      const layout = generateCity(PRODUCTION_WORLD_SEED, quality);
      const cityLifeSeed = simulationSeed(`${layout.seed}:city-life`);
      const pedestrians = new PedestrianSystem(
        new SimulationRandom(cityLifeSeed ^ 0x9a712c),
        quality,
        layout.roads,
        () => undefined,
      );
      for (let tick = 0; tick < 3; tick += 1) {
        pedestrians.tick(0.1, (tick + 1) * 0.1, {
          playerPosition: PLAYER_SPAWN,
        });
      }

      const intersections = pedestrians.getSnapshot().flatMap((pedestrian) =>
        layout.props
          .filter((prop) => propIntersectsPedestrian(prop, pedestrian))
          .map((prop) => `${pedestrian.id}:${prop.id}`),
      );
      expect(intersections).toEqual([]);
    },
  );

  it.each(['low', 'high'] as const)(
    'keeps every rendered production %s prop footprint outside buildings',
    (quality) => {
      const layout = generateCity(PRODUCTION_WORLD_SEED, quality);
      const overlaps: string[] = [];

      for (const prop of layout.props) {
        const { verticalRoad } = propRoadSlot(prop.id);
        const footprint = PROP_FOOTPRINTS[prop.kind];
        const halfX =
          (verticalRoad ? footprint.lateral : footprint.along) * prop.scale;
        const halfZ =
          (verticalRoad ? footprint.along : footprint.lateral) * prop.scale;
        for (const building of layout.buildings) {
          if (
            prop.position.x + halfX + 0.2 > building.position.x - building.width / 2
            && prop.position.x - halfX - 0.2 < building.position.x + building.width / 2
            && prop.position.z + halfZ + 0.2 > building.position.z - building.depth / 2
            && prop.position.z - halfZ - 0.2 < building.position.z + building.depth / 2
          ) {
            overlaps.push(`${prop.id}:${building.id}`);
          }
        }
      }

      expect(overlaps).toEqual([]);
    },
  );

  it.each(['low', 'high'] as const)(
    'keeps rendered production %s prop footprints separated from each other',
    (quality) => {
      const layout = generateCity(PRODUCTION_WORLD_SEED, quality);
      const overlaps: string[] = [];

      for (let firstIndex = 0; firstIndex < layout.props.length; firstIndex += 1) {
        const first = layout.props[firstIndex];
        if (!first) {
          continue;
        }
        const firstVertical = propRoadSlot(first.id).verticalRoad;
        const firstFootprint = PROP_FOOTPRINTS[first.kind];
        const firstHalfX =
          (firstVertical ? firstFootprint.lateral : firstFootprint.along)
          * first.scale;
        const firstHalfZ =
          (firstVertical ? firstFootprint.along : firstFootprint.lateral)
          * first.scale;
        for (
          let secondIndex = firstIndex + 1;
          secondIndex < layout.props.length;
          secondIndex += 1
        ) {
          const second = layout.props[secondIndex];
          if (!second) {
            continue;
          }
          const secondVertical = propRoadSlot(second.id).verticalRoad;
          const secondFootprint = PROP_FOOTPRINTS[second.kind];
          const secondHalfX =
            (secondVertical ? secondFootprint.lateral : secondFootprint.along)
            * second.scale;
          const secondHalfZ =
            (secondVertical ? secondFootprint.along : secondFootprint.lateral)
            * second.scale;
          if (
            Math.abs(first.position.x - second.position.x)
              < firstHalfX + secondHalfX + 0.15
            && Math.abs(first.position.z - second.position.z)
              < firstHalfZ + secondHalfZ + 0.15
          ) {
            overlaps.push(`${first.id}:${second.id}`);
          }
        }
      }

      expect(overlaps).toEqual([]);
    },
  );

  it('aligns long-X containers, benches, stalls, and shelters tangent to their roads', () => {
    const layouts = [
      generateCity('district-prop-tangents-a', 'high'),
      generateCity('district-prop-tangents-b', 'high'),
    ];
    const coveredKinds = new Set<PropKind>();

    for (const prop of layouts.flatMap((layout) => layout.props)) {
      if (!LONG_X_PROP_KINDS.has(prop.kind)) {
        continue;
      }

      const { verticalRoad } = propRoadSlot(prop.id);
      expect(prop.rotation).toBe(verticalRoad ? Math.PI / 2 : 0);
      coveredKinds.add(prop.kind);
    }

    expect(coveredKinds).toEqual(LONG_X_PROP_KINDS);
  });

  it('streams façade and rooftop depth while keeping sidewalks globally bounded', () => {
    const layout = generateCity('district-visual-depth', 'high');
    const landmarkCells = [...new Set(
      layout.buildings
        .filter((building) => building.landmark)
        .map((building) => cellIdAt(building.position)),
    )];
    const visuals = createCityVisuals(layout);

    const snapshot = visuals.applyStreamingState(
      landmarkCells,
      landmarkCells,
      FULL_DENSITY,
    );
    const meshNames: string[] = [];
    const visualLayers = new Set<string>();
    visuals.root.traverse((object) => {
      if (object instanceof InstancedMesh) {
        meshNames.push(object.name);
        const layers = object.userData.visualLayers;
        if (Array.isArray(layers)) {
          for (const layer of layers) {
            if (typeof layer === 'string') visualLayers.add(layer);
          }
        }
      }
    });

    expect(snapshot.residentCellIds).toEqual(
      [...landmarkCells].sort((left, right) => left.localeCompare(right)),
    );
    expect(meshNames).toContain('city-sidewalks');
    expect(visualLayers).toEqual(new Set([
      'shell',
      'storefront',
      'roof-cap',
      'roof-feature',
      'facade-front',
      'facade-side',
      'facade-accent',
      'window-band-low',
      'window-band-high',
    ]));
    expect(
      meshNames.filter((name) => name.startsWith('city-building-')),
    ).toHaveLength(5);
    expect(snapshot.structures.visible).toBeGreaterThan(
      layout.buildings.filter((building) =>
        landmarkCells.includes(cellIdAt(building.position)),
      ).length * 4,
    );

    visuals.dispose();
  });

  it('freezes full-capacity bounds before a reduced-first density transition', () => {
    const layout = generateCity('district-full-capacity-bounds', 'high');
    const activeCellIds = [...new Set(
      layout.buildings
        .filter((building) => building.landmark)
        .map((building) => cellIdAt(building.position)),
    )];
    const visuals = createCityVisuals(layout);

    visuals.applyStreamingState(
      activeCellIds,
      activeCellIds,
      {
        ...FULL_DENSITY,
        structures: 0.25,
        props: 0.25,
      },
    );

    const reducedMeshes: Array<{
      readonly mesh: InstancedMesh;
      readonly fullBound: NonNullable<InstancedMesh['boundingSphere']>;
    }> = [];
    for (const cellId of activeCellIds) {
      visuals.root.getObjectByName(`city-payload:${cellId}`)?.traverse((object) => {
        if (
          !(object instanceof InstancedMesh)
          || object.count >= object.instanceMatrix.count
        ) {
          return;
        }
        expect(object.boundingSphere).not.toBeNull();
        if (object.boundingSphere) {
          reducedMeshes.push({
            mesh: object,
            fullBound: object.boundingSphere.clone(),
          });
        }
      });
    }
    expect(reducedMeshes.length).toBeGreaterThan(0);

    visuals.applyStreamingState(
      activeCellIds,
      activeCellIds,
      FULL_DENSITY,
    );

    const instanceMatrix = new Matrix4();
    for (const { mesh, fullBound } of reducedMeshes) {
      expect(mesh.count).toBe(mesh.instanceMatrix.count);
      expect(mesh.boundingSphere?.center.toArray()).toEqual(
        fullBound.center.toArray(),
      );
      expect(mesh.boundingSphere?.radius).toBe(fullBound.radius);

      const geometryBound = mesh.geometry.boundingSphere;
      expect(geometryBound).not.toBeNull();
      if (!geometryBound) {
        continue;
      }
      for (let index = 0; index < mesh.instanceMatrix.count; index += 1) {
        mesh.getMatrixAt(index, instanceMatrix);
        const instanceBound = geometryBound.clone().applyMatrix4(instanceMatrix);
        expect(
          fullBound.center.distanceTo(instanceBound.center) + instanceBound.radius,
        ).toBeLessThanOrEqual(fullBound.radius + 1e-5);
      }
    }

    visuals.dispose();
  });

  it('gives Alex a layered silhouette whose hands and shoes follow animated limbs', () => {
    const avatar = new AvatarVisual();

    expect(avatar.root.getObjectByName('avatar-part:jacket-hem')).toBeDefined();
    expect(avatar.root.getObjectByName('avatar-part:shirt')).toBeDefined();
    expect(avatar.root.getObjectByName('avatar-part:hair')).toBeDefined();
    expect(avatar.root.getObjectByName('avatar-part:face')).toBeDefined();
    expect(avatar.root.getObjectByName('avatar-part:hand-left')?.parent).toBeDefined();
    expect(avatar.root.getObjectByName('avatar-part:hand-right')?.parent).toBeDefined();
    expect(avatar.root.getObjectByName('avatar-part:shoe-left')?.parent).toBeDefined();
    expect(avatar.root.getObjectByName('avatar-part:shoe-right')?.parent).toBeDefined();

    avatar.dispose();
  });

  it('keeps every Alex front detail on local -Z at gameplay heading zero', () => {
    const avatar = new AvatarVisual();
    const frontDetailNames = [
      'avatar-part:face',
      'avatar-part:shirt',
      'avatar-part:lapel-left',
      'avatar-part:lapel-right',
      'avatar-part:shoe-left',
      'avatar-part:shoe-right',
    ] as const;

    for (const name of frontDetailNames) {
      const detail = avatar.root.getObjectByName(name);
      expect(detail, `missing ${name}`).toBeDefined();
      expect(detail?.position.z, `${name} must face local -Z`).toBeLessThan(0);
    }

    avatar.dispose();
  });
});
