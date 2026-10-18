import { describe, expect, it, vi } from 'vitest'
import { PluginError, serveAsCompanion, type CompanionRuntime, type InvokeContext, type PortLike } from './companion'
import { CHANNEL, type PluginCatalog } from './plugin'

const HUB = 'hub-id'

const catalog: PluginCatalog = {
  ops: [],
  adapters: {
    'web.query': [{
      id: 'demo', summary: '데모', description: '데모 어댑터', hosts: ['example.com'],
      params: { type: 'object', required: ['q'], properties: { q: { type: 'string', maxLength: 10 }, limit: { type: 'integer', default: 5 } } },
    }],
  },
}

function fakePort(senderId = HUB, name: string = CHANNEL.callPort) {
  const onMsg: ((m: unknown) => void)[] = []
  const onDisc: (() => void)[] = []
  const sent: unknown[] = []
  const port: PortLike = {
    name,
    sender: { id: senderId },
    postMessage: (m) => { sent.push(m) },
    disconnect: vi.fn(),
    onMessage: { addListener: (fn) => { onMsg.push(fn) } },
    onDisconnect: { addListener: (fn) => { onDisc.push(fn) } },
  }
  return { port, sent, emit: (m: unknown) => onMsg.forEach((f) => f(m)), close: () => onDisc.forEach((f) => f()) }
}

function setup(handle: (req: { args: Record<string, unknown> }, ctx: InvokeContext) => Promise<unknown>, sendMessage = vi.fn(async () => ({ status: 'active' }))) {
  let connect: (p: PortLike) => void = () => {}
  const runtime: CompanionRuntime = { sendMessage, onConnectExternal: { addListener: (fn) => { connect = fn } } }
  const onRegister = vi.fn()
  serveAsCompanion({ hubId: HUB, name: 'demo', version: '1.0.0', catalog, handle, runtime, onRegister })
  return { connect: (p: PortLike) => connect(p), sendMessage, onRegister }
}

const invoke = (args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ type: 'invoke', op: 'web.query', ver: 1, adapter: 'demo', args, timeoutMs: 1000, sender: { ns: 'app', origin: 'https://x' }, ...extra })

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('serveAsCompanion', () => {
  it('시작하면 허브에 등록을 보낸다. 허브가 없으면 null', async () => {
    const { sendMessage, onRegister } = setup(async () => null)
    await flush()
    expect(sendMessage).toHaveBeenCalledWith(HUB, expect.objectContaining({ kind: CHANNEL.register, sdk: 1, catalog }))
    expect(onRegister).toHaveBeenCalledWith({ status: 'active' })

    const missing = setup(async () => null, vi.fn(async () => { throw new Error('Could not establish connection') }))
    await flush()
    expect(missing.onRegister).toHaveBeenCalledWith(null)
  })

  it('정상 호출: default 를 채워 핸들러에 넘기고 progress 와 result 를 보낸다', async () => {
    const { connect } = setup(async (req, ctx) => {
      ctx.progress('조회 중')
      return { echo: req.args }
    })
    const p = fakePort()
    connect(p.port)
    p.emit(invoke({ q: 'abc' }))
    await flush()
    expect(p.sent).toEqual([
      { type: 'progress', stage: '조회 중' },
      { type: 'result', ok: true, data: { echo: { q: 'abc', limit: 5 } } },
    ])
  })

  it('허브가 아닌 확장의 연결은 끊는다', () => {
    const { connect } = setup(async () => null)
    const p = fakePort('other')
    connect(p.port)
    expect(p.port.disconnect).toHaveBeenCalled()
  })

  it('params 스키마 위반과 모르는 어댑터', async () => {
    const { connect } = setup(async () => null)
    const a = fakePort()
    connect(a.port)
    a.emit(invoke({ q: 'x'.repeat(11) }))
    const b = fakePort()
    connect(b.port)
    b.emit(invoke({ q: 'a' }, { adapter: 'nope' }))
    await flush()
    expect(a.sent[0]).toMatchObject({ type: 'result', ok: false, error: { code: 'invalid_request' } })
    expect(b.sent[0]).toMatchObject({ type: 'result', ok: false, error: { code: 'unsupported_op' } })
  })

  it('cancel 메시지면 signal 이 중단되고 cancelled', async () => {
    let seen: AbortSignal | undefined
    const { connect } = setup((_req, ctx) => { seen = ctx.signal; return new Promise(() => {}) })
    const p = fakePort()
    connect(p.port)
    p.emit(invoke({ q: 'a' }))
    await flush()
    p.emit({ type: 'cancel' })
    await flush()
    expect(seen?.aborted).toBe(true)
    expect(p.sent).toEqual([{ type: 'result', ok: false, error: expect.objectContaining({ code: 'cancelled' }) }])
  })

  it('포트가 끊기면 중단하고 더 보내지 않는다', async () => {
    let seen: AbortSignal | undefined
    const { connect } = setup((_req, ctx) => { seen = ctx.signal; return new Promise(() => {}) })
    const p = fakePort()
    connect(p.port)
    p.emit(invoke({ q: 'a' }))
    await flush()
    p.close()
    await flush()
    expect(seen?.aborted).toBe(true)
    expect(p.sent).toEqual([])
  })

  it('timeout 과 PluginError 전달', async () => {
    vi.useFakeTimers()
    try {
      const { connect } = setup(() => new Promise(() => {}))
      const p = fakePort()
      connect(p.port)
      p.emit(invoke({ q: 'a' }, { timeoutMs: 50 }))
      await vi.advanceTimersByTimeAsync(60)
      expect(p.sent[0]).toMatchObject({ ok: false, error: { code: 'timeout' } })
    } finally {
      vi.useRealTimers()
    }

    const { connect } = setup(async () => { throw new PluginError({ code: 'blocked', message: '차단', retryable: false }) })
    const p = fakePort()
    connect(p.port)
    p.emit(invoke({ q: 'a' }))
    await flush()
    expect(p.sent[0]).toMatchObject({ ok: false, error: { code: 'blocked' } })
  })
})
