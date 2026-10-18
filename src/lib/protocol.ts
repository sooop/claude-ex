// 확장 위임 프로토콜 v2(op 단위 양방향 RPC). 명세: docs/spec/01 3장, 02 4장.
// reference/src/lib/protocolV2.ts 에서 우편번호 전용 부분(PROVIDES, WEB_QUERY_ADAPTERS, toLookupRequest)을 걷어냈다.

export const PROTOCOL_V2 = 2
export const V2_APP_SOURCE = 'ab-app'
export const V2_EXT_SOURCE = 'ab-ext'

export const V2_TYPES = ['hello', 'hello_ack', 'call', 'progress', 'result', 'cancel', 'event'] as const
export type V2Type = (typeof V2_TYPES)[number]

export const NS_RE = /^[a-z0-9._-]{1,64}$/
export const OP_RE = /^[a-z]+\.[a-z_]+$/

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
    typeof d.ns === 'string' && NS_RE.test(d.ns) &&
    typeof d.type === 'string' && (V2_TYPES as readonly string[]).includes(d.type) &&
    typeof d.id === 'string' && d.id.length > 0 && d.id.length <= 128
  )
}

/** 확장이 보내는 봉투. 앱 → 확장과 같은 형식이고 source 만 다르다 */
export function extEnvelope(ns: string, type: V2Type, id: string, body: Record<string, unknown> = {}) {
  return { source: V2_EXT_SOURCE, v: PROTOCOL_V2, ns, type, id, ts: Date.now(), ...body }
}

// ── 오류 ─────────────────────────────────────────────────────────────────────

export const V2_ERROR_CODES = [
  'invalid_request', 'unsupported_op', 'unsupported_version', 'busy', 'timeout', 'cancelled',
  'not_granted', 'blocked', 'network', 'parse_failed', 'payload_too_large', 'ai_unavailable', 'internal',
] as const
export type V2CommonCode = (typeof V2_ERROR_CODES)[number]
/** 공통 코드 + op 고유 코드(소문자 snake_case, 예: math_error) */
export type V2ErrorCode = V2CommonCode | (string & {})

export interface V2Error {
  code: V2ErrorCode
  message: string
  retryable: boolean
  detail?: unknown
}

const err = (code: V2ErrorCode, message: string, retryable: boolean, detail?: unknown): V2Error =>
  ({ code, message, retryable, ...(detail !== undefined ? { detail } : {}) })

export const V2_ERRORS = {
  invalid_request: (message = '요청 형식이 올바르지 않습니다', detail?: unknown) => err('invalid_request', message, false, detail),
  unsupported_op: (message = '지원하지 않는 op 입니다', detail?: unknown) => err('unsupported_op', message, false, detail),
  unsupported_version: (message = '지원하지 않는 프로토콜 버전입니다') => err('unsupported_version', message, false),
  busy: (message = '처리 중인 호출이 있습니다') => err('busy', message, true),
  timeout: (message = '제한 시간을 넘었습니다') => err('timeout', message, true),
  cancelled: (message = '취소되었습니다') => err('cancelled', message, false),
  ai_unavailable: (message = 'AI를 사용할 수 없습니다') => err('ai_unavailable', message, true),
  internal: (message = '확장 내부 오류', detail?: unknown) => err('internal', message, false, detail),
}

/** 상대가 보낸 error 객체를 정규화한다. 모르는 코드는 internal 로 취급한다(공통 계약) */
export function normalizeError(e: unknown, known: readonly string[] = []): V2Error {
  if (!e || typeof e !== 'object') return V2_ERRORS.internal('형식이 잘못된 오류 응답')
  const o = e as Record<string, unknown>
  const code = typeof o.code === 'string' ? o.code : ''
  const message = typeof o.message === 'string' ? o.message.slice(0, 300) : ''
  const isKnown = (V2_ERROR_CODES as readonly string[]).includes(code) || known.includes(code)
  return {
    code: isKnown ? code : 'internal',
    message: message || code || '알 수 없는 오류',
    retryable: o.retryable === true,
    ...(o.detail !== undefined ? { detail: o.detail } : {}),
  }
}

// ── 한도 ─────────────────────────────────────────────────────────────────────

export const V2_LIMITS = {
  minTimeoutMs: 1_000,
  maxTimeoutMs: 300_000,
  defaultTimeoutMs: 60_000,
  /** 호출자 쪽 타이머 유예 */
  graceMs: 2_000,
  maxMessageBytes: 1024 * 1024,
  maxPending: 8,
  /** hello 의 provides 전체 크기 상한 */
  maxProvidesBytes: 16 * 1024,
} as const

export function clampTimeout(t: number | undefined): number {
  if (t === undefined) return V2_LIMITS.defaultTimeoutMs
  return Math.min(Math.max(t, V2_LIMITS.minTimeoutMs), V2_LIMITS.maxTimeoutMs)
}

// ── 능력(provides) ───────────────────────────────────────────────────────────

export type OpKind = 'read' | 'write' | 'sensitive'

export interface ProvidedOp {
  op: string
  ver: number
  kind: OpKind
  consent: boolean
  summary?: string
  limits?: Record<string, unknown>
  adapters?: { id: string; summary: string }[]
  state?: 'ready' | 'needs_setup'
  hint?: string
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)

/** 앱이 hello/hello_ack 로 보낸 provides 를 정제한다. 형식이 맞지 않는 항목은 버린다 */
export function parseProvides(raw: unknown): ProvidedOp[] {
  if (!Array.isArray(raw)) return []
  const out: ProvidedOp[] = []
  for (const p of raw.slice(0, 64)) {
    if (!isObj(p) || typeof p.op !== 'string' || !OP_RE.test(p.op)) continue
    if (typeof p.ver !== 'number' || !Number.isInteger(p.ver) || p.ver < 1) continue
    const kind: OpKind = p.kind === 'write' || p.kind === 'sensitive' ? p.kind : 'read'
    out.push({
      op: p.op, ver: p.ver, kind, consent: p.consent === true,
      ...(typeof p.summary === 'string' ? { summary: p.summary.slice(0, 80) } : {}),
      ...(p.state === 'needs_setup' ? { state: 'needs_setup' as const } : {}),
      ...(typeof p.hint === 'string' ? { hint: p.hint.slice(0, 120) } : {}),
    })
  }
  return out
}

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

/** call 봉투의 형식만 확인한다. op 존재·인자 스키마는 레지스트리가 본다 */
export function validateCall(msg: Record<string, unknown>): CallValidation {
  const bad = (m: string): CallValidation => ({ ok: false, error: V2_ERRORS.invalid_request(m) })
  if (typeof msg.op !== 'string' || !OP_RE.test(msg.op)) return bad('op 형식 오류')
  if (typeof msg.ver !== 'number' || !Number.isInteger(msg.ver) || msg.ver < 1) return bad('ver 형식 오류')
  if (!isObj(msg.args)) return bad('args 가 없습니다')

  let timeoutMs: number = V2_LIMITS.defaultTimeoutMs
  if (msg.opts !== undefined) {
    if (!isObj(msg.opts)) return bad('opts 형식 오류')
    const t = msg.opts.timeoutMs
    if (t !== undefined) {
      if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return bad('timeoutMs 형식 오류')
      timeoutMs = clampTimeout(t)
    }
  }
  return { ok: true, call: { op: msg.op, ver: msg.ver, args: msg.args, timeoutMs } }
}

// ── 문자열 정제 ──────────────────────────────────────────────────────────────

/** 상대에게서 받은 문자열: 태그 제거, 제어문자 제거, 길이 제한 */
export function cleanText(s: unknown, max: number): string {
  if (typeof s !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return s.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max)
}

/** 직렬화 길이(UTF-16 코드 단위 기준 근사) */
export function jsonSize(x: unknown): number {
  try {
    return JSON.stringify(x)?.length ?? 0
  } catch {
    return Infinity
  }
}
