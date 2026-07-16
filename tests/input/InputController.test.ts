import { describe, expect, it } from 'vitest';

import { InputController, InputMap, toWorldInputState } from '../../src/input';

describe('InputController digital input', () => {
  it('tracks held, just-pressed, and just-released action and axis state', () => {
    const controller = new InputController();

    expect(controller.keyDown('KeyW')).toBe(true);
    const pressed = controller.consumeFrame();
    expect(pressed.actions.moveForward).toEqual({
      pressed: true,
      justPressed: true,
      justReleased: false,
    });
    expect(pressed.axes).toHaveProperty('moveForward', {
      value: 1,
      previousValue: 0,
      pressed: true,
      justPressed: true,
      justReleased: false,
    });

    expect(controller.keyDown('KeyW', true)).toBe(true);
    const held = controller.consumeFrame();
    expect(held.actions.moveForward.justPressed).toBe(false);
    expect(held.axes).toHaveProperty('moveForward.justPressed', false);

    expect(controller.keyUp('KeyW')).toBe(true);
    const released = controller.consumeFrame();
    expect(released.actions.moveForward).toEqual({
      pressed: false,
      justPressed: false,
      justReleased: true,
    });
    expect(released.axes).toHaveProperty('moveForward', {
      value: 0,
      previousValue: 1,
      pressed: false,
      justPressed: false,
      justReleased: true,
    });
  });

  it('reports both edge transitions when a tap occurs between frames', () => {
    const controller = new InputController();
    controller.keyDown('KeyE');
    controller.keyUp('KeyE');

    const frame = controller.consumeFrame();
    expect(frame.actions.interactEnterExit).toEqual({
      pressed: false,
      justPressed: true,
      justReleased: true,
    });
    expect(frame.commands).toHaveProperty('interact.justPressed', true);
  });

  it('aggregates multiple bindings without an early release edge', () => {
    const map = new InputMap();
    map.setKeyboardBindings('sprint', ['ShiftLeft', 'ShiftRight']);
    const controller = new InputController({ inputMap: map });

    controller.keyDown('ShiftLeft');
    controller.consumeFrame();
    controller.keyDown('ShiftRight');
    controller.keyUp('ShiftLeft');
    expect(controller.consumeFrame().commands).toHaveProperty('sprint.pressed', true);

    controller.keyUp('ShiftRight');
    expect(controller.consumeFrame().commands).toHaveProperty('sprint.justReleased', true);
  });

  it('normalizes mouse buttons and ignores valid but unbound inputs', () => {
    const controller = new InputController();

    expect(controller.mouseButtonDown(0)).toBe(true);
    expect(controller.mouseButtonDown(2)).toBe(true);
    expect(controller.keyDown('KeyZ')).toBe(false);
    const frame = controller.consumeFrame();
    expect(frame.commands).toHaveProperty('fireOrLightAttack.pressed', true);
    expect(frame.commands).toHaveProperty('aim.pressed', true);

    expect(() => controller.mouseButtonDown(5)).toThrow(RangeError);
    expect(() => controller.keyDown('NotAKey')).toThrow();
  });
});

describe('InputController analog and pointer input', () => {
  it('normalizes touch movement with a deadzone and gives analog input precedence', () => {
    const controller = new InputController({ analogDeadzone: 0.1 });
    controller.keyDown('KeyD');
    controller.setTouchMovement(0.55, 0.05);

    const analog = controller.consumeFrame();
    if (analog.mode !== 'on-foot') {
      throw new Error('Expected the default on-foot input mode');
    }
    expect(analog.axes.moveRight.value).toBeCloseTo(0.5);
    expect(analog.axes).toHaveProperty('moveForward.value', 0);

    controller.setTouchMovement(0, 0);
    const digitalFallback = controller.consumeFrame();
    expect(digitalFallback.axes).toHaveProperty('moveRight.value', 1);
  });

  it('maps touch buttons into the same canonical action states', () => {
    const controller = new InputController();
    controller.setTouchAction('jump', true);
    controller.setTouchAction('aim', true);

    const frame = controller.consumeFrame();
    expect(frame.commands).toHaveProperty('jump.pressed', true);
    expect(frame.commands).toHaveProperty('aim.pressed', true);

    controller.setTouchAction('jump', false);
    expect(controller.consumeFrame().commands).toHaveProperty('jump.justReleased', true);
  });

  it('accumulates sensitivity-scaled pointer deltas and consumes them once', () => {
    const controller = new InputController({
      mouseRadiansPerPixel: 0.01,
      touchRadiansPerPixel: 0.02,
    });
    controller.injectPointerDelta(2, -3, 'mouse');
    controller.injectPointerDelta(-1, 2, 'touch');

    const frame = controller.consumeFrame();
    expect(frame.pointerDelta.yaw).toBeCloseTo(0);
    expect(frame.pointerDelta.pitch).toBeCloseTo(-0.01);
    expect(controller.consumeFrame().pointerDelta).toEqual({ yaw: 0, pitch: 0 });
  });

  it('supports inverted vertical look', () => {
    const controller = new InputController({ mouseRadiansPerPixel: 0.01, invertY: true });
    controller.injectPointerDelta(0, 3);
    expect(controller.consumeFrame().pointerDelta.pitch).toBeCloseTo(0.03);
  });

  it('validates analog, pointer, and configuration values', () => {
    const controller = new InputController();
    expect(() => controller.setTouchMovement(Number.NaN, 0)).toThrow(TypeError);
    expect(() => controller.injectPointerDelta(Number.POSITIVE_INFINITY, 0)).toThrow(TypeError);
    expect(() => new InputController({ analogDeadzone: 1 })).toThrow(RangeError);
    expect(() => new InputController({ mouseRadiansPerPixel: -1 })).toThrow(RangeError);
  });
});

describe('InputController modes and lifecycle', () => {
  it('resolves overloaded bindings into on-foot commands', () => {
    const controller = new InputController({ mode: 'on-foot' });
    controller.keyDown('Space');
    controller.keyDown('KeyC');
    controller.keyDown('KeyE');
    controller.keyDown('KeyR');

    const frame = controller.consumeFrame();
    expect(frame.mode).toBe('on-foot');
    expect(frame.commands).toHaveProperty('jump.pressed', true);
    expect(frame.commands).toHaveProperty('crouch.pressed', true);
    expect(frame.commands).toHaveProperty('interact.pressed', true);
    expect(frame.commands).toHaveProperty('reload.pressed', true);
  });

  it('resolves the same bindings into vehicle commands', () => {
    const controller = new InputController({ mode: 'vehicle' });
    controller.keyDown('Space');
    controller.keyDown('KeyC');
    controller.keyDown('KeyE');
    controller.keyDown('KeyR');

    const frame = controller.consumeFrame();
    expect(frame.mode).toBe('vehicle');
    expect(frame.commands).toHaveProperty('handbrake.pressed', true);
    expect(frame.commands).toHaveProperty('cameraToggle.pressed', true);
    expect(frame.commands).toHaveProperty('enterExit.pressed', true);
    expect(frame.commands).toHaveProperty('vehicleReset.pressed', true);
  });

  it('releases held sources when changing modes, blurring, or hiding the document', () => {
    const controller = new InputController();
    controller.keyDown('KeyW');
    controller.setTouchAction('sprint', true);
    controller.setMode('vehicle');

    const afterModeChange = controller.consumeFrame();
    expect(afterModeChange.mode).toBe('vehicle');
    expect(afterModeChange.actions.moveForward.justReleased).toBe(true);
    expect(afterModeChange.actions.sprint.justReleased).toBe(true);

    controller.keyDown('KeyW');
    controller.handleBlur();
    expect(controller.consumeFrame().axes).toHaveProperty('throttle.value', 0);

    controller.keyDown('KeyD');
    controller.handleVisibilityChange(false);
    expect(controller.isPressed('moveRight')).toBe(true);
    controller.handleVisibilityChange(true);
    expect(controller.consumeFrame().actions.moveRight.justReleased).toBe(true);
  });

  it('releases active input when remapping and can restore a saved binding snapshot', () => {
    const controller = new InputController();
    const original = controller.bindingSnapshot();
    controller.keyDown('KeyW');
    controller.remapKeyboard('moveForward', 'ArrowUp');

    expect(controller.actionForBinding('keyboard', 'KeyW')).toBeUndefined();
    expect(controller.actionForBinding('keyboard', 'ArrowUp')).toBe('moveForward');
    expect(controller.consumeFrame().actions.moveForward.justReleased).toBe(true);
    expect(controller.keyDown('KeyW')).toBe(false);
    expect(controller.keyDown('ArrowUp')).toBe(true);

    controller.restoreBindings(original);
    expect(controller.actionForBinding('keyboard', 'KeyW')).toBe('moveForward');
    expect(controller.actionForBinding('keyboard', 'ArrowUp')).toBeUndefined();
  });

  it('keeps current bindings and held state when remapping validation fails', () => {
    const controller = new InputController();
    controller.keyDown('KeyW');

    expect(() => controller.remapKeyboard('moveForward', 'KeyS')).toThrow();
    expect(controller.actionForBinding('keyboard', 'KeyW')).toBe('moveForward');
    expect(controller.isPressed('moveForward')).toBe(true);
  });

  it('emits monotonic frame sequence numbers', () => {
    const controller = new InputController();
    expect(controller.consumeFrame().sequence).toBe(1);
    expect(controller.consumeFrame().sequence).toBe(2);
  });
});

describe('world input adapter', () => {
  it('maps held and one-shot on-foot controls to WorldInputState', () => {
    const controller = new InputController();
    controller.keyDown('KeyW');
    controller.keyDown('ShiftLeft');
    controller.keyDown('KeyQ');
    controller.keyDown('KeyE');
    controller.injectPointerDelta(4, -2);

    const first = toWorldInputState(controller.consumeFrame());
    expect(first.moveForward).toBe(1);
    expect(first.sprint).toBe(true);
    expect(first.shoulderSwap).toBe(true);
    expect(first.interact).toBe(true);
    expect(first.cameraYawDelta).not.toBe(0);

    const held = toWorldInputState(controller.consumeFrame());
    expect(held.shoulderSwap).toBe(false);
    expect(held.interact).toBe(false);
    expect(held.sprint).toBe(true);
  });

  it('maps vehicle axes, aim, handbrake, and enter/exit', () => {
    const controller = new InputController({ mode: 'vehicle' });
    controller.keyDown('KeyS');
    controller.keyDown('KeyA');
    controller.keyDown('Space');
    controller.keyDown('KeyE');
    controller.keyDown('KeyR');
    controller.keyDown('KeyC');
    controller.mouseButtonDown(0);
    controller.mouseButtonDown(2);

    const first = toWorldInputState(controller.consumeFrame());
    expect(first).toMatchObject({
      moveForward: -1,
      moveRight: -1,
      aim: true,
      handbrake: true,
      vehiclePrimaryAction: true,
      vehicleCameraToggle: true,
      vehicleReset: true,
      interact: true,
      jump: false,
      crouch: false,
      sprint: false,
    });
    expect(toWorldInputState(controller.consumeFrame()).vehicleReset).toBe(false);
    expect(toWorldInputState(controller.consumeFrame()).vehicleCameraToggle).toBe(false);
  });
});
