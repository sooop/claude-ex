// 확장 위임 프로토콜 v2(op 단위 양방향 RPC). 명세: docs/spec/01 3장, 02 4장.
// reference/src/lib/protocolV2.ts 에서 우편번호 전용 부분(PROVIDES, WEB_QUERY_ADAPTERS, toLookupRequest)을 걷어냈다.
import { V2_ERRORS, type V2Error } from '@/sdk/errors'

export const PROTOCOL_V2 = 2
export const V2_APP_SOURCE = 'ab-app'
export const V2_EXT_SOURCE = 'ab-ext'

export const V2_TYPES = ['hello', 'hello_ack', 'call', 'progress', 'result', 'cancel', 'event'] as const
export type V2Type = (typeof V2_TYPES)[number]

export const NS_RE = /^[a-z0-9._-]{1,64}$/
export { OP_RE, type OpKind } from '@/sdk/plugin'
import { OP_RE, type OpKind } from '@/sdk/plugin'

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
// 오류 형식은 플러그인과 공유하므로 SDK 에 있다

export { V2_ERROR_CODES, V2_ERRORS, normalizeError, type V2CommonCode, type V2Error, type V2ErrorCode } from '@/sdk/errors'

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
