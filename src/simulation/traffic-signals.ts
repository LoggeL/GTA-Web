import { districtAt } from '../game/city';
import { buildRoadGraph } from '../navigation/road-graph';
import type { SimulationRoadRecipe, SimulationVec3 } from './types';

export type TrafficSignalOrientation = 'horizontal' | 'vertical';
export type TrafficSignalAspect = 'red' | 'yellow' | 'green';
export type TrafficSignalPhase =
  | 'horizontal-green'
  | 'horizontal-yellow'
  | 'all-red-to-vertical'
  | 'vertical-green'
  | 'vertical-yellow'
  | 'all-red-to-horizontal';

export type TrafficSignalApproach =
  | TrafficSignalOrientation
  | Readonly<Pick<SimulationRoadRecipe, 'id'>>;

export const TRAFFIC_SIGNAL_TIMING = Object.freeze({
  greenSeconds: 12,
  yellowSeconds: 2,
  allRedSeconds: 1,
  cycleSeconds: 30,
});

/** Distance from a signalized junction center to each authored stop bar. */
export const TRAFFIC_SIGNAL_STOP_LINE_DISTANCE = 11.35;

export interface TrafficSignalJunctionSnapshot {
  readonly id: string;
  readonly position: Readonly<SimulationVec3>;
  readonly horizontalRoadIds: readonly string[];
  readonly verticalRoadIds: readonly string[];
  readonly offsetSeconds: number;
  readonly cyclePositionSeconds: number;
  readonly phase: TrafficSignalPhase;
  readonly horizontalAspect: TrafficSignalAspect;
  readonly verticalAspect: TrafficSignalAspect;
  readonly secondsUntilChange: number;
}

export interface TrafficSignalSystemSnapshot {
  /** The bounded shared cycle clock, always in [0, cycleSeconds). */
  readonly cycleClockSeconds: number;
  readonly cycleSeconds: number;
  readonly junctions: readonly TrafficSignalJunctionSnapshot[];
}

interface SignalJunction {
  readonly id: string;
  readonly position: Readonly<SimulationVec3>;
  readonly horizontalRoadIds: readonly string[];
  readonly verticalRoadIds: readonly string[];
  readonly roadOrientations: ReadonlyMap<string, TrafficSignalOrientation>;
  readonly offsetSeconds: number;
}

interface PhaseState {
  readonly phase: TrafficSignalPhase;
  readonly horizontalAspect: TrafficSignalAspect;
  readonly verticalAspect: TrafficSignalAspect;
  readonly endSeconds: number;
}

const CYCLE_SECONDS = TRAFFIC_SIGNAL_TIMING.cycleSeconds;
const HORIZONTAL_GREEN_END = TRAFFIC_SIGNAL_TIMING.greenSeconds;
const HORIZONTAL_YELLOW_END = HORIZONTAL_GREEN_END + TRAFFIC_SIGNAL_TIMING.yellowSeconds;
const FIRST_ALL_RED_END = HORIZONTAL_YELLOW_END + TRAFFIC_SIGNAL_TIMING.allRedSeconds;
const VERTICAL_GREEN_END = FIRST_ALL_RED_END + TRAFFIC_SIGNAL_TIMING.greenSeconds;
const VERTICAL_YELLOW_END = VERTICAL_GREEN_END + TRAFFIC_SIGNAL_TIMING.yellowSeconds;
const PHASE_BOUNDARIES = Object.freeze([
  0,
  HORIZONTAL_GREEN_END,
  HORIZONTAL_YELLOW_END,
  FIRST_ALL_RED_END,
  VERTICAL_GREEN_END,
  VERTICAL_YELLOW_END,
  CYCLE_SECONDS,
]);
const FLOAT_BOUNDARY_EPSILON = Number.EPSILON * CYCLE_SECONDS * 8;

if (VERTICAL_YELLOW_END + TRAFFIC_SIGNAL_TIMING.allRedSeconds !== CYCLE_SECONDS) {
  throw new Error('Traffic signal timing must fill exactly one cycle');
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function roadOrientation(
  road: Readonly<SimulationRoadRecipe>,
): TrafficSignalOrientation | null {
  if (road.width > road.depth) return 'horizontal';
  if (road.depth > road.width) return 'vertical';
  return null;
}

function validateAndCopyRoads(
  roadRecipes: readonly SimulationRoadRecipe[],
): readonly SimulationRoadRecipe[] {
  if (!Array.isArray(roadRecipes)) {
    throw new TypeError('traffic signal roads must be an array');
  }
  const roads = roadRecipes.map((road, index): SimulationRoadRecipe => {
    if (road === null || typeof road !== 'object') {
      throw new TypeError(`traffic signal road ${index} must be an object`);
    }
    if (typeof road.id !== 'string' || road.id.trim().length === 0) {
      throw new TypeError(`traffic signal road ${index} requires a non-empty id`);
    }
    if (
      !Number.isFinite(road.position?.x)
      || !Number.isFinite(road.position?.y)
      || !Number.isFinite(road.position?.z)
    ) {
      throw new RangeError(`traffic signal road ${road.id} requires a finite position`);
    }
    if (!Number.isFinite(road.width) || !Number.isFinite(road.depth) || road.width <= 0 || road.depth <= 0) {
      throw new RangeError(`traffic signal road ${road.id} requires positive finite dimensions`);
    }
    return {
      ...road,
      position: { ...road.position },
    };
  }).sort((left, right) => compareIds(left.id, right.id));

  if (new Set(roads.map(({ id }) => id)).size !== roads.length) {
    throw new Error('Traffic signal roads require unique ids');
  }
  return roads;
}

function buildSignalJunctions(
  roads: readonly SimulationRoadRecipe[],
): readonly SignalJunction[] {
  const orientations = new Map(
    roads.map((road) => [road.id, roadOrientation(road)] as const),
  );
  const graph = buildRoadGraph({
    roads: roads.map((road) => ({
      ...road,
      district: road.district ?? districtAt(road.position.x, road.position.z),
      major: Boolean(road.major),
    })),
  });

  const crossings = graph.nodes.flatMap((node) => {
    const horizontalRoadIds = Object.freeze(node.roadIds
      .filter((roadId) => orientations.get(roadId) === 'horizontal')
      .sort(compareIds));
    const verticalRoadIds = Object.freeze(node.roadIds
      .filter((roadId) => orientations.get(roadId) === 'vertical')
      .sort(compareIds));
    if (horizontalRoadIds.length === 0 || verticalRoadIds.length === 0) {
      return [];
    }
    const roadOrientations = new Map<string, TrafficSignalOrientation>();
    for (const roadId of horizontalRoadIds) roadOrientations.set(roadId, 'horizontal');
    for (const roadId of verticalRoadIds) roadOrientations.set(roadId, 'vertical');
    return [{
      id: node.id,
      position: Object.freeze({ x: node.position.x, y: 0, z: node.position.z }),
      horizontalRoadIds,
      verticalRoadIds,
      roadOrientations,
      offsetSeconds: 0,
    } satisfies SignalJunction];
  }).sort((left, right) => compareIds(left.id, right.id));

  const crossingCount = crossings.length;
  return crossings.map((junction, index) => ({
    ...junction,
    // Even deterministic progression gives every junction a bounded offset
    // and guarantees that a city with multiple signals is not synchronized.
    offsetSeconds: crossingCount === 0 ? 0 : index * CYCLE_SECONDS / crossingCount,
  }));
}

function normalizedCyclePosition(value: number): number {
  const remainder = value % CYCLE_SECONDS;
  const normalized = remainder < 0 ? remainder + CYCLE_SECONDS : remainder;
  for (const boundary of PHASE_BOUNDARIES) {
    if (Math.abs(normalized - boundary) <= FLOAT_BOUNDARY_EPSILON) {
      return boundary === CYCLE_SECONDS ? 0 : boundary;
    }
  }
  return normalized;
}

function phaseAt(cyclePositionSeconds: number): PhaseState {
  if (cyclePositionSeconds < HORIZONTAL_GREEN_END) {
    return {
      phase: 'horizontal-green',
      horizontalAspect: 'green',
      verticalAspect: 'red',
      endSeconds: HORIZONTAL_GREEN_END,
    };
  }
  if (cyclePositionSeconds < HORIZONTAL_YELLOW_END) {
    return {
      phase: 'horizontal-yellow',
      horizontalAspect: 'yellow',
      verticalAspect: 'red',
      endSeconds: HORIZONTAL_YELLOW_END,
    };
  }
  if (cyclePositionSeconds < FIRST_ALL_RED_END) {
    return {
      phase: 'all-red-to-vertical',
      horizontalAspect: 'red',
      verticalAspect: 'red',
      endSeconds: FIRST_ALL_RED_END,
    };
  }
  if (cyclePositionSeconds < VERTICAL_GREEN_END) {
    return {
      phase: 'vertical-green',
      horizontalAspect: 'red',
      verticalAspect: 'green',
      endSeconds: VERTICAL_GREEN_END,
    };
  }
  if (cyclePositionSeconds < VERTICAL_YELLOW_END) {
    return {
      phase: 'vertical-yellow',
      horizontalAspect: 'red',
      verticalAspect: 'yellow',
      endSeconds: VERTICAL_YELLOW_END,
    };
  }
  return {
    phase: 'all-red-to-horizontal',
    horizontalAspect: 'red',
    verticalAspect: 'red',
    endSeconds: CYCLE_SECONDS,
  };
}

/**
 * Owns deterministic signal discovery and timing behind a three-method seam.
 * The clock is modulo one cycle, so even very large deltas take constant work.
 */
export class TrafficSignalSystem {
  private readonly junctions: readonly SignalJunction[];
  private readonly junctionById: ReadonlyMap<string, SignalJunction>;
  private cycleClockSeconds = 0;

  public constructor(roadRecipes: readonly SimulationRoadRecipe[]) {
    this.junctions = buildSignalJunctions(validateAndCopyRoads(roadRecipes));
    this.junctionById = new Map(this.junctions.map((junction) => [junction.id, junction]));
  }

  public tick(deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      throw new RangeError('traffic signal deltaSeconds must be finite and non-negative');
    }
    this.cycleClockSeconds = normalizedCyclePosition(this.cycleClockSeconds + deltaSeconds);
  }

  public aspectFor(
    junctionId: string,
    approach: TrafficSignalApproach,
  ): TrafficSignalAspect {
    if (typeof junctionId !== 'string' || junctionId.length === 0) {
      throw new TypeError('traffic signal junctionId must be a non-empty string');
    }
    const junction = this.junctionById.get(junctionId);
    if (!junction) {
      throw new RangeError(`Unknown traffic signal junction: ${junctionId}`);
    }

    let orientation: TrafficSignalOrientation;
    if (approach === 'horizontal' || approach === 'vertical') {
      orientation = approach;
    } else {
      if (approach === null || typeof approach !== 'object' || typeof approach.id !== 'string') {
        throw new TypeError('traffic signal approach must be an orientation or road');
      }
      const roadOrientationAtJunction = junction.roadOrientations.get(approach.id);
      if (!roadOrientationAtJunction) {
        throw new RangeError(`Road ${approach.id} does not approach traffic signal ${junctionId}`);
      }
      orientation = roadOrientationAtJunction;
    }

    const cyclePosition = normalizedCyclePosition(
      this.cycleClockSeconds + junction.offsetSeconds,
    );
    const phase = phaseAt(cyclePosition);
    return orientation === 'horizontal' ? phase.horizontalAspect : phase.verticalAspect;
  }

  public getSnapshot(): TrafficSignalSystemSnapshot {
    const junctions = this.junctions.map((junction): TrafficSignalJunctionSnapshot => {
      const cyclePositionSeconds = normalizedCyclePosition(
        this.cycleClockSeconds + junction.offsetSeconds,
      );
      const phase = phaseAt(cyclePositionSeconds);
      return Object.freeze({
        id: junction.id,
        position: junction.position,
        horizontalRoadIds: junction.horizontalRoadIds,
        verticalRoadIds: junction.verticalRoadIds,
        offsetSeconds: junction.offsetSeconds,
        cyclePositionSeconds,
        phase: phase.phase,
        horizontalAspect: phase.horizontalAspect,
        verticalAspect: phase.verticalAspect,
        secondsUntilChange: phase.endSeconds - cyclePositionSeconds,
      });
    });
    return Object.freeze({
      cycleClockSeconds: this.cycleClockSeconds,
      cycleSeconds: CYCLE_SECONDS,
      junctions: Object.freeze(junctions),
    });
  }
}
