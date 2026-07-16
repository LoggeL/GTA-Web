import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
} from 'three';

import { boundsForCell, parseCellId } from '../navigation/cells';
import type { RoadClosureState } from '../navigation/types';
import type { CollisionRect } from './city';

export interface RoadClosureVisualSnapshot {
  readonly closureIds: readonly string[];
  readonly barrierCount: number;
}

interface ClosurePlacement {
  readonly x: number;
  readonly z: number;
  readonly alongX: boolean;
}

function placementFor(closure: Readonly<RoadClosureState>): ClosurePlacement {
  const target = boundsForCell(closure.toCellId);
  const targetCoordinates = parseCellId(closure.toCellId);
  if (!closure.fromCellId) {
    return {
      x: (target.minX + target.maxX) / 2,
      z: (target.minZ + target.maxZ) / 2,
      alongX: true,
    };
  }
  const fromCoordinates = parseCellId(closure.fromCellId);
  const deltaX = targetCoordinates.x - fromCoordinates.x;
  const deltaZ = targetCoordinates.z - fromCoordinates.z;
  if (Math.abs(deltaX) >= Math.abs(deltaZ) && deltaX !== 0) {
    return {
      x: deltaX > 0 ? target.minX + 0.8 : target.maxX - 0.8,
      z: (target.minZ + target.maxZ) / 2,
      alongX: false,
    };
  }
  return {
    x: (target.minX + target.maxX) / 2,
    z: deltaZ > 0 ? target.minZ + 0.8 : target.maxZ - 0.8,
    alongX: true,
  };
}

/** Lightweight authored barrier shown at a failed streamed-cell boundary. */
export class RoadClosureVisual {
  public readonly root = new Group();
  public disposed = false;

  readonly #geometry = new BoxGeometry(1, 1, 1);
  readonly #orange = new MeshStandardMaterial({
    color: 0xff784c,
    emissive: 0x7a1609,
    emissiveIntensity: 0.9,
    roughness: 0.7,
  });
  readonly #cream = new MeshStandardMaterial({
    color: 0xffe0a3,
    emissive: 0x6d4714,
    emissiveIntensity: 0.35,
    roughness: 0.78,
  });
  readonly #dark = new MeshStandardMaterial({
    color: 0x26343c,
    roughness: 0.86,
  });
  #closureIds: string[] = [];
  readonly #collisions: CollisionRect[] = [];

  public constructor() {
    this.root.name = 'stream-road-closures';
    this.root.visible = false;
  }

  public setClosures(
    closures: readonly Readonly<RoadClosureState>[],
  ): RoadClosureVisualSnapshot {
    if (this.disposed) throw new Error('Road closure visual is disposed');
    this.root.clear();
    this.#collisions.length = 0;
    const unique = new Map(closures.map((closure) => [closure.id, closure]));
    const ordered = [...unique.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    this.#closureIds = ordered.map((closure) => closure.id);

    for (const closure of ordered) {
      const placement = placementFor(closure);
      const group = new Group();
      group.name = `stream-road-closure:${closure.id}`;
      group.position.set(placement.x, 0, placement.z);
      this.#collisions.push({
        id: `stream-barrier:${closure.id}`,
        minX: placement.x - (placement.alongX ? 9 : 0.8),
        maxX: placement.x + (placement.alongX ? 9 : 0.8),
        minZ: placement.z - (placement.alongX ? 0.8 : 9),
        maxZ: placement.z + (placement.alongX ? 0.8 : 9),
        height: 1.7,
        kind: 'solid',
      });

      for (let index = 0; index < 6; index += 1) {
        const segment = new Mesh(
          this.#geometry,
          index % 2 === 0 ? this.#orange : this.#cream,
        );
        const offset = -7.5 + index * 3;
        segment.position.set(placement.alongX ? offset : 0, 1.25, placement.alongX ? 0 : offset);
        segment.scale.set(placement.alongX ? 3 : 0.42, 0.5, placement.alongX ? 0.42 : 3);
        segment.castShadow = true;
        group.add(segment);
      }
      for (const offset of [-7.6, 7.6]) {
        const foot = new Mesh(this.#geometry, this.#dark);
        foot.position.set(placement.alongX ? offset : 0, 0.55, placement.alongX ? 0 : offset);
        foot.scale.set(placement.alongX ? 0.5 : 2.1, 1.1, placement.alongX ? 2.1 : 0.5);
        foot.castShadow = true;
        group.add(foot);
      }
      this.root.add(group);
    }
    this.root.visible = ordered.length > 0;
    return this.snapshot();
  }

  public snapshot(): RoadClosureVisualSnapshot {
    return {
      closureIds: [...this.#closureIds],
      barrierCount: this.root.children.length,
    };
  }

  public get collisions(): readonly CollisionRect[] {
    return this.#collisions;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    this.root.clear();
    this.#closureIds = [];
    this.#collisions.length = 0;
    this.#geometry.dispose();
    this.#orange.dispose();
    this.#cream.dispose();
    this.#dark.dispose();
  }
}
