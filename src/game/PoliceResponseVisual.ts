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
    this.level = update.level;
    this.roadblockCollisions.length = 0;
    this.root.visible = update.level > 0;
    this.officers.visible = update.level >= 1;
    this.cruisers.visible = update.level >= 2;
    this.roadblock.visible = update.level >= 3;
    this.tacticalVan.visible = update.level >= 4;
    this.helicopter.visible = update.level >= 5;
    this.spotlight.visible = update.level >= 5 && update.phase !== 'clear';
    if (update.level === 0) return;

    const searchDistance = update.phase === 'search' || update.phase === 'investigating' ? 30 : 20;
    this.root.position.set(update.playerPosition.x, update.playerPosition.y, update.playerPosition.z);
    this.officers.position.set(-searchDistance * 0.55, 0, -searchDistance * 0.35);
    this.cruisers.position.set(searchDistance * 0.48, 0, -searchDistance * 0.42);
    const plannedRoadblock = update.responsePlan?.roadblocks[0];
    this.roadblock.position.set(
      plannedRoadblock ? plannedRoadblock.position.x - update.playerPosition.x : 0,
      0,
      plannedRoadblock ? plannedRoadblock.position.z - update.playerPosition.z : -searchDistance,
    );
    this.roadblock.rotation.y = plannedRoadblock?.heading ?? 0;
    if (update.level >= 3) {
      const deployments = update.responsePlan?.roadblocks.length
        ? update.responsePlan.roadblocks
        : [{
            id: 'fallback',
            anchorId: 'fallback',
            position: {
              x: update.playerPosition.x + this.roadblock.position.x,
              z: update.playerPosition.z + this.roadblock.position.z,
            },
            heading: 0,
            reinforced: update.level === 5,
            tireStrip: true,
          }];
      for (const deployment of deployments) {
        this.addRoadblockCollisions(deployment);
      }
    }
    this.tacticalVan.position.set(-searchDistance * 0.72, 0, searchDistance * 0.45);
    this.tacticalVan.rotation.y = Math.PI * 0.3;
    const plannedHelicopter = update.responsePlan?.helicopter;
    this.helicopter.position.set(
      plannedHelicopter?.active
        ? plannedHelicopter.position.x - update.playerPosition.x
        : searchDistance * 0.42,
      plannedHelicopter?.active
        ? plannedHelicopter.position.y - update.playerPosition.y
        : 18,
      plannedHelicopter?.active
        ? plannedHelicopter.position.z - update.playerPosition.z
        : searchDistance * 0.25,
    );
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

  private addRoadblockCollisions(deployment: Readonly<RoadblockDeployment>): void {
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
        height: 0.71,
        kind: 'solid',
      });
    }
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
