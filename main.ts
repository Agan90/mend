// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none. SPEC.md is the contract;
// this file implements it sentence by sentence. Node 22 standard library
// only, run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: one line on stdout, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed; the patch keeps going and nothing is written. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const leadingWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const trailingWs = (s: string): string => s.replace(/[ \t]+$/, '');
const bothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** A file as lines plus its line break and whether it ends with one. */
interface FileState {
  br: '\n' | '\r\n';
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

/** Line equality at a tier: 0 exact, 1 trailing spaces/tabs off, 2 both sides off. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailingWs(a) === trailingWs(b);
  return bothWs(a) === bothWs(b);
}

/** Every 0-based position at or after `from` where O matches the file's lines at a tier. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const start = Math.max(0, from);
  for (let i = start; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (in order) at which O occurs at or after `from`, with its positions. */
function firstTier(lines: string[], o: string[], tiers: number[], from: number): { tier: number; occ: number[] } | null {
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor, at the first tier with one. */
function anchorPos(lines: string[], anchor: string, tiers: number[], from: number): number | null {
  const start = Math.max(0, from);
  for (const t of tiers) {
    for (let i = start; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

/** One line of N: `ctx` is its index in O when it is a context line, else -1. */
interface NewLine {
  text: string;
  ctx: number;
}

/** The lines that replace O at `pos`: context lines as the file's own, other lines re-indented at tier 2. */
function buildReplacement(lines: string[], o: string[], n: NewLine[], pos: number, tier: number): string[] {
  const out: string[] = [];
  for (const nl of n) {
    if (nl.ctx >= 0) {
      out.push(lines[pos + nl.ctx]!);
      continue;
    }
    if (tier === 2) {
      const f = leadingWs(lines[pos]!);
      const p = leadingWs(o[0]!);
      const t = nl.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; nw: string }> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const readExisting = (tree: Tree): string => {
    if (!safePath(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = readExisting(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = readExisting(tree);
      const st = parseFile(before);
      if (line < 0 || line > st.lines.length) throw new Fail('no-match', p);
      st.lines.splice(line, 0, ...add);
      tree.now.set(p, renderFile(st));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One line of a unified hunk body, or of a V4A chunk body. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'backslash';
  text: string;
  raw: string;
}

function bodyLine(line: string): BodyLine {
  if (line === '') return { kind: 'ctx', text: '', raw: line };
  const c = line[0]!;
  if (c === ' ') return { kind: 'ctx', text: line.slice(1), raw: line };
  if (c === '-') return { kind: 'old', text: line.slice(1), raw: line };
  if (c === '+') return { kind: 'new', text: line.slice(1), raw: line };
  return { kind: 'backslash', text: line.slice(1), raw: line };
}

/** A hunk or chunk body as O and N, with N's context lines marked by their O index. */
function splitBody(body: BodyLine[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      n.push({ text: b.text, ctx: o.length });
      o.push(b.text);
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: -1 });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(h: { body: BodyLine[] }): boolean {
  for (let i = h.body.length - 1; i >= 0; i--) {
    const b = h.body[i]!;
    if (b.kind === 'ctx' || b.kind === 'new') return h.body[i + 1]?.kind === 'backslash';
  }
  return false;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

/** A path from a `--- ` or `+++ ` line: after the four characters, up to the first tab, spaces removed, a/ or b/ removed. */
function diffPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p === '/dev/null' ? null : p;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hasPair: boolean;
  hunks: Hunk[];
}

/** Apply a section's hunks in order to a file's lines, tracking the drift d. */
function applyUnifiedHunks(st: FileState, hunks: Hunk[], strict: boolean, path: string): void {
  const tiers = strict ? [0] : [0, 1, 2];
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitBody(h.body);
    if (o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > st.lines.length) pos = st.lines.length;
      const atEnd = pos === st.lines.length;
      st.lines.splice(pos, 0, ...n.map((x) => x.text));
      if (atEnd) st.final = !hunkNoEol(h);
      d += n.length;
      continue;
    }
    const found = firstTier(st.lines, o, tiers, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const runsToEnd = best + o.length === st.lines.length;
    const replacement = buildReplacement(st.lines, o, n, best, found.tier);
    st.lines.splice(best, o.length, ...replacement);
    if (runsToEnd) st.final = !hunkNoEol(h);
    d += n.length - o.length;
  }
}

/** Whether a `\` line follows the section's last `+` line, across all its hunks. */
function lastPlusNoEol(hunks: Hunk[]): boolean {
  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const body = hunks[hi]!.body;
    for (let i = body.length - 1; i >= 0; i--) {
      if (body[i]!.kind === 'new') return body[i + 1]?.kind === 'backslash';
    }
  }
  return false;
}

function unifiedSectionEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safePath(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && newP !== oldP && !safePath(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || sec.isCreate;
    const isDelete = !isCreate && (newP === null || sec.isDelete);
    if (isCreate) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const lines: string[] = [];
      for (const h of sec.hunks) {
        for (const b of h.body) if (b.kind === 'new') lines.push(b.text);
      }
      const final = !lastPlusNoEol(sec.hunks);
      tree.now.set(newP, lines.length === 0 ? '' : lines.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      const text = tree.get(oldP);
      if (text === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const st = parseFile(text);
      applyUnifiedHunks(st, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, renderFile(st));
      tree.moves.push({ old: oldP, nw: newP });
      return;
    }
    if (oldP === null) return;
    const text = tree.get(oldP);
    if (text === null) throw new Fail('missing', oldP);
    const st = parseFile(text);
    applyUnifiedHunks(st, sec.hunks, strict, oldP);
    tree.now.set(oldP, renderFile(st));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let i = 0;
  const inHeader = (): boolean => cur !== null && cur.hunks.length === 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, isCreate: false, isDelete: false, hasPair: false, hunks: [] };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (inHeader() && !cur!.hasPair) {
        cur!.oldPath = diffPath(line);
        cur!.newPath = diffPath(lines[i + 1]!);
        cur!.hasPair = true;
        i += 2;
        continue;
      }
      cur = { oldPath: diffPath(line), newPath: diffPath(lines[i + 1]!), isCreate: false, isDelete: false, hasPair: true, hunks: [] };
      sections.push(cur);
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (inHeader()) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i += 1;
      const body: BodyLine[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bodyLine(bl));
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
      cur.hunks.push({ a, body });
      continue;
    }
    if (inHeader()) {
      if (line.startsWith('rename from ') && !cur!.hasPair) cur!.oldPath = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ') && !cur!.hasPair) cur!.newPath = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur!.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur!.isDelete = true;
    }
    i += 1;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const st = parseFile(text);
    const tiers = strict ? [0] : [0, 1, 2];
    const found = firstTier(st.lines, oldLines, tiers, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const n: NewLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    const replacement = buildReplacement(st.lines, oldLines, n, pos, found.tier);
    st.lines.splice(pos, oldLines.length, ...replacement);
    tree.now.set(path, renderFile(st));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let prevEnd = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchNum = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchNum}`);
      path = prevPath;
    }
    let eq = -1;
    let j = i + 1;
    while (j < lines.length) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
      j += 1;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchNum}`);
    let rep = -1;
    let k = eq + 1;
    while (k < lines.length) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      k += 1;
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchNum}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, raw: Array<{ text: string; num: number }>, lineNum: number, strict: boolean): Edit {
  let idx = 0;
  let moveTo: string | null = null;
  if (idx < raw.length && raw[idx]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[idx]!.text.slice('*** Move to: '.length).trim();
    idx += 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (; idx < raw.length; idx++) {
    const r = raw[idx]!;
    const t = r.text;
    if (t.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchor = t.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      continue;
    }
    if (t.trimEnd() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.num}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${r.num}`);
        cur = { anchor: null, body: [], eof: false };
      }
      cur.body.push(bodyLine(t));
      continue;
    }
    throw new Exit2(`error: parse ${r.num}`);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${lineNum}`);
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safePath(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const st = parseFile(text);
    const tiers = strict ? [0] : [0, 1, 2];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const ap = anchorPos(st.lines, ch.anchor, tiers, cursor);
        if (ap === null) throw new Fail('no-match', path);
        cursor = ap + 1;
      }
      const { o, n } = splitBody(ch.body);
      if (o.length === 0) {
        const pos = ch.eof ? st.lines.length : cursor;
        st.lines.splice(pos, 0, ...n.map((x) => x.text));
        cursor = pos + n.length;
        continue;
      }
      let found: { tier: number; occ: number[] } | null = null;
      if (ch.eof) {
        for (const t of tiers) {
          const occ = occurrences(st.lines, o, t, cursor).filter((p) => p + o.length === st.lines.length);
          if (occ.length > 0) {
            found = { tier: t, occ };
            break;
          }
        }
      } else {
        found = firstTier(st.lines, o, tiers, cursor);
      }
      if (found === null) throw new Fail('no-match', path);
      const pos = found.occ[0]!;
      const replacement = buildReplacement(st.lines, o, n, pos, found.tier);
      st.lines.splice(pos, o.length, ...replacement);
      cursor = pos + replacement.length;
    }
    const out = renderFile(st);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sectionKind = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const edits: Edit[] = [];
  let i = first + 1;
  const end = last;
  while (i < end) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = sectionKind(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const prefixLen = kind === 'add' ? '*** Add File: '.length : kind === 'delete' ? '*** Delete File: '.length : '*** Update File: '.length;
    const path = line.slice(prefixLen).trim();
    const lineNum = i + 1;
    i += 1;
    const raw: Array<{ text: string; num: number }> = [];
    while (i < end && sectionKind(lines[i]!) === null) {
      raw.push({ text: lines[i]!, num: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      for (const r of raw) {
        if (r.text === '' || r.text.startsWith('+')) continue;
        throw new Exit2(`error: parse ${r.num}`);
      }
      edits.push(v4aAddEdit(path, raw.map((r) => (r.text === '' ? '' : r.text.slice(1)))));
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.num}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      edits.push(v4aUpdateEdit(path, raw, lineNum, strict));
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  interface Row {
    kind: string;
    path: string;
    oldPath: string | null;
    sortKey: string;
  }
  const rows: Row[] = [];
  const byPath = new Map<string, Row>();
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const row: Row = { kind: was === null ? 'A' : now === null ? 'D' : 'M', path: p, oldPath: null, sortKey: p };
    rows.push(row);
    byPath.set(p, row);
  }
  const consumed = new Set<Row>();
  const extra: Row[] = [];
  for (const m of tree.moves) {
    const dRow = byPath.get(m.old);
    const aRow = byPath.get(m.nw);
    if (dRow !== undefined && !consumed.has(dRow) && dRow.kind === 'D' && aRow !== undefined && !consumed.has(aRow) && aRow.kind === 'A') {
      consumed.add(dRow);
      consumed.add(aRow);
      extra.push({ kind: 'R', path: m.nw, oldPath: m.old, sortKey: m.nw });
    }
  }
  const finalRows = [...rows.filter((r) => !consumed.has(r)), ...extra].sort((a, b) => byteCmp(a.sortKey, b.sortKey));
  const out: string[] = [];
  for (const r of finalRows) out.push(r.kind === 'R' ? `R ${r.oldPath} -> ${r.path}` : `${r.kind} ${r.path}`);
  out.push(`ok: ${finalRows.length} ${finalRows.length === 1 ? 'file' : 'files'}`);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      if (tree.original(p) === now) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
