import {
  distance2d,
  headingFromDirection,
  normalize2d,
  pointBlocked,
} from './math';
import type {
  SimulationObstacle,
  SimulationRoadRecipe,
  SimulationVec3,
} from './types';

export type NpcNavigationStatus =
  | 'idle'
  | 'pathing'
  | 'recovering'
  | 'arrived'
  | 'unreachable';

export interface NpcNavigationNode {
  readonly id: string;
  readonly position: SimulationVec3;
  readonly neighbors: readonly string[];
}

export interface NpcNavigationGraph {
  readonly nodes: readonly NpcNavigationNode[];
  readonly nodeById: ReadonlyMap<string, NpcNavigationNode>;
}

export interface NpcNavigationStep {
  readonly position: SimulationVec3;
  readonly heading: number;
  readonly speed: number;
  readonly status: NpcNavigationStatus;
  readonly waypointIndex: number;
  readonly recoveryCount: number;
}

export interface NpcNavigationStepContext {
  readonly deltaSeconds: number;
  readonly speed: number;
  readonly radius: number;
  readonly obstacles?: readonly SimulationObstacle[];
}

interface MutableNavigationNode {
  readonly id: string;
  readonly position: SimulationVec3;
  readonly neighbors: Set<string>;
}

const SAMPLE_SPACING = 18;
const SIDEWALK_CLEARANCE = 2.4;
const ARRIVAL_DISTANCE = 0.55;
const RECOVERY_DELAY_SECONDS = 0.55;
const GIVE_UP_SECONDS = 2.4;
const MAX_RECOVERY_ATTEMPTS = 4;

function finitePosition(position: Readonly<SimulationVec3>): SimulationVec3 {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
    throw new RangeError('NPC navigation positions must be finite');
  }
  return { x: position.x, y: position.y, z: position.z };
}

function roadIsVertical(road: Readonly<SimulationRoadRecipe>): boolean {
  return road.depth > road.width;
}

function addUndirectedEdge(
  nodes: ReadonlyMap<string, MutableNavigationNode>,
  firstId: string,
  secondId: string,
): void {
  if (firstId === secondId) return;
  nodes.get(firstId)?.neighbors.add(secondId);
  nodes.get(secondId)?.neighbors.add(firstId);
}

function roadIntersection(
  first: Readonly<SimulationRoadRecipe>,
  second: Readonly<SimulationRoadRecipe>,
): SimulationVec3 | null {
  if (roadIsVertical(first) === roadIsVertical(second)) return null;
  const vertical = roadIsVertical(first) ? first : second;
  const horizontal = roadIsVertical(first) ? second : first;
  const x = vertical.position.x;
  const z = horizontal.position.z;
  if (
    Math.abs(x - horizontal.position.x) > horizontal.width / 2
    || Math.abs(z - vertical.position.z) > vertical.depth / 2
  ) {
    return null;
  }
  return { x, y: 0, z };
}

function nearestIds(
  nodes: readonly MutableNavigationNode[],
  position: Readonly<SimulationVec3>,
  count: number,
): readonly string[] {
  return [...nodes]
    .sort((left, right) => {
      const difference = distance2d(left.position, position) - distance2d(right.position, position);
      return Math.abs(difference) > 0.000001 ? difference : left.id.localeCompare(right.id);
    })
    .slice(0, count)
    .map(({ id }) => id);
}

/**
 * Builds a deterministic coarse pedestrian graph from road recipes. Each road
 * gets a sampled path on both sidewalks; nearby paths are linked by crosswalk
 * edges at intersections and by short joins at road ends.
 */
export function buildNpcNavigationGraph(
  roadRecipes: readonly SimulationRoadRecipe[],
): NpcNavigationGraph {
  const roads = roadRecipes
    .filter((road) => (
      Number.isFinite(road.position.x)
      && Number.isFinite(road.position.z)
      && road.width > 2
      && road.depth > 2
    ))
    .map((road) => ({ ...road, position: finitePosition(road.position) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(roads.map(({ id }) => id)).size !== roads.length) {
    throw new Error('NPC navigation roads require unique ids');
  }
  const nodes = new Map<string, MutableNavigationNode>();
  const nodesByRoad = new Map<string, MutableNavigationNode[]>();

  for (const road of roads) {
    const vertical = roadIsVertical(road);
    const length = vertical ? road.depth : road.width;
    const narrow = vertical ? road.width : road.depth;
    const segmentCount = Math.max(1, Math.ceil(length / SAMPLE_SPACING));
    const roadNodes: MutableNavigationNode[] = [];
    for (const side of [-1, 1] as const) {
      let previousId: string | null = null;
      for (let segment = 0; segment <= segmentCount; segment += 1) {
        const along = -length / 2 + (length * segment) / segmentCount;
        const lateral = side * (narrow / 2 + SIDEWALK_CLEARANCE);
        const id = `${road.id}:side-${side === -1 ? 'a' : 'b'}:${segment.toString().padStart(3, '0')}`;
        const position: SimulationVec3 = vertical
          ? { x: road.position.x + lateral, y: 0, z: road.position.z + along }
          : { x: road.position.x + along, y: 0, z: road.position.z + lateral };
        const node: MutableNavigationNode = { id, position, neighbors: new Set() };
        nodes.set(id, node);
        roadNodes.push(node);
        if (previousId) addUndirectedEdge(nodes, previousId, id);
        previousId = id;
      }
    }
    nodesByRoad.set(road.id, roadNodes);
  }

  for (let firstIndex = 0; firstIndex < roads.length; firstIndex += 1) {
    const first = roads[firstIndex];
    if (!first) continue;
    for (let secondIndex = firstIndex + 1; secondIndex < roads.length; secondIndex += 1) {
      const second = roads[secondIndex];
      if (!second) continue;
      const firstNodes = nodesByRoad.get(first.id) ?? [];
      const secondNodes = nodesByRoad.get(second.id) ?? [];
      const intersection = roadIntersection(first, second);
      if (intersection) {
        // Two sampled points on each sidewalk form the four corners around a
        // crossing. Linking all four preserves both sides instead of choosing
        // one through lexical tie-breaking at a symmetric intersection.
        const firstNear = nearestIds(firstNodes, intersection, 4);
        const secondNear = nearestIds(secondNodes, intersection, 4);
        for (const firstId of firstNear) {
          for (const secondId of secondNear) {
            addUndirectedEdge(nodes, firstId, secondId);
          }
        }
        continue;
      }

      const firstEnds = [firstNodes[0], firstNodes.at(-1)].filter(
        (node): node is MutableNavigationNode => node !== undefined,
      );
      const secondEnds = [secondNodes[0], secondNodes.at(-1)].filter(
        (node): node is MutableNavigationNode => node !== undefined,
      );
      for (const firstEnd of firstEnds) {
        for (const secondEnd of secondEnds) {
          if (distance2d(firstEnd.position, secondEnd.position) <= SAMPLE_SPACING * 0.9) {
            addUndirectedEdge(nodes, firstEnd.id, secondEnd.id);
          }
        }
      }
    }
  }

  const immutableNodes = [...nodes.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((node): NpcNavigationNode => ({
      id: node.id,
      position: { ...node.position },
      neighbors: [...node.neighbors].sort(),
    }));
  return {
    nodes: immutableNodes,
    nodeById: new Map(immutableNodes.map((node) => [node.id, node])),
  };
}

export function nearestNpcNavigationNode(
  graph: Readonly<NpcNavigationGraph>,
  position: Readonly<SimulationVec3>,
): NpcNavigationNode | null {
  let closest: NpcNavigationNode | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const node of graph.nodes) {
    const distance = distance2d(node.position, position);
    if (
      distance < closestDistance - 0.000001
      || (Math.abs(distance - closestDistance) <= 0.000001 && node.id.localeCompare(closest?.id ?? '') < 0)
    ) {
      closest = node;
      closestDistance = distance;
    }
  }
  return closest;
}

function reconstructPath(
  graph: Readonly<NpcNavigationGraph>,
  parents: ReadonlyMap<string, string>,
  endId: string,
): readonly SimulationVec3[] {
  const ids: string[] = [endId];
  let cursor = endId;
  while (parents.has(cursor)) {
    const parent = parents.get(cursor);
    if (!parent) break;
    ids.push(parent);
    cursor = parent;
  }
  ids.reverse();
  return ids
    .map((id) => graph.nodeById.get(id))
    .filter((node): node is NpcNavigationNode => node !== undefined)
    .map(({ position }) => ({ ...position }));
}

/** Deterministic A* with lexical tie breaking. */
export function findNpcNavigationPath(
  graph: Readonly<NpcNavigationGraph>,
  start: Readonly<SimulationVec3>,
  destination: Readonly<SimulationVec3>,
): readonly SimulationVec3[] {
  finitePosition(start);
  const finalPosition = finitePosition(destination);
  const startNode = nearestNpcNavigationNode(graph, start);
  const endNode = nearestNpcNavigationNode(graph, destination);
  if (!startNode || !endNode) return [finalPosition];

  const frontier = new Set<string>([startNode.id]);
  const costs = new Map<string, number>([[startNode.id, 0]]);
  const scores = new Map<string, number>([[startNode.id, distance2d(startNode.position, endNode.position)]]);
  const parents = new Map<string, string>();

  while (frontier.size > 0) {
    const currentId = [...frontier].sort((left, right) => {
      const difference = (scores.get(left) ?? Number.POSITIVE_INFINITY)
        - (scores.get(right) ?? Number.POSITIVE_INFINITY);
      return Math.abs(difference) > 0.000001 ? difference : left.localeCompare(right);
    })[0];
    if (!currentId) break;
    if (currentId === endNode.id) {
      const path = [...reconstructPath(graph, parents, currentId), finalPosition];
      return path.filter((point, index) => index === 0 || distance2d(point, path[index - 1] ?? point) > 0.05);
    }
    frontier.delete(currentId);
    const current = graph.nodeById.get(currentId);
    if (!current) continue;
    for (const neighborId of current.neighbors) {
      const neighbor = graph.nodeById.get(neighborId);
      if (!neighbor) continue;
      const tentative = (costs.get(currentId) ?? Number.POSITIVE_INFINITY)
        + distance2d(current.position, neighbor.position);
      const known = costs.get(neighborId) ?? Number.POSITIVE_INFINITY;
      const knownParent = parents.get(neighborId);
      if (
        tentative < known - 0.000001
        || (Math.abs(tentative - known) <= 0.000001 && currentId.localeCompare(knownParent ?? '') < 0)
      ) {
        parents.set(neighborId, currentId);
        costs.set(neighborId, tentative);
        scores.set(neighborId, tentative + distance2d(neighbor.position, endNode.position));
        frontier.add(neighborId);
      }
    }
  }
  return [];
}

function rotated(direction: Readonly<SimulationVec3>, sign: 1 | -1): SimulationVec3 {
  return sign === 1
    ? { x: -direction.z, y: 0, z: direction.x }
    : { x: direction.z, y: 0, z: -direction.x };
}

export class NpcNavigator {
  private readonly graph: NpcNavigationGraph;
  private readonly avoidanceSign: 1 | -1;
  private route: readonly SimulationVec3[] = [];
  private waypointIndex = 0;
  private status: NpcNavigationStatus = 'idle';
  private stuckSeconds = 0;
  private recoveryCount = 0;
  private lastPosition: SimulationVec3 | null = null;

  public constructor(graph: NpcNavigationGraph, avoidanceSign: 1 | -1 = 1) {
    this.graph = graph;
    this.avoidanceSign = avoidanceSign;
  }

  public setDestination(
    currentPosition: Readonly<SimulationVec3>,
    destination: Readonly<SimulationVec3>,
  ): NpcNavigationStatus {
    this.route = findNpcNavigationPath(this.graph, currentPosition, destination);
    this.waypointIndex = 0;
    this.stuckSeconds = 0;
    this.recoveryCount = 0;
    this.lastPosition = { ...currentPosition };
    this.status = this.route.length > 0 ? 'pathing' : 'unreachable';
    return this.status;
  }

  public clear(): void {
    this.route = [];
    this.waypointIndex = 0;
    this.stuckSeconds = 0;
    this.recoveryCount = 0;
    this.lastPosition = null;
    this.status = 'idle';
  }

  public getStatus(): NpcNavigationStatus {
    return this.status;
  }

  public getRecoveryCount(): number {
    return this.recoveryCount;
  }

  public step(
    currentPosition: Readonly<SimulationVec3>,
    context: Readonly<NpcNavigationStepContext>,
  ): NpcNavigationStep {
    const position = finitePosition(currentPosition);
    const dt = Math.min(0.1, Math.max(0, context.deltaSeconds));
    const speed = Math.max(0, context.speed);
    const radius = Math.max(0.05, context.radius);
    const obstacles = context.obstacles ?? [];
    if (this.status === 'idle' || this.status === 'arrived' || this.status === 'unreachable') {
      return {
        position,
        heading: 0,
        speed: 0,
        status: this.status,
        waypointIndex: this.waypointIndex,
        recoveryCount: this.recoveryCount,
      };
    }

    while (
      this.waypointIndex < this.route.length
      && distance2d(position, this.route[this.waypointIndex] ?? position) <= ARRIVAL_DISTANCE
    ) {
      this.waypointIndex += 1;
    }
    if (this.waypointIndex >= this.route.length) {
      this.status = 'arrived';
      this.lastPosition = position;
      return {
        position,
        heading: 0,
        speed: 0,
        status: this.status,
        waypointIndex: this.waypointIndex,
        recoveryCount: this.recoveryCount,
      };
    }

    const target = this.route[this.waypointIndex] ?? position;
    const desired = normalize2d({
      x: target.x - position.x,
      y: 0,
      z: target.z - position.z,
    });
    const directions = [
      desired,
      rotated(desired, this.avoidanceSign),
      rotated(desired, this.avoidanceSign === 1 ? -1 : 1),
      { x: -desired.x, y: 0, z: -desired.z },
    ];
    let chosen = desired;
    let candidate = position;
    let moved = false;
    for (const direction of directions) {
      const next = {
        x: position.x + direction.x * speed * dt,
        y: position.y,
        z: position.z + direction.z * speed * dt,
      };
      if (!pointBlocked(next, radius, obstacles)) {
        chosen = direction;
        candidate = next;
        moved = distance2d(position, next) > 0.0001;
        break;
      }
    }

    const externalMovement = this.lastPosition ? distance2d(position, this.lastPosition) : 0;
    if (moved || externalMovement > 0.025) {
      this.stuckSeconds = Math.max(0, this.stuckSeconds - dt * 2);
      if (this.status === 'recovering' && this.stuckSeconds <= 0.1) this.status = 'pathing';
    } else {
      this.stuckSeconds += dt;
    }
    if (this.stuckSeconds >= RECOVERY_DELAY_SECONDS && this.status !== 'recovering') {
      this.status = 'recovering';
      this.recoveryCount += 1;
    }
    if (
      this.stuckSeconds >= GIVE_UP_SECONDS
      || this.recoveryCount > MAX_RECOVERY_ATTEMPTS
    ) {
      const recoveryNode = [...this.route]
        .slice(this.waypointIndex)
        .find((point) => !pointBlocked(point, radius, obstacles));
      if (recoveryNode && distance2d(position, recoveryNode) <= SAMPLE_SPACING * 1.5) {
        candidate = { ...recoveryNode };
        this.stuckSeconds = 0;
        this.status = 'pathing';
      } else {
        this.status = 'unreachable';
        candidate = position;
      }
    }

    this.lastPosition = { ...candidate };
    return {
      position: candidate,
      heading: headingFromDirection(chosen.x, chosen.z),
      speed: moved ? speed : 0,
      status: this.status,
      waypointIndex: this.waypointIndex,
      recoveryCount: this.recoveryCount,
    };
  }
}
