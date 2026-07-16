import { describe, expect, it } from 'vitest';

import { getTouchControlLayout } from '../../src/ui/GameUI';

describe('GameUI touch control layouts', () => {
  it('exposes every on-foot combat action with concise accessible labels', () => {
    const layout = getTouchControlLayout(false);

    expect(Object.keys(layout)).toEqual([
      'interact',
      'sprint',
      'jump',
      'crouch',
      'aim',
      'fire',
      'melee',
      'reload',
      'weaponRadial',
    ]);
    expect(layout.melee).toEqual(['Charge heavy attack', 'HEAVY', false]);
    expect(layout.weaponRadial).toEqual(['Cycle weapon', 'SWAP', false]);
    expect(Object.values(layout).every(([, , hidden]) => !hidden)).toBe(true);
  });

  it('hides on-foot-only combat actions without removing vehicle controls', () => {
    const layout = getTouchControlLayout(true);

    expect(layout.melee?.[2]).toBe(true);
    expect(layout.weaponRadial?.[2]).toBe(true);
    expect(layout.sprint?.[2]).toBe(true);
    expect(layout.interact).toEqual(['Exit vehicle', 'EXIT', false]);
    expect(layout.jump).toEqual(['Handbrake', 'BRAKE', false]);
    expect(layout.reload).toEqual(['Vehicle reset', 'RESET', false]);
  });
});
