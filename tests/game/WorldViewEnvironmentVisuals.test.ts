import {
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  InstancedMesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Scene,
} from 'three';
import { describe, expect, it } from 'vitest';

import { generateCity } from '../../src/game/city';
import { WorldView } from '../../src/game/WorldView';
import { createCityVisuals } from '../../src/game/visuals';
import { cellIdAt } from '../../src/navigation/cells';

interface EnvironmentVisualHarness {
  readonly scene: Scene;
  readonly fog: FogExp2;
  readonly hemisphereLight: HemisphereLight;
  readonly sunLight: DirectionalLight;
  readonly environment: {
    timeOfDay: number;
    rainIntensity: number;
  };
  readonly cityVisuals: {
    readonly buildingMaterials: readonly MeshStandardMaterial[];
    readonly roadMaterial: MeshStandardMaterial | MeshLambertMaterial;
    readonly setRoadColor: (color: Readonly<Color>) => void;
  };
  applyEnvironmentVisuals(): void;
}

function createHarness(
  roadMaterial: MeshStandardMaterial | MeshLambertMaterial,
  setRoadColor: (color: Readonly<Color>) => void = () => undefined,
): EnvironmentVisualHarness {
  const harness = Object.create(WorldView.prototype) as unknown as EnvironmentVisualHarness;
  Object.assign(harness, {
    scene: new Scene(),
    fog: new FogExp2(0xffffff, 0.001),
    hemisphereLight: new HemisphereLight(),
    sunLight: new DirectionalLight(),
    environment: {
      timeOfDay: 0.5,
      rainIntensity: 0,
    },
    cityVisuals: {
      buildingMaterials: [new MeshStandardMaterial()],
      roadMaterial,
      setRoadColor,
    },
  });
  harness.scene.background = new Color();
  return harness;
}

describe('WorldView authored road rain feedback', () => {
  it('darkens and exactly restores the low Lambert road color without replacing it', () => {
    const roadMaterial = new MeshLambertMaterial({ color: 0x26313b });
    const harness = createHarness(roadMaterial);
    const stableColor = roadMaterial.color;
    const dry = roadMaterial.color.clone();

    harness.environment.rainIntensity = 1;
    harness.applyEnvironmentVisuals();
    const wet = roadMaterial.color.clone();
    expect(wet.r).toBeLessThan(dry.r);
    expect(wet.g).toBeLessThan(dry.g);
    expect(wet.b).toBeLessThan(dry.b);
    expect(roadMaterial.color).toBe(stableColor);

    harness.environment.rainIntensity = 0.5;
    harness.applyEnvironmentVisuals();
    const firstMidpoint = roadMaterial.color.toArray();
    harness.environment.rainIntensity = 0.5;
    harness.applyEnvironmentVisuals();
    expect(roadMaterial.color.toArray()).toEqual(firstMidpoint);

    harness.environment.rainIntensity = 0;
    harness.applyEnvironmentVisuals();
    expect(roadMaterial.color.getHex()).toBe(0x26313b);
    expect(roadMaterial.color).toBe(stableColor);
  });

  it('updates only the unified low road color span through rain and exact restore', () => {
    const layout = generateCity('world-view-unified-road-rain', 'low');
    const visuals = createCityVisuals(layout, { supportsMultiDraw: true });
    const harness = createHarness(
      visuals.roadMaterial,
      visuals.setRoadColor,
    );
    const carrier = visuals.root.getObjectByName('city-roads');
    expect(carrier).toBeInstanceOf(InstancedMesh);
    if (!(carrier instanceof InstancedMesh)) {
      throw new Error('Expected the unified low road carrier');
    }
    const roadStartIndex = 0;
    const color = new Color();
    const groundStartIndex = layout.roads.length * 3;
    carrier.getColorAt(groundStartIndex, color);
    const stableGroundColor = color.getHex();

    harness.environment.rainIntensity = 1;
    harness.applyEnvironmentVisuals();
    expect(visuals.roadMaterial.color.getHex()).toBe(0x141c24);
    layout.roads.forEach((_road, index) => {
      carrier.getColorAt(roadStartIndex + index, color);
      expect(color.getHex()).toBe(0x141c24);
    });
    carrier.getColorAt(groundStartIndex, color);
    expect(color.getHex()).toBe(stableGroundColor);

    const activeCellId = cellIdAt(layout.buildings[0]!.position);
    const streamed = visuals.applyStreamingState(
      [activeCellId],
      [activeCellId],
      {
        roads: 1,
        structures: 1,
        props: 1,
        actors: 1,
        shadows: 1,
      },
    );
    expect(streamed.structures.visible).toBeGreaterThan(0);
    const streamedRoadStartIndex = 0;
    expect(carrier.userData.roadStartIndex).toBe(streamedRoadStartIndex);
    layout.roads.forEach((_road, index) => {
      carrier.getColorAt(streamedRoadStartIndex + index, color);
      expect(color.getHex()).toBe(0x141c24);
    });
    carrier.getColorAt(groundStartIndex, color);
    expect(color.getHex()).toBe(stableGroundColor);

    harness.environment.rainIntensity = 0;
    harness.applyEnvironmentVisuals();
    expect(visuals.roadMaterial.color.getHex()).toBe(0x26313b);
    layout.roads.forEach((_road, index) => {
      carrier.getColorAt(streamedRoadStartIndex + index, color);
      expect(color.getHex()).toBe(0x26313b);
    });
    carrier.getColorAt(groundStartIndex, color);
    expect(color.getHex()).toBe(stableGroundColor);

    visuals.dispose();
  });

  it('retains the authored high Standard roughness and metalness rain response', () => {
    const roadMaterial = new MeshStandardMaterial({
      color: 0x26313b,
      roughness: 0.82,
      metalness: 0.05,
    });
    const harness = createHarness(roadMaterial);

    harness.environment.rainIntensity = 0.75;
    harness.applyEnvironmentVisuals();
    expect(roadMaterial.roughness).toBeCloseTo(0.505, 6);
    expect(roadMaterial.metalness).toBeCloseTo(0.23, 6);
    expect(roadMaterial.color.getHex()).toBe(0x26313b);

    harness.environment.rainIntensity = 0;
    harness.applyEnvironmentVisuals();
    expect(roadMaterial.roughness).toBe(0.82);
    expect(roadMaterial.metalness).toBe(0.05);
  });
});
