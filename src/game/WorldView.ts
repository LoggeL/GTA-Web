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

import { PLAYER_SPAWN, VEHICLE_SPAWN, districtAt, generateCity } from './city';
import type { CityLayout } from './city';
import { cameraSafeFraction } from './collision';
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
import { createWorldInputState } from './types';
import type {
  EnvironmentUpdate,
  Vec3Data,
  WorldInputState,
  WorldSnapshot,
  WorldViewOptions,
} from './types';
import { createVehicleState, findVehicleExitPoint, stepVehicle } from './vehicle';
import type { VehicleSimulationState } from './vehicle';
import { AvatarVisual, RainField, VehicleVisual, createCityVisuals } from './visuals';
import type { CityVisualBundle } from './visuals';

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

function distance2d(first: Readonly<Vec3Data>, second: Readonly<Vec3Data>): number {
  return Math.hypot(first.x - second.x, first.z - second.z);
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
  private readonly avatarVisual: AvatarVisual;
  private readonly vehicleVisual: VehicleVisual;
  private readonly rainField: RainField;
  private readonly controls: DefaultWorldControls | null;
  private readonly reducedMotion: boolean;
  private readonly onSnapshot: ((snapshot: WorldSnapshot) => void) | null;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly cameraTarget = new Vector3();
  private readonly desiredCamera = new Vector3();
  private readonly desiredLookTarget = new Vector3();

  private cameraYaw = DEFAULT_CAMERA_YAW;
  private cameraPitch = DEFAULT_CAMERA_PITCH;
  private currentAim = false;
  private running = false;
  private disposed = false;
  private animationFrame: number | null = null;
  private previousFrameTime = 0;
  private snapshotElapsed = Number.POSITIVE_INFINITY;

  public constructor(options: WorldViewOptions) {
    this.mount = options.mount;
    const quality = options.quality ?? 'high';
    this.reducedMotion = options.reducedMotion ?? false;
    this.onSnapshot = options.onSnapshot ?? null;
    this.layout = generateCity(options.seed ?? 'heatline-solara-world-v1', quality);
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
    this.avatarVisual = new AvatarVisual();
    this.vehicleVisual = new VehicleVisual();
    this.rainField = new RainField(this.layout.seed, quality);
    this.scene.add(
      this.cityVisuals.root,
      this.avatarVisual.root,
      this.vehicleVisual.root,
      this.rainField.points,
    );
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
  }

  public focus(): void {
    this.assertAlive();
    this.renderer.domElement.focus({ preventScroll: true });
  }

  public setEnvironment(update: EnvironmentUpdate): void {
    this.assertAlive();
    updateEnvironment(this.environment, update);
    this.applyEnvironmentVisuals();
    this.emitSnapshot(true);
  }

  public enterNearestVehicle(maximumDistance = 5): boolean {
    this.assertAlive();
    if (this.vehicle.occupied || this.vehicle.health <= 0) {
      return false;
    }
    if (distance2d(this.player.position, this.vehicle.position) > maximumDistance) {
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
    if (!this.vehicle.occupied || Math.abs(this.vehicle.speed) > 4.5) {
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
    this.avatarVisual.root.visible = true;
    this.avatarVisual.sync(this.player);
    this.cameraYaw = this.vehicle.heading;
    this.emitSnapshot(true);
    return true;
  }

  public toggleVehicle(): boolean {
    return this.vehicle.occupied ? this.exitVehicle() : this.enterNearestVehicle();
  }

  public update(deltaSeconds: number): void {
    this.assertAlive();
    const dt = Math.min(0.1, Math.max(0, deltaSeconds));
    const input = this.consumeInput();
    this.currentAim = input.aim;
    this.cameraYaw += input.cameraYawDelta;
    this.cameraPitch = MathUtils.clamp(this.cameraPitch + input.cameraPitchDelta, 0.12, 1.05);

    if (input.interact) {
      this.toggleVehicle();
    }

    if (this.vehicle.occupied) {
      stepVehicle(this.vehicle, input, this.layout.collisions, dt);
      this.vehicleVisual.sync(this.vehicle, dt);
    } else {
      stepPlayer(this.player, input, this.cameraYaw, this.layout.collisions, dt);
      this.avatarVisual.sync(this.player);
    }

    advanceEnvironment(this.environment, dt);
    this.applyEnvironmentVisuals();
    const focus = this.vehicle.occupied ? this.vehicle.position : this.player.position;
    this.rainField.update(dt, this.environment.rainIntensity, focus);
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
  }

  public resize(width = this.mount.clientWidth, height = this.mount.clientHeight): void {
    this.assertAlive();
    const safeWidth = Math.max(1, Math.floor(width));
    const safeHeight = Math.max(1, Math.floor(height));
    const maxPixelRatio = this.layout.quality === 'high' ? 2 : 1.25;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
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
    const nearVehicle = distance2d(this.player.position, this.vehicle.position) <= 5;
    const prompt = this.vehicle.occupied
      ? Math.abs(this.vehicle.speed) <= 4.5 ? 'Press E to exit vehicle' : null
      : nearVehicle && this.vehicle.health > 0 ? 'Press E to drive' : null;

    return {
      mode: this.vehicle.occupied ? 'vehicle' : 'on-foot',
      cameraMode: this.vehicle.occupied ? 'vehicle' : this.currentAim ? 'aim' : 'follow',
      district: districtAt(position.x, position.z),
      position: { ...position },
      heading,
      speedMetersPerSecond: speed,
      speedKph: speed * 3.6,
      grounded: this.vehicle.occupied || this.player.grounded,
      sprinting: !this.vehicle.occupied && this.player.sprinting,
      crouching: !this.vehicle.occupied && this.player.crouching,
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
    this.avatarVisual.dispose();
    this.vehicleVisual.dispose();
    this.rainField.dispose();
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.disposed = true;
  }

  private readonly onAnimationFrame = (time: number): void => {
    if (!this.running || this.disposed) {
      return;
    }
    const deltaSeconds = Math.min(0.1, Math.max(0, (time - this.previousFrameTime) / 1_000));
    this.previousFrameTime = time;
    this.update(deltaSeconds);
    this.render();
    this.animationFrame = requestAnimationFrame(this.onAnimationFrame);
  };

  private consumeInput(): WorldInputState {
    const input = this.controls?.consumeInput() ?? createWorldInputState();
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
    input.handbrake ||= this.externalInput.handbrake;
    input.interact ||= this.externalInput.interact;
    input.cameraYawDelta += this.externalInput.cameraYawDelta;
    input.cameraPitchDelta += this.externalInput.cameraPitchDelta;
    this.externalInput.interact = false;
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
    const horizontalDistance = Math.cos(this.cameraPitch) * distance;
    this.desiredCamera.set(
      this.cameraTarget.x + Math.sin(this.cameraYaw) * horizontalDistance,
      this.cameraTarget.y + Math.sin(this.cameraPitch) * distance + (inVehicle ? 0.8 : 0),
      this.cameraTarget.z + Math.cos(this.cameraYaw) * horizontalDistance,
    );
    const safeFraction = cameraSafeFraction(this.cameraTarget, this.desiredCamera, this.layout.collisions);
    this.desiredCamera.lerpVectors(this.cameraTarget, this.desiredCamera, safeFraction);
    this.desiredCamera.y = Math.max(0.8, this.desiredCamera.y);
    const blend = deltaSeconds >= 0.5 ? 1 : 1 - Math.exp(-(inVehicle ? 7 : 11) * deltaSeconds);
    this.camera.position.lerp(this.desiredCamera, blend);

    const shoulder = aim ? (Math.cos(this.cameraYaw) * 0.65) : 0;
    this.desiredLookTarget.set(
      this.cameraTarget.x + shoulder,
      this.cameraTarget.y + (aim ? 0.25 : 0),
      this.cameraTarget.z - (aim ? Math.sin(this.cameraYaw) * 0.65 : 0),
    );
    this.camera.lookAt(this.desiredLookTarget);
    this.camera.fov = MathUtils.damp(this.camera.fov, aim ? 48 : inVehicle ? 67 : 62, 10, deltaSeconds);
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

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error('WorldView has been disposed');
    }
  }
}
