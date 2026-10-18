import { describe, expect, it } from 'vitest'
import { cleanText, isV2Envelope, normalizeError, parseProvides, validateCall } from './protocol'
import { validateSchema } from './schema'

const env = (o: Record<string, unknown> = {}) => ({ source: 'ab-app', v: 2, ns: 'claude-ex-poc', type: 'call', id: 'a1', ...o })

describe('봉투 검증', () => {
  it('정상 봉투를 받는다', () => expect(isV2Envelope(env())).toBe(true))
  it.each([
    ['source', { source: 'ab-ext' }],
    ['ns 형식', { ns: 'Bad NS' }],
    ['type', { type: 'ping' }],
    ['id 없음', { id: '' }],
    ['v 문자열', { v: '2' }],
  ])('%s 이 틀리면 무시한다', (_, o) => expect(isV2Envelope(env(o))).toBe(false))
})

describe('validateCall', () => {
  it('timeoutMs 를 1,000~300,000 으로 자른다', () => {
    const r = validateCall({ op: 'calc.eval', ver: 1, args: {}, opts: { timeoutMs: 10 } })
    expect(r.ok && r.call.timeoutMs).toBe(1000)
  })
  it('args 가 없으면 invalid_request', () => {
    const r = validateCall({ op: 'calc.eval', ver: 1 })
    expect(!r.ok && r.error.code).toBe('invalid_request')
  })
  it('op 형식 오류', () => {
    const r = validateCall({ op: 'calc', ver: 1, args: {} })
    expect(!r.ok && r.error.code).toBe('invalid_request')
  })
})

describe('오류 정규화', () => {
  it('모르는 코드는 internal', () => expect(normalizeError({ code: 'weird', message: 'x' }).code).toBe('internal'))
  it('공통 코드는 유지', () => expect(normalizeError({ code: 'busy', message: 'x', retryable: true })).toMatchObject({ code: 'busy', retryable: true }))
  it('op 고유 코드는 known 에 있으면 유지', () => expect(normalizeError({ code: 'math_error' }, ['math_error']).code).toBe('math_error'))
})

describe('provides 정제', () => {
  it('형식이 맞지 않는 항목을 버리고 summary 를 80자로 자른다', () => {
    const p = parseProvides([{ op: 'text.translate', ver: 1, summary: 'x'.repeat(200) }, { op: 'BAD', ver: 1 }, 'x'])
    expect(p).toHaveLength(1)
    expect(p[0].summary).toHaveLength(80)
    expect(p[0].kind).toBe('read')
  })
})

describe('cleanText', () => {
  it('태그와 꺾쇠를 지우고 자른다', () => expect(cleanText('<b>hi</b> a<b', 5)).toBe('hi ab'))
})

describe('스키마 검증기', () => {
  const s = {
    type: 'object' as const,
    required: ['text'],
    properties: { text: { type: 'string' as const, maxLength: 3 }, n: { type: 'integer' as const, default: 2 } },
  }
  it('default 를 채운다', () => expect(validateSchema(s, { text: 'ab' })).toEqual({ value: { text: 'ab', n: 2 }, skip: false }))
  it('선언 외 필드를 거부한다', () => expect(validateSchema(s, { text: 'a', x: 1 }).err).toMatch('허용되지 않은 필드'))
  it('필수 필드 누락', () => expect(validateSchema(s, {}).err).toMatch('필수 필드'))
  it('길이 초과', () => expect(validateSchema(s, { text: 'abcd' }).err).toMatch('너무 깁니다'))
  it('additionalProperties 스키마로 값 검사', () => {
    const m = { type: 'object' as const, additionalProperties: { type: 'number' as const } }
    expect(validateSchema(m, { x: 1 }).err).toBeUndefined()
    expect(validateSchema(m, { x: 'a' }).err).toMatch('숫자')
  })
  it('지원하지 않는 키워드는 건너뛴다', () => expect(validateSchema({ oneOf: [] } as never, 1)).toEqual({ value: 1, skip: true }))
  it('__proto__ 키 거부', () => expect(validateSchema({ type: 'object' }, JSON.parse('{"__proto__":1}')).err).toBeDefined())
})
