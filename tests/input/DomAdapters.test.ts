import { afterEach, describe, expect, it, vi } from 'vitest';

import { DomInputAdapter, InputController, TouchInput } from '../../src/input';

class FakeWindow extends EventTarget {}

class FakeDocument extends EventTarget {
  public hidden = false;
}

class FakeElement extends EventTarget {
  public tabIndex = -1;
  public readonly style = { transform: '' };
  public focusCalls = 0;
  public capturedPointer: number | null = null;
  readonly #attributes = new Map<string, string>();

  public focus(): void {
    this.focusCalls += 1;
  }

  public setPointerCapture(pointerId: number): void {
    this.capturedPointer = pointerId;
  }

  public getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }

  public setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);
    if (name === 'tabindex') {
      this.tabIndex = Number(value);
    }
  }

  public removeAttribute(name: string): void {
    this.#attributes.delete(name);
    if (name === 'tabindex') {
      this.tabIndex = -1;
    }
  }

  public querySelector<ElementType extends Element>(_selectors: string): ElementType | null {
    return null;
  }

  public getBoundingClientRect(): DOMRect {
    return {
      bottom: 100,
      height: 100,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  }
}

class FakeStick extends FakeElement {
  public constructor(private readonly knob: FakeElement) {
    super();
  }

  public override querySelector<ElementType extends Element>(
    selectors: string,
  ): ElementType | null {
    return selectors === 'span' ? this.knob as unknown as ElementType : null;
  }
}

class FakeTouchRoot extends FakeElement {
  public constructor(
    private readonly stick: FakeStick,
    private readonly camera: FakeElement,
  ) {
    super();
  }

  public override querySelector<ElementType extends Element>(
    selectors: string,
  ): ElementType | null {
    if (selectors === '[data-touch-stick]') {
      return this.stick as unknown as ElementType;
    }
    if (selectors === '[data-touch-camera]') {
      return this.camera as unknown as ElementType;
    }
    return null;
  }
}

function eventWithProperties(
  type: string,
  properties: Readonly<Record<string, unknown>>,
): Event {
  const event = new Event(type, { cancelable: true });
  for (const [name, value] of Object.entries(properties)) {
    Object.defineProperty(event, name, { value });
  }
  return event;
}

function installBrowserGlobals(): { window: FakeWindow; document: FakeDocument } {
  const fakeWindow = new FakeWindow();
  const fakeDocument = new FakeDocument();
  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('document', fakeDocument);
  return { window: fakeWindow, document: fakeDocument };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DomInputAdapter', () => {
  it('makes a canvas focusable without focusing it until pointer interaction', () => {
    installBrowserGlobals();
    const target = new FakeElement();
    const controller = new InputController();
    const adapter = new DomInputAdapter(target as unknown as HTMLElement, controller);

    expect(target.tabIndex).toBe(0);
    expect(target.focusCalls).toBe(0);

    target.dispatchEvent(eventWithProperties('pointerdown', {
      button: 0,
      movementX: 0,
      movementY: 0,
      pointerId: 7,
      pointerType: 'mouse',
    }));
    expect(target.focusCalls).toBe(1);
    expect(target.capturedPointer).toBe(7);

    const keyDown = eventWithProperties('keydown', { code: 'KeyW', repeat: false });
    target.dispatchEvent(keyDown);
    expect(keyDown.defaultPrevented).toBe(true);
    expect(controller.isPressed('moveForward')).toBe(true);

    adapter.destroy();
    expect(target.tabIndex).toBe(-1);
    expect(controller.isPressed('moveForward')).toBe(false);
  });

  it('preserves explicit focus behavior when automatic focusability is disabled', () => {
    installBrowserGlobals();
    const target = new FakeElement();
    const adapter = new DomInputAdapter(
      target as unknown as HTMLElement,
      new InputController(),
      { focusOnPointerDown: false, makeFocusable: false },
    );

    target.dispatchEvent(eventWithProperties('pointerdown', {
      button: 0,
      movementX: 0,
      movementY: 0,
      pointerId: 1,
      pointerType: 'mouse',
    }));
    expect(target.tabIndex).toBe(-1);
    expect(target.focusCalls).toBe(0);
    adapter.destroy();
  });

  it('handles right-button aim plus left-button fire without stuck actions', () => {
    const browser = installBrowserGlobals();
    const target = new FakeElement();
    const controller = new InputController();
    const adapter = new DomInputAdapter(target as unknown as HTMLElement, controller);

    target.dispatchEvent(eventWithProperties('mousedown', { button: 2 }));
    expect(controller.consumeFrame().actions.aim.pressed).toBe(true);

    target.dispatchEvent(eventWithProperties('mousedown', { button: 0 }));
    const chord = controller.consumeFrame();
    expect(chord.actions.aim.pressed).toBe(true);
    expect(chord.actions.primaryAction.justPressed).toBe(true);

    browser.window.dispatchEvent(eventWithProperties('mouseup', { button: 0 }));
    const fireReleased = controller.consumeFrame();
    expect(fireReleased.actions.primaryAction.justReleased).toBe(true);
    expect(fireReleased.actions.aim.pressed).toBe(true);

    browser.window.dispatchEvent(eventWithProperties('mouseup', { button: 2 }));
    expect(controller.consumeFrame().actions.aim.justReleased).toBe(true);
    adapter.destroy();
  });

  it('releases all input on document hide', () => {
    const browser = installBrowserGlobals();
    const target = new FakeElement();
    const controller = new InputController();
    const adapter = new DomInputAdapter(target as unknown as HTMLElement, controller);
    target.dispatchEvent(eventWithProperties('keydown', { code: 'KeyD', repeat: false }));

    browser.document.hidden = true;
    browser.document.dispatchEvent(new Event('visibilitychange'));
    expect(controller.consumeFrame().actions.moveRight.justReleased).toBe(true);
    adapter.destroy();
  });
});

describe('TouchInput lifecycle', () => {
  it('neutralizes an active virtual stick and resets its knob on destroy', () => {
    const knob = new FakeElement();
    const stick = new FakeStick(knob);
    const camera = new FakeElement();
    const root = new FakeTouchRoot(stick, camera);
    const controller = new InputController({ analogDeadzone: 0 });
    const touch = new TouchInput(root as unknown as HTMLElement, controller);

    stick.dispatchEvent(eventWithProperties('pointerdown', {
      clientX: 86,
      clientY: 50,
      pointerId: 12,
    }));
    const active = controller.consumeFrame();
    expect(active.axes).toHaveProperty('moveRight.value', 1);

    touch.destroy();
    const neutral = controller.consumeFrame();
    expect(neutral.axes).toHaveProperty('moveRight.value', 0);
    expect(neutral.axes).toHaveProperty('moveRight.justReleased', true);
    expect(knob.style.transform).toBe('translate(-50%, -50%)');
  });
});
