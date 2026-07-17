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
  it('creates one deterministic low-poly cue at every authored exterior portal', () => {
    const first = new InteriorPortalVisual();
    const reordered = new InteriorPortalVisual([...AUTHORED_INTERIORS].reverse());

    expect(first.root.name).toBe('interior-portal-visuals');
    expect(first.root.children).toHaveLength(AUTHORED_INTERIORS.length + 2);
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
        definition.portal.position.x,
        definition.portal.position.y + 0.015,
        definition.portal.position.z,
      ]);
      expect(portal?.rotation.y).toBe(definition.portal.safeExteriorTransform.heading);
      expect(first.root.getObjectByName(`${portalName}:door`)).toBeInstanceOf(Object3D);
      expect(first.root.getObjectByName(`${portalName}:beacon`)).toBeInstanceOf(Object3D);
      expect(first.root.getObjectByName(`${portalName}:halo`)).toBeInstanceOf(Object3D);

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
      'interior-portal:halo-batch',
      'interior-portal:opaque-batch',
    ]);
    const partValues = new Set<number>();
    const portalPart = firstBatch.geometry.getAttribute('portalPart');
    const portalBeacon = firstBatch.geometry.getAttribute('portalBeacon');
    let beaconVertices = 0;
    for (let index = 0; index < portalPart.count; index += 1) {
      partValues.add(portalPart.getX(index));
      beaconVertices += portalBeacon.getX(index);
    }
    expect([...partValues].sort()).toEqual([0, 1, 2]);
    expect(beaconVertices).toBeGreaterThan(0);
    expect(beaconVertices).toBeLessThan(portalPart.count);

    first.dispose();
    reordered.dispose();
  });

  it('pulses emissive cues while reduced motion settles to a time-independent pose', () => {
    const visual = new InteriorPortalVisual();
    const portalId = AUTHORED_INTERIORS[0]?.portal.id;
    expect(portalId).toBeDefined();
    const beaconName = `interior-portal:${portalId}:beacon`;
    const haloName = `interior-portal:${portalId}:halo`;
    const beacon = visual.root.getObjectByName(beaconName) as Object3D;
    const halo = visual.root.getObjectByName(haloName) as Object3D;

    visual.update(0, false);
    const animatedStart = {
      intensity: beacon.userData.emissiveIntensity,
      opacity: halo.userData.opacity,
      y: beacon.position.y,
      rotationY: beacon.rotation.y,
    };
    visual.update(1, false);
    expect({
      intensity: beacon.userData.emissiveIntensity,
      opacity: halo.userData.opacity,
      y: beacon.position.y,
      rotationY: beacon.rotation.y,
    }).not.toEqual(animatedStart);

    visual.update(0, true);
    const reducedStart = {
      intensity: beacon.userData.emissiveIntensity,
      opacity: halo.userData.opacity,
      y: beacon.position.y,
      rotationY: beacon.rotation.y,
      haloScale: halo.scale.x,
    };
    visual.update(500, true);
    expect({
      intensity: beacon.userData.emissiveIntensity,
      opacity: halo.userData.opacity,
      y: beacon.position.y,
      rotationY: beacon.rotation.y,
      haloScale: halo.scale.x,
    }).toEqual(reducedStart);
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
    expect(visibleMeshes).toHaveLength(2);
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
