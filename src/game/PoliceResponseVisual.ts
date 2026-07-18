import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
} from 'three';
import type { BufferGeometry, Material } from 'three';

import { cellIdAt } from '../navigation/cells';
import type { CellId, RoadGraph, RoadGraphNode } from '../navigation/types';
import type { PoliceResponseSnapshot, RoadblockDeployment } from '../systems/policeResponse';
import type { CollisionRect } from './city';
import type { Vec3Data } from './types';

export type PoliceVisualLevel = 0 | 1 | 2 | 3 | 4 | 5;
export type PoliceVisualPhase = 'clear' | 'investigating' | 'pursuit' | 'search';

export interface PoliceResponseVisualUpdate {
  readonly playerPosition: Readonly<Vec3Data>;
  readonly level: PoliceVisualLevel;
  readonly phase: PoliceVisualPhase;
  readonly elapsedSeconds: number;
  readonly reducedMotion: boolean;
  readonly responsePlan?: Readonly<PoliceResponseSnapshot> | null;
  /** Stable exterior road graph used by ground units instead of a player-relative proxy. */
  readonly navigationGraph?: Readonly<RoadGraph> | null;
  /** Currently rendered exterior cells. Units outside them remain simulated but hidden. */
  readonly renderableCellIds?: ReadonlySet<CellId> | null;
  /** World-owned surface sampler; keeps response silhouettes on authored ground. */
  readonly groundHeightAt?: (x: number, z: number) => number;
}

export interface PoliceResponseVisualSnapshot {
  readonly level: PoliceVisualLevel;
  readonly officers: boolean;
  readonly cruisers: boolean;
  readonly roadblock: boolean;
  readonly tacticalVan: boolean;
  readonly helicopter: boolean;
  readonly spotlight: boolean;
}

type GroundResponseRole = 'officers' | 'cruisers' | 'tactical-van';

interface GroundResponseConfiguration {
  readonly minimumLevel: PoliceVisualLevel;
  readonly speedMetersPerSecond: number;
  readonly desiredDistance: number;
  readonly offsetX: number;
  readonly offsetZ: number;
}

interface GroundResponseState {
  initialized: boolean;
  currentNodeId: string | null;
  targetNodeId: string | null;
  previousNodeId: string | null;
  position: Vec3Data;
  heading: number;
}

const GROUND_RESPONSE_CONFIGURATION: Readonly<
  Record<GroundResponseRole, Readonly<GroundResponseConfiguration>>
> = Object.freeze({
  officers: Object.freeze({
    minimumLevel: 1,
    speedMetersPerSecond: 5.2,
    desiredDistance: 18,
    offsetX: -0.55,
    offsetZ: -0.35,
  }),
  cruisers: Object.freeze({
    minimumLevel: 2,
    speedMetersPerSecond: 16,
    desiredDistance: 26,
    offsetX: 0.48,
    offsetZ: -0.42,
  }),
  'tactical-van': Object.freeze({
    minimumLevel: 4,
    speedMetersPerSecond: 12,
    desiredDistance: 34,
    offsetX: -0.72,
    offsetZ: 0.45,
  }),
});

const RESPONSE_RECYCLE_DISTANCE_METERS = 320;
const MAX_VISUAL_STEP_SECONDS = 0.1;
const HELICOPTER_VISUAL_SPEED_METERS_PER_SECOND = 22;
const ROADBLOCK_HEIGHT_METERS = 0.71;

/**
 * Small code-native response silhouettes. These intentionally communicate the
 * escalation ladder without loading character or vehicle assets and without
 * depicting graphic violence.
 */
export class PoliceResponseVisual {
  public readonly root = new Group();

  private readonly officers = new Group();
  private readonly cruisers = new Group();
  private readonly roadblock = new Group();
  private readonly tacticalVan = new Group();
  private readonly helicopter = new Group();
  private readonly rotor = new Group();
  private readonly spotlight: Mesh;
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: Material[] = [];
  private readonly roadblockCollisions: CollisionRect[] = [];
  private readonly officerState = createGroundResponseState();
  private readonly cruiserState = createGroundResponseState();
  private readonly tacticalVanState = createGroundResponseState();
  private readonly fallbackRoadblockState = createGroundResponseState();
  private readonly helicopterPosition: Vec3Data = { x: 0, y: 18, z: 0 };
  private helicopterInitialized = false;
  private navigationGraph: Readonly<RoadGraph> | null = null;
  private readonly navigationNodes = new Map<string, Readonly<RoadGraphNode>>();
  private readonly navigationNeighbors = new Map<string, readonly string[]>();
  private lastElapsedSeconds: number | null = null;
  private level: PoliceVisualLevel = 0;

  public constructor() {
    this.root.name = 'police-response-visual';
    this.officers.name = 'police-foot-patrols';
    this.cruisers.name = 'police-cruisers';
    this.roadblock.name = 'police-roadblock';
    this.tacticalVan.name = 'police-tactical-van';
    this.helicopter.name = 'police-helicopter';

    const uniform = this.material(new MeshStandardMaterial({ color: 0x233b5c, roughness: 0.82 }));
    const skin = this.material(new MeshStandardMaterial({ color: 0xb67f62, roughness: 0.9 }));
    const cruiserWhite = this.material(new MeshStandardMaterial({ color: 0xe8edf1, roughness: 0.52, metalness: 0.16 }));
    const cruiserDark = this.material(new MeshStandardMaterial({ color: 0x17293e, roughness: 0.58, metalness: 0.2 }));
    const red = this.material(new MeshBasicMaterial({ color: 0xff4b42 }));
    const blue = this.material(new MeshBasicMaterial({ color: 0x3ba4ff }));
    const hazard = this.material(new MeshStandardMaterial({ color: 0xffb33d, roughness: 0.7 }));
    const tactical = this.material(new MeshStandardMaterial({ color: 0x354047, roughness: 0.78 }));
    const rotorMaterial = this.material(new MeshStandardMaterial({ color: 0x121a22, roughness: 0.62, metalness: 0.28 }));
    const spotlightMaterial = this.material(new MeshBasicMaterial({
      color: 0xffefad,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    }));

    const officerBody = this.geometry(new CylinderGeometry(0.28, 0.34, 1.3, 6));
    const officerHead = this.geometry(new CylinderGeometry(0.23, 0.23, 0.38, 8));
    for (const [index, x] of [-1.5, 1.5].entries()) {
      const body = new Mesh(officerBody, uniform);
      body.position.set(x, 0.68, index === 0 ? 0 : 0.45);
      body.castShadow = true;
      const head = new Mesh(officerHead, skin);
      head.position.set(x, 1.52, index === 0 ? 0 : 0.45);
      head.castShadow = true;
      this.officers.add(body, head);
    }

    const carBody = this.geometry(new BoxGeometry(2.05, 0.72, 4.2));
    const carCabin = this.geometry(new BoxGeometry(1.65, 0.58, 1.9));
    const lightBar = this.geometry(new BoxGeometry(0.62, 0.12, 0.24));
    for (const [index, x] of [-4.8, 4.8].entries()) {
      const cruiser = new Group();
      cruiser.position.set(x, 0, index === 0 ? -1.8 : 1.8);
      cruiser.rotation.y = index === 0 ? 0.12 : Math.PI + 0.12;
      const body = new Mesh(carBody, cruiserWhite);
      body.position.y = 0.48;
      const cabin = new Mesh(carCabin, cruiserDark);
      cabin.position.set(0, 1.06, -0.2);
      const leftLight = new Mesh(lightBar, red);
      leftLight.position.set(-0.36, 1.41, -0.2);
      const rightLight = new Mesh(lightBar, blue);
      rightLight.position.set(0.36, 1.41, -0.2);
      cruiser.add(body, cabin, leftLight, rightLight);
      this.cruisers.add(cruiser);
    }

    const barrierGeometry = this.geometry(new BoxGeometry(2.6, 0.58, 0.42));
    for (const x of [-2.8, 0, 2.8]) {
      const barrier = new Mesh(barrierGeometry, hazard);
      barrier.position.set(x, 0.42, 0);
      barrier.rotation.z = x === 0 ? 0 : (x < 0 ? -0.04 : 0.04);
      this.roadblock.add(barrier);
    }

    const vanBody = new Mesh(this.geometry(new BoxGeometry(2.4, 1.55, 4.8)), tactical);
    vanBody.position.y = 0.9;
    const vanCabin = new Mesh(this.geometry(new BoxGeometry(2.15, 0.72, 1.55)), cruiserDark);
    vanCabin.position.set(0, 1.63, -1.1);
    this.tacticalVan.add(vanBody, vanCabin);

    const helicopterBody = new Mesh(this.geometry(new BoxGeometry(2.15, 1.05, 4.1)), tactical);
    const helicopterCabin = new Mesh(this.geometry(new BoxGeometry(1.9, 0.82, 1.4)), cruiserDark);
    helicopterCabin.position.set(0, -0.05, -1.65);
    const tail = new Mesh(this.geometry(new BoxGeometry(0.42, 0.38, 4.3)), rotorMaterial);
    tail.position.set(0, 0.22, 3.65);
    const rotorBlade = this.geometry(new BoxGeometry(8.6, 0.08, 0.22));
    const rotorA = new Mesh(rotorBlade, rotorMaterial);
    const rotorB = new Mesh(rotorBlade, rotorMaterial);
    rotorB.rotation.y = Math.PI / 2;
    this.rotor.position.y = 0.72;
    this.rotor.add(rotorA, rotorB);
    this.spotlight = new Mesh(this.geometry(new ConeGeometry(4.8, 13, 16, 1, true)), spotlightMaterial);
    this.spotlight.position.y = -6.7;
    this.helicopter.add(helicopterBody, helicopterCabin, tail, this.rotor, this.spotlight);

    this.root.add(this.officers, this.cruisers, this.roadblock, this.tacticalVan, this.helicopter);
    this.update({
      playerPosition: { x: 0, y: 0, z: 0 },
      level: 0,
      phase: 'clear',
      elapsedSeconds: 0,
      reducedMotion: false,
    });
  }

  public update(update: Readonly<PoliceResponseVisualUpdate>): void {
    this.syncNavigationGraph(update.navigationGraph ?? null);
    const deltaSeconds = this.visualDeltaSeconds(update.elapsedSeconds);
    const groundHeightAt = update.groundHeightAt ?? flatGroundHeight;
    const renderableCellIds = update.renderableCellIds ?? null;
    this.level = update.level;
    this.roadblockCollisions.length = 0;
    // Every child transform is authored in world space. Keeping this invariant
    // prevents camera/player movement from dragging the response formation.
    this.root.position.set(0, 0, 0);
    this.root.visible = update.level > 0;
    this.helicopter.visible = update.level >= 5;
    this.spotlight.visible = update.level >= 5 && update.phase !== 'clear';
    if (update.level === 0) {
      this.officers.visible = false;
      this.cruisers.visible = false;
      this.roadblock.visible = false;
      this.tacticalVan.visible = false;
      this.resetGroundResponses();
      this.helicopterInitialized = false;
      return;
    }

    this.updateGroundResponse(
      'officers',
      this.officers,
      this.officerState,
      update,
      deltaSeconds,
      renderableCellIds,
      groundHeightAt,
    );
    this.updateGroundResponse(
      'cruisers',
      this.cruisers,
      this.cruiserState,
      update,
      deltaSeconds,
      renderableCellIds,
      groundHeightAt,
    );
    this.updateGroundResponse(
      'tactical-van',
      this.tacticalVan,
      this.tacticalVanState,
      update,
      deltaSeconds,
      renderableCellIds,
      groundHeightAt,
    );
    this.updateRoadblock(update, renderableCellIds, groundHeightAt);

    const searchDistance = update.phase === 'search' || update.phase === 'investigating' ? 30 : 20;
    const plannedHelicopter = update.responsePlan?.helicopter;
    if (update.level >= 5) {
      const desiredHelicopterPosition = plannedHelicopter?.active
        ? plannedHelicopter.position
        : {
            x: update.playerPosition.x + searchDistance * 0.42,
            y: 18,
            z: update.playerPosition.z + searchDistance * 0.25,
          };
      this.updateHelicopterPosition(
        desiredHelicopterPosition,
        update.playerPosition,
        deltaSeconds,
      );
      this.helicopter.position.set(
        this.helicopterPosition.x,
        this.helicopterPosition.y,
        this.helicopterPosition.z,
      );
    } else {
      this.helicopterInitialized = false;
    }
    if (!update.reducedMotion) {
      this.rotor.rotation.y = update.elapsedSeconds * 18;
      const pulse = 1 + Math.sin(update.elapsedSeconds * 2.4) * 0.06;
      this.spotlight.scale.set(pulse, 1, pulse);
    } else {
      this.rotor.rotation.y = 0;
      this.spotlight.scale.set(1, 1, 1);
    }
  }

  public snapshot(): PoliceResponseVisualSnapshot {
    return {
      level: this.level,
      officers: this.officers.visible,
      cruisers: this.cruisers.visible,
      roadblock: this.roadblock.visible,
      tacticalVan: this.tacticalVan.visible,
      helicopter: this.helicopter.visible,
      spotlight: this.spotlight.visible,
    };
  }

  /**
   * World-space blockers matching the three visible barricade segments.
   * They are intentionally absent below heat level three so an invisible
   * police response can never obstruct traversal.
   */
  public get collisions(): readonly CollisionRect[] {
    return this.roadblockCollisions;
  }

  public dispose(): void {
    this.root.removeFromParent();
    this.roadblockCollisions.length = 0;
    this.geometries.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
  }

  private addRoadblockCollisions(
    deployment: Readonly<RoadblockDeployment>,
    groundHeight: number,
  ): void {
    const cosine = Math.cos(deployment.heading);
    const sine = Math.sin(deployment.heading);
    const halfX = Math.abs(cosine) * 1.3 + Math.abs(sine) * 0.21;
    const halfZ = Math.abs(sine) * 1.3 + Math.abs(cosine) * 0.21;
    for (const [index, barrierX] of [-2.8, 0, 2.8].entries()) {
      const centerX = deployment.position.x + cosine * barrierX;
      const centerZ = deployment.position.z - sine * barrierX;
      this.roadblockCollisions.push({
        id: deployment.id === 'fallback'
          ? `police-roadblock-barrier-${index + 1}`
          : `police-roadblock-${deployment.id}-barrier-${index + 1}`,
        minX: centerX - halfX,
        maxX: centerX + halfX,
        minZ: centerZ - halfZ,
        maxZ: centerZ + halfZ,
        height: groundHeight + ROADBLOCK_HEIGHT_METERS,
        kind: 'solid',
      });
    }
  }

  private visualDeltaSeconds(elapsedSeconds: number): number {
    const previous = this.lastElapsedSeconds;
    this.lastElapsedSeconds = elapsedSeconds;
    if (previous === null || !Number.isFinite(elapsedSeconds) || elapsedSeconds < previous) {
      return 0;
    }
    return Math.min(MAX_VISUAL_STEP_SECONDS, elapsedSeconds - previous);
  }

  private updateHelicopterPosition(
    desired: Readonly<Vec3Data>,
    playerPosition: Readonly<Vec3Data>,
    deltaSeconds: number,
  ): void {
    if (
      !this.helicopterInitialized
      || distance2d(this.helicopterPosition, playerPosition)
        > RESPONSE_RECYCLE_DISTANCE_METERS
    ) {
      this.helicopterPosition.x = desired.x;
      this.helicopterPosition.y = desired.y;
      this.helicopterPosition.z = desired.z;
      this.helicopterInitialized = true;
      return;
    }
    const deltaX = desired.x - this.helicopterPosition.x;
    const deltaY = desired.y - this.helicopterPosition.y;
    const deltaZ = desired.z - this.helicopterPosition.z;
    const distance = Math.hypot(deltaX, deltaY, deltaZ);
    if (distance <= 0.001 || deltaSeconds <= 0) return;
    const movement = Math.min(
      distance,
      HELICOPTER_VISUAL_SPEED_METERS_PER_SECOND * deltaSeconds,
    );
    this.helicopterPosition.x += deltaX / distance * movement;
    this.helicopterPosition.y += deltaY / distance * movement;
    this.helicopterPosition.z += deltaZ / distance * movement;
  }

  private syncNavigationGraph(graph: Readonly<RoadGraph> | null): void {
    if (graph === this.navigationGraph) return;
    this.navigationGraph = graph;
    this.navigationNodes.clear();
    this.navigationNeighbors.clear();
    if (graph === null) return;

    for (const node of graph.nodes) {
      this.navigationNodes.set(node.id, node);
      this.navigationNeighbors.set(node.id, []);
    }
    const mutableNeighbors = new Map<string, Set<string>>();
    for (const node of graph.nodes) {
      mutableNeighbors.set(node.id, new Set());
    }
    for (const edge of graph.edges) {
      if (!this.navigationNodes.has(edge.fromNodeId) || !this.navigationNodes.has(edge.toNodeId)) {
        continue;
      }
      mutableNeighbors.get(edge.fromNodeId)?.add(edge.toNodeId);
      mutableNeighbors.get(edge.toNodeId)?.add(edge.fromNodeId);
    }
    for (const [nodeId, neighbors] of mutableNeighbors) {
      this.navigationNeighbors.set(nodeId, [...neighbors].sort((left, right) => left.localeCompare(right)));
    }
    this.resetGroundResponses();
  }

  private updateGroundResponse(
    role: GroundResponseRole,
    group: Group,
    state: GroundResponseState,
    update: Readonly<PoliceResponseVisualUpdate>,
    deltaSeconds: number,
    renderableCellIds: ReadonlySet<CellId> | null,
    groundHeightAt: (x: number, z: number) => number,
  ): void {
    const configuration = GROUND_RESPONSE_CONFIGURATION[role];
    if (update.level < configuration.minimumLevel) {
      group.visible = false;
      resetGroundResponseState(state);
      return;
    }

    const distanceFromPlayer = state.initialized
      ? distance2d(state.position, update.playerPosition)
      : Number.POSITIVE_INFINITY;
    const currentNodeMissing = state.currentNodeId !== null
      && !this.navigationNodes.has(state.currentNodeId);
    if (
      !state.initialized
      || currentNodeMissing
      || distanceFromPlayer > RESPONSE_RECYCLE_DISTANCE_METERS
    ) {
      this.placeGroundResponse(role, state, update.playerPosition, renderableCellIds, groundHeightAt);
    } else {
      this.advanceGroundResponse(
        role,
        state,
        update.playerPosition,
        deltaSeconds,
        renderableCellIds,
        groundHeightAt,
      );
    }

    group.position.set(state.position.x, state.position.y, state.position.z);
    group.rotation.y = state.heading;
    group.visible = state.initialized
      && this.positionIsRenderable(state.position, renderableCellIds);
  }

  private placeGroundResponse(
    role: GroundResponseRole,
    state: GroundResponseState,
    playerPosition: Readonly<Vec3Data>,
    renderableCellIds: ReadonlySet<CellId> | null,
    groundHeightAt: (x: number, z: number) => number,
  ): void {
    const node = this.selectResponseNode(role, playerPosition, renderableCellIds);
    const configuration = GROUND_RESPONSE_CONFIGURATION[role];
    const position = node?.position ?? {
      x: playerPosition.x + configuration.offsetX * configuration.desiredDistance,
      z: playerPosition.z + configuration.offsetZ * configuration.desiredDistance,
    };
    state.initialized = true;
    state.currentNodeId = node?.id ?? null;
    state.targetNodeId = null;
    state.previousNodeId = null;
    state.position.x = position.x;
    state.position.z = position.z;
    state.position.y = groundHeightAt(position.x, position.z);
    state.heading = node ? this.headingFromNode(node.id) : 0;
  }

  private advanceGroundResponse(
    role: GroundResponseRole,
    state: GroundResponseState,
    playerPosition: Readonly<Vec3Data>,
    deltaSeconds: number,
    renderableCellIds: ReadonlySet<CellId> | null,
    groundHeightAt: (x: number, z: number) => number,
  ): void {
    if (state.currentNodeId === null || deltaSeconds <= 0) {
      state.position.y = groundHeightAt(state.position.x, state.position.z);
      return;
    }

    const configuration = GROUND_RESPONSE_CONFIGURATION[role];
    let remainingMovement = configuration.speedMetersPerSecond * deltaSeconds;
    for (let transitions = 0; transitions < 4 && remainingMovement > 0; transitions += 1) {
      if (state.targetNodeId === null) {
        state.targetNodeId = this.selectNextNode(
          role,
          state,
          playerPosition,
          renderableCellIds,
        );
      }
      if (state.targetNodeId === null) break;
      const target = this.navigationNodes.get(state.targetNodeId);
      if (target === undefined) {
        state.targetNodeId = null;
        break;
      }
      const deltaX = target.position.x - state.position.x;
      const deltaZ = target.position.z - state.position.z;
      const distance = Math.hypot(deltaX, deltaZ);
      if (distance <= 0.001) {
        state.previousNodeId = state.currentNodeId;
        state.currentNodeId = target.id;
        state.targetNodeId = null;
        continue;
      }
      state.heading = Math.atan2(deltaX, deltaZ);
      const movement = Math.min(distance, remainingMovement);
      state.position.x += deltaX / distance * movement;
      state.position.z += deltaZ / distance * movement;
      remainingMovement -= movement;
      if (movement >= distance - 0.001) {
        state.previousNodeId = state.currentNodeId;
        state.currentNodeId = target.id;
        state.targetNodeId = null;
      }
    }
    state.position.y = groundHeightAt(state.position.x, state.position.z);
  }

  private selectResponseNode(
    role: GroundResponseRole | 'roadblock',
    playerPosition: Readonly<Vec3Data>,
    renderableCellIds: ReadonlySet<CellId> | null,
  ): Readonly<RoadGraphNode> | null {
    const configuration = role === 'roadblock'
      ? { desiredDistance: 30, offsetX: 0, offsetZ: -1 }
      : GROUND_RESPONSE_CONFIGURATION[role];
    const desired = {
      x: playerPosition.x + configuration.offsetX * configuration.desiredDistance,
      z: playerPosition.z + configuration.offsetZ * configuration.desiredDistance,
    };
    let selected: Readonly<RoadGraphNode> | null = null;
    let selectedScore = Number.POSITIVE_INFINITY;
    for (const node of this.navigationNodes.values()) {
      if (!this.positionIsRenderable(node.position, renderableCellIds)) continue;
      const score = distance2d(node.position, desired);
      if (
        score < selectedScore - Number.EPSILON
        || (
          Math.abs(score - selectedScore) <= Number.EPSILON
          && (selected === null || node.id.localeCompare(selected.id) < 0)
        )
      ) {
        selected = node;
        selectedScore = score;
      }
    }
    return selected;
  }

  private selectNextNode(
    role: GroundResponseRole,
    state: GroundResponseState,
    playerPosition: Readonly<Vec3Data>,
    renderableCellIds: ReadonlySet<CellId> | null,
  ): string | null {
    if (state.currentNodeId === null) return null;
    const configuration = GROUND_RESPONSE_CONFIGURATION[role];
    const desired = {
      x: playerPosition.x + configuration.offsetX * configuration.desiredDistance,
      z: playerPosition.z + configuration.offsetZ * configuration.desiredDistance,
    };
    const candidates = [
      state.currentNodeId,
      ...(this.navigationNeighbors.get(state.currentNodeId) ?? []),
    ];
    let selected = state.currentNodeId;
    let selectedScore = Number.POSITIVE_INFINITY;
    for (const nodeId of candidates) {
      const node = this.navigationNodes.get(nodeId);
      if (node === undefined || !this.positionIsRenderable(node.position, renderableCellIds)) continue;
      const reversePenalty = nodeId === state.previousNodeId && candidates.length > 2 ? 3 : 0;
      const score = distance2d(node.position, desired) + reversePenalty;
      if (
        score < selectedScore - Number.EPSILON
        || (Math.abs(score - selectedScore) <= Number.EPSILON && nodeId.localeCompare(selected) < 0)
      ) {
        selected = nodeId;
        selectedScore = score;
      }
    }
    return selected === state.currentNodeId ? null : selected;
  }

  private updateRoadblock(
    update: Readonly<PoliceResponseVisualUpdate>,
    renderableCellIds: ReadonlySet<CellId> | null,
    groundHeightAt: (x: number, z: number) => number,
  ): void {
    if (update.level < 3) {
      this.roadblock.visible = false;
      resetGroundResponseState(this.fallbackRoadblockState);
      return;
    }

    const plannedDeployments = update.responsePlan?.roadblocks ?? [];
    let deployments: readonly Readonly<RoadblockDeployment>[] = plannedDeployments;
    if (deployments.length === 0) {
      const distanceFromPlayer = this.fallbackRoadblockState.initialized
        ? distance2d(this.fallbackRoadblockState.position, update.playerPosition)
        : Number.POSITIVE_INFINITY;
      if (
        !this.fallbackRoadblockState.initialized
        || distanceFromPlayer > RESPONSE_RECYCLE_DISTANCE_METERS
      ) {
        const node = this.selectResponseNode('roadblock', update.playerPosition, renderableCellIds);
        const position = node?.position ?? {
          x: update.playerPosition.x,
          z: update.playerPosition.z - 30,
        };
        this.fallbackRoadblockState.initialized = true;
        this.fallbackRoadblockState.currentNodeId = node?.id ?? null;
        this.fallbackRoadblockState.position = {
          x: position.x,
          y: groundHeightAt(position.x, position.z),
          z: position.z,
        };
        this.fallbackRoadblockState.heading = node ? this.headingFromNode(node.id) : 0;
      }
      deployments = [{
        id: 'fallback',
        anchorId: this.fallbackRoadblockState.currentNodeId ?? 'fallback',
        position: {
          x: this.fallbackRoadblockState.position.x,
          z: this.fallbackRoadblockState.position.z,
        },
        heading: this.fallbackRoadblockState.heading,
        reinforced: update.level === 5,
        tireStrip: true,
      }];
    }

    const renderableDeployments = deployments.filter((deployment) =>
      this.positionIsRenderable(deployment.position, renderableCellIds),
    );
    const visualDeployment = renderableDeployments[0];
    this.roadblock.visible = visualDeployment !== undefined;
    if (visualDeployment !== undefined) {
      const groundHeight = groundHeightAt(
        visualDeployment.position.x,
        visualDeployment.position.z,
      );
      this.roadblock.position.set(
        visualDeployment.position.x,
        groundHeight,
        visualDeployment.position.z,
      );
      this.roadblock.rotation.y = visualDeployment.heading;
      this.addRoadblockCollisions(visualDeployment, groundHeight);
    }
  }

  private headingFromNode(nodeId: string): number {
    const node = this.navigationNodes.get(nodeId);
    const neighborId = this.navigationNeighbors.get(nodeId)?.[0];
    const neighbor = neighborId ? this.navigationNodes.get(neighborId) : undefined;
    return node && neighbor
      ? Math.atan2(neighbor.position.x - node.position.x, neighbor.position.z - node.position.z)
      : 0;
  }

  private positionIsRenderable(
    position: Readonly<{ x: number; z: number }>,
    renderableCellIds: ReadonlySet<CellId> | null,
  ): boolean {
    return renderableCellIds === null || renderableCellIds.has(cellIdAt(position));
  }

  private resetGroundResponses(): void {
    resetGroundResponseState(this.officerState);
    resetGroundResponseState(this.cruiserState);
    resetGroundResponseState(this.tacticalVanState);
    resetGroundResponseState(this.fallbackRoadblockState);
  }

  private geometry<T extends BufferGeometry>(geometry: T): T {
    this.geometries.push(geometry);
    return geometry;
  }

  private material<T extends Material>(material: T): T {
    this.materials.push(material);
    return material;
  }
}

function createGroundResponseState(): GroundResponseState {
  return {
    initialized: false,
    currentNodeId: null,
    targetNodeId: null,
    previousNodeId: null,
    position: { x: 0, y: 0, z: 0 },
    heading: 0,
  };
}

function resetGroundResponseState(state: GroundResponseState): void {
  state.initialized = false;
  state.currentNodeId = null;
  state.targetNodeId = null;
  state.previousNodeId = null;
  state.position.x = 0;
  state.position.y = 0;
  state.position.z = 0;
  state.heading = 0;
}

function flatGroundHeight(): number {
  return 0;
}

function distance2d(
  first: Readonly<{ x: number; z: number }>,
  second: Readonly<{ x: number; z: number }>,
): number {
  return Math.hypot(second.x - first.x, second.z - first.z);
}
