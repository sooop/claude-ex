// 앱 프레임 origin 검사. PoC 는 고정값이다(옵션 페이지의 허용 목록은 이후 단계).
// 실측 origin: https://<uuid>.frame.claudeusercontent.com, 상위 프레임에 https://claude.ai (docs/postal-notes/protocol-v1-notes.md)

export const PORT_NAME = 'claude-ex-bridge'

const APP_FRAME_ORIGIN = /^https:\/\/[a-z0-9-]+\.frame\.claudeusercontent\.com$/
const APP_PARENT_ORIGIN = 'https://claude.ai'

export function isAllowedAppOrigin(origin: string): boolean {
  return APP_FRAME_ORIGIN.test(origin)
}

/** 앱 프레임이 claude.ai 안에 임베드된 경우에만 true (다른 사이트가 이 호스트를 임베드해도 거부) */
export function hasAllowedParent(ancestorOrigins: readonly string[]): boolean {
  return ancestorOrigins.includes(APP_PARENT_ORIGIN)
}
