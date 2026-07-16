import {
  AdditiveBlending,
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  RingGeometry,
} from 'three';
import type { BufferGeometry, Material } from 'three';
import type { CellId } from '../navigation/types';

import {
  AUTHORED_INTERIORS,
} from './InteriorRuntime';
import type {
  InteriorDefinition,
  InteriorPortalDefinition,
} from './InteriorRuntime';

const PORTAL_ACCENTS = [
  0x31d7c7,
  0xff8a4c,
  0x63b7ff,
  0xe67cff,
  0xffd15c,
] as const;

const BEACON_BASE_HEIGHT = 3.36;

interface PortalPulseTarget {
  readonly beacon: Mesh<OctahedronGeometry, MeshStandardMaterial>;
  readonly halo: Mesh<RingGeometry, MeshBasicMaterial>;
  readonly accentMaterial: MeshStandardMaterial;
  readonly phase: number;
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function accentFor(portalId: string): number {
  const index = stableHash(portalId) % PORTAL_ACCENTS.length;
  return PORTAL_ACCENTS[index] ?? PORTAL_ACCENTS[0];
}

function phaseFor(portalId: string): number {
  return (stableHash(`${portalId}:pulse`) / 0xffff_ffff) * Math.PI * 2;
}

function addScaledBox(
  parent: Group,
  geometry: BoxGeometry,
  material: MeshStandardMaterial,
  name: string,
  position: readonly [number, number, number],
  scale: readonly [number, number, number],
): Mesh<BoxGeometry, MeshStandardMaterial> {
  const mesh = new Mesh(geometry, material);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/**
 * Lightweight exterior cues for authored interiors. The component owns every
 * GPU resource it creates; attach `root` to the world scene and call `dispose`
 * when that scene is torn down.
 */
export class InteriorPortalVisual {
  public readonly root = new Group();

  readonly #geometries = new Set<BufferGeometry>();
  readonly #materials = new Set<Material>();
  readonly #pulseTargets: PortalPulseTarget[] = [];
  readonly #portalCells = new Map<Group, CellId>();
  #disposed = false;

  public constructor(
    definitions: readonly InteriorDefinition[] = AUTHORED_INTERIORS,
  ) {
    this.root.name = 'interior-portal-visuals';

    const boxGeometry = new BoxGeometry(1, 1, 1);
    const stemGeometry = new CylinderGeometry(0.035, 0.055, 0.48, 6);
    const beaconGeometry = new OctahedronGeometry(0.22, 0);
    const haloGeometry = new RingGeometry(0.56, 0.72, 20);
    this.#geometries.add(boxGeometry);
    this.#geometries.add(stemGeometry);
    this.#geometries.add(beaconGeometry);
    this.#geometries.add(haloGeometry);

    const frameMaterial = new MeshStandardMaterial({
      color: 0x263640,
      roughness: 0.72,
      metalness: 0.28,
    });
    this.#materials.add(frameMaterial);

    for (const definition of definitions) {
      const portalRoot = this.#createPortal(
        definition.portal,
        boxGeometry,
        stemGeometry,
        beaconGeometry,
        haloGeometry,
        frameMaterial,
      );
      this.#portalCells.set(portalRoot, definition.portal.cellId);
    }
  }

  public get disposed(): boolean {
    return this.#disposed;
  }

  public setVisible(visible: boolean): void {
    if (this.#disposed) {
      return;
    }
    this.root.visible = visible;
  }

  /** Keeps exterior cues resident only with their streamed city cell. */
  public setResidentCellIds(cellIds: readonly CellId[]): void {
    if (this.#disposed) return;
    const resident = new Set(cellIds);
    for (const [portalRoot, cellId] of this.#portalCells) {
      portalRoot.visible = resident.has(cellId);
    }
  }

  /** Update pulse animation with elapsed time in seconds. */
  public update(elapsedSeconds: number, reducedMotion = false): void {
    if (this.#disposed) {
      return;
    }
    if (!Number.isFinite(elapsedSeconds)) {
      throw new RangeError('Portal visual time must be finite');
    }

    for (const target of this.#pulseTargets) {
      const wave = reducedMotion
        ? 0.5
        : (Math.sin(elapsedSeconds * 2.15 + target.phase) + 1) / 2;
      target.accentMaterial.emissiveIntensity = 0.78 + wave * 1.18;
      target.halo.material.opacity = 0.14 + wave * 0.18;
      const haloScale = reducedMotion ? 1.04 : 0.94 + wave * 0.16;
      target.halo.scale.setScalar(haloScale);
      target.beacon.position.y = reducedMotion
        ? BEACON_BASE_HEIGHT
        : BEACON_BASE_HEIGHT + Math.sin(elapsedSeconds * 1.7 + target.phase) * 0.09;
      target.beacon.rotation.y = reducedMotion
        ? target.phase
        : target.phase + elapsedSeconds * 0.72;
    }
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.root.removeFromParent();
    for (const geometry of this.#geometries) {
      geometry.dispose();
    }
    for (const material of this.#materials) {
      material.dispose();
    }
    this.#geometries.clear();
    this.#materials.clear();
    this.#pulseTargets.length = 0;
    this.#portalCells.clear();
    this.root.clear();
    this.root.visible = false;
  }

  #createPortal(
    portal: Readonly<InteriorPortalDefinition>,
    boxGeometry: BoxGeometry,
    stemGeometry: CylinderGeometry,
    beaconGeometry: OctahedronGeometry,
    haloGeometry: RingGeometry,
    frameMaterial: MeshStandardMaterial,
  ): Group {
    const portalRoot = new Group();
    portalRoot.name = `interior-portal:${portal.id}`;
    portalRoot.position.set(
      portal.position.x,
      portal.position.y + 0.015,
      portal.position.z,
    );
    portalRoot.rotation.y = portal.safeExteriorTransform.heading;

    const accent = accentFor(portal.id);
    const doorMaterial = new MeshStandardMaterial({
      color: 0x14232d,
      emissive: accent,
      emissiveIntensity: 0.18,
      roughness: 0.58,
      metalness: 0.36,
    });
    const accentMaterial = new MeshStandardMaterial({
      color: accent,
      emissive: accent,
      emissiveIntensity: 1.2,
      roughness: 0.32,
      metalness: 0.12,
      toneMapped: false,
    });
    const haloMaterial = new MeshBasicMaterial({
      color: accent,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    this.#materials.add(doorMaterial);
    this.#materials.add(accentMaterial);
    this.#materials.add(haloMaterial);

    addScaledBox(
      portalRoot,
      boxGeometry,
      doorMaterial,
      `interior-portal:${portal.id}:door`,
      [0, 1.34, 0],
      [1.64, 2.5, 0.16],
    );
    addScaledBox(
      portalRoot,
      boxGeometry,
      frameMaterial,
      `interior-portal:${portal.id}:frame-left`,
      [-0.98, 1.46, 0.02],
      [0.18, 2.92, 0.28],
    );
    addScaledBox(
      portalRoot,
      boxGeometry,
      frameMaterial,
      `interior-portal:${portal.id}:frame-right`,
      [0.98, 1.46, 0.02],
      [0.18, 2.92, 0.28],
    );
    addScaledBox(
      portalRoot,
      boxGeometry,
      frameMaterial,
      `interior-portal:${portal.id}:frame-top`,
      [0, 2.84, 0.02],
      [2.14, 0.18, 0.28],
    );
    addScaledBox(
      portalRoot,
      boxGeometry,
      frameMaterial,
      `interior-portal:${portal.id}:threshold`,
      [0, 0.04, 0.14],
      [2.14, 0.08, 0.58],
    );
    addScaledBox(
      portalRoot,
      boxGeometry,
      accentMaterial,
      `interior-portal:${portal.id}:accent-left`,
      [-0.81, 1.34, -0.1],
      [0.055, 2.42, 0.045],
    );
    addScaledBox(
      portalRoot,
      boxGeometry,
      accentMaterial,
      `interior-portal:${portal.id}:accent-right`,
      [0.81, 1.34, -0.1],
      [0.055, 2.42, 0.045],
    );

    const stem = new Mesh(stemGeometry, frameMaterial);
    stem.name = `interior-portal:${portal.id}:beacon-stem`;
    stem.position.y = 3.08;
    stem.castShadow = true;
    portalRoot.add(stem);

    const beacon = new Mesh(beaconGeometry, accentMaterial);
    beacon.name = `interior-portal:${portal.id}:beacon`;
    beacon.position.y = BEACON_BASE_HEIGHT;
    beacon.castShadow = true;
    portalRoot.add(beacon);

    const halo = new Mesh(haloGeometry, haloMaterial);
    halo.name = `interior-portal:${portal.id}:halo`;
    halo.position.set(0, 0.025, -0.14);
    halo.rotation.x = -Math.PI / 2;
    halo.renderOrder = 1;
    portalRoot.add(halo);

    this.root.add(portalRoot);
    this.#pulseTargets.push({
      beacon,
      halo,
      accentMaterial,
      phase: phaseFor(portal.id),
    });
    return portalRoot;
  }
}
