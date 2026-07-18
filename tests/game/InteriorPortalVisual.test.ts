import {
  Group,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  Object3D,
} from 'three';
import type {
  BufferGeometry,
  Material,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import { AUTHORED_INTERIORS } from '../../src/game/InteriorRuntime';
import { InteriorPortalVisual } from '../../src/game/InteriorPortalVisual';

function opaqueBatchFor(
  visual: InteriorPortalVisual,
): InstancedMesh<BufferGeometry, MeshStandardMaterial> {
  const object = visual.root.getObjectByName('interior-portal:opaque-batch');
  expect(object).toBeInstanceOf(InstancedMesh);
  const material = (object as Mesh).material;
  expect(material).toBeInstanceOf(MeshStandardMaterial);
  return object as InstancedMesh<BufferGeometry, MeshStandardMaterial>;
}

describe('InteriorPortalVisual', () => {
  it('mounts one deterministic batched entrance on every authored building facade', () => {
    const first = new InteriorPortalVisual();
    const reordered = new InteriorPortalVisual([...AUTHORED_INTERIORS].reverse());

    expect(first.root.name).toBe('interior-portal-visuals');
    expect(first.root.children).toHaveLength(AUTHORED_INTERIORS.length + 1);
    const firstBatch = opaqueBatchFor(first);
    const reorderedBatch = opaqueBatchFor(reordered);
    const firstAccents = firstBatch.geometry.getAttribute('instancePortalAccent');
    const reorderedAccents = reorderedBatch.geometry.getAttribute('instancePortalAccent');
    const firstPhases = firstBatch.geometry.getAttribute('instancePortalPhase');
    const reorderedPhases = reorderedBatch.geometry.getAttribute('instancePortalPhase');
    for (const definition of AUTHORED_INTERIORS) {
      const portalName = `interior-portal:${definition.portal.id}`;
      const portal = first.root.getObjectByName(portalName);
      expect(portal).toBeInstanceOf(Group);
      expect(portal?.position.toArray()).toEqual([
        definition.portal.attachment.position.x,
        definition.portal.attachment.position.y + 0.015,
        definition.portal.attachment.position.z,
      ]);
      expect(portal?.rotation.y).toBe(definition.portal.attachment.heading);
      expect(portal?.userData.hostBuildingId).toBe(definition.exteriorBuilding.id);
      const door = first.root.getObjectByName(`${portalName}:door`);
      expect(door).toBeInstanceOf(Object3D);
      expect(door?.position.z).toBeGreaterThan(0);
      expect(first.root.getObjectByName(`${portalName}:sign`)).toBeInstanceOf(Object3D);
      expect(first.root.getObjectByName(`${portalName}:awning`)).toBeInstanceOf(Object3D);
      expect(first.root.getObjectByName(`${portalName}:beacon`)).toBeUndefined();
      expect(first.root.getObjectByName(`${portalName}:halo`)).toBeUndefined();
      expect(first.root.getObjectByName(`${portalName}:threshold`)).toBeUndefined();

      const renderables: Mesh[] = [];
      portal?.traverse((object) => {
        if (object instanceof Mesh) renderables.push(object);
      });
      expect(renderables).toHaveLength(0);

      const firstIndex = AUTHORED_INTERIORS.indexOf(definition);
      const reorderedIndex = [...AUTHORED_INTERIORS].reverse().findIndex(
        ({ portal: { id } }) => id === definition.portal.id,
      );
      expect([
        firstAccents.getX(firstIndex),
        firstAccents.getY(firstIndex),
        firstAccents.getZ(firstIndex),
        firstPhases.getX(firstIndex),
      ]).toEqual([
        reorderedAccents.getX(reorderedIndex),
        reorderedAccents.getY(reorderedIndex),
        reorderedAccents.getZ(reorderedIndex),
        reorderedPhases.getX(reorderedIndex),
      ]);
    }

    const globalRenderables: Mesh[] = [];
    first.root.traverse((object) => {
      if (object instanceof Mesh) globalRenderables.push(object);
    });
    expect(globalRenderables.map(({ name }) => name).sort()).toEqual([
      'interior-portal:opaque-batch',
    ]);
    const partValues = new Set<number>();
    const portalPart = firstBatch.geometry.getAttribute('portalPart');
    for (let index = 0; index < portalPart.count; index += 1) {
      partValues.add(portalPart.getX(index));
    }
    expect([...partValues].sort()).toEqual([0, 1, 2]);
    expect(firstBatch.geometry.getAttribute('portalBeacon')).toBeUndefined();
    expect(firstBatch.userData.componentNames).toEqual([
      'door',
      'frame-left',
      'frame-right',
      'frame-top',
      'sign',
      'awning',
    ]);

    first.dispose();
    reordered.dispose();
  });

  it('pulses only the facade sign shader while all entrance geometry stays fixed', () => {
    const visual = new InteriorPortalVisual();
    const portalId = AUTHORED_INTERIORS[0]?.portal.id;
    expect(portalId).toBeDefined();
    const portal = visual.root.getObjectByName(`interior-portal:${portalId}`) as Group;
    const batch = opaqueBatchFor(visual);
    const uniforms = batch.material.userData.portalUniforms as {
      readonly elapsed: { value: number };
      readonly reducedMotion: { value: number };
    };
    const initialMatrix = portal.matrix.clone();

    visual.update(0, false);
    expect(uniforms).toMatchObject({
      elapsed: { value: 0 },
      reducedMotion: { value: 0 },
    });
    visual.update(1, false);
    expect(uniforms.elapsed.value).toBe(1);
    expect(portal.matrix).toEqual(initialMatrix);

    visual.update(500, true);
    expect(uniforms).toMatchObject({
      elapsed: { value: 500 },
      reducedMotion: { value: 1 },
    });
    expect(portal.matrix).toEqual(initialMatrix);
    expect(() => visual.update(Number.NaN)).toThrow(/time must be finite/i);

    visual.dispose();
  });

  it('toggles the entire layer and disposes owned GPU resources exactly once', () => {
    const parent = new Group();
    const visual = new InteriorPortalVisual();
    parent.add(visual.root);
    visual.setVisible(false);
    expect(visual.root.visible).toBe(false);
    visual.setVisible(true);
    expect(visual.root.visible).toBe(true);
    const resident = AUTHORED_INTERIORS[0]?.portal.cellId;
    expect(resident).toBeDefined();
    visual.setResidentCellIds(resident ? [resident] : []);
    const portalGroups = visual.root.children.filter((object) => object instanceof Group);
    expect(portalGroups.filter((portal) => portal.visible)).toHaveLength(1);
    const visibleMeshes: Mesh[] = [];
    visual.root.traverse((object) => {
      if (object instanceof Mesh) visibleMeshes.push(object);
    });
    expect(visibleMeshes).toHaveLength(1);
    expect(visibleMeshes.every(({ visible }) => visible)).toBe(true);
    visual.setResidentCellIds([]);
    expect(visibleMeshes.every(({ visible }) => !visible)).toBe(true);
    visual.setResidentCellIds(resident ? [resident] : []);

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
      if (object.customDepthMaterial) {
        materials.add(object.customDepthMaterial);
      }
    });
    let disposeEvents = 0;
    const batchMeshes = visibleMeshes.filter(
      (mesh): mesh is InstancedMesh => mesh instanceof InstancedMesh,
    );
    const batchDisposeSpies = batchMeshes.map((mesh) => vi.spyOn(mesh, 'dispose'));
    for (const resource of [...geometries, ...materials]) {
      resource.addEventListener('dispose', () => {
        disposeEvents += 1;
      });
    }

    visual.dispose();
    visual.dispose();
    visual.update(12);
    visual.setVisible(true);

    expect(visual.disposed).toBe(true);
    expect(disposeEvents).toBe(geometries.size + materials.size);
    expect(batchDisposeSpies.every((spy) => spy.mock.calls.length === 1)).toBe(true);
    expect(visual.root.parent).toBeNull();
    expect(visual.root.children).toHaveLength(0);
    expect(visual.root.visible).toBe(false);
  });
});
