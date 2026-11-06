import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {diffValues, formatJq, formatPointer, parseDocument, runFilter, suggestFilters, valueAt} from '../engine.mjs';
import {samples} from '../samples.mjs';
import {createApp} from '../server.mjs';

test('parses JSON, NDJSON, a BOM, and points at the broken line', () => {
  assert.equal(parseDocument('\uFEFF{"a":1}').value.a, 1);
  const lines = parseDocument('{"ok":true}\n{"ok":false}\n');
  assert.equal(lines.format, 'ndjson');
  assert.equal(lines.value.length, 2);
  const broken = parseDocument('{\n  "a": 1,\n}\n');
  assert.match(broken.error, /第 3 行/);
  assert.equal(broken.line, 3);
  assert.ok(broken.column >= 1);
  const ndjson = parseDocument('{"ok":true}\n[\n');
  assert.equal(ndjson.error, '第 2 行不是合法的 JSON');
  assert.equal(ndjson.line, 2);
  assert.equal(parseDocument('').error, '还没有内容');
  assert.match(parseDocument('x'.repeat(8_000_001)).error, /8MB/);
});

test('suggests filters that fit the open document', () => {
  const order = parseDocument(samples.order.a).value;
  const hints = suggestFilters(order);
  assert.ok(hints.includes('keys'));
  assert.ok(hints.includes('.items[]'));
  const select = hints.find((item) => item.startsWith('.items[] | select(.price >= '));
  const paid = runFilter(order, select);
  assert.ok(paid.values.length >= 1);
  assert.ok(paid.values.length < order.items.length);
  const log = suggestFilters(parseDocument(samples.log.a).value);
  assert.ok(log.includes('.[]'));
  assert.ok(log.some((item) => item.includes('.status')));
  assert.ok(suggestFilters({买家: 1}).includes('.["买家"]'));
  assert.deepEqual(suggestFilters(null), []);
});

test('filters the order, the log, and a Chinese key without executing text', () => {
  const order = parseDocument(samples.order.a);
  const paid = runFilter(order.value, samples.order.filter);
  assert.deepEqual(paid.values.map((item) => item.sku), ['cup-ash', 'bowl-ember']);
  assert.equal(runFilter(order.value, '.items[-1].name').values[0], '开片盖');
  assert.equal(runFilter(order.value, '.items | length').values[0], 3);
  assert.equal(runFilter(order.value, 'select(.note)').values.length, 0);
  assert.equal(runFilter(order.value, '.missing.city').ok, true);
  assert.equal(runFilter(order.value, '.missing.city').values.length, 0);
  const log = runFilter(parseDocument(samples.log.a).value, samples.log.filter);
  assert.equal(log.values.length, 1);
  assert.equal(log.values[0].status, 500);
  assert.equal(runFilter(parseDocument('{"买家":"林夏"}').value, '.["买家"]').values[0], '林夏');
  assert.equal(runFilter(parseDocument('{"__proto__":{"x":1},"a":2}').value, '.__proto__.x').values[0], 1);
  assert.equal(({}).x, undefined);
  for (const source of ['process.exit(1)', 'constructor.constructor("return 1")()', '..name', 'select(.items[])']) {
    const result = runFilter(order.value, source);
    assert.equal(result.ok, false, source);
  }
  assert.equal(runFilter([1, 2], '.[] | select(. >= 2)').values[0], 2);
  assert.match(runFilter({name: '灰釉杯'}, 'select(.name ~= "杯")').values[0].name, /杯/);
});

test('stops a wide expansion and formats paths', () => {
  const wide = runFilter(Array.from({length: 10001}, (_, index) => index), '.[]');
  assert.equal(wide.ok, false);
  assert.equal(formatJq([]), '.');
  assert.equal(formatJq([{type: 'key', key: 'items'}, {type: 'index', index: 0}]), '.items[0]');
  assert.equal(formatJq([{type: 'key', key: 'a/b'}]), '.["a/b"]');
  assert.equal(formatPointer([{type: 'key', key: 'a/b'}, {type: 'key', key: 'a~b'}]), '/a~1b/a~0b');
  assert.equal(valueAt({items: [null, {name: '赤泥碗'}]}, [{type: 'key', key: 'items'}, {type: 'index', index: 1}, {type: 'key', key: 'name'}]), '赤泥碗');
});

test('diffs the firing configs by field and caps a long list', () => {
  const diff = diffValues(parseDocument(samples.config.a).value, parseDocument(samples.config.b).value);
  assert.deepEqual(diff.changes.map((change) => `${change.kind} ${formatJq(change.segments)}`), [
    'changed .cone',
    'changed .holdMinutes',
    'changed .glazes[1]',
    'removed .note',
    'added .vent'
  ]);
  assert.equal(diffValues({same: 1}, {same: 1}).changes.length, 0);
  const before = {};
  const after = {};
  for (let i = 0; i < 450; i += 1) {
    before[`k${i}`] = 1;
    after[`k${i}`] = 2;
  }
  const capped = diffValues(before, after);
  assert.equal(capped.changes.length, 400);
  assert.equal(capped.truncated, true);
});

test('the page is static, local, and does not execute its input', async () => {
  for (const name of ['engine.mjs', 'app.js', 'server.mjs']) {
    const source = await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\beval\s*\(/);
    assert.doesNotMatch(source, /\bnew\s+Function\b/);
    assert.doesNotMatch(source, /innerHTML/);
    assert.doesNotMatch(source, /document\.write/);
    assert.doesNotMatch(source, /child_process/);
  }
  const app = createApp();
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  try {
    const port = app.address().port;
    const home = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(await home.text(), /Kiln/);
    const head = await fetch(`http://127.0.0.1:${port}/app.js`, {method: 'HEAD'});
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const missing = await fetch(`http://127.0.0.1:${port}/package.json`);
    assert.equal(missing.status, 404);
    const posted = await fetch(`http://127.0.0.1:${port}/`, {method: 'POST'});
    assert.equal(posted.status, 405);
    const encoded = await fetch(`http://127.0.0.1:${port}/%2e%2e%2fpackage.json`);
    assert.equal(encoded.status, 404);
  } finally {
    app.close();
    await once(app, 'close');
  }
});
