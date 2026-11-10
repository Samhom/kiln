const MAX_INPUT = 8_000_000;
const MAX_FILTER = 2_000;
const MAX_STREAM = 10_000;
const MAX_DIFF = 400;
const MAX_PIPES = 12;

class FilterError extends Error {
  constructor(message, index = -1) {
    super(message);
    this.name = 'FilterError';
    this.index = index;
  }
}

function rejectAt(text, index, message) {
  throw new FilterError(place(text, index, message), index);
}

export function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function own(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  const desc = Object.getOwnPropertyDescriptor(value, key);
  if (!desc || !Object.prototype.hasOwnProperty.call(desc, 'value')) return undefined;
  return desc.value;
}

function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positionOf(text, index) {
  let line = 1;
  let column = 1;
  const end = Math.min(index, text.length);
  for (let i = 0; i < end; i += 1) {
    if (text[i] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return {line, column};
}

function jsonError(text, error) {
  const match = /position (\d+)/.exec(String(error && error.message));
  if (!match) return {error: '这不是合法的 JSON，也不是按行分隔的 JSON'};
  const {line, column} = positionOf(text, Number(match[1]));
  return {error: `第 ${line} 行第 ${column} 列附近不是合法的 JSON`, line, column};
}

function parseNdjson(text) {
  const lines = text.split(/\r?\n/);
  const values = [];
  let seen = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    seen += 1;
    try {
      values.push(JSON.parse(line));
    } catch {
      if (seen === 1 && values.length === 0) return null;
      return {ok: false, error: `第 ${i + 1} 行不是合法的 JSON`, line: i + 1, column: 1};
    }
  }
  if (values.length < 2) return null;
  return {ok: true, format: 'ndjson', value: values};
}

export function parseDocument(text) {
  if (typeof text !== 'string') return {ok: false, error: '没有可读的文本'};
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.length > MAX_INPUT) return {ok: false, error: '超过 8MB，窑不打开这么大的文本'};
  if (!text.trim()) return {ok: false, error: '还没有内容'};
  const bytes = new TextEncoder().encode(text).length;
  try {
    return {ok: true, format: 'json', value: JSON.parse(text), bytes};
  } catch (error) {
    const ndjson = parseNdjson(text);
    if (ndjson) return {...ndjson, bytes};
    return {ok: false, ...jsonError(text, error)};
  }
}

export function summarize(value) {
  let nodes = 0;
  let depth = 0;
  let capped = false;
  const walk = (current, level) => {
    if (capped) return;
    nodes += 1;
    if (level > depth) depth = level;
    if (nodes > 200_000 || level > 80) {
      capped = true;
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) walk(item, level + 1);
      return;
    }
    if (!isPlain(current)) return;
    for (const key of Object.keys(current)) walk(own(current, key), level + 1);
  };
  walk(value, 1);
  return {type: typeName(value), nodes, depth, capped};
}

export function deepEqual(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right || Array.isArray(left) !== Array.isArray(right)) return false;
  if (left === null || right === null || typeof left !== 'object') return false;
  if (Array.isArray(left)) {
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
      if (!deepEqual(left[i], right[i])) return false;
    }
    return true;
  }
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(right, key) || !deepEqual(own(left, key), own(right, key))) return false;
  }
  return true;
}

export function formatJq(segments) {
  let out = '.';
  for (const seg of segments) {
    if (seg.type === 'index') out += `[${seg.index}]`;
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(seg.key)) out += `${out.endsWith('.') ? '' : '.'}${seg.key}`;
    else out += `[${JSON.stringify(seg.key)}]`;
  }
  return out;
}

export function formatPointer(segments) {
  return segments.map((seg) => {
    const raw = seg.type === 'index' ? String(seg.index) : String(seg.key);
    return `/${raw.replaceAll('~', '~0').replaceAll('/', '~1')}`;
  }).join('');
}

export function valueAt(value, segments) {
  let current = value;
  for (const seg of segments) {
    if (seg.type === 'index') {
      if (!Array.isArray(current) || seg.index < 0 || seg.index >= current.length) return undefined;
      current = current[seg.index];
    } else if (seg.type === 'key') {
      const next = own(current, seg.key);
      if (next === undefined && (!isPlain(current) || !Object.prototype.hasOwnProperty.call(current, seg.key))) return undefined;
      current = next;
    } else {
      return undefined;
    }
  }
  return current;
}

export function diffValues(left, right) {
  const changes = [];
  const state = {stop: false};
  const emit = (kind, segments, before, after) => {
    if (changes.length >= MAX_DIFF) {
      state.stop = true;
      return;
    }
    changes.push({kind, segments, before, after});
  };
  const visit = (a, b, segments, depth) => {
    if (state.stop || deepEqual(a, b)) return;
    const bothArray = Array.isArray(a) && Array.isArray(b);
    const bothObject = isPlain(a) && isPlain(b);
    if (depth < 40 && (bothArray || bothObject)) {
      if (bothArray) {
        const count = Math.max(a.length, b.length);
        for (let i = 0; i < count; i += 1) {
          if (state.stop) return;
          const next = segments.concat({type: 'index', index: i});
          if (i >= a.length) emit('added', next, undefined, b[i]);
          else if (i >= b.length) emit('removed', next, a[i], undefined);
          else visit(a[i], b[i], next, depth + 1);
        }
        return;
      }
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
      for (const key of keys) {
        if (state.stop) return;
        const next = segments.concat({type: 'key', key});
        const hasLeft = Object.prototype.hasOwnProperty.call(a, key);
        const hasRight = Object.prototype.hasOwnProperty.call(b, key);
        if (!hasLeft) emit('added', next, undefined, own(b, key));
        else if (!hasRight) emit('removed', next, own(a, key), undefined);
        else visit(own(a, key), own(b, key), next, depth + 1);
      }
      return;
    }
    emit('changed', segments, a, b);
  };
  visit(left, right, [], 0);
  return {changes, truncated: state.stop};
}

function place(text, index, message) {
  if (index >= text.length) return `末尾：${message}`;
  return `第 ${index + 1} 个字符：${message}`;
}

function readString(text, index) {
  let value = '';
  let i = index + 1;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') return {value, i: i + 1};
    if (char === '\\') {
      const next = text[i + 1];
      const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (Object.prototype.hasOwnProperty.call(simple, next)) {
        value += simple[next];
        i += 2;
        continue;
      }
      if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
        value += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      rejectAt(text, i, '这个转义窑不认识');
    }
    if (char === '\n' || char === '\r') rejectAt(text, i, '字符串没有结束');
    value += char;
    i += 1;
  }
  rejectAt(text, index, '字符串没有结束');
}

function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === ' ' || char === '\n' || char === '\t' || char === '\r') {
      i += 1;
      continue;
    }
    const index = i;
    if ('|()[]'.includes(char)) {
      const type = { '(': 'lparen', ')': 'rparen', '[': 'lbrack', ']': 'rbrack', '|': 'pipe' }[char];
      tokens.push({type, value: char, index});
      i += 1;
      continue;
    }
    if (char === '.') {
      tokens.push({type: 'dot', value: '.', index});
      i += 1;
      continue;
    }
    if (char === '"') {
      const parsed = readString(text, i);
      tokens.push({type: 'string', value: parsed.value, index});
      i = parsed.i;
      continue;
    }
    const op = /^(~=|!=|==|>=|<=|>|<)/.exec(text.slice(i));
    if (op) {
      tokens.push({type: 'op', value: op[0], index});
      i += op[0].length;
      continue;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      if (!match) rejectAt(text, i, '这个数字写得不对');
      const value = Number(match[0]);
      if (!Number.isFinite(value)) rejectAt(text, i, '这个数字窑放不下');
      tokens.push({type: 'number', value, index});
      i += match[0].length;
      continue;
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
    if (ident) {
      tokens.push({type: 'ident', value: ident[0], index});
      i += ident[0].length;
      continue;
    }
    rejectAt(text, i, '这里有认不出的符号');
  }
  tokens.push({type: 'eof', value: '', index: text.length});
  return tokens;
}

function parseFilter(text) {
  const tokens = tokenize(text);
  let cursor = 0;
  const peek = () => tokens[cursor];
  const expect = (type, message) => {
    const token = peek();
    if (token.type !== type) rejectAt(text, token.index, message);
    cursor += 1;
    return token;
  };
  const eat = (type) => {
    if (peek().type !== type) return false;
    cursor += 1;
    return true;
  };
  const parseBracket = () => {
    expect('lbrack', '这里需要方括号');
    if (eat('rbrack')) return {type: 'iterate'};
    if (peek().type === 'string') {
      const key = expect('string', '这里需要字符串').value;
      expect('rbrack', '字符串键名后面需要 ]');
      return {type: 'key', key};
    }
    if (peek().type === 'number') {
      const token = expect('number', '这里需要下标');
      if (!Number.isSafeInteger(token.value)) rejectAt(text, token.index, '下标要是整数，并且不能太大');
      expect('rbrack', '下标后面需要 ]');
      return {type: 'index', index: token.value};
    }
    rejectAt(text, peek().index, '方括号里写数字、字符串，或留空表示展开');
  };
  const parsePath = () => {
    const start = peek();
    expect('dot', '路径从点开始，例如 .name');
    if (peek().type === 'dot') rejectAt(text, peek().index, '暂不支持 ..');
    const segs = [];
    const takeKey = () => {
      if (peek().type !== 'ident') rejectAt(text, peek().index, '路径这里需要键名或方括号');
      segs.push({type: 'key', key: expect('ident', '路径这里需要键名').value});
    };
    if (peek().type === 'lbrack') segs.push(parseBracket());
    else if (peek().type === 'ident') takeKey();
    while (peek().type === 'dot' || peek().type === 'lbrack') {
      if (eat('dot')) {
        if (peek().type === 'dot') rejectAt(text, peek().index, '暂不支持 ..');
        if (peek().type === 'lbrack') segs.push(parseBracket());
        else takeKey();
      } else {
        segs.push(parseBracket());
      }
    }
    return {type: 'path', segs, index: start.index};
  };
  const parseLiteral = () => {
    const token = peek();
    if (token.type === 'string' || token.type === 'number') {
      cursor += 1;
      return token.value;
    }
    if (token.type === 'ident' && (token.value === 'true' || token.value === 'false' || token.value === 'null')) {
      cursor += 1;
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      return null;
    }
    rejectAt(text, token.index, '这里需要字符串、数字、true、false 或 null');
  };
  const parseCond = () => {
    const path = parsePath();
    if (peek().type !== 'op') return {type: 'truthy', path};
    const op = expect('op', '这里需要比较').value;
    return {type: 'cmp', path, op, literal: parseLiteral()};
  };
  const parseAtom = () => {
    const token = peek();
    if (token.type === 'ident') {
      cursor += 1;
      if (token.value === 'select') {
        expect('lparen', 'select 后面需要 (');
        const cond = parseCond();
        expect('rparen', 'select 的条件没有结束');
        return {type: 'select', cond};
      }
      if (token.value === 'keys' || token.value === 'length' || token.value === 'type') return {type: 'builtin', name: token.value};
      rejectAt(text, token.index, `这里不认识 ${token.value}。路径从点开始，例如 .${token.value}`);
    }
    if (token.type === 'dot') return parsePath();
    rejectAt(text, token.index, '这里需要路径、select、keys、length 或 type');
  };
  let expr = parseAtom();
  let pipes = 0;
  while (eat('pipe')) {
    pipes += 1;
    if (pipes > MAX_PIPES) throw new FilterError('最多串 12 段', peek().index);
    expr = {type: 'pipe', left: expr, right: parseAtom()};
  }
  if (peek().type !== 'eof') rejectAt(text, peek().index, '后面多出来一段');
  return expr;
}

function tooMany() {
  return {ok: false, error: `结果超过 ${MAX_STREAM} 条，把过滤写得更具体一些`};
}

function pushStream(target, values) {
  for (const value of values) {
    if (target.length >= MAX_STREAM) return false;
    target.push(value);
  }
  return true;
}

function applyPath(value, segs) {
  let current = [value];
  for (const seg of segs) {
    const next = [];
    for (const item of current) {
      if (seg.type === 'key') {
        if (!isPlain(item) || !Object.prototype.hasOwnProperty.call(item, seg.key)) continue;
        next.push(own(item, seg.key));
      } else if (seg.type === 'index') {
        if (!Array.isArray(item)) continue;
        const index = seg.index < 0 ? item.length + seg.index : seg.index;
        if (index >= 0 && index < item.length) next.push(item[index]);
      } else if (Array.isArray(item)) {
        for (const entry of item) {
          if (next.length >= MAX_STREAM) return tooMany();
          next.push(entry);
        }
      } else if (isPlain(item)) {
        for (const key of Object.keys(item)) {
          if (next.length >= MAX_STREAM) return tooMany();
          next.push(own(item, key));
        }
      } else {
        return {ok: false, error: '[] 只能展开数组或对象'};
      }
      if (next.length > MAX_STREAM) return tooMany();
    }
    current = next;
  }
  return {ok: true, values: current};
}

function compare(op, left, right) {
  if (op === '==') return deepEqual(left, right);
  if (op === '!=') return !deepEqual(left, right);
  if (op === '~=') return typeof left === 'string' && typeof right === 'string' && left.includes(right);
  if (typeof left !== 'number' || typeof right !== 'number') return false;
  if (op === '>') return left > right;
  if (op === '<') return left < right;
  if (op === '>=') return left >= right;
  if (op === '<=') return left <= right;
  return false;
}

function matchCond(cond, value) {
  const got = applyPath(value, cond.path.segs);
  if (!got.ok) return got;
  if (got.values.length > 1) return {ok: false, error: 'select 里的路径要对到一个值，展开请写在 select 前面'};
  if (got.values.length === 0) return {ok: true, yes: false};
  const left = got.values[0];
  if (cond.type === 'truthy') return {ok: true, yes: left !== null && left !== false};
  return {ok: true, yes: compare(cond.op, left, cond.literal)};
}

function applyBuiltin(name, value) {
  if (name === 'type') return {ok: true, values: [typeName(value)]};
  if (name === 'length') {
    if (typeof value === 'string' || Array.isArray(value)) return {ok: true, values: [value.length]};
    if (isPlain(value)) return {ok: true, values: [Object.keys(value).length]};
    return {ok: false, error: 'length 只能用于字符串、数组或对象'};
  }
  if (Array.isArray(value)) return {ok: true, values: [value.map((_, index) => index)]};
  if (isPlain(value)) return {ok: true, values: [Object.keys(value)]};
  return {ok: false, error: 'keys 只能用于数组或对象'};
}

function evaluate(expr, input) {
  if (expr.type === 'pipe') {
    const left = evaluate(expr.left, input);
    if (!left.ok) return left;
    const values = [];
    for (const value of left.values) {
      const right = evaluate(expr.right, [value]);
      if (!right.ok) return right;
      if (!pushStream(values, right.values)) return tooMany();
    }
    return {ok: true, values};
  }
  if (expr.type === 'path') {
    const values = [];
    for (const value of input) {
      const step = applyPath(value, expr.segs);
      if (!step.ok) return step;
      if (!pushStream(values, step.values)) return tooMany();
    }
    return {ok: true, values};
  }
  if (expr.type === 'select') {
    const values = [];
    for (const value of input) {
      const pass = matchCond(expr.cond, value);
      if (!pass.ok) return pass;
      if (pass.yes) values.push(value);
    }
    return {ok: true, values};
  }
  if (expr.type === 'builtin') {
    const values = [];
    for (const value of input) {
      const applied = applyBuiltin(expr.name, value);
      if (!applied.ok) return applied;
      if (!pushStream(values, applied.values)) return tooMany();
    }
    return {ok: true, values};
  }
  return {ok: false, error: '这种过滤还不会算'};
}

export function runFilter(value, source) {
  if (typeof source !== 'string') return {ok: false, error: '过滤不是文本'};
  const text = source.trim();
  if (text.length > MAX_FILTER) return {ok: false, error: '过滤超过 2000 个字符'};
  if (!text || text === '.') return {ok: true, values: [value]};
  try {
    return evaluate(parseFilter(text), [value]);
  } catch (error) {
    if (error instanceof FilterError) return {ok: false, error: error.message, index: error.index};
    throw error;
  }
}

function joinPath(prefix, key) {
  const piece = formatJq([{type: 'key', key}]);
  return prefix ? `${prefix}${piece}` : piece;
}

function fieldPaths(object, prefix) {
  const paths = [];
  for (const key of Object.keys(object)) {
    if (paths.length >= 3) break;
    const child = own(object, key);
    const path = joinPath(prefix, key);
    paths.push(Array.isArray(child) && child.some(isPlain) ? `${path}[]` : path);
  }
  return paths;
}

function numberCut(numbers) {
  const unique = [...new Set(numbers.filter((item) => Number.isFinite(item)).slice(0, 20))].sort((a, b) => a - b);
  if (!unique.length) return null;
  return unique[Math.ceil((unique.length - 1) / 2)];
}

function selectOn(rows, sample, arrayPath) {
  const key = Object.keys(sample).find((name) => typeof own(sample, name) === 'number' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  if (!key) return '';
  const cut = numberCut(rows.map((row) => (isPlain(row) ? own(row, key) : undefined)));
  if (cut === null) return '';
  return `${arrayPath} | select(.${key} >= ${JSON.stringify(cut)})`;
}

export function suggestFilters(value) {
  const out = [];
  const add = (text) => {
    if (text && text.length <= MAX_FILTER && !out.includes(text) && out.length < 6) out.push(text);
  };
  if (Array.isArray(value)) {
    const sample = value.find(isPlain);
    add('.[]');
    if (sample) for (const path of fieldPaths(sample, '.[]')) add(path);
    if (sample) add(selectOn(value, sample, '.[]'));
    add('length');
    return out;
  }
  if (!isPlain(value)) return out;
  add('keys');
  for (const path of fieldPaths(value, '')) add(path);
  const arrayKey = Object.keys(value).find((key) => {
    const child = own(value, key);
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && Array.isArray(child) && child.some(isPlain);
  });
  if (arrayKey) {
    add(`.${arrayKey}[]`);
    add(selectOn(own(value, arrayKey), own(value, arrayKey).find(isPlain), `.${arrayKey}[]`));
  }
  add('length');
  return out;
}
