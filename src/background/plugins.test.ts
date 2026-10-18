import { describe, expect, it, vi } from 'vitest'
import { PLUGINS_KEY, diffCatalog } from './plugins'
import { HUB_ID, POSTAL, adapter, catalog, flush, makeHost } from './testing/fake-hub'
import type { InvokeMessage } from '@/sdk/plugin'

const msg = (over: Partial<InvokeMessage> = {}): InvokeMessage => ({
  type: 'invoke', op: 'web.query', ver: 1, adapter: 'zip-auto', args: { searchText: '강남' }, timeoutMs: 5000,
  sender: { ns: 'n', origin: 'https://x' }, ...over,
})

async function activated() {
  const ctx = makeHost()
  await ctx.host.ready
  await ctx.register(POSTAL, { catalog: catalog() })
  await ctx.host.approve(POSTAL)
  return ctx
}

describe('등록과 승인', () => {
  it('새 플러그인은 대기, 승인하면 활성이 되고 변경이 알려진다', async () => {
    const { host, register, store } = makeHost()
    const changed = vi.fn()
    host.onChange(changed)
    expect(await register(POSTAL, { catalog: catalog() })).toEqual({ status: 'pending' })
    expect(host.pendingCount()).toBe(1)
    expect(host.active()).toEqual([])
    expect(changed).toHaveBeenCalledTimes(1)

    expect(await host.approve(POSTAL)).toBe(true)
    expect(host.active().map((p) => p.extId)).toEqual([POSTAL])
    expect(host.pendingCount()).toBe(0)
    expect((store[PLUGINS_KEY] as any)[POSTAL]).toMatchObject({ status: 'active', approvedHash: expect.any(String) })
    // 같은 카탈로그로 다시 등록하면 묻지 않고 활성, 상태 변화 없음
    changed.mockClear()
    expect(await register(POSTAL, { catalog: catalog(), version: '1.0.1' })).toEqual({ status: 'active' })
    expect(host.active()).toHaveLength(1)
  })

  it('카탈로그 해시가 바뀌면 비활성이 되고 다시 대기, 이전 승인과의 차이를 낸다', async () => {
    const { host, register } = await activated()
    expect(await register(POSTAL, { catalog: catalog(['epost-zip', 'juso-addr']) })).toEqual({ status: 'pending' })
    expect(host.active()).toEqual([])
    const info = host.list().find((p) => p.extId === POSTAL)!
    expect(info.status).toBe('pending')
    expect(info.diff).toMatchObject({ addedAdapters: ['web.query/juso-addr'], removedAdapters: ['web.query/zip-auto'], modified: [] })
    // 이전 승인(원래 카탈로그)로 돌아가면 곧바로 활성
    expect(await register(POSTAL, { catalog: catalog() })).toEqual({ status: 'active' })
  })

  it('설명만 바뀌면 modified 로 보인다', () => {
    const d = diffCatalog(catalog(), catalog(['epost-zip', 'zip-auto'], { description: '바뀜' }))
    expect(d).toMatchObject({ addedAdapters: [], removedAdapters: [], modified: ['web.query/epost-zip', 'web.query/zip-auto'] })
  })

  it('거부하면 같은 해시로 다시 등록해도 rejected, 다른 해시는 다시 묻는다', async () => {
    const { host, register } = makeHost()
    await register(POSTAL, { catalog: catalog() })
    expect(await host.deny(POSTAL)).toBe(true)
    expect(await register(POSTAL, { catalog: catalog() })).toEqual({ status: 'rejected', reason: '사용자가 거부함' })
    expect(host.pendingCount()).toBe(0)
    expect(await register(POSTAL, { catalog: catalog(['epost-zip']) })).toEqual({ status: 'pending' })
  })

  it('remove 하면 기록이 사라져 처음부터 다시 승인받는다', async () => {
    const { host, register } = await activated()
    expect(await host.remove(POSTAL)).toBe(true)
    expect(host.list()).toEqual([])
    expect(await register(POSTAL, { catalog: catalog() })).toEqual({ status: 'pending' })
  })

  it('대기 중이 아니면 approve/deny 는 false', async () => {
    const { host } = await activated()
    expect(await host.approve(POSTAL)).toBe(false)
    expect(await host.deny(POSTAL)).toBe(false)
    expect(await host.approve('nope')).toBe(false)
  })

  it('저장된 상태를 서비스 워커 재시작 뒤에도 쓴다(등록은 ready 를 기다린다)', async () => {
    const first = await activated()
    const second = makeHost({ stored: first.store[PLUGINS_KEY] })
    expect(await second.register(POSTAL, { catalog: catalog() })).toEqual({ status: 'active' })
    expect(second.host.active()).toHaveLength(1)
  })
})

describe('등록 거부', () => {
  it('sdk 버전이 다르면 rejected', async () => {
    const { register } = makeHost()
    expect(await register(POSTAL, { sdk: 2, catalog: catalog() })).toMatchObject({ status: 'rejected' })
  })
  it('카탈로그가 32KiB 를 넘거나 형식이 틀리면 rejected', async () => {
    const { register, host } = makeHost()
    const big = catalog(['a'], { description: 'x'.repeat(2000) })
    big.adapters['web.query'] = Array.from({ length: 20 }, (_, i) => adapter(`a${i}`, { description: 'x'.repeat(2000) }))
    expect(await register(POSTAL, { catalog: big })).toMatchObject({ status: 'rejected', reason: expect.stringContaining('32KiB') })
    expect(await register(POSTAL, { catalog: { ops: 1 } })).toMatchObject({ status: 'rejected' })
    expect(host.list()).toEqual([])
  })
  it('어댑터를 받지 않는 op 에 어댑터를 보태면 rejected', async () => {
    const { register } = makeHost()
    expect(await register(POSTAL, { catalog: { ops: [], adapters: { 'calc.eval': [adapter('x')] } } })).toMatchObject({ status: 'rejected' })
  })
  it('허브 내장 op 이름과 겹치면 rejected', async () => {
    const { register } = makeHost()
    const op = { name: 'calc.eval', ver: 1, kind: 'read', summary: 's', description: 'd', args: { type: 'object' }, result: { type: 'object' }, errors: [], limits: { timeoutMs: 1000 } }
    expect(await register(POSTAL, { catalog: { ops: [op], adapters: {} } })).toMatchObject({ status: 'rejected', reason: expect.stringContaining('calc.eval') })
  })
  it('다른 플러그인의 op·어댑터 id 와 겹치면 rejected, 같은 플러그인은 갱신 가능', async () => {
    const { register } = await activated()
    const other = 'otherotherotherotherotherotherot'
    expect(await register(other, { catalog: catalog(['zip-auto']) })).toMatchObject({ status: 'rejected', reason: expect.stringContaining('zip-auto') })
    expect(await register(other, { catalog: catalog(['other-one']) })).toEqual({ status: 'pending' })
    const op = { name: 'foo.bar', ver: 1, kind: 'read', summary: 's', description: 'd', args: { type: 'object' }, result: { type: 'object' }, errors: [], limits: { timeoutMs: 1000 } }
    expect(await register(POSTAL, { catalog: { ops: [op], adapters: {} } })).toEqual({ status: 'pending' })
    expect(await register(other, { catalog: { ops: [op], adapters: {} } })).toMatchObject({ status: 'rejected' })
  })
  it('확장이 아닌 발신자(id 없음)와 허브 자신은 rejected', async () => {
    const { register, host } = makeHost()
    expect(await register(POSTAL, { catalog: catalog() }, null)).toMatchObject({ status: 'rejected' })
    expect(await register(HUB_ID, { catalog: catalog() })).toMatchObject({ status: 'rejected' })
    expect(host.list()).toEqual([])
  })
  it('register 가 아닌 메시지는 응답하지 않는다', async () => {
    const { register } = makeHost()
    expect(await register(POSTAL, { kind: 'other' })).toEqual({ status: 'rejected', reason: 'no listener' })
  })
})

describe('invoke', () => {
  it('invoke 메시지를 보내고 progress 를 전달하며 result 로 resolve, 포트를 닫는다', async () => {
    const { host, ports, state } = await activated()
    state.onConnect = (p) => {
      p.onHubMessage = () => {
        p.emit({ type: 'progress', stage: '조회', detail: '1/2', pct: 50 })
        p.emit({ type: 'result', ok: true, data: { rows: [] } })
      }
    }
    const onProgress = vi.fn()
    await expect(host.invoke(POSTAL, msg(), new AbortController().signal, onProgress)).resolves.toEqual({ rows: [] })
    expect(ports[0].name).toBe('abp-plugin/call')
    expect(ports[0].sent[0]).toMatchObject({ type: 'invoke', adapter: 'zip-auto' })
    expect(onProgress).toHaveBeenCalledWith('조회', '1/2', 50)
    expect(ports[0].disconnected).toBe(true)
  })

  it('result 의 error 는 normalizeError 로 정제된다(모르는 코드는 internal)', async () => {
    const { host, state } = await activated()
    state.onConnect = (p) => {
      p.onHubMessage = () => p.emit({ type: 'result', ok: false, error: { code: 'zzz', message: 'm', retryable: true } })
    }
    await expect(host.invoke(POSTAL, msg(), new AbortController().signal)).rejects.toMatchObject({ code: 'internal', retryable: true })
    state.onConnect = (p) => {
      p.onHubMessage = () => p.emit({ type: 'result', ok: false, error: { code: 'blocked', message: 'b' } })
    }
    await expect(host.invoke(POSTAL, msg(), new AbortController().signal)).rejects.toMatchObject({ code: 'blocked' })
  })

  it('abort 하면 cancel 을 보내고 포트를 끊고 cancelled', async () => {
    const { host, ports } = await activated()
    const ac = new AbortController()
    const p = host.invoke(POSTAL, msg(), ac.signal)
    ac.abort('cancelled')
    await expect(p).rejects.toMatchObject({ code: 'cancelled' })
    expect(ports[0].sent.map((m) => m.type)).toEqual(['invoke', 'cancel'])
    expect(ports[0].disconnected).toBe(true)
  })

  it('abort 사유가 timeout 이면 timeout', async () => {
    const { host } = await activated()
    const ac = new AbortController()
    const p = host.invoke(POSTAL, msg(), ac.signal)
    ac.abort('timeout')
    await expect(p).rejects.toMatchObject({ code: 'timeout' })
  })

  it('이미 abort 된 signal 이면 연결하지 않는다', async () => {
    const { host, ports } = await activated()
    await expect(host.invoke(POSTAL, msg(), AbortSignal.abort('cancelled'))).rejects.toMatchObject({ code: 'cancelled' })
    expect(ports).toHaveLength(0)
  })

  it('메시지를 하나도 못 받고 끊기면 plugin_unreachable(retryable)', async () => {
    const { host, state } = await activated()
    state.onConnect = (p) => void queueMicrotask(() => p.drop())
    await expect(host.invoke(POSTAL, msg(), new AbortController().signal)).rejects.toMatchObject({
      code: 'internal', retryable: true, detail: 'plugin_unreachable',
    })
  })

  it('connect 가 던져도 plugin_unreachable', async () => {
    const { host, state } = await activated()
    state.connectThrows = true
    await expect(host.invoke(POSTAL, msg(), new AbortController().signal)).rejects.toMatchObject({ detail: 'plugin_unreachable' })
  })

  it('progress 를 받은 뒤 끊기면 plugin_disconnected(retryable)', async () => {
    const { host, state } = await activated()
    state.onConnect = (p) => {
      p.onHubMessage = () => {
        p.emit({ type: 'progress', stage: 's' })
        p.drop()
      }
    }
    await expect(host.invoke(POSTAL, msg(), new AbortController().signal)).rejects.toMatchObject({
      code: 'internal', retryable: true, detail: 'plugin_disconnected',
    })
  })

  it('활성이 아닌(대기·미등록) 플러그인에는 연결하지 않는다', async () => {
    const { host, register, ports } = makeHost()
    await register(POSTAL, { catalog: catalog() })
    await expect(host.invoke(POSTAL, msg(), new AbortController().signal)).rejects.toMatchObject({ code: 'unsupported_op' })
    await expect(host.invoke('nope', msg(), new AbortController().signal)).rejects.toMatchObject({ code: 'unsupported_op' })
    expect(ports).toHaveLength(0)
    await flush()
  })
})
