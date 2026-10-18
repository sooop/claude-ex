// 확장 → 앱 번역 요청(text.translate@1)의 라우팅과 작업 상태.
// 대상은 text.translate 를 제공하는 세션 중 가장 최근에 hello 한 하나. 없으면 아티팩트 탭을 열고 연결을 기다린다.
import { cleanText, type V2Error } from '@/lib/protocol'
import { validateSchema, type Schema } from '@/lib/schema'
import { TRANSLATE_MAX_CHARS, type AppInfo, type Tier, type TranslateJob } from '@/lib/messages'
import { callWithRetry, type AppSession } from './session'

export const TRANSLATE_OP = 'text.translate'
export const TRANSLATE_VER = 1

/** 앱이 돌려주는 결과 스키마. 선언 외 필드가 있으면 거부한다 */
const resultSchema: Schema = {
  type: 'object',
  required: ['text'],
  properties: {
    text: { type: 'string', maxLength: 8000 },
    tier: { type: 'string', enum: ['quick', 'normal', 'advanced'] },
    modelApplied: { type: 'string', maxLength: 100 },
  },
}

export interface HubDeps {
  now(): number
  uuid(): string
  getTier(): Promise<Tier>
  artifactUrl: string
  appWaitMs: number
  timeoutMs: number
  openTab(url: string): Promise<void>
  /** 작업이 바뀔 때마다 호출(저장·팝업 알림·배지) */
  onJob(job: TranslateJob | null): void
  /** 연결 상태가 바뀔 때(팝업 상태 갱신) */
  onStatus?(): void
  /** 결과가 나온 뒤 팝업을 다시 띄운다. 실패해도 무시 */
  openPopup?(): Promise<void>
}

export class TranslateHub {
  private sessions = new Set<AppSession>()
  private job: TranslateJob | null = null
  private controller: AbortController | null = null
  private waiters = new Set<() => void>()

  constructor(private deps: HubDeps) {}

  /** 서비스 워커 재시작 뒤 저장된 작업을 복원한다. 진행 중이던 작업은 끊긴 것으로 끝낸다 */
  restore(job: TranslateJob | null) {
    if (job && (job.state === 'running' || job.state === 'waiting_app')) {
      job = { ...job, state: 'error', finishedAt: this.deps.now(), unseen: true,
        error: { code: 'internal', message: '확장이 재시작되어 번역이 중단되었습니다' } }
      this.deps.onJob(job)
    }
    this.job = job
  }

  add(s: AppSession) {
    this.sessions.add(s)
  }

  remove(s: AppSession) {
    this.sessions.delete(s)
    this.deps.onStatus?.()
  }

  /** 세션의 provides 가 바뀌면 호출. 연결을 기다리는 번역 작업을 깨운다 */
  peerChanged() {
    if (this.latest()) for (const w of [...this.waiters]) w()
    this.deps.onStatus?.()
  }

  translators(): AppSession[] {
    return [...this.sessions]
      .filter((s) => !s.isDisposed && s.provides(TRANSLATE_OP, TRANSLATE_VER))
      .sort((a, b) => b.peerSeenAt - a.peerSeenAt)
  }

  latest(): AppSession | undefined {
    return this.translators()[0]
  }

  info(s: AppSession | undefined): AppInfo | null {
    return s ? { ns: s.ns, tabId: s.tabId ?? -1, connectedAt: s.peerSeenAt } : null
  }

  get sessionCount() {
    return this.sessions.size
  }

  get current() {
    return this.job
  }

  private update(patch: Partial<TranslateJob>) {
    if (!this.job) return
    this.job = { ...this.job, ...patch }
    this.deps.onJob(this.job)
  }

  markSeen() {
    if (this.job?.unseen) this.update({ unseen: false })
  }

  cancel() {
    this.controller?.abort()
  }

  private waitForTranslator(ms: number, signal: AbortSignal): Promise<AppSession | undefined> {
    const now = this.latest()
    if (now) return Promise.resolve(now)
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.waiters.delete(done)
        signal.removeEventListener('abort', done)
        resolve(this.latest())
      }
      const timer = setTimeout(done, ms)
      this.waiters.add(done)
      signal.addEventListener('abort', done, { once: true })
    })
  }

  /** 번역을 시작한다. 결과는 onJob 으로 알린다. 시작 자체가 불가능하면 오류를 돌려준다 */
  async start(rawText: string): Promise<{ ok: true; jobId: string } | { ok: false; error: { code: string; message: string } }> {
    const text = typeof rawText === 'string' ? rawText.trim() : ''
    if (!text) return { ok: false, error: { code: 'invalid_request', message: '번역할 문장을 입력하세요' } }
    if (text.length > TRANSLATE_MAX_CHARS)
      return { ok: false, error: { code: 'invalid_request', message: `${TRANSLATE_MAX_CHARS}자 이하로 입력하세요` } }
    if (this.job && (this.job.state === 'running' || this.job.state === 'waiting_app'))
      return { ok: false, error: { code: 'busy', message: '진행 중인 번역이 있습니다' } }
    if (!this.latest() && !this.deps.artifactUrl)
      return { ok: false, error: { code: 'not_granted', message: '열린 번역 앱이 없고 아티팩트 주소가 설정되지 않았습니다' } }

    const tier = await this.deps.getTier()
    const id = this.deps.uuid()
    this.job = { id, text, tier, state: 'running', startedAt: this.deps.now() }
    this.controller = new AbortController()
    void this.run(this.controller.signal)
    return { ok: true, jobId: id }
  }

  private async run(signal: AbortSignal) {
    const job = this.job!
    let openedTab = false
    try {
      let target = this.latest()
      if (!target) {
        openedTab = true
        this.update({ state: 'waiting_app', stage: '번역 앱 탭을 여는 중' })
        await this.deps.openTab(this.deps.artifactUrl)
        target = await this.waitForTranslator(this.deps.appWaitMs, signal)
        if (signal.aborted) throw { code: 'cancelled', message: '취소되었습니다', retryable: false } satisfies V2Error
        if (!target)
          throw { code: 'timeout', message: '번역 앱이 제한 시간 안에 연결되지 않았습니다', retryable: false } satisfies V2Error
      }
      this.update({ state: 'running', stage: '번역 요청 전송' })
      const session = target
      const data = await callWithRetry(
        () => session.callApp(TRANSLATE_OP, TRANSLATE_VER, { text: job.text, tier: job.tier }, {
          timeoutMs: this.deps.timeoutMs,
          signal,
          onProgress: (stage) => this.update({ stage: cleanText(stage, 60) }),
        }),
        { signal },
      )
      // 앱의 결과도 신뢰하지 않는다: 스키마 검증 후 정제
      const r = validateSchema(resultSchema, data)
      if (r.err !== undefined) throw { code: 'parse_failed', message: `앱 결과 형식 오류: ${r.err}`, retryable: false } satisfies V2Error
      const d = r.value as { text: string; tier?: Tier; modelApplied?: string }
      this.update({
        state: 'done', finishedAt: this.deps.now(), unseen: true, stage: undefined,
        result: {
          text: cleanText(d.text, 8000),
          tier: d.tier ?? job.tier,
          ...(d.modelApplied ? { modelApplied: cleanText(d.modelApplied, 100) } : {}),
        },
      })
    } catch (e) {
      const err = (e && typeof e === 'object' ? e : {}) as Partial<V2Error>
      this.update({
        state: 'error', finishedAt: this.deps.now(), unseen: true, stage: undefined,
        error: { code: String(err.code ?? 'internal'), message: cleanText(err.message ?? '번역에 실패했습니다', 300) },
      })
    } finally {
      this.controller = null
    }
    // 탭을 열면 팝업이 닫히므로 결과가 나온 뒤 다시 띄운다(동의 창 클릭으로 닫히는 것을 피하려고 결과 시점에 연다)
    if (openedTab) await this.deps.openPopup?.().catch(() => {})
  }
}
