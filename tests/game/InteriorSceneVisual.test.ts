import {
  BoxGeometry,
  CylinderGeometry,
  Mesh,
  PlaneGeometry,
} from 'three';
import type { BufferGeometry, Material, MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';

import {
  AUTHORED_INTERIORS,
} from '../../src/game/InteriorRuntime';
import type {
  InteriorDefinition,
  InteriorVisualRecipe,
} from '../../src/game/InteriorRuntime';
import { InteriorSceneVisual } from '../../src/game/InteriorSceneVisual';

function fixtureDefinition(): InteriorDefinition {
  const source = AUTHORED_INTERIORS[0];
  if (!source) {
    throw new Error('Expected an authored interior fixture');
  }
  const visuals: readonly InteriorVisualRecipe[] = [
    {
      id: 'test-box',
      primitive: 'box',
      position: { x: 1, y: 2, z: 3 },
      size: { x: 4, y: 5, z: 6 },
      rotationY: Math.PI / 3,
      color: 0x123456,
    },
    {
      id: 'test-plane',
      primitive: 'plane',
      position: { x: -2, y: 3, z: -4 },
      size: { x: 7, y: 0.4, z: 1 },
      rotationY: -Math.PI / 4,
      color: 0xabcdef,
      emissiveColor: 0x112233,
    },
    {
      id: 'test-cylinder',
      primitive: 'cylinder',
      position: { x: 5, y: 1.5, z: 2 },
      size: { x: 2, y: 3, z: 4 },
      rotationY: Math.PI / 8,
      color: 0xfedcba,
    },
  ];
  return {
    ...source,
    scene: {
      ...source.scene,
      exitPosition: { x: 0.5, y: 0, z: 6 },
      visuals,
    },
  };
}

function meshNamed(visual: InteriorSceneVisual, name: string): Mesh {
  const object = visual.root.getObjectByName(name);
  if (!(object instanceof Mesh)) {
    throw new Error(`Expected mesh named ${name}`);
  }
  return object;
}

function ownedResources(visual: InteriorSceneVisual): {
  geometries: Set<BufferGeometry>;
  materials: Set<Material>;
} {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  visual.root.traverse((object) => {
    if (!(object instanceof Mesh)) {
      return;
    }
    geometries.add(object.geometry);
    if (Array.isArray(object.material)) {
      object.material.forEach((material) => materials.add(material));
    } else {
      materials.add(object.material);
    }
  });
  return { geometries, materials };
}

describe('InteriorSceneVisual', () => {
  it('builds deterministic box, plane, and cylinder recipe meshes', () => {
    const definition = fixtureDefinition();
    const visual = new InteriorSceneVisual();

    visual.load(definition);

    expect(visual.group).toBe(visual.root);
    expect(visual.loadedInteriorId).toBe(definition.id);
    expect(visual.root.name).toBe(`interior-scene:${definition.id}`);

    const box = meshNamed(visual, 'interior-visual:test-box');
    const plane = meshNamed(visual, 'interior-visual:test-plane');
    const cylinder = meshNamed(visual, 'interior-visual:test-cylinder');
    expect(box.geometry).toBeInstanceOf(BoxGeometry);
    expect(plane.geometry).toBeInstanceOf(PlaneGeometry);
    expect(cylinder.geometry).toBeInstanceOf(CylinderGeometry);
    expect(box.position.toArray()).toEqual([1, 2, 3]);
    expect(box.scale.toArray()).toEqual([4, 5, 6]);
    expect(box.rotation.y).toBeCloseTo(Math.PI / 3);
    expect(plane.position.toArray()).toEqual([-2, 3, -4]);
    expect(plane.scale.toArray()).toEqual([7, 0.4, 1]);
    expect(plane.rotation.y).toBeCloseTo(-Math.PI / 4);
    expect(cylinder.position.toArray()).toEqual([5, 1.5, 2]);
    expect(cylinder.scale.toArray()).toEqual([2, 3, 4]);
    expect(cylinder.rotation.y).toBeCloseTo(Math.PI / 8);

    const boxMaterial = box.material as MeshStandardMaterial;
    const planeMaterial = plane.material as MeshStandardMaterial;
    expect(boxMaterial.color.getHex()).toBe(0x123456);
    expect(boxMaterial.emissive.getHex()).toBe(0x000000);
    expect(boxMaterial.emissiveIntensity).toBe(0);
    expect(planeMaterial.color.getHex()).toBe(0xabcdef);
    expect(planeMaterial.emissive.getHex()).toBe(0x112233);
    expect(planeMaterial.emissiveIntensity).toBeGreaterThan(0);

    visual.dispose();
  });

  it('adds a geometry-only exit doorway and floor beacon at the authored exit', () => {
    const definition = fixtureDefinition();
    const visual = new InteriorSceneVisual();

    visual.load(definition);

    const cue = visual.root.getObjectByName('interior-exit-cue');
    expect(cue?.position.toArray()).toEqual([0.5, 0, 6]);
    expect(cue?.children).toHaveLength(4);
    expect(meshNamed(visual, 'interior-exit-cue:left').geometry).toBeInstanceOf(
      BoxGeometry,
    );
    expect(meshNamed(visual, 'interior-exit-cue:right').geometry).toBeInstanceOf(
      BoxGeometry,
    );
    expect(meshNamed(visual, 'interior-exit-cue:header').geometry).toBeInstanceOf(
      BoxGeometry,
    );
    expect(meshNamed(visual, 'interior-exit-cue:beacon').geometry).toBeInstanceOf(
      CylinderGeometry,
    );
    expect(
      (meshNamed(visual, 'interior-exit-cue:beacon').material as MeshStandardMaterial)
        .emissive.getHex(),
    ).not.toBe(0);

    visual.dispose();
  });

  it('releases replaced resources once and keeps clear and dispose idempotent', () => {
    const definition = fixtureDefinition();
    const visual = new InteriorSceneVisual();
    visual.load(definition);
    const firstResources = ownedResources(visual);
    let firstDisposeEvents = 0;
    for (const resource of [
      ...firstResources.geometries,
      ...firstResources.materials,
    ]) {
      resource.addEventListener('dispose', () => {
        firstDisposeEvents += 1;
      });
    }

    visual.load(definition);

    expect(firstDisposeEvents).toBe(
      firstResources.geometries.size + firstResources.materials.size,
    );
    expect(visual.root.children).toHaveLength(definition.scene.visuals.length + 1);
    const replacementResources = ownedResources(visual);
    let replacementDisposeEvents = 0;
    for (const resource of [
      ...replacementResources.geometries,
      ...replacementResources.materials,
    ]) {
      resource.addEventListener('dispose', () => {
        replacementDisposeEvents += 1;
      });
    }

    visual.clear();
    visual.clear();
    visual.dispose();
    visual.dispose();

    expect(replacementDisposeEvents).toBe(
      replacementResources.geometries.size + replacementResources.materials.size,
    );
    expect(visual.root.children).toHaveLength(0);
    expect(visual.loadedInteriorId).toBeNull();
    expect(visual.disposed).toBe(true);
    expect(() => visual.load(definition)).toThrow(/disposed/);
  });

  it('rejects malformed transforms before replacing a loaded scene', () => {
    const definition = fixtureDefinition();
    const visual = new InteriorSceneVisual();
    visual.load(definition);
    const malformed: InteriorDefinition = {
      ...definition,
      scene: {
        ...definition.scene,
        visuals: [
          {
            ...definition.scene.visuals[0]!,
            size: { x: 1, y: 0, z: 1 },
          },
        ],
      },
    };

    expect(() => visual.load(malformed)).toThrow(/positive finite dimensions/);
    expect(visual.loadedInteriorId).toBe(definition.id);
    expect(visual.root.children).toHaveLength(definition.scene.visuals.length + 1);

    visual.dispose();
  });
});
