import {
  BufferAttribute,
  BufferGeometry,
  BoxGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix3,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from 'three';
import type { Material, Scene } from 'three';

import type { VehicleClassId } from '../data/types';
import { COMBAT_CAPACITY } from './combat';
import { PEDESTRIAN_CAPACITY } from './pedestrians';
import { TRAFFIC_CAPACITY } from './traffic';
import type {
  CitySimulationSnapshot,
  CombatRole,
  SimulationVisualCapabilities,
} from './types';

const TRAFFIC_BODY_COLORS = Object.freeze([
  new Color(0x16a89f),
  new Color(0xe46443),
  new Color(0xe2b641),
  new Color(0x5479b9),
  new Color(0xe8e8df),
  new Color(0x72558c),
  new Color(0x25343d),
  new Color(0xb8c7c9),
  new Color(0x9e3e3c),
]);
const POLICE_BODY_COLOR = new Color(0xe7edf2);
const GLASS_COLOR = new Color(0x163646);
const TRAFFIC_TRIM_COLOR = new Color(0x172027);
const WHEEL_COLOR = new Color(0x101214);
const HUB_COLOR = new Color(0x8b969d);
const HEADLIGHT_COLOR = new Color(0xfff1c2);
const TAILLIGHT_COLOR = new Color(0xf13b32);
const POLICE_RED_COLOR = new Color(0xff3b35);
const POLICE_BLUE_COLOR = new Color(0x3a79ff);
const ACCESSORY_COLOR = new Color(0x303a3e);
const COMBAT_GEAR_COLOR = new Color(0x252d30);
const DEFAULT_TOP_COLOR = new Color(0xdf6e50);
const DEFAULT_BOTTOM_COLOR = new Color(0x24313a);
const DEFAULT_SKIN_COLOR = new Color(0xb77a58);
const DEFAULT_HAIR_COLOR = new Color(0x35241b);
const PEDESTRIAN_TOP_COLORS = Object.freeze([
  new Color(0xdf6e50),
  new Color(0x3e9b83),
  new Color(0xd4a43b),
  new Color(0x5a70ae),
  new Color(0xa84f6b),
  new Color(0xefe1c4),
  new Color(0x36555e),
  new Color(0x9b6d43),
]);
const PEDESTRIAN_BOTTOM_COLORS = Object.freeze([
  new Color(0x24313a),
  new Color(0x40566d),
  new Color(0x6f5a4c),
  new Color(0x25252a),
  new Color(0x6b7480),
  new Color(0x8b775f),
]);
const SKIN_COLORS = Object.freeze([
  new Color(0x5f3829),
  new Color(0x8a563d),
  new Color(0xb77a58),
  new Color(0xd7a47c),
  new Color(0xf0c7a0),
]);
const HAIR_COLORS = Object.freeze([
  new Color(0x171414),
  new Color(0x35241b),
  new Color(0x6f4325),
  new Color(0xb4803c),
  new Color(0x8a8b89),
]);
const PEDESTRIAN_HEIGHTS: readonly number[] = Object.freeze([0.92, 0.96, 1, 1.035, 1.075]);
const PEDESTRIAN_BUILDS: readonly number[] = Object.freeze([0.86, 0.94, 1, 1.08, 1.15]);

const ROLE_COLORS: Readonly<Record<CombatRole, Color>> = Object.freeze({
  brawler: new Color(0xc85a3f),
  gunner: new Color(0x6f8bc0),
  flanker: new Color(0xa66eb0),
  heavy: new Color(0x5d686e),
  marksman: new Color(0xd0a23b),
});
const DEFAULT_VISUAL_CAPABILITIES: Readonly<SimulationVisualCapabilities> = Object.freeze({
  supportsMultiDraw: false,
});

interface TrafficVisualProfile {
  readonly bodyScale: readonly [number, number, number];
  readonly bodyHeight: number;
  readonly cabinScale: readonly [number, number, number];
  readonly cabinHeight: number;
  readonly cabinOffsetZ: number;
  readonly hoodScale: readonly [number, number, number];
  readonly hoodHeight: number;
  readonly hoodOffsetZ: number;
  readonly deckScale: readonly [number, number, number];
  readonly deckHeight: number;
  readonly deckOffsetZ: number;
  readonly wheelOffsetX: number;
  readonly wheelOffsetZ: number;
  readonly wheelHeight: number;
  readonly wheelScale: readonly [number, number, number];
  readonly wheelCount: 2 | 4;
  readonly lampOffsetX: number;
  readonly lampHeight: number;
  readonly bumperScaleX: number;
}

const TRAFFIC_VISUAL_PROFILES: Readonly<Record<VehicleClassId, TrafficVisualProfile>> = Object.freeze({
  compact: {
    bodyScale: [0.88, 0.92, 0.84],
    bodyHeight: 0.43,
    cabinScale: [0.88, 1, 0.9],
    cabinHeight: 0.9,
    cabinOffsetZ: 0.08,
    hoodScale: [0.87, 0.9, 0.76],
    hoodHeight: 0.72,
    hoodOffsetZ: -1.25,
    deckScale: [0.84, 0.82, 0.55],
    deckHeight: 0.7,
    deckOffsetZ: 1.33,
    wheelOffsetX: 0.78,
    wheelOffsetZ: 1.22,
    wheelHeight: 0.34,
    wheelScale: [0.82, 0.84, 0.84],
    wheelCount: 4,
    lampOffsetX: 0.57,
    lampHeight: 0.48,
    bumperScaleX: 0.84,
  },
  sedan: {
    bodyScale: [1, 1, 1],
    bodyHeight: 0.45,
    cabinScale: [1, 1, 1],
    cabinHeight: 0.96,
    cabinOffsetZ: 0.12,
    hoodScale: [1, 1, 1.05],
    hoodHeight: 0.76,
    hoodOffsetZ: -1.48,
    deckScale: [0.98, 0.92, 0.82],
    deckHeight: 0.73,
    deckOffsetZ: 1.5,
    wheelOffsetX: 0.91,
    wheelOffsetZ: 1.45,
    wheelHeight: 0.35,
    wheelScale: [0.92, 0.94, 0.94],
    wheelCount: 4,
    lampOffsetX: 0.68,
    lampHeight: 0.51,
    bumperScaleX: 0.98,
  },
  muscle: {
    bodyScale: [1.08, 0.9, 1.06],
    bodyHeight: 0.43,
    cabinScale: [1.03, 0.78, 0.88],
    cabinHeight: 0.87,
    cabinOffsetZ: 0.3,
    hoodScale: [1.08, 1.1, 1.3],
    hoodHeight: 0.74,
    hoodOffsetZ: -1.52,
    deckScale: [1.06, 0.9, 0.76],
    deckHeight: 0.7,
    deckOffsetZ: 1.64,
    wheelOffsetX: 0.98,
    wheelOffsetZ: 1.53,
    wheelHeight: 0.36,
    wheelScale: [1.02, 1.05, 1.05],
    wheelCount: 4,
    lampOffsetX: 0.74,
    lampHeight: 0.49,
    bumperScaleX: 1.06,
  },
  sports: {
    bodyScale: [0.98, 0.72, 1.08],
    bodyHeight: 0.37,
    cabinScale: [0.91, 0.62, 0.82],
    cabinHeight: 0.72,
    cabinOffsetZ: 0.24,
    hoodScale: [0.98, 0.72, 1.35],
    hoodHeight: 0.59,
    hoodOffsetZ: -1.52,
    deckScale: [0.96, 0.65, 0.72],
    deckHeight: 0.57,
    deckOffsetZ: 1.7,
    wheelOffsetX: 0.9,
    wheelOffsetZ: 1.58,
    wheelHeight: 0.31,
    wheelScale: [0.94, 0.9, 0.9],
    wheelCount: 4,
    lampOffsetX: 0.7,
    lampHeight: 0.4,
    bumperScaleX: 0.97,
  },
  van: {
    bodyScale: [1.08, 1.18, 1.16],
    bodyHeight: 0.57,
    cabinScale: [1.08, 1.72, 1.66],
    cabinHeight: 1.13,
    cabinOffsetZ: 0.18,
    hoodScale: [1.06, 1.18, 0.62],
    hoodHeight: 0.91,
    hoodOffsetZ: -1.92,
    deckScale: [1.05, 1.1, 0.38],
    deckHeight: 0.88,
    deckOffsetZ: 2.13,
    wheelOffsetX: 0.98,
    wheelOffsetZ: 1.72,
    wheelHeight: 0.39,
    wheelScale: [0.98, 1.04, 1.04],
    wheelCount: 4,
    lampOffsetX: 0.73,
    lampHeight: 0.63,
    bumperScaleX: 1.06,
  },
  pickup: {
    bodyScale: [1.09, 1.04, 1.19],
    bodyHeight: 0.5,
    cabinScale: [1.04, 1.22, 0.78],
    cabinHeight: 1.02,
    cabinOffsetZ: -0.63,
    hoodScale: [1.07, 1.08, 0.94],
    hoodHeight: 0.81,
    hoodOffsetZ: -1.8,
    deckScale: [1.06, 1.25, 1.6],
    deckHeight: 0.78,
    deckOffsetZ: 1.23,
    wheelOffsetX: 0.98,
    wheelOffsetZ: 1.72,
    wheelHeight: 0.4,
    wheelScale: [1.04, 1.08, 1.08],
    wheelCount: 4,
    lampOffsetX: 0.73,
    lampHeight: 0.57,
    bumperScaleX: 1.08,
  },
  'police-cruiser': {
    bodyScale: [1.04, 1.02, 1.08],
    bodyHeight: 0.46,
    cabinScale: [1.03, 1.03, 1.02],
    cabinHeight: 0.98,
    cabinOffsetZ: 0.1,
    hoodScale: [1.04, 1, 1.12],
    hoodHeight: 0.78,
    hoodOffsetZ: -1.58,
    deckScale: [1.03, 0.92, 0.85],
    deckHeight: 0.74,
    deckOffsetZ: 1.65,
    wheelOffsetX: 0.95,
    wheelOffsetZ: 1.58,
    wheelHeight: 0.36,
    wheelScale: [0.96, 0.98, 0.98],
    wheelCount: 4,
    lampOffsetX: 0.7,
    lampHeight: 0.52,
    bumperScaleX: 1.03,
  },
  motorcycle: {
    bodyScale: [0.27, 0.58, 0.62],
    bodyHeight: 0.55,
    cabinScale: [0.22, 0.52, 0.3],
    cabinHeight: 0.84,
    cabinOffsetZ: -0.38,
    hoodScale: [0.26, 2.25, 0.56],
    hoodHeight: 0.78,
    hoodOffsetZ: -0.14,
    deckScale: [0.28, 1.55, 0.34],
    deckHeight: 0.72,
    deckOffsetZ: 0.62,
    wheelOffsetX: 0,
    wheelOffsetZ: 1.02,
    wheelHeight: 0.39,
    wheelScale: [0.58, 1.04, 1.04],
    wheelCount: 2,
    lampOffsetX: 0.07,
    lampHeight: 0.63,
    bumperScaleX: 0.25,
  },
});

function stableStringHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function markInstancesUpdated(mesh: InstancedMesh): void {
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) {
    mesh.instanceColor.needsUpdate = true;
  }
}

function createInstancedMesh(
  geometry: BufferGeometry,
  material: Material,
  capacity: number,
  name: string,
  shadows = true,
): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.name = name;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  mesh.frustumCulled = false;
  return mesh;
}

interface MergedActorSectionRecipe {
  readonly geometry: BufferGeometry;
  readonly count: number;
}

interface PreparedMergedActorSection {
  readonly slotOffset: number;
  readonly slotCount: number;
  readonly vertexCount: number;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
}

/**
 * Compacts heterogeneous actor parts into one dynamic, vertex-colored draw.
 * The caller keeps writing logical slot matrices/colors; flush expands only
 * visible slots into preallocated world-space buffers without frame allocation.
 */
class DynamicMergedActorMesh {
  public readonly mesh: Mesh<BufferGeometry, Material>;

  private readonly sections: readonly PreparedMergedActorSection[];
  private readonly slotMatrices: Float32Array;
  private readonly slotColors: Float32Array;
  private readonly slotVisibility: Uint8Array;
  private readonly outputPositions: Float32Array;
  private readonly outputNormals: Float32Array;
  private readonly outputColors: Float32Array;
  private readonly positionAttribute: BufferAttribute;
  private readonly normalAttribute: BufferAttribute;
  private readonly colorAttribute: BufferAttribute;
  private readonly matrix = new Matrix4();
  private readonly normalMatrix = new Matrix3();
  private readonly point = new Vector3();
  private readonly normal = new Vector3();
  private disposed = false;

  public constructor(
    name: string,
    material: Material,
    recipes: readonly MergedActorSectionRecipe[],
  ) {
    let slotOffset = 0;
    let maximumVertices = 0;
    const sections: PreparedMergedActorSection[] = [];
    for (let sectionIndex = 0; sectionIndex < recipes.length; sectionIndex += 1) {
      const recipe = recipes[sectionIndex];
      if (!recipe) continue;
      const sourcePositions = recipe.geometry.getAttribute('position');
      const sourceNormals = recipe.geometry.getAttribute('normal');
      if (!sourcePositions || !sourceNormals) {
        throw new Error(`Merged actor geometry ${name} requires positions and normals`);
      }
      const sourceIndex = recipe.geometry.index;
      const vertexCount = sourceIndex?.count ?? sourcePositions.count;
      const positions = new Float32Array(vertexCount * 3);
      const normals = new Float32Array(vertexCount * 3);
      for (let vertex = 0; vertex < vertexCount; vertex += 1) {
        const sourceVertex = sourceIndex?.getX(vertex) ?? vertex;
        const component = vertex * 3;
        positions[component] = sourcePositions.getX(sourceVertex);
        positions[component + 1] = sourcePositions.getY(sourceVertex);
        positions[component + 2] = sourcePositions.getZ(sourceVertex);
        normals[component] = sourceNormals.getX(sourceVertex);
        normals[component + 1] = sourceNormals.getY(sourceVertex);
        normals[component + 2] = sourceNormals.getZ(sourceVertex);
      }
      sections.push({
        slotOffset,
        slotCount: recipe.count,
        vertexCount,
        positions,
        normals,
      });
      slotOffset += recipe.count;
      maximumVertices += vertexCount * recipe.count;
    }
    this.sections = Object.freeze(sections);
    this.slotMatrices = new Float32Array(slotOffset * 16);
    this.slotColors = new Float32Array(slotOffset * 3);
    this.slotVisibility = new Uint8Array(slotOffset);
    this.outputPositions = new Float32Array(maximumVertices * 3);
    this.outputNormals = new Float32Array(maximumVertices * 3);
    this.outputColors = new Float32Array(maximumVertices * 3);
    this.positionAttribute = new BufferAttribute(this.outputPositions, 3)
      .setUsage(DynamicDrawUsage);
    this.normalAttribute = new BufferAttribute(this.outputNormals, 3)
      .setUsage(DynamicDrawUsage);
    this.colorAttribute = new BufferAttribute(this.outputColors, 3)
      .setUsage(DynamicDrawUsage);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', this.positionAttribute);
    geometry.setAttribute('normal', this.normalAttribute);
    geometry.setAttribute('color', this.colorAttribute);
    geometry.setDrawRange(0, 0);
    this.mesh = new Mesh(geometry, material);
    this.mesh.name = name;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
  }

  public sectionOffset(sectionIndex: number): number {
    const section = this.sections[sectionIndex];
    if (!section) {
      throw new RangeError(`Unknown merged actor section ${sectionIndex}`);
    }
    return section.slotOffset;
  }

  public beginFrame(): void {
    this.slotVisibility.fill(0);
  }

  public setVisibleAt(slot: number, visible: boolean): void {
    this.assertSlot(slot);
    this.slotVisibility[slot] = visible ? 1 : 0;
    if (visible) {
      const colorOffset = slot * 3;
      this.slotColors[colorOffset] = 1;
      this.slotColors[colorOffset + 1] = 1;
      this.slotColors[colorOffset + 2] = 1;
    }
  }

  public setMatrixAt(slot: number, matrix: Readonly<Matrix4>): void {
    this.assertSlot(slot);
    this.slotMatrices.set(matrix.elements, slot * 16);
  }

  public setColorAt(slot: number, color: Readonly<Color>): void {
    this.assertSlot(slot);
    const offset = slot * 3;
    this.slotColors[offset] = color.r;
    this.slotColors[offset + 1] = color.g;
    this.slotColors[offset + 2] = color.b;
  }

  public flush(): void {
    let outputVertex = 0;
    for (let sectionIndex = 0; sectionIndex < this.sections.length; sectionIndex += 1) {
      const section = this.sections[sectionIndex];
      if (!section) continue;
      for (let localSlot = 0; localSlot < section.slotCount; localSlot += 1) {
        const slot = section.slotOffset + localSlot;
        if (this.slotVisibility[slot] === 0) continue;
        this.matrix.fromArray(this.slotMatrices, slot * 16);
        this.normalMatrix.getNormalMatrix(this.matrix);
        const colorOffset = slot * 3;
        const red = this.slotColors[colorOffset] ?? 1;
        const green = this.slotColors[colorOffset + 1] ?? 1;
        const blue = this.slotColors[colorOffset + 2] ?? 1;
        for (let vertex = 0; vertex < section.vertexCount; vertex += 1) {
          const sourceOffset = vertex * 3;
          const outputOffset = outputVertex * 3;
          this.point.set(
            section.positions[sourceOffset] ?? 0,
            section.positions[sourceOffset + 1] ?? 0,
            section.positions[sourceOffset + 2] ?? 0,
          ).applyMatrix4(this.matrix);
          this.normal.set(
            section.normals[sourceOffset] ?? 0,
            section.normals[sourceOffset + 1] ?? 1,
            section.normals[sourceOffset + 2] ?? 0,
          ).applyNormalMatrix(this.normalMatrix);
          this.outputPositions[outputOffset] = this.point.x;
          this.outputPositions[outputOffset + 1] = this.point.y;
          this.outputPositions[outputOffset + 2] = this.point.z;
          this.outputNormals[outputOffset] = this.normal.x;
          this.outputNormals[outputOffset + 1] = this.normal.y;
          this.outputNormals[outputOffset + 2] = this.normal.z;
          this.outputColors[outputOffset] = red;
          this.outputColors[outputOffset + 1] = green;
          this.outputColors[outputOffset + 2] = blue;
          outputVertex += 1;
        }
      }
    }
    this.mesh.geometry.setDrawRange(0, outputVertex);
    if (outputVertex === 0) return;
    this.markUpdated(this.positionAttribute, outputVertex * 3);
    this.markUpdated(this.normalAttribute, outputVertex * 3);
    this.markUpdated(this.colorAttribute, outputVertex * 3);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.geometry.dispose();
  }

  private assertSlot(slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.slotVisibility.length) {
      throw new RangeError(`Merged actor slot ${slot} is outside the fixed pool`);
    }
  }

  private markUpdated(attribute: BufferAttribute, componentCount: number): void {
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, componentCount);
    attribute.needsUpdate = true;
  }
}

type VisualCarrier = InstancedMesh | DynamicMergedActorMesh;

interface VisualPart {
  readonly carrier: VisualCarrier;
  readonly offset: number;
  readonly fixedColor: Color | null;
}

interface TrafficVisualParts {
  readonly bodies: VisualPart;
  readonly cabins: VisualPart;
  readonly hoods: VisualPart;
  readonly decks: VisualPart;
  readonly bumpers: VisualPart;
  readonly wheels: VisualPart;
  readonly wheelHubs: VisualPart;
  readonly headlights: VisualPart;
  readonly taillights: VisualPart;
  readonly policeRedLights: VisualPart;
  readonly policeBlueLights: VisualPart;
}

interface PedestrianVisualParts {
  readonly torsos: VisualPart;
  readonly legs: VisualPart;
  readonly arms: VisualPart;
  readonly heads: VisualPart;
  readonly hair: VisualPart;
  readonly hats: VisualPart;
  readonly backpacks: VisualPart;
}

interface CombatantVisualParts {
  readonly torsos: VisualPart;
  readonly legs: VisualPart;
  readonly arms: VisualPart;
  readonly heads: VisualPart;
  readonly gear: VisualPart;
  readonly weapons: VisualPart;
}

interface SimulationVisualParts {
  readonly quality: 'low' | 'high';
  readonly traffic: TrafficVisualParts;
  readonly pedestrians: PedestrianVisualParts;
  readonly combatants: CombatantVisualParts;
}

function highPart(carrier: InstancedMesh): VisualPart {
  return { carrier, offset: 0, fixedColor: null };
}

function lowPart(
  carrier: DynamicMergedActorMesh,
  offset: number,
  fixedColor: Color | null = null,
): VisualPart {
  return { carrier, offset, fixedColor };
}

export class SimulationVisualLayer {
  public readonly root = new Group();

  private readonly trafficBodies: InstancedMesh;
  private readonly trafficCabins: InstancedMesh;
  private readonly trafficHoods: InstancedMesh;
  private readonly trafficDecks: InstancedMesh;
  private readonly trafficBumpers: InstancedMesh;
  private readonly trafficWheels: InstancedMesh;
  private readonly trafficWheelHubs: InstancedMesh;
  private readonly trafficHeadlights: InstancedMesh;
  private readonly trafficTaillights: InstancedMesh;
  private readonly trafficPoliceRedLights: InstancedMesh;
  private readonly trafficPoliceBlueLights: InstancedMesh;
  private readonly trafficMeshes: readonly InstancedMesh[];

  private readonly pedestrianTorsos: InstancedMesh;
  private readonly pedestrianLegs: InstancedMesh;
  private readonly pedestrianArms: InstancedMesh;
  private readonly pedestrianHeads: InstancedMesh;
  private readonly pedestrianHair: InstancedMesh;
  private readonly pedestrianHats: InstancedMesh;
  private readonly pedestrianBackpacks: InstancedMesh;
  private readonly pedestrianMeshes: readonly InstancedMesh[];

  private readonly combatantTorsos: InstancedMesh;
  private readonly combatantLegs: InstancedMesh;
  private readonly combatantArms: InstancedMesh;
  private readonly combatantHeads: InstancedMesh;
  private readonly combatantGear: InstancedMesh;
  private readonly combatantWeapons: InstancedMesh;
  private readonly combatantMeshes: readonly InstancedMesh[];

  private readonly lowWriters: readonly DynamicMergedActorMesh[];
  private readonly lowMeshes: readonly Mesh<BufferGeometry, Material>[];
  private readonly highParts: SimulationVisualParts;
  private readonly lowParts: SimulationVisualParts;
  private activeParts: SimulationVisualParts;

  private readonly geometries: readonly BufferGeometry[];
  private readonly materials: readonly Material[];
  private readonly dummy = new Object3D();
  private disposed = false;

  public constructor(
    scene: Scene,
    capabilities: Readonly<SimulationVisualCapabilities> = DEFAULT_VISUAL_CAPABILITIES,
  ) {
    // The low-quality path uses ordinary InstancedMesh draws on every browser.
    // Keep the capability parameter for CitySimulation.attach compatibility.
    void capabilities;
    this.root.name = 'city-simulation-visuals';

    const trafficBodyGeometry = new BoxGeometry(2, 0.58, 4);
    const trafficCabinGeometry = new BoxGeometry(1.55, 0.58, 1.75);
    const trafficDetailGeometry = new BoxGeometry(1.78, 0.2, 1.06);
    const trafficBumperGeometry = new BoxGeometry(1.9, 0.16, 0.18);
    const trafficWheelGeometry = new CylinderGeometry(0.36, 0.36, 0.3, 8);
    trafficWheelGeometry.rotateZ(Math.PI / 2);
    const trafficHubGeometry = new CylinderGeometry(0.18, 0.18, 0.32, 8);
    trafficHubGeometry.rotateZ(Math.PI / 2);
    const trafficLampGeometry = new BoxGeometry(0.38, 0.16, 0.09);
    const trafficPoliceLampGeometry = new BoxGeometry(0.46, 0.12, 0.18);

    const pedestrianTorsoGeometry = new CylinderGeometry(0.25, 0.3, 0.72, 6);
    const pedestrianLegGeometry = new BoxGeometry(0.17, 0.72, 0.2);
    pedestrianLegGeometry.translate(0, -0.36, 0);
    const pedestrianArmGeometry = new BoxGeometry(0.14, 0.62, 0.16);
    pedestrianArmGeometry.translate(0, -0.31, 0);
    const headGeometry = new IcosahedronGeometry(0.23, 0);
    const hairGeometry = new IcosahedronGeometry(0.245, 0);
    const hatGeometry = new CylinderGeometry(0.3, 0.32, 0.1, 8);
    const backpackGeometry = new BoxGeometry(0.4, 0.48, 0.18);

    const combatantTorsoGeometry = new CylinderGeometry(0.3, 0.35, 0.78, 6);
    const combatantLegGeometry = new BoxGeometry(0.2, 0.74, 0.23);
    combatantLegGeometry.translate(0, -0.37, 0);
    const combatantArmGeometry = new BoxGeometry(0.17, 0.68, 0.19);
    combatantArmGeometry.translate(0, -0.34, 0);
    const combatantGearGeometry = new BoxGeometry(0.54, 0.48, 0.2);
    const combatantWeaponGeometry = new BoxGeometry(0.1, 0.12, 0.72);

    const trafficBodyMaterial = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.43,
      metalness: 0.24,
    });
    const glassMaterial = new MeshStandardMaterial({
      color: 0x163646,
      roughness: 0.2,
      metalness: 0.42,
    });
    const trafficTrimMaterial = new MeshStandardMaterial({
      color: 0x172027,
      roughness: 0.55,
      metalness: 0.32,
    });
    const wheelMaterial = new MeshStandardMaterial({ color: 0x101214, roughness: 0.92 });
    const hubMaterial = new MeshStandardMaterial({ color: 0x8b969d, roughness: 0.34, metalness: 0.78 });
    const headlightMaterial = new MeshStandardMaterial({
      color: 0xfff1c2,
      emissive: 0xffbe55,
      emissiveIntensity: 1.5,
      roughness: 0.24,
    });
    const taillightMaterial = new MeshStandardMaterial({
      color: 0xf13b32,
      emissive: 0xa50908,
      emissiveIntensity: 1.4,
      roughness: 0.32,
    });
    const policeRedMaterial = new MeshStandardMaterial({
      color: 0xff3b35,
      emissive: 0xd20d0a,
      emissiveIntensity: 1.8,
    });
    const policeBlueMaterial = new MeshStandardMaterial({
      color: 0x3a79ff,
      emissive: 0x124fd9,
      emissiveIntensity: 1.8,
    });
    const pedestrianTopMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.84 });
    const pedestrianBottomMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
    const skinMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.88 });
    const hairMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.94 });
    const accessoryMaterial = new MeshStandardMaterial({ color: 0x303a3e, roughness: 0.86 });
    const combatMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
    const combatGearMaterial = new MeshStandardMaterial({
      color: 0x252d30,
      roughness: 0.67,
      metalness: 0.18,
    });
    const lowQualityMaterial = new MeshLambertMaterial({
      color: 0xffffff,
      vertexColors: true,
    });

    this.trafficBodies = createInstancedMesh(
      trafficBodyGeometry,
      trafficBodyMaterial,
      TRAFFIC_CAPACITY.high,
      'traffic-body-shells',
    );
    this.trafficCabins = createInstancedMesh(
      trafficCabinGeometry,
      glassMaterial,
      TRAFFIC_CAPACITY.high,
      'traffic-cabins',
    );
    this.trafficHoods = createInstancedMesh(
      trafficDetailGeometry,
      trafficBodyMaterial,
      TRAFFIC_CAPACITY.high,
      'traffic-hoods',
    );
    this.trafficDecks = createInstancedMesh(
      trafficDetailGeometry,
      trafficBodyMaterial,
      TRAFFIC_CAPACITY.high,
      'traffic-rear-decks',
    );
    this.trafficBumpers = createInstancedMesh(
      trafficBumperGeometry,
      trafficTrimMaterial,
      TRAFFIC_CAPACITY.high * 2,
      'traffic-bumpers',
    );
    this.trafficWheels = createInstancedMesh(
      trafficWheelGeometry,
      wheelMaterial,
      TRAFFIC_CAPACITY.high * 4,
      'traffic-wheels',
    );
    this.trafficWheelHubs = createInstancedMesh(
      trafficHubGeometry,
      hubMaterial,
      TRAFFIC_CAPACITY.high * 4,
      'traffic-wheel-hubs',
    );
    this.trafficHeadlights = createInstancedMesh(
      trafficLampGeometry,
      headlightMaterial,
      TRAFFIC_CAPACITY.high * 2,
      'traffic-headlights',
      false,
    );
    this.trafficTaillights = createInstancedMesh(
      trafficLampGeometry,
      taillightMaterial,
      TRAFFIC_CAPACITY.high * 2,
      'traffic-taillights',
      false,
    );
    this.trafficPoliceRedLights = createInstancedMesh(
      trafficPoliceLampGeometry,
      policeRedMaterial,
      TRAFFIC_CAPACITY.high,
      'traffic-police-red-lights',
      false,
    );
    this.trafficPoliceBlueLights = createInstancedMesh(
      trafficPoliceLampGeometry,
      policeBlueMaterial,
      TRAFFIC_CAPACITY.high,
      'traffic-police-blue-lights',
      false,
    );
    this.trafficMeshes = Object.freeze([
      this.trafficBodies,
      this.trafficCabins,
      this.trafficHoods,
      this.trafficDecks,
      this.trafficBumpers,
      this.trafficWheels,
      this.trafficWheelHubs,
      this.trafficHeadlights,
      this.trafficTaillights,
      this.trafficPoliceRedLights,
      this.trafficPoliceBlueLights,
    ]);

    this.pedestrianTorsos = createInstancedMesh(
      pedestrianTorsoGeometry,
      pedestrianTopMaterial,
      PEDESTRIAN_CAPACITY.high,
      'pedestrian-torsos',
    );
    this.pedestrianLegs = createInstancedMesh(
      pedestrianLegGeometry,
      pedestrianBottomMaterial,
      PEDESTRIAN_CAPACITY.high * 2,
      'pedestrian-legs',
    );
    this.pedestrianArms = createInstancedMesh(
      pedestrianArmGeometry,
      skinMaterial,
      PEDESTRIAN_CAPACITY.high * 2,
      'pedestrian-arms',
    );
    this.pedestrianHeads = createInstancedMesh(
      headGeometry,
      skinMaterial,
      PEDESTRIAN_CAPACITY.high,
      'pedestrian-heads',
    );
    this.pedestrianHair = createInstancedMesh(
      hairGeometry,
      hairMaterial,
      PEDESTRIAN_CAPACITY.high,
      'pedestrian-hair',
    );
    this.pedestrianHats = createInstancedMesh(
      hatGeometry,
      accessoryMaterial,
      PEDESTRIAN_CAPACITY.high,
      'pedestrian-hats',
    );
    this.pedestrianBackpacks = createInstancedMesh(
      backpackGeometry,
      accessoryMaterial,
      PEDESTRIAN_CAPACITY.high,
      'pedestrian-backpacks',
    );
    this.pedestrianMeshes = Object.freeze([
      this.pedestrianTorsos,
      this.pedestrianLegs,
      this.pedestrianArms,
      this.pedestrianHeads,
      this.pedestrianHair,
      this.pedestrianHats,
      this.pedestrianBackpacks,
    ]);

    this.combatantTorsos = createInstancedMesh(
      combatantTorsoGeometry,
      combatMaterial,
      COMBAT_CAPACITY.high,
      'combatant-torsos',
    );
    this.combatantLegs = createInstancedMesh(
      combatantLegGeometry,
      pedestrianBottomMaterial,
      COMBAT_CAPACITY.high * 2,
      'combatant-legs',
    );
    this.combatantArms = createInstancedMesh(
      combatantArmGeometry,
      combatMaterial,
      COMBAT_CAPACITY.high * 2,
      'combatant-arms',
    );
    this.combatantHeads = createInstancedMesh(
      headGeometry,
      skinMaterial,
      COMBAT_CAPACITY.high,
      'combatant-heads',
    );
    this.combatantGear = createInstancedMesh(
      combatantGearGeometry,
      combatGearMaterial,
      COMBAT_CAPACITY.high,
      'combatant-role-gear',
    );
    this.combatantWeapons = createInstancedMesh(
      combatantWeaponGeometry,
      combatGearMaterial,
      COMBAT_CAPACITY.high,
      'combatant-weapons',
    );
    this.combatantMeshes = Object.freeze([
      this.combatantTorsos,
      this.combatantLegs,
      this.combatantArms,
      this.combatantHeads,
      this.combatantGear,
      this.combatantWeapons,
    ]);

    this.highParts = {
      quality: 'high',
      traffic: {
        bodies: highPart(this.trafficBodies),
        cabins: highPart(this.trafficCabins),
        hoods: highPart(this.trafficHoods),
        decks: highPart(this.trafficDecks),
        bumpers: highPart(this.trafficBumpers),
        wheels: highPart(this.trafficWheels),
        wheelHubs: highPart(this.trafficWheelHubs),
        headlights: highPart(this.trafficHeadlights),
        taillights: highPart(this.trafficTaillights),
        policeRedLights: highPart(this.trafficPoliceRedLights),
        policeBlueLights: highPart(this.trafficPoliceBlueLights),
      },
      pedestrians: {
        torsos: highPart(this.pedestrianTorsos),
        legs: highPart(this.pedestrianLegs),
        arms: highPart(this.pedestrianArms),
        heads: highPart(this.pedestrianHeads),
        hair: highPart(this.pedestrianHair),
        hats: highPart(this.pedestrianHats),
        backpacks: highPart(this.pedestrianBackpacks),
      },
      combatants: {
        torsos: highPart(this.combatantTorsos),
        legs: highPart(this.combatantLegs),
        arms: highPart(this.combatantArms),
        heads: highPart(this.combatantHeads),
        gear: highPart(this.combatantGear),
        weapons: highPart(this.combatantWeapons),
      },
    };

    const trafficCapacity = TRAFFIC_CAPACITY.low;
    const pedestrianCapacity = PEDESTRIAN_CAPACITY.low;
    const combatCapacity = COMBAT_CAPACITY.low;
    const lowActorWriter = new DynamicMergedActorMesh(
      'low-quality-actors-merged',
      lowQualityMaterial,
      [
        // Traffic sections 0-10.
        { geometry: trafficBodyGeometry, count: trafficCapacity },
        { geometry: trafficCabinGeometry, count: trafficCapacity },
        { geometry: trafficDetailGeometry, count: trafficCapacity },
        { geometry: trafficDetailGeometry, count: trafficCapacity },
        { geometry: trafficBumperGeometry, count: trafficCapacity * 2 },
        { geometry: trafficWheelGeometry, count: trafficCapacity * 4 },
        { geometry: trafficHubGeometry, count: trafficCapacity * 4 },
        { geometry: trafficLampGeometry, count: trafficCapacity * 2 },
        { geometry: trafficLampGeometry, count: trafficCapacity * 2 },
        { geometry: trafficPoliceLampGeometry, count: trafficCapacity },
        { geometry: trafficPoliceLampGeometry, count: trafficCapacity },
        // Pedestrian sections 11-17.
        { geometry: pedestrianTorsoGeometry, count: pedestrianCapacity },
        { geometry: pedestrianLegGeometry, count: pedestrianCapacity * 2 },
        { geometry: pedestrianArmGeometry, count: pedestrianCapacity * 2 },
        { geometry: headGeometry, count: pedestrianCapacity },
        { geometry: hairGeometry, count: pedestrianCapacity },
        { geometry: hatGeometry, count: pedestrianCapacity },
        { geometry: backpackGeometry, count: pedestrianCapacity },
        // Combatant sections 18-23.
        { geometry: combatantTorsoGeometry, count: combatCapacity },
        { geometry: combatantLegGeometry, count: combatCapacity * 2 },
        { geometry: combatantArmGeometry, count: combatCapacity * 2 },
        { geometry: headGeometry, count: combatCapacity },
        { geometry: combatantGearGeometry, count: combatCapacity },
        { geometry: combatantWeaponGeometry, count: combatCapacity },
      ],
    );
    this.lowWriters = Object.freeze([lowActorWriter]);
    this.lowMeshes = Object.freeze([lowActorWriter.mesh]);
    this.lowMeshes.forEach((mesh) => {
      mesh.visible = false;
    });

    this.lowParts = {
      quality: 'low',
      traffic: {
        bodies: lowPart(lowActorWriter, lowActorWriter.sectionOffset(0)),
        cabins: lowPart(lowActorWriter, lowActorWriter.sectionOffset(1), GLASS_COLOR),
        hoods: lowPart(lowActorWriter, lowActorWriter.sectionOffset(2)),
        decks: lowPart(lowActorWriter, lowActorWriter.sectionOffset(3)),
        bumpers: lowPart(
          lowActorWriter,
          lowActorWriter.sectionOffset(4),
          TRAFFIC_TRIM_COLOR,
        ),
        wheels: lowPart(lowActorWriter, lowActorWriter.sectionOffset(5), WHEEL_COLOR),
        wheelHubs: lowPart(lowActorWriter, lowActorWriter.sectionOffset(6), HUB_COLOR),
        headlights: lowPart(
          lowActorWriter,
          lowActorWriter.sectionOffset(7),
          HEADLIGHT_COLOR,
        ),
        taillights: lowPart(
          lowActorWriter,
          lowActorWriter.sectionOffset(8),
          TAILLIGHT_COLOR,
        ),
        policeRedLights: lowPart(
          lowActorWriter,
          lowActorWriter.sectionOffset(9),
          POLICE_RED_COLOR,
        ),
        policeBlueLights: lowPart(
          lowActorWriter,
          lowActorWriter.sectionOffset(10),
          POLICE_BLUE_COLOR,
        ),
      },
      pedestrians: {
        torsos: lowPart(lowActorWriter, lowActorWriter.sectionOffset(11)),
        legs: lowPart(lowActorWriter, lowActorWriter.sectionOffset(12)),
        arms: lowPart(lowActorWriter, lowActorWriter.sectionOffset(13)),
        heads: lowPart(lowActorWriter, lowActorWriter.sectionOffset(14)),
        hair: lowPart(lowActorWriter, lowActorWriter.sectionOffset(15)),
        hats: lowPart(
          lowActorWriter,
          lowActorWriter.sectionOffset(16),
          ACCESSORY_COLOR,
        ),
        backpacks: lowPart(
          lowActorWriter,
          lowActorWriter.sectionOffset(17),
          ACCESSORY_COLOR,
        ),
      },
      combatants: {
        torsos: lowPart(lowActorWriter, lowActorWriter.sectionOffset(18)),
        legs: lowPart(lowActorWriter, lowActorWriter.sectionOffset(19)),
        arms: lowPart(lowActorWriter, lowActorWriter.sectionOffset(20)),
        heads: lowPart(lowActorWriter, lowActorWriter.sectionOffset(21)),
        gear: lowPart(
          lowActorWriter,
          lowActorWriter.sectionOffset(22),
          COMBAT_GEAR_COLOR,
        ),
        weapons: lowPart(
          lowActorWriter,
          lowActorWriter.sectionOffset(23),
          COMBAT_GEAR_COLOR,
        ),
      },
    };
    this.activeParts = this.highParts;

    this.root.add(
      ...this.trafficMeshes,
      ...this.pedestrianMeshes,
      ...this.combatantMeshes,
      ...this.lowMeshes,
    );
    scene.add(this.root);

    this.geometries = Object.freeze([
      trafficBodyGeometry,
      trafficCabinGeometry,
      trafficDetailGeometry,
      trafficBumperGeometry,
      trafficWheelGeometry,
      trafficHubGeometry,
      trafficLampGeometry,
      trafficPoliceLampGeometry,
      pedestrianTorsoGeometry,
      pedestrianLegGeometry,
      pedestrianArmGeometry,
      headGeometry,
      hairGeometry,
      hatGeometry,
      backpackGeometry,
      combatantTorsoGeometry,
      combatantLegGeometry,
      combatantArmGeometry,
      combatantGearGeometry,
      combatantWeaponGeometry,
    ]);
    this.materials = Object.freeze([
      trafficBodyMaterial,
      glassMaterial,
      trafficTrimMaterial,
      wheelMaterial,
      hubMaterial,
      headlightMaterial,
      taillightMaterial,
      policeRedMaterial,
      policeBlueMaterial,
      pedestrianTopMaterial,
      pedestrianBottomMaterial,
      skinMaterial,
      hairMaterial,
      accessoryMaterial,
      combatMaterial,
      combatGearMaterial,
      lowQualityMaterial,
    ]);
  }

  public update(snapshot: Readonly<CitySimulationSnapshot>): void {
    const nextParts = snapshot.quality === 'low' ? this.lowParts : this.highParts;
    if (nextParts !== this.activeParts) {
      this.activeParts = nextParts;
      const highVisible = nextParts.quality === 'high';
      this.trafficMeshes.forEach((mesh) => {
        mesh.visible = highVisible;
      });
      this.pedestrianMeshes.forEach((mesh) => {
        mesh.visible = highVisible;
      });
      this.combatantMeshes.forEach((mesh) => {
        mesh.visible = highVisible;
      });
      this.lowMeshes.forEach((mesh) => {
        mesh.visible = !highVisible;
      });
    }
    if (this.activeParts.quality === 'low') {
      const actorWriter = this.lowWriters[0];
      if (!actorWriter) {
        throw new Error('Low-quality actor writer is missing');
      }
      actorWriter.beginFrame();
      this.updateTraffic(snapshot, this.activeParts.traffic);
      this.updatePedestrians(snapshot, this.activeParts.pedestrians);
      this.updateCombatants(snapshot, this.activeParts.combatants);
      actorWriter.flush();
      return;
    }
    this.updateTraffic(snapshot, this.activeParts.traffic);
    this.updatePedestrians(snapshot, this.activeParts.pedestrians);
    this.updateCombatants(snapshot, this.activeParts.combatants);
  }

  public setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.root.removeFromParent();
    for (let index = 0; index < this.trafficMeshes.length; index += 1) {
      this.trafficMeshes[index]?.dispose();
    }
    for (let index = 0; index < this.pedestrianMeshes.length; index += 1) {
      this.pedestrianMeshes[index]?.dispose();
    }
    for (let index = 0; index < this.combatantMeshes.length; index += 1) {
      this.combatantMeshes[index]?.dispose();
    }
    for (let index = 0; index < this.lowWriters.length; index += 1) {
      this.lowWriters[index]?.dispose();
    }
    this.geometries.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
    this.root.clear();
  }

  private setHidden(part: VisualPart, index: number): void {
    const instanceId = part.offset + index;
    if (part.carrier instanceof DynamicMergedActorMesh) {
      part.carrier.setVisibleAt(instanceId, false);
      return;
    }
    this.dummy.position.set(0, -10_000, 0);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.set(0, 0, 0);
    this.dummy.updateMatrix();
    part.carrier.setMatrixAt(instanceId, this.dummy.matrix);
  }

  private setInstance(
    part: VisualPart,
    index: number,
    x: number,
    y: number,
    z: number,
    heading: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
    rotationX = 0,
    rotationZ = 0,
  ): void {
    const instanceId = part.offset + index;
    this.dummy.position.set(x, y, z);
    this.dummy.rotation.set(rotationX, heading, rotationZ);
    this.dummy.scale.set(scaleX, scaleY, scaleZ);
    this.dummy.updateMatrix();
    part.carrier.setMatrixAt(instanceId, this.dummy.matrix);
    if (part.carrier instanceof DynamicMergedActorMesh) {
      part.carrier.setVisibleAt(instanceId, true);
    }
    if (part.fixedColor) {
      part.carrier.setColorAt(instanceId, part.fixedColor);
    }
  }

  private setActorPart(
    part: VisualPart,
    index: number,
    worldX: number,
    worldZ: number,
    heading: number,
    localX: number,
    y: number,
    localZ: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
    rotationX = 0,
    rotationZ = 0,
  ): void {
    const sinHeading = Math.sin(heading);
    const cosHeading = Math.cos(heading);
    this.setInstance(
      part,
      index,
      worldX + localX * cosHeading + localZ * sinHeading,
      y,
      worldZ - localX * sinHeading + localZ * cosHeading,
      heading,
      scaleX,
      scaleY,
      scaleZ,
      rotationX,
      rotationZ,
    );
  }

  private setPartColor(part: VisualPart, index: number, color: Readonly<Color>): void {
    part.carrier.setColorAt(part.offset + index, color);
  }

  private hideTraffic(parts: Readonly<TrafficVisualParts>, index: number): void {
    this.setHidden(parts.bodies, index);
    this.setHidden(parts.cabins, index);
    this.setHidden(parts.hoods, index);
    this.setHidden(parts.decks, index);
    this.setHidden(parts.policeRedLights, index);
    this.setHidden(parts.policeBlueLights, index);
    for (let component = 0; component < 2; component += 1) {
      const pairIndex = index * 2 + component;
      this.setHidden(parts.bumpers, pairIndex);
      this.setHidden(parts.headlights, pairIndex);
      this.setHidden(parts.taillights, pairIndex);
    }
    for (let wheel = 0; wheel < 4; wheel += 1) {
      const wheelIndex = index * 4 + wheel;
      this.setHidden(parts.wheels, wheelIndex);
      this.setHidden(parts.wheelHubs, wheelIndex);
    }
  }

  private updateTraffic(
    snapshot: Readonly<CitySimulationSnapshot>,
    parts: Readonly<TrafficVisualParts>,
  ): void {
    const capacity = this.activeParts.quality === 'low'
      ? TRAFFIC_CAPACITY.low
      : TRAFFIC_CAPACITY.high;
    for (let index = 0; index < capacity; index += 1) {
      const vehicle = snapshot.traffic[index];
      if (!vehicle) {
        this.hideTraffic(parts, index);
        continue;
      }

      const profile = TRAFFIC_VISUAL_PROFILES[vehicle.classId];
      const bodyColor = vehicle.classId === 'police-cruiser'
        ? POLICE_BODY_COLOR
        : TRAFFIC_BODY_COLORS[stableStringHash(vehicle.id) % TRAFFIC_BODY_COLORS.length] ?? POLICE_BODY_COLOR;
      this.setActorPart(
        parts.bodies,
        index,
        vehicle.position.x,
        vehicle.position.z,
        vehicle.heading,
        0,
        profile.bodyHeight,
        0,
        profile.bodyScale[0],
        profile.bodyScale[1],
        profile.bodyScale[2],
      );
      this.setPartColor(parts.bodies, index, bodyColor);

      this.setActorPart(
        parts.cabins,
        index,
        vehicle.position.x,
        vehicle.position.z,
        vehicle.heading,
        0,
        profile.cabinHeight,
        profile.cabinOffsetZ,
        profile.cabinScale[0],
        profile.cabinScale[1],
        profile.cabinScale[2],
      );
      this.setActorPart(
        parts.hoods,
        index,
        vehicle.position.x,
        vehicle.position.z,
        vehicle.heading,
        0,
        profile.hoodHeight,
        profile.hoodOffsetZ,
        profile.hoodScale[0],
        profile.hoodScale[1],
        profile.hoodScale[2],
      );
      this.setPartColor(parts.hoods, index, bodyColor);
      this.setActorPart(
        parts.decks,
        index,
        vehicle.position.x,
        vehicle.position.z,
        vehicle.heading,
        0,
        profile.deckHeight,
        profile.deckOffsetZ,
        profile.deckScale[0],
        profile.deckScale[1],
        profile.deckScale[2],
      );
      this.setPartColor(parts.decks, index, bodyColor);

      for (let component = 0; component < 2; component += 1) {
        const end = component === 0 ? -1 : 1;
        const localX = component === 0 ? -profile.lampOffsetX : profile.lampOffsetX;
        const pairIndex = index * 2 + component;
        this.setActorPart(
          parts.bumpers,
          pairIndex,
          vehicle.position.x,
          vehicle.position.z,
          vehicle.heading,
          0,
          profile.bodyHeight - 0.18,
          end * (2.03 * profile.bodyScale[2]),
          profile.bumperScaleX,
          1,
          1,
        );
        this.setActorPart(
          parts.headlights,
          pairIndex,
          vehicle.position.x,
          vehicle.position.z,
          vehicle.heading,
          localX,
          profile.lampHeight,
          -2.08 * profile.bodyScale[2],
          vehicle.classId === 'motorcycle' ? 0.48 : 1,
          1,
          1,
        );
        this.setActorPart(
          parts.taillights,
          pairIndex,
          vehicle.position.x,
          vehicle.position.z,
          vehicle.heading,
          localX,
          profile.lampHeight,
          2.08 * profile.bodyScale[2],
          vehicle.classId === 'motorcycle' ? 0.48 : 1,
          1,
          1,
        );
      }

      for (let wheel = 0; wheel < 4; wheel += 1) {
        const wheelIndex = index * 4 + wheel;
        if (wheel >= profile.wheelCount) {
          this.setHidden(parts.wheels, wheelIndex);
          this.setHidden(parts.wheelHubs, wheelIndex);
          continue;
        }
        const twoWheels = profile.wheelCount === 2;
        const localX = twoWheels ? 0 : (wheel % 2 === 0 ? profile.wheelOffsetX : -profile.wheelOffsetX);
        const localZ = twoWheels
          ? (wheel === 0 ? -profile.wheelOffsetZ : profile.wheelOffsetZ)
          : (wheel < 2 ? -profile.wheelOffsetZ : profile.wheelOffsetZ);
        this.setActorPart(
          parts.wheels,
          wheelIndex,
          vehicle.position.x,
          vehicle.position.z,
          vehicle.heading,
          localX,
          profile.wheelHeight,
          localZ,
          profile.wheelScale[0],
          profile.wheelScale[1],
          profile.wheelScale[2],
        );
        this.setActorPart(
          parts.wheelHubs,
          wheelIndex,
          vehicle.position.x,
          vehicle.position.z,
          vehicle.heading,
          localX,
          profile.wheelHeight,
          localZ,
          profile.wheelScale[0],
          profile.wheelScale[1],
          profile.wheelScale[2],
        );
      }

      if (vehicle.classId === 'police-cruiser') {
        const lightbarHeight = profile.cabinHeight + profile.cabinScale[1] * 0.33;
        this.setActorPart(
          parts.policeRedLights,
          index,
          vehicle.position.x,
          vehicle.position.z,
          vehicle.heading,
          -0.28,
          lightbarHeight,
          profile.cabinOffsetZ,
          1,
          1,
          1,
        );
        this.setActorPart(
          parts.policeBlueLights,
          index,
          vehicle.position.x,
          vehicle.position.z,
          vehicle.heading,
          0.28,
          lightbarHeight,
          profile.cabinOffsetZ,
          1,
          1,
          1,
        );
      } else {
        this.setHidden(parts.policeRedLights, index);
        this.setHidden(parts.policeBlueLights, index);
      }
    }
    if (this.activeParts.quality === 'high') {
      for (let index = 0; index < this.trafficMeshes.length; index += 1) {
        const mesh = this.trafficMeshes[index];
        if (mesh) markInstancesUpdated(mesh);
      }
    }
  }

  private hidePedestrian(parts: Readonly<PedestrianVisualParts>, index: number): void {
    this.setHidden(parts.torsos, index);
    this.setHidden(parts.heads, index);
    this.setHidden(parts.hair, index);
    this.setHidden(parts.hats, index);
    this.setHidden(parts.backpacks, index);
    for (let side = 0; side < 2; side += 1) {
      this.setHidden(parts.legs, index * 2 + side);
      this.setHidden(parts.arms, index * 2 + side);
    }
  }

  private updatePedestrians(
    snapshot: Readonly<CitySimulationSnapshot>,
    parts: Readonly<PedestrianVisualParts>,
  ): void {
    const capacity = this.activeParts.quality === 'low'
      ? PEDESTRIAN_CAPACITY.low
      : PEDESTRIAN_CAPACITY.high;
    for (let index = 0; index < capacity; index += 1) {
      const pedestrian = snapshot.pedestrians[index];
      if (!pedestrian) {
        this.hidePedestrian(parts, index);
        continue;
      }

      const style = stableStringHash(pedestrian.id);
      const height = PEDESTRIAN_HEIGHTS[style % PEDESTRIAN_HEIGHTS.length] ?? 1;
      const build = PEDESTRIAN_BUILDS[(style >>> 3) % PEDESTRIAN_BUILDS.length] ?? 1;
      const skinColor = SKIN_COLORS[(style >>> 6) % SKIN_COLORS.length] ?? DEFAULT_SKIN_COLOR;
      const topColor = PEDESTRIAN_TOP_COLORS[(style >>> 10) % PEDESTRIAN_TOP_COLORS.length]
        ?? DEFAULT_TOP_COLOR;
      const bottomColor = PEDESTRIAN_BOTTOM_COLORS[(style >>> 14) % PEDESTRIAN_BOTTOM_COLORS.length]
        ?? DEFAULT_BOTTOM_COLOR;
      const hairColor = HAIR_COLORS[(style >>> 18) % HAIR_COLORS.length] ?? DEFAULT_HAIR_COLOR;
      const activity = Math.min(1, Math.max(0, pedestrian.speed / 3.6));
      const cadence = pedestrian.behavior === 'flee' ? 9 : pedestrian.behavior === 'witness-report' ? 2.2 : 5.2;
      const phase = snapshot.simulationTime * cadence + (style % 17) * 0.63;
      const stride = pedestrian.behavior === 'flee'
        ? 0.72
        : pedestrian.behavior === 'witness-report'
          ? 0.04
          : 0.43 * activity;
      const legSwing = Math.sin(phase) * stride;
      const bob = Math.abs(Math.sin(phase * 2))
        * (pedestrian.behavior === 'flee' ? 0.055 : 0.024)
        * Math.max(0.2, activity);
      const torsoLean = pedestrian.behavior === 'flee' ? 0.17 : 0.025 * activity;

      this.setActorPart(
        parts.torsos,
        index,
        pedestrian.position.x,
        pedestrian.position.z,
        pedestrian.heading,
        0,
        1.08 * height + bob,
        0,
        build,
        height,
        build,
        -torsoLean,
      );
      this.setPartColor(parts.torsos, index, topColor);
      this.setActorPart(
        parts.heads,
        index,
        pedestrian.position.x,
        pedestrian.position.z,
        pedestrian.heading,
        0,
        1.61 * height + bob,
        -0.015,
        0.98 * build,
        height,
        0.98 * build,
        -torsoLean * 0.25,
        pedestrian.behavior === 'witness-report' ? 0.12 : 0,
      );
      this.setPartColor(parts.heads, index, skinColor);

      const hasHat = style % 7 === 0;
      const hasHair = !hasHat && style % 6 !== 0;
      if (hasHair) {
        this.setActorPart(
          parts.hair,
          index,
          pedestrian.position.x,
          pedestrian.position.z,
          pedestrian.heading,
          0,
          1.73 * height + bob,
          0,
          build,
          0.52 * height,
          build,
          -torsoLean * 0.25,
        );
        this.setPartColor(parts.hair, index, hairColor);
      } else {
        this.setHidden(parts.hair, index);
      }
      if (hasHat) {
        this.setActorPart(
          parts.hats,
          index,
          pedestrian.position.x,
          pedestrian.position.z,
          pedestrian.heading,
          0,
          1.83 * height + bob,
          0,
          0.9 * build,
          height,
          0.9 * build,
          -torsoLean * 0.2,
        );
      } else {
        this.setHidden(parts.hats, index);
      }

      if (style % 5 === 0) {
        this.setActorPart(
          parts.backpacks,
          index,
          pedestrian.position.x,
          pedestrian.position.z,
          pedestrian.heading,
          0,
          1.1 * height + bob,
          0.25 * build,
          build,
          height,
          build,
          -torsoLean,
        );
      } else {
        this.setHidden(parts.backpacks, index);
      }

      for (let sideIndex = 0; sideIndex < 2; sideIndex += 1) {
        const side = sideIndex === 0 ? -1 : 1;
        const pairIndex = index * 2 + sideIndex;
        const sideSwing = side * legSwing;
        this.setActorPart(
          parts.legs,
          pairIndex,
          pedestrian.position.x,
          pedestrian.position.z,
          pedestrian.heading,
          side * 0.14 * build,
          0.76 * height + bob,
          0,
          build,
          height,
          build,
          sideSwing,
          pedestrian.behavior === 'witness-report' ? side * 0.08 : 0,
        );
        this.setPartColor(parts.legs, pairIndex, bottomColor);

        let armRotationX = -sideSwing * 0.72;
        let armRotationZ = side * -0.08;
        if (pedestrian.behavior === 'witness-report') {
          if (sideIndex === 0) {
            armRotationX = 1.25;
            armRotationZ = 0.18;
          } else {
            armRotationX = 0.2;
            armRotationZ = -2.42;
          }
        }
        this.setActorPart(
          parts.arms,
          pairIndex,
          pedestrian.position.x,
          pedestrian.position.z,
          pedestrian.heading,
          side * 0.34 * build,
          1.34 * height + bob,
          0,
          build,
          height,
          build,
          armRotationX,
          armRotationZ,
        );
        this.setPartColor(parts.arms, pairIndex, skinColor);
      }
    }
    if (this.activeParts.quality === 'high') {
      for (let index = 0; index < this.pedestrianMeshes.length; index += 1) {
        const mesh = this.pedestrianMeshes[index];
        if (mesh) markInstancesUpdated(mesh);
      }
    }
  }

  private hideCombatant(parts: Readonly<CombatantVisualParts>, index: number): void {
    this.setHidden(parts.torsos, index);
    this.setHidden(parts.heads, index);
    this.setHidden(parts.gear, index);
    this.setHidden(parts.weapons, index);
    for (let side = 0; side < 2; side += 1) {
      this.setHidden(parts.legs, index * 2 + side);
      this.setHidden(parts.arms, index * 2 + side);
    }
  }

  private updateCombatants(
    snapshot: Readonly<CitySimulationSnapshot>,
    parts: Readonly<CombatantVisualParts>,
  ): void {
    const capacity = this.activeParts.quality === 'low'
      ? COMBAT_CAPACITY.low
      : COMBAT_CAPACITY.high;
    for (let index = 0; index < capacity; index += 1) {
      const combatant = snapshot.combatants[index];
      if (!combatant) {
        this.hideCombatant(parts, index);
        continue;
      }

      const style = stableStringHash(combatant.id);
      const heavyScale = combatant.role === 'heavy' ? 1.18 : 1;
      const bodyColor = ROLE_COLORS[combatant.role];
      const skinColor = SKIN_COLORS[(style >>> 4) % SKIN_COLORS.length] ?? DEFAULT_SKIN_COLOR;
      const bottomColor = PEDESTRIAN_BOTTOM_COLORS[(style >>> 8) % PEDESTRIAN_BOTTOM_COLORS.length]
        ?? DEFAULT_BOTTOM_COLOR;
      const defeated = combatant.behavior === 'defeated';
      const moving = combatant.behavior === 'patrol'
        || combatant.behavior === 'investigate'
        || combatant.behavior === 'reposition'
        || combatant.behavior === 'flee';
      const phase = snapshot.simulationTime
        * (combatant.behavior === 'flee' || combatant.behavior === 'reposition' ? 8 : 4.5)
        + (style % 13) * 0.71;
      const stride = moving ? Math.sin(phase) * (combatant.behavior === 'flee' ? 0.62 : 0.34) : 0;
      const aiming = combatant.behavior === 'engage' || combatant.behavior === 'reposition';

      if (defeated) {
        this.setActorPart(
          parts.torsos,
          index,
          combatant.position.x,
          combatant.position.z,
          combatant.heading,
          0,
          0.32,
          0,
          heavyScale,
          heavyScale,
          heavyScale,
          0,
          Math.PI / 2,
        );
        this.setPartColor(parts.torsos, index, bodyColor);
        this.setActorPart(
          parts.heads,
          index,
          combatant.position.x,
          combatant.position.z,
          combatant.heading,
          0.58 * heavyScale,
          0.28,
          0,
          heavyScale,
          heavyScale,
          heavyScale,
          0,
          Math.PI / 2,
        );
        this.setPartColor(parts.heads, index, skinColor);
        this.setHidden(parts.gear, index);
        if (combatant.role === 'brawler') {
          this.setHidden(parts.weapons, index);
        } else {
          this.setActorPart(
            parts.weapons,
            index,
            combatant.position.x,
            combatant.position.z,
            combatant.heading,
            -0.52,
            0.14,
            -0.18,
            1,
            1,
            1,
            0,
            Math.PI / 2,
          );
        }
        for (let sideIndex = 0; sideIndex < 2; sideIndex += 1) {
          const pairIndex = index * 2 + sideIndex;
          const side = sideIndex === 0 ? -1 : 1;
          this.setActorPart(
            parts.legs,
            pairIndex,
            combatant.position.x,
            combatant.position.z,
            combatant.heading,
            side * 0.23,
            0.22,
            0.62,
            heavyScale,
            heavyScale,
            heavyScale,
            Math.PI / 2,
          );
          this.setPartColor(parts.legs, pairIndex, bottomColor);
          this.setActorPart(
            parts.arms,
            pairIndex,
            combatant.position.x,
            combatant.position.z,
            combatant.heading,
            side * 0.26,
            0.25,
            -0.16,
            heavyScale,
            heavyScale,
            heavyScale,
            Math.PI / 2,
          );
          this.setPartColor(parts.arms, pairIndex, bodyColor);
        }
        continue;
      }

      const bob = Math.abs(Math.sin(phase * 2)) * (moving ? 0.025 : 0);
      this.setActorPart(
        parts.torsos,
        index,
        combatant.position.x,
        combatant.position.z,
        combatant.heading,
        0,
        1.08 * heavyScale + bob,
        0,
        heavyScale,
        heavyScale,
        heavyScale,
        aiming ? -0.08 : combatant.behavior === 'flee' ? -0.16 : 0,
      );
      this.setPartColor(parts.torsos, index, bodyColor);
      this.setActorPart(
        parts.heads,
        index,
        combatant.position.x,
        combatant.position.z,
        combatant.heading,
        0,
        1.66 * heavyScale + bob,
        -0.02,
        heavyScale,
        heavyScale,
        heavyScale,
      );
      this.setPartColor(parts.heads, index, skinColor);
      this.setActorPart(
        parts.gear,
        index,
        combatant.position.x,
        combatant.position.z,
        combatant.heading,
        0,
        1.13 * heavyScale + bob,
        0.27 * heavyScale,
        combatant.role === 'heavy' ? 1.22 : 0.88,
        combatant.role === 'heavy' ? 1.14 : 0.8,
        1,
      );

      const hasWeapon = combatant.role !== 'brawler';
      if (hasWeapon) {
        this.setActorPart(
          parts.weapons,
          index,
          combatant.position.x,
          combatant.position.z,
          combatant.heading,
          0.18 * heavyScale,
          (aiming ? 1.28 : 1.08) * heavyScale + bob,
          -0.42 * heavyScale,
          heavyScale,
          heavyScale,
          combatant.role === 'marksman' ? 1.35 : 1,
          aiming ? -0.12 : -0.42,
        );
      } else {
        this.setHidden(parts.weapons, index);
      }

      for (let sideIndex = 0; sideIndex < 2; sideIndex += 1) {
        const pairIndex = index * 2 + sideIndex;
        const side = sideIndex === 0 ? -1 : 1;
        this.setActorPart(
          parts.legs,
          pairIndex,
          combatant.position.x,
          combatant.position.z,
          combatant.heading,
          side * 0.16 * heavyScale,
          0.76 * heavyScale + bob,
          aiming ? side * 0.06 : 0,
          heavyScale,
          heavyScale,
          heavyScale,
          side * stride,
          aiming ? side * 0.13 : 0,
        );
        this.setPartColor(parts.legs, pairIndex, bottomColor);

        const armSwing = aiming
          ? (sideIndex === 0 ? 1.18 : 1.02)
          : -side * stride * 0.72;
        this.setActorPart(
          parts.arms,
          pairIndex,
          combatant.position.x,
          combatant.position.z,
          combatant.heading,
          side * 0.39 * heavyScale,
          1.37 * heavyScale + bob,
          aiming ? 0.08 : 0,
          heavyScale,
          heavyScale,
          heavyScale,
          armSwing,
          aiming ? side * 0.24 : side * -0.08,
        );
        this.setPartColor(parts.arms, pairIndex, bodyColor);
      }
    }
    if (this.activeParts.quality === 'high') {
      for (let index = 0; index < this.combatantMeshes.length; index += 1) {
        const mesh = this.combatantMeshes[index];
        if (mesh) markInstancesUpdated(mesh);
      }
    }
  }
}
