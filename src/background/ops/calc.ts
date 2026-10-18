// calc.eval@1. 규격: docs/spec/03-artifact-requirements.md 6장
import { evaluate } from '@/lib/calc'
import { V2_ERRORS } from '@/lib/protocol'
import { OpError, type OpDef } from '../registry'

export const calcEval: OpDef = {
  name: 'calc.eval', ver: 1, kind: 'read', consent: false,
  summary: '사칙·거듭제곱·함수가 들어간 수식을 계산한다',
  description:
    '수식 문자열을 계산한다. 연산 + - * / % ^, 괄호, 단항 -. 함수 sqrt abs round floor ceil min max log ln exp sin cos tan. 상수 pi e. ' +
    'eval을 쓰지 않는 파서로 계산한다.',
  args: {
    type: 'object',
    required: ['expr'],
    properties: {
      expr: { type: 'string', minLength: 1, maxLength: 500, description: '수식' },
      vars: { type: 'object', additionalProperties: { type: 'number' }, description: '변수 이름 → 숫자(최대 16개)' },
      precision: { type: 'integer', minimum: 0, maximum: 15, default: 12, description: '결과 문자열의 유효숫자' },
    },
  },
  result: {
    type: 'object',
    required: ['value', 'text'],
    properties: { value: { type: 'number' }, text: { type: 'string' } },
  },
  errors: [
    { code: 'invalid_request', when: '문법 오류, 모르는 이름이나 함수. detail.pos에 문자 위치' },
    { code: 'math_error', when: '0으로 나누기, 결과가 NaN이나 Infinity' },
  ],
  examples: [
    { args: { expr: 'sqrt(x^2 + y^2)', vars: { x: 3, y: 4 } }, result: { value: 5, text: '5' } },
    { args: { expr: '1/3', precision: 4 }, result: { value: 1 / 3, text: '0.3333' } },
  ],
  limits: { maxConcurrent: 1, timeoutMs: 5_000 },
  extraCodes: ['math_error'],
  async handler({ args }) {
    const r = evaluate(args.expr as string, args.vars as Record<string, number> | undefined, args.precision as number | undefined)
    if (r.ok) return { value: r.value, text: r.text }
    if (r.code === 'math_error') throw new OpError({ code: 'math_error', message: r.message, retryable: false })
    throw new OpError(V2_ERRORS.invalid_request(r.message, r.pos !== undefined ? { pos: r.pos } : undefined))
  },
}
