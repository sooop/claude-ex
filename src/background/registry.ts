// op 레지스트리. 명세 02 4.1의 정의 객체와 실행 순서(op → 스키마 → 동시성 → 핸들러 → 정제)를 따른다.
// PoC 범위: 권한·동의 단계는 없다(read op 뿐). 정의에 kind·consent 를 두어 나중에 게이트를 끼울 수 있게 한다.
import { V2_ERRORS, type OpKind, type ProvidedOp, type V2Error } from '@/lib/protocol'
import { validateSchema, type Schema } from '@/lib/schema'

export interface OpSender {
  ns: string
  origin: string
  tabId?: number
}

export interface OpContext {
  args: Record<string, unknown>
  signal: AbortSignal
  progress(stage: string, detail?: string, pct?: number): void
  sender: OpSender
}

export interface OpDef {
  name: string
  ver: number
  kind: OpKind
  consent: false
  summary: string
  description: string
  args: Schema
  result: Schema
  errors: { code: string; when: string }[]
  examples?: { args: unknown; result: unknown }[]
  limits: { maxConcurrent: 1; timeoutMs: number }
  /** op 고유 오류 코드(공통 코드 외). 호출자가 internal 로 바꾸지 않게 알린다 */
  extraCodes?: string[]
  handler(ctx: OpContext): Promise<unknown>
}

/** 핸들러가 던지면 그대로 error result 로 나간다 */
export class OpError extends Error {
  constructor(readonly error: V2Error) {
    super(error.message)
  }
}

export interface Registry {
  readonly catalogRev: string
  provides(): ProvidedOp[]
  get(name: string, ver: number): OpDef | undefined
  known(): string[]
}

/** 짧은 해시(FNV-1a 32비트). 카탈로그 변경 감지용이라 암호학적 강도는 필요 없다 */
function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

const toProvided = (d: OpDef): ProvidedOp => ({
  op: d.name, ver: d.ver, kind: d.kind, consent: d.consent, summary: d.summary,
  limits: { maxConcurrent: d.limits.maxConcurrent, timeoutMs: d.limits.timeoutMs },
  state: 'ready',
})

const describeArgs: Schema = {
  type: 'object',
  properties: {
    op: { type: 'string', maxLength: 64 },
    adapter: { type: 'string', maxLength: 64 },
  },
}

/** 정의 목록으로 레지스트리를 만든다. meta.describe 는 자동으로 추가한다 */
export function createRegistry(defs: OpDef[]): Registry {
  const all: OpDef[] = []
  const provides = () => all.map(toProvided)
  const known = () => all.map((d) => d.name)
  let catalogRev = ''

  const describe: OpDef = {
    name: 'meta.describe', ver: 1, kind: 'read', consent: false,
    summary: 'op와 어댑터의 상세 설명을 조회한다',
    description: 'op를 생략하면 전체 목록과 catalogRev를, 지정하면 그 op의 인자·결과 스키마, 오류, 한도, 예시를 돌려준다.',
    args: describeArgs,
    result: { type: 'object' },
    errors: [{ code: 'unsupported_op', when: '없는 op 또는 어댑터. detail.known에 이름 목록' }],
    limits: { maxConcurrent: 1, timeoutMs: 5_000 },
    async handler({ args }) {
      if (args.op === undefined) return { provides: provides(), catalogRev }
      const d = all.find((x) => x.name === args.op)
      if (!d) throw new OpError(V2_ERRORS.unsupported_op(`없는 op: ${String(args.op)}`, { known: known() }))
      if (args.adapter !== undefined)
        throw new OpError(V2_ERRORS.unsupported_op(`${d.name}에는 어댑터가 없습니다`, { known: [] }))
      return {
        op: d.name, ver: d.ver, kind: d.kind, consent: d.consent, summary: d.summary, description: d.description,
        args: d.args, result: d.result, errors: d.errors,
        limits: { maxConcurrent: d.limits.maxConcurrent, timeoutMs: d.limits.timeoutMs },
        examples: (d.examples ?? []).slice(0, 3),
      }
    },
  }

  all.push(describe, ...defs)
  catalogRev = hash(JSON.stringify(provides()))

  return {
    catalogRev,
    provides,
    get: (name, ver) => all.find((d) => d.name === name && d.ver === ver),
    known,
  }
}

export type ArgsCheck = { ok: true; args: Record<string, unknown> } | { ok: false; error: V2Error }

/** 인자 스키마 검증. 선언 외 필드는 거부하고 default 를 채운다 */
export function checkArgs(def: OpDef, args: Record<string, unknown>): ArgsCheck {
  const r = validateSchema(def.args, args)
  if (r.err !== undefined) return { ok: false, error: V2_ERRORS.invalid_request(r.err.slice(0, 160)) }
  return { ok: true, args: r.value as Record<string, unknown> }
}
