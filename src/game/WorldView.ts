import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  MathUtils,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';

import { cellIdAt } from '../navigation/cells';
import type { CellId } from '../navigation/types';
import type { RoadClosureState } from '../navigation/types';
import { CitySimulation } from '../simulation';
import type {
  ActorPopulationLimits,
  CitySimulationSnapshot,
} from '../simulation';
import { computeCameraPlacement, oppositeShoulder } from './camera';
import type { DrawDensityLimits } from './CityStreamingController';
import { PLAYER_SPAWN, VEHICLE_SPAWN, districtAt, generateCity } from './city';
import type { CityLayout, CollisionRect } from './city';
import { DefaultWorldControls } from './controls';
import {
  advanceEnvironment,
  createEnvironmentState,
  dayPhaseAt,
  environmentPaletteAt,
  updateEnvironment,
} from './environment';
import type { EnvironmentState } from './environment';
import { createPlayerState, stepPlayer } from './player';
import type { PlayerSimulationState } from './player';
import { findNearestInteractionTarget } from './interaction';
import { InteriorPortalVisual } from './InteriorPortalVisual';
import { InteriorRuntime } from './InteriorRuntime';
import type { InteriorActorState, InteriorTransform } from './InteriorRuntime';
import { InteriorSceneVisual } from './InteriorSceneVisual';
import { RoadClosureVisual } from './RoadClosureVisual';
import { createWorldInputState } from './types';
import type {
  EnvironmentUpdate,
  ShoulderSide,
  WorldInputState,
  WorldSnapshot,
  WorldViewOptions,
} from './types';
import {
  VEHICLE_RADIUS,
  createVehicleState,
  findVehicleExitPoint,
  stepVehicle,
  vehicleCanExit,
} from './vehicle';
import type { VehicleSimulationState } from './vehicle';
import { AvatarVisual, RainField, VehicleVisual, createCityVisuals } from './visuals';
import type { CityVisualBundle } from './visuals';
import type { CityVisualStreamingSnapshot } from './visuals';

const DEFAULT_CAMERA_YAW = Math.PI * 0.14;
const DEFAULT_CAMERA_PITCH = 0.42;
const CAMERA_TARGET_HEIGHT = 1.48;

function clampAxis(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function copyInput(target: WorldInputState, source: Partial<WorldInputState>): void {
  if (source.moveForward !== undefined) {
    target.moveForward = clampAxis(source.moveForward);
  }
  if (source.moveRight !== undefined) {
    target.moveRight = clampAxis(source.moveRight);
  }
  if (source.sprint !== undefined) {
    target.sprint = source.sprint;
  }
  if (source.jump !== undefined) {
    target.jump = source.jump;
  }
  if (source.crouch !== undefined) {
    target.crouch = source.crouch;
  }
  if (source.aim !== undefined) {
    target.aim = source.aim;
  }
  if (source.shoulderSwap !== undefined) {
    target.shoulderSwap ||= source.shoulderSwap;
  }
  if (source.handbrake !== undefined) {
    target.handbrake = source.handbrake;
  }
  if (source.interact !== undefined) {
    target.interact ||= source.interact;
  }
  if (source.cameraYawDelta !== undefined) {
    target.cameraYawDelta += source.cameraYawDelta;
  }
  if (source.cameraPitchDelta !== undefined) {
    target.cameraPitchDelta += source.cameraPitchDelta;
  }
}

export class WorldView {
  public readonly renderer: WebGLRenderer;
  public readonly scene: Scene;
  public readonly camera: PerspectiveCamera;
  public readonly fog: FogExp2;
  public readonly hemisphereLight: HemisphereLight;
  public readonly sunLight: DirectionalLight;
  public readonly layout: CityLayout;

  private readonly mount: HTMLElement;
  private readonly player: PlayerSimulationState;
  private readonly vehicle: VehicleSimulationState;
  private readonly environment: EnvironmentState;
  private readonly externalInput = createWorldInputState();
  private readonly cityVisuals: CityVisualBundle;
  private readonly citySimulation: CitySimulation;
  private readonly interiorRuntime: InteriorRuntime;
  private readonly interiorSceneVisual: InteriorSceneVisual;
  private readonly interiorPortalVisual: InteriorPortalVisual;
  private readonly roadClosureVisual: RoadClosureVisual;
  private readonly avatarVisual: AvatarVisual;
  private readonly vehicleVisual: VehicleVisual;
  private readonly rainField: RainField;
  private readonly controls: DefaultWorldControls | null;
  private readonly inputProvider: (() => Partial<WorldInputState>) | null;
  private reducedMotion: boolean;
  private resolutionScale: number;
  private readonly onSnapshot: ((snapshot: WorldSnapshot) => void) | null;
  private readonly onFrame: ((frameMilliseconds: number) => void) | null;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly cameraTarget = new Vector3();
  private readonly desiredCamera = new Vector3();
  private readonly desiredLookTarget = new Vector3();

  private cameraYaw = DEFAULT_CAMERA_YAW;
  private cameraPitch = DEFAULT_CAMERA_PITCH;
  private currentAim = false;
  private shoulderSide: ShoulderSide = 'right';
  private running = false;
  private paused = false;
  private focused = false;
  private disposed = false;
  private animationFrame: number | null = null;
  private previousFrameTime = 0;
  private snapshotElapsed = Number.POSITIVE_INFINITY;
  private elapsedSeconds = 0;
  private interiorTransitionPending = false;
  private exteriorCollisions: readonly CollisionRect[];

  public constructor(options: WorldViewOptions) {
    this.mount = options.mount;
    const quality = options.quality ?? 'high';
    this.reducedMotion = options.reducedMotion ?? false;
    this.resolutionScale = MathUtils.clamp(options.resolutionScale ?? 1, 0.5, 1);
    this.inputProvider = options.inputProvider ?? null;
    this.onSnapshot = options.onSnapshot ?? null;
    this.onFrame = options.onFrame ?? null;
    this.layout = generateCity(options.seed ?? 'heatline-solara-world-v1', quality);
    this.exteriorCollisions = this.layout.collisions;
    this.player = createPlayerState(options.initialPosition ?? PLAYER_SPAWN);
    this.player.heading = options.initialHeading ?? 0;
    this.vehicle = createVehicleState(VEHICLE_SPAWN);
    this.environment = createEnvironmentState({
      timeOfDay: options.timeOfDay,
      rainIntensity: options.rainIntensity,
      clockRate: options.clockRate,
    });

    this.scene = new Scene();
    this.scene.background = new Color(0x47aeda);
    this.fog = new FogExp2(0x82becb, 0.0011);
    this.scene.fog = this.fog;
    this.camera = new PerspectiveCamera(62, 1, 0.1, 1_850);
    this.camera.position.set(-242, 6.2, 256);

    this.renderer = new WebGLRenderer({
      antialias: quality === 'high',
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = quality === 'high';
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.domElement.className = 'world-view__canvas';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.addEventListener('focus', this.onCanvasFocus);
    this.renderer.domElement.addEventListener('blur', this.onCanvasBlur);
    window.addEventListener('blur', this.onWindowBlur);
    this.mount.append(this.renderer.domElement);

    this.hemisphereLight = new HemisphereLight(0xa9e4f6, 0x6d7c63, 1.3);
    this.sunLight = new DirectionalLight(0xffefc0, 2.05);
    this.sunLight.position.set(-180, 420, 210);
    this.sunLight.castShadow = quality === 'high';
    this.sunLight.shadow.mapSize.set(1_024, 1_024);
    this.sunLight.shadow.camera.left = -90;
    this.sunLight.shadow.camera.right = 90;
    this.sunLight.shadow.camera.top = 90;
    this.sunLight.shadow.camera.bottom = -90;
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 800;
    this.scene.add(this.hemisphereLight, this.sunLight);

    this.cityVisuals = createCityVisuals(this.layout);
    this.citySimulation = new CitySimulation({
      seed: `${this.layout.seed}:city-life`,
      quality,
      roads: this.layout.roads,
      seedCombatants: false,
    });
    this.interiorRuntime = new InteriorRuntime();
    this.interiorSceneVisual = new InteriorSceneVisual();
    this.interiorPortalVisual = new InteriorPortalVisual(this.interiorRuntime.definitions);
    this.roadClosureVisual = new RoadClosureVisual();
    this.avatarVisual = new AvatarVisual();
    this.vehicleVisual = new VehicleVisual();
    this.rainField = new RainField(this.layout.seed, quality);
    this.scene.add(
      this.cityVisuals.root,
      this.interiorSceneVisual.root,
      this.interiorPortalVisual.root,
      this.roadClosureVisual.root,
      this.avatarVisual.root,
      this.vehicleVisual.root,
      this.rainField.points,
    );
    this.citySimulation.attach(this.scene);
    this.avatarVisual.sync(this.player);
    this.vehicleVisual.sync(this.vehicle, 0);

    this.controls = options.enableDefaultControls === false
      ? null
      : new DefaultWorldControls(this.renderer.domElement);
    this.resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => this.resize());
    this.resizeObserver?.observe(this.mount);
    this.resize();
    this.applyEnvironmentVisuals();
    this.updateCamera(1);
    this.emitSnapshot(true);
  }

  /**
   * Supplies persistent analog/button state from an app input layer. Camera
   * deltas and `interact` are consumed once; other values persist until reset.
   */
  public setInput(input: Partial<WorldInputState>): void {
    this.assertAlive();
    copyInput(this.externalInput, input);
  }

  public clearInput(): void {
    Object.assign(this.externalInput, createWorldInputState());
    this.controls?.clear();
    this.currentAim = false;
  }

  public focus(): void {
    this.assertAlive();
    this.renderer.domElement.focus({ preventScroll: true });
  }

  public pause(): void {
    this.stop();
  }

  public resume(): void {
    this.start();
  }

  public setEnvironment(update: EnvironmentUpdate): void {
    this.assertAlive();
    updateEnvironment(this.environment, update);
    this.applyEnvironmentVisuals();
    this.emitSnapshot(true);
  }

  public setPresentation(options: {
    readonly reducedMotion?: boolean;
    readonly resolutionScale?: number;
  }): void {
    this.assertAlive();
    if (options.reducedMotion !== undefined) {
      this.reducedMotion = options.reducedMotion;
    }
    if (options.resolutionScale !== undefined) {
      if (!Number.isFinite(options.resolutionScale)) {
        throw new TypeError('resolutionScale must be finite');
      }
      const resolutionScale = MathUtils.clamp(options.resolutionScale, 0.5, 1);
      if (resolutionScale !== this.resolutionScale) {
        this.resolutionScale = resolutionScale;
        this.resize();
      }
    }
  }

  public setCityStreaming(
    renderableActiveCellIds: readonly CellId[],
    residentCellIds: readonly CellId[],
    drawDensity: Readonly<DrawDensityLimits>,
  ): CityVisualStreamingSnapshot {
    this.assertAlive();
    const active = new Set(renderableActiveCellIds);
    this.exteriorCollisions = this.layout.collisions.filter((collision) =>
      active.has(cellIdAt({
        x: (collision.minX + collision.maxX) / 2,
        z: (collision.minZ + collision.maxZ) / 2,
      })),
    );
    this.interiorPortalVisual.setResidentCellIds(residentCellIds);
    return this.cityVisuals.applyStreamingState(
      renderableActiveCellIds,
      residentCellIds,
      drawDensity,
    );
  }

  public setActorLimits(
    limits: Readonly<ActorPopulationLimits>,
  ): ActorPopulationLimits {
    this.assertAlive();
    return this.citySimulation.setActorLimits(limits);
  }

  public getCitySimulationSnapshot(): CitySimulationSnapshot {
    this.assertAlive();
    return this.citySimulation.getSnapshot();
  }

  public get activeCollisionCount(): number {
    return this.exteriorCollisions.length + this.roadClosureVisual.collisions.length;
  }

  public setRoadClosures(
    closures: readonly Readonly<RoadClosureState>[],
  ): void {
    this.assertAlive();
    this.roadClosureVisual.setClosures(closures);
  }

  public recoverToSafePosition(position: Readonly<{ x: number; z: number }>): void {
    this.assertAlive();
    if (!Number.isFinite(position.x) || !Number.isFinite(position.z)) {
      throw new TypeError('safe position must contain finite coordinates');
    }
    if (this.interiorRuntime.phase !== 'exterior') return;
    if (this.vehicle.occupied) {
      this.vehicle.position.x = position.x;
      this.vehicle.position.z = position.z;
      this.vehicle.speed = 0;
      this.vehicle.steering = 0;
      this.vehicleVisual.sync(this.vehicle, 0);
    } else {
      this.applyPlayerTransform({
        position: { x: position.x, y: 0, z: position.z },
        heading: this.player.heading,
      });
    }
    this.updateCamera(1);
    this.emitSnapshot(true);
  }

  public enterNearestVehicle(maximumDistance = 5): boolean {
    this.assertAlive();
    if (
      this.vehicle.occupied
      || this.vehicle.health <= 0
      || !this.player.grounded
      || this.player.traversalMode === 'vaulting'
    ) {
      return false;
    }
    const target = this.getInteractionTarget(maximumDistance);
    if (target?.id !== 'moreno-rook') {
      return false;
    }

    this.vehicle.occupied = true;
    this.vehicle.speed = 0;
    this.avatarVisual.root.visible = false;
    this.cameraYaw = this.vehicle.heading;
    this.emitSnapshot(true);
    return true;
  }

  public exitVehicle(): boolean {
    this.assertAlive();
    if (!vehicleCanExit(this.vehicle)) {
      return false;
    }
    const exitPoint = findVehicleExitPoint(this.vehicle, this.layout.collisions);
    if (!exitPoint) {
      return false;
    }

    this.vehicle.occupied = false;
    this.player.position = { ...exitPoint };
    this.player.velocity = { x: 0, y: 0, z: 0 };
    this.player.heading = this.vehicle.heading;
    this.player.grounded = true;
    this.player.traversalMode = 'grounded';
    this.player.surfaceHeight = 0;
    this.player.vault = null;
    this.avatarVisual.root.visible = true;
    this.avatarVisual.sync(this.player);
    this.cameraYaw = this.vehicle.heading;
    this.emitSnapshot(true);
    return true;
  }

  public toggleVehicle(): boolean {
    return this.interact();
  }

  public interact(): boolean {
    if (this.interiorTransitionPending) {
      return false;
    }
    if (this.interiorRuntime.phase === 'interior') {
      const eligibility = this.interiorRuntime.evaluateExit(this.interiorActorState());
      if (!eligibility.eligible) return false;
      void this.exitInterior();
      return true;
    }
    if (this.vehicle.occupied) {
      return this.exitVehicle();
    }
    const target = this.getInteractionTarget();
    if (target && this.interiorRuntime.definitionForPortal(target.id)) {
      void this.enterInterior(target.id);
      return true;
    }
    return this.enterNearestVehicle();
  }

  public getInteractionTarget(maximumDistance = 5): ReturnType<typeof findNearestInteractionTarget> {
    if (this.interiorTransitionPending) {
      return null;
    }
    if (this.interiorRuntime.phase === 'interior') {
      const eligibility = this.interiorRuntime.evaluateExit(this.interiorActorState());
      if (!eligibility.eligible || !eligibility.portalId || !eligibility.prompt) return null;
      const definition = this.interiorRuntime.currentDefinition;
      if (!definition) return null;
      return {
        id: `interior-exit:${eligibility.portalId}`,
        kind: 'world',
        prompt: eligibility.prompt,
        distanceMeters: eligibility.distanceMeters ?? 0,
        position: { ...definition.scene.exitPosition },
      };
    }
    if (this.vehicle.occupied) {
      return vehicleCanExit(this.vehicle)
        ? {
            id: 'moreno-rook',
            kind: 'vehicle',
            prompt: 'Press E to exit vehicle',
            distanceMeters: 0,
            position: { ...this.vehicle.position },
          }
        : null;
    }
    const actor = this.interiorActorState();
    const eligiblePortal = this.interiorRuntime.nearestEligiblePortal(
      actor,
      Math.max(0, maximumDistance),
    );
    if (
      eligiblePortal?.eligible
      && eligiblePortal.portalId
      && eligiblePortal.prompt
    ) {
      const definition = this.interiorRuntime.definitionForPortal(
        eligiblePortal.portalId,
      );
      if (definition) {
        return {
          id: definition.portal.id,
          kind: 'world',
          prompt: eligiblePortal.prompt,
          distanceMeters: eligiblePortal.distanceMeters ?? 0,
          position: { ...definition.portal.position },
        };
      }
    }
    const portalCandidates = this.interiorRuntime.definitions.map((definition) => ({
      id: definition.portal.id,
      kind: 'world' as const,
      position: definition.portal.position,
      prompt: definition.portal.prompt,
      enabled: this.interiorRuntime.evaluatePortal(definition.portal.id, actor).eligible,
    }));
    return findNearestInteractionTarget({
      origin: this.player.position,
      heading: this.player.heading,
      maximumDistance: Math.max(0, maximumDistance),
      collisions: this.layout.collisions,
      candidates: [
        {
          id: 'moreno-rook',
          kind: 'vehicle',
          position: this.vehicle.position,
          radius: VEHICLE_RADIUS,
          prompt: 'Press E to drive',
          enabled: this.vehicle.health > 0 && this.player.grounded && this.player.traversalMode !== 'vaulting',
        },
        ...portalCandidates,
      ],
    });
  }

  public async enterInterior(portalId: string): Promise<boolean> {
    this.assertAlive();
    if (this.interiorTransitionPending) return false;
    this.interiorTransitionPending = true;
    this.clearInput();
    this.emitSnapshot(true);
    const result = await this.interiorRuntime.enter(portalId, this.interiorActorState());
    if (this.disposed) return false;
    if (result.success) {
      const definition = this.interiorRuntime.currentDefinition;
      if (!definition) {
        this.interiorTransitionPending = false;
        return false;
      }
      this.interiorSceneVisual.load(definition);
      this.cityVisuals.root.visible = false;
      this.interiorPortalVisual.setVisible(false);
      this.vehicleVisual.root.visible = false;
      this.rainField.points.visible = false;
      this.citySimulation.setVisible(false);
      this.applyPlayerTransform(result.transform);
    } else if (result.recoveryTransform) {
      this.applyPlayerTransform(result.recoveryTransform);
    }
    this.interiorTransitionPending = false;
    this.updateCamera(1);
    this.emitSnapshot(true);
    return result.success;
  }

  public async exitInterior(): Promise<boolean> {
    this.assertAlive();
    if (this.interiorTransitionPending) return false;
    this.interiorTransitionPending = true;
    this.clearInput();
    this.emitSnapshot(true);
    const result = await this.interiorRuntime.exit(this.interiorActorState());
    if (this.disposed) return false;
    const transform = result.success ? result.transform : result.recoveryTransform;
    if (transform) this.applyPlayerTransform(transform);
    this.interiorSceneVisual.clear();
    this.cityVisuals.root.visible = true;
    this.interiorPortalVisual.setVisible(true);
    this.vehicleVisual.root.visible = true;
    this.citySimulation.setVisible(true);
    this.interiorTransitionPending = false;
    this.updateCamera(1);
    this.emitSnapshot(true);
    return result.success;
  }

  public update(deltaSeconds: number): void {
    this.assertAlive();
    const dt = Math.min(0.1, Math.max(0, deltaSeconds));
    if (this.paused) {
      return;
    }
    this.elapsedSeconds += dt;
    this.interiorPortalVisual.update(this.elapsedSeconds, this.reducedMotion);
    if (this.interiorTransitionPending) {
      advanceEnvironment(this.environment, dt);
      this.applyEnvironmentVisuals();
      this.updateCamera(dt);
      this.snapshotElapsed += dt;
      this.emitSnapshot(false);
      return;
    }
    const input = this.consumeInput();
    this.currentAim = input.aim;
    if (input.shoulderSwap) {
      this.shoulderSide = oppositeShoulder(this.shoulderSide);
    }
    this.cameraYaw += input.cameraYawDelta;
    this.cameraPitch = MathUtils.clamp(this.cameraPitch + input.cameraPitchDelta, 0.12, 1.05);

    if (input.interact) {
      this.toggleVehicle();
    }

    if (this.vehicle.occupied) {
      stepVehicle(this.vehicle, input, this.activeCollisions(), dt, {
        rainIntensity: this.environment.rainIntensity,
      });
      this.vehicleVisual.sync(this.vehicle, dt);
    } else {
      stepPlayer(this.player, input, this.cameraYaw, this.activeCollisions(), dt);
      this.avatarVisual.sync(this.player);
    }

    if (this.interiorRuntime.phase === 'exterior') {
      const actor = this.vehicle.occupied ? this.vehicle : this.player;
      this.citySimulation.tick({
        deltaSeconds: dt,
        playerPosition: { ...actor.position },
        playerHeading: actor.heading,
      });
    }

    advanceEnvironment(this.environment, dt);
    this.applyEnvironmentVisuals();
    const focus = this.vehicle.occupied ? this.vehicle.position : this.player.position;
    this.rainField.update(
      dt,
      this.interiorRuntime.phase === 'interior' ? 0 : this.environment.rainIntensity,
      focus,
    );
    this.updateCamera(dt);
    this.snapshotElapsed += dt;
    this.emitSnapshot(false);
  }

  public render(): void {
    this.assertAlive();
    this.renderer.render(this.scene, this.camera);
  }

  /** Starts a simple autonomous animation loop. A host with its own fixed loop can omit this. */
  public start(): void {
    this.assertAlive();
    if (this.running) {
      return;
    }
    this.clearInput();
    this.paused = false;
    this.running = true;
    this.previousFrameTime = performance.now();
    this.animationFrame = requestAnimationFrame(this.onAnimationFrame);
  }

  public stop(): void {
    this.running = false;
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.clearInput();
    this.paused = true;
    if (!this.disposed) {
      this.emitSnapshot(true);
    }
  }

  public resize(width = this.mount.clientWidth, height = this.mount.clientHeight): void {
    this.assertAlive();
    const safeWidth = Math.max(1, Math.floor(width));
    const safeHeight = Math.max(1, Math.floor(height));
    const maxPixelRatio = this.layout.quality === 'high' ? 2 : 1.25;
    this.renderer.setPixelRatio(
      Math.max(0.5, Math.min(window.devicePixelRatio || 1, maxPixelRatio) * this.resolutionScale),
    );
    this.renderer.setSize(safeWidth, safeHeight, false);
    this.camera.aspect = safeWidth / safeHeight;
    this.camera.updateProjectionMatrix();
  }

  public getSnapshot(): WorldSnapshot {
    const position = this.vehicle.occupied ? this.vehicle.position : this.player.position;
    const heading = this.vehicle.occupied ? this.vehicle.heading : this.player.heading;
    const speed = this.vehicle.occupied
      ? Math.abs(this.vehicle.speed)
      : Math.hypot(this.player.velocity.x, this.player.velocity.z);
    const interiorState = this.interiorRuntime.snapshot();
    const interiorDefinition = this.interiorRuntime.currentDefinition
      ?? (interiorState.activePortalId
        ? this.interiorRuntime.definitionForPortal(interiorState.activePortalId)
        : null);
    const interactionTarget = this.getInteractionTarget();
    const prompt = this.interiorTransitionPending
      ? interiorState.phase === 'loading-exit'
        ? `Leaving ${interiorDefinition?.scene.label ?? 'interior'}…`
        : `Entering ${interiorDefinition?.scene.label ?? 'interior'}…`
      : interactionTarget?.prompt ?? null;
    const velocity = this.vehicle.occupied
      ? {
          x: -Math.sin(this.vehicle.heading) * this.vehicle.speed,
          y: 0,
          z: -Math.cos(this.vehicle.heading) * this.vehicle.speed,
        }
      : { ...this.player.velocity };

    return {
      mode: this.vehicle.occupied ? 'vehicle' : 'on-foot',
      cameraMode: this.vehicle.occupied ? 'vehicle' : this.currentAim ? 'aim' : 'follow',
      district: interiorDefinition?.portal.district ?? districtAt(position.x, position.z),
      position: { ...position },
      velocity,
      heading,
      speedMetersPerSecond: speed,
      speedKph: speed * 3.6,
      grounded: this.vehicle.occupied || this.player.grounded,
      sprinting: !this.vehicle.occupied && this.player.sprinting,
      crouching: !this.vehicle.occupied && this.player.crouching,
      verticalSpeed: this.vehicle.occupied ? 0 : this.player.velocity.y,
      traversalMode: this.vehicle.occupied ? 'grounded' : this.player.traversalMode,
      cameraYaw: this.cameraYaw,
      cameraPitch: this.cameraPitch,
      shoulderSide: this.shoulderSide,
      paused: this.paused,
      focused: this.focused,
      running: this.running,
      interactionTarget,
      canInteract: interactionTarget !== null,
      canExitVehicle: vehicleCanExit(this.vehicle),
      interiorId: this.interiorRuntime.currentInteriorId,
      interiorLabel: interiorDefinition?.scene.label ?? null,
      interiorPhase: this.interiorRuntime.phase,
      timeOfDay: this.environment.timeOfDay,
      dayPhase: dayPhaseAt(this.environment.timeOfDay),
      rainIntensity: this.environment.rainIntensity,
      vehicleHealth: this.vehicle.occupied ? this.vehicle.health : null,
      prompt,
    };
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.stop();
    this.resizeObserver?.disconnect();
    this.controls?.dispose();
    this.cityVisuals.dispose();
    this.citySimulation.dispose();
    this.interiorSceneVisual.dispose();
    this.interiorPortalVisual.dispose();
    this.roadClosureVisual.dispose();
    this.avatarVisual.dispose();
    this.vehicleVisual.dispose();
    this.rainField.dispose();
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.domElement.removeEventListener('focus', this.onCanvasFocus);
    this.renderer.domElement.removeEventListener('blur', this.onCanvasBlur);
    window.removeEventListener('blur', this.onWindowBlur);
    this.renderer.domElement.remove();
    this.disposed = true;
  }

  private readonly onAnimationFrame = (time: number): void => {
    if (!this.running || this.disposed) {
      return;
    }
    const deltaSeconds = Math.min(0.1, Math.max(0, (time - this.previousFrameTime) / 1_000));
    this.previousFrameTime = time;
    this.onFrame?.(deltaSeconds * 1_000);
    this.update(deltaSeconds);
    this.render();
    this.animationFrame = requestAnimationFrame(this.onAnimationFrame);
  };

  private consumeInput(): WorldInputState {
    const input = this.controls?.consumeInput() ?? createWorldInputState();
    if (this.inputProvider) {
      copyInput(input, this.inputProvider());
    }
    const externalHasMovement = Math.abs(this.externalInput.moveForward) > 0.001
      || Math.abs(this.externalInput.moveRight) > 0.001;
    if (externalHasMovement) {
      input.moveForward = this.externalInput.moveForward;
      input.moveRight = this.externalInput.moveRight;
    }
    input.sprint ||= this.externalInput.sprint;
    input.jump ||= this.externalInput.jump;
    input.crouch ||= this.externalInput.crouch;
    input.aim ||= this.externalInput.aim;
    input.shoulderSwap ||= this.externalInput.shoulderSwap;
    input.handbrake ||= this.externalInput.handbrake;
    input.interact ||= this.externalInput.interact;
    input.cameraYawDelta += this.externalInput.cameraYawDelta;
    input.cameraPitchDelta += this.externalInput.cameraPitchDelta;
    this.externalInput.interact = false;
    this.externalInput.shoulderSwap = false;
    this.externalInput.cameraYawDelta = 0;
    this.externalInput.cameraPitchDelta = 0;
    return input;
  }

  private updateCamera(deltaSeconds: number): void {
    const inVehicle = this.vehicle.occupied;
    const source = inVehicle ? this.vehicle.position : this.player.position;
    const aim = !inVehicle && this.currentAim;
    const targetHeight = inVehicle ? 1.25 : CAMERA_TARGET_HEIGHT * (this.player.crouching ? 0.72 : 1);
    this.cameraTarget.set(source.x, source.y + targetHeight, source.z);

    const speedDistance = this.reducedMotion ? 0 : Math.min(2.4, Math.abs(this.vehicle.speed) * 0.075);
    const distance = inVehicle ? 8.4 + speedDistance : aim ? 4.15 : 6.75;
    const placement = computeCameraPlacement({
      target: this.cameraTarget,
      yaw: this.cameraYaw,
      pitch: this.cameraPitch,
      distance,
      mode: inVehicle ? 'vehicle' : aim ? 'aim' : 'follow',
      shoulderSide: this.shoulderSide,
      collisions: this.activeCollisions(),
    });
    this.desiredCamera.set(placement.position.x, placement.position.y, placement.position.z);
    const blend = deltaSeconds >= 0.5 ? 1 : 1 - Math.exp(-(inVehicle ? 7 : 11) * deltaSeconds);
    this.camera.position.lerp(this.desiredCamera, blend);

    this.desiredLookTarget.set(
      placement.lookTarget.x,
      placement.lookTarget.y,
      placement.lookTarget.z,
    );
    this.camera.lookAt(this.desiredLookTarget);
    this.camera.fov = MathUtils.damp(this.camera.fov, placement.fov, 10, deltaSeconds);
    this.camera.updateProjectionMatrix();
  }

  private applyEnvironmentVisuals(): void {
    const palette = environmentPaletteAt(this.environment.timeOfDay, this.environment.rainIntensity);
    (this.scene.background as Color).setHex(palette.sky);
    this.fog.color.setHex(palette.fog);
    const nightFogBoost = dayPhaseAt(this.environment.timeOfDay) === 'night' ? 0.00018 : 0;
    this.fog.density = 0.00095 + this.environment.rainIntensity * 0.00125 + nightFogBoost;
    this.hemisphereLight.color.setHex(palette.hemisphereSky);
    this.hemisphereLight.groundColor.setHex(palette.hemisphereGround);
    this.hemisphereLight.intensity = palette.hemisphereIntensity;
    this.sunLight.color.setHex(palette.sun);
    this.sunLight.intensity = palette.sunIntensity;
    const sunAngle = (this.environment.timeOfDay - 0.25) * Math.PI * 2;
    this.sunLight.position.set(
      Math.cos(sunAngle) * 360,
      Math.max(24, Math.sin(sunAngle) * 430),
      Math.sin(sunAngle * 0.72) * 280,
    );
    this.cityVisuals.buildingMaterials.forEach((material) => {
      material.emissiveIntensity = palette.buildingEmissiveIntensity;
    });
    this.cityVisuals.roadMaterial.roughness = 0.82 - this.environment.rainIntensity * 0.42;
    this.cityVisuals.roadMaterial.metalness = 0.05 + this.environment.rainIntensity * 0.24;
  }

  private emitSnapshot(force: boolean): void {
    if (!this.onSnapshot || (!force && this.snapshotElapsed < 0.1)) {
      return;
    }
    this.snapshotElapsed = 0;
    this.onSnapshot(this.getSnapshot());
  }

  private activeCollisions(): readonly CollisionRect[] {
    return this.interiorRuntime.currentDefinition?.scene.collisions
      ?? [...this.exteriorCollisions, ...this.roadClosureVisual.collisions];
  }

  private interiorActorState(): InteriorActorState {
    const position = this.vehicle.occupied ? this.vehicle.position : this.player.position;
    const heading = this.vehicle.occupied ? this.vehicle.heading : this.player.heading;
    return {
      position: { ...position },
      heading,
      mode: this.vehicle.occupied ? 'vehicle' : 'on-foot',
      grounded: this.vehicle.occupied || this.player.grounded,
      safeExteriorTransform: this.interiorRuntime.phase === 'exterior'
        ? { position: { ...position }, heading }
        : undefined,
    };
  }

  private applyPlayerTransform(transform: Readonly<InteriorTransform>): void {
    this.vehicle.occupied = false;
    this.player.position = { ...transform.position };
    this.player.velocity = { x: 0, y: 0, z: 0 };
    this.player.heading = transform.heading;
    this.player.grounded = true;
    this.player.sprinting = false;
    this.player.crouching = false;
    this.player.traversalMode = 'grounded';
    this.player.surfaceHeight = 0;
    this.player.vault = null;
    this.cameraYaw = transform.heading;
    this.avatarVisual.root.visible = true;
    this.avatarVisual.sync(this.player);
    this.clearInput();
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error('WorldView has been disposed');
    }
  }

  private readonly onCanvasFocus = (): void => {
    this.focused = true;
    this.emitSnapshot(true);
  };

  private readonly onCanvasBlur = (): void => {
    this.focused = false;
    this.clearInput();
    this.emitSnapshot(true);
  };

  private readonly onWindowBlur = (): void => {
    this.focused = false;
    this.clearInput();
    this.emitSnapshot(true);
  };
}
