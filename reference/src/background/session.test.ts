import { describe, expect, it } from 'vitest'
import { normalizePage } from '@/lib/normalize'
import { RequestQueue } from './queue'
import { BridgeSession } from './session'
import { APP_SOURCE } from '@/lib/protocol'
import jibun from '@/lib/__fixtures__/jibun.json'
import empty from '@/lib/__fixtures__/empty.json'

type Msg = Record<string, any>

const lookup = (id: string, query: Record<string, unknown>, options?: Record<string, unknown>, v = 1) =>
  ({ source: APP_SOURCE, v, type: 'lookup', id, query, ...(options ? { options } : {}) })

/** 테스트는 조회처의 원본 JSON 을 돌려주고, 세션에는 정규화까지 마친 결과로 넘긴다 */
type RawFetch = (keyword: string, pageIdx: number, pageSize: number, signal: AbortSignal) => Promise<unknown>

function setup(fetchPage: RawFetch, minIntervalMs = 5) {
  const out: Msg[] = []
  const times: number[] = []
  const queue = new RequestQueue({ minIntervalMs, maxLength: 50 })
  const session = new BridgeSession((m) => out.push(m), {
    queue,
    extVersion: '9.9.9',
    now: Date.now,
    fetchPage: async (kw, idx, size, _source, signal) => {
      times.push(Date.now())
      return normalizePage(await fetchPage(kw, idx, size, signal), idx, size)
    },
  })
  const waitFor = async (pred: (m: Msg) => boolean, ms = 3000): Promise<Msg> => {
    const start = Date.now()
    while (Date.now() - start < ms) {
      const hit = out.find(pred)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('timeout waiting for message')
  }
  const result = (id: string) => waitFor((m) => m.type === 'result' && m.id === id)
  return { out, times, session, result, waitFor }
}

const ok = (json: unknown) => async () => json
const hang: RawFetch = (_k, _i, _s, signal) =>
  new Promise((_res, rej) => signal.addEventListener('abort', () => rej(signal.reason), { once: true }))

describe('수용 기준', () => {
  it('1. ping → pong (features, limits 포함)', async () => {
    const t = setup(ok(empty))
    t.session.handle({ source: APP_SOURCE, v: 1, type: 'ping', id: 'a1' })
    const pong = await t.waitFor((m) => m.type === 'pong')
    expect(pong).toMatchObject({ id: 'a1', ok: true, extVersion: '9.9.9', supportedVersions: [1] })
    expect(pong.features).toEqual(expect.arrayContaining(['lookup', 'cancel', 'progress']))
    expect(pong.limits).toMatchObject({ minIntervalMs: 500, maxLimit: 20, defaultTimeoutMs: 15000 })
  })

  it('2. 정상 조회: 후보 1건 이상, zip5 5자리, road 비어 있지 않음, 범위 행은 제외', async () => {
    const t = setup(ok(jibun))
    t.session.handle(lookup('b7', { searchText: '역삼동 736-1' }))
    const r = await t.result('b7')
    expect(r.ok).toBe(true)
    expect(r.candidates.length).toBeGreaterThanOrEqual(1)
    for (const c of r.candidates) {
      expect(c.zip5).toMatch(/^\d{5}$/)
      expect(c.road).not.toBe('')
    }
    expect(r.meta).toMatchObject({ source: 'epost', queryUsed: '역삼동 736-1', parserVersion: expect.any(String) })
  })

  it('11. 같은 zip5+road 는 한 번만 반환', async () => {
    const t = setup(ok(jibun)) // 캐피탈타워/롯데캐피탈 두 행이 같은 zip5+road
    t.session.handle(lookup('d1', { searchText: '역삼동 736-1' }))
    const r = await t.result('d1')
    expect(r.candidates).toHaveLength(1)
  })

  it('3. 결과 없음은 ok:true 와 빈 배열', async () => {
    const t = setup(ok(empty))
    t.session.handle(lookup('c1', { searchText: '없는동 9999' }))
    const r = await t.result('c1')
    expect(r).toMatchObject({ ok: true, candidates: [] })
  })

  it('4. oldZip 만 보내면 oldZipSearch 로 조회(우체국이 구우편번호 검색을 지원)', async () => {
    const t = setup(ok(empty))
    t.session.handle(lookup('e1', { oldZip: '135924' }))
    const r = await t.result('e1')
    expect(r.ok).toBe(true)
    expect(r.meta.queryUsed).toBe('135924')
  })

  it('4-b. 검색어를 만들 수 없는 oldAddr 만 오면 unsupported_query', async () => {
    const t = setup(ok(empty))
    t.session.handle(lookup('e2', { oldAddr: '서울특별시' }))
    const r = await t.result('e2')
    expect(r).toMatchObject({ ok: false, error: { code: 'unsupported_query', retryable: false } })
  })

  it('5. 필드 누락, 200자 초과, 미지원 v 는 invalid_request', async () => {
    const t = setup(ok(empty))
    t.session.handle(lookup('f1', {}))
    t.session.handle(lookup('f2', { searchText: 'ㄱ'.repeat(201) }))
    t.session.handle(lookup('f3', { searchText: '역삼동 1' }, undefined, 2))
    t.session.handle(lookup('f4', { oldZip: '12345' }))
    for (const id of ['f1', 'f2', 'f3', 'f4']) {
      expect((await t.result(id)).error.code).toBe('invalid_request')
    }
  })

  it('6. 우체국 무응답은 timeoutMs 안에 timeout(retryable)', async () => {
    const t = setup(hang)
    t.session.handle(lookup('g1', { searchText: '역삼동 1' }, { timeoutMs: 1000 }))
    const r = await t.waitFor((m) => m.type === 'result' && m.id === 'g1', 2500)
    expect(r.error).toMatchObject({ code: 'timeout', retryable: true })
  })

  it('7. 조회 중 cancel 은 cancelled 로 응답하고 이후 result 가 더 오지 않음', async () => {
    const t = setup(hang)
    t.session.handle(lookup('h1', { searchText: '역삼동 1' }))
    await t.waitFor((m) => m.type === 'progress' && m.id === 'h1')
    t.session.handle({ source: APP_SOURCE, v: 1, type: 'cancel', id: 'h1' })
    const r = await t.result('h1')
    expect(r.error.code).toBe('cancelled')
    await new Promise((res) => setTimeout(res, 50))
    expect(t.out.filter((m) => m.type === 'result' && m.id === 'h1')).toHaveLength(1)
    expect(t.out.filter((m) => m.type === 'progress' && m.id === 'h1').length).toBeLessThanOrEqual(1)
  })

  it('7-b. 이미 끝난 id 의 cancel 은 무시', async () => {
    const t = setup(ok(empty))
    t.session.handle(lookup('i1', { searchText: '역삼동 1' }))
    await t.result('i1')
    t.session.handle({ source: APP_SOURCE, v: 1, type: 'cancel', id: 'i1' })
    await new Promise((res) => setTimeout(res, 30))
    expect(t.out.filter((m) => m.type === 'result' && m.id === 'i1')).toHaveLength(1)
  })

  it('8. 20건 연속 lookup: 요청 간격 ≥ minIntervalMs, 응답 id 일치', async () => {
    const t = setup(ok(empty), 30)
    const ids = Array.from({ length: 20 }, (_, i) => `k${i}`)
    ids.forEach((id) => t.session.handle(lookup(id, { searchText: `역삼동 ${id.slice(1)}` })))
    const results = await Promise.all(ids.map((id) => t.waitFor((m) => m.type === 'result' && m.id === id, 5000)))
    expect(results.map((r) => r.id)).toEqual(ids)
    for (let i = 1; i < t.times.length; i++) {
      expect(t.times[i] - t.times[i - 1]).toBeGreaterThanOrEqual(28) // 타이머 오차 허용
    }
    // 응답은 요청 순서대로
    const order = t.out.filter((m) => m.type === 'result').map((m) => m.id)
    expect(order).toEqual(ids)
  })

  it('9. 알 수 없는 source / 형식은 응답 없이 무시', async () => {
    const t = setup(ok(empty))
    t.session.handle({ source: 'evil', v: 1, type: 'ping', id: 'x' })
    t.session.handle({ source: APP_SOURCE, v: '1', type: 'ping', id: 'x' })
    t.session.handle({ source: APP_SOURCE, v: 1, type: 'unknown', id: 'x' })
    t.session.handle({ source: APP_SOURCE, v: 1, type: 'ping' })
    t.session.handle(null)
    await new Promise((res) => setTimeout(res, 30))
    expect(t.out).toEqual([])
  })

  it('10. 응답 구조가 바뀌면 parse_failed 와 meta.parserVersion', async () => {
    const t = setup(ok({ unexpected: true }))
    t.session.handle(lookup('m1', { searchText: '역삼동 1' }))
    const r = await t.result('m1')
    expect(r).toMatchObject({ ok: false, error: { code: 'parse_failed', retryable: false } })
    expect(r.meta.parserVersion).toEqual(expect.any(String))
  })
})

describe('오류 매핑과 재시도', () => {
  it('네트워크 오류는 1회만 재시도하고 이후 network', async () => {
    let calls = 0
    const t = setup(async () => { calls++; throw new TypeError('Failed to fetch') })
    t.session.handle(lookup('n1', { searchText: '역삼동 1' }))
    const r = await t.result('n1')
    expect(r.error).toMatchObject({ code: 'network', retryable: true })
    expect(calls).toBe(2)
  })

  it('중복 진행 id 는 invalid_request', async () => {
    const t = setup(hang)
    t.session.handle(lookup('p1', { searchText: '역삼동 1' }))
    t.session.handle(lookup('p1', { searchText: '역삼동 2' }))
    const r = await t.waitFor((m) => m.type === 'result' && m.id === 'p1')
    expect(r.error.code).toBe('invalid_request')
    t.session.dispose()
  })

  it('세션 종료 시 진행 중인 조회를 중단한다', async () => {
    const t = setup(hang)
    t.session.handle(lookup('q1', { searchText: '역삼동 1' }))
    await t.waitFor((m) => m.type === 'progress')
    t.session.dispose()
    await new Promise((res) => setTimeout(res, 30))
    // dispose 후 대기 중이던 작업은 취소되며 새 작업이 정상 진행 가능
    const t2 = setup(ok(empty))
    t2.session.handle(lookup('q2', { searchText: '역삼동 1' }))
    expect((await t2.result('q2')).ok).toBe(true)
  })
})

describe('프로토콜 v2', () => {
  const call = (id: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ source: 'ab-app', v: 2, ns: 'postal-converter', type: 'call', id, op: 'web.query', ver: 1, args, ...extra })
  const q = (params: Record<string, unknown>, adapter = 'epost-zip') => ({ adapter, params })

  it('hello → hello_ack(provides 에 web.query, supportedVersions [2])', async () => {
    const t = setup(ok(empty))
    t.session.handle({ source: 'ab-app', v: 2, ns: 'postal-converter', type: 'hello', id: 'h1' })
    const ack = await t.waitFor((m) => m.type === 'hello_ack')
    expect(ack).toMatchObject({ source: 'ab-ext', v: 2, ns: 'postal-converter', id: 'h1', ok: true, supportedVersions: [2] })
    expect(ack.provides).toEqual(expect.arrayContaining([expect.objectContaining({ op: 'web.query', ver: 1, kind: 'read' })]))
  })

  it('확장이 먼저 hello 를 보낸다', () => {
    const t = setup(ok(empty))
    t.session.hello()
    expect(t.out[0]).toMatchObject({ source: 'ab-ext', type: 'hello', role: 'extension' })
  })

  it('web.query 정상: data.items, meta.untrusted', async () => {
    const t = setup(ok(jibun))
    t.session.handle(call('c1', q({ searchText: '역삼동 736-1' })))
    const r = await t.result('c1')
    expect(r).toMatchObject({ source: 'ab-ext', ok: true })
    expect(r.data.items.length).toBeGreaterThan(0)
    expect(r.meta).toMatchObject({ untrusted: true })
  })

  it('미지원 op / 버전 / 스키마 위반 / 알 수 없는 필드', async () => {
    const t = setup(ok(empty))
    t.session.handle(call('u1', q({ searchText: 'x' }), { op: 'file.save' }))
    t.session.handle(call('u2', q({ searchText: 'x' }), { ver: 9 }))
    t.session.handle(call('u3', q({})))
    t.session.handle(call('u4', { ...q({ searchText: 'x' }), url: 'https://evil' }))
    t.session.handle(call('u5', q({ searchText: 'x' }, 'nope')))
    t.session.handle({ ...call('u6', q({ searchText: 'x' })), v: 3 })
    expect((await t.result('u1')).error.code).toBe('unsupported_op')
    expect((await t.result('u2')).error.code).toBe('unsupported_op')
    expect((await t.result('u3')).error.code).toBe('invalid_request')
    expect((await t.result('u4')).error.code).toBe('invalid_request')
    expect((await t.result('u5')).error.code).toBe('invalid_request')
    expect((await t.result('u6')).error.code).toBe('unsupported_version')
  })

  it('동시 1건 초과는 busy(재시도 가능), cancel 은 cancelled', async () => {
    const t = setup(hang)
    t.session.handle(call('d1', q({ searchText: '역삼동 736-1' })))
    t.session.handle(call('d2', q({ searchText: '역삼동 736-1' })))
    const busy = await t.result('d2')
    expect(busy.error).toMatchObject({ code: 'busy', retryable: true })
    t.session.handle({ source: 'ab-app', v: 2, ns: 'postal-converter', type: 'cancel', id: 'd1' })
    expect((await t.result('d1')).error.code).toBe('cancelled')
  })

  it('타임아웃은 v2 timeout(재시도 가능)', async () => {
    const t = setup(hang)
    t.session.handle(call('t1', q({ searchText: '역삼동 736-1' }), { opts: { timeoutMs: 1000 } }))
    const r = await t.waitFor((m) => m.type === 'result' && m.id === 't1', 4000)
    expect(r.error).toMatchObject({ code: 'timeout', retryable: true })
  })

  it('v1 메시지는 그대로 동작한다', async () => {
    const t = setup(ok(jibun))
    t.session.handle(lookup('v1', { searchText: '역삼동 736-1' }))
    const r = await t.result('v1')
    expect(r).toMatchObject({ source: 'postal-bridge', v: 1, ok: true })
  })
})
