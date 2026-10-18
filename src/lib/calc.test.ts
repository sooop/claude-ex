import { describe, it, expect } from 'vitest'
import { evaluate } from './calc'

describe('evaluate 기본 계산', () => {
  it('변수가 들어간 제곱근: sqrt(x^2 + y^2) = 5', () => {
    const r = evaluate('sqrt(x^2 + y^2)', { x: 3, y: 4 })
    expect(r).toEqual({ ok: true, value: 5, text: '5' })
  })

  it('-2^2 는 -(2^2) = -4', () => {
    expect(evaluate('-2^2')).toEqual({ ok: true, value: -4, text: '-4' })
  })

  it('^ 는 우결합: 2^3^2 = 2^9 = 512', () => {
    expect(evaluate('2^3^2')).toEqual({ ok: true, value: 512, text: '512' })
  })

  it('min 은 인자 여러 개를 받는다: min(3,1,2) = 1', () => {
    expect(evaluate('min(3,1,2)')).toEqual({ ok: true, value: 1, text: '1' })
  })

  it('max 도 인자 여러 개를 받는다', () => {
    expect(evaluate('max(3,1,2)')).toEqual({ ok: true, value: 3, text: '3' })
  })

  it('0.1+0.2 는 text 가 "0.3" (기본 precision 12)', () => {
    const r = evaluate('0.1+0.2')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe('0.3')
    expect(r.value).toBeCloseTo(0.3, 15)
  })

  it('pi 는 근사값으로 계산된다', () => {
    const r = evaluate('pi')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toBeCloseTo(Math.PI, 12)
    expect(r.text).toBe('3.14159265359')
  })

  it('ln(e) = 1', () => {
    const r = evaluate('ln(e)')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toBeCloseTo(1, 12)
    expect(r.text).toBe('1')
  })

  it('log 는 상용로그: log(1000) = 3', () => {
    const r = evaluate('log(1000)')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toBeCloseTo(3, 12)
    expect(r.text).toBe('3')
  })

  it('단항 +, 지수 표기, 나머지 연산', () => {
    expect(evaluate('+3')).toMatchObject({ ok: true, value: 3 })
    expect(evaluate('1e3')).toMatchObject({ ok: true, value: 1000, text: '1000' })
    expect(evaluate('7%3')).toMatchObject({ ok: true, value: 1 })
  })

  it('2^-1 처럼 지수 자리에 단항 마이너스를 쓸 수 있다', () => {
    expect(evaluate('2^-1')).toMatchObject({ ok: true, value: 0.5, text: '0.5' })
  })
})

describe('evaluate precision', () => {
  it('precision 2 이면 1/3 은 "0.33"', () => {
    expect(evaluate('1/3', undefined, 2)).toEqual({ ok: true, value: 1 / 3, text: '0.33' })
  })

  it('precision 0 이면 정수 반올림 문자열, value 는 반올림 전 값', () => {
    expect(evaluate('2.5', undefined, 0)).toEqual({ ok: true, value: 2.5, text: '3' })
  })

  it('precision 이 0~15 밖이면 invalid_request', () => {
    expect(evaluate('1', undefined, 16)).toMatchObject({ ok: false, code: 'invalid_request' })
    expect(evaluate('1', undefined, -1)).toMatchObject({ ok: false, code: 'invalid_request' })
    expect(evaluate('1', undefined, 1.5)).toMatchObject({ ok: false, code: 'invalid_request' })
  })
})

describe('evaluate math_error', () => {
  it('1/0 은 math_error', () => {
    expect(evaluate('1/0')).toMatchObject({ ok: false, code: 'math_error' })
  })

  it('5%0 은 math_error', () => {
    expect(evaluate('5%0')).toMatchObject({ ok: false, code: 'math_error' })
  })

  it('sqrt(-1) 은 math_error (NaN)', () => {
    expect(evaluate('sqrt(-1)')).toMatchObject({ ok: false, code: 'math_error' })
  })

  it('중간 결과가 Infinity 이면 math_error', () => {
    expect(evaluate('1e308*10')).toMatchObject({ ok: false, code: 'math_error' })
    expect(evaluate('2^1024')).toMatchObject({ ok: false, code: 'math_error' })
  })
})

describe('evaluate invalid_request', () => {
  it('2+*3 은 pos 2 의 문법 오류', () => {
    expect(evaluate('2+*3')).toMatchObject({ ok: false, code: 'invalid_request', pos: 2 })
  })

  it('모르는 함수 foo(1)', () => {
    expect(evaluate('foo(1)')).toMatchObject({ ok: false, code: 'invalid_request', pos: 0 })
  })

  it('모르는 이름 z+1', () => {
    expect(evaluate('z+1')).toMatchObject({ ok: false, code: 'invalid_request', pos: 0 })
  })

  it('괄호 불일치 (1+2 는 pos 4', () => {
    expect(evaluate('(1+2')).toMatchObject({ ok: false, code: 'invalid_request', pos: 4 })
  })

  it('인자 개수 오류: sqrt(1,2) 는 쉼표 위치 pos 6, min() 은 닫는 괄호 위치 pos 4', () => {
    expect(evaluate('sqrt(1,2)')).toMatchObject({ ok: false, code: 'invalid_request', pos: 6 })
    expect(evaluate('min()')).toMatchObject({ ok: false, code: 'invalid_request', pos: 4 })
  })

  it('함수 이름을 변수처럼 쓰면 invalid_request', () => {
    expect(evaluate('sqrt+1')).toMatchObject({ ok: false, code: 'invalid_request', pos: 0 })
  })

  it('허용되지 않는 문자와 불완전한 지수 표기', () => {
    expect(evaluate('1 # 2')).toMatchObject({ ok: false, code: 'invalid_request', pos: 2 })
    expect(evaluate('2e')).toMatchObject({ ok: false, code: 'invalid_request', pos: 1 })
  })

  it('expr 길이는 1~500자', () => {
    expect(evaluate('')).toMatchObject({ ok: false, code: 'invalid_request' })
    expect(evaluate('1+'.repeat(250) + '1')).toMatchObject({ ok: false, code: 'invalid_request' })
    expect(evaluate('1' + '+1'.repeat(249))).toMatchObject({ ok: true })
  })
})

describe('evaluate vars 검증', () => {
  it('vars 17개는 invalid_request', () => {
    const vars: Record<string, number> = {}
    for (let i = 0; i < 17; i++) vars[`v${i}`] = i
    expect(evaluate('v0', vars)).toMatchObject({ ok: false, code: 'invalid_request' })
  })

  it('vars 16개는 허용', () => {
    const vars: Record<string, number> = {}
    for (let i = 0; i < 16; i++) vars[`v${i}`] = i
    expect(evaluate('v15', vars)).toMatchObject({ ok: true, value: 15 })
  })

  it('vars 에 pi 가 있으면 invalid_request (상수 이름은 변수로 못 쓴다)', () => {
    expect(evaluate('pi', { pi: 1 })).toMatchObject({ ok: false, code: 'invalid_request' })
  })

  it('vars 에 함수 이름이 있으면 invalid_request', () => {
    expect(evaluate('1', { sqrt: 1 })).toMatchObject({ ok: false, code: 'invalid_request' })
  })

  it('변수 이름 규칙 위반과 비유한 값은 invalid_request', () => {
    expect(evaluate('1', { '1x': 1 })).toMatchObject({ ok: false, code: 'invalid_request' })
    expect(evaluate('x', { x: NaN })).toMatchObject({ ok: false, code: 'invalid_request' })
    expect(evaluate('x', { x: Infinity })).toMatchObject({ ok: false, code: 'invalid_request' })
  })
})
