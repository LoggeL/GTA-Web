import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
} from 'three';
import type { BufferGeometry, Material, Scene } from 'three';

import { COMBAT_CAPACITY } from './combat';
import { PEDESTRIAN_CAPACITY } from './pedestrians';
import { TRAFFIC_CAPACITY } from './traffic';
import type { CitySimulationSnapshot, CombatRole } from './types';

const TRAFFIC_COLORS: readonly number[] = [0x18b6aa, 0xef6b47, 0xe5b94f, 0x5a79b8, 0xeeeeea, 0x7b5a91];
const PEDESTRIAN_COLORS: readonly number[] = [0xe57a59, 0x48a58d, 0xd6a845, 0x6678b6, 0xb66078];
const ROLE_COLORS: Readonly<Record<CombatRole, number>> = Object.freeze({
  brawler: 0xc85a3f,
  gunner: 0x6f8bc0,
  flanker: 0xa66eb0,
  heavy: 0x5d686e,
  marksman: 0xd0a23b,
});

function markInstancesUpdated(mesh: InstancedMesh): void {
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) {
    mesh.instanceColor.needsUpdate = true;
  }
}

export class SimulationVisualLayer {
  public readonly root = new Group();

  private readonly trafficBodies: InstancedMesh;
  private readonly trafficCabins: InstancedMesh;
  private readonly pedestrianBodies: InstancedMesh;
  private readonly pedestrianHeads: InstancedMesh;
  private readonly combatantBodies: InstancedMesh;
  private readonly geometries: BufferGeometry[];
  private readonly materials: Material[];
  private readonly dummy = new Object3D();

  public constructor(scene: Scene) {
    this.root.name = 'city-simulation-visuals';
    const trafficBodyGeometry = new BoxGeometry(2, 0.7, 4);
    const trafficCabinGeometry = new BoxGeometry(1.55, 0.55, 1.75);
    const pedestrianBodyGeometry = new CylinderGeometry(0.24, 0.3, 1.25, 6);
    const pedestrianHeadGeometry = new IcosahedronGeometry(0.24, 0);
    const combatantGeometry = new BoxGeometry(0.72, 1.65, 0.5);
    const trafficMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.48, metalness: 0.18 });
    const glassMaterial = new MeshStandardMaterial({ color: 0x18384a, roughness: 0.22, metalness: 0.35 });
    const pedestrianMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.86 });
    const skinMaterial = new MeshStandardMaterial({ color: 0xa87358, roughness: 0.9 });
    const combatMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.76 });

    this.trafficBodies = new InstancedMesh(trafficBodyGeometry, trafficMaterial, TRAFFIC_CAPACITY.high);
    this.trafficCabins = new InstancedMesh(trafficCabinGeometry, glassMaterial, TRAFFIC_CAPACITY.high);
    this.pedestrianBodies = new InstancedMesh(pedestrianBodyGeometry, pedestrianMaterial, PEDESTRIAN_CAPACITY.high);
    this.pedestrianHeads = new InstancedMesh(pedestrianHeadGeometry, skinMaterial, PEDESTRIAN_CAPACITY.high);
    this.combatantBodies = new InstancedMesh(combatantGeometry, combatMaterial, COMBAT_CAPACITY.high);
    for (const mesh of [
      this.trafficBodies,
      this.trafficCabins,
      this.pedestrianBodies,
      this.pedestrianHeads,
      this.combatantBodies,
    ]) {
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
    }

    this.root.add(
      this.trafficBodies,
      this.trafficCabins,
      this.pedestrianBodies,
      this.pedestrianHeads,
      this.combatantBodies,
    );
    scene.add(this.root);
    this.geometries = [
      trafficBodyGeometry,
      trafficCabinGeometry,
      pedestrianBodyGeometry,
      pedestrianHeadGeometry,
      combatantGeometry,
    ];
    this.materials = [trafficMaterial, glassMaterial, pedestrianMaterial, skinMaterial, combatMaterial];
  }

  public update(snapshot: Readonly<CitySimulationSnapshot>): void {
    this.updateTraffic(snapshot);
    this.updatePedestrians(snapshot);
    this.updateCombatants(snapshot);
  }

  public dispose(): void {
    this.root.removeFromParent();
    this.geometries.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
  }

  private setHidden(mesh: InstancedMesh, index: number): void {
    this.dummy.position.set(0, -10_000, 0);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.set(0, 0, 0);
    this.dummy.updateMatrix();
    mesh.setMatrixAt(index, this.dummy.matrix);
  }

  private updateTraffic(snapshot: Readonly<CitySimulationSnapshot>): void {
    for (let index = 0; index < TRAFFIC_CAPACITY.high; index += 1) {
      const vehicle = snapshot.traffic[index];
      if (!vehicle) {
        this.setHidden(this.trafficBodies, index);
        this.setHidden(this.trafficCabins, index);
        continue;
      }
      this.dummy.position.set(vehicle.position.x, 0.48, vehicle.position.z);
      this.dummy.rotation.set(0, vehicle.heading, 0);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      this.trafficBodies.setMatrixAt(index, this.dummy.matrix);
      this.trafficBodies.setColorAt(index, new Color(TRAFFIC_COLORS[index % TRAFFIC_COLORS.length] ?? 0xffffff));
      this.dummy.position.y = 1.04;
      this.dummy.updateMatrix();
      this.trafficCabins.setMatrixAt(index, this.dummy.matrix);
    }
    markInstancesUpdated(this.trafficBodies);
    markInstancesUpdated(this.trafficCabins);
  }

  private updatePedestrians(snapshot: Readonly<CitySimulationSnapshot>): void {
    for (let index = 0; index < PEDESTRIAN_CAPACITY.high; index += 1) {
      const pedestrian = snapshot.pedestrians[index];
      if (!pedestrian) {
        this.setHidden(this.pedestrianBodies, index);
        this.setHidden(this.pedestrianHeads, index);
        continue;
      }
      this.dummy.position.set(pedestrian.position.x, 0.63, pedestrian.position.z);
      this.dummy.rotation.set(0, pedestrian.heading, 0);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      this.pedestrianBodies.setMatrixAt(index, this.dummy.matrix);
      this.pedestrianBodies.setColorAt(index, new Color(PEDESTRIAN_COLORS[index % PEDESTRIAN_COLORS.length] ?? 0xffffff));
      this.dummy.position.y = 1.48;
      this.dummy.updateMatrix();
      this.pedestrianHeads.setMatrixAt(index, this.dummy.matrix);
    }
    markInstancesUpdated(this.pedestrianBodies);
    markInstancesUpdated(this.pedestrianHeads);
  }

  private updateCombatants(snapshot: Readonly<CitySimulationSnapshot>): void {
    for (let index = 0; index < COMBAT_CAPACITY.high; index += 1) {
      const combatant = snapshot.combatants[index];
      if (!combatant) {
        this.setHidden(this.combatantBodies, index);
        continue;
      }
      this.dummy.position.set(
        combatant.position.x,
        combatant.behavior === 'defeated' ? 0.38 : 0.84,
        combatant.position.z,
      );
      this.dummy.rotation.set(0, combatant.heading, combatant.behavior === 'defeated' ? Math.PI / 2 : 0);
      const heavyScale = combatant.role === 'heavy' ? 1.28 : 1;
      this.dummy.scale.set(heavyScale, heavyScale, heavyScale);
      this.dummy.updateMatrix();
      this.combatantBodies.setMatrixAt(index, this.dummy.matrix);
      this.combatantBodies.setColorAt(index, new Color(ROLE_COLORS[combatant.role]));
    }
    markInstancesUpdated(this.combatantBodies);
  }
}

