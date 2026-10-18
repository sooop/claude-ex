// 세션 → 레지스트리 → PluginHost → (가짜)플러그인 포트까지 한 줄로 잇는 통합 테스트
import { afterEach, describe, expect, it, vi } from 'vitest'
import { calcEval } from './ops/calc'
import { createLiveRegistry } from './registry'
import { AppSession, type SessionDeps } from './session'
import { POSTAL, catalog, flush, makeHost, type FakePort } from './testing/fake-hub'

type Msg = Record<string, any>
const app = (o: Msg) => ({ source: 'ab-app', v: 2, ns: 'claude-ex-poc', ...o })
const OTHER = 'otherotherotherotherotherotherot'

async function setup() {
  const h = makeHost()
  await h.host.ready
  const live = createLiveRegistry([calcEval], h.host)
  const sent: Msg[] = []
  const deps: SessionDeps = {
    get registry() {
      return live.registry
    },
    log: { appendSafe: async () => {} },
    extVersion: '0.1.0',
    now: () => Date.now(),
    uuid: (() => { let n = 0; return () => `u${++n}` })(),
    defaultNs: 'claude-ex-poc',
  }
  const s = new AppSession((m) => sent.push(m), deps, 'https://x.frame.claudeusercontent.com', 7)
  // index.ts 와 같은 배선
  h.host.onChange(() => live.rebuild())
  live.onChange(() => s.notifyCatalog())
  // index.ts 처럼 연결 직후 확장이 먼저 hello 한다
  s.hello()
  const call = (id: string, args: Msg, opts?: Msg) => s.handle(app({ type: 'call', id, op: 'web.query', ver: 1, args, ...(opts ? { opts } : {}) }))
  const result = (id: string) => sent.find((m) => m.type === 'result' && m.id === id)
  const activate = async (extId: string, ids: string[]) => {
    await h.register(extId, { catalog: catalog(ids) })
    await h.host.approve(extId)
  }
  return { ...h, live, s, sent, call, result, activate }
}

afterEach(() => vi.useRealTimers())

describe('web.query 중계', () => {
  it('어댑터별 담당 플러그인으로 가고, 결과 meta 에 untrusted, progress 도 전달된다', async () => {
    const t = await setup()
    await t.activate(POSTAL, ['epost-zip'])
    await t.activate(OTHER, ['other-one'])
    const seen: [string, any][] = []
    t.state.onConnect = (p, extId) => {
      p.onHubMessage = (m) => {
        seen.push([extId, m])
        p.emit({ type: 'progress', stage: '조회 중' })
        p.emit({ type: 'result', ok: true, data: { rows: [{ zip: '06236' }] } })
      }
    }
    t.call('c1', { adapter: 'other-one', params: { searchText: '강남' } })
    await flush()
    expect(seen).toHaveLength(1)
    expect(seen[0][0]).toBe(OTHER)
    expect(seen[0][1]).toMatchObject({ type: 'invoke', op: 'web.query', adapter: 'other-one', args: { searchText: '강남', limit: 10 }, sender: { ns: 'claude-ex-poc' } })
    expect(t.sent.find((m) => m.type === 'progress')).toMatchObject({ id: 'c1', stage: '조회 중' })
    expect(t.result('c1')).toMatchObject({ ok: true, data: { rows: [{ zip: '06236' }] }, meta: { untrusted: true } })

    t.call('c2', { adapter: 'epost-zip', params: {} })
    await flush()
    expect(seen[1][0]).toBe(POSTAL)
  })

  it('calc.eval 결과에는 untrusted 가 붙지 않는다', async () => {
    const t = await setup()
    t.s.handle(app({ type: 'call', id: 'c', op: 'calc.eval', ver: 1, args: { expr: '1+1' } }))
    await flush()
    expect(t.result('c')!.meta.untrusted).toBeUndefined()
  })

  it('params 위반은 invalid_request 이고 플러그인에 연결하지 않는다', async () => {
    const t = await setup()
    await t.activate(POSTAL, ['epost-zip'])
    t.call('c1', { adapter: 'epost-zip', params: { limit: 0 } })
    t.call('c2', { adapter: 'epost-zip' }) // params 없음: op 스키마 위반
    await flush()
    expect(t.result('c1')!.error.code).toBe('invalid_request')
    expect(t.result('c2')!.error.code).toBe('invalid_request')
    expect(t.ports).toHaveLength(0)
  })

  it('없는 어댑터는 unsupported_op + 어댑터 id 목록', async () => {
    const t = await setup()
    await t.activate(POSTAL, ['epost-zip'])
    t.call('c1', { adapter: 'nope', params: {} })
    await flush()
    expect(t.result('c1')!.error).toMatchObject({ code: 'unsupported_op', detail: { known: ['epost-zip'] } })
  })

  it('앱이 cancel 하면 플러그인에 cancel 을 보내고 포트를 끊는다', async () => {
    const t = await setup()
    await t.activate(POSTAL, ['epost-zip'])
    t.call('c1', { adapter: 'epost-zip', params: {} })
    await flush()
    const port = t.ports[0]
    t.s.handle(app({ type: 'cancel', id: 'c1' }))
    await flush()
    expect(t.result('c1')!.error.code).toBe('cancelled')
    expect(port.sent.map((m) => m.type)).toEqual(['invoke', 'cancel'])
    expect(port.disconnected).toBe(true)
  })

  it('제한 시간이 지나면 timeout 이고 플러그인에 cancel 을 보낸다', async () => {
    vi.useFakeTimers()
    const t = await setup()
    await t.activate(POSTAL, ['epost-zip'])
    t.call('c1', { adapter: 'epost-zip', params: {} }, { timeoutMs: 1500 })
    await vi.advanceTimersByTimeAsync(1)
    const port: FakePort = t.ports[0]
    expect(port.sent[0].timeoutMs).toBe(1500)
    await vi.advanceTimersByTimeAsync(1500)
    expect(t.result('c1')!.error.code).toBe('timeout')
    expect(port.sent.map((m) => m.type)).toEqual(['invoke', 'cancel'])
  })

  it('플러그인에 연결할 수 없으면 internal + plugin_unreachable', async () => {
    const t = await setup()
    await t.activate(POSTAL, ['epost-zip'])
    t.state.onConnect = (p) => void queueMicrotask(() => p.drop())
    t.call('c1', { adapter: 'epost-zip', params: {} })
    await flush()
    expect(t.result('c1')!.error).toMatchObject({ code: 'internal', retryable: true, detail: 'plugin_unreachable' })
  })
})

describe('카탈로그 변경 알림', () => {
  it('승인하면 catalog_changed 이벤트가 새 catalogRev 와 함께 나가고 provides 에 web.query 가 생긴다', async () => {
    const t = await setup()
    t.s.hello()
    const rev0 = t.sent[0].catalogRev
    expect(t.sent[0].provides.some((p: Msg) => p.op === 'web.query')).toBe(false)

    await t.register(POSTAL, { catalog: catalog() })
    expect(t.sent.filter((m) => m.type === 'event')).toHaveLength(0) // 대기 중에는 카탈로그가 그대로
    await t.host.approve(POSTAL)
    const ev = t.sent.filter((m) => m.type === 'event')
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ source: 'ab-ext', name: 'catalog_changed', data: { catalogRev: t.live.registry.catalogRev } })
    expect(ev[0].data.catalogRev).not.toBe(rev0)

    // 새 hello 의 provides 에도 반영
    t.s.handle(app({ type: 'hello', id: 'h', supportedVersions: [2] }))
    const ack = t.sent.find((m) => m.type === 'hello_ack')!
    expect(ack.provides.find((p: Msg) => p.op === 'web.query').adapters.map((a: Msg) => a.id)).toEqual(['epost-zip', 'zip-auto'])

    // 해제하면 다시 event, web.query 사라짐
    await t.host.remove(POSTAL)
    expect(t.sent.filter((m) => m.type === 'event')).toHaveLength(2)
    expect(t.live.registry.get('web.query', 1)).toBeUndefined()
  })

  it('hello 를 주고받기 전에는 catalog_changed 를 보내지 않는다', async () => {
    const h = makeHost()
    await h.host.ready
    const live = createLiveRegistry([calcEval], h.host)
    const sent: Msg[] = []
    const s = new AppSession((m) => sent.push(m), {
      get registry() { return live.registry },
      log: { appendSafe: async () => {} }, extVersion: '0.1.0', now: () => Date.now(), uuid: () => 'u', defaultNs: 'claude-ex-poc',
    }, 'https://x.frame.claudeusercontent.com', 7)
    h.host.onChange(() => live.rebuild())
    live.onChange(() => s.notifyCatalog())
    await h.register(POSTAL, { catalog: catalog(['epost-zip']) })
    await h.host.approve(POSTAL)
    expect(sent.filter((m) => m.type === 'event')).toHaveLength(0)
    s.hello()
    expect(sent.at(-1)).toMatchObject({ type: 'hello', catalogRev: live.registry.catalogRev })
  })

  it('카탈로그가 바뀌어 대기로 돌아가면 plugin 이 꺼지고 event 가 나간다', async () => {
    const t = await setup()
    await t.activate(POSTAL, ['epost-zip', 'zip-auto'])
    const before = t.sent.filter((m) => m.type === 'event').length
    await t.register(POSTAL, { catalog: catalog(['epost-zip']) })
    expect(t.sent.filter((m) => m.type === 'event')).toHaveLength(before + 1)
    t.call('c1', { adapter: 'epost-zip', params: {} })
    await flush()
    expect(t.result('c1')!.error.code).toBe('unsupported_op')
  })
})
