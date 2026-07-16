import { isValidKeyboardCode } from './InputMap';
import type { InputController } from './InputController';

export interface DomInputAdapterOptions {
  readonly preventDefault?: boolean;
  readonly focusOnPointerDown?: boolean;
  readonly makeFocusable?: boolean;
}

/**
 * Thin browser adapter for InputController. Game state stays in InputController,
 * which keeps this class disposable and the input logic testable without a DOM.
 */
export class DomInputAdapter {
  readonly #target: HTMLElement;
  readonly #controller: InputController;
  readonly #preventDefault: boolean;
  readonly #focusOnPointerDown: boolean;
  readonly #previousTabIndex: string | null;
  readonly #madeFocusable: boolean;
  #pointerId: number | null = null;
  #destroyed = false;

  public constructor(
    target: HTMLElement,
    controller: InputController,
    options: DomInputAdapterOptions = {},
  ) {
    this.#target = target;
    this.#controller = controller;
    this.#preventDefault = options.preventDefault ?? true;
    this.#focusOnPointerDown = options.focusOnPointerDown ?? true;
    this.#previousTabIndex = target.getAttribute('tabindex');
    this.#madeFocusable = (options.makeFocusable ?? true) && target.tabIndex < 0;
    if (this.#madeFocusable) {
      target.tabIndex = 0;
    }

    target.addEventListener('keydown', this.#onKeyDown);
    target.addEventListener('keyup', this.#onKeyUp);
    target.addEventListener('mousedown', this.#onMouseDown);
    target.addEventListener('pointerdown', this.#onPointerDown);
    target.addEventListener('pointermove', this.#onPointerMove);
    target.addEventListener('pointerup', this.#onPointerUp);
    target.addEventListener('pointercancel', this.#onPointerCancel);
    target.addEventListener('contextmenu', this.#onContextMenu);
    target.addEventListener('blur', this.#onBlur);
    window.addEventListener('mouseup', this.#onMouseUp);
    window.addEventListener('blur', this.#onBlur);
    document.addEventListener('visibilitychange', this.#onVisibilityChange);
  }

  public destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#controller.releaseAll();
    this.#pointerId = null;
    this.#target.removeEventListener('keydown', this.#onKeyDown);
    this.#target.removeEventListener('keyup', this.#onKeyUp);
    this.#target.removeEventListener('mousedown', this.#onMouseDown);
    this.#target.removeEventListener('pointerdown', this.#onPointerDown);
    this.#target.removeEventListener('pointermove', this.#onPointerMove);
    this.#target.removeEventListener('pointerup', this.#onPointerUp);
    this.#target.removeEventListener('pointercancel', this.#onPointerCancel);
    this.#target.removeEventListener('contextmenu', this.#onContextMenu);
    this.#target.removeEventListener('blur', this.#onBlur);
    window.removeEventListener('mouseup', this.#onMouseUp);
    window.removeEventListener('blur', this.#onBlur);
    document.removeEventListener('visibilitychange', this.#onVisibilityChange);
    if (this.#madeFocusable && this.#target.tabIndex === 0) {
      if (this.#previousTabIndex === null) {
        this.#target.removeAttribute('tabindex');
      } else {
        this.#target.setAttribute('tabindex', this.#previousTabIndex);
      }
    }
  }

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    if (!isValidKeyboardCode(event.code)) {
      return;
    }
    const consumed = this.#controller.keyDown(event.code, event.repeat);
    if (consumed && this.#preventDefault) {
      event.preventDefault();
    }
  };

  readonly #onKeyUp = (event: KeyboardEvent): void => {
    if (!isValidKeyboardCode(event.code)) {
      return;
    }
    const consumed = this.#controller.keyUp(event.code);
    if (consumed && this.#preventDefault) {
      event.preventDefault();
    }
  };

  readonly #onPointerDown = (event: PointerEvent): void => {
    if (this.#focusOnPointerDown) {
      this.#target.focus({ preventScroll: true });
    }
    this.#pointerId = event.pointerId;
    this.#target.setPointerCapture(event.pointerId);
  };

  readonly #onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.#pointerId) {
      return;
    }
    const source = event.pointerType === 'touch' ? 'touch' : 'mouse';
    this.#controller.injectPointerDelta(event.movementX, event.movementY, source);
    if (this.#preventDefault) {
      event.preventDefault();
    }
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId === this.#pointerId) {
      this.#pointerId = null;
    }
  };

  readonly #onMouseDown = (event: MouseEvent): void => {
    if (event.button < 0 || event.button > 4) {
      return;
    }
    const consumed = this.#controller.mouseButtonDown(event.button);
    if (consumed && this.#preventDefault) {
      event.preventDefault();
    }
  };

  readonly #onMouseUp = (event: MouseEvent): void => {
    if (event.button < 0 || event.button > 4) {
      return;
    }
    const consumed = this.#controller.mouseButtonUp(event.button);
    if (consumed && this.#preventDefault) {
      event.preventDefault();
    }
  };

  readonly #onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId === this.#pointerId) {
      this.#pointerId = null;
    }
    this.#controller.releaseAll();
  };

  readonly #onContextMenu = (event: MouseEvent): void => {
    if (this.#preventDefault) {
      event.preventDefault();
    }
  };

  readonly #onBlur = (): void => {
    this.#pointerId = null;
    this.#controller.handleBlur();
  };

  readonly #onVisibilityChange = (): void => {
    this.#controller.handleVisibilityChange(document.hidden);
    if (document.hidden) {
      this.#pointerId = null;
    }
  };
}
