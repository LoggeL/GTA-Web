import {
  Group,
  Mesh,
  MeshStandardMaterial,
} from 'three';
import type {
  BufferGeometry,
  Material,
  MeshBasicMaterial,
} from 'three';
import { describe, expect, it } from 'vitest';

import { AUTHORED_INTERIORS } from '../../src/game/InteriorRuntime';
import { InteriorPortalVisual } from '../../src/game/InteriorPortalVisual';

function standardMaterialFor(
  visual: InteriorPortalVisual,
  name: string,
): MeshStandardMaterial {
  const object = visual.root.getObjectByName(name);
  expect(object).toBeInstanceOf(Mesh);
  const material = (object as Mesh).material;
  expect(material).toBeInstanceOf(MeshStandardMaterial);
  return material as MeshStandardMaterial;
}

describe('InteriorPortalVisual', () => {
  it('creates one deterministic low-poly cue at every authored exterior portal', () => {
    const first = new InteriorPortalVisual();
    const reordered = new InteriorPortalVisual([...AUTHORED_INTERIORS].reverse());

    expect(first.root.name).toBe('interior-portal-visuals');
    expect(first.root.children).toHaveLength(AUTHORED_INTERIORS.length);
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
      expect(first.root.getObjectByName(`${portalName}:door`)).toBeInstanceOf(Mesh);
      expect(first.root.getObjectByName(`${portalName}:beacon`)).toBeInstanceOf(Mesh);
      expect(first.root.getObjectByName(`${portalName}:halo`)).toBeInstanceOf(Mesh);

      const firstAccent = standardMaterialFor(first, `${portalName}:beacon`);
      const reorderedAccent = standardMaterialFor(reordered, `${portalName}:beacon`);
      expect(firstAccent.color.getHex()).toBe(reorderedAccent.color.getHex());
      expect(firstAccent.emissive.getHex()).toBe(firstAccent.color.getHex());
    }

    first.dispose();
    reordered.dispose();
  });

  it('pulses emissive cues while reduced motion settles to a time-independent pose', () => {
    const visual = new InteriorPortalVisual();
    const portalId = AUTHORED_INTERIORS[0]?.portal.id;
    expect(portalId).toBeDefined();
    const beaconName = `interior-portal:${portalId}:beacon`;
    const haloName = `interior-portal:${portalId}:halo`;
    const beacon = visual.root.getObjectByName(beaconName) as Mesh;
    const halo = visual.root.getObjectByName(haloName) as Mesh;
    const beaconMaterial = beacon.material as MeshStandardMaterial;
    const haloMaterial = halo.material as MeshBasicMaterial;

    visual.update(0, false);
    const animatedStart = {
      intensity: beaconMaterial.emissiveIntensity,
      opacity: haloMaterial.opacity,
      y: beacon.position.y,
      rotationY: beacon.rotation.y,
    };
    visual.update(1, false);
    expect({
      intensity: beaconMaterial.emissiveIntensity,
      opacity: haloMaterial.opacity,
      y: beacon.position.y,
      rotationY: beacon.rotation.y,
    }).not.toEqual(animatedStart);

    visual.update(0, true);
    const reducedStart = {
      intensity: beaconMaterial.emissiveIntensity,
      opacity: haloMaterial.opacity,
      y: beacon.position.y,
      rotationY: beacon.rotation.y,
      haloScale: halo.scale.x,
    };
    visual.update(500, true);
    expect({
      intensity: beaconMaterial.emissiveIntensity,
      opacity: haloMaterial.opacity,
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
    expect(visual.root.children.filter((portal) => portal.visible)).toHaveLength(1);

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
    let disposeEvents = 0;
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
    expect(visual.root.parent).toBeNull();
    expect(visual.root.children).toHaveLength(0);
    expect(visual.root.visible).toBe(false);
  });
});
