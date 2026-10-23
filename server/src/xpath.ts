/**
 * 精简 XPath 引擎，覆盖 Kazumi 规则里使用的子集：
 *   //tag  //*  /tag  @attr  text()
 *   [@a]  [@a='v']  [contains(@a,'v')]  [starts-with(@a,'v')]  [n]  [not(...)]
 * Kazumi 的规则约定：SearchName / SearchResult 相对 SearchList 节点取，本引擎把开头的 // 视作 .//
 */
type Predicate =
  | { kind: 'attr'; name: string }
  | { kind: 'eq'; name: string; value: string }
  | { kind: 'contains'; name: string; value: string }
  | { kind: 'startsWith'; name: string; value: string }
  | { kind: 'not'; inner: Predicate }
  | { kind: 'index'; index: number };

interface Step {
  axis: 'child' | 'descendant';
  tag: string;
  preds: Predicate[];
  /** 终端：@attr 或 text() */
  terminal?: { kind: 'attr' | 'text'; name?: string };
}

function splitPredicates(raw: string): { head: string; preds: string[] } {
  let depth = 0;
  let quote: string | null = null;
  let head = '';
  const preds: string[] = [];
  let buf = '';
  let inPred = false;
  for (const ch of raw) {
    if (quote) {
      if (inPred) buf += ch;
      else head += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      if (inPred) buf += ch;
      else head += ch;
      continue;
    }
    if (ch === '[') {
      if (depth === 0) { inPred = true; buf = ''; depth = 1; continue; }
      depth++; buf += ch; continue;
    }
    if (ch === ']') {
      depth--;
      if (depth === 0) { inPred = false; preds.push(buf.trim()); continue; }
      buf += ch; continue;
    }
    if (inPred) buf += ch; else head += ch;
  }
  return { head: head.trim(), preds };
}

function parsePredicate(raw: string): Predicate | null {
  const p = raw.trim();
  if (!p) return null;
  if (/^\d+$/.test(p)) return { kind: 'index', index: Number(p) };
  if (p.startsWith('not(') && p.endsWith(')')) {
    const inner = parsePredicate(p.slice(4, -1));
    return inner ? { kind: 'not', inner } : null;
  }
  let m = /^contains\(\s*@([\w:-]+)\s*,\s*(['"])(.*?)\2\s*\)$/.exec(p);
  if (m) return { kind: 'contains', name: m[1], value: m[3] };
  m = /^starts-with\(\s*@([\w:-]+)\s*,\s*(['"])(.*?)\2\s*\)$/.exec(p);
  if (m) return { kind: 'startsWith', name: m[1], value: m[3] };
  m = /^@([\w:-]+)\s*=\s*(['"])(.*?)\2$/.exec(p);
  if (m) return { kind: 'eq', name: m[1], value: m[3] };
  m = /^@([\w:-]+)$/.exec(p);
  if (m) return { kind: 'attr', name: m[1] };
  m = /^text\(\)\s*=\s*(['"])(.*?)\1$/.exec(p);
  if (m) return { kind: 'eq', name: '__text', value: m[2] };
  return null;
}

function parsePath(path: string): Step[] {
  const src = path.trim();
  const steps: Step[] = [];
  let i = 0;
  let axis: 'child' | 'descendant' = 'descendant';
  while (i < src.length) {
    if (src[i] === '/') {
      if (src[i + 1] === '/') { axis = 'descendant'; i += 2; } else { axis = 'child'; i += 1; }
      if (i >= src.length) break;
      // 截取到下一个未加引号的 /
      let j = i, quote: string | null = null, depth = 0;
      for (; j < src.length; j++) {
        const ch = src[j];
        if (quote) { if (ch === quote) quote = null; continue; }
        if (ch === "'" || ch === '"') { quote = ch; continue; }
        if (ch === '[') depth++;
        else if (ch === ']') depth--;
        else if (ch === '/' && depth === 0) break;
      }
      const chunk = src.slice(i, j);
      i = j;
      steps.push(parseStep(axis, chunk));
      continue;
    }
    // 首部没有斜杠时（例如 @href / text()），按 descendant 处理
    let j = i, quote: string | null = null, depth = 0;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === '[') depth++;
      else if (ch === ']') depth--;
      else if (ch === '/' && depth === 0) break;
    }
    steps.push(parseStep(axis, src.slice(i, j)));
    i = j;
  }
  return steps.filter(Boolean);
}

function parseStep(axis: 'child' | 'descendant', chunk: string): Step {
  const { head, preds } = splitPredicates(chunk);
  if (head.startsWith('@')) return { axis, tag: '*', preds: [], terminal: { kind: 'attr', name: head.slice(1) } };
  if (head === 'text()') return { axis, tag: '*', preds: [], terminal: { kind: 'text' } };
  const tag = head === '' || head === '.' ? '*' : head;
  return { axis, tag, preds: preds.map(parsePredicate).filter((p): p is Predicate => !!p) };
}

function attrOf(node: any, name: string): string | null {
  if (name === '__text') return node.textContent ?? null;
  if (!node || typeof node.getAttribute !== 'function') return null;
  return node.getAttribute(name);
}

function matchPredicate(node: any, pred: Predicate): boolean {
  switch (pred.kind) {
    case 'attr': return attrOf(node, pred.name) !== null;
    case 'eq': return (attrOf(node, pred.name) ?? '') === pred.value;
    case 'contains': return (attrOf(node, pred.name) ?? '').includes(pred.value);
    case 'startsWith': return (attrOf(node, pred.name) ?? '').startsWith(pred.value);
    case 'not': return !matchPredicate(node, pred.inner);
    default: return true;
  }
}

function children(node: any): any[] {
  return Array.from(node.children ?? []) as any[];
}

function descendants(node: any, out: any[] = []): any[] {
  for (const child of children(node)) { out.push(child); descendants(child, out); }
  return out;
}

function collect(root: any, step: Step): any[] {
  const pool = step.axis === 'descendant' ? descendants(root) : children(root);
  const filtered = pool.filter((n) => step.tag === '*' || (n.localName ?? n.tagName ?? '').toLowerCase() === step.tag.toLowerCase());
  let result = filtered.filter((n) => step.preds.filter((p) => p.kind !== 'index').every((p) => matchPredicate(n, p)));
  const idxs = step.preds.filter((p): p is { kind: 'index'; index: number } => p.kind === 'index');
  if (idxs.length) result = result.filter((_, i) => idxs.some((p) => p.index === i + 1));
  return result;
}

export function evaluate(root: any, path: string): { nodes: any[]; value: string | null } {
  const steps = parsePath(path);
  if (!steps.length) return { nodes: [], value: null };
  let current: any[] = [root];
  for (let s = 0; s < steps.length; s++) {
    const step = steps[s];
    const next: any[] = [];
    for (const node of current) next.push(...collect(node, step));
    if (step.terminal) {
      const first = next[0];
      if (!first) return { nodes: [], value: null };
      const value = step.terminal.kind === 'text'
        ? (first.textContent ?? '').trim()
        : (first.getAttribute?.(step.terminal.name!) ?? null);
      return { nodes: next, value: value === null ? null : value.trim() };
    }
    current = dedupe(next);
    if (!current.length) return { nodes: [], value: null };
  }
  return { nodes: current, value: current[0]?.textContent?.trim() ?? null };
}

function dedupe(nodes: any[]): any[] {
  return Array.from(new Set(nodes));
}

export function selectNodes(root: any, path: string): any[] {
  const steps = parsePath(path);
  if (!steps.length) return [];
  let current: any[] = [root];
  for (const step of steps) {
    const next: any[] = [];
    for (const node of current) next.push(...collect(node, step));
    current = dedupe(next);
    if (!current.length) return [];
  }
  return current;
}

export function selectValue(node: any, path: string): string | null {
  if (!path) return null;
  const { value } = evaluate(node, path);
  return value && value.length ? value : null;
}
