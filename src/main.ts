import './styles.css';

import { App } from './app/App';

const root = document.querySelector<HTMLDivElement>('#app');

if (!root) {
  throw new Error('Missing #app root');
}

root.innerHTML = '<main class="boot-fallback" role="status">Preparing Solara…</main>';

void App.boot(root)
  .then(() => root.setAttribute('aria-busy', 'false'))
  .catch((error: unknown) => {
    console.error(error);
    root.setAttribute('aria-busy', 'false');
    root.innerHTML = `
      <main class="boot-fallback boot-fallback--error">
        <h1>HEATLINE</h1>
        <p>Solara could not start. Reload the page or try a current WebGL2 browser.</p>
      </main>
    `;
  });
