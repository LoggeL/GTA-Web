import { createWorldInputState } from './types';
import type { WorldInputState } from './types';

const GAME_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ShiftLeft',
  'ShiftRight',
  'Space',
  'KeyC',
  'KeyE',
  'KeyQ',
]);

export class DefaultWorldControls {
  private readonly canvas: HTMLCanvasElement;
  private readonly pressed = new Set<string>();
  private interactionQueued = false;
  private shoulderSwapQueued = false;
  private aiming = false;
  private pointerId: number | null = null;
  private yawDelta = 0;
  private pitchDelta = 0;

  public constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', 'Solara game world');
    canvas.addEventListener('keydown', this.onKeyDown);
    canvas.addEventListener('keyup', this.onKeyUp);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    canvas.addEventListener('blur', this.onCanvasBlur);
    window.addEventListener('blur', this.onBlur);
  }

  public consumeInput(): WorldInputState {
    const input = createWorldInputState();
    input.moveForward = Number(this.pressed.has('KeyW')) - Number(this.pressed.has('KeyS'));
    input.moveRight = Number(this.pressed.has('KeyD')) - Number(this.pressed.has('KeyA'));
    input.sprint = this.pressed.has('ShiftLeft') || this.pressed.has('ShiftRight');
    input.jump = this.pressed.has('Space');
    input.crouch = this.pressed.has('KeyC');
    input.aim = this.aiming;
    input.shoulderSwap = this.shoulderSwapQueued;
    input.handbrake = this.pressed.has('Space');
    input.interact = this.interactionQueued;
    input.cameraYawDelta = this.yawDelta;
    input.cameraPitchDelta = this.pitchDelta;
    this.interactionQueued = false;
    this.shoulderSwapQueued = false;
    this.yawDelta = 0;
    this.pitchDelta = 0;
    return input;
  }

  public clear(): void {
    this.pressed.clear();
    this.interactionQueued = false;
    this.shoulderSwapQueued = false;
    this.aiming = false;
    this.pointerId = null;
    this.yawDelta = 0;
    this.pitchDelta = 0;
  }

  public dispose(): void {
    this.clear();
    this.canvas.removeEventListener('keydown', this.onKeyDown);
    this.canvas.removeEventListener('keyup', this.onKeyUp);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.removeEventListener('blur', this.onCanvasBlur);
    window.removeEventListener('blur', this.onBlur);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (GAME_KEYS.has(event.code)) {
      event.preventDefault();
    }
    if (event.code === 'KeyE' && !event.repeat) {
      this.interactionQueued = true;
    }
    if (event.code === 'KeyQ' && !event.repeat) {
      this.shoulderSwapQueued = true;
    }
    this.pressed.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.canvas.focus({ preventScroll: true });
    this.pointerId = event.pointerId;
    this.canvas.setPointerCapture(event.pointerId);
    if (event.button === 2) {
      this.aiming = true;
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) {
      return;
    }
    const sensitivity = event.pointerType === 'touch' ? 0.006 : 0.0032;
    this.yawDelta -= event.movementX * sensitivity;
    this.pitchDelta -= event.movementY * sensitivity;
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.button === 2 || event.type === 'pointercancel') {
      this.aiming = false;
    }
    if (this.pointerId === event.pointerId) {
      this.pointerId = null;
    }
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private readonly onBlur = (): void => {
    this.clear();
  };

  private readonly onCanvasBlur = (): void => {
    this.clear();
  };
}
