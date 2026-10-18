// 포트(앱 프레임) 하나에 대응하는 ABP v2 세션. 제공자(앱 → 확장 call 처리)와 호출자(확장 → 앱 call) 역할을 모두 맡는다.
// reference/src/background/session.ts 의 v2 부분을 바탕으로 v1·우편번호 결합을 걷어내고 op 레지스트리 디스패치로 바꿨다.
import {
  PROTOCOL_V2, V2_ERRORS, V2_LIMITS, clampTimeout, extEnvelope, isV2Envelope, jsonSize, normalizeError,
  parseProvides, validateCall,
  type ProvidedOp, type V2Envelope, type V2Error,
} from '@/lib/protocol'
import { OpError, checkArgs, type Registry } from './registry'

export interface CallLogSink {
  appendSafe(e: {
    ts: number; endTs: number; elapsedMs: number; ns: string; origin: string; op: string; ver: number
    args: unknown; ok: boolean; data?: unknown; error?: { code: string; message: string }
  }): Promise<void>
}

export interface SessionDeps {
  /** 플러그인 승인에 따라 바뀐다. 호출할 때마다 읽으므로 getter 로 최신 레지스트리를 돌려줘도 된다 */
  readonly registry: Registry
  log: CallLogSink
  extVersion: string
  now(): number
  uuid(): string
  /** 앱의 첫 메시지 전에 확장이 먼저 hello 할 때 쓰는 ns(서비스 워커 재시작 뒤 앱이 다시 hello 하지 않는 경우 대비) */
  defaultNs?: string
  /** 앱이 hello/hello_ack 로 능력을 알렸거나 바뀌었을 때 */
  onPeerChange?(session: AppSession): void
}

export interface CallAppOptions {
  timeoutMs?: number
  signal?: AbortSignal
  onProgress?(stage: string, detail?: string): void
}

interface Pending {
  resolve(data: unknown): void
  reject(e: V2Error): void
  timer: ReturnType<typeof setTimeout>
  onProgress?: (stage: string, detail?: string) => void
  cleanup(): void
}

type Post = (msg: Record<string, unknown>) => void

let seq = 0

export class AppSession {
  readonly key = `s${++seq}`
  /** 앱이 hello 나 call 로 알린 ns. 첫 메시지 전에는 빈 문자열 */
  ns = ''
  /** 앱이 제공하는 op(hello/hello_ack 의 provides) */
  peerProvides: ProvidedOp[] = []
  /** 앱의 hello/hello_ack 를 마지막으로 받은 시각. 0 이면 아직 모름 */
  peerSeenAt = 0
  /** 진행 중인 앱 → 확장 call: id → 중단기 */
  private active = new Map<string, { op: string; controller: AbortController }>()
  /** 진행 중인 확장 → 앱 call */
  private pending = new Map<string, Pending>()
  private disposed = false

  constructor(
    private post: Post,
    private deps: SessionDeps,
    readonly origin: string,
    readonly tabId?: number,
  ) {}

  private send(type: V2Envelope['type'], id: string, body: Record<string, unknown> = {}) {
    const ns = this.ns || this.deps.defaultNs
    if (this.disposed || !ns) return
    this.post(extEnvelope(ns, type, id, body))
  }

  private helloBody() {
    return {
      role: 'extension',
      version: this.deps.extVersion,
      supportedVersions: [PROTOCOL_V2],
      catalogRev: this.deps.registry.catalogRev,
      provides: this.deps.registry.provides(),
    }
  }

  /** 확장이 먼저 보내는 hello. 앱의 첫 메시지 전이면 defaultNs 로 보낸다 */
  hello(): void {
    this.send('hello', `x-${this.key}-${this.deps.uuid()}`, this.helloBody())
  }

  /** 카탈로그가 바뀌었음을 앱에 알린다(명세 01 3.8). 앱은 설명 캐시를 버리고 목록을 다시 받는다 */
  notifyCatalog(): void {
    this.send('event', `x-${this.key}-${this.deps.uuid()}`, { name: 'catalog_changed', data: { catalogRev: this.deps.registry.catalogRev } })
  }

  provides(op: string, ver: number): ProvidedOp | undefined {
    return this.peerProvides.find((p) => p.op === op && p.ver === ver && p.state !== 'needs_setup')
  }

  handle(data: unknown): void {
    if (this.disposed || !isV2Envelope(data)) return
    const firstContact = !this.ns
    this.ns = data.ns
    switch (data.type) {
      case 'hello':
        if (data.v !== PROTOCOL_V2) return
        this.notePeer(data)
        this.send('hello_ack', data.id, { ok: true, ...this.helloBody() })
        return
      case 'hello_ack':
        if (data.v !== PROTOCOL_V2) return
        this.notePeer(data)
        return
      case 'call':
        // 앱이 hello 없이 바로 call 하면 우리 hello 도 같이 보내 능력을 알린다
        if (firstContact) this.hello()
        void this.handleCall(data)
        return
      case 'cancel':
        this.active.get(data.id)?.controller.abort('cancelled')
        return
      case 'progress':
      case 'result':
        this.onCallerMessage(data)
        return
      case 'event':
        // PoC: 앱발 event 는 처리하지 않는다
        return
    }
  }

  private notePeer(data: V2Envelope) {
    const sv = data.supportedVersions
    if (Array.isArray(sv) && !sv.includes(PROTOCOL_V2)) return
    if (jsonSize(data.provides) > V2_LIMITS.maxProvidesBytes) {
      this.peerProvides = []
    } else {
      this.peerProvides = parseProvides(data.provides)
    }
    this.peerSeenAt = this.deps.now()
    this.deps.onPeerChange?.(this)
  }

  // ── 제공자 역할: 앱 → 확장 call ─────────────────────────────────────────

  private async handleCall(data: V2Envelope) {
    const id = data.id
    const startedAt = this.deps.now()
    let untrusted = false
    const op = typeof data.op === 'string' ? data.op.slice(0, 64) : ''
    const ver = typeof data.ver === 'number' ? data.ver : 0
    const finish = (out: { ok: true; data: unknown } | { ok: false; error: V2Error }) => {
      const endTs = this.deps.now()
      if (out.ok) this.send('result', id, { ok: true, data: out.data, meta: { elapsedMs: endTs - startedAt, ...(untrusted ? { untrusted: true } : {}) } })
      else this.send('result', id, { ok: false, error: out.error })
      void this.deps.log.appendSafe({
        ts: startedAt, endTs, elapsedMs: endTs - startedAt, ns: this.ns, origin: this.origin, op, ver,
        args: data.args, ok: out.ok,
        ...(out.ok ? { data: out.data } : { error: { code: out.error.code, message: out.error.message } }),
      })
    }

    if (data.v !== PROTOCOL_V2) return finish({ ok: false, error: V2_ERRORS.unsupported_version(`지원하지 않는 v: ${data.v}`) })
    if (jsonSize(data) > V2_LIMITS.maxMessageBytes)
      return finish({ ok: false, error: { code: 'payload_too_large', message: '메시지가 1MiB를 넘습니다', retryable: false } })
    if (this.active.has(id)) return finish({ ok: false, error: V2_ERRORS.invalid_request('이미 진행 중인 id 입니다') })

    const c = validateCall(data)
    if (!c.ok) return finish({ ok: false, error: c.error })
    const def = this.deps.registry.get(c.call.op, c.call.ver)
    if (!def) {
      return finish({
        ok: false,
        error: V2_ERRORS.unsupported_op(`지원하지 않는 op: ${c.call.op} v${c.call.ver}`, { known: this.deps.registry.known() }),
      })
    }
    untrusted = def.untrusted === true
    const a = checkArgs(def, c.call.args)
    if (!a.ok) return finish({ ok: false, error: a.error })
    if ([...this.active.values()].some((x) => x.op === def.name)) return finish({ ok: false, error: V2_ERRORS.busy() })

    const controller = new AbortController()
    const timeoutMs = Math.min(c.call.timeoutMs, def.limits.timeoutMs)
    const timer = setTimeout(() => controller.abort('timeout'), timeoutMs)
    this.active.set(id, { op: def.name, controller })
    try {
      const result = await Promise.race([
        def.handler({
          args: a.args,
          signal: controller.signal,
          progress: (stage, detail, pct) => {
            if (!controller.signal.aborted)
              this.send('progress', id, { stage, ...(detail ? { detail } : {}), ...(pct !== undefined ? { pct } : {}) })
          },
          sender: { ns: this.ns, origin: this.origin, tabId: this.tabId },
          timeoutMs,
        }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
        }),
      ])
      finish({ ok: true, data: result })
    } catch (e) {
      if (e instanceof OpError) finish({ ok: false, error: e.error })
      else if (e === 'timeout') finish({ ok: false, error: V2_ERRORS.timeout() })
      else if (e === 'cancelled') finish({ ok: false, error: V2_ERRORS.cancelled() })
      else finish({ ok: false, error: V2_ERRORS.internal('op 처리 중 오류') })
    } finally {
      clearTimeout(timer)
      this.active.delete(id)
    }
  }

  // ── 호출자 역할: 확장 → 앱 call ─────────────────────────────────────────

  /** 앱의 op 를 호출한다. 성공하면 data, 실패하면 V2Error 로 reject. 재시도는 호출부(callWithRetry)가 맡는다 */
  callApp(op: string, ver: number, args: Record<string, unknown>, opts: CallAppOptions = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.disposed) return reject(V2_ERRORS.internal('앱 연결이 끊겼습니다'))
      if (!this.provides(op, ver)) return reject(V2_ERRORS.unsupported_op(`앱이 ${op} v${ver}를 제공하지 않습니다`))
      if (this.pending.size >= V2_LIMITS.maxPending) return reject(V2_ERRORS.busy('대기 중인 호출이 너무 많습니다'))
      if (opts.signal?.aborted) return reject(V2_ERRORS.cancelled())

      const id = `x-${this.deps.uuid()}`
      const timeoutMs = clampTimeout(opts.timeoutMs)
      const onAbort = () => {
        this.send('cancel', id)
        settle()
        reject(V2_ERRORS.cancelled())
      }
      const settle = () => {
        const p = this.pending.get(id)
        if (!p) return false
        clearTimeout(p.timer)
        p.cleanup()
        this.pending.delete(id)
        return true
      }
      const timer = setTimeout(() => {
        this.send('cancel', id)
        settle()
        reject(V2_ERRORS.timeout('앱이 제한 시간 안에 응답하지 않았습니다'))
      }, timeoutMs + V2_LIMITS.graceMs)
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (d) => { settle(); resolve(d) },
        reject: (e) => { settle(); reject(e) },
        timer,
        onProgress: opts.onProgress,
        cleanup: () => opts.signal?.removeEventListener('abort', onAbort),
      })
      this.send('call', id, { op, ver, args, opts: { timeoutMs } })
    })
  }

  private onCallerMessage(data: V2Envelope) {
    const p = this.pending.get(data.id)
    if (!p) return // 이미 끝났거나 모르는 id: 무시
    if (data.type === 'progress') {
      if (typeof data.stage === 'string') p.onProgress?.(data.stage.slice(0, 60), typeof data.detail === 'string' ? data.detail.slice(0, 120) : undefined)
      return
    }
    if (data.ok === true) p.resolve(data.data)
    else p.reject(normalizeError(data.error))
  }

  /** 포트가 닫히면 진행 중인 작업을 모두 끝낸다 */
  dispose(): void {
    if (this.disposed) return
    for (const { controller } of this.active.values()) controller.abort('cancelled')
    for (const p of [...this.pending.values()]) p.reject(V2_ERRORS.internal('앱 연결이 끊겼습니다'))
    this.disposed = true
    this.peerProvides = []
    this.deps.onPeerChange?.(this)
  }

  get isDisposed() {
    return this.disposed
  }
}

/** busy 와 retryable 오류는 지수 백오프로 최대 2회 재시도한다(명세 02 4.3) */
export async function callWithRetry(
  call: () => Promise<unknown>,
  opts: { retries?: number; baseDelayMs?: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {},
): Promise<unknown> {
  const retries = opts.retries ?? 2
  const base = opts.baseDelayMs ?? 500
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  for (let attempt = 0; ; attempt++) {
    try {
      return await call()
    } catch (e) {
      const err = e as V2Error
      // timeout 은 앱이 처리 중일 수 있어 다시 보내지 않는다(번역이 두 번 실행되는 것을 막는다)
      const retry = err?.code === 'busy' && attempt < retries && !opts.signal?.aborted
      if (!retry) throw e
      await sleep(base * 2 ** attempt)
    }
  }
}
