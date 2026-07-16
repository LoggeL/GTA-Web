import type { RandomSeed } from '../core/random';
import type { EndingChoice } from '../core/state';
import type { ItemDefinition } from '../data/types';
import {
  PoliceResponseDirector,
  type PoliceResponsePosition,
  type PoliceResponseSnapshot,
  type RoadblockCandidate,
  validatePoliceResponseSnapshot,
} from './policeResponse';
import {
  applyDefeatPenalty,
  clearWanted,
  confirmPoliceSighting,
  createWantedState,
  escalateWanted,
  reportCrime,
  tickWanted,
  wantedLevelForHeat,
  type DefeatPenaltyInput,
  type DefeatPenaltyResult,
  type WantedLevel,
  type WantedModifiers,
  type WantedSystemState,
} from './wanted';

export const WANTED_RUNTIME_SNAPSHOT_VERSION = 1 as const;
export const MAX_PROCESSED_WITNESS_REPORTS = 256;

export type WitnessSource = 'pedestrian' | 'security-camera' | 'police';

/** A delivered report. Merely committing a crime does not call this API. */
export interface WitnessReportInput {
  crimeId: string;
  witnessId: string;
  source: WitnessSource;
  severity: 1 | 2 | 3 | 4 | 5;
  confidence: number;
  suspectIdentified: boolean;
  position: PoliceResponsePosition;
}

export type WitnessReportResult =
  | {
    accepted: true;
    key: string;
    heatAdded: number;
    previousLevel: WantedLevel;
    state: WantedSystemState;
  }
  | {
    accepted: false;
    key: string;
    reason: 'duplicate';
    state: WantedSystemState;
  };

export interface WantedRuntimeModifiers {
  nerve: number;
  ending: EndingChoice | null;
  heatGainMultiplier: number;
  searchDurationMultiplier: number;
}

export interface WantedRuntimeSnapshot {
  version: typeof WANTED_RUNTIME_SNAPSHOT_VERSION;
  elapsedSeconds: number;
  modifiers: WantedRuntimeModifiers;
  state: WantedSystemState;
  lastKnownPosition: PoliceResponsePosition | null;
  searchCenter: PoliceResponsePosition | null;
  searchRadius: number;
  processedWitnessReports: string[];
  police: PoliceResponseSnapshot;
}

export interface WantedRuntimeOptions {
  seed?: RandomSeed;
  modifiers?: Partial<WantedRuntimeModifiers> & Pick<WantedRuntimeModifiers, 'nerve'>;
}

export interface WantedRuntimeTickContext {
  playerPosition: PoliceResponsePosition;
  visibleToPolice: boolean;
  roadblockCandidates?: readonly RoadblockCandidate[];
}

const WITNESS_HEAT_BY_SEVERITY: Readonly<Record<WitnessReportInput['severity'], number>> = Object.freeze({
  1: 10,
  2: 24,
  3: 42,
  4: 68,
  5: 100,
});

const SEARCH_RADIUS_BY_LEVEL: Readonly<Record<WantedLevel, number>> = Object.freeze({
  0: 0,
  1: 55,
  2: 75,
  3: 105,
  4: 135,
  5: 175,
});

/**
 * Authoritative crime-report-to-response state machine. The class owns no
 * render or actor instances: consumers spawn its response plan in the world.
 */
export class WantedRuntime {
  private police: PoliceResponseDirector;
  private modifiers: WantedRuntimeModifiers;
  private state: WantedSystemState = createWantedState();
  private elapsedSeconds = 0;
  private lastKnownPosition: PoliceResponsePosition | null = null;
  private searchCenter: PoliceResponsePosition | null = null;
  private readonly processedWitnessReports: string[] = [];
  private readonly processedWitnessReportSet = new Set<string>();

  public constructor(options: WantedRuntimeOptions = {}) {
    this.modifiers = normalizeModifiers(options.modifiers ?? { nerve: 1 });
    this.police = new PoliceResponseDirector(options.seed ?? 'heatline-wanted-runtime-v1');
  }

  public static fromSnapshot(snapshot: Readonly<WantedRuntimeSnapshot>): WantedRuntime {
    validateWantedRuntimeSnapshot(snapshot);
    const runtime = new WantedRuntime({ modifiers: snapshot.modifiers });
    runtime.state = cloneWantedState(snapshot.state);
    runtime.elapsedSeconds = snapshot.elapsedSeconds;
    runtime.lastKnownPosition = cloneNullablePosition(snapshot.lastKnownPosition);
    runtime.searchCenter = cloneNullablePosition(snapshot.searchCenter);
    runtime.processedWitnessReports.push(...snapshot.processedWitnessReports);
    for (const key of snapshot.processedWitnessReports) {
      runtime.processedWitnessReportSet.add(key);
    }
    runtime.replacePolice(PoliceResponseDirector.fromSnapshot(snapshot.police));
    return runtime;
  }

  /** Restores the compact wanted state persisted by the core save schema. */
  public restoreState(
    state: Readonly<WantedSystemState>,
    position: Readonly<PoliceResponsePosition>,
    roadblockCandidates?: readonly RoadblockCandidate[],
  ): WantedRuntimeSnapshot {
    validateWantedState(state);
    validatePosition(position, 'position');
    this.state = cloneWantedState(state);
    if (state.level === 0) {
      this.lastKnownPosition = null;
      this.searchCenter = null;
      this.police.clear();
      return this.getSnapshot();
    }
    this.searchCenter = clonePosition(position);
    this.lastKnownPosition = state.phase === 'pursuit' ? clonePosition(position) : null;
    this.syncPolice(
      0,
      position,
      state.phase === 'pursuit',
      roadblockCandidates,
    );
    return this.getSnapshot();
  }

  public reportWitness(report: Readonly<WitnessReportInput>): WitnessReportResult {
    validateWitnessReport(report);
    const key = witnessReportKey(report);
    if (this.processedWitnessReportSet.has(key)) {
      return {
        accepted: false,
        key,
        reason: 'duplicate',
        state: cloneWantedState(this.state),
      };
    }

    this.rememberWitnessReport(key);
    const previousLevel = this.state.level;
    const previousHeat = this.state.heat;
    const baseHeat = witnessHeat(report);
    const suspectIdentified = report.source === 'police' || report.suspectIdentified;
    this.state = reportCrime(this.state, {
      baseHeat,
      suspectIdentified,
    }, this.modifiers);

    if (suspectIdentified && this.state.level > 0) {
      this.lastKnownPosition = clonePosition(report.position);
    }
    if (this.state.level > 0 && this.searchCenter === null) {
      this.searchCenter = clonePosition(report.position);
    }
    this.syncPolice(0, report.position, suspectIdentified);
    return {
      accepted: true,
      key,
      heatAdded: this.state.heat - previousHeat,
      previousLevel,
      state: cloneWantedState(this.state),
    };
  }

  /** Mission-authored escalation; never lowers an existing wanted level. */
  public escalate(
    targetLevel: WantedLevel,
    position: Readonly<PoliceResponsePosition>,
    suspectIdentified = true,
    roadblockCandidates?: readonly RoadblockCandidate[],
  ): WantedRuntimeSnapshot {
    validatePosition(position, 'position');
    this.state = escalateWanted(this.state, targetLevel, this.modifiers, suspectIdentified);
    if (targetLevel === 0) {
      return this.clear();
    }
    this.searchCenter = clonePosition(position);
    if (suspectIdentified) {
      this.lastKnownPosition = clonePosition(position);
    }
    this.syncPolice(0, position, suspectIdentified, roadblockCandidates);
    return this.getSnapshot();
  }

  public confirmSighting(
    position: Readonly<PoliceResponsePosition>,
    roadblockCandidates?: readonly RoadblockCandidate[],
  ): WantedRuntimeSnapshot {
    validatePosition(position, 'position');
    if (this.state.level === 0) {
      return this.clear();
    }
    this.lastKnownPosition = clonePosition(position);
    this.searchCenter = clonePosition(position);
    this.state = confirmPoliceSighting(this.state, this.modifiers);
    this.syncPolice(0, position, true, roadblockCandidates);
    return this.getSnapshot();
  }

  public tick(
    deltaSeconds: number,
    context: Readonly<WantedRuntimeTickContext>,
  ): WantedRuntimeSnapshot {
    assertFiniteNonNegative(deltaSeconds, 'deltaSeconds');
    validatePosition(context.playerPosition, 'playerPosition');
    this.elapsedSeconds += deltaSeconds;

    if (context.visibleToPolice && this.state.level > 0) {
      this.lastKnownPosition = clonePosition(context.playerPosition);
      this.searchCenter = clonePosition(context.playerPosition);
    } else if (this.state.phase === 'pursuit' && this.searchCenter === null) {
      this.searchCenter = cloneNullablePosition(this.lastKnownPosition) ?? clonePosition(context.playerPosition);
    }

    const center = this.searchCenter ?? this.lastKnownPosition ?? context.playerPosition;
    const insideSearchArea = distance2d(context.playerPosition, center)
      <= searchRadiusForLevel(this.state.level);
    this.state = tickWanted(this.state, deltaSeconds, {
      isVisible: context.visibleToPolice,
      insideSearchArea,
    }, this.modifiers);

    if (this.state.level === 0) {
      this.lastKnownPosition = null;
      this.searchCenter = null;
      this.police.clear();
      return this.getSnapshot();
    }

    this.syncPolice(
      deltaSeconds,
      context.playerPosition,
      context.visibleToPolice,
      context.roadblockCandidates,
    );
    return this.getSnapshot();
  }

  public setModifiers(
    modifiers: Partial<WantedRuntimeModifiers> & Pick<WantedRuntimeModifiers, 'nerve'>,
  ): WantedRuntimeSnapshot {
    this.modifiers = normalizeModifiers(modifiers);
    return this.getSnapshot();
  }

  /** Clears heat and deployed response while retaining report de-duplication. */
  public clear(): WantedRuntimeSnapshot {
    this.state = clearWanted();
    this.lastKnownPosition = null;
    this.searchCenter = null;
    this.police.clear();
    return this.getSnapshot();
  }

  public resolveDefeat(
    input: Readonly<DefeatPenaltyInput>,
    definitions: readonly ItemDefinition[],
    outcome: 'death' | 'arrest',
  ): DefeatPenaltyResult {
    const result = applyDefeatPenalty(input, definitions, outcome);
    this.clear();
    return result;
  }

  public getSnapshot(): WantedRuntimeSnapshot {
    return {
      version: WANTED_RUNTIME_SNAPSHOT_VERSION,
      elapsedSeconds: this.elapsedSeconds,
      modifiers: { ...this.modifiers },
      state: cloneWantedState(this.state),
      lastKnownPosition: cloneNullablePosition(this.lastKnownPosition),
      searchCenter: cloneNullablePosition(this.searchCenter),
      searchRadius: searchRadiusForLevel(this.state.level),
      processedWitnessReports: [...this.processedWitnessReports],
      police: this.police.getSnapshot(),
    };
  }

  private rememberWitnessReport(key: string): void {
    this.processedWitnessReports.push(key);
    this.processedWitnessReportSet.add(key);
    if (this.processedWitnessReports.length <= MAX_PROCESSED_WITNESS_REPORTS) {
      return;
    }
    const removed = this.processedWitnessReports.shift();
    if (removed !== undefined) {
      this.processedWitnessReportSet.delete(removed);
    }
  }

  private syncPolice(
    deltaSeconds: number,
    suspectPosition: Readonly<PoliceResponsePosition>,
    suspectVisible: boolean,
    roadblockCandidates?: readonly RoadblockCandidate[],
  ): void {
    const lastKnownPosition = this.lastKnownPosition ?? this.searchCenter ?? suspectPosition;
    this.police.tick(deltaSeconds, this.state.level, this.state.phase, {
      suspectPosition,
      lastKnownPosition,
      suspectVisible,
      ...(roadblockCandidates === undefined ? {} : { roadblockCandidates }),
    });
  }

  /** Used only by the validated static restore path. */
  private replacePolice(restored: PoliceResponseDirector): void {
    this.police = restored;
  }
}

export function searchRadiusForLevel(level: WantedLevel): number {
  return SEARCH_RADIUS_BY_LEVEL[level];
}

export function witnessHeat(report: Readonly<WitnessReportInput>): number {
  validateWitnessReport(report);
  const confidenceMultiplier = 0.7 + report.confidence * 0.3;
  const sourceMultiplier = report.source === 'police'
    ? 1.15
    : report.source === 'security-camera' ? 0.9 : 1;
  return WITNESS_HEAT_BY_SEVERITY[report.severity] * confidenceMultiplier * sourceMultiplier;
}

export function validateWantedRuntimeSnapshot(
  snapshot: Readonly<WantedRuntimeSnapshot>,
): void {
  if (snapshot.version !== WANTED_RUNTIME_SNAPSHOT_VERSION) {
    throw new RangeError(`unsupported wanted runtime snapshot version ${String(snapshot.version)}`);
  }
  assertFiniteNonNegative(snapshot.elapsedSeconds, 'elapsedSeconds');
  if (!isRecord(snapshot.modifiers)) {
    throw new RangeError('wanted modifiers must be an object');
  }
  normalizeModifiers(snapshot.modifiers);
  if (!isRecord(snapshot.state)) {
    throw new RangeError('wanted state must be an object');
  }
  validateWantedState(snapshot.state);
  validateNullablePosition(snapshot.lastKnownPosition, 'lastKnownPosition');
  validateNullablePosition(snapshot.searchCenter, 'searchCenter');
  if (snapshot.searchRadius !== searchRadiusForLevel(snapshot.state.level)) {
    throw new RangeError('searchRadius does not match the wanted level');
  }
  if (!Array.isArray(snapshot.processedWitnessReports)) {
    throw new RangeError('processed witness reports must be an array');
  }
  if (snapshot.processedWitnessReports.length > MAX_PROCESSED_WITNESS_REPORTS) {
    throw new RangeError('too many processed witness reports');
  }
  const reportKeys = new Set<string>();
  for (const key of snapshot.processedWitnessReports) {
    if (!key || reportKeys.has(key)) {
      throw new RangeError('processed witness report keys must be unique and non-empty');
    }
    reportKeys.add(key);
  }
  if (!isRecord(snapshot.police)) {
    throw new RangeError('police response must be an object');
  }
  validatePoliceResponseSnapshot(snapshot.police);
  if (snapshot.police.level !== snapshot.state.level || snapshot.police.phase !== snapshot.state.phase) {
    throw new RangeError('police response must match wanted state level and phase');
  }
  if (snapshot.state.level === 0 && (snapshot.lastKnownPosition !== null || snapshot.searchCenter !== null)) {
    throw new RangeError('clear wanted snapshots cannot retain search positions');
  }
}

function normalizeModifiers(
  modifiers: Partial<WantedRuntimeModifiers> & Pick<WantedRuntimeModifiers, 'nerve'>,
): WantedRuntimeModifiers {
  if (modifiers.ending !== undefined
    && modifiers.ending !== null
    && modifiers.ending !== 'rule'
    && modifiers.ending !== 'expose') {
    throw new RangeError('ending must be rule, expose, or null');
  }
  const normalized: WantedRuntimeModifiers = {
    nerve: modifiers.nerve,
    ending: modifiers.ending ?? null,
    heatGainMultiplier: modifiers.heatGainMultiplier ?? 1,
    searchDurationMultiplier: modifiers.searchDurationMultiplier ?? 1,
  };
  const wantedModifiers: WantedModifiers = {
    nerve: normalized.nerve,
    ending: normalized.ending,
    heatGainMultiplier: normalized.heatGainMultiplier,
    searchDurationMultiplier: normalized.searchDurationMultiplier,
  };
  // Exercise the shared validation without introducing a second ruleset.
  reportCrime(createWantedState(), { baseHeat: 0, suspectIdentified: false }, wantedModifiers);
  return normalized;
}

function validateWitnessReport(report: Readonly<WitnessReportInput>): void {
  if (!report.crimeId || !report.witnessId) {
    throw new RangeError('crimeId and witnessId must be non-empty');
  }
  if (!['pedestrian', 'security-camera', 'police'].includes(report.source)) {
    throw new RangeError('invalid witness source');
  }
  if (typeof report.suspectIdentified !== 'boolean') {
    throw new RangeError('suspectIdentified must be a boolean');
  }
  if (!Number.isInteger(report.severity) || report.severity < 1 || report.severity > 5) {
    throw new RangeError('witness severity must be an integer between 1 and 5');
  }
  if (!Number.isFinite(report.confidence) || report.confidence < 0 || report.confidence > 1) {
    throw new RangeError('witness confidence must be between 0 and 1');
  }
  if (!isRecord(report.position)) {
    throw new RangeError('witness position must be an object');
  }
  validatePosition(report.position, 'witness position');
}

function validateWantedState(state: Readonly<WantedSystemState>): void {
  if (!Number.isInteger(state.level) || state.level < 0 || state.level > 5) {
    throw new RangeError('wanted level must be an integer between 0 and 5');
  }
  if (!Number.isFinite(state.heat) || state.heat < 0) {
    throw new RangeError('wanted heat must be non-negative and finite');
  }
  if (!Number.isFinite(state.searchSecondsRemaining) || state.searchSecondsRemaining < 0) {
    throw new RangeError('searchSecondsRemaining must be non-negative and finite');
  }
  if ((state.level === 0) !== (state.phase === 'clear')) {
    throw new RangeError('only wanted level zero may use the clear phase');
  }
  if (!['clear', 'investigating', 'pursuit', 'search'].includes(state.phase)) {
    throw new RangeError('invalid wanted phase');
  }
  if (wantedLevelForHeat(state.heat) !== state.level) {
    throw new RangeError('wanted heat does not match wanted level');
  }
}

function witnessReportKey(report: Readonly<WitnessReportInput>): string {
  return `${report.source}:${report.crimeId}:${report.witnessId}`;
}

function cloneWantedState(state: Readonly<WantedSystemState>): WantedSystemState {
  return { ...state };
}

function cloneNullablePosition(
  position: Readonly<PoliceResponsePosition> | null,
): PoliceResponsePosition | null {
  return position === null ? null : clonePosition(position);
}

function clonePosition(position: Readonly<PoliceResponsePosition>): PoliceResponsePosition {
  return { x: position.x, z: position.z };
}

function validateNullablePosition(
  position: Readonly<PoliceResponsePosition> | null,
  label: string,
): void {
  if (position !== null) {
    if (!isRecord(position)) {
      throw new RangeError(`${label} must be an object or null`);
    }
    validatePosition(position, label);
  }
}

function validatePosition(position: Readonly<PoliceResponsePosition>, label: string): void {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.z)) {
    throw new RangeError(`${label} must contain finite coordinates`);
  }
}

function distance2d(
  left: Readonly<PoliceResponsePosition>,
  right: Readonly<PoliceResponsePosition>,
): number {
  return Math.hypot(left.x - right.x, left.z - right.z);
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be non-negative and finite`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
