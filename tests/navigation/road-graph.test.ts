import { describe, expect, it } from 'vitest';

import { generateCity } from '../../src/game/city';
import type { CityLayout } from '../../src/game/city';
import {
  buildRoadGraph,
  createGpsRoute,
  findRoadRoute,
  findRouteAStar,
  nearestRoadNode,
  simplifyRoutePoints,
} from '../../src/navigation';

describe('road graph and deterministic A* routing', () => {
  it('derives a stable graph from city road rectangles', () => {
    const city = generateCity('navigation-graph', 'high');
    const first = buildRoadGraph(city);
    const second = buildRoadGraph(city);

    expect(first).toEqual(second);
    expect(first.nodes.length).toBeGreaterThan(150);
    expect(first.edges.length).toBeGreaterThan(200);
    expect(new Set(first.nodes.map((node) => node.id)).size).toBe(first.nodes.length);
    expect(new Set(first.edges.map((edge) => edge.id)).size).toBe(first.edges.length);
  });

  it('finds the nearest intersection with stable tie-breaking', () => {
    const graph = buildRoadGraph(generateCity('nearest-node', 'low'));
    const nearest = nearestRoadNode(graph, { x: -547, z: -553 });

    expect(nearest?.position).toEqual({ x: -550, z: -550 });
    expect(nearestRoadNode(graph, { x: 10_000, z: 10_000 }, 10)).toBeNull();
  });

  it('routes deterministically across all four districts through the city spines', () => {
    const graph = buildRoadGraph(generateCity('cross-district-route', 'high'));
    const first = findRoadRoute(graph, { x: -550, z: -550 }, { x: 550, z: 550 });
    const second = findRoadRoute(graph, { x: -550, z: -550 }, { x: 550, z: 550 });

    expect(first).toEqual(second);
    expect(first).not.toBeNull();
    expect(first?.distanceMeters).toBe(2200);
    expect(first?.points).toContainEqual({ x: 0, z: 0 });
    const routeDistricts = new Set(
      first?.nodeIds.map((id) => graph.nodes.find((node) => node.id === id)?.district),
    );
    expect(routeDistricts.size).toBeGreaterThanOrEqual(3);
  });

  it('honors closed edges and reports an unreachable destination', () => {
    const layout: Pick<CityLayout, 'roads'> = {
      roads: [
        {
          id: 'only-road',
          district: 'arroyo-heights',
          position: { x: 0, y: 0, z: 0 },
          width: 100,
          depth: 10,
          major: false,
        },
      ],
    };
    const graph = buildRoadGraph(layout);
    const start = graph.nodes.find((node) => node.position.x === -50);
    const goal = graph.nodes.find((node) => node.position.x === 50);
    const edge = graph.edges[0];

    expect(start).toBeDefined();
    expect(goal).toBeDefined();
    expect(edge).toBeDefined();
    expect(findRouteAStar(graph, start?.id ?? '', goal?.id ?? '')).not.toBeNull();
    expect(
      findRouteAStar(graph, start?.id ?? '', goal?.id ?? '', new Set([edge?.id ?? ''])),
    ).toBeNull();
  });

  it('simplifies collinear route points into lightweight GPS segments', () => {
    const points = [
      { x: 0, z: 0 },
      { x: 10, z: 0 },
      { x: 20, z: 0 },
      { x: 20, z: 10 },
      { x: 20, z: 20 },
    ];
    expect(simplifyRoutePoints(points, 0)).toEqual([
      { x: 0, z: 0 },
      { x: 20, z: 0 },
      { x: 20, z: 20 },
    ]);

    const gps = createGpsRoute(
      {
        startNodeId: 'a',
        goalNodeId: 'e',
        nodeIds: ['a', 'b', 'c', 'd', 'e'],
        points,
        edgeIds: ['ab', 'bc', 'cd', 'de'],
        distanceMeters: 40,
      },
      0,
    );
    expect(gps.segments).toHaveLength(2);
    expect(gps.distanceMeters).toBe(40);
    expect(gps.segments[0]?.headingRadians).toBeCloseTo(Math.PI / 2);
  });
});
