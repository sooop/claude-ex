// PoC 고정 설정. 아티팩트 주소는 사용자가 게시 후 넘겨준다.

/** 번역 아티팩트 주소. 열린 앱이 없을 때 새 탭으로 연다. 비어 있으면 탭을 열지 않고 오류로 끝낸다 */
export const ARTIFACT_URL = 'https://claude.ai/artifact/NAHzUqkN8hMxGpTGuzL3Ek?sk=Lag-rs3WFpOgyDK5PlX6Dw'

/** 아티팩트의 ABP.CFG.ns */
export const APP_NS = 'claude-ex-poc'

export const EXT_VERSION = '0.1.0'

export const POC = {
  /** 탭을 연 뒤 앱 연결(text.translate 제공)을 기다리는 시간 */
  appWaitMs: 30_000,
  translateTimeoutMs: 60_000,
  /** 로그 본문 자르기 기준(바이트, JSON 직렬화 기준) */
  logBodyMaxBytes: 8 * 1024,
  logMaxEntries: 1000,
} as const
