// PluginHost·세션 테스트용 가짜 chrome. 실제 chrome 을 쓰지 않고 저장소·외부 메시지·포트를 흉내 낸다.
import type { PortLike } from '@/sdk/companion'
import type { AdapterDef, PluginCatalog, RegisterResponse } from '@/sdk/plugin'
import { PluginHost, type PluginHostDeps } from '../plugins'
import { ADAPTER_OPS } from '../registry'

export const HUB_ID = 'hubhubhubhubhubhubhubhubhubhubhu'
export const POSTAL = 'postalpostalpostalpostalpostalpo'

/** 허브가 connect 로 얻는 포트. 플러그인 역할은 emit/drop 과 onHubMessage 로 연기한다 */
export class FakePort implements PortLike {
  name = ''
  sent: any[] = []
  disconnected = false
  /** 허브가 postMessage 할 때 플러그인 쪽에서 반응하는 훅 */
  onHubMessage: (msg: any, port: FakePort) => void = () => {}
  private msgFns: ((m: unknown) => void)[] = []
  private dropFns: (() => void)[] = []
  onMessage = { addListener: (fn: (m: unknown) => void) => void this.msgFns.push(fn) }
  onDisconnect = { addListener: (fn: () => void) => void this.dropFns.push(fn) }
  postMessage(m: unknown) {
    if (this.disconnected) throw new Error('끊긴 포트')
    this.sent.push(m)
    this.onHubMessage(m, this)
  }
  disconnect() {
    this.disconnected = true
  }
  /** 플러그인 → 허브 메시지 */
  emit(m: unknown) {
    for (const fn of this.msgFns) fn(m)
  }
  /** 플러그인 쪽이 포트를 끊음(또는 연결 실패) */
  drop() {
    this.disconnected = true
    for (const fn of this.dropFns) fn()
  }
}

export function makeHost(opts: { stored?: unknown; reservedOps?: string[]; failGet?: boolean } = {}) {
  const store: Record<string, unknown> = opts.stored !== undefined ? { plugins: opts.stored } : {}
  const ports: FakePort[] = []
  let external: ((msg: unknown, sender: { id?: string }, send: (r: unknown) => void) => boolean | void) | undefined
  const state = {
    /** 새 포트가 열릴 때 플러그인 역할을 정하는 훅 */
    onConnect: (_port: FakePort, _extId: string) => {},
    connectThrows: false,
  }
  const deps: PluginHostDeps = {
    storage: {
      get: async (k) => {
        if (opts.failGet) throw new Error('storage 실패')
        return k in store ? { [k]: JSON.parse(JSON.stringify(store[k])) } : {}
      },
      set: async (items) => void Object.assign(store, JSON.parse(JSON.stringify(items))),
    },
    runtime: {
      id: HUB_ID,
      connect(extId, info) {
        if (state.connectThrows) throw new Error('연결 실패')
        const p = new FakePort()
        p.name = info.name
        ports.push(p)
        state.onConnect(p, extId)
        return p
      },
      onMessageExternal: { addListener: (fn) => void (external = fn) },
    },
    reservedOps: opts.reservedOps ?? ['meta.describe', 'calc.eval', 'web.query'],
    adapterOps: ADAPTER_OPS,
  }
  const host = new PluginHost(deps)
  host.listen()
  /** 플러그인 확장이 허브에 register 를 보낸 것처럼 */
  const register = (extId: string, msg: Record<string, unknown>, senderId: string | null = extId) =>
    new Promise<RegisterResponse>((resolve) => {
      const keep = external!({ kind: 'abp-plugin/register', sdk: 1, name: 'postal', version: '1.0.0', ...msg }, { id: senderId ?? undefined }, resolve as (r: unknown) => void)
      if (keep !== true) resolve({ status: 'rejected', reason: 'no listener' })
    })
  return { host, store, ports, state, register }
}

export const adapter = (id: string, over: Partial<AdapterDef> = {}): AdapterDef => ({
  id, summary: `${id} 요약`, description: `${id} 설명`,
  params: { type: 'object', properties: { searchText: { type: 'string', maxLength: 100 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } } },
  hosts: ['example.com'], ...over,
})

export const catalog = (ids: string[] = ['epost-zip', 'zip-auto'], over: Partial<AdapterDef> = {}): PluginCatalog =>
  ({ ops: [], adapters: { 'web.query': ids.map((i) => adapter(i, over)) } })

export const flush = () => new Promise((r) => setTimeout(r, 0))
