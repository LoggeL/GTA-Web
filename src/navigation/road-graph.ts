import { districtAt } from '../game/city';
import type { CityLayout, RoadRecipe } from '../game/city';
import type {
  GpsRoute,
  GpsRouteSegment,
  NavigationPoint,
  RoadGraph,
  RoadGraphEdge,
  RoadGraphNode,
  RoadRoute,
} from './types';

const INTERSECTION_EPSILON = 0.001;
const COORDINATE_PRECISION = 1_000;

interface CenterLine {
  readonly road: RoadRecipe;
  readonly orientation: 'horizontal' | 'vertical';
  readonly fixed: number;
  readonly minimum: number;
  readonly maximum: number;
}

interface MutableNode {
  readonly id: string;
  readonly position: NavigationPoint;
  readonly roadIds: Set<string>;
}

interface AdjacentEdge {
  readonly nodeId: string;
  readonly edge: RoadGraphEdge;
}

function normalizeCoordinate(value: number): number {
  const rounded = Math.round(value * COORDINATE_PRECISION) / COORDINATE_PRECISION;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function coordinateKey(point: NavigationPoint): string {
  return `${normalizeCoordinate(point.x)},${normalizeCoordinate(point.z)}`;
}

function nodeId(point: NavigationPoint): string {
  return `road-node:${coordinateKey(point)}`;
}

function centerLine(road: RoadRecipe): CenterLine {
  if (road.depth > road.width) {
    return {
      road,
      orientation: 'vertical',
      fixed: road.position.x,
      minimum: road.position.z - road.depth / 2,
      maximum: road.position.z + road.depth / 2,
    };
  }

  return {
    road,
    orientation: 'horizontal',
    fixed: road.position.z,
    minimum: road.position.x - road.width / 2,
    maximum: road.position.x + road.width / 2,
  };
}

function includesCoordinate(segment: CenterLine, value: number): boolean {
  return value >= segment.minimum - INTERSECTION_EPSILON && value <= segment.maximum + INTERSECTION_EPSILON;
}

function endpoints(segment: CenterLine): readonly [NavigationPoint, NavigationPoint] {
  if (segment.orientation === 'vertical') {
    return [
      { x: segment.fixed, z: segment.minimum },
      { x: segment.fixed, z: segment.maximum },
    ];
  }
  return [
    { x: segment.minimum, z: segment.fixed },
    { x: segment.maximum, z: segment.fixed },
  ];
}

function intersection(first: CenterLine, second: CenterLine): NavigationPoint | null {
  if (first.orientation === second.orientation) {
    return null;
  }
  const vertical = first.orientation === 'vertical' ? first : second;
  const horizontal = first.orientation === 'horizontal' ? first : second;
  if (!includesCoordinate(vertical, horizontal.fixed) || !includesCoordinate(horizontal, vertical.fixed)) {
    return null;
  }
  return { x: vertical.fixed, z: horizontal.fixed };
}

function distance(first: NavigationPoint, second: NavigationPoint): number {
  return Math.hypot(second.x - first.x, second.z - first.z);
}

export function buildRoadGraph(layout: Pick<CityLayout, 'roads'>): RoadGraph {
  const lines = [...layout.roads]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(centerLine);
  const pointsByRoad = new Map<string, Map<string, NavigationPoint>>();

  for (const line of lines) {
    const points = new Map<string, NavigationPoint>();
    for (const endpoint of endpoints(line)) {
      const normalized = {
        x: normalizeCoordinate(endpoint.x),
        z: normalizeCoordinate(endpoint.z),
      };
      points.set(coordinateKey(normalized), normalized);
    }
    pointsByRoad.set(line.road.id, points);
  }

  for (let firstIndex = 0; firstIndex < lines.length; firstIndex += 1) {
    const first = lines[firstIndex];
    if (first === undefined) {
      continue;
    }
    for (let secondIndex = firstIndex + 1; secondIndex < lines.length; secondIndex += 1) {
      const second = lines[secondIndex];
      if (second === undefined) {
        continue;
      }
      const point = intersection(first, second);
      if (point === null) {
        continue;
      }
      const normalized = {
        x: normalizeCoordinate(point.x),
        z: normalizeCoordinate(point.z),
      };
      const key = coordinateKey(normalized);
      pointsByRoad.get(first.road.id)?.set(key, normalized);
      pointsByRoad.get(second.road.id)?.set(key, normalized);
    }
  }

  const mutableNodes = new Map<string, MutableNode>();
  for (const line of lines) {
    const points = pointsByRoad.get(line.road.id);
    if (points === undefined) {
      continue;
    }
    for (const [key, point] of points) {
      const existing = mutableNodes.get(key);
      if (existing === undefined) {
        mutableNodes.set(key, {
          id: nodeId(point),
          position: point,
          roadIds: new Set([line.road.id]),
        });
      } else {
        existing.roadIds.add(line.road.id);
      }
    }
  }

  const nodes: RoadGraphNode[] = [...mutableNodes.values()]
    .map((node) => ({
      id: node.id,
      position: node.position,
      district: districtAt(node.position.x, node.position.z),
      roadIds: [...node.roadIds].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const nodesByKey = new Map(nodes.map((node) => [coordinateKey(node.position), node]));
  const edges: RoadGraphEdge[] = [];

  for (const line of lines) {
    const roadPoints = [...(pointsByRoad.get(line.road.id)?.values() ?? [])]
      .sort((left, right) => {
        const primary = line.orientation === 'vertical' ? left.z - right.z : left.x - right.x;
        return primary === 0 ? coordinateKey(left).localeCompare(coordinateKey(right)) : primary;
      });

    for (let index = 0; index < roadPoints.length - 1; index += 1) {
      const fromPoint = roadPoints[index];
      const toPoint = roadPoints[index + 1];
      if (fromPoint === undefined || toPoint === undefined) {
        continue;
      }
      const from = nodesByKey.get(coordinateKey(fromPoint));
      const to = nodesByKey.get(coordinateKey(toPoint));
      if (from === undefined || to === undefined || from.id === to.id) {
        continue;
      }
      edges.push({
        id: `${line.road.id}:segment-${index}`,
        fromNodeId: from.id,
        toNodeId: to.id,
        roadId: line.road.id,
        distanceMeters: distance(from.position, to.position),
        major: line.road.major,
      });
    }
  }

  return { nodes, edges };
}

export function nearestRoadNode(
  graph: RoadGraph,
  point: NavigationPoint,
  maximumDistanceMeters: number = Number.POSITIVE_INFINITY,
): RoadGraphNode | null {
  if (maximumDistanceMeters < 0) {
    throw new RangeError('maximumDistanceMeters cannot be negative');
  }
  let nearest: RoadGraphNode | null = null;
  let nearestDistance = maximumDistanceMeters;

  for (const node of graph.nodes) {
    const candidateDistance = distance(point, node.position);
    if (
      candidateDistance < nearestDistance - Number.EPSILON ||
      (Math.abs(candidateDistance - nearestDistance) <= Number.EPSILON &&
        (nearest === null || node.id.localeCompare(nearest.id) < 0))
    ) {
      nearest = node;
      nearestDistance = candidateDistance;
    }
  }

  return nearest;
}

function buildAdjacency(graph: RoadGraph, closedEdgeIds: ReadonlySet<string>): Map<string, AdjacentEdge[]> {
  const adjacency = new Map<string, AdjacentEdge[]>();
  for (const node of graph.nodes) {
    adjacency.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (closedEdgeIds.has(edge.id)) {
      continue;
    }
    adjacency.get(edge.fromNodeId)?.push({ nodeId: edge.toNodeId, edge });
    adjacency.get(edge.toNodeId)?.push({ nodeId: edge.fromNodeId, edge });
  }
  for (const adjacent of adjacency.values()) {
    adjacent.sort((left, right) => {
      const nodeComparison = left.nodeId.localeCompare(right.nodeId);
      return nodeComparison === 0 ? left.edge.id.localeCompare(right.edge.id) : nodeComparison;
    });
  }
  return adjacency;
}

function reconstructRoute(
  graph: RoadGraph,
  startNodeId: string,
  goalNodeId: string,
  cameFrom: ReadonlyMap<string, { readonly nodeId: string; readonly edgeId: string }>,
  distanceMeters: number,
): RoadRoute {
  const nodeIds = [goalNodeId];
  const edgeIds: string[] = [];
  let cursor = goalNodeId;

  while (cursor !== startNodeId) {
    const previous = cameFrom.get(cursor);
    if (previous === undefined) {
      throw new Error(`Unable to reconstruct route from ${startNodeId} to ${goalNodeId}`);
    }
    nodeIds.push(previous.nodeId);
    edgeIds.push(previous.edgeId);
    cursor = previous.nodeId;
  }

  nodeIds.reverse();
  edgeIds.reverse();
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const points = nodeIds.map((id) => {
    const node = byId.get(id);
    if (node === undefined) {
      throw new Error(`Route references unknown road node: ${id}`);
    }
    return node.position;
  });

  return { startNodeId, goalNodeId, nodeIds, points, edgeIds, distanceMeters };
}

export function findRouteAStar(
  graph: RoadGraph,
  startNodeId: string,
  goalNodeId: string,
  closedEdgeIds: ReadonlySet<string> = new Set<string>(),
): RoadRoute | null {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const start = nodesById.get(startNodeId);
  const goal = nodesById.get(goalNodeId);
  if (start === undefined) {
    throw new Error(`Unknown start road node: ${startNodeId}`);
  }
  if (goal === undefined) {
    throw new Error(`Unknown goal road node: ${goalNodeId}`);
  }
  if (startNodeId === goalNodeId) {
    return {
      startNodeId,
      goalNodeId,
      nodeIds: [startNodeId],
      points: [start.position],
      edgeIds: [],
      distanceMeters: 0,
    };
  }

  const adjacency = buildAdjacency(graph, closedEdgeIds);
  const open = new Set([startNodeId]);
  const cameFrom = new Map<string, { nodeId: string; edgeId: string }>();
  const gScore = new Map<string, number>([[startNodeId, 0]]);
  const heuristic = new Map<string, number>();
  for (const node of graph.nodes) {
    heuristic.set(node.id, distance(node.position, goal.position));
  }

  while (open.size > 0) {
    const candidates = [...open].sort((leftId, rightId) => {
      const leftG = gScore.get(leftId) ?? Number.POSITIVE_INFINITY;
      const rightG = gScore.get(rightId) ?? Number.POSITIVE_INFINITY;
      const leftH = heuristic.get(leftId) ?? Number.POSITIVE_INFINITY;
      const rightH = heuristic.get(rightId) ?? Number.POSITIVE_INFINITY;
      const fDifference = leftG + leftH - (rightG + rightH);
      if (Math.abs(fDifference) > Number.EPSILON) {
        return fDifference;
      }
      const hDifference = leftH - rightH;
      return Math.abs(hDifference) > Number.EPSILON ? hDifference : leftId.localeCompare(rightId);
    });
    const currentId = candidates[0];
    if (currentId === undefined) {
      break;
    }
    if (currentId === goalNodeId) {
      return reconstructRoute(
        graph,
        startNodeId,
        goalNodeId,
        cameFrom,
        gScore.get(goalNodeId) ?? 0,
      );
    }

    open.delete(currentId);
    const currentScore = gScore.get(currentId) ?? Number.POSITIVE_INFINITY;
    for (const adjacent of adjacency.get(currentId) ?? []) {
      const tentativeScore = currentScore + adjacent.edge.distanceMeters;
      const knownScore = gScore.get(adjacent.nodeId) ?? Number.POSITIVE_INFINITY;
      if (tentativeScore + Number.EPSILON >= knownScore) {
        continue;
      }
      cameFrom.set(adjacent.nodeId, { nodeId: currentId, edgeId: adjacent.edge.id });
      gScore.set(adjacent.nodeId, tentativeScore);
      open.add(adjacent.nodeId);
    }
  }

  return null;
}

export function findRoadRoute(
  graph: RoadGraph,
  start: NavigationPoint,
  goal: NavigationPoint,
  closedEdgeIds: ReadonlySet<string> = new Set<string>(),
): RoadRoute | null {
  const startNode = nearestRoadNode(graph, start);
  const goalNode = nearestRoadNode(graph, goal);
  if (startNode === null || goalNode === null) {
    return null;
  }
  return findRouteAStar(graph, startNode.id, goalNode.id, closedEdgeIds);
}

function pointToSegmentDistance(
  point: NavigationPoint,
  start: NavigationPoint,
  end: NavigationPoint,
): number {
  const deltaX = end.x - start.x;
  const deltaZ = end.z - start.z;
  const lengthSquared = deltaX * deltaX + deltaZ * deltaZ;
  if (lengthSquared === 0) {
    return distance(point, start);
  }
  const projection = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * deltaX + (point.z - start.z) * deltaZ) / lengthSquared),
  );
  return distance(point, {
    x: start.x + projection * deltaX,
    z: start.z + projection * deltaZ,
  });
}

function simplifySection(
  points: readonly NavigationPoint[],
  firstIndex: number,
  lastIndex: number,
  tolerance: number,
  keep: Set<number>,
): void {
  const first = points[firstIndex];
  const last = points[lastIndex];
  if (first === undefined || last === undefined || lastIndex <= firstIndex + 1) {
    return;
  }

  let furthestIndex = -1;
  let furthestDistance = tolerance;
  for (let index = firstIndex + 1; index < lastIndex; index += 1) {
    const point = points[index];
    if (point === undefined) {
      continue;
    }
    const candidateDistance = pointToSegmentDistance(point, first, last);
    if (candidateDistance > furthestDistance) {
      furthestIndex = index;
      furthestDistance = candidateDistance;
    }
  }
  if (furthestIndex === -1) {
    return;
  }
  keep.add(furthestIndex);
  simplifySection(points, firstIndex, furthestIndex, tolerance, keep);
  simplifySection(points, furthestIndex, lastIndex, tolerance, keep);
}

export function simplifyRoutePoints(
  source: readonly NavigationPoint[],
  toleranceMeters: number = 1,
): readonly NavigationPoint[] {
  if (!Number.isFinite(toleranceMeters) || toleranceMeters < 0) {
    throw new RangeError('toleranceMeters must be a finite non-negative number');
  }
  const points = source.filter((point, index) => {
    const previous = source[index - 1];
    return previous === undefined || point.x !== previous.x || point.z !== previous.z;
  });
  if (points.length <= 2) {
    return points;
  }

  const keep = new Set([0, points.length - 1]);
  simplifySection(points, 0, points.length - 1, toleranceMeters, keep);
  return [...keep]
    .sort((left, right) => left - right)
    .map((index) => points[index])
    .filter((point): point is NavigationPoint => point !== undefined);
}

export function createGpsRoute(route: RoadRoute, toleranceMeters: number = 1): GpsRoute {
  const points = simplifyRoutePoints(route.points, toleranceMeters);
  const segments: GpsRouteSegment[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (from === undefined || to === undefined) {
      continue;
    }
    segments.push({
      index,
      from,
      to,
      distanceMeters: distance(from, to),
      headingRadians: Math.atan2(to.x - from.x, to.z - from.z),
    });
  }
  return { points, segments, distanceMeters: route.distanceMeters };
}
