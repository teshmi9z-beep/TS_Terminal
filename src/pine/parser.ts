// Pine Script (v5/v6 subset) parser: logical lines -> tokens -> AST.

export class PineError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(`Ligne ${line} : ${message}`);
    this.line = line;
  }
}

export type Expr =
  | { k: 'num'; id: number; v: number }
  | { k: 'str'; id: number; v: string }
  | { k: 'bool'; id: number; v: boolean }
  | { k: 'na'; id: number }
  | { k: 'color'; id: number; v: string }
  | { k: 'id'; id: number; name: string; line: number }
  | { k: 'hist'; id: number; e: Expr; off: Expr }
  | { k: 'un'; id: number; op: string; e: Expr }
  | { k: 'bin'; id: number; op: string; a: Expr; b: Expr }
  | { k: 'tern'; id: number; c: Expr; a: Expr; b: Expr }
  | { k: 'call'; id: number; fn: string; args: Expr[]; named: Record<string, Expr>; line: number }
  | { k: 'tuple'; id: number; items: Expr[] }
  | { k: 'ifx'; id: number; branches: { cond: Expr | null; body: Stmt[] }[] };

export type Stmt =
  | { k: 'decl'; name: string; e: Expr; isVar: boolean; line: number }
  | { k: 'assign'; name: string; op: string; e: Expr; line: number }
  | { k: 'tupdecl'; names: string[]; e: Expr; line: number }
  | { k: 'expr'; e: Expr; line: number }
  | { k: 'if'; branches: { cond: Expr | null; body: Stmt[] }[]; line: number }
  | { k: 'for'; v: string; from: Expr; to: Expr; by: Expr | null; body: Stmt[]; line: number }
  | { k: 'while'; cond: Expr; body: Stmt[]; line: number }
  | { k: 'break' | 'continue'; line: number }
  | { k: 'fn'; name: string; params: { name: string; def: Expr | null }[]; body: Stmt[]; line: number };

type Line = { indent: number; text: string; no: number };
type Tok = { t: 'num' | 'str' | 'id' | 'color' | 'op'; v: string };

const TYPE_WORDS = new Set(['int', 'float', 'bool', 'color', 'string', 'label', 'line', 'box', 'table', 'series', 'simple', 'const']);
const OPS = [':=', '=>', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '+', '-', '*', '/', '%', '<', '>', '=', '?', ':', ',', '(', ')', '[', ']'];

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

function bracketDelta(code: string): number {
  let d = 0, quote: string | null = null;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') d++;
    else if (ch === ')' || ch === ']') d--;
  }
  return d;
}

// joins wrapped lines (open brackets, trailing operator, or Pine's "indent not
// a multiple of 4" continuation rule) and records each line's block depth
function logicalLines(src: string): Line[] {
  const raw = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Line[] = [];
  let pending: Line | null = null;
  let depth = 0;
  raw.forEach((rawLine, idx) => {
    const code = stripComment(rawLine).replace(/\s+$/, '');
    if (!code.trim()) return;
    const ws = (code.match(/^[ \t]*/)?.[0] ?? '').replace(/\t/g, '    ').length;
    const text = code.trim();
    const continues = pending && (depth > 0 || (/([-+*/%,?:<>=([]|\band|\bor|\bnot)$/.test(pending.text) && !/=>$/.test(pending.text)) || ws % 4 !== 0);
    if (pending && continues) pending.text += ' ' + text;
    else {
      if (pending) out.push(pending);
      pending = { indent: Math.floor(ws / 4), text, no: idx + 1 };
    }
    depth = Math.max(0, depth + bracketDelta(code));
  });
  if (pending) out.push(pending);
  return out;
}

function tokenize(text: string, line: number): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    const rest = text.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/))) { toks.push({ t: 'num', v: m[1] }); i += m[1].length; continue; }
    if ((m = rest.match(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/))) { toks.push({ t: 'color', v: m[0] }); i += m[0].length; continue; }
    if (ch === '"' || ch === "'") {
      let j = i + 1, s = '';
      while (j < text.length && text[j] !== ch) { if (text[j] === '\\' && j + 1 < text.length) { s += text[j + 1] === 'n' ? '\n' : text[j + 1]; j += 2; } else s += text[j++]; }
      if (j >= text.length) throw new PineError('chaîne de caractères non fermée', line);
      toks.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if ((m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/))) { toks.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
    const op = OPS.find((o) => rest.startsWith(o));
    if (op) { toks.push({ t: 'op', v: op }); i += op.length; continue; }
    throw new PineError(`caractère inattendu « ${ch} »`, line);
  }
  return toks;
}

let nodeSeq = 1;

class ExprParser {
  private p = 0;
  private toks: Tok[];
  private line: number;
  constructor(toks: Tok[], line: number) {
    this.toks = toks;
    this.line = line;
  }
  peek(o = 0) { return this.toks[this.p + o]; }
  done() { return this.p >= this.toks.length; }
  isOp(v: string, o = 0) { const t = this.peek(o); return !!t && t.t === 'op' && t.v === v; }
  isWord(v: string, o = 0) { const t = this.peek(o); return !!t && t.t === 'id' && t.v === v; }
  take() { return this.toks[this.p++]; }
  expectOp(v: string) {
    if (!this.isOp(v)) throw new PineError(`« ${v} » attendu${this.peek() ? ` avant « ${this.peek().v} »` : ''}`, this.line);
    this.p++;
  }
  node<T extends Omit<Expr, 'id'>>(n: T): T & { id: number } { return { ...n, id: nodeSeq++ }; }

  parse(): Expr { return this.ternary(); }

  ternary(): Expr {
    const c = this.or();
    if (this.isOp('?')) {
      this.p++;
      const a = this.ternary();
      this.expectOp(':');
      const b = this.ternary();
      return this.node({ k: 'tern', c, a, b } as const);
    }
    return c;
  }
  or(): Expr {
    let a = this.and();
    while (this.isWord('or')) { this.p++; a = this.node({ k: 'bin', op: 'or', a, b: this.and() } as const); }
    return a;
  }
  and(): Expr {
    let a = this.equality();
    while (this.isWord('and')) { this.p++; a = this.node({ k: 'bin', op: 'and', a, b: this.equality() } as const); }
    return a;
  }
  equality(): Expr {
    let a = this.comparison();
    while (this.isOp('==') || this.isOp('!=')) { const op = this.take().v; a = this.node({ k: 'bin', op, a, b: this.comparison() } as const); }
    return a;
  }
  comparison(): Expr {
    let a = this.additive();
    while (this.isOp('<') || this.isOp('>') || this.isOp('<=') || this.isOp('>=')) { const op = this.take().v; a = this.node({ k: 'bin', op, a, b: this.additive() } as const); }
    return a;
  }
  additive(): Expr {
    let a = this.multiplicative();
    while (this.isOp('+') || this.isOp('-')) { const op = this.take().v; a = this.node({ k: 'bin', op, a, b: this.multiplicative() } as const); }
    return a;
  }
  multiplicative(): Expr {
    let a = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) { const op = this.take().v; a = this.node({ k: 'bin', op, a, b: this.unary() } as const); }
    return a;
  }
  unary(): Expr {
    if (this.isOp('-') || this.isOp('+')) { const op = this.take().v; return this.node({ k: 'un', op, e: this.unary() } as const); }
    if (this.isWord('not')) { this.p++; return this.node({ k: 'un', op: 'not', e: this.unary() } as const); }
    return this.postfix();
  }
  postfix(): Expr {
    let e = this.primary();
    while (this.isOp('[')) {
      this.p++;
      const off = this.ternary();
      this.expectOp(']');
      e = this.node({ k: 'hist', e, off } as const);
    }
    return e;
  }
  args(): { args: Expr[]; named: Record<string, Expr> } {
    const args: Expr[] = [];
    const named: Record<string, Expr> = {};
    this.expectOp('(');
    while (!this.isOp(')')) {
      if (this.peek()?.t === 'id' && this.isOp('=', 1)) {
        const name = this.take().v;
        this.p++;
        named[name] = this.ternary();
      } else args.push(this.ternary());
      if (this.isOp(',')) this.p++;
      else if (!this.isOp(')')) throw new PineError('« , » ou « ) » attendu', this.line);
    }
    this.p++;
    return { args, named };
  }
  primary(): Expr {
    const t = this.peek();
    if (!t) throw new PineError('expression incomplète', this.line);
    if (t.t === 'num') { this.p++; return this.node({ k: 'num', v: parseFloat(t.v) } as const); }
    if (t.t === 'str') { this.p++; return this.node({ k: 'str', v: t.v } as const); }
    if (t.t === 'color') { this.p++; return this.node({ k: 'color', v: t.v.toLowerCase() } as const); }
    if (t.t === 'op' && t.v === '(') { this.p++; const e = this.ternary(); this.expectOp(')'); return e; }
    if (t.t === 'op' && t.v === '[') {
      this.p++;
      const items: Expr[] = [];
      while (!this.isOp(']')) { items.push(this.ternary()); if (this.isOp(',')) this.p++; }
      this.p++;
      return this.node({ k: 'tuple', items } as const);
    }
    if (t.t === 'id') {
      this.p++;
      if (t.v === 'true' || t.v === 'false') return this.node({ k: 'bool', v: t.v === 'true' } as const);
      if (t.v === 'na' && !this.isOp('(')) return this.node({ k: 'na' } as const);
      // generic type arguments (array.new<float>) are not supported
      if (this.isOp('(')) {
        const { args, named } = this.args();
        return this.node({ k: 'call', fn: t.v, args, named, line: this.line } as const);
      }
      return this.node({ k: 'id', name: t.v, line: this.line } as const);
    }
    throw new PineError(`« ${t.v} » inattendu`, this.line);
  }
}

function parseExprTokens(toks: Tok[], line: number): Expr {
  const p = new ExprParser(toks, line);
  const e = p.parse();
  if (!p.done()) throw new PineError(`« ${p.peek().v} » inattendu`, line);
  return e;
}

export type Program = { body: Stmt[]; version: number };

export function parsePine(src: string): Program {
  nodeSeq = 1;
  const version = parseInt(src.match(/\/\/\s*@version\s*=\s*(\d+)/)?.[1] ?? '5');
  const lines = logicalLines(src);
  let i = 0;

  function block(indent: number): Stmt[] {
    const out: Stmt[] = [];
    while (i < lines.length) {
      const ln = lines[i];
      if (ln.indent < indent) break;
      if (ln.indent > indent) throw new PineError('indentation inattendue (blocs = 4 espaces ou 1 tabulation)', ln.no);
      out.push(statement(indent));
    }
    return out;
  }

  function subBlock(indent: number, ownerLine: number): Stmt[] {
    if (i >= lines.length || lines[i].indent <= indent) throw new PineError('bloc vide : les lignes suivantes doivent être indentées', ownerLine);
    return block(indent + 1);
  }

  // if / else if / else chains, as statement or as the value of an assignment
  function ifChain(first: Tok[], indent: number, no: number): { cond: Expr | null; body: Stmt[] }[] {
    const branches: { cond: Expr | null; body: Stmt[] }[] = [{ cond: parseExprTokens(first, no), body: subBlock(indent, no) }];
    while (i < lines.length && lines[i].indent === indent && /^else\b/.test(lines[i].text)) {
      const ln = lines[i++];
      const toks = tokenize(ln.text, ln.no).slice(1);
      if (toks[0]?.t === 'id' && toks[0].v === 'if') branches.push({ cond: parseExprTokens(toks.slice(1), ln.no), body: subBlock(indent, ln.no) });
      else { branches.push({ cond: null, body: subBlock(indent, ln.no) }); break; }
    }
    return branches;
  }

  function rhs(toks: Tok[], indent: number, no: number): Expr {
    if (toks[0]?.t === 'id' && toks[0].v === 'if') return { k: 'ifx', id: nodeSeq++, branches: ifChain(toks.slice(1), indent, no) };
    if (toks[0]?.t === 'id' && toks[0].v === 'switch') throw new PineError('« switch » n’est pas encore pris en charge (utilisez if / else if)', no);
    return parseExprTokens(toks, no);
  }

  function statement(indent: number): Stmt {
    const ln = lines[i++];
    const no = ln.no;
    let toks = tokenize(ln.text, no);
    const word = (k: number) => (toks[k]?.t === 'id' ? toks[k].v : null);
    const op = (k: number) => (toks[k]?.t === 'op' ? toks[k].v : null);

    const w0 = word(0);
    if (w0 === 'import' || w0 === 'export' || w0 === 'method' || w0 === 'type') throw new PineError(`« ${w0} » n’est pas pris en charge`, no);
    if (w0 === 'if') return { k: 'if', branches: ifChain(toks.slice(1), indent, no), line: no };
    if (w0 === 'else') throw new PineError('« else » sans « if »', no);
    if (w0 === 'break' || w0 === 'continue') return { k: w0, line: no };
    if (w0 === 'while') return { k: 'while', cond: parseExprTokens(toks.slice(1), no), body: subBlock(indent, no), line: no };
    if (w0 === 'for') {
      const v = word(1);
      if (!v || op(2) !== '=') throw new PineError('syntaxe attendue : for i = début to fin [by pas]', no);
      if (toks.some((t) => t.t === 'id' && t.v === 'in')) throw new PineError('« for ... in » n’est pas pris en charge', no);
      const toIdx = toks.findIndex((t, k) => k > 2 && t.t === 'id' && t.v === 'to');
      const byIdx = toks.findIndex((t, k) => k > toIdx && t.t === 'id' && t.v === 'by');
      if (toIdx < 0) throw new PineError('« to » attendu dans la boucle for', no);
      const from = parseExprTokens(toks.slice(3, toIdx), no);
      const to = parseExprTokens(toks.slice(toIdx + 1, byIdx < 0 ? undefined : byIdx), no);
      const by = byIdx < 0 ? null : parseExprTokens(toks.slice(byIdx + 1), no);
      return { k: 'for', v, from, to, by, body: subBlock(indent, no), line: no };
    }

    // function definition: name(params) => expr | block
    if (w0 && op(1) === '(') {
      let d = 0, close = -1;
      for (let k = 1; k < toks.length; k++) {
        if (toks[k].t === 'op' && toks[k].v === '(') d++;
        if (toks[k].t === 'op' && toks[k].v === ')' && --d === 0) { close = k; break; }
      }
      if (close > 0 && op(close + 1) === '=>') {
        const params: { name: string; def: Expr | null }[] = [];
        let k = 2;
        while (k < close) {
          while (toks[k]?.t === 'id' && TYPE_WORDS.has(toks[k].v) && toks[k + 1]?.t === 'id') k++;
          const name = toks[k]?.v;
          if (!name) break;
          k++;
          let def: Expr | null = null;
          if (toks[k]?.v === '=') {
            let e = k + 1;
            while (e < close && toks[e].v !== ',') e++;
            def = parseExprTokens(toks.slice(k + 1, e), no);
            k = e;
          }
          params.push({ name, def });
          if (toks[k]?.v === ',') k++;
        }
        const after = toks.slice(close + 2);
        const body: Stmt[] = after.length ? [{ k: 'expr', e: rhs(after, indent, no), line: no }] : subBlock(indent, no);
        return { k: 'fn', name: w0, params, body, line: no };
      }
    }

    // tuple declaration: [a, b, c] = expr
    if (op(0) === '[') {
      const close = toks.findIndex((t) => t.t === 'op' && t.v === ']');
      if (close > 0 && op(close + 1) === '=') {
        const names = toks.slice(1, close).filter((t) => t.t === 'id').map((t) => t.v);
        return { k: 'tupdecl', names, e: rhs(toks.slice(close + 2), indent, no), line: no };
      }
    }

    // [var|varip] [type] name = expr
    let isVar = false;
    if (w0 === 'var' || w0 === 'varip') { isVar = true; toks = toks.slice(1); }
    while (toks.length > 2 && toks[0].t === 'id' && TYPE_WORDS.has(toks[0].v) && toks[1].t === 'id') toks = toks.slice(1);
    if (toks[0]?.t === 'id' && toks[1]?.t === 'op') {
      const o = toks[1].v;
      if (o === '=') return { k: 'decl', name: toks[0].v, e: rhs(toks.slice(2), indent, no), isVar, line: no };
      if ([':=', '+=', '-=', '*=', '/=', '%='].includes(o)) return { k: 'assign', name: toks[0].v, op: o, e: rhs(toks.slice(2), indent, no), line: no };
    }
    if (isVar) throw new PineError('déclaration « var » incomplète', no);
    return { k: 'expr', e: rhs(toks, indent, no), line: no };
  }

  const body = block(0);
  return { body, version };
}
