import { runLookup, toBridgeError, type LookupDeps } from '@/lib/lookup'
import {
  BRIDGE_SOURCE, ERRORS, FEATURES, LIMITS, PROTOCOL_V,
  isAppEnvelope, validateLookup,
  type BridgeError, type LookupRequest,
} from '@/lib/protocol'
import {
  PROTOCOL_V2, PROVIDES, V2_ERRORS, V2_EXT_SOURCE,
  isV2Envelope, toLookupRequest, toV2Error, validateCall, type V2Error,
} from '@/lib/protocolV2'
import type { AppEndpoint, DecideClient } from './decide'
import type { SearchPage, Source } from '@/lib/search'
import { RequestQueue } from './queue'

export interface SessionDeps {
  queue: RequestQueue
  extVersion: string
  /** 우체국 호출. signal 로 중단된다 */
  fetchPage(keyword: string, pageIdx: number, pageSize: number, source: Source, signal: AbortSignal): Promise<SearchPage>
  now(): number
  /** 후보 판정(확장 → 앱) 클라이언트. ready/decision/progress 를 여기로 넘긴다 */
  decide?: DecideClient
}

type RunOutcome =
  | { ok: true; candidates: unknown; meta: object }
  | { ok: false; error: BridgeError; meta?: object }

type Post = (msg: Record<string, unknown>) => void

let sessionSeq = 0

/** 포트(프레임) 하나에 대응하는 프로토콜 처리기. 조회어와 결과는 저장하거나 기록하지 않는다 */
export class BridgeSession implements AppEndpoint {
  private readonly prefix = `s${++sessionSeq}:`
  private active = new Set<string>()
  /** v2 call 진행 중 id. op 당 동시 1건(maxConcurrent)이라 세션 단위로 센다 */
  private activeV2 = new Map<string, string>()
  /** v2 ns 는 앱이 hello 로 알린 값을 쓴다(없으면 call 의 ns 를 따른다) */
  private ns = 'postal-converter'

  constructor(private post: Post, private deps: SessionDeps, readonly tabId?: number) {}

  send(msg: Record<string, unknown>) {
    this.post({ source: BRIDGE_SOURCE, v: PROTOCOL_V, ts: this.deps.now(), ...msg })
  }

  private fail(id: string, error: BridgeError) {
    this.send({ type: 'result', id, ok: false, error })
  }

  // ── v2 ──────────────────────────────────────────────────────────────────

  sendV2(msg: Record<string, unknown>) {
    this.post({ source: V2_EXT_SOURCE, v: PROTOCOL_V2, ns: this.ns, ts: this.deps.now(), ...msg })
  }

  /** 포트 연결 직후 확장이 먼저 hello 를 보낸다(로드 순서가 보장되지 않아 양쪽이 모두 보낸다) */
  hello(): void {
    this.sendV2({ type: 'hello', id: `x-${this.prefix}hello`, ...this.helloBody() })
  }

  private helloBody() {
    return {
      role: 'extension',
      version: this.deps.extVersion,
      supportedVersions: [PROTOCOL_V2],
      provides: PROVIDES,
    }
  }

  private failV2(id: string, error: V2Error) {
    this.sendV2({ type: 'result', id, ok: false, error })
  }

  private handleV2(data: Record<string, unknown> & { id: string; v: number; ns: string; type: string }): void {
    this.ns = data.ns
    switch (data.type) {
      case 'hello':
        if (data.v !== PROTOCOL_V2) return
        this.sendV2({ type: 'hello_ack', id: data.id, ok: true, ...this.helloBody() })
        return
      case 'call':
        void this.callV2(data)
        return
      case 'cancel':
        if (data.v !== PROTOCOL_V2) return
        if (this.activeV2.has(data.id)) this.deps.queue.cancel(this.prefix + data.id)
        return
      // hello_ack, result, progress, event: 앱이 제공하는 op(ai.decide)는 아직 v1 경로를 쓴다
    }
  }

  private async callV2(data: Record<string, unknown> & { id: string; v: number }) {
    const id = data.id
    if (data.v !== PROTOCOL_V2) return this.failV2(id, V2_ERRORS.unsupported_version(`지원하지 않는 v: ${data.v}`))
    if (this.activeV2.has(id)) return this.failV2(id, V2_ERRORS.invalid_request('이미 진행 중인 id 입니다'))

    const c = validateCall(data)
    if (!c.ok) return this.failV2(id, c.error)
    if (this.activeV2.size >= 1) return this.failV2(id, V2_ERRORS.busy())

    // op 레지스트리: 현재 web.query v1 하나
    const q = toLookupRequest(c.call.args, c.call.timeoutMs)
    if (!q.ok) return this.failV2(id, q.error)

    this.activeV2.set(id, c.call.op)
    const startedAt = this.deps.now()
    const outcome = await this.runQueued(id, q.req, (stage, detail) =>
      this.sendV2({ type: 'progress', id, stage, ...(detail ? { detail } : {}) }))
    this.activeV2.delete(id)

    const elapsedMs = this.deps.now() - startedAt
    if (outcome.ok) {
      // 외부 사이트에서 읽은 텍스트이므로 untrusted 로 표시한다(앱이 AI 프롬프트에 넣을 때 데이터로 구획)
      this.sendV2({ type: 'result', id, ok: true, data: { items: outcome.candidates }, meta: { ...outcome.meta, elapsedMs, untrusted: true } })
    } else {
      this.sendV2({ type: 'result', id, ok: false, error: toV2Error(outcome.error), ...(outcome.meta ? { meta: outcome.meta } : {}) })
    }
  }

  // ── v1 + 공통 ───────────────────────────────────────────────────────────

  handle(data: unknown): void {
    if (isV2Envelope(data)) return this.handleV2(data)
    if (!isAppEnvelope(data)) return

    switch (data.type) {
      case 'ping':
        if (data.v !== PROTOCOL_V) return
        this.send({
          type: 'pong', id: data.id, ok: true,
          extVersion: this.deps.extVersion,
          supportedVersions: [PROTOCOL_V],
          features: [...FEATURES],
          limits: {
            minIntervalMs: LIMITS.minIntervalMs,
            maxLimit: LIMITS.maxLimit,
            defaultTimeoutMs: LIMITS.defaultTimeoutMs,
          },
        })
        return
      case 'lookup':
        void this.lookup(data)
        return
      case 'cancel':
        if (data.v !== PROTOCOL_V) return
        if (this.active.has(data.id)) this.deps.queue.cancel(this.prefix + data.id)
        return
      case 'ready':
      case 'decision':
      case 'progress':
        // 후보 판정 방향: 앱이 확장에 보내는 메시지
        if (data.v !== PROTOCOL_V) return
        this.deps.decide?.onAppMessage(this, data)
        return
    }
  }

  /** 포트가 닫히면 이 세션의 작업을 모두 중단한다(응답할 곳이 없다) */
  dispose(): void {
    this.deps.decide?.detach(this)
    for (const id of [...this.active, ...this.activeV2.keys()]) this.deps.queue.cancel(this.prefix + id)
    this.active.clear()
    this.activeV2.clear()
  }

  private async lookup(data: Record<string, unknown> & { id: string; v: number }) {
    const id = data.id
    if (data.v !== PROTOCOL_V) return this.fail(id, ERRORS.invalid_request(`지원하지 않는 v: ${data.v}`))
    if (this.active.has(id)) return this.fail(id, ERRORS.invalid_request('이미 진행 중인 id 입니다'))

    const v = validateLookup(data)
    if (!v.ok) return this.fail(id, v.error)

    this.active.add(id)
    const outcome = await this.runQueued(id, v.req, (stage, detail) =>
      this.send({ type: 'progress', id, stage, ...(detail ? { detail } : {}) }))
    this.active.delete(id)

    if (outcome.ok) this.send({ type: 'result', id, ok: true, candidates: outcome.candidates, meta: outcome.meta })
    else this.send({ type: 'result', id, ok: false, error: outcome.error, ...(outcome.meta ? { meta: outcome.meta } : {}) })
  }

  /** 큐에 넣어 조회를 실행하고 v1/v2 공통 결과로 돌려준다 */
  private async runQueued(
    id: string,
    req: LookupRequest,
    onProgress: (stage: string, detail?: string) => void,
  ): Promise<RunOutcome> {
    const outcome = await this.deps.queue.enqueue(this.prefix + id, req.timeoutMs, async ({ signal, throttle }) => {
      const lookupDeps: LookupDeps = {
        fetchPage: (kw, idx, size, source) => this.deps.fetchPage(kw, idx, size, source, signal),
        throttle,
        onProgress: (stage, detail) => !signal.aborted && onProgress(stage, detail),
        now: this.deps.now,
      }
      return runLookup(req, lookupDeps, signal)
    })

    switch (outcome.status) {
      case 'ok': {
        const r = outcome.value
        return r.ok
          ? { ok: true, candidates: r.candidates, meta: r.meta }
          : { ok: false, error: r.error, ...(r.meta ? { meta: r.meta } : {}) }
      }
      case 'cancelled': return { ok: false, error: ERRORS.cancelled() }
      case 'timeout': return { ok: false, error: ERRORS.timeout() }
      case 'full': return { ok: false, error: ERRORS.rate_limited(LIMITS.minIntervalMs * LIMITS.maxQueue) }
      case 'error': return { ok: false, error: toBridgeError(outcome.error) }
    }
  }
}
