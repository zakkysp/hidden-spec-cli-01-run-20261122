// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in patch order, for the `R old -> new` output line. */
  readonly moves: { from: string; to: string }[] = [];
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

/** A file as lines: its line break, and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}
function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** One line of a replacement: `ctx` is its index in the old lines when it is a context line, else null. */
interface NL {
  text: string;
  ctx: number | null;
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** Line equality at a matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}
/** Every 0-based position where O occurs in lines at this tier. */
function occurrences(O: string[], lines: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (!lineEq(O[k]!, lines[i + k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
/** The first tier (0, then 1, then 2; 0 only under --strict) with an occurrence, or null. */
function findTier(O: string[], lines: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(O, lines, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}
/** The lines N writes when it replaces O at position `at`: context lines are the file's own matched lines,
 *  every other line is re-indented at tier 2 (SPEC.md section 5). */
function buildReplacement(O: string[], N: NL[], at: number, lines: string[], tier: number): string[] {
  const out: string[] = [];
  const F = leadWs(lines[at] ?? '');
  const P = leadWs(O[0] ?? '');
  for (const n of N) {
    if (n.ctx !== null) {
      out.push(lines[at + n.ctx]!);
      continue;
    }
    let t = n.text;
    if (tier === 2 && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
    out.push(t);
  }
  return out;
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
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

/** One unified hunk (SPEC.md section 6). */
interface Hunk {
  a: number;
  o: string[];
  n: NL[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noEolPlus: boolean;
}
interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` / `+++ ` line names (null: /dev/null). */
function headerPath(l: string): string | null {
  let p = l.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Parse a unified patch into sections (SPEC.md section 6). */
function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const diffRe = /^diff --git a\/(.+) b\/(.+)$/;
  let cur: Section | null = null;
  let inHeader = false;
  let havePair = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = diffRe.exec(l.trimEnd());
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, create: false, del: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      havePair = false;
      i++;
      continue;
    }
    if (l.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (cur !== null && inHeader && !havePair) {
          cur.oldPath = headerPath(l);
          cur.newPath = headerPath(next);
          havePair = true;
          i += 2;
          continue;
        }
        cur = { oldPath: headerPath(l), newPath: headerPath(next), create: false, del: false, hunks: [] };
        sections.push(cur);
        inHeader = true;
        havePair = true;
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bl);
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const o: string[] = [];
      const n: NL[] = [];
      let lastCtxOrPlus = -1;
      let lastPlus = -1;
      for (let k = 0; k < body.length; k++) {
        const bl = body[k]!;
        if (bl.startsWith(' ')) {
          const t = bl.slice(1);
          o.push(t);
          n.push({ text: t, ctx: o.length - 1 });
          lastCtxOrPlus = k;
        } else if (bl.startsWith('-')) {
          o.push(bl.slice(1));
        } else if (bl.startsWith('+')) {
          n.push({ text: bl.slice(1), ctx: null });
          lastCtxOrPlus = k;
          lastPlus = k;
        } else if (bl === '') {
          o.push('');
          n.push({ text: '', ctx: o.length - 1 });
          lastCtxOrPlus = k;
        }
      }
      const noEol = lastCtxOrPlus >= 0 && lastCtxOrPlus + 1 < body.length && body[lastCtxOrPlus + 1]!.startsWith('\\');
      const noEolPlus = lastPlus >= 0 && lastPlus + 1 < body.length && body[lastPlus + 1]!.startsWith('\\');
      cur.hunks.push({ a, o, n, noEol, noEolPlus });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('rename from ') && !havePair) cur.oldPath = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ') && !havePair) cur.newPath = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
      i++;
      continue;
    }
    i++;
  }
  return sections;
}

/** Apply a section's hunks, in order, to a file's lines (SPEC.md section 6). */
function applyHunks(f: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let lines = f.lines.slice();
  let fin = f.final;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = findTier(h.o, lines, strict);
      if (!found) throw new Fail('no-match', path);
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
      const rep = buildReplacement(h.o, h.n, best, lines, found.tier);
      const ranToEnd = best + h.o.length === lines.length;
      lines.splice(best, h.o.length, ...rep);
      if (ranToEnd) fin = !h.noEol;
      d += h.n.length - h.o.length;
    } else {
      let idx = h.a + d;
      if (idx < 0) idx = 0;
      if (idx > lines.length) idx = lines.length;
      const rep = h.n.map((x) => x.text);
      const ranToEnd = idx === lines.length;
      lines.splice(idx, 0, ...rep);
      if (ranToEnd) fin = !h.noEol;
      d += h.n.length;
    }
  }
  return { lines, br: f.br, final: fin };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((s) => (tree: Tree) => {
    const isCreate = s.oldPath === null || s.create;
    const isDelete = !isCreate && (s.newPath === null || s.del);
    if (isCreate) {
      const p = s.newPath;
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const created: string[] = [];
      for (const h of s.hunks) for (const x of h.n) created.push(x.text);
      let noEol = false;
      for (let k = s.hunks.length - 1; k >= 0; k--) {
        if (s.hunks[k]!.n.some((x) => x.ctx === null)) {
          noEol = s.hunks[k]!.noEolPlus;
          break;
        }
      }
      tree.now.set(p, joinFile({ lines: created, br: '\n', final: created.length > 0 && !noEol }));
      return;
    }
    if (isDelete) {
      const p = s.oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = s.oldPath!;
    const newP = s.newPath!;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const isMove = oldP !== newP;
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const out = joinFile(applyHunks(splitFile(before), s.hunks, strict, oldP));
    tree.now.set(newP, out);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.moves.push({ from: oldP, to: newP });
    }
  });
}

/** One SEARCH/REPLACE block (SPEC.md section 7). */
function srEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, joinFile({ lines: newLines.slice(), br: '\n', final: newLines.length > 0 }));
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const f = splitFile(before);
    const found = findTier(oldLines, f.lines, strict);
    if (!found) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const at = found.occ[0]!;
    const rep = buildReplacement(
      oldLines,
      newLines.map((t) => ({ text: t, ctx: null })),
      at,
      f.lines,
      found.tier,
    );
    const lines = f.lines.slice();
    lines.splice(at, oldLines.length, ...rep);
    tree.now.set(p, joinFile({ lines, br: f.br, final: f.final }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let pos = 0;
  let prevPath: string | null = null;
  let prevEnd = 0;
  while (true) {
    let s = -1;
    for (let k = pos; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        s = k;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let k = s - 1; k >= prevEnd; k--) {
      const t = lines[k]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let k = s + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let gt = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        gt = k;
        break;
      }
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (gt < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, gt), strict));
    prevPath = path;
    prevEnd = gt + 1;
    pos = gt + 1;
  }
  return edits;
}

/** One V4A update chunk (SPEC.md section 8). */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NL[];
}

/** The path a V4A section line names, or null when the line is not that section kind. */
function v4aHead(l: string, kind: string): string | null {
  const pre = `*** ${kind}: `;
  if (l.startsWith(pre)) return l.slice(pre.length).trim();
  if (l === `*** ${kind}:`) return '';
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const addP = v4aHead(l, 'Add File');
    const delP = addP === null ? v4aHead(l, 'Delete File') : null;
    const updP = addP === null && delP === null ? v4aHead(l, 'Update File') : null;
    if (addP === null && delP === null && updP === null) throw new Exit2(`error: parse ${i + 1}`);
    const secLines: { text: string; num: number }[] = [];
    let j = i + 1;
    while (j < last) {
      const sl = lines[j]!;
      if (v4aHead(sl, 'Add File') !== null || v4aHead(sl, 'Delete File') !== null || v4aHead(sl, 'Update File') !== null) break;
      secLines.push({ text: sl, num: j + 1 });
      j++;
    }
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
    if (addP !== null) {
      const fileLines: string[] = [];
      for (const sl of secLines) {
        if (sl.text.startsWith('+')) fileLines.push(sl.text.slice(1));
        else if (sl.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${sl.num}`);
      }
      edits.push((tree: Tree) => {
        if (!safe(addP)) throw new Fail('unsafe', addP);
        if (tree.get(addP) !== null) throw new Fail('exists', addP);
        tree.now.set(addP, joinFile({ lines: fileLines.slice(), br: '\n', final: fileLines.length > 0 }));
      });
      i = j;
      continue;
    }
    if (delP !== null) {
      if (secLines.length > 0) throw new Exit2(`error: parse ${secLines[0]!.num}`);
      edits.push((tree: Tree) => {
        if (!safe(delP)) throw new Fail('unsafe', delP);
        if (tree.get(delP) === null) throw new Fail('missing', delP);
        tree.now.set(delP, null);
      });
      i = j;
      continue;
    }
    const p = updP!;
    let k = 0;
    let moveTo: string | null = null;
    if (k < secLines.length) {
      const mv = secLines[k]!.text;
      if (mv.startsWith('*** Move to: ')) {
        moveTo = mv.slice('*** Move to: '.length).trim();
        k++;
      } else if (mv === '*** Move to:') {
        moveTo = '';
        k++;
      }
    }
    const chunks: VChunk[] = [];
    let cur: VChunk | null = null;
    for (; k < secLines.length; k++) {
      const sl = secLines[k]!;
      const t = sl.text;
      if (t.startsWith('@@')) {
        const anchor = t.slice(2).trim();
        cur = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [] };
        chunks.push(cur);
        continue;
      }
      if (t === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${sl.num}`);
        cur.eof = true;
        cur = null;
        continue;
      }
      if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
        if (cur === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${sl.num}`);
          cur = { anchor: null, eof: false, o: [], n: [] };
          chunks.push(cur);
        }
        if (t.startsWith(' ')) {
          const tx = t.slice(1);
          cur.o.push(tx);
          cur.n.push({ text: tx, ctx: cur.o.length - 1 });
        } else if (t.startsWith('-')) {
          cur.o.push(t.slice(1));
        } else if (t.startsWith('+')) {
          cur.n.push({ text: t.slice(1), ctx: null });
        } else {
          cur.o.push('');
          cur.n.push({ text: '', ctx: cur.o.length - 1 });
        }
        continue;
      }
      throw new Exit2(`error: parse ${sl.num}`);
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push((tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const f = splitFile(before);
      let lines2 = f.lines.slice();
      let cursor = 0;
      for (const c of chunks) {
        if (c.anchor !== null) {
          const found = findTier([c.anchor], lines2.slice(cursor), strict);
          if (!found) throw new Fail('no-match', p);
          cursor = cursor + found.occ[0]! + 1;
        }
        if (c.o.length === 0) {
          const ins = c.eof ? lines2.length : cursor;
          const rep = c.n.map((x) => x.text);
          lines2.splice(ins, 0, ...rep);
          cursor = ins + rep.length;
          continue;
        }
        if (c.eof) {
          const pos = lines2.length - c.o.length;
          if (pos < cursor) throw new Fail('no-match', p);
          let tierFound: number | null = null;
          for (const t of strict ? [0] : [0, 1, 2]) {
            let ok = true;
            for (let kk = 0; kk < c.o.length; kk++) {
              if (!lineEq(c.o[kk]!, lines2[pos + kk]!, t)) {
                ok = false;
                break;
              }
            }
            if (ok) {
              tierFound = t;
              break;
            }
          }
          if (tierFound === null) throw new Fail('no-match', p);
          const rep = buildReplacement(c.o, c.n, pos, lines2, tierFound);
          lines2.splice(pos, c.o.length, ...rep);
          cursor = pos + rep.length;
          continue;
        }
        const found = findTier(c.o, lines2.slice(cursor), strict);
        if (!found) throw new Fail('no-match', p);
        const at = cursor + found.occ[0]!;
        const rep = buildReplacement(c.o, c.n, at, lines2, found.tier);
        lines2.splice(at, c.o.length, ...rep);
        cursor = at + rep.length;
      }
      tree.now.set(moveTo ?? p, joinFile({ lines: lines2, br: f.br, final: f.final }));
      if (moveTo !== null) {
        tree.now.set(p, null);
        tree.moves.push({ from: p, to: moveTo });
      }
    });
    i = j;
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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
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
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const entries: { key: string; line: string }[] = [];
  const coveredOld = new Set<string>();
  const coveredNew = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.from);
    const nowOld = tree.get(m.from);
    const wasNew = tree.original(m.to);
    const nowNew = tree.get(m.to);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      entries.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
      coveredOld.add(m.from);
      coveredNew.add(m.to);
    }
  }
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (coveredOld.has(p) || coveredNew.has(p)) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
