import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const gameUiSource = readFileSync(new URL('../../src/ui/GameUI.ts', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../../src/app/App.ts', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');

describe('GameUI final accessibility contract', () => {
  it('gives the visually hidden save-file input a visible focus proxy', () => {
    expect(gameUiSource).toMatch(
      /data-save-import-file[^>]*>\s*<label class="button save-import-file-trigger"/,
    );
    expect(styles).toContain('.visually-hidden:focus-visible + .save-import-file-trigger');
  });

  it('uses a gameplay-only modal orientation blocker with focus restoration', () => {
    expect(gameUiSource).toContain(
      'data-orientation-blocker hidden role="dialog" aria-modal="true"',
    );
    expect(gameUiSource).toContain('setOrientationBlocked(blocked: boolean)');
    expect(appSource).toContain("this.#root.classList.contains('is-playing')");
    expect(appSource).toContain('this.#ui.setOrientationBlocked(blocked)');
    expect(styles).toContain(
      '.is-playing.is-orientation-blocked .rotate-overlay:not([hidden])',
    );
  });

  it('keeps storage alerts perceivable inside active modals', () => {
    expect(gameUiSource.match(/data-modal-persistence-warning/g)?.length).toBeGreaterThanOrEqual(5);
    expect(gameUiSource).toContain("querySelectorAll<HTMLElement>('[data-modal-persistence-warning]')");
    expect(styles).toContain('.modal-persistence-warning');
  });

  it('announces objective changes without rewriting unchanged live-region text', () => {
    expect(gameUiSource).toContain(
      'objective-card" role="status" aria-live="polite" aria-atomic="true"',
    );
    expect(gameUiSource).toContain('if (objective.textContent !== snapshot.objective)');
  });

  it('retains safe-area width and 44px-equivalent emergency actions', () => {
    expect(styles).toMatch(/\.wide-card\s*{[^}]*width:\s*min\(100%, 70rem\)/s);
    expect(styles).toMatch(/\.persistence-warning \.button\s*{[^}]*min-height:\s*2\.75rem/s);
  });
});
