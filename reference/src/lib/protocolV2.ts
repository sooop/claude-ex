// 확장 위임 프로토콜 v2(op 단위 양방향 RPC) 확장 측. 명세: 확장 위임 프로토콜 설계 (1/2) 3장, (2/2)
// v1(protocol.ts)과 병행한다. 봉투 source 가 다르므로(`ab-app` / `ab-ext`) 서로 간섭하지 않는다.
import { LIMITS, type BridgeError, type LookupRequest, type LookupSource } from './protocol'

export const PROTOCOL_V2 = 2
export const V2_APP_SOURCE = 'ab-app'
export const V2_EXT_SOURCE = 'ab-ext'

export const V2_TYPES = ['hello', 'hello_ack', 'call', 'progress', 'result', 'cancel', 'event'] as const
export type V2Type = (typeof V2_TYPES)[number]

export interface V2Envelope {
  source: typeof V2_APP_SOURCE
  v: number
  ns: string
  type: V2Type
  id: string
  [key: string]: unknown
}

/** 공통 형식(source, v 숫자, ns, 알려진 type, 문자열 id)을 만족하면 true. 아니면 조용히 무시한다 */
export function isV2Envelope(data: unknown): data is V2Envelope {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  return (
    d.source === V2_APP_SOURCE &&
    typeof d.v === 'number' &&
    typeof d.ns === 'string' && /^[a-z0-9._-]{1,64}$/.test(d.ns) &&
    typeof d.type === 'string' && (V2_TYPES as readonly string[]).includes(d.type) &&
    typeof d.id === 'string' && d.id.length > 0 && d.id.length <= 128
  )
}

// ── 오류 ─────────────────────────────────────────────────────────────────────

export type V2ErrorCode =
  | 'invalid_request' | 'unsupported_op' | 'unsupported_version' | 'busy' | 'timeout' | 'cancelled'
  | 'not_granted' | 'blocked' | 'network' | 'parse_failed' | 'payload_too_large' | 'ai_unavailable' | 'internal'

export interface V2Error {
  code: V2ErrorCode
  message: string
  retryable: boolean
  detail?: unknown
}

export const V2_ERRORS = {
  invalid_request: (message = '요청 형식이 올바르지 않습니다'): V2Error => ({ code: 'invalid_request', message, retryable: false }),
  unsupported_op: (message = '지원하지 않는 op 입니다'): V2Error => ({ code: 'unsupported_op', message, retryable: false }),
  unsupported_version: (message = '지원하지 않는 프로토콜 버전입니다'): V2Error => ({ code: 'unsupported_version', message, retryable: false }),
  busy: (message = '처리 중인 호출이 있습니다'): V2Error => ({ code: 'busy', message, retryable: true }),
  internal: (message = '확장 내부 오류', detail?: unknown): V2Error =>
    ({ code: 'internal', message, retryable: false, ...(detail !== undefined ? { detail } : {}) }),
}

/** v1 오류를 v2 코드로 옮긴다. v2 에 없는 코드는 가장 가까운 코드로 매핑한다 */
export function toV2Error(e: BridgeError): V2Error {
  switch (e.code) {
    case 'unsupported_query': return { code: 'invalid_request', message: e.message, retryable: false }
    case 'rate_limited': return { code: 'busy', message: e.message, retryable: true, ...(e.retryAfterMs ? { detail: { retryAfterMs: e.retryAfterMs } } : {}) }
    default: return { code: e.code, message: e.message, retryable: e.retryable }
  }
}

// ── 능력(provides) ───────────────────────────────────────────────────────────

/** web.query 어댑터 id → v1 조회처. 허용 도메인은 fetchers 가 고정하고 있다 */
export const WEB_QUERY_ADAPTERS = {
  'epost-zip': 'epost',
  'juso-addr': 'juso',
  'zip-auto': 'auto',
} as const satisfies Record<string, LookupSource>
export type WebQueryAdapter = keyof typeof WEB_QUERY_ADAPTERS

export const V2_LIMITS = {
  minTimeoutMs: 1000,
  maxTimeoutMs: LIMITS.maxTimeoutMs,
  defaultTimeoutMs: LIMITS.defaultTimeoutMs,
  maxConcurrent: 1,
} as const

export interface ProvidedOp {
  op: string
  ver: number
  kind: 'read' | 'write' | 'sensitive'
  consent: boolean
  limits: Record<string, unknown>
}

export const PROVIDES: readonly ProvidedOp[] = [
  {
    op: 'web.query', ver: 1, kind: 'read', consent: false,
    limits: {
      maxConcurrent: V2_LIMITS.maxConcurrent,
      maxLimit: LIMITS.maxLimit,
      maxTextLen: LIMITS.maxTextLen,
      adapters: Object.keys(WEB_QUERY_ADAPTERS),
    },
  },
]

// ── call 검증 ────────────────────────────────────────────────────────────────

export interface CallRequest {
  op: string
  ver: number
  args: Record<string, unknown>
  timeoutMs: number
}

export type CallValidation =
  | { ok: true; call: CallRequest }
  | { ok: false; error: V2Error }

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)

export function validateCall(msg: Record<string, unknown>): CallValidation {
  const bad = (m: string): CallValidation => ({ ok: false, error: V2_ERRORS.invalid_request(m) })
  if (typeof msg.op !== 'string' || !/^[a-z]+\.[a-z_]+$/.test(msg.op)) return bad('op 형식 오류')
  if (typeof msg.ver !== 'number' || !Number.isInteger(msg.ver) || msg.ver < 1) return bad('ver 형식 오류')
  if (!isObj(msg.args)) return bad('args 가 없습니다')

  const provided = PROVIDES.find((p) => p.op === msg.op && p.ver === msg.ver)
  if (!provided) return { ok: false, error: V2_ERRORS.unsupported_op(`지원하지 않는 op: ${msg.op} v${msg.ver}`) }

  let timeoutMs: number = V2_LIMITS.defaultTimeoutMs
  if (msg.opts !== undefined) {
    if (!isObj(msg.opts)) return bad('opts 형식 오류')
    const t = msg.opts.timeoutMs
    if (t !== undefined) {
      if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return bad('timeoutMs 형식 오류')
      timeoutMs = Math.min(Math.max(t, V2_LIMITS.minTimeoutMs), V2_LIMITS.maxTimeoutMs)
    }
  }
  return { ok: true, call: { op: msg.op, ver: msg.ver, args: msg.args, timeoutMs } }
}

/**
 * web.query 인자 `{adapter, params:{searchText?, oldAddr?, oldZip?}, limit?, analyze?}` 를 v1 조회 요청으로 바꾼다.
 * 선언하지 않은 필드는 거부한다(argsSchema).
 */
export function toLookupRequest(args: Record<string, unknown>, timeoutMs: number):
  { ok: true; req: LookupRequest } | { ok: false; error: V2Error } {
  const bad = (m: string) => ({ ok: false as const, error: V2_ERRORS.invalid_request(m) })
  const allowedArgs = ['adapter', 'params', 'limit', 'analyze']
  if (Object.keys(args).some((k) => !allowedArgs.includes(k))) return bad('알 수 없는 args 필드')

  const adapter = args.adapter
  if (typeof adapter !== 'string' || !Object.prototype.hasOwnProperty.call(WEB_QUERY_ADAPTERS, adapter)) return bad('adapter 형식 오류')
  const source = WEB_QUERY_ADAPTERS[adapter as WebQueryAdapter]

  const p = args.params
  if (!isObj(p)) return bad('params 가 없습니다')
  if (Object.keys(p).some((k) => !['searchText', 'oldAddr', 'oldZip'].includes(k))) return bad('알 수 없는 params 필드')

  const text = (name: 'searchText' | 'oldAddr'): string | undefined | null => {
    const v = p[name]
    if (v === undefined) return undefined
    if (typeof v !== 'string' || v.length > LIMITS.maxTextLen) return null
    return v.trim() || undefined
  }
  const searchText = text('searchText')
  const oldAddr = text('oldAddr')
  if (searchText === null) return bad(`searchText 형식 오류(${LIMITS.maxTextLen}자 이하 문자열)`)
  if (oldAddr === null) return bad(`oldAddr 형식 오류(${LIMITS.maxTextLen}자 이하 문자열)`)

  let oldZip: string | undefined
  if (p.oldZip !== undefined) {
    if (typeof p.oldZip !== 'string' || !/^\d{6}$/.test(p.oldZip)) return bad('oldZip 형식 오류(6자리 숫자)')
    oldZip = p.oldZip
  }
  if (!searchText && !oldAddr && !oldZip) return bad('searchText, oldAddr, oldZip 중 하나가 필요합니다')

  let limit: number = LIMITS.defaultLimit
  if (args.limit !== undefined) {
    if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1) return bad('limit 형식 오류')
    limit = Math.min(args.limit, LIMITS.maxLimit)
  }
  let analyze = true
  if (args.analyze !== undefined) {
    if (typeof args.analyze !== 'boolean') return bad('analyze 형식 오류')
    analyze = args.analyze
  }
  return { ok: true, req: { searchText, oldAddr, oldZip, limit, timeoutMs, source, analyze } }
}
