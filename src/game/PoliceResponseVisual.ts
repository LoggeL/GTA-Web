import { Group } from 'three';

import type { CellId, RoadGraph } from '../navigation/types';
import type { PoliceResponseSnapshot } from '../systems/policeResponse';
import type { CollisionRect } from './city';
import type { Vec3Data } from './types';

export type PoliceVisualLevel = 0 | 1 | 2 | 3 | 4 | 5;
export type PoliceVisualPhase = 'clear' | 'investigating' | 'pursuit' | 'search';

/**
 * Compatibility input retained at the WorldView seam while live police actors
 * are removed. Wanted/crime data can continue to load old saves and advance
 * authored objectives without creating a response in the world.
 */
export interface PoliceResponseVisualUpdate {
  readonly playerPosition: Readonly<Vec3Data>;
  readonly level: PoliceVisualLevel;
  readonly phase: PoliceVisualPhase;
  readonly elapsedSeconds: number;
  readonly reducedMotion: boolean;
  readonly responsePlan?: Readonly<PoliceResponseSnapshot> | null;
  readonly navigationGraph?: Readonly<RoadGraph> | null;
  readonly renderableCellIds?: ReadonlySet<CellId> | null;
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

const DISABLED_POLICE_RESPONSE_SNAPSHOT: Readonly<PoliceResponseVisualSnapshot> =
  Object.freeze({
    level: 0,
    officers: false,
    cruisers: false,
    roadblock: false,
    tacticalVan: false,
    helicopter: false,
    spotlight: false,
  });

const NO_POLICE_COLLISIONS: readonly CollisionRect[] = Object.freeze([]);

/**
 * Disabled production adapter for the former police presentation seam.
 *
 * It intentionally allocates no response geometry or materials, creates no
 * child actors, and reports no collisions. Keeping the established interface
 * lets saves, wanted state, and mission logic remain compatible without
 * allowing broken police deployments back into the rendered world.
 */
export class PoliceResponseVisual {
  public readonly root = new Group();

  public constructor() {
    this.root.name = 'police-response-disabled';
    this.root.visible = false;
  }

  public update(_update: Readonly<PoliceResponseVisualUpdate>): void {
    this.root.visible = false;
  }

  public snapshot(): PoliceResponseVisualSnapshot {
    return DISABLED_POLICE_RESPONSE_SNAPSHOT;
  }

  public get collisions(): readonly CollisionRect[] {
    return NO_POLICE_COLLISIONS;
  }

  public dispose(): void {
    this.root.visible = false;
    this.root.removeFromParent();
  }
}
