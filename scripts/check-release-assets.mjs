import process from 'node:process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SITE_URL = 'https://loggel.github.io/GTA-Web/';
export const SOCIAL_IMAGE_URL = `${SITE_URL}assets/social/heatline-solara-social.jpg`;
export const SOCIAL_IMAGE_WIDTH = 1200;
export const SOCIAL_IMAGE_HEIGHT = 630;
export const SOCIAL_IMAGE_LIMIT = 250 * 1024;

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const REQUIRED_BRAND_ASSETS = Object.freeze([
  {
    relativePath: 'favicon.svg',
    signature: (bytes) => bytes.subarray(0, 256).toString('utf8').includes('<svg'),
    format: 'SVG',
  },
  {
    relativePath: 'assets/splash/heatline-splash.webp',
    signature: (bytes) => bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP',
    format: 'WebP',
  },
]);
const DESCRIPTION =
  'An original third-person open-world crime-action RPG, playable in your browser.';
const SOCIAL_ALT =
  'HEATLINE: SOLARA — a neon-lit drive through the streets of Solara';

const EXPECTED_METADATA = [
  { selector: 'link[rel="canonical"]', attribute: 'href', value: SITE_URL },
  { selector: 'meta[property="og:type"]', attribute: 'content', value: 'website' },
  {
    selector: 'meta[property="og:site_name"]',
    attribute: 'content',
    value: 'HEATLINE: SOLARA',
  },
  {
    selector: 'meta[property="og:title"]',
    attribute: 'content',
    value: 'HEATLINE: SOLARA',
  },
  { selector: 'meta[property="og:description"]', attribute: 'content', value: DESCRIPTION },
  { selector: 'meta[property="og:url"]', attribute: 'content', value: SITE_URL },
  { selector: 'meta[property="og:image"]', attribute: 'content', value: SOCIAL_IMAGE_URL },
  { selector: 'meta[property="og:image:type"]', attribute: 'content', value: 'image/jpeg' },
  {
    selector: 'meta[property="og:image:width"]',
    attribute: 'content',
    value: String(SOCIAL_IMAGE_WIDTH),
  },
  {
    selector: 'meta[property="og:image:height"]',
    attribute: 'content',
    value: String(SOCIAL_IMAGE_HEIGHT),
  },
  { selector: 'meta[property="og:image:alt"]', attribute: 'content', value: SOCIAL_ALT },
  {
    selector: 'meta[name="twitter:card"]',
    attribute: 'content',
    value: 'summary_large_image',
  },
  {
    selector: 'meta[name="twitter:title"]',
    attribute: 'content',
    value: 'HEATLINE: SOLARA',
  },
  { selector: 'meta[name="twitter:description"]', attribute: 'content', value: DESCRIPTION },
  { selector: 'meta[name="twitter:image"]', attribute: 'content', value: SOCIAL_IMAGE_URL },
  { selector: 'meta[name="twitter:image:alt"]', attribute: 'content', value: SOCIAL_ALT },
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseAttributes(tag) {
  const attributes = new Map();
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gs)) {
    attributes.set(match[1]?.toLowerCase(), match[3]);
  }
  return attributes;
}

function findElements(html, tagName, identityName, identityValue) {
  const tagPattern = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  return [...html.matchAll(tagPattern)]
    .map(([tag]) => ({ tag, attributes: parseAttributes(tag) }))
    .filter(({ attributes }) => attributes.get(identityName) === identityValue);
}

function parseSelector(selector) {
  const match = /^(link|meta)\[(rel|name|property)="([^"]+)"\]$/.exec(selector);
  if (!match) throw new Error(`Unsupported metadata selector: ${selector}`);
  return { tagName: match[1], identityName: match[2], identityValue: match[3] };
}

export function validateMetadata(html) {
  for (const expected of EXPECTED_METADATA) {
    const { tagName, identityName, identityValue } = parseSelector(expected.selector);
    const elements = findElements(html, tagName, identityName, identityValue);
    if (elements.length !== 1) {
      throw new Error(`${expected.selector} must occur exactly once; found ${elements.length}.`);
    }
    const actual = elements[0]?.attributes.get(expected.attribute);
    if (actual !== expected.value) {
      throw new Error(
        `${expected.selector} must set ${expected.attribute}="${expected.value}"; found "${actual ?? ''}".`,
      );
    }
  }

  const absoluteImageReferences = html.match(
    new RegExp(escapeRegExp(SOCIAL_IMAGE_URL), 'g'),
  );
  if (absoluteImageReferences?.length !== 2) {
    throw new Error('The absolute social image URL must be used once by Open Graph and once by Twitter.');
  }
}

const SOF_MARKERS = new Set([
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcd,
  0xce,
  0xcf,
]);

export function parseJpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('Social image is not a JPEG: missing SOI signature.');
  }

  let offset = 2;
  while (offset < bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) throw new Error('Social JPEG has a truncated segment header.');

    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      throw new Error('Social JPEG has an invalid segment length.');
    }

    if (SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) throw new Error('Social JPEG has an invalid frame header.');
      return {
        width: bytes.readUInt16BE(offset + 5),
        height: bytes.readUInt16BE(offset + 3),
      };
    }
    offset += segmentLength;
  }

  throw new Error('Social JPEG has no supported frame header.');
}

export async function validateReleaseAssets({ htmlPath, socialImagePath }) {
  let imageInfo;
  try {
    imageInfo = await stat(socialImagePath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Required social JPEG is missing: ${socialImagePath}`, { cause: error });
    }
    throw error;
  }

  const [html, image] = await Promise.all([readFile(htmlPath, 'utf8'), readFile(socialImagePath)]);

  validateMetadata(html);
  if (imageInfo.size > SOCIAL_IMAGE_LIMIT) {
    throw new Error(
      `Social JPEG is ${(imageInfo.size / 1024).toFixed(1)} KiB; maximum is 250 KiB.`,
    );
  }

  const dimensions = parseJpegDimensions(image);
  if (dimensions.width !== SOCIAL_IMAGE_WIDTH || dimensions.height !== SOCIAL_IMAGE_HEIGHT) {
    throw new Error(
      `Social JPEG is ${dimensions.width}×${dimensions.height}; expected 1200×630.`,
    );
  }

  return { bytes: imageInfo.size, ...dimensions };
}

function isLocalAssetReference(reference) {
  return reference.length > 0
    && !reference.startsWith('#')
    && !reference.startsWith('data:')
    && !reference.startsWith('blob:')
    && !/^[a-z][a-z\d+.-]*:/i.test(reference)
    && !reference.startsWith('//');
}

function cleanAssetReference(reference) {
  return decodeURIComponent(reference.split(/[?#]/u, 1)[0] ?? '');
}

export function extractHtmlAssetReferences(html) {
  const references = [];
  for (const match of html.matchAll(/<(?:script|link|img|source)\b[^>]*\b(?:src|href)\s*=\s*(["'])(.*?)\1/giu)) {
    const reference = cleanAssetReference(match[2] ?? '');
    if (isLocalAssetReference(reference)) references.push(reference);
  }
  return references;
}

export function extractCssAssetReferences(css) {
  const references = [];
  for (const match of css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/giu)) {
    const reference = cleanAssetReference(match[2]?.trim() ?? '');
    if (isLocalAssetReference(reference)) references.push(reference);
  }
  return references;
}

async function assertRegularFile(path, label) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`${label} is missing: ${path}`, { cause: error });
    }
    throw error;
  }
  if (!info.isFile() || info.size === 0) throw new Error(`${label} must be a non-empty regular file: ${path}`);
  return info;
}

export async function validateBrandAssets(assetRoot) {
  const validated = [];
  for (const asset of REQUIRED_BRAND_ASSETS) {
    const path = resolve(assetRoot, asset.relativePath);
    const info = await assertRegularFile(path, `Required ${asset.format} asset`);
    const bytes = await readFile(path);
    if (!asset.signature(bytes)) {
      throw new Error(`Required ${asset.format} asset has an invalid signature: ${path}`);
    }
    validated.push({ path: asset.relativePath, bytes: info.size });
  }
  return validated;
}

function resolveInside(root, fromPath, reference) {
  const candidate = reference.startsWith('/')
    ? resolve(root, `.${reference}`)
    : resolve(dirname(fromPath), reference);
  const relativePath = relative(root, candidate);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`Published asset reference escapes dist: ${reference}`);
  }
  return candidate;
}

export async function validateDistAssetGraph(distRoot) {
  const htmlPath = resolve(distRoot, 'index.html');
  const html = await readFile(htmlPath, 'utf8');
  const referenced = [];

  for (const reference of extractHtmlAssetReferences(html)) {
    referenced.push(resolveInside(distRoot, htmlPath, reference));
  }

  const assetsDirectory = resolve(distRoot, 'assets');
  const entries = await readdir(assetsDirectory, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.css')) continue;
    const parentPath = entry.parentPath ?? entry.path;
    const cssPath = resolve(parentPath, entry.name);
    const css = await readFile(cssPath, 'utf8');
    for (const reference of extractCssAssetReferences(css)) {
      referenced.push(resolveInside(distRoot, cssPath, reference));
    }
  }

  const unique = [...new Set(referenced)];
  await Promise.all(unique.map((path) => assertRegularFile(path, 'Published asset reference')));
  if (!unique.some((path) => path.endsWith('.js')) || !unique.some((path) => path.endsWith('.css'))) {
    throw new Error('Published HTML must reference at least one local JavaScript and CSS asset.');
  }
  return unique.map((path) => relative(distRoot, path)).sort();
}

export async function runReleaseGate(mode = 'source') {
  const isDist = mode === 'dist';
  const htmlPath = resolve(PROJECT_ROOT, isDist ? 'dist/index.html' : 'index.html');
  const socialImagePath = resolve(
    PROJECT_ROOT,
    isDist
      ? 'dist/assets/social/heatline-solara-social.jpg'
      : 'public/assets/social/heatline-solara-social.jpg',
  );
  const [result, brandAssets] = await Promise.all([
    validateReleaseAssets({ htmlPath, socialImagePath }),
    validateBrandAssets(resolve(PROJECT_ROOT, isDist ? 'dist' : 'public')),
  ]);
  const graph = isDist ? await validateDistAssetGraph(resolve(PROJECT_ROOT, 'dist')) : [];
  console.log(
    `Release assets (${mode}): social JPEG ${result.width}×${result.height}, ${(result.bytes / 1024).toFixed(1)} KiB; ${brandAssets.length} brand assets${isDist ? `; ${graph.length} local references` : ''}`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  await runReleaseGate(process.argv.includes('--dist') ? 'dist' : 'source');
}
