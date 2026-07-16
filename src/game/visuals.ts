import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Points,
  PointsMaterial,
} from 'three';
import type { Matrix4 } from 'three';

import { DISTRICTS, DISTRICT_SIZE } from './city';
import type { CityLayout, PropRecipe } from './city';
import type { PlayerSimulationState } from './player';
import { SeededRandom } from './random';
import type { Vec3Data, WorldQuality } from './types';
import type { VehicleSimulationState } from './vehicle';

export interface CityVisualBundle {
  root: Group;
  buildingMaterials: readonly MeshStandardMaterial[];
  roadMaterial: MeshStandardMaterial;
  dispose: () => void;
}

function composeMatrix(
  target: Object3D,
  x: number,
  y: number,
  z: number,
  scaleX: number,
  scaleY: number,
  scaleZ: number,
  rotationY = 0,
): Matrix4 {
  target.position.set(x, y, z);
  target.rotation.set(0, rotationY, 0);
  target.scale.set(scaleX, scaleY, scaleZ);
  target.updateMatrix();
  return target.matrix;
}

function createDistrictGrounds(root: Group, geometries: BufferGeometry[], materials: MeshStandardMaterial[]): void {
  for (const district of DISTRICTS) {
    const geometry = new BoxGeometry(DISTRICT_SIZE, 0.12, DISTRICT_SIZE);
    const material = new MeshStandardMaterial({
      color: district.groundColor,
      roughness: 0.94,
      metalness: 0,
    });
    const ground = new Mesh(geometry, material);
    ground.position.set(
      (district.minX + district.maxX) / 2,
      -0.08,
      (district.minZ + district.maxZ) / 2,
    );
    ground.receiveShadow = true;
    root.add(ground);
    geometries.push(geometry);
    materials.push(material);
  }

  const oceanGeometry = new PlaneGeometry(300, 1_300, 1, 1);
  const oceanMaterial = new MeshStandardMaterial({
    color: 0x197c9b,
    roughness: 0.25,
    metalness: 0.05,
    transparent: true,
    opacity: 0.9,
  });
  const ocean = new Mesh(oceanGeometry, oceanMaterial);
  ocean.rotation.x = -Math.PI / 2;
  ocean.position.set(-748, -0.18, 0);
  root.add(ocean);
  geometries.push(oceanGeometry);
  materials.push(oceanMaterial);
}

function createRoads(
  root: Group,
  layout: CityLayout,
  geometries: BufferGeometry[],
  materials: MeshStandardMaterial[],
): MeshStandardMaterial {
  const geometry = new BoxGeometry(1, 1, 1);
  const material = new MeshStandardMaterial({
    color: 0x26313b,
    roughness: 0.82,
    metalness: 0.05,
  });
  const mesh = new InstancedMesh(geometry, material, layout.roads.length);
  const dummy = new Object3D();
  layout.roads.forEach((road, index) => {
    mesh.setMatrixAt(
      index,
      composeMatrix(dummy, road.position.x, road.position.y, road.position.z, road.width, 0.1, road.depth),
    );
  });
  mesh.receiveShadow = true;
  root.add(mesh);
  geometries.push(geometry);
  materials.push(material);

  const markingCount = layout.roads.reduce((count, road) => {
    const length = Math.max(road.width, road.depth);
    return count + Math.floor(length / 28);
  }, 0);
  const markingGeometry = new BoxGeometry(1, 1, 1);
  const markingMaterial = new MeshStandardMaterial({
    color: 0xffd66b,
    emissive: 0x6d4817,
    emissiveIntensity: 0.12,
    roughness: 0.72,
  });
  const markings = new InstancedMesh(markingGeometry, markingMaterial, markingCount);
  let markingIndex = 0;
  for (const road of layout.roads) {
    const vertical = road.depth > road.width;
    const length = vertical ? road.depth : road.width;
    const dashCount = Math.floor(length / 28);
    for (let dash = 0; dash < dashCount; dash += 1) {
      const along = -length / 2 + 14 + dash * 28;
      const x = road.position.x + (vertical ? 0 : along);
      const z = road.position.z + (vertical ? along : 0);
      markings.setMatrixAt(
        markingIndex,
        composeMatrix(dummy, x, 0.105, z, vertical ? 0.18 : 7.5, 0.025, vertical ? 7.5 : 0.18),
      );
      markingIndex += 1;
    }
  }
  root.add(markings);
  geometries.push(markingGeometry);
  materials.push(markingMaterial);
  return material;
}

function createBuildings(
  root: Group,
  layout: CityLayout,
  quality: WorldQuality,
  geometries: BufferGeometry[],
  materials: MeshStandardMaterial[],
): readonly MeshStandardMaterial[] {
  const buildingMaterials: MeshStandardMaterial[] = [];
  for (const district of DISTRICTS) {
    const recipes = layout.buildings.filter((building) => building.district === district.id);
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardMaterial({
      color: 0xffffff,
      emissive: district.emissiveColor,
      emissiveIntensity: 0.08,
      roughness: 0.72,
      metalness: district.id === 'alta-vista' ? 0.18 : 0.04,
    });
    const mesh = new InstancedMesh(geometry, material, recipes.length);
    const dummy = new Object3D();

    recipes.forEach((building, index) => {
      mesh.setMatrixAt(
        index,
        composeMatrix(
          dummy,
          building.position.x,
          building.position.y,
          building.position.z,
          building.width,
          building.height,
          building.depth,
        ),
      );
      mesh.setColorAt(index, new Color(building.color));
    });
    mesh.castShadow = quality === 'high';
    mesh.receiveShadow = true;
    root.add(mesh);
    geometries.push(geometry);
    materials.push(material);
    buildingMaterials.push(material);
  }
  return buildingMaterials;
}

function propStemDimensions(prop: PropRecipe): readonly [number, number] {
  switch (prop.kind) {
    case 'palm':
      return [0.34 * prop.scale, 7.2 * prop.scale];
    case 'tree':
      return [0.45 * prop.scale, 4.4 * prop.scale];
    case 'streetlight':
      return [0.13 * prop.scale, 6.2 * prop.scale];
    case 'bollard':
      return [0.22 * prop.scale, 1.05 * prop.scale];
    case 'container':
      return [0, 0];
  }
}

function createProps(
  root: Group,
  layout: CityLayout,
  geometries: BufferGeometry[],
  materials: MeshStandardMaterial[],
): void {
  const stems = layout.props.filter((prop) => prop.kind !== 'container');
  const stemGeometry = new CylinderGeometry(0.5, 0.68, 1, 6);
  const stemMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.88 });
  const stemMesh = new InstancedMesh(stemGeometry, stemMaterial, stems.length);
  const dummy = new Object3D();
  stems.forEach((prop, index) => {
    const [radius, height] = propStemDimensions(prop);
    stemMesh.setMatrixAt(
      index,
      composeMatrix(dummy, prop.position.x, height / 2, prop.position.z, radius, height, radius, prop.rotation),
    );
    const color = prop.kind === 'palm' || prop.kind === 'tree' ? 0x755235 : 0x46525a;
    stemMesh.setColorAt(index, new Color(color));
  });
  stemMesh.castShadow = true;
  root.add(stemMesh);
  geometries.push(stemGeometry);
  materials.push(stemMaterial);

  const foliage = layout.props.filter((prop) => prop.kind === 'palm' || prop.kind === 'tree');
  const foliageGeometry = new ConeGeometry(1, 1, 6);
  const foliageMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  const foliageMesh = new InstancedMesh(foliageGeometry, foliageMaterial, foliage.length);
  foliage.forEach((prop, index) => {
    const palm = prop.kind === 'palm';
    const radius = (palm ? 3.2 : 2.6) * prop.scale;
    const height = (palm ? 4.2 : 4.8) * prop.scale;
    const y = (palm ? 8.1 : 6.2) * prop.scale;
    foliageMesh.setMatrixAt(
      index,
      composeMatrix(dummy, prop.position.x, y, prop.position.z, radius, height, radius, prop.rotation),
    );
    foliageMesh.setColorAt(index, new Color(palm ? 0x2f9f6a : 0x4d8d50));
  });
  foliageMesh.castShadow = true;
  root.add(foliageMesh);
  geometries.push(foliageGeometry);
  materials.push(foliageMaterial);

  const lights = layout.props.filter((prop) => prop.kind === 'streetlight');
  const lightGeometry = new IcosahedronGeometry(0.32, 0);
  const lightMaterial = new MeshStandardMaterial({
    color: 0xfff2c3,
    emissive: 0xffb74f,
    emissiveIntensity: 2.2,
  });
  const lightMesh = new InstancedMesh(lightGeometry, lightMaterial, lights.length);
  lights.forEach((prop, index) => {
    lightMesh.setMatrixAt(
      index,
      composeMatrix(dummy, prop.position.x, 6.25 * prop.scale, prop.position.z, 1, 1, 1),
    );
  });
  root.add(lightMesh);
  geometries.push(lightGeometry);
  materials.push(lightMaterial);

  const containers = layout.props.filter((prop) => prop.kind === 'container');
  const containerGeometry = new BoxGeometry(1, 1, 1);
  const containerMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.78, metalness: 0.2 });
  const containerMesh = new InstancedMesh(containerGeometry, containerMaterial, containers.length);
  containers.forEach((prop, index) => {
    containerMesh.setMatrixAt(
      index,
      composeMatrix(
        dummy,
        prop.position.x,
        1.25 * prop.scale,
        prop.position.z,
        5.8 * prop.scale,
        2.5 * prop.scale,
        2.45 * prop.scale,
        prop.rotation,
      ),
    );
    containerMesh.setColorAt(index, new Color(prop.color));
  });
  containerMesh.castShadow = true;
  root.add(containerMesh);
  geometries.push(containerGeometry);
  materials.push(containerMaterial);
}

export function createCityVisuals(layout: CityLayout): CityVisualBundle {
  const root = new Group();
  root.name = 'procedural-solara';
  const geometries: BufferGeometry[] = [];
  const materials: MeshStandardMaterial[] = [];
  createDistrictGrounds(root, geometries, materials);
  const roadMaterial = createRoads(root, layout, geometries, materials);
  const buildingMaterials = createBuildings(root, layout, layout.quality, geometries, materials);
  createProps(root, layout, geometries, materials);

  return {
    root,
    buildingMaterials,
    roadMaterial,
    dispose: () => {
      root.removeFromParent();
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
    },
  };
}

export class AvatarVisual {
  public readonly root = new Group();

  private readonly leftArm: Mesh;
  private readonly rightArm: Mesh;
  private readonly leftLeg: Mesh;
  private readonly rightLeg: Mesh;
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: MeshStandardMaterial[] = [];

  public constructor() {
    this.root.name = 'alex-avatar';
    const jacketMaterial = new MeshStandardMaterial({ color: 0xff7045, roughness: 0.76 });
    const darkMaterial = new MeshStandardMaterial({ color: 0x182936, roughness: 0.84 });
    const skinMaterial = new MeshStandardMaterial({ color: 0xb97858, roughness: 0.92 });
    this.materials.push(jacketMaterial, darkMaterial, skinMaterial);

    const torsoGeometry = new BoxGeometry(0.78, 0.95, 0.42);
    const headGeometry = new IcosahedronGeometry(0.31, 1);
    const limbGeometry = new BoxGeometry(0.24, 0.78, 0.24);
    this.geometries.push(torsoGeometry, headGeometry, limbGeometry);

    const torso = new Mesh(torsoGeometry, jacketMaterial);
    torso.position.y = 1.42;
    torso.castShadow = true;
    const head = new Mesh(headGeometry, skinMaterial);
    head.position.y = 2.18;
    head.castShadow = true;
    this.leftArm = new Mesh(limbGeometry, jacketMaterial);
    this.rightArm = new Mesh(limbGeometry, jacketMaterial);
    this.leftLeg = new Mesh(limbGeometry, darkMaterial);
    this.rightLeg = new Mesh(limbGeometry, darkMaterial);
    this.leftArm.position.set(-0.53, 1.4, 0);
    this.rightArm.position.set(0.53, 1.4, 0);
    this.leftLeg.position.set(-0.23, 0.52, 0);
    this.rightLeg.position.set(0.23, 0.52, 0);
    for (const limb of [this.leftArm, this.rightArm, this.leftLeg, this.rightLeg]) {
      limb.castShadow = true;
    }
    this.root.add(torso, head, this.leftArm, this.rightArm, this.leftLeg, this.rightLeg);
  }

  public sync(state: Readonly<PlayerSimulationState>): void {
    this.root.position.set(state.position.x, state.position.y, state.position.z);
    this.root.rotation.y = state.heading;
    this.root.scale.y = state.crouching ? 0.72 : 1;
    const horizontalSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    const walkAmount = Math.min(1, horizontalSpeed / 4.8);
    const swing = Math.sin(state.stride * 2.25) * 0.72 * walkAmount;
    this.leftArm.rotation.x = swing;
    this.rightArm.rotation.x = -swing;
    this.leftLeg.rotation.x = -swing;
    this.rightLeg.rotation.x = swing;
  }

  public dispose(): void {
    this.root.removeFromParent();
    this.geometries.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
  }
}

export class VehicleVisual {
  public readonly root = new Group();

  private readonly wheels: readonly Mesh[];
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: (MeshStandardMaterial | MeshBasicMaterial)[] = [];
  private wheelSpin = 0;

  public constructor() {
    this.root.name = 'arcade-sports-car';
    const bodyMaterial = new MeshStandardMaterial({ color: 0x16b8a9, roughness: 0.42, metalness: 0.28 });
    const glassMaterial = new MeshStandardMaterial({ color: 0x163248, roughness: 0.2, metalness: 0.48 });
    const tireMaterial = new MeshStandardMaterial({ color: 0x101418, roughness: 0.94 });
    const headlightMaterial = new MeshBasicMaterial({ color: 0xfff1bd });
    this.materials.push(bodyMaterial, glassMaterial, tireMaterial, headlightMaterial);

    const lowerGeometry = new BoxGeometry(2.15, 0.62, 4.35);
    const cabinGeometry = new BoxGeometry(1.72, 0.68, 2.05);
    const bumperGeometry = new BoxGeometry(2.28, 0.24, 0.38);
    const wheelGeometry = new CylinderGeometry(0.43, 0.43, 0.38, 10);
    const lightGeometry = new BoxGeometry(0.42, 0.18, 0.08);
    this.geometries.push(lowerGeometry, cabinGeometry, bumperGeometry, wheelGeometry, lightGeometry);

    const lower = new Mesh(lowerGeometry, bodyMaterial);
    lower.position.y = 0.78;
    lower.castShadow = true;
    const cabin = new Mesh(cabinGeometry, glassMaterial);
    cabin.position.set(0, 1.37, -0.18);
    cabin.castShadow = true;
    const frontBumper = new Mesh(bumperGeometry, bodyMaterial);
    frontBumper.position.set(0, 0.58, -2.18);
    const rearBumper = new Mesh(bumperGeometry, bodyMaterial);
    rearBumper.position.set(0, 0.58, 2.18);

    const wheelPositions: readonly (readonly [number, number, number])[] = [
      [-1.08, 0.52, -1.42],
      [1.08, 0.52, -1.42],
      [-1.08, 0.52, 1.42],
      [1.08, 0.52, 1.42],
    ];
    this.wheels = wheelPositions.map(([x, y, z]) => {
      const wheel = new Mesh(wheelGeometry, tireMaterial);
      wheel.position.set(x, y, z);
      wheel.rotation.z = Math.PI / 2;
      wheel.castShadow = true;
      return wheel;
    });

    const leftHeadlight = new Mesh(lightGeometry, headlightMaterial);
    const rightHeadlight = new Mesh(lightGeometry, headlightMaterial);
    leftHeadlight.position.set(-0.63, 0.85, -2.2);
    rightHeadlight.position.set(0.63, 0.85, -2.2);
    this.root.add(
      lower,
      cabin,
      frontBumper,
      rearBumper,
      ...this.wheels,
      leftHeadlight,
      rightHeadlight,
    );
  }

  public sync(state: Readonly<VehicleSimulationState>, deltaSeconds: number): void {
    this.root.position.set(state.position.x, state.position.y, state.position.z);
    this.root.rotation.y = state.heading;
    this.wheelSpin -= state.speed * deltaSeconds / 0.43;
    this.wheels.forEach((wheel, index) => {
      wheel.rotation.x = this.wheelSpin;
      wheel.rotation.y = index < 2 ? -state.steering * 0.32 : 0;
    });
  }

  public dispose(): void {
    this.root.removeFromParent();
    this.geometries.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
  }
}

export class RainField {
  public readonly points: Points<BufferGeometry, PointsMaterial>;

  private readonly positions: Float32Array;
  private readonly geometry: BufferGeometry;
  private readonly material: PointsMaterial;
  private readonly count: number;

  public constructor(seed: number, quality: WorldQuality) {
    this.count = quality === 'high' ? 1_200 : 520;
    this.positions = new Float32Array(this.count * 3);
    const rng = new SeededRandom(seed ^ 0xa17c93);
    for (let index = 0; index < this.count; index += 1) {
      const offset = index * 3;
      this.positions[offset] = rng.range(-72, 72);
      this.positions[offset + 1] = rng.range(2, 72);
      this.positions[offset + 2] = rng.range(-72, 72);
    }
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    this.material = new PointsMaterial({
      color: 0xccecff,
      size: quality === 'high' ? 0.17 : 0.23,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.points = new Points(this.geometry, this.material);
    this.points.name = 'local-rain';
    this.points.frustumCulled = false;
  }

  public update(deltaSeconds: number, intensity: number, center: Readonly<Vec3Data>): void {
    const normalizedIntensity = Math.max(0, Math.min(1, intensity));
    this.points.visible = normalizedIntensity > 0.005;
    this.points.position.set(center.x, 0, center.z);
    this.material.opacity = 0.2 + normalizedIntensity * 0.58;
    this.geometry.setDrawRange(0, Math.ceil(this.count * normalizedIntensity));
    const fallDistance = deltaSeconds * (28 + normalizedIntensity * 36);
    for (let index = 1; index < this.positions.length; index += 3) {
      const current = this.positions[index];
      if (current === undefined) {
        continue;
      }
      const next = current - fallDistance;
      this.positions[index] = next < 0.5 ? 70 : next;
    }
    const positionAttribute = this.geometry.getAttribute('position');
    positionAttribute.needsUpdate = true;
  }

  public dispose(): void {
    this.points.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
