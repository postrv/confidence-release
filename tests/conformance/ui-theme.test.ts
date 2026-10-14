import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { applyTheme, readTheme, resolveTheme, saveTheme, THEME_COLORS, THEME_STORAGE_KEY } from '../../apps/web/src/theme';

const html = readFileSync(new URL('../../apps/web/index.html', import.meta.url), 'utf8');
const bootstrap = html.match(/<script id="theme-bootstrap">([\s\S]*?)<\/script>/)?.[1];
assert.ok(bootstrap, 'The saved preference must be available before the app loads.');

function documentFixture() {
  const dataset: Record<string, string> = {};
  const meta: Record<string, string> = {};
  const document = { documentElement: { dataset }, querySelector: () => ({ setAttribute: (name: string, value: string) => { meta[name] = value; } }) } as unknown as Document;
  return { document, dataset, meta };
}

test('first visit and invalid preferences use dark; only an explicit light choice selects light', () => {
  for (const value of [null, undefined, '', 'system', 'LIGHT', 'malformed', {}, 'dark']) assert.equal(resolveTheme(value), 'dark');
  for (const value of [null, 'dark', 'light', 'invalid']) {
    const fixture = documentFixture();
    const storage = { getItem: (key: string) => { assert.equal(key, THEME_STORAGE_KEY); return value; } };
    runInNewContext(bootstrap!, { document: fixture.document, localStorage: storage });
    assert.equal(fixture.dataset.theme, readTheme(() => storage));
    assert.equal(fixture.meta.content, THEME_COLORS[resolveTheme(value)]);
  }
  assert.ok(html.indexOf('id="theme-bootstrap"') < html.indexOf('src="/src/main.tsx"'));
});

test('an explicit choice survives a new reader and changes the document and browser chrome together', () => {
  const retained = new Map<string, string>();
  const storage = { getItem: (key: string) => retained.get(key) ?? null, setItem: (key: string, value: string) => { retained.set(key, value); } };
  const fixture = documentFixture();
  for (const theme of ['light', 'dark'] as const) {
    applyTheme(theme, fixture.document); saveTheme(theme, () => storage);
    assert.equal(readTheme(() => storage), theme);
    assert.equal(fixture.dataset.theme, theme);
    assert.equal(fixture.meta.content, THEME_COLORS[theme]);
  }
  assert.deepEqual([...retained.keys()], [THEME_STORAGE_KEY]);
});

test('blocked storage access, reads and writes cannot prevent startup or changing the current page', () => {
  const unavailable = () => { throw new Error('Storage unavailable'); };
  assert.equal(readTheme(unavailable), 'dark');
  assert.equal(readTheme(() => ({ getItem: unavailable })), 'dark');
  const fixture = documentFixture();
  const context = { document: fixture.document, get localStorage() { return unavailable(); } };
  assert.doesNotThrow(() => runInNewContext(bootstrap!, context));
  assert.equal(fixture.dataset.theme, 'dark');
  applyTheme('light', fixture.document);
  assert.doesNotThrow(() => saveTheme('light', unavailable));
  assert.doesNotThrow(() => saveTheme('light', () => ({ setItem: unavailable })));
  assert.equal(fixture.dataset.theme, 'light');
  assert.equal(fixture.meta.content, THEME_COLORS.light);
});

function luminance(hex: string): number {
  const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + .05) / (values[1] + .05);
}

test('both theme palettes keep normal text, action labels and outcome text at least 4.5:1', () => {
  const css = readFileSync(new URL('../../apps/web/src/styles.css', import.meta.url), 'utf8');
  const palette = (selector: string) => Object.fromEntries([...css.slice(css.indexOf(selector)).split('}')[0].matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/g)].map(match => [match[1], match[2]]));
  for (const [name, colors] of [['dark', palette(':root {')], ['light', palette(':root[data-theme="light"]')]] as const) {
    const pairs: [string, string][] = ['canvas', 'surface', 'surface-soft', 'surface-raised', 'surface-hover', 'sidebar-bg'].flatMap(background => ['ink', 'text-secondary', 'muted'].map(foreground => [foreground, background] as [string, string]));
    for (const tone of ['positive', 'negative', 'warning', 'info', 'purple', 'accent']) pairs.push([tone, tone + '-soft']);
    pairs.push(['on-action', 'action'], ['on-action', 'action-hover'], ['attention-ink', 'attention-soft'], ['attention-muted', 'attention-soft']);
    for (const [foreground, background] of pairs) {
      const ratio = contrast(colors[foreground], colors[background]);
      assert.ok(ratio >= 4.5, `${name} ${foreground} / ${background}: ${ratio.toFixed(2)}:1`);
    }
  }
});
