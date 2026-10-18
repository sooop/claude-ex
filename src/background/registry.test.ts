import { describe, expect, it } from 'vitest'
import { calcEval } from './ops/calc'
import { OpError, createLiveRegistry, createRegistry, type OpContext, type PluginSource } from './registry'
import { adapter, catalog } from './testing/fake-hub'
import type { PluginCatalog } from '@/sdk/plugin'

/** 활성 플러그인 목록을 테스트가 직접 바꾸는 가짜 소스 */
function source(initial: Record<string, PluginCatalog> = {}) {
  const active: Record<string, PluginCatalog> = { ...initial }
  const calls: any[] = []
  const src: PluginSource = {
    active: () => Object.entries(active).map(([extId, c]) => ({ extId, name: extId, catalog: c })),
    invoke: async (extId, msg, _signal, onProgress) => {
      calls.push({ extId, msg })
      onProgress?.('조회', '1/1')
      return { echo: msg.args }
    },
  }
  return { src, active, calls }
}

/** reject 된 오류를 값으로 받는다 */
const fail = (p: Promise<unknown>): Promise<any> => p.catch((e) => e)

const ctx = (args: Record<string, unknown>): OpContext => ({
  args, signal: new AbortController().signal, progress: () => {}, sender: { ns: 'n', origin: 'https://x' }, timeoutMs: 4000,
})

describe('동적 레지스트리', () => {
  it('어댑터를 추가·삭제하면 catalogRev 가 바뀌고 web.query 가 provides 에 나타났다 사라진다', () => {
    const { src, active } = source()
    const live = createLiveRegistry([calcEval], src)
    const rev0 = live.registry.catalogRev
    expect(live.registry.provides().map((p) => p.op)).toEqual(['meta.describe', 'calc.eval'])
    expect(live.registry.get('web.query', 1)).toBeUndefined()

    const seen: string[] = []
    live.onChange((r) => seen.push(r.catalogRev))
    active.pm = catalog(['epost-zip', 'zip-auto'])
    expect(live.rebuild()).toBe(true)
    const wq = live.registry.provides().find((p) => p.op === 'web.query')!
    expect(wq).toMatchObject({ kind: 'read', consent: false, adapters: [{ id: 'epost-zip', summary: 'epost-zip 요약' }, { id: 'zip-auto', summary: 'zip-auto 요약' }] })
    expect(live.registry.catalogRev).not.toBe(rev0)
    expect(live.rebuild()).toBe(false) // 그대로면 알리지 않는다

    active.pm = catalog(['epost-zip'])
    expect(live.rebuild()).toBe(true)
    expect(live.registry.provides().find((p) => p.op === 'web.query')!.adapters).toHaveLength(1)

    delete active.pm
    expect(live.rebuild()).toBe(true)
    expect(live.registry.get('web.query', 1)).toBeUndefined()
    expect(live.registry.catalogRev).toBe(rev0)
    expect(seen).toHaveLength(3)
  })

  it('어댑터 설명만 바뀌어도 catalogRev 가 바뀐다', () => {
    const { src, active } = source({ pm: catalog() })
    const live = createLiveRegistry([calcEval], src)
    const rev = live.registry.catalogRev
    active.pm = catalog(['epost-zip', 'zip-auto'], { description: '바뀐 설명' })
    expect(live.rebuild()).toBe(true)
    expect(live.registry.catalogRev).not.toBe(rev)
  })

  it('meta.describe(op) 는 adapters 전체를, (op, adapter) 는 한 건을, 없는 어댑터는 unsupported_op', async () => {
    const { src } = source({ pm: catalog(['epost-zip', 'zip-auto']) })
    const r = createRegistry([calcEval], src)
    const d = r.get('meta.describe', 1)!
    const all: any = await d.handler(ctx({ op: 'web.query' }))
    expect(all.adapters.map((a: any) => a.id)).toEqual(['epost-zip', 'zip-auto'])
    expect(all.args.required).toEqual(['adapter', 'params'])
    const one: any = await d.handler(ctx({ op: 'web.query', adapter: 'zip-auto' }))
    expect(one.adapters).toHaveLength(1)
    expect(one.adapters[0]).toMatchObject({ id: 'zip-auto', description: 'zip-auto 설명', hosts: ['example.com'], resultNotes: '', notes: '' })
    expect(one.adapters[0].params.type).toBe('object')
    const err = await fail(d.handler(ctx({ op: 'web.query', adapter: 'nope' })))
    expect(err).toBeInstanceOf(OpError)
    expect(err.error).toMatchObject({ code: 'unsupported_op', detail: { known: ['epost-zip', 'zip-auto'] } })
    // 어댑터가 없는 op 에 adapter 를 지정하면 known 이 빈 목록
    const err2 = await fail(d.handler(ctx({ op: 'calc.eval', adapter: 'x' })))
    expect(err2.error).toMatchObject({ code: 'unsupported_op', detail: { known: [] } })
    // op 없이 adapter 만 지정은 invalid_request
    const err3 = await fail(d.handler(ctx({ adapter: 'x' })))
    expect(err3.error.code).toBe('invalid_request')
  })

  it('web.query 핸들러: 어댑터별 플러그인으로 보내고 params default 를 채운다', async () => {
    const { src, calls } = source({ a: catalog(['epost-zip']), b: catalog(['zip-auto'].map((x) => x)) })
    const r = createRegistry([calcEval], src)
    const wq = r.get('web.query', 1)!
    expect(wq.untrusted).toBe(true)
    await expect(wq.handler(ctx({ adapter: 'zip-auto', params: { searchText: 'x' } }))).resolves.toEqual({ echo: { searchText: 'x', limit: 10 } })
    expect(calls[0]).toMatchObject({ extId: 'b', msg: { op: 'web.query', ver: 1, adapter: 'zip-auto', timeoutMs: 4000, sender: { ns: 'n', origin: 'https://x' } } })
    await wq.handler(ctx({ adapter: 'epost-zip', params: {} }))
    expect(calls[1].extId).toBe('a')
  })

  it('web.query 핸들러: params 위반은 invalid_request 로 플러그인에 가지 않고, 없는 어댑터는 known 을 준다', async () => {
    const { src, calls } = source({ a: catalog(['epost-zip']) })
    const wq = createRegistry([calcEval], src).get('web.query', 1)!
    const e1 = await fail(wq.handler(ctx({ adapter: 'epost-zip', params: { limit: 999 } })))
    expect(e1.error.code).toBe('invalid_request')
    const e2 = await fail(wq.handler(ctx({ adapter: 'epost-zip', params: { evil: 1 } })))
    expect(e2.error.code).toBe('invalid_request')
    const e3 = await fail(wq.handler(ctx({ adapter: 'nope', params: {} })))
    expect(e3.error).toMatchObject({ code: 'unsupported_op', detail: { known: ['epost-zip'] } })
    expect(calls).toHaveLength(0)
  })

  it('플러그인이 invoke 에서 V2Error 로 reject 하면 OpError 로 바뀐다', async () => {
    const { src } = source({ a: catalog(['epost-zip']) })
    src.invoke = async () => { throw { code: 'internal', message: 'm', retryable: true, detail: 'plugin_unreachable' } }
    const wq = createRegistry([calcEval], src).get('web.query', 1)!
    const e = await fail(wq.handler(ctx({ adapter: 'epost-zip', params: {} })))
    expect(e).toBeInstanceOf(OpError)
    expect(e.error.detail).toBe('plugin_unreachable')
  })

  it('플러그인 자체 op 도 OpDef 로 등록되고 adapter 없이 호출된다', async () => {
    const op = {
      name: 'foo.bar', ver: 1, kind: 'read' as const, summary: 's', description: 'd', args: { type: 'object' as const },
      result: { type: 'object' as const }, errors: [], limits: { timeoutMs: 2000 }, extraCodes: ['foo_error'],
    }
    const { src, calls } = source({ a: { ops: [op], adapters: {} } })
    const r = createRegistry([calcEval], src)
    expect(r.provides().map((p) => p.op)).toEqual(['meta.describe', 'calc.eval', 'foo.bar'])
    expect(r.get('web.query', 1)).toBeUndefined() // 어댑터가 없으면 web.query 도 없다
    const d = r.get('foo.bar', 1)!
    expect(d).toMatchObject({ consent: false, extraCodes: ['foo_error'], limits: { maxConcurrent: 1, timeoutMs: 2000 } })
    await d.handler(ctx({ x: 1 }))
    expect(calls[0].msg).toMatchObject({ op: 'foo.bar', ver: 1, args: { x: 1 } })
    expect(calls[0].msg.adapter).toBeUndefined()
  })

  it('플러그인 소스가 없으면 기존처럼 동작한다', () => {
    const r = createRegistry([calcEval])
    expect(r.known()).toEqual(['meta.describe', 'calc.eval'])
    expect(adapter('x').id).toBe('x')
  })
})
