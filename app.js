import {diffValues, formatJq, formatPointer, parseDocument, runFilter, suggestFilters, summarize, typeName, valueAt} from './engine.mjs';
import {samples} from './samples.mjs';

const HINTS = ['.items[] | select(.price >= 80)', '.[] | select(.status >= 500)', '.buyer.city', 'keys'];
const TYPE_LABEL = {object: '对象', array: '数组', string: '字符串', number: '数字', boolean: '布尔', null: 'null'};
const KIND_LABEL = {added: '增', removed: '删', changed: '改'};

const state = {
  mode: 'view',
  view: 'tree',
  filter: '',
  find: '',
  hit: 0,
  hits: [],
  pendingScroll: false,
  selection: [],
  pick: {segments: [], value: undefined},
  sort: null,
  collapsed: new Set(),
  opened: new Set(),
  expansion: null,
  diffKind: 'all',
  glance: false,
  treeRows: [],
  follow: false,
  wrap: false,
  diffChanges: [],
  docs: {
    a: {text: '', parsed: null, note: ''},
    b: {text: '', parsed: null, note: ''}
  },
  undo: {a: '', b: ''},
  outcome: null,
  display: undefined
};
const timers = {a: 0, b: 0, filter: 0};
let copyTimer = 0;

const els = {
  main: document.querySelector('#main'),
  sourceA: document.querySelector('#source-a'),
  sourceB: document.querySelector('#source-b'),
  modeView: document.querySelector('#mode-view'),
  modeCompare: document.querySelector('#mode-compare'),
  textA: document.querySelector('#text-a'),
  textB: document.querySelector('#text-b'),
  badgeA: document.querySelector('#badge-a'),
  badgeB: document.querySelector('#badge-b'),
  linesA: document.querySelector('#lines-a'),
  linesB: document.querySelector('#lines-b'),
  msgA: document.querySelector('#msg-a'),
  msgB: document.querySelector('#msg-b'),
  jumpA: document.querySelector('#jump-a'),
  jumpB: document.querySelector('#jump-b'),
  undoA: document.querySelector('#undo-a'),
  undoB: document.querySelector('#undo-b'),
  filter: document.querySelector('#filter'),
  filterForm: document.querySelector('#filter-form'),
  filterMsg: document.querySelector('#filter-msg'),
  jumpFilter: document.querySelector('#jump-filter'),
  chips: document.querySelector('#chips'),
  summary: document.querySelector('#summary'),
  context: document.querySelector('#context'),
  crumbs: document.querySelector('#crumbs'),
  pathJq: document.querySelector('#path-jq'),
  pathPointer: document.querySelector('#path-pointer'),
  copyState: document.querySelector('#copy-state'),
  find: document.querySelector('#find'),
  findCount: document.querySelector('#find-count'),
  stage: document.querySelector('#stage'),
  treeTools: document.querySelector('#tree-tools'),
  rawTools: document.querySelector('#raw-tools'),
  toggleWrap: document.querySelector('#toggle-wrap'),
  tabs: [...document.querySelectorAll('[data-view]')]
};

function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readOwn(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  const desc = Object.getOwnPropertyDescriptor(value, key);
  if (!desc || !Object.prototype.hasOwnProperty.call(desc, 'value')) return undefined;
  return desc.value;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function cellText(value) {
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 160)}…` : value;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `数组 · ${value.length}`;
  return `对象 · ${Object.keys(value).length} 个键`;
}

function previewPrimitive(value) {
  if (typeof value === 'string') return JSON.stringify(value.length > 120 ? `${value.slice(0, 120)}…` : value);
  return JSON.stringify(value);
}

function previewBranch(value) {
  if (Array.isArray(value)) return `数组 · ${value.length}`;
  return `对象 · ${Object.keys(value).length} 个键`;
}

function childCount(value) {
  if (Array.isArray(value)) return value.length;
  if (isPlain(value)) return Object.keys(value).length;
  return 0;
}

function isBranch(value) {
  return Array.isArray(value) || isPlain(value);
}

function segmentLabel(seg) {
  return seg.type === 'index' ? `[${seg.index}]` : seg.key;
}

function fillMatch(element, text, query) {
  const source = String(text);
  const needle = query.trim();
  if (!needle) {
    element.textContent = source;
    return;
  }
  const at = source.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) {
    element.textContent = source;
    return;
  }
  element.replaceChildren();
  if (at > 0) element.append(source.slice(0, at));
  const mark = document.createElement('mark');
  mark.textContent = source.slice(at, at + needle.length);
  element.append(mark);
  const rest = source.slice(at + needle.length);
  if (rest) element.append(rest);
}

function compactJson(value) {
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

function readRecent() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem('kiln.filters') || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => typeof item === 'string' && item.length <= 2000).slice(0, 6);
  } catch {
    return [];
  }
}

function writeRecent(filters) {
  try {
    sessionStorage.setItem('kiln.filters', JSON.stringify(filters.slice(0, 6)));
  } catch {
    // 记不住最近的过滤也不影响使用。
  }
}

function remember(filter) {
  const text = filter.trim();
  if (!text || text === '.' || text.length > 2000) return;
  writeRecent([text, ...readRecent().filter((item) => item !== text)]);
}

function forget(filter) {
  writeRecent(readRecent().filter((item) => item !== filter));
}

function flash(message) {
  els.copyState.textContent = message;
  window.clearTimeout(copyTimer);
  copyTimer = window.setTimeout(() => {
    els.copyState.textContent = '';
  }, 1600);
}

function usePath() {
  if (!state.selection.length) {
    flash('先在右边点一行');
    return;
  }
  const current = state.filter.trim();
  if (current && current !== '.') {
    flash('先清除过滤，这条路径才对得上原文');
    return;
  }
  els.filter.value = formatJq(state.selection);
  window.clearTimeout(timers.filter);
  applyFilter({rememberResult: true});
}

function downloadResult() {
  if (state.display === undefined) {
    flash('还没有可下载的结果');
    return;
  }
  const blob = new Blob([`${JSON.stringify(state.display, null, 2)}\n`], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'kiln-result.json';
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  flash('已开始下载');
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    flash(message || '已复制');
  } catch {
    flash('浏览器没有允许复制，可以选中上面的路径');
  }
}

function invalidate() {
  state.selection = [];
  state.collapsed = new Set();
  state.opened = new Set();
  state.expansion = null;
  state.sort = null;
  state.hit = 0;
  state.pendingScroll = false;
}

function compute() {
  if (!state.docs.a.parsed?.ok) {
    state.outcome = null;
    state.display = undefined;
    state.pick = {segments: [], value: undefined};
    return;
  }
  const outcome = runFilter(state.docs.a.parsed.value, state.filter);
  state.outcome = outcome;
  if (!outcome.ok || outcome.values.length === 0) {
    state.display = undefined;
    state.pick = {segments: [], value: undefined};
    return;
  }
  state.display = outcome.values.length === 1 ? outcome.values[0] : outcome.values;
  state.pick = {segments: [], value: state.display};
}

function parseSide(side) {
  const doc = state.docs[side];
  doc.parsed = parseDocument(doc.text);
  if (side === 'a') {
    invalidate();
    compute();
  }
  refresh();
}

function stash(side) {
  const text = state.docs[side].text;
  if (text) state.undo[side] = text;
}

function setText(side, text, note = '', options = {}) {
  const doc = state.docs[side];
  if (!options.keepUndo && doc.text && doc.text !== text) stash(side);
  doc.text = text;
  doc.note = note;
  (side === 'a' ? els.textA : els.textB).value = text;
  window.clearTimeout(timers[side]);
  parseSide(side);
}

function undoText(side) {
  const previous = state.undo[side];
  if (!previous) return;
  state.undo[side] = '';
  setText(side, previous, '已撤销', {keepUndo: true});
}

function isOpen(pointer, depth, value) {
  if (!isBranch(value) || childCount(value) === 0) return false;
  if (state.collapsed.has(pointer)) return false;
  if (state.opened.has(pointer)) return true;
  if (state.expansion === 'shut') return false;
  if (state.expansion === 'open') return true;
  if (depth === 0) return childCount(value) <= 80;
  if (depth === 1) return childCount(value) <= 24;
  return false;
}

function collectHits(value, query) {
  const hits = [];
  if (!query) return hits;
  const needle = query.toLowerCase();
  let seen = 0;
  const walk = (current, segments) => {
    if (hits.length >= 200 || seen > 50000) return;
    seen += 1;
    const last = segments.at(-1);
    const label = last ? (last.type === 'key' ? last.key : String(last.index)) : '';
    const primitive = current === null || typeof current !== 'object';
    if ((label && label.toLowerCase().includes(needle)) || (primitive && String(current).toLowerCase().includes(needle))) {
      hits.push(segments.map((seg) => ({...seg})));
    }
    if (Array.isArray(current)) current.forEach((item, index) => walk(item, segments.concat({type: 'index', index})));
    else if (isPlain(current)) {
      for (const key of Object.keys(current)) walk(readOwn(current, key), segments.concat({type: 'key', key}));
    }
  };
  walk(value, []);
  return hits;
}

function compareCells(left, right, dir) {
  const empty = (value) => value === undefined || value === null;
  if (empty(left) && empty(right)) return 0;
  if (empty(left)) return 1;
  if (empty(right)) return -1;
  const a = typeof left === 'object' ? cellText(left) : left;
  const b = typeof right === 'object' ? cellText(right) : right;
  if (typeof a === 'number' && typeof b === 'number') return (a - b) * dir;
  return String(a).localeCompare(String(b), 'zh') * dir;
}

function choose(segments, value) {
  state.selection = segments.map((seg) => ({...seg}));
  state.pick = {segments: state.selection, value};
  renderPath();
  renderStage();
}

function valueFor(segments) {
  const roots = [];
  if (state.display !== undefined) roots.push(state.display);
  if (state.docs.a.parsed?.ok) roots.push(state.docs.a.parsed.value);
  if (state.docs.b.parsed?.ok) roots.push(state.docs.b.parsed.value);
  for (const root of roots) {
    if (!segments.length) return root;
    const value = valueAt(root, segments);
    if (value !== undefined) return value;
  }
  return undefined;
}

function renderPath() {
  els.crumbs.replaceChildren();
  const levels = [[]];
  for (let index = 0; index < state.selection.length; index += 1) levels.push(state.selection.slice(0, index + 1));
  levels.forEach((level, index) => {
    if (index > 0) {
      const separator = document.createElement('span');
      separator.className = 'crumb-sep';
      separator.textContent = '/';
      els.crumbs.append(separator);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'crumb';
    button.textContent = level.length ? segmentLabel(level.at(-1)) : '整份';
    if (index === levels.length - 1) button.setAttribute('aria-current', 'location');
    button.addEventListener('click', () => choose(level, valueFor(level)));
    els.crumbs.append(button);
  });
  const path = formatJq(state.selection);
  const pointer = formatPointer(state.selection);
  els.pathJq.textContent = path;
  els.pathPointer.textContent = pointer ? `指针 ${pointer}` : '点一层可以回到那里';
}

function renderShell() {
  els.main.classList.toggle('is-compare', state.mode === 'compare');
  els.sourceB.hidden = state.mode !== 'compare';
  els.modeView.setAttribute('aria-selected', String(state.mode === 'view'));
  els.modeCompare.setAttribute('aria-selected', String(state.mode === 'compare'));
  for (const button of els.tabs) button.setAttribute('aria-selected', String(button.dataset.view === state.view));
  els.treeTools.hidden = state.view !== 'tree' || state.display === undefined;
  els.rawTools.hidden = state.view !== 'raw' || state.display === undefined;
  els.toggleWrap.setAttribute('aria-pressed', String(state.wrap));
  els.find.placeholder = state.view === 'diff' ? '路径或值，回车到下一处差异' : '键或值，回车到下一处';
  if (state.mode === 'compare' && state.view === 'diff') els.context.textContent = '这一页比较左右两份原文，不使用过滤。';
  else if (state.mode === 'compare') els.context.textContent = '树形、表格和文本只看左边这份，并套用过滤。';
  else els.context.textContent = '右边是左边这份 JSON 的结果。';
}

function renderSourceMeta() {
  for (const side of ['a', 'b']) {
    const doc = state.docs[side];
    const badge = side === 'a' ? els.badgeA : els.badgeB;
    const lines = side === 'a' ? els.linesA : els.linesB;
    const msg = side === 'a' ? els.msgA : els.msgB;
    badge.textContent = doc.parsed?.ok ? (doc.parsed.format === 'ndjson' ? 'NDJSON' : 'JSON') : '';
    lines.textContent = doc.text ? `${doc.text.split(/\n/).length} 行` : '';
    const jump = side === 'a' ? els.jumpA : els.jumpB;
    const undo = side === 'a' ? els.undoA : els.undoB;
    undo.hidden = !state.undo[side];
    msg.classList.toggle('is-error', Boolean(doc.text.trim() && doc.parsed && !doc.parsed.ok));
    jump.hidden = !(doc.text.trim() && doc.parsed && !doc.parsed.ok && doc.parsed.line);
    if (!doc.text.trim()) msg.textContent = '';
    else if (!doc.parsed?.ok) msg.textContent = doc.parsed?.error || '';
    else msg.textContent = doc.note || '';
  }
  const failed = Boolean(state.docs.a.text.trim() && state.docs.a.parsed && !state.docs.a.parsed.ok);
  const badFilter = Boolean(state.outcome && !state.outcome.ok);
  els.filterMsg.classList.toggle('is-error', failed || badFilter);
  els.jumpFilter.hidden = !(badFilter && typeof state.outcome?.index === 'number' && state.outcome.index >= 0);
  if (!state.docs.a.text.trim()) els.filterMsg.textContent = '输入后会自动更新右边';
  else if (failed) els.filterMsg.textContent = '左边还不能解析，过滤先停着';
  else if (badFilter) els.filterMsg.textContent = state.outcome.error;
  else if (state.filter.trim() && state.filter.trim() !== '.' && state.outcome?.values.length === 0) els.filterMsg.textContent = '没有匹配。可以改条件，或清除后看回全部';
  else if (state.outcome?.values.length > 1) els.filterMsg.textContent = `${state.outcome.values.length} 条结果，已收成数组，适合切到表格`;
  else els.filterMsg.textContent = state.filter.trim() ? '1 条结果' : '输入后会自动更新右边';
}

function activeHints() {
  if (state.docs.a.parsed?.ok) {
    const suggested = suggestFilters(state.docs.a.parsed.value);
    if (suggested.length) return suggested;
  }
  return HINTS;
}

function chipButton(text) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chip';
  button.textContent = text;
  button.addEventListener('click', () => {
    els.filter.value = text;
    window.clearTimeout(timers.filter);
    applyFilter({rememberResult: true});
  });
  return button;
}

function renderChips() {
  els.chips.replaceChildren();
  const hints = activeHints();
  const recent = readRecent().filter((item) => !hints.includes(item));
  for (const text of hints) els.chips.append(chipButton(text));
  for (const text of recent) {
    const group = document.createElement('span');
    group.className = 'chip-recent';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'chip-x';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `忘掉 ${text}`);
    remove.addEventListener('click', () => {
      forget(text);
      renderChips();
    });
    group.append(chipButton(text), remove);
    els.chips.append(group);
  }
}

function emptyNote(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}

function renderEmpty() {
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';
  const title = document.createElement('h2');
  title.textContent = '先放进一份 JSON';
  const copy = document.createElement('p');
  copy.textContent = '贴上接口响应，或拖进文件。也可以直接打开一份例子，看树形、表格和路径。';
  const row = document.createElement('div');
  row.className = 'samples';
  for (const key of ['order', 'log', 'config']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pill';
    button.textContent = `${samples[key].label} · ${samples[key].hint}`;
    button.addEventListener('click', () => loadSample(key));
    row.append(button);
  }
  wrap.append(title, copy, row);
  return wrap;
}

function drawTree(value, segments, depth, parent, hitSet, current, budget) {
  if (budget.left <= 0) return;
  budget.left -= 1;
  const pointer = formatPointer(segments);
  const open = isOpen(pointer, depth, value);
  const row = document.createElement('div');
  row.className = 'row';
  row.style.setProperty('--depth', String(depth));
  if (hitSet.has(pointer)) row.classList.add('is-hit');
  if (current && pointer === current) row.dataset.current = 'true';
  if (formatPointer(state.selection) === pointer) row.classList.add('is-selected');
  const branch = isBranch(value) && childCount(value) > 0;
  state.treeRows.push({pointer, segments, value, branch, open});
  const twist = document.createElement(branch ? 'button' : 'span');
  twist.className = 'twist';
  twist.textContent = branch ? (open ? '▾' : '▸') : '·';
  if (branch) {
    twist.type = 'button';
    twist.setAttribute('aria-label', open ? '收起' : '展开');
    twist.addEventListener('click', () => {
      if (open) {
        state.collapsed.add(pointer);
        state.opened.delete(pointer);
      } else {
        state.collapsed.delete(pointer);
        state.opened.add(pointer);
      }
      renderStage();
    });
  }
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'node';
  const key = document.createElement('span');
  key.className = 'k';
  fillMatch(key, segments.length ? segmentLabel(segments.at(-1)) : '根', state.find);
  const shown = document.createElement('span');
  if (!isBranch(value)) {
    shown.className = 'v';
    shown.dataset.kind = typeName(value);
    fillMatch(shown, previewPrimitive(value), state.find);
  } else {
    shown.className = 'v dim';
    fillMatch(shown, previewBranch(value), state.find);
  }
  main.append(key, shown);
  main.addEventListener('click', () => choose(segments, value));
  row.append(twist, main);
  parent.append(row);
  if (!open) return;
  const entries = Array.isArray(value)
    ? value.map((item, index) => ({seg: {type: 'index', index}, item}))
    : Object.keys(value).map((keyName) => ({seg: {type: 'key', key: keyName}, item: readOwn(value, keyName)}));
  const room = Math.min(200, budget.left);
  for (const entry of entries.slice(0, room)) drawTree(entry.item, segments.concat(entry.seg), depth + 1, parent, hitSet, current, budget);
  if (entries.length > room) {
    const more = document.createElement('p');
    more.className = 'more';
    more.style.setProperty('--depth', String(depth + 1));
    more.textContent = entries.length > 200
      ? `还有 ${entries.length - 200} 项没画出来。换到表格里看，或把过滤写窄一点。`
      : '展开到这里先停一下。其余可以逐层打开，或改用表格。';
    parent.append(more);
  }
}

function renderTree() {
  state.treeRows = [];
  const tree = document.createElement('div');
  tree.className = 'tree';
  const current = state.hit >= 0 && state.hits[state.hit] ? formatPointer(state.hits[state.hit]) : '';
  const hitSet = new Set(state.hits.map((segments) => formatPointer(segments)));
  drawTree(state.display, [], 0, tree, hitSet, state.find.trim() ? current : '', {left: 800});
  return tree;
}

function searchable(value) {
  if (typeof value === 'string') return value.length > 500 ? value.slice(0, 500) : value;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? '';
  if (Array.isArray(value)) return `数组 ${value.length}`;
  return Object.keys(value).slice(0, 24).join(' ');
}

function rowMatches(item, index, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (String(index).includes(needle)) return true;
  if (!isPlain(item)) return searchable(item).toLowerCase().includes(needle);
  for (const key of Object.keys(item)) {
    if (key.toLowerCase().includes(needle)) return true;
    if (searchable(readOwn(item, key)).toLowerCase().includes(needle)) return true;
  }
  return false;
}

function numberSpan(rows, key) {
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (const row of rows) {
    const value = readOwn(row, key);
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    count += 1;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (count < 2 || min === max) return '';
  return `${min}–${max}`;
}

function markCurrent(row, segments) {
  if (state.hit >= 0 && state.hits[state.hit] && formatPointer(state.hits[state.hit]) === formatPointer(segments)) {
    row.dataset.current = 'true';
  }
}

function tableHits(value, query) {
  if (value === undefined || !query.trim()) return [];
  if (Array.isArray(value)) {
    return value.slice(0, 5000).flatMap((item, index) => (rowMatches(item, index, query) ? [[{type: 'index', index}]] : [])).slice(0, 200);
  }
  if (isPlain(value)) {
    const needle = query.trim().toLowerCase();
    return Object.keys(value).filter((key) => key.toLowerCase().includes(needle) || searchable(readOwn(value, key)).toLowerCase().includes(needle)).slice(0, 200).map((key) => [{type: 'key', key}]);
  }
  return rowMatches(value, 0, query) ? [[{type: 'index', index: 0}]] : [];
}

function headerCell(label, sort) {
  const th = document.createElement('th');
  const button = document.createElement('button');
  button.type = 'button';
  const active = state.sort && state.sort.index === sort.index && state.sort.key === sort.key;
  button.textContent = label + (active ? (state.sort.dir < 0 ? ' ↓' : ' ↑') : '');
  button.addEventListener('click', () => {
    state.sort = active ? {...sort, dir: -state.sort.dir} : {...sort, dir: 1};
    renderStage();
  });
  th.append(button);
  return th;
}

function valueCell(text, segments, value) {
  const td = document.createElement('td');
  const button = document.createElement('button');
  button.type = 'button';
  fillMatch(button, text, state.find);
  if (formatPointer(state.selection) === formatPointer(segments)) td.classList.add('is-selected');
  button.addEventListener('click', () => choose(segments, value));
  td.append(button);
  return td;
}

function tableFrame(noteText, table) {
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  if (noteText) {
    const note = document.createElement('p');
    note.className = 'table-note';
    note.textContent = noteText;
    wrap.append(note);
  }
  wrap.append(table);
  return wrap;
}

function renderObjectTable(rows) {
  const columns = [];
  const seen = new Set();
  for (const row of rows.slice(0, 500)) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
      if (columns.length === 24) break;
    }
    if (columns.length === 24) break;
  }
  const limited = columns.length === 24 && rows.slice(0, 500).some((row) => Object.keys(row).some((key) => !seen.has(key)));
  let indexed = rows.map((item, index) => ({index, item}));
  const huge = indexed.length > 5000;
  const needle = state.find.trim();
  if (huge) indexed = indexed.slice(0, needle ? 5000 : 300);
  const pool = indexed.length;
  if (needle) indexed = indexed.filter((row) => rowMatches(row.item, row.index, needle));
  if (state.sort) {
    const dir = state.sort.dir;
    indexed.sort((a, b) => state.sort.index ? (a.index - b.index) * dir : compareCells(readOwn(a.item, state.sort.key), readOwn(b.item, state.sort.key), dir));
  }
  const clipped = !huge && indexed.length > 300;
  const visible = indexed.slice(0, 300);
  const notes = [];
  if (needle) notes.push(`${huge ? `在前 ${pool} 行里找到 ${indexed.length} 行` : `找到 ${indexed.length} 行`}${indexed.length > 300 ? '，先显示 300 行' : ''}`);
  if (!needle && huge) notes.push('行数很多，表只取前 300 行');
  else if (!needle && clipped) notes.push(`先显示 300 行，共 ${rows.length} 行`);
  if (limited) notes.push('列停在 24 个');
  const table = document.createElement('table');
  const head = document.createElement('tr');
  head.append(headerCell('序号', {index: true, key: '#'}));
  for (const key of columns) {
    const span = numberSpan(indexed.map((row) => row.item), key);
    head.append(headerCell(span ? `${key} · ${span}` : key, {index: false, key}));
  }
  const thead = document.createElement('thead');
  thead.append(head);
  const tbody = document.createElement('tbody');
  for (const row of visible) {
    const tr = document.createElement('tr');
    const segments = [{type: 'index', index: row.index}];
    markCurrent(tr, segments);
    tr.append(valueCell(String(row.index), segments, row.item));
    for (const key of columns) {
      const has = Object.prototype.hasOwnProperty.call(row.item, key);
      const value = has ? readOwn(row.item, key) : undefined;
      tr.append(valueCell(has ? cellText(value) : '', [{type: 'index', index: row.index}, {type: 'key', key}], value));
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return tableFrame(notes.join('，'), table);
}

function renderKeyTable(value) {
  let rows = Object.keys(value).map((key) => ({key, value: readOwn(value, key)}));
  const total = rows.length;
  const needle = state.find.trim();
  if (needle) {
    const lower = needle.toLowerCase();
    rows = rows.filter((row) => row.key.toLowerCase().includes(lower) || searchable(row.value).toLowerCase().includes(lower));
  }
  const found = rows.length;
  if (state.sort?.key === '键') rows.sort((a, b) => a.key.localeCompare(b.key, 'zh') * state.sort.dir);
  if (state.sort?.key === '值') rows.sort((a, b) => compareCells(a.value, b.value, state.sort.dir));
  const clipped = rows.length > 300;
  rows = rows.slice(0, 300);
  const table = document.createElement('table');
  const head = document.createElement('tr');
  head.append(headerCell('键', {index: false, key: '键'}), headerCell('值', {index: false, key: '值'}));
  const thead = document.createElement('thead');
  thead.append(head);
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    const segments = [{type: 'key', key: row.key}];
    markCurrent(tr, segments);
    tr.append(
      valueCell(row.key, segments, row.value),
      valueCell(cellText(row.value), segments, row.value)
    );
    tbody.append(tr);
  }
  table.append(thead, tbody);
  const note = needle
    ? `找到 ${found} 行${clipped ? '，先显示 300 行' : ''}`
    : (clipped ? `先显示 300 行，共 ${total} 个键` : '');
  return tableFrame(note, table);
}

function renderListTable(rows) {
  let indexed = rows.map((item, index) => ({index, item}));
  const needle = state.find.trim();
  if (needle) indexed = indexed.filter((row) => rowMatches(row.item, row.index, needle));
  const found = indexed.length;
  if (state.sort?.key === '值') indexed.sort((a, b) => compareCells(a.item, b.item, state.sort.dir));
  if (state.sort?.index) indexed.sort((a, b) => (a.index - b.index) * state.sort.dir);
  const clipped = indexed.length > 300;
  const table = document.createElement('table');
  const head = document.createElement('tr');
  head.append(headerCell('序号', {index: true, key: '#'}), headerCell('值', {index: false, key: '值'}));
  const thead = document.createElement('thead');
  thead.append(head);
  const tbody = document.createElement('tbody');
  for (const row of indexed.slice(0, 300)) {
    const tr = document.createElement('tr');
    const segments = [{type: 'index', index: row.index}];
    markCurrent(tr, segments);
    tr.append(valueCell(String(row.index), segments, row.item), valueCell(cellText(row.item), segments, row.item));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  const note = needle
    ? `找到 ${found} 行${clipped ? '，先显示 300 行' : ''}`
    : (clipped ? `先显示 300 行，共 ${rows.length} 行` : '');
  return tableFrame(note, table);
}

function renderTable() {
  const value = state.display;
  if (Array.isArray(value) && value.length && value.every(isPlain)) return renderObjectTable(value);
  if (Array.isArray(value)) return renderListTable(value);
  if (isPlain(value)) return renderKeyTable(value);
  return renderListTable([value]);
}

function renderRaw() {
  const wrap = document.createElement('div');
  wrap.className = 'raw-wrap';
  const pre = document.createElement('pre');
  const full = JSON.stringify(state.display, null, 2);
  pre.textContent = full.length > 200000 ? `${full.slice(0, 200000)}\n… 后面省略了，复制值仍是完整结果` : full;
  if (state.wrap) pre.classList.add('is-wrap');
  wrap.append(pre);
  return wrap;
}

function changeText(change) {
  const parts = [formatJq(change.segments)];
  if (change.kind !== 'added') parts.push(compactJson(change.before));
  if (change.kind !== 'removed') parts.push(compactJson(change.after));
  return parts.join('\n').toLowerCase();
}

function renderDiff(diff) {
  const wrap = document.createElement('div');
  wrap.className = 'diff';
  if (state.mode !== 'compare') return wrap.append(emptyNote('先切到比两份，再贴上另一份 JSON。')), wrap;
  if (!state.docs.a.text.trim() || !state.docs.b.text.trim()) return wrap.append(emptyNote('两边都要有原文。')), wrap;
  if (!state.docs.a.parsed?.ok || !state.docs.b.parsed?.ok) return wrap.append(emptyNote('两边都要是合法的 JSON 或 NDJSON。')), wrap;
  if (!diff.changes.length) return wrap.append(emptyNote('两份原文一样。')), wrap;
  if (diff.truncated) wrap.append(emptyNote('先列出 400 处，后面没有继续比。'));
  const counts = {added: 0, removed: 0, changed: 0};
  for (const change of diff.changes) counts[change.kind] += 1;
  const filters = document.createElement('div');
  filters.className = 'diff-filters';
  for (const kind of ['all', 'changed', 'added', 'removed']) {
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.className = 'pill';
    const count = kind === 'all' ? diff.changes.length : counts[kind];
    choice.textContent = `${kind === 'all' ? '全部' : KIND_LABEL[kind]} ${count}`;
    if (state.diffKind === kind) choice.setAttribute('aria-pressed', 'true');
    choice.addEventListener('click', () => {
      state.diffKind = kind;
      renderStage();
    });
    filters.append(choice);
  }
  wrap.append(filters);
  const query = state.find.trim().toLowerCase();
  let visible = diff.changes.filter((change) => state.diffKind === 'all' || change.kind === state.diffKind);
  if (query) visible = visible.filter((change) => changeText(change).includes(query));
  if (!visible.length) {
    wrap.append(emptyNote(query ? '没有找到。' : '这一类里没有差异。'));
    return wrap;
  }
  const current = state.hit >= 0 && state.hits[state.hit] ? formatPointer(state.hits[state.hit]) : '';
  for (const change of visible) {
    const line = document.createElement('div');
    line.className = 'diff-line';
    if (current && formatPointer(change.segments) === current) line.dataset.current = 'true';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `diff-row kind-${change.kind}`;
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = KIND_LABEL[change.kind];
    const path = document.createElement('code');
    fillMatch(path, formatJq(change.segments), state.find);
    button.append(mark, path);
    if (change.kind !== 'added') {
      const before = document.createElement('span');
      before.className = 'diff-value';
      fillMatch(before, compactJson(change.before), state.find);
      button.append(before);
    } else button.append(document.createElement('span'));
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = change.kind === 'changed' ? '→' : '';
    button.append(arrow);
    if (change.kind !== 'removed') {
      const after = document.createElement('span');
      after.className = 'diff-value';
      fillMatch(after, compactJson(change.after), state.find);
      button.append(after);
    }
    button.addEventListener('click', () => choose(change.segments, change.kind === 'removed' ? change.before : change.after));
    const look = document.createElement('button');
    look.type = 'button';
    look.className = 'pill look';
    look.textContent = '只看这一处';
    look.addEventListener('click', () => focusChange(change));
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'pill look';
    copy.textContent = '复制这一处';
    copy.addEventListener('click', () => copyText(changeLine(change), '已复制这一处'));
    line.append(button, look, copy);
    wrap.append(line);
  }
  return wrap;
}

function changeLine(change) {
  const path = formatJq(change.segments);
  if (change.kind === 'added') return `${path} 新增 ${compactJson(change.after)}`;
  if (change.kind === 'removed') return `${path} 删除 ${compactJson(change.before)}`;
  return `${path} ${compactJson(change.before)} → ${compactJson(change.after)}`;
}

function focusChange(change) {
  const path = formatJq(change.segments);
  els.filter.value = path;
  state.filter = path;
  state.mode = 'view';
  state.view = 'tree';
  state.glance = false;
  state.docs.a.note = '';
  invalidate();
  compute();
  if (state.outcome?.ok && state.outcome.values.length) remember(path);
  else if (change.kind === 'added') {
    state.outcome = {ok: true, values: [change.after]};
    state.display = change.after;
    state.pick = {segments: [], value: change.after};
    state.docs.a.note = '这一处是新增，树里显示的是另一份的值，左边原文没变。';
    state.glance = true;
  }
  refresh();
}

function renderSummary(diff) {
  if (state.view === 'diff') {
    if (!diff) els.summary.textContent = '差异';
    else if (!diff.changes.length) els.summary.textContent = '两份原文一样';
    else els.summary.textContent = `${diff.changes.length} 处差异${diff.truncated ? '，后面没有继续比' : ''}`;
    return;
  }
  if (state.display === undefined) {
    els.summary.textContent = state.docs.a.text.trim() ? '没有可显示的结果' : '等一份 JSON';
    return;
  }
  const info = summarize(state.display);
  const bits = [TYPE_LABEL[info.type] || info.type];
  if (state.outcome?.values.length > 1) bits.push(`${state.outcome.values.length} 条`);
  bits.push(`${info.nodes}${info.capped ? '+' : ''} 个节点`);
  bits.push(`深度 ${info.depth}`);
  if (state.docs.a.parsed?.bytes) bits.push(`${formatBytes(state.docs.a.parsed.bytes)} 原文`);
  els.summary.textContent = bits.join(' · ');
}

function syncHits() {
  const query = state.find.trim();
  if (state.view === 'diff') {
    const needle = query.toLowerCase();
    const pool = state.diffChanges.filter((change) => state.diffKind === 'all' || change.kind === state.diffKind);
    state.hits = needle ? pool.filter((change) => changeText(change).includes(needle)).map((change) => change.segments) : [];
  } else if (state.view === 'table') state.hits = tableHits(state.display, query);
  else state.hits = state.display === undefined ? [] : collectHits(state.display, query);
  if (state.hit >= state.hits.length) state.hit = 0;
}

function revealHit() {
  const segments = state.hits[state.hit];
  if (!segments) return;
  if (state.view === 'diff') {
    const change = state.diffChanges.find((item) => formatPointer(item.segments) === formatPointer(segments));
    state.selection = segments.map((seg) => ({...seg}));
    state.pick = {segments: state.selection, value: change ? (change.kind === 'removed' ? change.before : change.after) : undefined};
    state.pendingScroll = true;
    return;
  }
  for (let i = 0; i < segments.length; i += 1) {
    const pointer = formatPointer(segments.slice(0, i));
    state.collapsed.delete(pointer);
    state.opened.add(pointer);
  }
  state.selection = segments.map((seg) => ({...seg}));
  state.pick = {segments: state.selection, value: valueAt(state.display, state.selection)};
  if (state.view === 'raw') state.view = 'tree';
  state.pendingScroll = true;
}

function renderStage() {
  let diff = null;
  if (state.view === 'diff' && state.mode === 'compare' && state.docs.a.parsed?.ok && state.docs.b.parsed?.ok) {
    diff = diffValues(state.docs.a.parsed.value, state.docs.b.parsed.value);
  }
  state.diffChanges = diff?.changes || [];
  syncHits();
  const query = state.find.trim();
  const capped = state.hits.length === 200 ? '，已到上限' : '';
  els.findCount.textContent = !query ? '' : state.hits.length ? (state.hit < 0 ? `${state.hits.length} 处${capped}` : `${state.hit + 1} / ${state.hits.length}${capped}`) : '没有找到';
  renderPath();
  renderSummary(diff);
  let view;
  if (!state.docs.a.text.trim() && state.view !== 'diff') view = renderEmpty();
  else if (state.view === 'diff') view = renderDiff(diff);
  else if (!state.docs.a.parsed?.ok) view = emptyNote(state.docs.a.parsed?.error || '原文还不能解析');
  else if (!state.outcome?.ok) view = emptyNote(state.outcome?.error || '过滤没有算成');
  else if (state.outcome.values.length === 0) view = renderNoMatch();
  else if (state.view === 'table') view = renderTable();
  else if (state.view === 'raw') view = renderRaw();
  else view = renderTree();
  els.stage.replaceChildren(view);
  if (state.pendingScroll) {
    els.stage.querySelector('[data-current="true"]')?.scrollIntoView({block: 'nearest'});
    state.pendingScroll = false;
  }
  if (state.follow) {
    els.stage.querySelector('.row.is-selected')?.scrollIntoView({block: 'nearest'});
    state.follow = false;
  }
}

function refresh() {
  renderShell();
  renderSourceMeta();
  renderChips();
  renderStage();
}

function renderNoMatch() {
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';
  const title = document.createElement('h2');
  title.textContent = '没有留下结果';
  const copy = document.createElement('p');
  copy.textContent = '这条过滤没有对上任何值。';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pill';
  button.textContent = '清除过滤，看回全部';
  button.addEventListener('click', () => {
    els.filter.value = '';
    window.clearTimeout(timers.filter);
    applyFilter();
  });
  wrap.append(title, copy, button);
  return wrap;
}

function applyFilter({rememberResult = false} = {}) {
  if (state.glance) {
    state.glance = false;
    state.docs.a.note = '';
  }
  const next = els.filter.value;
  if (next !== state.filter) {
    state.filter = next;
    state.selection = [];
    state.sort = null;
    state.hit = -1;
    state.pendingScroll = false;
    state.expansion = null;
    state.collapsed = new Set();
    state.opened = new Set();
  }
  compute();
  if (rememberResult && state.outcome?.ok) remember(state.filter);
  refresh();
}

function loadSample(key) {
  const sample = samples[key];
  if (!sample) return;
  stash('a');
  stash('b');
  state.mode = sample.mode;
  state.view = sample.view;
  state.filter = sample.filter;
  els.filter.value = sample.filter;
  state.docs.a.text = sample.a;
  state.docs.b.text = sample.b || '';
  state.docs.a.note = '';
  state.docs.b.note = '';
  els.textA.value = sample.a;
  els.textB.value = sample.b || '';
  state.docs.a.parsed = parseDocument(sample.a);
  state.docs.b.parsed = parseDocument(sample.b || '');
  remember(sample.filter);
  invalidate();
  compute();
  renderChips();
  refresh();
  els.stage.scrollTop = 0;
}

function tidy(side) {
  const doc = state.docs[side];
  if (!doc.parsed?.ok) {
    doc.note = '';
    refresh();
    return;
  }
  const text = doc.parsed.format === 'ndjson'
    ? `${doc.parsed.value.map((item) => JSON.stringify(item)).join('\n')}\n`
    : `${JSON.stringify(doc.parsed.value, null, 2)}\n`;
  setText(side, text, '已整理');
}

function loadFile(file, side) {
  if (!file) return;
  if (side === 'b') state.mode = 'compare';
  if (/^(image|audio|video)\//.test(file.type) || file.type === 'application/pdf' || file.type === 'application/zip' || file.type === 'application/gzip') {
    state.docs[side].note = '';
    (side === 'a' ? els.msgA : els.msgB).textContent = '请打开 JSON、NDJSON 或文本';
    (side === 'a' ? els.msgA : els.msgB).classList.add('is-error');
    renderShell();
    return;
  }
  if (file.size > 8000000) {
    const msg = side === 'a' ? els.msgA : els.msgB;
    msg.textContent = '超过 8MB，窑不打开这么大的文件';
    msg.classList.add('is-error');
    renderShell();
    return;
  }
  const reader = new FileReader();
  reader.onload = () => setText(side, typeof reader.result === 'string' ? reader.result : '', `已打开 ${file.name.slice(0, 80)}`);
  reader.onerror = () => {
    const msg = side === 'a' ? els.msgA : els.msgB;
    msg.textContent = '这个文件没有读出来';
    msg.classList.add('is-error');
  };
  reader.readAsText(file, 'UTF-8');
}

function bindFile(side) {
  const input = document.querySelector(side === 'a' ? '#file-a' : '#file-b');
  const opener = document.querySelector(side === 'a' ? '#open-a' : '#open-b');
  opener.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    loadFile(input.files?.[0], side);
    input.value = '';
  });
}

function bindDrop(element, side) {
  element.addEventListener('dragover', (event) => {
    event.preventDefault();
    element.classList.add('dropping');
  });
  element.addEventListener('dragleave', () => element.classList.remove('dropping'));
  element.addEventListener('drop', (event) => {
    event.preventDefault();
    element.classList.remove('dropping');
    loadFile(event.dataTransfer?.files?.[0], side);
  });
}

function insertSpaces(element) {
  const start = element.selectionStart ?? element.value.length;
  const end = element.selectionEnd ?? start;
  element.setRangeText('  ', start, end, 'end');
  element.dispatchEvent(new Event('input', {bubbles: true}));
}

function focusHit(delta) {
  syncHits();
  if (!state.hits.length) return;
  if (state.hit < 0) state.hit = delta < 0 ? state.hits.length - 1 : 0;
  else state.hit = (state.hit + delta + state.hits.length) % state.hits.length;
  revealHit();
  refresh();
}

function jumpFilter() {
  const index = state.outcome?.index;
  if (typeof index !== 'number' || index < 0) return;
  const raw = els.filter.value;
  const lead = raw.length - raw.trimStart().length;
  const start = lead + index;
  els.filter.focus();
  els.filter.setSelectionRange(start, Math.min(raw.length, start + 1));
}

function jumpToError(side) {
  const doc = state.docs[side];
  const line = doc.parsed?.line;
  if (!line) return;
  const area = side === 'a' ? els.textA : els.textB;
  const lines = doc.text.split('\n');
  let start = 0;
  for (let index = 0; index < line - 1 && index < lines.length; index += 1) start += lines[index].length + 1;
  const length = lines[line - 1]?.length ?? 0;
  const column = Math.max(1, doc.parsed.column || 1);
  area.focus();
  area.setSelectionRange(start + Math.min(length, column - 1), start + length);
  const lineHeight = Number.parseFloat(getComputedStyle(area).lineHeight) || 21;
  area.scrollTop = Math.max(0, (line - 3) * lineHeight);
}

function stepTree(key) {
  if (state.view !== 'tree' || !state.treeRows.length) return false;
  const pointer = formatPointer(state.selection);
  let index = state.treeRows.findIndex((row) => row.pointer === pointer);
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    if (index < 0) index = 0;
    else index += key === 'ArrowDown' ? 1 : -1;
    index = Math.max(0, Math.min(state.treeRows.length - 1, index));
    const row = state.treeRows[index];
    state.follow = true;
    choose(row.segments, row.value);
    return true;
  }
  const row = index < 0 ? null : state.treeRows[index];
  if (!row) return false;
  if (key === 'ArrowRight') {
    if (row.branch && !row.open) {
      state.collapsed.delete(row.pointer);
      state.opened.add(row.pointer);
      state.follow = true;
      refresh();
    }
    return true;
  }
  if (key === 'ArrowLeft') {
    if (row.branch && row.open) {
      state.collapsed.add(row.pointer);
      state.opened.delete(row.pointer);
      state.follow = true;
      refresh();
      return true;
    }
    if (row.segments.length) {
      const parent = row.segments.slice(0, -1);
      state.follow = true;
      choose(parent, valueFor(parent));
    }
    return true;
  }
  return false;
}

function watchText(side) {
  const element = side === 'a' ? els.textA : els.textB;
  element.addEventListener('input', () => {
    state.docs[side].text = element.value;
    state.docs[side].note = '';
    window.clearTimeout(timers[side]);
    timers[side] = window.setTimeout(() => parseSide(side), 250);
    renderSourceMeta();
  });
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      insertSpaces(element);
    }
  });
}

els.modeView.addEventListener('click', () => {
  state.mode = 'view';
  if (state.view === 'diff') state.view = 'tree';
  refresh();
});
els.modeCompare.addEventListener('click', () => {
  state.mode = 'compare';
  state.view = 'diff';
  refresh();
});
for (const button of document.querySelectorAll('[data-sample]')) {
  button.addEventListener('click', () => loadSample(button.dataset.sample));
}
for (const button of els.tabs) {
  button.addEventListener('click', () => {
    state.view = button.dataset.view;
    refresh();
  });
}
els.filterForm.addEventListener('submit', (event) => {
  event.preventDefault();
  window.clearTimeout(timers.filter);
  applyFilter({rememberResult: true});
});
els.filter.addEventListener('input', () => {
  window.clearTimeout(timers.filter);
  els.filterMsg.textContent = '正在更新结果';
  els.filterMsg.classList.remove('is-error');
  timers.filter = window.setTimeout(() => applyFilter(), 280);
});
document.querySelector('#clear-filter').addEventListener('click', () => {
  els.filter.value = '';
  window.clearTimeout(timers.filter);
  applyFilter();
});
els.jumpA.addEventListener('click', () => jumpToError('a'));
els.jumpB.addEventListener('click', () => jumpToError('b'));
els.jumpFilter.addEventListener('click', jumpFilter);
document.querySelector('#tidy-a').addEventListener('click', () => tidy('a'));
document.querySelector('#tidy-b').addEventListener('click', () => tidy('b'));
document.querySelector('#clear-a').addEventListener('click', () => setText('a', ''));
document.querySelector('#clear-b').addEventListener('click', () => setText('b', ''));
els.undoA.addEventListener('click', () => undoText('a'));
els.undoB.addEventListener('click', () => undoText('b'));
document.querySelector('#swap').addEventListener('click', () => {
  stash('a');
  stash('b');
  const a = state.docs.a.text;
  const b = state.docs.b.text;
  state.docs.a.note = '';
  state.docs.b.note = '';
  state.docs.a.text = b;
  state.docs.b.text = a;
  els.textA.value = b;
  els.textB.value = a;
  state.docs.a.parsed = parseDocument(b);
  state.docs.b.parsed = parseDocument(a);
  invalidate();
  compute();
  refresh();
});
document.querySelector('#copy-path').addEventListener('click', () => copyText(formatJq(state.selection), '已复制路径'));
document.querySelector('#use-path').addEventListener('click', usePath);
document.querySelector('#copy-pointer').addEventListener('click', () => {
  const pointer = formatPointer(state.selection);
  copyText(pointer, pointer ? '已复制指针' : '已复制根指针（空字符串）');
});
document.querySelector('#copy-value').addEventListener('click', () => {
  if (state.pick.value === undefined && state.display === undefined) {
    flash('这个路径上没有值');
    return;
  }
  const value = state.pick.segments.length ? state.pick.value : state.display;
  if (value === undefined) {
    flash('这个路径上没有值');
    return;
  }
  copyText(JSON.stringify(value, null, 2), '已复制值');
});
document.querySelector('#download').addEventListener('click', downloadResult);
els.find.addEventListener('input', () => {
  state.find = els.find.value;
  state.hit = -1;
  renderStage();
});
els.find.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  focusHit(event.shiftKey ? -1 : 1);
});
document.querySelector('#expand-all').addEventListener('click', () => {
  state.expansion = 'open';
  state.collapsed = new Set();
  refresh();
});
document.querySelector('#collapse-all').addEventListener('click', () => {
  state.expansion = 'shut';
  state.opened = new Set();
  state.collapsed = new Set();
  refresh();
});
els.toggleWrap.addEventListener('click', () => {
  state.wrap = !state.wrap;
  refresh();
});
document.querySelector('#find-prev').addEventListener('click', () => focusHit(-1));
document.querySelector('#find-next').addEventListener('click', () => focusHit(1));
document.addEventListener('keydown', (event) => {
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
  if (!typing && stepTree(event.key)) {
    event.preventDefault();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    window.clearTimeout(timers.filter);
    applyFilter({rememberResult: true});
  } else if (event.key === '/' && !typing) {
    event.preventDefault();
    els.find.focus();
  }
});
bindFile('a');
bindFile('b');
bindDrop(els.sourceA, 'a');
bindDrop(els.sourceB, 'b');
watchText('a');
watchText('b');
state.docs.a.parsed = parseDocument('');
state.docs.b.parsed = parseDocument('');
renderChips();
refresh();
