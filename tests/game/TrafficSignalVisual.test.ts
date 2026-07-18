import {
  Color,
  InstancedMesh,
  Matrix4,
  Vector3,
} from 'three';
import type { Material } from 'three';
import { describe, expect, it, vi } from 'vitest';

import {
  TrafficSignalVisual,
  type TrafficSignalVisualSnapshot,
} from '../../src/game/TrafficSignalVisual';

const signal = (
  id: string,
  x: number,
  z: number,
  horizontalAspect: TrafficSignalVisualSnapshot['horizontalAspect'] = 'green',
  verticalAspect: TrafficSignalVisualSnapshot['verticalAspect'] = 'red',
): TrafficSignalVisualSnapshot => ({
  id,
  position: { x, y: 0, z },
  horizontalAspect,
  verticalAspect,
});

function layer(visual: TrafficSignalVisual, name: string): InstancedMesh {
  const match = visual.root.getObjectByName(name);
  if (!(match instanceof InstancedMesh)) {
    throw new Error(`Missing signal layer ${name}`);
  }
  return match;
}

function renderedTriangles(visual: TrafficSignalVisual): number {
  let triangles = 0;
  visual.root.traverse((object) => {
    if (!(object instanceof InstancedMesh)) return;
    const geometryTriangles = object.geometry.index
      ? object.geometry.index.count / 3
      : object.geometry.getAttribute('position').count / 3;
    triangles += geometryTriangles * object.count;
  });
  return triangles;
}

describe('TrafficSignalVisual', () => {
  it('creates four bounded high-quality layers and no per-signal objects', () => {
    const visual = new TrafficSignalVisual(2, 'high');
    const poles = layer(visual, 'traffic-signal-poles');
    const heads = layer(visual, 'traffic-signal-heads');
    const stopBars = layer(visual, 'traffic-signal-stop-bars');
    const lenses = layer(visual, 'traffic-signal-lenses');

    expect(visual.object).toBe(visual.root);
    expect(visual.root.name).toBe('traffic-signal-visual');
    expect(visual.root.children).toEqual([poles, heads, stopBars, lenses]);
    expect(visual.root.visible).toBe(false);
    expect(poles.instanceMatrix.count).toBe(8);
    expect(heads.instanceMatrix.count).toBe(8);
    expect(stopBars.instanceMatrix.count).toBe(8);
    expect(lenses.instanceMatrix.count).toBe(24);
    expect([poles.count, heads.count, stopBars.count, lenses.count])
      .toEqual([0, 0, 0, 0]);
    expect([
      poles.frustumCulled,
      heads.frustumCulled,
      stopBars.frustumCulled,
      lenses.frustumCulled,
    ]).toEqual([false, false, false, false]);
    expect([
      poles.castShadow,
      heads.castShadow,
      stopBars.castShadow,
      lenses.castShadow,
    ]).toEqual([true, true, false, false]);
    for (const mesh of [poles, heads, stopBars, lenses]) {
      expect(mesh.geometry.boundingBox).not.toBeNull();
      expect(mesh.geometry.boundingSphere).not.toBeNull();
    }
    visual.update([signal('surface-check', 0, 0)]);
    const stopBarMatrix = new Matrix4();
    const stopBarPosition = new Vector3();
    stopBars.getMatrixAt(0, stopBarMatrix);
    stopBarPosition.setFromMatrixPosition(stopBarMatrix);
    expect(stopBarPosition.y).toBeCloseTo(0.115, 5);
    visual.dispose();
  });

  it('shows four roadside heads per intersection with live axis phases', () => {
    const visual = new TrafficSignalVisual(2, 'low');
    visual.update([
      signal('b', 100, 200, 'red', 'green'),
      signal('a', 10, 20, 'green', 'red'),
    ]);
    const structures = layer(visual, 'traffic-signal-structures');

    expect(visual.root.visible).toBe(true);
    expect(visual.root.children).toEqual([structures]);
    expect(structures.count).toBe(2);
    expect(structures.castShadow).toBe(false);
    expect(structures.geometry.getAttribute('color')).toBeDefined();
    expect(structures.geometry.boundingBox?.min.x).toBeCloseTo(-11.57, 2);
    expect(structures.geometry.boundingBox?.max.x).toBeCloseTo(11.57, 2);
    expect(structures.geometry.boundingBox?.min.z).toBeCloseTo(-11.57, 2);
    expect(structures.geometry.boundingBox?.max.z).toBeCloseTo(11.57, 2);
    expect(structures.geometry.boundingBox?.max.y).toBeGreaterThan(4.9);

    const positions = structures.geometry.getAttribute('position');
    const colors = structures.geometry.getAttribute('color');
    const stopBarColor = new Color(0xe8eee9);
    let stopBarVertexCount = 0;
    for (let vertexIndex = 0; vertexIndex < colors.count; vertexIndex += 1) {
      if (
        Math.abs(colors.getX(vertexIndex) - stopBarColor.r) < 0.000001
        && Math.abs(colors.getY(vertexIndex) - stopBarColor.g) < 0.000001
        && Math.abs(colors.getZ(vertexIndex) - stopBarColor.b) < 0.000001
      ) {
        stopBarVertexCount += 1;
        expect(positions.getY(vertexIndex)).toBeCloseTo(0.115, 5);
      }
    }
    expect(stopBarVertexCount).toBe(16);

    const matrix = new Matrix4();
    const position = new Vector3();
    structures.getMatrixAt(0, matrix);
    position.setFromMatrixPosition(matrix);
    expect(position.x).toBe(10);
    expect(position.y).toBe(0);
    expect(position.z).toBe(20);

    const signalLenses = structures.geometry.getAttribute('signalLens');
    const roleCounts = new Map<string, number>();
    for (let vertexIndex = 0; vertexIndex < signalLenses.count; vertexIndex += 1) {
      const role = `${signalLenses.getX(vertexIndex)}:${signalLenses.getY(vertexIndex)}`;
      roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    }
    expect(roleCounts.get('-1:-1')).toBe(64);
    for (const axis of [0, 1]) {
      for (const phase of [0, 1, 2]) {
        expect(roleCounts.get(`${axis}:${phase}`)).toBe(10);
      }
    }

    const instancePhases = structures.geometry.getAttribute(
      'instanceSignalPhases',
    );
    expect(instancePhases.itemSize).toBe(2);
    expect(instancePhases.count).toBe(2);
    expect([...instancePhases.array]).toEqual([2, 0, 0, 2]);

    const shader = {
      vertexShader: '#include <common>\n#include <color_vertex>',
      fragmentShader: '',
      uniforms: {},
    };
    const material = structures.material;
    if (Array.isArray(material)) {
      throw new Error('Low signal visual must use one material');
    }
    material.onBeforeCompile(
      shader as unknown as Parameters<typeof material.onBeforeCompile>[0],
      null as never,
    );
    expect(shader.vertexShader).toContain('attribute vec2 signalLens');
    expect(shader.vertexShader).toContain('attribute vec2 instanceSignalPhases');
    expect(shader.vertexShader).toContain('activeSignalColor');
    expect(shader.vertexShader).toContain('inactiveSignalColor');
    expect(shader.vertexShader).toContain(
      'mix( inactiveSignalColor, activeSignalColor, signalIsActive )',
    );
    expect(material.customProgramCacheKey())
      .toBe('traffic-signal-low-one-draw-v1');
    visual.dispose();
  });

  it('reduces the low-quality path to one draw and 76 triangles per signal', () => {
    const high = new TrafficSignalVisual(1, 'high');
    const low = new TrafficSignalVisual(1, 'low');
    high.update([signal('one', 0, 0)]);
    low.update([signal('one', 0, 0)]);

    expect(high.root.children).toHaveLength(4);
    expect(low.root.children).toHaveLength(1);
    expect(renderedTriangles(high)).toBe(392);
    expect(renderedTriangles(low)).toBe(76);
    expect(renderedTriangles(low)).toBeLessThan(renderedTriangles(high) / 5);

    high.dispose();
    low.dispose();
  });

  it('keeps buffers and child objects stable across deterministic phase updates', () => {
    const visual = new TrafficSignalVisual(3, 'high');
    const poles = layer(visual, 'traffic-signal-poles');
    const stopBars = layer(visual, 'traffic-signal-stop-bars');
    const lenses = layer(visual, 'traffic-signal-lenses');
    const children = [...visual.root.children];
    const matrixBuffer = poles.instanceMatrix.array;
    const stopBarBuffer = stopBars.instanceMatrix.array;
    const colorBuffer = lenses.instanceColor?.array;

    visual.update([
      signal('north', 0, 100),
      signal('south', 0, -100),
    ]);
    const firstMatrices = [...poles.instanceMatrix.array];
    const firstColors = [...(lenses.instanceColor?.array ?? [])];

    visual.update([
      signal('south', 0, -100),
      signal('north', 0, 100),
    ]);
    expect([...poles.instanceMatrix.array]).toEqual(firstMatrices);
    expect([...(lenses.instanceColor?.array ?? [])]).toEqual(firstColors);
    expect(visual.root.children).toEqual(children);
    expect(poles.instanceMatrix.array).toBe(matrixBuffer);
    expect(stopBars.instanceMatrix.array).toBe(stopBarBuffer);
    expect(lenses.instanceColor?.array).toBe(colorBuffer);

    visual.update([
      signal('south', 0, -100, 'yellow', 'red'),
      signal('north', 0, 100, 'yellow', 'red'),
    ]);
    expect(poles.instanceMatrix.array).toBe(matrixBuffer);
    expect(stopBars.instanceMatrix.array).toBe(stopBarBuffer);
    expect(lenses.instanceColor?.array).toBe(colorBuffer);
    visual.dispose();
  });

  it('keeps low-quality matrix and phase buffers stable across updates', () => {
    const visual = new TrafficSignalVisual(3, 'low');
    const structures = layer(visual, 'traffic-signal-structures');
    const phases = structures.geometry.getAttribute('instanceSignalPhases');
    const children = [...visual.root.children];
    const structureBuffer = structures.instanceMatrix.array;
    const phaseBuffer = phases.array;

    visual.update([
      signal('north', 0, 100),
      signal('south', 0, -100),
    ]);
    const firstStructureMatrices = [...structures.instanceMatrix.array];
    const firstPhases = [...phases.array];

    visual.update([
      signal('south', 0, -100),
      signal('north', 0, 100),
    ]);
    expect([...structures.instanceMatrix.array]).toEqual(firstStructureMatrices);
    expect([...phases.array]).toEqual(firstPhases);
    expect(visual.root.children).toEqual(children);
    expect(structures.instanceMatrix.array).toBe(structureBuffer);
    expect(phases.array).toBe(phaseBuffer);

    visual.update([
      signal('south', 0, -100, 'yellow', 'red'),
      signal('north', 0, 100, 'yellow', 'red'),
    ]);
    expect(structures.instanceMatrix.array).toBe(structureBuffer);
    expect(phases.array).toBe(phaseBuffer);
    expect([...phases.array].slice(0, 4)).toEqual([1, 0, 1, 0]);
    visual.dispose();
  });

  it('deduplicates, sorts and caps updates at its construction capacity', () => {
    const visual = new TrafficSignalVisual(2, 'high');
    visual.update([
      signal('c', 300, 0),
      signal('a', 100, 0),
      signal('b', 200, 0),
      signal('a', 100, 0),
    ]);
    expect(layer(visual, 'traffic-signal-poles').count).toBe(8);
    expect(layer(visual, 'traffic-signal-heads').count).toBe(8);
    expect(layer(visual, 'traffic-signal-stop-bars').count).toBe(8);
    expect(layer(visual, 'traffic-signal-lenses').count).toBe(24);

    visual.update([]);
    expect(visual.root.visible).toBe(false);
    expect(layer(visual, 'traffic-signal-poles').count).toBe(0);
    visual.dispose();
  });

  it('disposes shared resources once and rejects later updates', () => {
    expect(() => new TrafficSignalVisual(0, 'low')).toThrow(/positive integer/);
    expect(() => new TrafficSignalVisual(1.5, 'high')).toThrow(/positive integer/);

    const visual = new TrafficSignalVisual(1, 'high');
    const poles = layer(visual, 'traffic-signal-poles');
    const heads = layer(visual, 'traffic-signal-heads');
    const stopBars = layer(visual, 'traffic-signal-stop-bars');
    const lenses = layer(visual, 'traffic-signal-lenses');
    const geometrySpies = [poles, heads, stopBars, lenses].map((mesh) =>
      vi.spyOn(mesh.geometry, 'dispose')
    );
    const materialSpies = [poles, heads, stopBars, lenses].map((mesh) =>
      vi.spyOn(mesh.material as Material, 'dispose')
    );

    visual.update([signal('only', 0, 0)]);
    visual.dispose();
    visual.dispose();
    expect(visual.disposed).toBe(true);
    expect(visual.root.children).toHaveLength(0);
    expect(visual.root.visible).toBe(false);
    for (const spy of [...geometrySpies, ...materialSpies]) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
    expect(() => visual.update([])).toThrow(/disposed/);
  });
});
