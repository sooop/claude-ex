import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { calcEval } from './ops/calc'
import { OpError, createRegistry, type OpDef } from './registry'
import { AppSession, callWithRetry, type SessionDeps } from './session'

type Msg = Record<string, any>

const app = (o: Msg) => ({ source: 'ab-app', v: 2, ns: 'claude-ex-poc', ...o })

/** 끝나지 않는 op(취소·타임아웃 확인용) */
const slow: OpDef = {
  ...calcEval, name: 'test.slow', summary: 'slow', extraCodes: [],
  args: { type: 'object' }, limits: { maxConcurrent: 1, timeoutMs: 3_000 },
  handler: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new OpError({ code: 'cancelled', message: 'x', retryable: false })))),
}

function setup() {
  const sent: Msg[] = []
  const logs: Msg[] = []
  let n = 0
  const deps: SessionDeps = {
    registry: createRegistry([calcEval, slow]),
    log: { appendSafe: async (e) => { logs.push(e) } },
    extVersion: '0.1.0',
    now: () => Date.now(),
    uuid: () => `u${++n}`,
    defaultNs: 'claude-ex-poc',
    onPeerChange: vi.fn(),
  }
  const s = new AppSession((m) => sent.push(m), deps, 'https://x.frame.claudeusercontent.com', 7)
  const results = () => sent.filter((m) => m.type === 'result')
  return { s, sent, logs, deps, results }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('핸드셰이크', () => {
  it('앱 hello 에 같은 id 로 hello_ack 하고 catalogRev·provides 를 싣는다', () => {
    const { s, sent, deps } = setup()
    s.handle(app({ type: 'hello', id: 'h1', supportedVersions: [2], provides: [{ op: 'text.translate', ver: 1, kind: 'read' }] }))
    const ack = sent.find((m) => m.type === 'hello_ack')!
    expect(ack).toMatchObject({ id: 'h1', ok: true, source: 'ab-ext', ns: 'claude-ex-poc', supportedVersions: [2] })
    expect(ack.catalogRev).toMatch(/^[0-9a-f]{8}$/)
    expect(ack.provides.map((p: Msg) => p.op)).toEqual(['meta.describe', 'calc.eval', 'test.slow'])
    expect(s.provides('text.translate', 1)).toBeTruthy()
    expect(deps.onPeerChange).toHaveBeenCalled()
  })
  it('확장 hello 는 defaultNs 로 나간다', () => {
    const { s, sent } = setup()
    s.hello()
    expect(sent[0]).toMatchObject({ type: 'hello', ns: 'claude-ex-poc' })
  })
  it('needs_setup op 는 제공하지 않는 것으로 본다', () => {
    const { s } = setup()
    s.handle(app({ type: 'hello_ack', id: 'h', provides: [{ op: 'text.translate', ver: 1, state: 'needs_setup' }] }))
    expect(s.provides('text.translate', 1)).toBeUndefined()
  })
})

describe('앱 → 확장 call', () => {
  it('calc.eval 성공과 로그', async () => {
    const { s, results, logs } = setup()
    s.handle(app({ type: 'call', id: 'c1', op: 'calc.eval', ver: 1, args: { expr: 'sqrt(x^2 + y^2)', vars: { x: 3, y: 4 } } }))
    await flush()
    expect(results()[0]).toMatchObject({ id: 'c1', ok: true, data: { value: 5, text: '5' } })
    expect(logs[0]).toMatchObject({ op: 'calc.eval', ok: true, args: { expr: 'sqrt(x^2 + y^2)' }, data: { value: 5 } })
  })
  it('math_error, invalid_request + pos', async () => {
    const { s, results } = setup()
    s.handle(app({ type: 'call', id: 'a', op: 'calc.eval', ver: 1, args: { expr: '1/0' } }))
    await flush()
    s.handle(app({ type: 'call', id: 'b', op: 'calc.eval', ver: 1, args: { expr: '2+*3' } }))
    await flush()
    const r = results()
    expect(r.find((m) => m.id === 'a')!.error.code).toBe('math_error')
    expect(r.find((m) => m.id === 'b')!.error).toMatchObject({ code: 'invalid_request', detail: { pos: 2 } })
  })
  it('스키마에 없는 인자는 invalid_request', async () => {
    const { s, results } = setup()
    s.handle(app({ type: 'call', id: 'a', op: 'calc.eval', ver: 1, args: { expr: '1', evil: 1 } }))
    await flush()
    expect(results()[0].error.code).toBe('invalid_request')
  })
  it('없는 op 는 unsupported_op + detail.known, 로그도 남는다', async () => {
    const { s, results, logs } = setup()
    s.handle(app({ type: 'call', id: 'a', op: 'web.query', ver: 1, args: {} }))
    await flush()
    expect(results()[0].error).toMatchObject({ code: 'unsupported_op', detail: { known: ['meta.describe', 'calc.eval', 'test.slow'] } })
    expect(logs[0]).toMatchObject({ op: 'web.query', ok: false, error: { code: 'unsupported_op' } })
  })
  it('meta.describe: 목록, 상세, 없는 op', async () => {
    const { s, results } = setup()
    s.handle(app({ type: 'call', id: 'a', op: 'meta.describe', ver: 1, args: {} }))
    await flush()
    s.handle(app({ type: 'call', id: 'b', op: 'meta.describe', ver: 1, args: { op: 'calc.eval' } }))
    await flush()
    s.handle(app({ type: 'call', id: 'c', op: 'meta.describe', ver: 1, args: { op: 'nope.x' } }))
    await flush()
    const r = Object.fromEntries(results().map((m) => [m.id, m]))
    expect(r.a.data.provides).toHaveLength(3)
    expect(r.a.data.catalogRev).toMatch(/^[0-9a-f]{8}$/)
    expect(r.b.data).toMatchObject({ op: 'calc.eval', args: { required: ['expr'] } })
    expect(r.b.data.examples.length).toBeLessThanOrEqual(3)
    expect(r.c.error).toMatchObject({ code: 'unsupported_op', detail: { known: expect.arrayContaining(['calc.eval']) } })
  })
  it('같은 op 동시 호출은 busy, cancel 은 cancelled', async () => {
    const { s, results } = setup()
    s.handle(app({ type: 'call', id: 'a', op: 'test.slow', ver: 1, args: {} }))
    s.handle(app({ type: 'call', id: 'b', op: 'test.slow', ver: 1, args: {} }))
    await flush()
    expect(results().find((m) => m.id === 'b')!.error.code).toBe('busy')
    s.handle(app({ type: 'cancel', id: 'a' }))
    await flush()
    expect(results().find((m) => m.id === 'a')!.error.code).toBe('cancelled')
  })
  it('잘못된 v 는 unsupported_version', async () => {
    const { s, results } = setup()
    s.handle(app({ type: 'call', id: 'a', v: 3, op: 'calc.eval', ver: 1, args: { expr: '1' } }))
    await flush()
    expect(results()[0].error.code).toBe('unsupported_version')
  })
})

describe('확장 → 앱 call', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const ready = () => {
    const ctx = setup()
    ctx.s.handle(app({ type: 'hello', id: 'h', provides: [{ op: 'text.translate', ver: 1, kind: 'read' }] }))
    return ctx
  }

  it('result 로 resolve, progress 전달, 늦은 중복 result 무시', async () => {
    const { s, sent } = ready()
    const onProgress = vi.fn()
    const p = s.callApp('text.translate', 1, { text: '안녕', tier: 'quick' }, { timeoutMs: 5000, onProgress })
    const call = sent.find((m) => m.type === 'call')!
    expect(call).toMatchObject({ op: 'text.translate', ver: 1, args: { text: '안녕', tier: 'quick' }, opts: { timeoutMs: 5000 } })
    s.handle(app({ type: 'progress', id: call.id, stage: 'translating' }))
    s.handle(app({ type: 'result', id: call.id, ok: true, data: { text: 'Hello' } }))
    s.handle(app({ type: 'result', id: call.id, ok: false, error: { code: 'internal' } }))
    await expect(p).resolves.toEqual({ text: 'Hello' })
    expect(onProgress).toHaveBeenCalledWith('translating', undefined)
  })
  it('timeoutMs + 2초 뒤 timeout, cancel 전송, 뒤늦은 result 무시', async () => {
    const { s, sent } = ready()
    const p = s.callApp('text.translate', 1, { text: 'a', tier: 'quick' }, { timeoutMs: 5000 })
    const err = p.catch((e) => e)
    vi.advanceTimersByTime(6999)
    expect(sent.some((m) => m.type === 'cancel')).toBe(false)
    vi.advanceTimersByTime(1)
    expect(await err).toMatchObject({ code: 'timeout' })
    expect(sent.some((m) => m.type === 'cancel')).toBe(true)
    const id = sent.find((m) => m.type === 'call')!.id
    expect(() => s.handle(app({ type: 'result', id, ok: true, data: {} }))).not.toThrow()
  })
  it('제공하지 않는 op 는 보내지 않고 unsupported_op', async () => {
    const { s, sent } = setup()
    await expect(s.callApp('text.translate', 1, {})).rejects.toMatchObject({ code: 'unsupported_op' })
    expect(sent.some((m) => m.type === 'call')).toBe(false)
  })
  it('모르는 오류 코드는 internal', async () => {
    const { s, sent } = ready()
    const p = s.callApp('text.translate', 1, {})
    s.handle(app({ type: 'result', id: sent.find((m) => m.type === 'call')!.id, ok: false, error: { code: 'zzz', message: 'm' } }))
    await expect(p).rejects.toMatchObject({ code: 'internal' })
  })
  it('signal 로 취소하면 cancel 을 보내고 cancelled', async () => {
    const { s, sent } = ready()
    const ac = new AbortController()
    const p = s.callApp('text.translate', 1, {}, { signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toMatchObject({ code: 'cancelled' })
    expect(sent.some((m) => m.type === 'cancel')).toBe(true)
  })
  it('dispose 하면 진행 중 호출이 internal 로 끝난다', async () => {
    const { s } = ready()
    const p = s.callApp('text.translate', 1, {})
    s.dispose()
    await expect(p).rejects.toMatchObject({ code: 'internal' })
  })
})

describe('callWithRetry', () => {
  it('busy 는 최대 2회 재시도', async () => {
    const call = vi.fn().mockRejectedValue({ code: 'busy', retryable: true })
    await expect(callWithRetry(call, { sleep: async () => {} })).rejects.toMatchObject({ code: 'busy' })
    expect(call).toHaveBeenCalledTimes(3)
  })
  it('timeout 은 재시도하지 않는다', async () => {
    const call = vi.fn().mockRejectedValue({ code: 'timeout', retryable: true })
    await expect(callWithRetry(call, { sleep: async () => {} })).rejects.toMatchObject({ code: 'timeout' })
    expect(call).toHaveBeenCalledTimes(1)
  })
  it('재시도 중 성공하면 값을 돌려준다', async () => {
    const call = vi.fn().mockRejectedValueOnce({ code: 'busy' }).mockResolvedValue(1)
    await expect(callWithRetry(call, { sleep: async () => {} })).resolves.toBe(1)
  })
})
