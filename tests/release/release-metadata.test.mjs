import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import {
  extractCssAssetReferences,
  extractHtmlAssetReferences,
  parseJpegDimensions,
  SOCIAL_IMAGE_HEIGHT,
  SOCIAL_IMAGE_LIMIT,
  SOCIAL_IMAGE_URL,
  SOCIAL_IMAGE_WIDTH,
  validateBrandAssets,
  validateMetadata,
  validateReleaseAssets,
} from '../../scripts/check-release-assets.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const INDEX_PATH = resolve(ROOT, 'index.html');
const SOCIAL_IMAGE_PATH = resolve(
  ROOT,
  'public/assets/social/heatline-solara-social.jpg',
);

function jpegFrame(marker, width, height) {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    marker,
    0x00,
    0x08,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x00,
    0xff,
    0xd9,
  ]);
}

test('JPEG parser accepts baseline and progressive frame headers', () => {
  assert.deepEqual(parseJpegDimensions(jpegFrame(0xc0, 1200, 630)), {
    width: 1200,
    height: 630,
  });
  assert.deepEqual(parseJpegDimensions(jpegFrame(0xc2, 800, 418)), {
    width: 800,
    height: 418,
  });
  assert.throws(() => parseJpegDimensions(Buffer.from('not a jpeg')), /missing SOI/);
});

test('metadata gate requires canonical, Open Graph, and Twitter image metadata', async () => {
  const html = await readFile(INDEX_PATH, 'utf8');
  assert.doesNotThrow(() => validateMetadata(html));
  assert.equal(html.split(SOCIAL_IMAGE_URL).length - 1, 2);
  assert.throws(
    () => validateMetadata(html.replace('https://loggel.github.io/GTA-Web/', '/')),
    /canonical/,
  );
});

test('checked-in social card meets the publishing contract', async () => {
  const result = await validateReleaseAssets({
    htmlPath: INDEX_PATH,
    socialImagePath: SOCIAL_IMAGE_PATH,
  });
  assert.equal(result.width, SOCIAL_IMAGE_WIDTH);
  assert.equal(result.height, SOCIAL_IMAGE_HEIGHT);
  assert.ok(result.bytes <= SOCIAL_IMAGE_LIMIT);
});

test('checked-in splash and favicon have valid non-empty image signatures', async () => {
  const assets = await validateBrandAssets(resolve(ROOT, 'public'));
  assert.deepEqual(assets.map(({ path }) => path), [
    'favicon.svg',
    'assets/splash/heatline-splash.webp',
  ]);
  assert.ok(assets.every(({ bytes }) => bytes > 0));
});

test('asset reference extractors ignore remote/data URLs and retain local paths', () => {
  assert.deepEqual(
    extractHtmlAssetReferences(`
      <script src="./assets/app.js"></script>
      <link href="/assets/app.css?rev=1" rel="stylesheet">
      <link href="https://example.com/remote.css" rel="stylesheet">
    `),
    ['./assets/app.js', '/assets/app.css'],
  );
  assert.deepEqual(
    extractCssAssetReferences(`
      .hero { background: url('../assets/hero.webp#crop'); }
      .inline { background: url(data:image/png;base64,AAAA); }
    `),
    ['../assets/hero.webp'],
  );
});
