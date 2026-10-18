/**
 * 수식 계산기 (재귀 하강 파서).
 * eval, Function, new Function 을 쓰지 않는다. 입력은 토큰화 → AST 구성 → 평가 순서로만 처리한다.
 * 명세: docs/spec/03-artifact-requirements.md 6장 (calc.eval).
 */

export interface CalcOk { ok: true; value: number; text: string }
export interface CalcErr { ok: false; code: 'invalid_request' | 'math_error'; message: string; pos?: number }

const MAX_EXPR_LEN = 500;
const MAX_VARS = 16;
const DEFAULT_PRECISION = 12;
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

// 토큰 정규식은 sticky(y) 플래그로 lastIndex 위치에서만 매칭한다.
// 지수 표기는 e 뒤에 숫자가 올 때만 포함한다(예: "2e" 는 숫자 2 와 이름 e 로 나뉜다).
const NUM_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const ID_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
const OP_CHARS = '+-*/%^(),';

// 상수는 변수로 덮어쓸 수 없다(검증 단계에서 거부).
const CONSTANTS = new Map<string, number>([
  ['pi', Math.PI],
  ['e', Math.E],
]);

interface FnSpec { min: number; max: number; apply: (args: number[]) => number }

function unary(f: (x: number) => number): FnSpec {
  return { min: 1, max: 1, apply: (a) => f(a[0]) };
}

const FUNCTIONS = new Map<string, FnSpec>([
  ['sqrt', unary(Math.sqrt)],
  ['abs', unary(Math.abs)],
  ['round', unary(Math.round)],
  ['floor', unary(Math.floor)],
  ['ceil', unary(Math.ceil)],
  ['log', unary(Math.log10)], // 상용로그
  ['ln', unary(Math.log)], // 자연로그
  ['exp', unary(Math.exp)],
  ['sin', unary(Math.sin)],
  ['cos', unary(Math.cos)],
  ['tan', unary(Math.tan)],
  ['min', { min: 1, max: Infinity, apply: (a) => Math.min(...a) }],
  ['max', { min: 1, max: Infinity, apply: (a) => Math.max(...a) }],
]);

/** 파서·평가기가 던지는 내부 오류. evaluate 에서 CalcErr 로 바꾼다. */
class CalcError extends Error {
  readonly code: CalcErr['code'];
  readonly pos: number | undefined;

  constructor(code: CalcErr['code'], message: string, pos?: number) {
    super(message);
    this.code = code;
    this.pos = pos;
  }
}

type Tok =
  | { kind: 'num'; value: number; pos: number; text: string }
  | { kind: 'id'; name: string; pos: number; text: string }
  | { kind: 'op'; op: string; pos: number; text: string }
  | { kind: 'end'; pos: number; text: string };

type Node =
  | { k: 'lit'; v: number }
  | { k: 'neg'; a: Node }
  | { k: 'bin'; op: '+' | '-' | '*' | '/' | '%' | '^'; a: Node; b: Node }
  | { k: 'call'; apply: (args: number[]) => number; args: Node[] };

function isOp(t: Tok, ch: string): boolean {
  return t.kind === 'op' && t.op === ch;
}

/** 문자열을 토큰 배열로 바꾼다. 마지막 토큰은 항상 end 이며 위치는 입력 길이다. */
function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;

    NUM_RE.lastIndex = i;
    const nm = NUM_RE.exec(src);
    if (nm) {
      const text = nm[0];
      const value = Number(text);
      // 리터럴 자체가 범위를 넘으면(예: 1e400) 계산 오류로 본다.
      if (!Number.isFinite(value)) throw new CalcError('math_error', '숫자가 표현 범위를 벗어났습니다', start);
      toks.push({ kind: 'num', value, pos: start, text });
      i += text.length;
      continue;
    }

    ID_RE.lastIndex = i;
    const im = ID_RE.exec(src);
    if (im) {
      toks.push({ kind: 'id', name: im[0], pos: start, text: im[0] });
      i += im[0].length;
      continue;
    }

    if (OP_CHARS.includes(c)) {
      toks.push({ kind: 'op', op: c, pos: start, text: c });
      i++;
      continue;
    }

    throw new CalcError('invalid_request', `알 수 없는 문자: '${c}'`, start);
  }
  toks.push({ kind: 'end', pos: src.length, text: '' });
  return toks;
}

/** 문법:
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/' | '%') unary)*
 *   unary   := ('-' | '+') unary | power
 *   power   := primary ('^' unary)?        // 우결합, 지수 쪽은 단항을 허용(2^-1)
 *   primary := NUMBER | NAME | NAME '(' args ')' | '(' expr ')'
 * 단항 '-' 는 power 보다 바깥이므로 -2^2 = -(2^2) = -4 가 된다.
 * 이름은 파싱 중에 상수·변수 값으로 바로 바꾼다. 그래서 오류 위치가 입력 순서와 맞는다.
 */
class Parser {
  private i = 0;

  constructor(
    private readonly toks: Tok[],
    private readonly vars: Map<string, number>,
  ) {}

  parse(): Node {
    const n = this.expr();
    const t = this.peek();
    if (t.kind !== 'end') throw this.unexpected(t);
    return n;
  }

  private peek(): Tok {
    return this.toks[this.i];
  }

  private unexpected(t: Tok): CalcError {
    if (t.kind === 'end') return new CalcError('invalid_request', '수식이 중간에 끝났습니다', t.pos);
    return new CalcError('invalid_request', `예상하지 못한 토큰: '${t.text}'`, t.pos);
  }

  private expr(): Node {
    let n = this.term();
    for (;;) {
      const t = this.peek();
      if (t.kind === 'op' && (t.op === '+' || t.op === '-')) {
        this.i++;
        n = { k: 'bin', op: t.op, a: n, b: this.term() };
      } else {
        return n;
      }
    }
  }

  private term(): Node {
    let n = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.kind === 'op' && (t.op === '*' || t.op === '/' || t.op === '%')) {
        this.i++;
        n = { k: 'bin', op: t.op, a: n, b: this.unary() };
      } else {
        return n;
      }
    }
  }

  private unary(): Node {
    const t = this.peek();
    if (isOp(t, '-')) {
      this.i++;
      return { k: 'neg', a: this.unary() };
    }
    if (isOp(t, '+')) {
      this.i++;
      return this.unary();
    }
    return this.power();
  }

  private power(): Node {
    const base = this.primary();
    if (isOp(this.peek(), '^')) {
      this.i++;
      // 우결합: 오른쪽은 다시 power 가 아니라 unary 를 받는다.
      return { k: 'bin', op: '^', a: base, b: this.unary() };
    }
    return base;
  }

  private primary(): Node {
    const t = this.peek();

    if (t.kind === 'num') {
      this.i++;
      return { k: 'lit', v: t.value };
    }

    if (t.kind === 'id') {
      this.i++;
      if (isOp(this.peek(), '(')) {
        const spec = FUNCTIONS.get(t.name);
        if (!spec) throw new CalcError('invalid_request', `알 수 없는 함수: ${t.name}`, t.pos);
        this.i++; // '(' 소비
        return this.call(t.name, spec);
      }
      const v = CONSTANTS.get(t.name) ?? this.vars.get(t.name);
      if (v !== undefined) return { k: 'lit', v };
      if (FUNCTIONS.has(t.name)) {
        throw new CalcError('invalid_request', `함수는 변수로 쓸 수 없습니다: ${t.name}`, t.pos);
      }
      throw new CalcError('invalid_request', `알 수 없는 이름: ${t.name}`, t.pos);
    }

    if (isOp(t, '(')) {
      this.i++;
      const n = this.expr();
      const c = this.peek();
      if (!isOp(c, ')')) throw new CalcError('invalid_request', "')'가 필요합니다", c.pos);
      this.i++;
      return n;
    }

    throw this.unexpected(t);
  }

  /** '(' 를 이미 소비한 뒤 인자 목록과 ')' 를 읽는다. */
  private call(name: string, spec: FnSpec): Node {
    const args: Node[] = [];
    const commas: number[] = [];
    let closePos = -1;

    if (isOp(this.peek(), ')')) {
      closePos = this.peek().pos;
      this.i++;
    } else {
      for (;;) {
        args.push(this.expr());
        const t = this.peek();
        if (isOp(t, ',')) {
          commas.push(t.pos);
          this.i++;
          continue;
        }
        if (isOp(t, ')')) {
          closePos = t.pos;
          this.i++;
          break;
        }
        throw this.unexpected(t);
      }
    }

    // 인자 부족은 닫는 괄호 위치, 인자 초과는 첫 번째 초과 인자 앞의 쉼표 위치를 가리킨다.
    if (args.length < spec.min) {
      throw new CalcError('invalid_request', `${name}은(는) 인자가 최소 ${spec.min}개 필요합니다`, closePos);
    }
    if (args.length > spec.max) {
      throw new CalcError('invalid_request', `${name}은(는) 인자가 최대 ${spec.max}개입니다`, commas[spec.max - 1]);
    }
    return { k: 'call', apply: spec.apply, args };
  }
}

/** 계산 중간 결과가 NaN·Infinity 이면 math_error. */
function fin(x: number): number {
  if (!Number.isFinite(x)) throw new CalcError('math_error', '계산 결과가 유한한 수가 아닙니다');
  return x;
}

function evalNode(n: Node): number {
  switch (n.k) {
    case 'lit':
      return n.v;
    case 'neg':
      return fin(-evalNode(n.a));
    case 'bin': {
      const x = evalNode(n.a);
      const y = evalNode(n.b);
      switch (n.op) {
        case '+':
          return fin(x + y);
        case '-':
          return fin(x - y);
        case '*':
          return fin(x * y);
        case '/':
          if (y === 0) throw new CalcError('math_error', '0으로 나눌 수 없습니다');
          return fin(x / y);
        case '%':
          if (y === 0) throw new CalcError('math_error', '0으로 나눌 수 없습니다');
          return fin(x % y);
        case '^':
          return fin(x ** y);
        default:
          throw new Error('알 수 없는 연산자'); // 도달 불가(타입상 모든 연산자가 처리됨)
      }
    }
    case 'call':
      return fin(n.apply(n.args.map((a) => evalNode(a))));
    default:
      throw new Error('알 수 없는 노드'); // 도달 불가
  }
}

/** vars 와 precision 을 검증한다. 실패하면 invalid_request 를 던진다. */
function validate(
  expr: unknown,
  vars: unknown,
  precision: unknown,
): { vars: Map<string, number>; precision: number } {
  if (typeof expr !== 'string') throw new CalcError('invalid_request', '수식은 문자열이어야 합니다');
  if (expr.length < 1 || expr.length > MAX_EXPR_LEN) {
    throw new CalcError('invalid_request', `수식은 1~${MAX_EXPR_LEN}자여야 합니다`);
  }

  const map = new Map<string, number>();
  if (vars !== undefined) {
    if (vars === null || typeof vars !== 'object' || Array.isArray(vars)) {
      throw new CalcError('invalid_request', '변수는 객체여야 합니다');
    }
    const keys = Object.keys(vars);
    if (keys.length > MAX_VARS) throw new CalcError('invalid_request', `변수는 최대 ${MAX_VARS}개입니다`);
    for (const key of keys) {
      if (!VAR_NAME_RE.test(key)) throw new CalcError('invalid_request', `잘못된 변수 이름: ${key}`);
      if (CONSTANTS.has(key) || FUNCTIONS.has(key)) {
        throw new CalcError('invalid_request', `상수·함수 이름은 변수로 쓸 수 없습니다: ${key}`);
      }
      const value: unknown = (vars as Record<string, unknown>)[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new CalcError('invalid_request', `변수 값은 유한한 숫자여야 합니다: ${key}`);
      }
      map.set(key, value);
    }
  }

  let p = DEFAULT_PRECISION;
  if (precision !== undefined) {
    if (typeof precision !== 'number' || !Number.isInteger(precision) || precision < 0 || precision > 15) {
      throw new CalcError('invalid_request', 'precision은 0~15 정수여야 합니다');
    }
    p = precision;
  }

  return { vars: map, precision: p };
}

/** text: 유효숫자 precision 자리로 반올림한 뒤 Number 로 다시 바꾸어 String 으로 만든다. precision 0 이면 정수 반올림. */
function formatText(value: number, precision: number): string {
  if (precision === 0) return String(Math.round(value));
  return String(Number(value.toPrecision(precision)));
}

/** 수식을 계산한다. 예외를 던지지 않고 CalcOk 또는 CalcErr 를 돌려준다. */
export function evaluate(expr: string, vars?: Record<string, number>, precision?: number): CalcOk | CalcErr {
  try {
    const req = validate(expr, vars, precision);
    const ast = new Parser(tokenize(expr), req.vars).parse();
    const value = evalNode(ast);
    return { ok: true, value, text: formatText(value, req.precision) };
  } catch (err) {
    if (err instanceof CalcError) {
      const out: CalcErr = { ok: false, code: err.code, message: err.message };
      if (err.pos !== undefined) out.pos = err.pos;
      return out;
    }
    throw err;
  }
}
