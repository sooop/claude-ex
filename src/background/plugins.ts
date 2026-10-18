// 플러그인 호스트: 다른 확장이 보낸 등록(op·어댑터)의 승인 상태를 저장하고, 승인된 플러그인에 호출을 중계한다.
// 채널 계약은 src/sdk/plugin.ts, 상대편(플러그인 쪽)은 src/sdk/companion.ts. chrome API 는 주입받는다.
import type { PluginInfo } from '@/lib/messages'
import { cleanText } from '@/lib/protocol'
import type { PortLike } from '@/sdk/companion'
import { V2_ERRORS, normalizeError, type V2Error } from '@/sdk/errors'
import {
  CHANNEL, SDK_VERSION, canonicalJson, catalogHash, validateCatalog,
  type InvokeMessage, type PluginCatalog, type RegisterResponse,
} from '@/sdk/plugin'
import type { ActivePlugin, PluginSource } from './registry'

export const PLUGINS_KEY = 'plugins'

export type PluginStatus = 'active' | 'pending' | 'denied'

export interface PluginRecord {
  name: string
  version: string
  catalog: PluginCatalog
  hash: string
  status: PluginStatus
  /** 사용자가 마지막으로 허용한 카탈로그의 해시와 내용. 해시가 이것과 같으면 다시 묻지 않고 활성 */
  approvedHash?: string
  approvedCatalog?: PluginCatalog
}

type ExternalListener = (msg: unknown, sender: { id?: string }, sendResponse: (r: unknown) => void) => boolean | void

export interface PluginHostDeps {
  storage: {
    get(key: string): Promise<Record<string, unknown>>
    set(items: Record<string, unknown>): Promise<void>
  }
  runtime: {
    /** 허브 자신의 확장 id */
    id: string
    connect(extId: string, info: { name: string }): PortLike
    onMessageExternal: { addListener(fn: ExternalListener): void }
  }
  /** 플러그인이 쓸 수 없는 op 이름(허브 내장 op) */
  reservedOps: string[]
  /** 플러그인이 어댑터를 보탤 수 있는 op */
  adapterOps: readonly string[]
}

type Progress = (stage: string, detail?: string, pct?: number) => void

const unreachable = (): V2Error => ({ code: 'internal', message: '플러그인에 연결할 수 없습니다', retryable: true, detail: 'plugin_unreachable' })
const disconnected = (): V2Error => ({ code: 'internal', message: '플러그인과의 연결이 중간에 끊겼습니다', retryable: true, detail: 'plugin_disconnected' })
const abortError = (signal: AbortSignal): V2Error => (signal.reason === 'timeout' ? V2_ERRORS.timeout() : V2_ERRORS.cancelled())

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)

/** 카탈로그의 op·어댑터를 이름 → 내용 JSON 으로 펼친다(차이 계산용) */
function items(c: PluginCatalog): { ops: Map<string, string>; adapters: Map<string, string> } {
  const ops = new Map(c.ops.map((o) => [o.name, canonicalJson(o)] as const))
  const adapters = new Map<string, string>()
  for (const [op, list] of Object.entries(c.adapters)) for (const a of list) adapters.set(`${op}/${a.id}`, canonicalJson(a))
  return { ops, adapters }
}

/** 이전 승인과 새 카탈로그의 차이 */
export function diffCatalog(prev: PluginCatalog, next: PluginCatalog): NonNullable<PluginInfo['diff']> {
  const a = items(prev)
  const b = items(next)
  const added = (x: Map<string, string>, y: Map<string, string>) => [...y.keys()].filter((k) => !x.has(k))
  const modified = (x: Map<string, string>, y: Map<string, string>) => [...y.keys()].filter((k) => x.has(k) && x.get(k) !== y.get(k))
  return {
    addedOps: added(a.ops, b.ops),
    removedOps: added(b.ops, a.ops),
    addedAdapters: added(a.adapters, b.adapters),
    removedAdapters: added(b.adapters, a.adapters),
    modified: [...modified(a.ops, b.ops), ...modified(a.adapters, b.adapters)],
  }
}

export class PluginHost implements PluginSource {
  private state: Record<string, PluginRecord> = {}
  private listeners = new Set<() => void>()
  /** 저장된 상태를 읽지 못했으면 false. 이때는 저장소에 쓰지 않는다 */
  private persist = true
  /** 저장된 상태를 다 불러온 뒤 resolve. 등록 처리와 첫 레지스트리 생성은 이것을 기다린다 */
  readonly ready: Promise<void>

  constructor(private deps: PluginHostDeps) {
    const load = () => deps.storage.get(PLUGINS_KEY).then((r) => {
      const saved = r[PLUGINS_KEY]
      if (isObj(saved)) this.state = saved as Record<string, PluginRecord>
    })
    // 한 번 다시 시도하고, 그래도 못 읽으면 이번 서비스 워커 동안은 저장하지 않는다(빈 상태로 승인 기록을 덮어쓰지 않으려고)
    this.ready = load().catch(load).catch(() => { this.persist = false })
  }

  /** onMessageExternal 리스너를 단다. 서비스 워커 최상위에서 동기로 불러야 한다(재시작 때 이벤트를 놓치지 않으려고) */
  listen(): void {
    this.deps.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
      if (!isObj(msg) || msg.kind !== CHANNEL.register) return false
      void this.handleRegister(msg, sender.id).then(sendResponse)
      return true
    })
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private async changed() {
    for (const fn of [...this.listeners]) fn()
    if (this.persist) await this.deps.storage.set({ [PLUGINS_KEY]: this.state }).catch(() => {})
  }

  // ── 등록 ───────────────────────────────────────────────────────────────────

  private async handleRegister(msg: Record<string, unknown>, extId: string | undefined): Promise<RegisterResponse> {
    await this.ready
    // 확장이 보낸 메시지만 받는다(sender.id 는 브라우저가 채우며, 웹 페이지에는 없다). 허브 자신은 제외
    if (typeof extId !== 'string' || extId === '' || extId === this.deps.runtime.id) return { status: 'rejected', reason: '확장에서 온 요청이 아닙니다' }
    const r = this.register(extId, msg)
    if (r.changed) await this.changed()
    return r.res
  }

  /** 등록 메시지를 판정하고 상태를 바꾼다(메모리). 저장·알림은 호출부가 한다 */
  private register(extId: string, msg: Record<string, unknown>): { res: RegisterResponse; changed: boolean } {
    const reject = (reason: string) => ({ res: { status: 'rejected', reason } as RegisterResponse, changed: false })
    if (msg.sdk !== SDK_VERSION) return reject(`SDK 버전이 맞지 않습니다(허브 ${SDK_VERSION})`)
    if (typeof msg.name !== 'string' || typeof msg.version !== 'string') return reject('name/version 형식 오류')
    const name = cleanText(msg.name, 40)
    const version = cleanText(msg.version, 20)
    if (!name) return reject('name 이 비어 있습니다')
    const check = validateCatalog(msg.catalog)
    if (!check.ok) return reject(check.reason)
    const catalog = check.catalog
    const bad = this.conflict(extId, catalog)
    if (bad) return reject(bad)

    const hash = catalogHash(catalog)
    const prev = this.state[extId]
    const rec: PluginRecord = {
      name, version, catalog, hash, status: 'pending',
      ...(prev?.approvedHash !== undefined ? { approvedHash: prev.approvedHash } : {}),
      ...(prev?.approvedCatalog ? { approvedCatalog: prev.approvedCatalog } : {}),
    }
    // 해시는 빠른 비교용이고, 승인·거부 판정은 카탈로그 전체를 비교한다(해시 충돌로 다른 카탈로그가 통과하지 않게)
    const same = (c: PluginCatalog | undefined) => !!c && canonicalJson(c) === canonicalJson(catalog)
    if (rec.approvedHash === hash && same(rec.approvedCatalog)) {
      rec.status = 'active'
    } else if (prev?.status === 'denied' && prev.hash === hash && same(prev.catalog)) {
      return reject('사용자가 거부함') // 같은 내용으로는 다시 묻지 않는다
    }
    this.state[extId] = rec
    return { res: { status: rec.status === 'active' ? 'active' : 'pending' }, changed: !prev || canonicalJson(prev) !== canonicalJson(rec) }
  }

  /** 허브 내장 op·다른 플러그인(활성·대기)의 op 이름과 어댑터 id 가 겹치는지. 겹치면 사유 */
  private conflict(extId: string, catalog: PluginCatalog): string | undefined {
    const reserved = new Set(this.deps.reservedOps)
    const ops = new Set<string>()
    const adapters = new Set<string>()
    for (const [id, p] of Object.entries(this.state)) {
      if (id === extId || p.status === 'denied') continue
      for (const o of p.catalog.ops) ops.add(o.name)
      for (const [op, list] of Object.entries(p.catalog.adapters)) for (const a of list) adapters.add(`${op}/${a.id}`)
    }
    for (const o of catalog.ops) {
      if (reserved.has(o.name)) return `허브 내장 op 와 이름이 겹칩니다: ${o.name}`
      if (ops.has(o.name)) return `다른 플러그인의 op 와 이름이 겹칩니다: ${o.name}`
    }
    for (const [op, list] of Object.entries(catalog.adapters)) {
      if (!this.deps.adapterOps.includes(op)) return `어댑터를 받지 않는 op 입니다: ${op}`
      for (const a of list) if (adapters.has(`${op}/${a.id}`)) return `다른 플러그인의 어댑터와 id 가 겹칩니다: ${a.id}`
    }
    return undefined
  }

  // ── 승인 ───────────────────────────────────────────────────────────────────

  /** 승인 대기를 허용한다. 카탈로그 해시를 승인 기준으로 저장한다.
   *  expectedHash 는 사용자가 카드에서 본 카탈로그의 해시다. 그사이 재등록으로 카탈로그가 바뀌었으면 승인하지 않는다 */
  async approve(extId: string, expectedHash?: string): Promise<boolean> {
    await this.ready
    const rec = this.state[extId]
    if (rec?.status !== 'pending') return false
    if (expectedHash !== undefined && rec.hash !== expectedHash) return false
    this.state[extId] = { ...rec, status: 'active', approvedHash: rec.hash, approvedCatalog: rec.catalog }
    await this.changed()
    return true
  }

  /** 승인 대기를 거부한다. 같은 카탈로그로 다시 등록해도 묻지 않는다 */
  async deny(extId: string, expectedHash?: string): Promise<boolean> {
    await this.ready
    const rec = this.state[extId]
    if (rec?.status !== 'pending') return false
    if (expectedHash !== undefined && rec.hash !== expectedHash) return false
    this.state[extId] = { ...rec, status: 'denied' }
    await this.changed()
    return true
  }

  /** 플러그인을 목록에서 지운다. 승인 기록도 함께 사라져 다시 등록하면 처음부터 승인을 받는다 */
  async remove(extId: string): Promise<boolean> {
    await this.ready
    if (!this.state[extId]) return false
    delete this.state[extId]
    await this.changed()
    return true
  }

  list(): PluginInfo[] {
    return Object.entries(this.state).map(([extId, p]) => ({
      extId, name: p.name, version: p.version, status: p.status, hash: p.hash,
      ops: p.catalog.ops.map((o) => ({ name: o.name, ver: o.ver, summary: o.summary })),
      adapters: Object.entries(p.catalog.adapters).flatMap(([op, list]) => list.map((a) => ({ op, id: a.id, summary: a.summary }))),
      ...(p.approvedCatalog && p.status !== 'active' ? { diff: diffCatalog(p.approvedCatalog, p.catalog) } : {}),
    }))
  }

  pendingCount(): number {
    return Object.values(this.state).filter((p) => p.status === 'pending').length
  }

  active(): ActivePlugin[] {
    return Object.entries(this.state)
      .filter(([, p]) => p.status === 'active')
      .map(([extId, p]) => ({ extId, name: p.name, catalog: p.catalog }))
  }

  // ── 호출 ───────────────────────────────────────────────────────────────────

  /**
   * 활성 플러그인에 호출 1건을 보낸다(호출마다 포트 1개). 결과 data 로 resolve, 실패는 V2Error 로 reject.
   * signal 이 abort 되면 cancel 을 보내고 포트를 끊는다.
   */
  invoke(extId: string, msg: InvokeMessage, signal: AbortSignal, onProgress?: Progress): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const rec = this.state[extId]
      // 승인된 플러그인 id 에만 연결한다
      if (rec?.status !== 'active') return reject(V2_ERRORS.unsupported_op('활성 상태가 아닌 플러그인입니다'))
      if (signal.aborted) return reject(abortError(signal))

      let port: PortLike
      try {
        port = this.deps.runtime.connect(extId, { name: CHANNEL.callPort })
      } catch {
        return reject(unreachable())
      }
      const known = rec.catalog.ops.find((o) => o.name === msg.op)?.extraCodes ?? []
      let received = 0
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        fn()
      }
      const close = () => {
        try { port.disconnect() } catch { /* 이미 끊김 */ }
      }
      const onAbort = () => finish(() => {
        try { port.postMessage({ type: 'cancel' }) } catch { /* 이미 끊김 */ }
        close()
        reject(abortError(signal))
      })

      port.onMessage.addListener((raw) => {
        if (settled) return
        received++
        if (!isObj(raw)) return
        if (raw.type === 'progress' && typeof raw.stage === 'string') {
          onProgress?.(
            cleanText(raw.stage, 60),
            typeof raw.detail === 'string' ? cleanText(raw.detail, 120) : undefined,
            typeof raw.pct === 'number' && Number.isFinite(raw.pct) ? raw.pct : undefined,
          )
        } else if (raw.type === 'result') {
          finish(() => {
            close()
            if (raw.ok === true) resolve(raw.data)
            else reject(normalizeError(raw.error, known))
          })
        }
      })
      port.onDisconnect.addListener(() => finish(() => reject(received === 0 ? unreachable() : disconnected())))
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        port.postMessage(msg)
      } catch {
        finish(() => { close(); reject(unreachable()) })
      }
    })
  }
}
