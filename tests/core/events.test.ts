import { describe, expect, it, vi } from 'vitest';

import { EventBus, createGameEventBus } from '../../src/core/events';

interface TestEvents {
  count: number;
  message: { text: string };
}

describe('EventBus', () => {
  it('delivers typed payloads synchronously and unsubscribes', () => {
    const bus = new EventBus<TestEvents>();
    const listener = vi.fn<(value: number) => void>();
    const unsubscribe = bus.on('count', listener);

    bus.emit('count', 4);
    unsubscribe();
    bus.emit('count', 9);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(4);
    expect(bus.listenerCount('count')).toBe(0);
  });

  it('supports once listeners and stable mutation during dispatch', () => {
    const bus = new EventBus<TestEvents>();
    const calls: string[] = [];
    let unsubscribeSecond = (): void => undefined;
    bus.once('message', ({ text }) => calls.push(`once:${text}`));
    bus.on('message', ({ text }) => {
      calls.push(`first:${text}`);
      unsubscribeSecond();
    });
    unsubscribeSecond = bus.on('message', ({ text }) => calls.push(`second:${text}`));

    bus.emit('message', { text: 'a' });
    bus.emit('message', { text: 'b' });

    expect(calls).toEqual(['once:a', 'first:a', 'second:a', 'first:b']);
  });

  it('exposes the complete game event bus factory', () => {
    const bus = createGameEventBus();
    const listener = vi.fn();
    bus.on('wanted:changed', listener);

    bus.emit('wanted:changed', { previous: 0, current: 1, phase: 'investigating' });

    expect(listener).toHaveBeenCalledOnce();
  });
});
