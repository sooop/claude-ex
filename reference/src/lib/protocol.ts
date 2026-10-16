// 우편번호 변환기 ↔ 확장 연동 프로토콜 v1
import type { Source } from './search'

export const PROTOCOL_V = 1
export const APP_SOURCE = 'postal-converter'
export const BRIDGE_SOURCE = 'postal-bridge'
export const PORT_NAME = 'postal-bridge'

// 앱 프레임의 실측 origin: https://<uuid>.frame.claudeusercontent.com (상위 프레임은 https://claude.ai)
const APP_FRAME_ORIGIN = /^https:\/\/[a-z0-9-]+\.frame\.claudeusercontent\.com$/
const APP_PARENT_ORIGIN = 'https://claude.ai'

export function isAllowedAppOrigin(origin: string): boolean {
  return APP_FRAME_ORIGIN.test(origin)
}

/** 앱 프레임이 claude.ai 안에 임베드된 경우에만 true (다른 사이트가 이 호스트를 임베드해도 거부) */
export function hasAllowedParent(ancestorOrigins: readonly string[]): boolean {
  return ancestorOrigins.includes(APP_PARENT_ORIGIN)
}

export const LIMITS = {
  minIntervalMs: 500,
  maxLimit: 20,
  defaultLimit: 10,
  defaultTimeoutMs: 15000,
  minTimeoutMs: 1000,
  maxTimeoutMs: 60000,
  maxTextLen: 200,
  maxQueue: 50,
} as const

export const FEATURES = ['lookup', 'cancel', 'progress', 'oldZipSearch', 'jusoSearch'] as const

export type ErrorCode =
  | 'unsupported_query' | 'invalid_request' | 'network' | 'timeout' | 'rate_limited'
  | 'blocked' | 'parse_failed' | 'cancelled' | 'internal'

export interface BridgeError {
  code: ErrorCode
  message: string
  retryable: boolean
  retryAfterMs?: number
}

export const ERRORS = {
  unsupported_query: (message = '검색어로 쓸 수 없는 입력입니다'): BridgeError =>
    ({ code: 'unsupported_query', message, retryable: false }),
  invalid_request: (message = '요청 형식이 올바르지 않습니다'): BridgeError =>
    ({ code: 'invalid_request', message, retryable: false }),
  network: (message = '우체국에 연결하지 못했습니다'): BridgeError =>
    ({ code: 'network', message, retryable: true }),
  timeout: (message = '우체국 응답 없음'): BridgeError =>
    ({ code: 'timeout', message, retryable: true }),
  rate_limited: (retryAfterMs?: number, message = '요청 한도를 초과했습니다'): BridgeError =>
    ({ code: 'rate_limited', message, retryable: true, ...(retryAfterMs ? { retryAfterMs } : {}) }),
  blocked: (message = '우체국에서 요청이 차단되었습니다'): BridgeError =>
    ({ code: 'blocked', message, retryable: false }),
  parse_failed: (message = '우체국 응답 형식을 읽을 수 없습니다'): BridgeError =>
    ({ code: 'parse_failed', message, retryable: false }),
  cancelled: (message = '조회가 취소되었습니다'): BridgeError =>
    ({ code: 'cancelled', message, retryable: false }),
  internal: (message = '확장 내부 오류'): BridgeError =>
    ({ code: 'internal', message, retryable: false }),
}

// 앱이 보내는 type. ready/decision/progress 는 후보 판정(decide) 방향에서 앱이 확장에 보내는 메시지
export type AppMessageType = 'ping' | 'lookup' | 'cancel' | 'ready' | 'decision' | 'progress'
const APP_TYPES: readonly string[] = ['ping', 'lookup', 'cancel', 'ready', 'decision', 'progress']

export interface AppEnvelope {
  source: typeof APP_SOURCE
  v: number
  type: AppMessageType
  id: string
  [key: string]: unknown
}

/** 공통 형식(source, v 숫자, 알려진 type, 문자열 id)을 만족하면 true. 아니면 조용히 무시한다 */
export function isAppEnvelope(data: unknown): data is AppEnvelope {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  return (
    d.source === APP_SOURCE &&
    typeof d.v === 'number' &&
    typeof d.type === 'string' && APP_TYPES.includes(d.type) &&
    typeof d.id === 'string' && d.id.length > 0 && d.id.length <= 128
  )
}

export interface Candidate {
  zip5: string
  road: string
  jibun?: string
  detail?: string
  /** 추가 필드(v1 호환): 구우편번호 6자리 숫자 */
  oldZip?: string
  /** 추가 필드(v1 호환, 입력 분석 검색일 때): 건물(단지)명 */
  name?: string
  /** 추가 필드(v1 호환): 단지 안 동 목록 원문(예: '101동~103동,105동~108동') */
  dongs?: string
  /** 추가 필드(v1 호환): 확장이 입력을 분석해 매긴 점수와 근거. 후보는 점수 내림차순으로 온다 */
  match?: { score: number; why: string[] }
}

export interface LookupMeta {
  source: Source
  fetchedAt: number
  parserVersion: string
  queryUsed: string
  total: number
  truncated: boolean
  /** 추가 필드(v1 호환): 입력 분석 검색으로 조회했는지 */
  analyzed?: boolean
  /** 추가 필드: 분석 검색에서 확장이 확신하는 1순위가 있는지 */
  confident?: boolean
}

/** lookup 조회처 선택(추가 필드): 기본 epost, auto 는 우체국에 후보가 없을 때 juso 로 대체 */
export type LookupSource = 'epost' | 'juso' | 'auto'

export interface LookupRequest {
  searchText?: string
  oldAddr?: string
  oldZip?: string
  limit: number
  timeoutMs: number
  source: LookupSource
  /** false 면 입력 분석 없이 searchText 를 그대로 조회한다(기본: oldAddr 가 있으면 분석 검색) */
  analyze?: boolean
}

export type LookupValidation =
  | { ok: true; req: LookupRequest }
  | { ok: false; error: BridgeError }

const isStr = (x: unknown): x is string => typeof x === 'string'

export function validateLookup(msg: Record<string, unknown>): LookupValidation {
  const bad = (m: string): LookupValidation => ({ ok: false, error: ERRORS.invalid_request(m) })

  const q = msg.query
  if (!q || typeof q !== 'object' || Array.isArray(q)) return bad('query 가 없습니다')
  const query = q as Record<string, unknown>

  const text = (name: 'searchText' | 'oldAddr'): string | undefined | null => {
    const v = query[name]
    if (v === undefined) return undefined
    if (!isStr(v) || v.length > LIMITS.maxTextLen) return null
    return v.trim() || undefined
  }
  const searchText = text('searchText')
  const oldAddr = text('oldAddr')
  if (searchText === null) return bad('searchText 형식 오류(200자 이하 문자열)')
  if (oldAddr === null) return bad('oldAddr 형식 오류(200자 이하 문자열)')

  let oldZip: string | undefined
  if (query.oldZip !== undefined) {
    if (!isStr(query.oldZip) || !/^\d{6}$/.test(query.oldZip)) return bad('oldZip 형식 오류(6자리 숫자)')
    oldZip = query.oldZip
  }

  if (!searchText && !oldAddr && !oldZip) return bad('searchText, oldAddr, oldZip 중 하나가 필요합니다')

  const opt = msg.options
  if (opt !== undefined && (!opt || typeof opt !== 'object' || Array.isArray(opt))) return bad('options 형식 오류')
  const o = (opt ?? {}) as Record<string, unknown>

  let limit: number = LIMITS.defaultLimit
  if (o.limit !== undefined) {
    if (typeof o.limit !== 'number' || !Number.isInteger(o.limit) || o.limit < 1) return bad('limit 형식 오류')
    limit = Math.min(o.limit, LIMITS.maxLimit)
  }
  let timeoutMs: number = LIMITS.defaultTimeoutMs
  if (o.timeoutMs !== undefined) {
    if (typeof o.timeoutMs !== 'number' || !Number.isFinite(o.timeoutMs) || o.timeoutMs <= 0) return bad('timeoutMs 형식 오류')
    timeoutMs = Math.min(Math.max(o.timeoutMs, LIMITS.minTimeoutMs), LIMITS.maxTimeoutMs)
  }

  let source: LookupSource = 'epost'
  if (o.source !== undefined) {
    if (o.source !== 'epost' && o.source !== 'juso' && o.source !== 'auto') return bad('source 형식 오류')
    source = o.source
  }

  let analyze = true
  if (o.analyze !== undefined) {
    if (typeof o.analyze !== 'boolean') return bad('analyze 형식 오류')
    analyze = o.analyze
  }

  return { ok: true, req: { searchText, oldAddr, oldZip, limit, timeoutMs, source, analyze } }
}
