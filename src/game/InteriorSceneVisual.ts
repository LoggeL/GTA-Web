import {
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  FrontSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
} from 'three';
import type { BufferGeometry, Material } from 'three';

import type {
  InteriorDefinition,
  InteriorVisualRecipe,
} from './InteriorRuntime';
import type { Vec3Data } from './types';

const EXIT_CUE_COLOR = 0x5eead4;
const EXIT_CUE_EMISSIVE_INTENSITY = 1.15;
const RECIPE_EMISSIVE_INTENSITY = 0.72;

type InteriorPrimitiveGeometry =
  | BoxGeometry
  | CylinderGeometry
  | PlaneGeometry;

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function assertFiniteVector(label: string, value: Readonly<Vec3Data>): void {
  if (![value.x, value.y, value.z].every(Number.isFinite)) {
    throw new RangeError(`${label} must contain finite coordinates`);
  }
}

function assertValidRecipe(recipe: Readonly<InteriorVisualRecipe>): void {
  if (recipe.id.trim().length === 0) {
    throw new TypeError('Interior visual recipe IDs cannot be empty');
  }
  assertFiniteVector(`Interior visual "${recipe.id}" position`, recipe.position);
  if (![recipe.size.x, recipe.size.y, recipe.size.z].every(isFinitePositive)) {
    throw new RangeError(
      `Interior visual "${recipe.id}" size must contain positive finite dimensions`,
    );
  }
  if (!Number.isFinite(recipe.rotationY)) {
    throw new RangeError(`Interior visual "${recipe.id}" rotation must be finite`);
  }
}

function createGeometry(
  primitive: InteriorVisualRecipe['primitive'],
): InteriorPrimitiveGeometry {
  switch (primitive) {
    case 'box':
      return new BoxGeometry(1, 1, 1);
    case 'plane':
      return new PlaneGeometry(1, 1);
    case 'cylinder':
      return new CylinderGeometry(0.5, 0.5, 1, 16, 1, false);
  }
}

function createRecipeMaterial(
  recipe: Readonly<InteriorVisualRecipe>,
): MeshStandardMaterial {
  const emissive = recipe.emissiveColor ?? 0x000000;
  return new MeshStandardMaterial({
    color: recipe.color,
    emissive,
    emissiveIntensity:
      recipe.emissiveColor === undefined ? 0 : RECIPE_EMISSIVE_INTENSITY,
    metalness: recipe.emissiveColor === undefined ? 0.04 : 0.12,
    roughness: recipe.emissiveColor === undefined ? 0.82 : 0.58,
    side: recipe.primitive === 'plane' ? DoubleSide : FrontSide,
  });
}

/**
 * Owns all scene-graph and GPU resources created from one interior recipe.
 * The root group itself is stable so callers can attach it to a scene once,
 * then safely replace or clear its contents during interior transitions.
 */
export class InteriorSceneVisual {
  public readonly root = new Group();
  public readonly group = this.root;

  readonly #geometries = new Set<BufferGeometry>();
  readonly #materials = new Set<Material>();
  #loadedInteriorId: InteriorDefinition['id'] | null = null;
  #disposed = false;

  public constructor() {
    this.root.name = 'interior-scene';
  }

  public get loadedInteriorId(): InteriorDefinition['id'] | null {
    return this.#loadedInteriorId;
  }

  public get disposed(): boolean {
    return this.#disposed;
  }

  public load(definition: Readonly<InteriorDefinition>): void {
    this.#assertUsable();
    assertFiniteVector('Interior exit position', definition.scene.exitPosition);
    definition.scene.visuals.forEach(assertValidRecipe);

    this.clear();
    this.root.name = `interior-scene:${definition.id}`;
    this.root.userData.interiorId = definition.id;

    for (const recipe of definition.scene.visuals) {
      this.#addRecipeVisual(recipe);
    }
    this.#addExitCue(definition);
    this.#loadedInteriorId = definition.id;
  }

  public clear(): void {
    if (this.#disposed) {
      return;
    }

    this.root.clear();
    for (const geometry of this.#geometries) {
      geometry.dispose();
    }
    for (const material of this.#materials) {
      material.dispose();
    }
    this.#geometries.clear();
    this.#materials.clear();
    this.#loadedInteriorId = null;
    this.root.name = 'interior-scene';
    delete this.root.userData.interiorId;
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.clear();
    this.#disposed = true;
  }

  #addRecipeVisual(recipe: Readonly<InteriorVisualRecipe>): void {
    const geometry = createGeometry(recipe.primitive);
    const material = createRecipeMaterial(recipe);
    const mesh = new Mesh(geometry, material);
    mesh.name = `interior-visual:${recipe.id}`;
    mesh.position.set(recipe.position.x, recipe.position.y, recipe.position.z);
    mesh.rotation.set(0, recipe.rotationY, 0);
    mesh.scale.set(recipe.size.x, recipe.size.y, recipe.size.z);
    mesh.castShadow = recipe.primitive !== 'plane';
    mesh.receiveShadow = true;
    mesh.userData.recipeId = recipe.id;
    mesh.userData.primitive = recipe.primitive;
    this.root.add(mesh);
    this.#track(geometry, material);
  }

  #addExitCue(definition: Readonly<InteriorDefinition>): void {
    const cue = new Group();
    cue.name = 'interior-exit-cue';
    cue.position.set(
      definition.scene.exitPosition.x,
      definition.scene.exitPosition.y,
      definition.scene.exitPosition.z,
    );
    cue.userData.kind = 'exit-cue';

    const frameMaterial = new MeshStandardMaterial({
      color: EXIT_CUE_COLOR,
      emissive: EXIT_CUE_COLOR,
      emissiveIntensity: EXIT_CUE_EMISSIVE_INTENSITY,
      metalness: 0.18,
      roughness: 0.34,
    });
    this.#materials.add(frameMaterial);

    const addFramePart = (
      name: string,
      position: readonly [number, number, number],
      scale: readonly [number, number, number],
    ): void => {
      const geometry = new BoxGeometry(1, 1, 1);
      const mesh = new Mesh(geometry, frameMaterial);
      mesh.name = name;
      mesh.position.set(...position);
      mesh.scale.set(...scale);
      mesh.castShadow = false;
      cue.add(mesh);
      this.#geometries.add(geometry);
    };

    addFramePart('interior-exit-cue:left', [-1.08, 1.25, 0.68], [0.12, 2.5, 0.12]);
    addFramePart('interior-exit-cue:right', [1.08, 1.25, 0.68], [0.12, 2.5, 0.12]);
    addFramePart('interior-exit-cue:header', [0, 2.48, 0.68], [2.28, 0.12, 0.12]);

    const beaconGeometry = new CylinderGeometry(0.5, 0.5, 1, 24, 1, false);
    const beaconMaterial = new MeshStandardMaterial({
      color: EXIT_CUE_COLOR,
      emissive: EXIT_CUE_COLOR,
      emissiveIntensity: EXIT_CUE_EMISSIVE_INTENSITY,
      transparent: true,
      opacity: 0.7,
      metalness: 0.05,
      roughness: 0.42,
    });
    const beacon = new Mesh(beaconGeometry, beaconMaterial);
    beacon.name = 'interior-exit-cue:beacon';
    beacon.position.set(0, 0.025, 0);
    beacon.scale.set(1.15, 0.05, 1.15);
    beacon.receiveShadow = false;
    cue.add(beacon);
    this.#track(beaconGeometry, beaconMaterial);

    this.root.add(cue);
  }

  #track(geometry: BufferGeometry, material: Material): void {
    this.#geometries.add(geometry);
    this.#materials.add(material);
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new Error('InteriorSceneVisual has been disposed');
    }
  }
}
