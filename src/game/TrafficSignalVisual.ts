import {
  BoxGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
} from 'three';
import type { BufferGeometry, Material } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { TRAFFIC_SIGNAL_STOP_LINE_DISTANCE } from '../simulation/traffic-signals';
import type { Vec3Data, WorldQuality } from './types';

export type TrafficSignalPhase = 'red' | 'yellow' | 'green';

export interface TrafficSignalVisualSnapshot {
  readonly id: string;
  readonly position: Readonly<Vec3Data>;
  readonly horizontalAspect: TrafficSignalPhase;
  readonly verticalAspect: TrafficSignalPhase;
}

type SignalAxis = 'horizontal' | 'vertical';

interface SignalHeadPlacement {
  readonly offsetX: number;
  readonly offsetZ: number;
  readonly yaw: number;
  readonly axis: SignalAxis;
}

interface StopBarPlacement {
  readonly offsetX: number;
  readonly offsetZ: number;
  readonly yaw: number;
}

const HEADS_PER_SIGNAL = 4;
const LENSES_PER_HEAD = 3;
const SIGNAL_OFFSET = 10.35;
const POLE_HEIGHT = 4.65;
const HEAD_HEIGHT = 4.28;
const HEAD_FACE_OFFSET = 0.181;
const STOP_BAR_OFFSET = TRAFFIC_SIGNAL_STOP_LINE_DISTANCE;
const STOP_BAR_LANE_OFFSET = 4.35;
const STOP_BAR_SURFACE_Y = 0.115;

const HEAD_PLACEMENTS: readonly SignalHeadPlacement[] = [
  {
    offsetX: -SIGNAL_OFFSET,
    offsetZ: -SIGNAL_OFFSET,
    yaw: Math.PI / 2,
    axis: 'horizontal',
  },
  {
    offsetX: SIGNAL_OFFSET,
    offsetZ: SIGNAL_OFFSET,
    yaw: -Math.PI / 2,
    axis: 'horizontal',
  },
  {
    offsetX: SIGNAL_OFFSET,
    offsetZ: -SIGNAL_OFFSET,
    yaw: 0,
    axis: 'vertical',
  },
  {
    offsetX: -SIGNAL_OFFSET,
    offsetZ: SIGNAL_OFFSET,
    yaw: Math.PI,
    axis: 'vertical',
  },
];

const STOP_BAR_PLACEMENTS: readonly StopBarPlacement[] = [
  {
    offsetX: -STOP_BAR_OFFSET,
    offsetZ: STOP_BAR_LANE_OFFSET,
    yaw: Math.PI / 2,
  },
  {
    offsetX: STOP_BAR_OFFSET,
    offsetZ: -STOP_BAR_LANE_OFFSET,
    yaw: Math.PI / 2,
  },
  {
    offsetX: -STOP_BAR_LANE_OFFSET,
    offsetZ: -STOP_BAR_OFFSET,
    yaw: 0,
  },
  {
    offsetX: STOP_BAR_LANE_OFFSET,
    offsetZ: STOP_BAR_OFFSET,
    yaw: 0,
  },
];

const LENS_PHASES: readonly TrafficSignalPhase[] = ['red', 'yellow', 'green'];
const LENS_Y_OFFSETS: readonly number[] = [0.39, 0, -0.39];
const LOW_POLE_COLOR = new Color(0x59656a);
const LOW_HEAD_COLOR = new Color(0x151a1c);
const LOW_STOP_BAR_COLOR = new Color(0xe8eee9);
const ACTIVE_RED = new Color(0xff3126);
const ACTIVE_YELLOW = new Color(0xffb51b);
const ACTIVE_GREEN = new Color(0x35ed73);
const INACTIVE_RED = new Color(0x250605);
const INACTIVE_YELLOW = new Color(0x261a04);
const INACTIVE_GREEN = new Color(0x05250f);

function shaderColor(color: Color): string {
  return `vec3(${color.r.toFixed(9)}, ${color.g.toFixed(9)}, ${color.b.toFixed(9)})`;
}

const LOW_SIGNAL_VERTEX_PARAMETERS = /* glsl */ `
attribute vec2 signalLens;
attribute vec2 instanceSignalPhases;
`;

const LOW_SIGNAL_COLOR_VERTEX = /* glsl */ `
#include <color_vertex>
if ( signalLens.x > -0.5 ) {
  float activeSignalPhase = signalLens.x < 0.5
    ? instanceSignalPhases.x
    : instanceSignalPhases.y;
  float signalIsActive = 1.0 - step(
    0.25,
    abs( signalLens.y - activeSignalPhase )
  );
  vec3 activeSignalColor = signalLens.y < 0.5
    ? ${shaderColor(ACTIVE_RED)}
    : ( signalLens.y < 1.5
      ? ${shaderColor(ACTIVE_YELLOW)}
      : ${shaderColor(ACTIVE_GREEN)} );
  vec3 inactiveSignalColor = signalLens.y < 0.5
    ? ${shaderColor(INACTIVE_RED)}
    : ( signalLens.y < 1.5
      ? ${shaderColor(INACTIVE_YELLOW)}
      : ${shaderColor(INACTIVE_GREEN)} );
  vColor = mix( inactiveSignalColor, activeSignalColor, signalIsActive );
}
`;

function compareSignalId(
  left: Readonly<TrafficSignalVisualSnapshot>,
  right: Readonly<TrafficSignalVisualSnapshot>,
): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function signalPhaseIndex(phase: TrafficSignalPhase): number {
  if (phase === 'red') return 0;
  if (phase === 'yellow') return 1;
  return 2;
}

function lowPartGeometry(
  source: BufferGeometry,
  matrix: Matrix4,
  color: Color,
  signalAxis = -1,
  signalPhase = -1,
): BufferGeometry {
  const geometry = source.clone();
  geometry.applyMatrix4(matrix);
  const vertexCount = geometry.getAttribute('position').count;
  const colors = new Float32BufferAttribute(vertexCount * 3, 3);
  const signalLenses = new Float32BufferAttribute(vertexCount * 2, 2);
  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    colors.setXYZ(vertexIndex, color.r, color.g, color.b);
    signalLenses.setXY(vertexIndex, signalAxis, signalPhase);
  }
  geometry.setAttribute('color', colors);
  geometry.setAttribute('signalLens', signalLenses);
  return geometry;
}

function lowTransformAt(
  x: number,
  y: number,
  z: number,
  yaw = 0,
): Matrix4 {
  const matrix = new Matrix4().makeRotationY(yaw);
  matrix.setPosition(x, y, z);
  return matrix;
}

/**
 * Packs four poles, four head backplates, four stop bars and all twelve
 * three-position lenses into one 76-triangle intersection geometry.
 */
function createLowSignalGeometry(): BufferGeometry {
  const pole = new CylinderGeometry(0.13, 0.17, POLE_HEIGHT, 3, 1, true);
  pole.translate(0, POLE_HEIGHT / 2, 0);
  const head = new PlaneGeometry(0.62, 1.34);
  const stopBar = new PlaneGeometry(6.4, 0.44);
  stopBar.rotateX(-Math.PI / 2);
  const lens = new CircleGeometry(0.17, 3);

  const parts: BufferGeometry[] = [];
  for (const placement of HEAD_PLACEMENTS) {
    parts.push(
      lowPartGeometry(
        pole,
        lowTransformAt(placement.offsetX, 0, placement.offsetZ),
        LOW_POLE_COLOR,
      ),
      lowPartGeometry(
        head,
        lowTransformAt(
          placement.offsetX,
          HEAD_HEIGHT,
          placement.offsetZ,
          placement.yaw,
        ),
        LOW_HEAD_COLOR,
      ),
    );
  }
  for (const placement of STOP_BAR_PLACEMENTS) {
    parts.push(
      lowPartGeometry(
        stopBar,
        lowTransformAt(
          placement.offsetX,
          STOP_BAR_SURFACE_Y,
          placement.offsetZ,
          placement.yaw,
        ),
        LOW_STOP_BAR_COLOR,
      ),
    );
  }
  for (const placement of HEAD_PLACEMENTS) {
    const normalX = Math.sin(placement.yaw);
    const normalZ = Math.cos(placement.yaw);
    const signalAxis = placement.axis === 'horizontal' ? 0 : 1;
    for (let phaseIndex = 0; phaseIndex < LENSES_PER_HEAD; phaseIndex += 1) {
      parts.push(
        lowPartGeometry(
          lens,
          lowTransformAt(
            placement.offsetX + normalX * HEAD_FACE_OFFSET,
            HEAD_HEIGHT + LENS_Y_OFFSETS[phaseIndex]!,
            placement.offsetZ + normalZ * HEAD_FACE_OFFSET,
            placement.yaw,
          ),
          phaseIndex === 0
            ? INACTIVE_RED
            : phaseIndex === 1
              ? INACTIVE_YELLOW
              : INACTIVE_GREEN,
          signalAxis,
          phaseIndex,
        ),
      );
    }
  }

  const geometry = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  pole.dispose();
  head.dispose();
  stopBar.dispose();
  lens.dispose();
  if (!geometry) {
    throw new Error('Traffic signal low-quality geometry batching failed');
  }
  geometry.name = 'traffic-signal-low-complete';
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function configureLowSignalMaterial(material: MeshBasicMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>${LOW_SIGNAL_VERTEX_PARAMETERS}`,
      )
      .replace('#include <color_vertex>', LOW_SIGNAL_COLOR_VERTEX);
  };
  material.customProgramCacheKey = () => 'traffic-signal-low-one-draw-v1';
}

/**
 * Bounded, allocation-stable traffic-light geometry.
 *
 * Every logical intersection gets four roadside signal heads: two display the
 * horizontal phase and two display the vertical phase. High quality uses four
 * detailed instanced layers. Low quality batches the complete intersection,
 * including shader-colored live lenses, into one instance and one draw.
 */
export class TrafficSignalVisual {
  public readonly root = new Group();
  public readonly object = this.root;
  public disposed = false;

  readonly #maxSignals: number;
  readonly #structures: InstancedMesh<BufferGeometry, MeshBasicMaterial> | null;
  readonly #poles: InstancedMesh<BufferGeometry, Material> | null;
  readonly #heads: InstancedMesh<BufferGeometry, Material> | null;
  readonly #stopBars: InstancedMesh<BufferGeometry, MeshBasicMaterial> | null;
  readonly #lenses: InstancedMesh<BufferGeometry, MeshBasicMaterial> | null;
  readonly #signalPhases: InstancedBufferAttribute | null;
  readonly #geometries: readonly BufferGeometry[];
  readonly #materials: readonly Material[];
  readonly #dummy = new Object3D();
  readonly #ordered: Readonly<TrafficSignalVisualSnapshot>[] = [];
  readonly #activeRed = ACTIVE_RED;
  readonly #activeYellow = ACTIVE_YELLOW;
  readonly #activeGreen = ACTIVE_GREEN;
  readonly #inactiveRed = INACTIVE_RED;
  readonly #inactiveYellow = INACTIVE_YELLOW;
  readonly #inactiveGreen = INACTIVE_GREEN;

  public constructor(maxSignals: number, quality: WorldQuality) {
    if (!Number.isInteger(maxSignals) || maxSignals <= 0) {
      throw new RangeError('Traffic signal capacity must be a positive integer');
    }
    this.#maxSignals = maxSignals;
    this.root.name = 'traffic-signal-visual';
    this.root.visible = false;

    const headCapacity = maxSignals * HEADS_PER_SIGNAL;

    if (quality === 'low') {
      const structureGeometry = createLowSignalGeometry();
      const signalPhases = new InstancedBufferAttribute(
        new Float32Array(maxSignals * 2),
        2,
      );
      signalPhases.setUsage(DynamicDrawUsage);
      structureGeometry.setAttribute('instanceSignalPhases', signalPhases);
      const structureMaterial = new MeshBasicMaterial({
        color: 0xffffff,
        toneMapped: false,
        vertexColors: true,
      });
      configureLowSignalMaterial(structureMaterial);
      this.#geometries = [structureGeometry];
      this.#materials = [structureMaterial];
      this.#structures = this.#createLayer(
        'traffic-signal-structures',
        structureGeometry,
        structureMaterial,
        maxSignals,
        'low',
      );
      this.#poles = null;
      this.#heads = null;
      this.#stopBars = null;
      this.#lenses = null;
      this.#signalPhases = signalPhases;
      this.root.add(this.#structures);
    } else {
      const lensCapacity = headCapacity * LENSES_PER_HEAD;
      const lensGeometry = new CircleGeometry(0.17, 14);
      const lensMaterial = new MeshBasicMaterial({
        color: 0xffffff,
        toneMapped: false,
      });
      const poleGeometry = new CylinderGeometry(
        0.13,
        0.17,
        POLE_HEIGHT,
        8,
      );
      poleGeometry.translate(0, POLE_HEIGHT / 2, 0);
      const headGeometry = new BoxGeometry(0.62, 1.34, 0.34);
      const stopBarGeometry = new BoxGeometry(6.4, 0.035, 0.44);
      for (const geometry of [
        poleGeometry,
        headGeometry,
        stopBarGeometry,
        lensGeometry,
      ]) {
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
      }
      this.#geometries = [
        poleGeometry,
        headGeometry,
        stopBarGeometry,
        lensGeometry,
      ];

      const poleMaterial = new MeshStandardMaterial({
        color: 0x59656a,
        metalness: 0.42,
        roughness: 0.62,
      });
      const headMaterial = new MeshStandardMaterial({
        color: 0x151a1c,
        metalness: 0.12,
        roughness: 0.82,
      });
      const stopBarMaterial = new MeshBasicMaterial({
        color: 0xe8eee9,
        toneMapped: false,
      });
      this.#materials = [
        poleMaterial,
        headMaterial,
        stopBarMaterial,
        lensMaterial,
      ];

      this.#structures = null;
      this.#signalPhases = null;
      this.#poles = this.#createLayer(
        'traffic-signal-poles',
        poleGeometry,
        poleMaterial,
        headCapacity,
        'high',
      );
      this.#heads = this.#createLayer(
        'traffic-signal-heads',
        headGeometry,
        headMaterial,
        headCapacity,
        'high',
      );
      this.#stopBars = this.#createLayer(
        'traffic-signal-stop-bars',
        stopBarGeometry,
        stopBarMaterial,
        headCapacity,
        'low',
      );
      this.#lenses = this.#createLayer(
        'traffic-signal-lenses',
        lensGeometry,
        lensMaterial,
        lensCapacity,
        'low',
      );
      this.root.add(this.#poles, this.#heads, this.#stopBars, this.#lenses);

      // Allocate instance colors during construction so update() only mutates
      // existing typed arrays.
      this.#lenses.setColorAt(lensCapacity - 1, this.#inactiveRed);
      if (this.#lenses.instanceColor) {
        this.#lenses.instanceColor.setUsage(DynamicDrawUsage);
      }
      this.#lenses.count = 0;
    }
  }

  public update(
    snapshots: readonly Readonly<TrafficSignalVisualSnapshot>[],
  ): void {
    if (this.disposed) {
      throw new Error('Traffic signal visual is disposed');
    }

    this.#selectSignals(snapshots);
    const visibleSignals = this.#ordered.length;
    this.root.visible = visibleSignals > 0;

    if (this.#structures && this.#signalPhases) {
      this.#structures.count = visibleSignals;
      for (
        let signalIndex = 0;
        signalIndex < visibleSignals;
        signalIndex += 1
      ) {
        const signal = this.#ordered[signalIndex]!;
        this.#setMatrix(
          this.#structures,
          signalIndex,
          signal.position.x,
          signal.position.y,
          signal.position.z,
          0,
        );
        this.#signalPhases.setXY(
          signalIndex,
          signalPhaseIndex(signal.horizontalAspect),
          signalPhaseIndex(signal.verticalAspect),
        );
      }
      this.#structures.instanceMatrix.needsUpdate = visibleSignals > 0;
      this.#signalPhases.needsUpdate = visibleSignals > 0;
      return;
    }

    const poles = this.#poles;
    const heads = this.#heads;
    const stopBars = this.#stopBars;
    const lenses = this.#lenses;
    if (!poles || !heads || !stopBars || !lenses) {
      throw new Error('Traffic signal visual layers are incomplete');
    }

    const headCount = visibleSignals * HEADS_PER_SIGNAL;
    const lensCount = headCount * LENSES_PER_HEAD;
    poles.count = headCount;
    heads.count = headCount;
    stopBars.count = headCount;
    lenses.count = lensCount;

    let headIndex = 0;
    let lensIndex = 0;
    for (let signalIndex = 0; signalIndex < visibleSignals; signalIndex += 1) {
      const signal = this.#ordered[signalIndex]!;
      for (
        let placementIndex = 0;
        placementIndex < HEADS_PER_SIGNAL;
        placementIndex += 1
      ) {
        const placement = HEAD_PLACEMENTS[placementIndex]!;
        const x = signal.position.x + placement.offsetX;
        const y = signal.position.y;
        const z = signal.position.z + placement.offsetZ;
        this.#setMatrix(poles, headIndex, x, y, z, 0);
        this.#setMatrix(
          heads,
          headIndex,
          x,
          y + HEAD_HEIGHT,
          z,
          placement.yaw,
        );

        const normalX = Math.sin(placement.yaw);
        const normalZ = Math.cos(placement.yaw);
        const phase = placement.axis === 'horizontal'
          ? signal.horizontalAspect
          : signal.verticalAspect;
        for (let phaseIndex = 0; phaseIndex < LENSES_PER_HEAD; phaseIndex += 1) {
          const lensPhase = LENS_PHASES[phaseIndex]!;
          this.#setMatrix(
            lenses,
            lensIndex,
            x + normalX * HEAD_FACE_OFFSET,
            y + HEAD_HEIGHT + LENS_Y_OFFSETS[phaseIndex]!,
            z + normalZ * HEAD_FACE_OFFSET,
            placement.yaw,
          );
          lenses.setColorAt(
            lensIndex,
            lensPhase === phase
              ? this.#activeColor(lensPhase)
              : this.#inactiveColor(lensPhase),
          );
          lensIndex += 1;
        }
        headIndex += 1;
      }
      for (
        let placementIndex = 0;
        placementIndex < HEADS_PER_SIGNAL;
        placementIndex += 1
      ) {
        const placement = STOP_BAR_PLACEMENTS[placementIndex]!;
        const stopBarIndex = signalIndex * HEADS_PER_SIGNAL + placementIndex;
        this.#setMatrix(
          stopBars,
          stopBarIndex,
          signal.position.x + placement.offsetX,
          signal.position.y + STOP_BAR_SURFACE_Y,
          signal.position.z + placement.offsetZ,
          placement.yaw,
        );
      }
    }

    poles.instanceMatrix.needsUpdate = headCount > 0;
    heads.instanceMatrix.needsUpdate = headCount > 0;
    stopBars.instanceMatrix.needsUpdate = headCount > 0;
    lenses.instanceMatrix.needsUpdate = lensCount > 0;
    if (lenses.instanceColor) {
      lenses.instanceColor.needsUpdate = lensCount > 0;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    this.root.clear();
    this.root.visible = false;
    this.#ordered.length = 0;
    if (this.#structures) this.#structures.count = 0;
    if (this.#poles) this.#poles.count = 0;
    if (this.#heads) this.#heads.count = 0;
    if (this.#stopBars) this.#stopBars.count = 0;
    if (this.#lenses) this.#lenses.count = 0;
    for (const geometry of this.#geometries) geometry.dispose();
    for (const material of this.#materials) material.dispose();
  }

  #createLayer<TMaterial extends Material>(
    name: string,
    geometry: BufferGeometry,
    material: TMaterial,
    capacity: number,
    quality: WorldQuality,
  ): InstancedMesh<BufferGeometry, TMaterial> {
    const layer = new InstancedMesh(geometry, material, capacity);
    layer.name = name;
    layer.count = 0;
    layer.visible = true;
    layer.frustumCulled = false;
    layer.castShadow = quality === 'high';
    layer.receiveShadow = quality === 'high';
    layer.instanceMatrix.setUsage(DynamicDrawUsage);
    return layer;
  }

  #selectSignals(
    snapshots: readonly Readonly<TrafficSignalVisualSnapshot>[],
  ): void {
    this.#ordered.length = 0;
    for (
      let snapshotIndex = 0;
      snapshotIndex < snapshots.length;
      snapshotIndex += 1
    ) {
      const snapshot = snapshots[snapshotIndex]!;
      let insertionIndex = 0;
      while (
        insertionIndex < this.#ordered.length
        && compareSignalId(this.#ordered[insertionIndex]!, snapshot) < 0
      ) {
        insertionIndex += 1;
      }
      if (
        insertionIndex < this.#ordered.length
        && compareSignalId(this.#ordered[insertionIndex]!, snapshot) === 0
      ) {
        continue;
      }
      if (insertionIndex >= this.#maxSignals) continue;

      const previousLength = this.#ordered.length;
      const nextLength = Math.min(previousLength + 1, this.#maxSignals);
      this.#ordered.length = nextLength;
      for (
        let shiftIndex = nextLength - 1;
        shiftIndex > insertionIndex;
        shiftIndex -= 1
      ) {
        this.#ordered[shiftIndex] = this.#ordered[shiftIndex - 1]!;
      }
      this.#ordered[insertionIndex] = snapshot;
    }
  }

  #setMatrix(
    layer: InstancedMesh,
    index: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
  ): void {
    this.#dummy.position.set(x, y, z);
    this.#dummy.rotation.set(0, yaw, 0);
    this.#dummy.scale.set(1, 1, 1);
    this.#dummy.updateMatrix();
    layer.setMatrixAt(index, this.#dummy.matrix);
  }

  #activeColor(phase: TrafficSignalPhase): Color {
    if (phase === 'red') return this.#activeRed;
    if (phase === 'yellow') return this.#activeYellow;
    return this.#activeGreen;
  }

  #inactiveColor(phase: TrafficSignalPhase): Color {
    if (phase === 'red') return this.#inactiveRed;
    if (phase === 'yellow') return this.#inactiveYellow;
    return this.#inactiveGreen;
  }
}
