// 팝업 ↔ 서비스 워커 내부 메시지 계약(chrome.runtime.sendMessage). 페이지와 주고받는 ABP 봉투와는 별개다.

export const TIERS = ['quick', 'normal', 'advanced'] as const
export type Tier = (typeof TIERS)[number]
export const TIER_LABEL: Record<Tier, string> = { quick: '빠름', normal: '보통', advanced: '고급' }

export type JobState =
  | 'waiting_app' // 열린 앱이 없어 탭을 열고 연결을 기다리는 중
  | 'running' // 앱에 call 을 보내고 result 를 기다리는 중
  | 'done'
  | 'error'

export interface TranslateJob {
  id: string
  text: string
  tier: Tier
  state: JobState
  startedAt: number
  finishedAt?: number
  /** 진행 단계 문구(앱의 progress.stage 등, 정제됨) */
  stage?: string
  result?: { text: string; tier: Tier; modelApplied?: string }
  error?: { code: string; message: string }
  /** 결과를 아직 팝업에서 보지 않았는지(배지 표시용) */
  unseen?: boolean
}

export interface AppInfo {
  ns: string
  tabId: number
  title?: string
  connectedAt: number
}

export interface StatusResponse {
  tier: Tier
  /** text.translate 를 제공하는 연결된 앱 수 */
  translators: number
  /** 번역 요청을 보낼 대상(가장 최근 연결) */
  latest: AppInfo | null
  /** 연결된 앱 세션 전체 수(제공 op 무관) */
  sessions: number
  job: TranslateJob | null
}

export type PopupRequest =
  | { kind: 'status' }
  | { kind: 'setTier'; tier: Tier }
  | { kind: 'translate'; text: string }
  | { kind: 'cancelJob' }
  /** 팝업이 결과를 보여 줬음을 알린다(unseen 해제, 배지 지움) */
  | { kind: 'seenJob' }

export type TranslateResponse = { ok: true; jobId: string } | { ok: false; error: { code: string; message: string } }

/** 서비스 워커 → 열린 팝업 브로드캐스트 */
export type PopupEvent = { kind: 'jobUpdate'; job: TranslateJob | null } | { kind: 'statusChanged' }

export const TRANSLATE_MAX_CHARS = 2000
