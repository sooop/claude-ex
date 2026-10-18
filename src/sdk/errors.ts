// v2 오류 코드와 정규화. 허브와 플러그인이 같은 오류 형식을 쓴다(명세 01 3.5).

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

