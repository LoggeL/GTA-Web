import { CITY_HALF_SIZE, DISTRICTS, generateCity } from '../game/city';
import type { CityLayout } from '../game/city';
import type { WorldSnapshot } from '../game/types';

export interface MinimapOptions {
  seed?: number | string;
  visibleRadius?: number;
}

const DISTRICT_COLORS = new Map(DISTRICTS.map((district) => [district.id, district.groundColor]));

export class MinimapRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  readonly #layout: CityLayout;
  readonly #radius: number;

  constructor(canvas: HTMLCanvasElement, options: MinimapOptions = {}) {
    this.#canvas = canvas;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D canvas is unavailable');
    this.#context = context;
    this.#layout = generateCity(options.seed ?? 'heatline-solara-v1', 'low');
    this.#radius = options.visibleRadius ?? 175;
  }

  resize(): void {
    const rect = this.#canvas.getBoundingClientRect();
    const pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * pixelRatio));
    const height = Math.max(1, Math.round(rect.height * pixelRatio));
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }
  }

  draw(snapshot: WorldSnapshot): void {
    this.resize();
    const { width, height } = this.#canvas;
    const context = this.#context;
    const scale = Math.min(width, height) / (this.#radius * 2);
    context.clearRect(0, 0, width, height);
    context.save();
    context.translate(width / 2, height / 2);
    context.rotate(snapshot.heading);
    context.scale(scale, scale);
    context.translate(-snapshot.position.x, -snapshot.position.z);

    for (const district of DISTRICTS) {
      context.fillStyle = `#${(DISTRICT_COLORS.get(district.id) ?? 0x18333e).toString(16).padStart(6, '0')}`;
      context.fillRect(district.minX, district.minZ, district.maxX - district.minX, district.maxZ - district.minZ);
    }

    context.fillStyle = '#25313a';
    for (const road of this.#layout.roads) {
      context.fillRect(
        road.position.x - road.width / 2,
        road.position.z - road.depth / 2,
        road.width,
        road.depth,
      );
    }

    context.fillStyle = 'rgba(4, 12, 17, 0.62)';
    for (const building of this.#layout.buildings) {
      context.fillRect(
        building.position.x - building.width / 2,
        building.position.z - building.depth / 2,
        building.width,
        building.depth,
      );
    }

    context.strokeStyle = 'rgba(255, 213, 106, 0.82)';
    context.lineWidth = 1 / scale;
    context.beginPath();
    context.moveTo(-CITY_HALF_SIZE, 0);
    context.lineTo(CITY_HALF_SIZE, 0);
    context.moveTo(0, -CITY_HALF_SIZE);
    context.lineTo(0, CITY_HALF_SIZE);
    context.stroke();
    context.restore();

    const gradient = context.createRadialGradient(width / 2, height / 2, height * 0.28, width / 2, height / 2, height * 0.52);
    gradient.addColorStop(0, 'rgba(7, 18, 27, 0)');
    gradient.addColorStop(1, 'rgba(7, 18, 27, 0.66)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
  }
}
