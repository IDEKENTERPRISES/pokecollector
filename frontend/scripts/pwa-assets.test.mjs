import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'manifest.json'), 'utf8'));

function readPngHeader(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG', `${file} is not a PNG`);
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] };
}

test('manifest declares an installable standalone app', () => {
  assert.equal(manifest.id, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#000000');
  assert.equal(manifest.background_color, '#000000');
});

test('manifest icons are versioned files under /icons/ whose sizes match', () => {
  assert.ok(manifest.icons.length >= 4);
  for (const icon of manifest.icons) {
    assert.ok(icon.src.startsWith('/icons/'), `${icon.src} must start with /icons/`);
    assert.ok(!icon.src.includes('?'), `${icon.src} must not use a query string`);
    const file = path.join(publicDir, icon.src);
    assert.ok(fs.existsSync(file), `${icon.src} is missing on disk`);
    const { width, height } = readPngHeader(file);
    assert.equal(icon.sizes, `${width}x${height}`, `${icon.src} declared sizes`);
  }
  const purposes = new Set(manifest.icons.map((icon) => icon.purpose));
  assert.ok(purposes.has('any') && purposes.has('maskable'));
});

test('maskable and apple-touch icons are opaque', () => {
  for (const icon of manifest.icons.filter((i) => i.purpose === 'maskable')) {
    const { colorType } = readPngHeader(path.join(publicDir, icon.src));
    assert.equal(colorType, 2, `${icon.src} must have no alpha channel`);
  }
  const apple = readPngHeader(path.join(publicDir, 'icons/pc-apple-touch-180-v3.png'));
  assert.equal(apple.colorType, 2);
  assert.equal(apple.width, 180);
  assert.equal(apple.height, 180);
});

test('index.html has the iOS meta tags and no cache-busting query strings', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(!html.includes('?v='));
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /<meta name="mobile-web-app-capable" content="yes"/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="PokéCollector"/);
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black"/);
  assert.match(html, /<meta name="theme-color" content="#000000"/);
  assert.match(html, /rel="apple-touch-icon" sizes="180x180" href="\/icons\/pc-apple-touch-180-v3\.png"/);
});

test('index.html has a pure black fallback layer and downloads no web fonts', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /<style>@layer pc-fallback {[^}]*background-color: #000000/);
  // The app uses the system font stacks only (design doc Q6): no Google Fonts link, no preconnect.
  assert.ok(!html.includes('fonts.googleapis.com'));
  assert.ok(!html.includes('fonts.gstatic.com'));
  assert.ok(!html.includes('data-pc-fonts'));
});
