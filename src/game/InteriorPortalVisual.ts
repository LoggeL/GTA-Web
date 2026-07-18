import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshDepthMaterial,
  MeshStandardMaterial,
  Object3D,
} from 'three';
import type {
  BufferGeometry,
  Material,
  WebGLProgramParametersWithUniforms,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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

const PORTAL_PART_FRAME = 0;
const PORTAL_PART_DOOR = 1;
const PORTAL_PART_ACCENT = 2;

interface PortalShaderUniforms {
  readonly elapsed: { value: number };
  readonly reducedMotion: { value: number };
  readonly frameColor: { value: Color };
  readonly doorColor: { value: Color };
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

function transformAt(
  position: readonly [number, number, number],
  scale: readonly [number, number, number] = [1, 1, 1],
): Matrix4 {
  const transform = new Matrix4().makeScale(...scale);
  transform.setPosition(...position);
  return transform;
}

function portalPartGeometry(
  source: BufferGeometry,
  transform: Matrix4,
  part: number,
): BufferGeometry {
  const geometry = source.index === null ? source.clone() : source.toNonIndexed();
  geometry.applyMatrix4(transform);
  const vertexCount = geometry.getAttribute('position').count;
  geometry.setAttribute(
    'portalPart',
    new Float32BufferAttribute(new Float32Array(vertexCount).fill(part), 1),
  );
  return geometry;
}

function createPortalCompositeGeometry(): BufferGeometry {
  const box = new BoxGeometry(1, 1, 1);
  const parts = [
    portalPartGeometry(
      box,
      transformAt([0, 1.34, 0.12], [1.72, 2.5, 0.16]),
      PORTAL_PART_DOOR,
    ),
    portalPartGeometry(
      box,
      transformAt([-0.98, 1.46, 0.14], [0.18, 2.92, 0.28]),
      PORTAL_PART_FRAME,
    ),
    portalPartGeometry(
      box,
      transformAt([0.98, 1.46, 0.14], [0.18, 2.92, 0.28]),
      PORTAL_PART_FRAME,
    ),
    portalPartGeometry(
      box,
      transformAt([0, 2.84, 0.14], [2.14, 0.18, 0.28]),
      PORTAL_PART_FRAME,
    ),
    portalPartGeometry(
      box,
      transformAt([0, 3.18, 0.12], [2.78, 0.58, 0.18]),
      PORTAL_PART_ACCENT,
    ),
    portalPartGeometry(
      box,
      transformAt([0, 2.82, 0.42], [2.48, 0.14, 0.86]),
      PORTAL_PART_ACCENT,
    ),
  ];
  const geometry = mergeGeometries(parts, false);
  parts.forEach((part) => part.dispose());
  box.dispose();
  if (!geometry) {
    throw new Error('Portal geometry batching failed');
  }
  geometry.name = 'interior-portal:opaque-composite';
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function addAnchor(
  parent: Group,
  name: string,
  position: readonly [number, number, number],
  scale: readonly [number, number, number] = [1, 1, 1],
): Object3D {
  const anchor = new Object3D();
  anchor.name = name;
  anchor.position.set(...position);
  anchor.scale.set(...scale);
  parent.add(anchor);
  return anchor;
}

function bindPortalUniforms(
  shader: WebGLProgramParametersWithUniforms,
  uniforms: PortalShaderUniforms,
): void {
  shader.uniforms.portalElapsed = uniforms.elapsed;
  shader.uniforms.portalReducedMotion = uniforms.reducedMotion;
  shader.uniforms.portalFrameColor = uniforms.frameColor;
  shader.uniforms.portalDoorColor = uniforms.doorColor;
}

const PORTAL_VERTEX_PARAMETERS = /* glsl */ `
attribute float portalPart;
attribute vec3 instancePortalAccent;
attribute float instancePortalPhase;
uniform float portalElapsed;
uniform float portalReducedMotion;
varying float vPortalPart;
varying vec3 vPortalAccent;
varying float vPortalPhase;
`;

const PORTAL_INSTANCE_POSITION = /* glsl */ `
#include <begin_vertex>
vPortalPart = portalPart;
vPortalAccent = instancePortalAccent;
vPortalPhase = instancePortalPhase;
`;

function configurePortalSurfaceMaterial(
  material: MeshStandardMaterial,
  uniforms: PortalShaderUniforms,
): void {
  material.onBeforeCompile = (shader) => {
    bindPortalUniforms(shader, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${PORTAL_VERTEX_PARAMETERS}`)
      .replace('#include <begin_vertex>', PORTAL_INSTANCE_POSITION);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float portalElapsed;
uniform float portalReducedMotion;
uniform vec3 portalFrameColor;
uniform vec3 portalDoorColor;
varying float vPortalPart;
varying vec3 vPortalAccent;
varying float vPortalPhase;`,
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec3 portalSurfaceColor = vPortalPart > 1.5
  ? vPortalAccent
  : ( vPortalPart > 0.5 ? portalDoorColor : portalFrameColor );
vec4 diffuseColor = vec4( portalSurfaceColor, opacity );`,
      )
      .replace(
        'vec3 totalEmissiveRadiance = emissive;',
        `float portalWave = portalReducedMotion > 0.5
  ? 0.5
  : ( sin( portalElapsed * 2.15 + vPortalPhase ) + 1.0 ) * 0.5;
float portalEmissiveIntensity = vPortalPart > 1.5
  ? 0.78 + portalWave * 1.18
  : ( vPortalPart > 0.5 ? 0.18 : 0.0 );
vec3 totalEmissiveRadiance = vPortalAccent * portalEmissiveIntensity;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = vPortalPart > 1.5 ? 0.32 : ( vPortalPart > 0.5 ? 0.58 : 0.72 );`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
metalnessFactor = vPortalPart > 1.5 ? 0.12 : ( vPortalPart > 0.5 ? 0.36 : 0.28 );`,
      )
      .replace(
        '#include <tonemapping_fragment>',
        `#if defined( TONE_MAPPING )
if ( vPortalPart < 1.5 ) {
  gl_FragColor.rgb = toneMapping( gl_FragColor.rgb );
}
#endif`,
      );
  };
  material.customProgramCacheKey = () => 'interior-facade-entrance-surface-v1';
  material.userData.portalUniforms = uniforms;
}

interface PortalInstanceAttributes {
  readonly accent: InstancedBufferAttribute;
  readonly phase: InstancedBufferAttribute;
}

function addPortalInstanceAttributes(
  geometry: BufferGeometry,
  count: number,
): PortalInstanceAttributes {
  const accent = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
  const phase = new InstancedBufferAttribute(new Float32Array(count), 1);
  geometry.setAttribute('instancePortalAccent', accent);
  geometry.setAttribute('instancePortalPhase', phase);
  return { accent, phase };
}

const HIDDEN_PORTAL_MATRIX = new Matrix4().makeScale(0, 0, 0);

/**
 * Batched facade-mounted entrances for authored interiors. The module owns every
 * GPU resource it creates; attach `root` to the world scene and call `dispose`
 * when that scene is torn down.
 */
export class InteriorPortalVisual {
  public readonly root = new Group();

  readonly #geometries = new Set<BufferGeometry>();
  readonly #materials = new Set<Material>();
  readonly #portalCells = new Map<Group, { readonly cellId: CellId; readonly index: number }>();
  readonly #uniforms: PortalShaderUniforms;
  readonly #surfaceBatch: InstancedMesh<BufferGeometry, MeshStandardMaterial>;
  #disposed = false;

  public constructor(
    definitions: readonly InteriorDefinition[] = AUTHORED_INTERIORS,
  ) {
    this.root.name = 'interior-portal-visuals';

    const compositeGeometry = createPortalCompositeGeometry();
    this.#geometries.add(compositeGeometry);

    const surfaceAttributes = addPortalInstanceAttributes(compositeGeometry, definitions.length);
    this.#uniforms = {
      elapsed: { value: 0 },
      reducedMotion: { value: 0 },
      frameColor: { value: new Color(0x263640) },
      doorColor: { value: new Color(0x14232d) },
    };
    const surfaceMaterial = new MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 1,
      roughness: 0.72,
      metalness: 0.28,
    });
    surfaceMaterial.name = 'interior-portal:surface-batch';
    configurePortalSurfaceMaterial(surfaceMaterial, this.#uniforms);
    const depthMaterial = new MeshDepthMaterial();
    depthMaterial.name = 'interior-portal:depth-batch';
    this.#materials.add(surfaceMaterial);
    this.#materials.add(depthMaterial);

    this.#surfaceBatch = new InstancedMesh(
      compositeGeometry,
      surfaceMaterial,
      definitions.length,
    );
    this.#surfaceBatch.name = 'interior-portal:opaque-batch';
    this.#surfaceBatch.castShadow = true;
    this.#surfaceBatch.receiveShadow = true;
    this.#surfaceBatch.customDepthMaterial = depthMaterial;
    this.#surfaceBatch.frustumCulled = false;
    this.#surfaceBatch.instanceMatrix.setUsage(DynamicDrawUsage);
    this.#surfaceBatch.userData.componentNames = [
      'door',
      'frame-left',
      'frame-right',
      'frame-top',
      'sign',
      'awning',
    ];
    this.root.add(this.#surfaceBatch);

    definitions.forEach((definition, index) => {
      const portalRoot = this.#createPortal(
        definition.portal,
        index,
        surfaceAttributes,
      );
      this.#portalCells.set(portalRoot, { cellId: definition.portal.cellId, index });
    });
    surfaceAttributes.accent.needsUpdate = true;
    surfaceAttributes.phase.needsUpdate = true;
    this.#syncBatches();
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
    for (const [portalRoot, { cellId }] of this.#portalCells) {
      portalRoot.visible = resident.has(cellId);
    }
    this.#syncBatches();
  }

  /** Updates the subtle facade-sign emissive pulse without moving geometry. */
  public update(elapsedSeconds: number, reducedMotion = false): void {
    if (this.#disposed) {
      return;
    }
    if (!Number.isFinite(elapsedSeconds)) {
      throw new RangeError('Portal visual time must be finite');
    }

    this.#uniforms.elapsed.value = elapsedSeconds;
    this.#uniforms.reducedMotion.value = reducedMotion ? 1 : 0;
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.root.removeFromParent();
    this.#surfaceBatch.dispose();
    for (const geometry of this.#geometries) {
      geometry.dispose();
    }
    for (const material of this.#materials) {
      material.dispose();
    }
    this.#geometries.clear();
    this.#materials.clear();
    this.#portalCells.clear();
    this.root.clear();
    this.root.visible = false;
  }

  #createPortal(
    portal: Readonly<InteriorPortalDefinition>,
    index: number,
    surfaceAttributes: PortalInstanceAttributes,
  ): Group {
    const portalRoot = new Group();
    portalRoot.name = `interior-portal:${portal.id}`;
    portalRoot.position.set(
      portal.attachment.position.x,
      portal.attachment.position.y + 0.015,
      portal.attachment.position.z,
    );
    portalRoot.rotation.y = portal.attachment.heading;
    portalRoot.userData.hostBuildingId = portal.attachment.hostBuildingId;

    const accent = accentFor(portal.id);
    const phase = phaseFor(portal.id);
    const accentColor = new Color(accent);
    surfaceAttributes.accent.setXYZ(index, accentColor.r, accentColor.g, accentColor.b);
    surfaceAttributes.phase.setX(index, phase);

    addAnchor(
      portalRoot,
      `interior-portal:${portal.id}:door`,
      [0, 1.34, 0.12],
      [1.64, 2.5, 0.16],
    );
    addAnchor(
      portalRoot,
      `interior-portal:${portal.id}:frame-left`,
      [-0.98, 1.46, 0.14],
      [0.18, 2.92, 0.28],
    );
    addAnchor(
      portalRoot,
      `interior-portal:${portal.id}:frame-right`,
      [0.98, 1.46, 0.14],
      [0.18, 2.92, 0.28],
    );
    addAnchor(
      portalRoot,
      `interior-portal:${portal.id}:frame-top`,
      [0, 2.84, 0.14],
      [2.14, 0.18, 0.28],
    );
    addAnchor(
      portalRoot,
      `interior-portal:${portal.id}:sign`,
      [0, 3.18, 0.12],
      [2.78, 0.58, 0.18],
    );
    addAnchor(
      portalRoot,
      `interior-portal:${portal.id}:awning`,
      [0, 2.82, 0.42],
      [2.48, 0.14, 0.86],
    );

    this.root.add(portalRoot);
    return portalRoot;
  }

  #syncBatches(): void {
    let anyVisible = false;
    for (const [portalRoot, { index }] of this.#portalCells) {
      if (portalRoot.visible) {
        portalRoot.updateMatrix();
        this.#surfaceBatch.setMatrixAt(index, portalRoot.matrix);
        anyVisible = true;
      } else {
        this.#surfaceBatch.setMatrixAt(index, HIDDEN_PORTAL_MATRIX);
      }
    }
    this.#surfaceBatch.visible = anyVisible;
    this.#surfaceBatch.instanceMatrix.needsUpdate = true;
  }
}
