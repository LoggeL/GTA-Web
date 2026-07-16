import type { WorldInputState } from '../game';

export class TouchInput {
  readonly #stick: HTMLElement;
  readonly #knob: HTMLElement;
  readonly #camera: HTMLElement;
  readonly #onInput: (input: Partial<WorldInputState>) => void;
  #stickPointer: number | null = null;
  #cameraPointer: number | null = null;
  #cameraX = 0;
  #cameraY = 0;

  constructor(root: HTMLElement, onInput: (input: Partial<WorldInputState>) => void) {
    const stick = root.querySelector<HTMLElement>('[data-touch-stick]');
    const knob = stick?.querySelector<HTMLElement>('span');
    const camera = root.querySelector<HTMLElement>('[data-touch-camera]');
    if (!stick || !knob || !camera) throw new Error('Touch input elements are missing');
    this.#stick = stick;
    this.#knob = knob;
    this.#camera = camera;
    this.#onInput = onInput;
    this.#bind();
  }

  destroy(): void {
    this.#stick.removeEventListener('pointerdown', this.#onStickDown);
    this.#stick.removeEventListener('pointermove', this.#onStickMove);
    this.#stick.removeEventListener('pointerup', this.#onStickUp);
    this.#stick.removeEventListener('pointercancel', this.#onStickUp);
    this.#camera.removeEventListener('pointerdown', this.#onCameraDown);
    this.#camera.removeEventListener('pointermove', this.#onCameraMove);
    this.#camera.removeEventListener('pointerup', this.#onCameraUp);
    this.#camera.removeEventListener('pointercancel', this.#onCameraUp);
  }

  #bind(): void {
    this.#stick.addEventListener('pointerdown', this.#onStickDown);
    this.#stick.addEventListener('pointermove', this.#onStickMove);
    this.#stick.addEventListener('pointerup', this.#onStickUp);
    this.#stick.addEventListener('pointercancel', this.#onStickUp);
    this.#camera.addEventListener('pointerdown', this.#onCameraDown);
    this.#camera.addEventListener('pointermove', this.#onCameraMove);
    this.#camera.addEventListener('pointerup', this.#onCameraUp);
    this.#camera.addEventListener('pointercancel', this.#onCameraUp);
  }

  readonly #onStickDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.#stickPointer = event.pointerId;
    this.#stick.setPointerCapture(event.pointerId);
    this.#updateStick(event);
  };

  readonly #onStickMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.#stickPointer) return;
    event.preventDefault();
    this.#updateStick(event);
  };

  readonly #onStickUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.#stickPointer) return;
    event.preventDefault();
    this.#stickPointer = null;
    this.#knob.style.transform = 'translate(-50%, -50%)';
    this.#onInput({ moveForward: 0, moveRight: 0 });
  };

  readonly #onCameraDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.#cameraPointer = event.pointerId;
    this.#cameraX = event.clientX;
    this.#cameraY = event.clientY;
    this.#camera.setPointerCapture(event.pointerId);
  };

  readonly #onCameraMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.#cameraPointer) return;
    event.preventDefault();
    const deltaX = event.clientX - this.#cameraX;
    const deltaY = event.clientY - this.#cameraY;
    this.#cameraX = event.clientX;
    this.#cameraY = event.clientY;
    this.#onInput({ cameraYawDelta: -deltaX * 0.006, cameraPitchDelta: -deltaY * 0.006 });
  };

  readonly #onCameraUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.#cameraPointer) return;
    event.preventDefault();
    this.#cameraPointer = null;
  };

  #updateStick(event: PointerEvent): void {
    const rect = this.#stick.getBoundingClientRect();
    const radius = Math.max(1, Math.min(rect.width, rect.height) * 0.36);
    const rawX = event.clientX - (rect.left + rect.width / 2);
    const rawY = event.clientY - (rect.top + rect.height / 2);
    const length = Math.hypot(rawX, rawY);
    const scale = length > radius ? radius / length : 1;
    const x = rawX * scale;
    const y = rawY * scale;
    this.#knob.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
    this.#onInput({ moveRight: x / radius, moveForward: -y / radius });
  }
}
