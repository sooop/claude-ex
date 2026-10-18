// 플러그인(동반 확장) 쪽 헬퍼: 허브 등록, 호출 포트 수신, invoke/progress/result/cancel 처리.
// chrome API 는 주입받는다(테스트에서 가짜로 바꾼다). 기본값은 전역 chrome.runtime.
import { V2_ERRORS, type V2Error } from './errors'
import {
  CHANNEL, SDK_VERSION,
  type CallSender, type HubToPlugin, type InvokeMessage, type PluginCatalog, type PluginToHub,
  type RegisterMessage, type RegisterResponse,
} from './plugin'
import { validateSchema, type Schema } from './schema'

export interface PortLike {
  name: string
  sender?: { id?: string }
  postMessage(msg: unknown): void
  disconnect(): void
  onMessage: { addListener(fn: (msg: unknown) => void): void }
  onDisconnect: { addListener(fn: () => void): void }
}

export interface CompanionRuntime {
  sendMessage(extensionId: string, msg: unknown): Promise<unknown>
  onConnectExternal: { addListener(fn: (port: PortLike) => void): void }
}

export interface InvokeRequest {
  op: string
  ver: number
  adapter?: string
  /** 스키마 검증과 default 채움을 거친 인자 */
  args: Record<string, unknown>
}

export interface InvokeContext {
  signal: AbortSignal
  progress(stage: string, detail?: string, pct?: number): void
  sender: CallSender
}

/** 핸들러가 던지면 그대로 error result 로 나간다 */
export class PluginError extends Error {
  constructor(readonly error: V2Error) {
    super(error.message)
  }
}

export interface CompanionOptions {
  hubId: string
  name: string
  version: string
  catalog: PluginCatalog
  handle(req: InvokeRequest, ctx: InvokeContext): Promise<unknown>
  runtime?: CompanionRuntime
  /** 등록 결과. 허브가 없으면 null */
  onRegister?(r: RegisterResponse | null): void
}

export interface Companion {
  /** 등록을 (다시) 보낸다. 허브가 없으면 null */
  register(): Promise<RegisterResponse | null>
}

const MAX_TIMEOUT_MS = 300_000

function defaultRuntime(): CompanionRuntime {
  const rt = (globalThis as { chrome?: { runtime?: unknown } }).chrome?.runtime
  if (!rt) throw new Error('chrome.runtime 이 없습니다')
  return rt as CompanionRuntime
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)

/** 인자 스키마를 찾는다. 어댑터 호출이면 어댑터 params, 아니면 op args */
function findSchema(catalog: PluginCatalog, m: InvokeMessage): Schema | undefined {
  if (m.adapter !== undefined) return catalog.adapters[m.op]?.find((a) => a.id === m.adapter)?.params
  return catalog.ops.find((o) => o.name === m.op && o.ver === m.ver)?.args
}

function parseInvoke(msg: unknown): InvokeMessage | undefined {
  if (!isObj(msg) || msg.type !== 'invoke') return undefined
  if (typeof msg.op !== 'string' || typeof msg.ver !== 'number' || !isObj(msg.args)) return undefined
  if (msg.adapter !== undefined && typeof msg.adapter !== 'string') return undefined
  const s = isObj(msg.sender) ? msg.sender : {}
  const t = typeof msg.timeoutMs === 'number' && msg.timeoutMs > 0 ? Math.min(msg.timeoutMs, MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS
  return {
    type: 'invoke', op: msg.op, ver: msg.ver, args: msg.args, timeoutMs: t,
    ...(msg.adapter !== undefined ? { adapter: msg.adapter as string } : {}),
    sender: { ns: typeof s.ns === 'string' ? s.ns : '', origin: typeof s.origin === 'string' ? s.origin : '' },
  }
}

function serveCall(port: PortLike, opts: CompanionOptions) {
  const controller = new AbortController()
  let started = false
  let done = false
  const post = (m: PluginToHub) => {
    if (done) return
    try { port.postMessage(m) } catch { /* 허브가 포트를 닫음 */ }
  }
  const finish = (r: { ok: true; data: unknown } | { ok: false; error: V2Error }) => {
    post({ type: 'result', ...r } as PluginToHub)
    done = true
  }

  port.onDisconnect.addListener(() => {
    done = true
    controller.abort('cancelled')
  })
  port.onMessage.addListener((raw) => {
    const msg = raw as HubToPlugin
    if (isObj(msg) && msg.type === 'cancel') {
      controller.abort('cancelled')
      return
    }
    if (started) return
    started = true
    void run(msg)
  })

  async function run(raw: unknown) {
    const m = parseInvoke(raw)
    if (!m) return finish({ ok: false, error: V2_ERRORS.invalid_request('invoke 형식 오류') })
    const schema = findSchema(opts.catalog, m)
    if (!schema) {
      const what = m.adapter !== undefined ? `${m.op} 어댑터 ${m.adapter}` : `${m.op} v${m.ver}`
      return finish({ ok: false, error: V2_ERRORS.unsupported_op(`플러그인에 없는 ${what}`) })
    }
    const v = validateSchema(schema, m.args)
    if (v.err !== undefined) return finish({ ok: false, error: V2_ERRORS.invalid_request(v.err.slice(0, 160)) })

    const timer = setTimeout(() => controller.abort('timeout'), m.timeoutMs)
    try {
      const data = await Promise.race([
        opts.handle(
          { op: m.op, ver: m.ver, args: v.value as Record<string, unknown>, ...(m.adapter !== undefined ? { adapter: m.adapter } : {}) },
          {
            signal: controller.signal,
            sender: m.sender,
            progress: (stage, detail, pct) => {
              if (!controller.signal.aborted)
                post({ type: 'progress', stage, ...(detail ? { detail } : {}), ...(pct !== undefined ? { pct } : {}) })
            },
          },
        ),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
        }),
      ])
      finish({ ok: true, data })
    } catch (e) {
      if (e instanceof PluginError) finish({ ok: false, error: e.error })
      else if (e === 'timeout') finish({ ok: false, error: V2_ERRORS.timeout() })
      else if (e === 'cancelled') finish({ ok: false, error: V2_ERRORS.cancelled() })
      else finish({ ok: false, error: V2_ERRORS.internal('플러그인 처리 중 오류') })
    } finally {
      clearTimeout(timer)
    }
  }
}

/** 플러그인 확장의 서비스 워커에서 한 번 부른다. 곧바로 허브에 등록을 보낸다 */
export function serveAsCompanion(opts: CompanionOptions): Companion {
  const rt = opts.runtime ?? defaultRuntime()

  rt.onConnectExternal.addListener((port) => {
    if (port.name !== CHANNEL.callPort) return
    if (port.sender?.id !== opts.hubId) {
      port.disconnect()
      return
    }
    serveCall(port, opts)
  })

  const register = async (): Promise<RegisterResponse | null> => {
    const msg: RegisterMessage = { kind: CHANNEL.register, sdk: SDK_VERSION, name: opts.name, version: opts.version, catalog: opts.catalog }
    let r: RegisterResponse | null = null
    try {
      const res = await rt.sendMessage(opts.hubId, msg)
      if (isObj(res) && (res.status === 'active' || res.status === 'pending' || res.status === 'rejected'))
        r = { status: res.status, ...(typeof res.reason === 'string' ? { reason: res.reason } : {}) }
    } catch {
      // 허브가 설치되지 않았거나 꺼져 있음
    }
    opts.onRegister?.(r)
    return r
  }
  void register()
  return { register }
}
