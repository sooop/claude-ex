// 앱 프레임(window.postMessage) ↔ 확장 service worker 중계. 메시지 내용은 해석하거나 저장하지 않는다.
import {
  BRIDGE_SOURCE, ERRORS, PORT_NAME, PROTOCOL_V,
  hasAllowedParent, isAllowedAppOrigin, isAppEnvelope,
} from '@/lib/protocol'
import { PROTOCOL_V2, V2_ERRORS, V2_EXT_SOURCE, isV2Envelope } from '@/lib/protocolV2'

// 알려진 origin(https://claude.ai)이면 그 origin 으로만 응답한다. 불투명 origin 이면 '*' 로 대체한다.
const targetOrigin = location.origin === 'null' ? '*' : location.origin

let port: chrome.runtime.Port | null = null
/** 진행 중인 호출 id -> 프로토콜 버전과 ns. 연결이 끊기면 버전에 맞는 봉투로 오류를 돌려준다 */
const pendingLookups = new Map<string, { ver: 1 | 2; ns?: string }>()

function toPage(msg: unknown) {
  window.postMessage(msg, targetOrigin)
}

function getPort(): chrome.runtime.Port {
  if (port) return port
  const p = chrome.runtime.connect({ name: PORT_NAME })

  p.onMessage.addListener((msg: { source?: string; type?: string; id?: string }) => {
    if (msg?.source !== BRIDGE_SOURCE && msg?.source !== V2_EXT_SOURCE) return
    if (msg.type === 'result' && typeof msg.id === 'string') pendingLookups.delete(msg.id)
    toPage(msg)
  })

  p.onDisconnect.addListener(() => {
    port = null
    scheduleReconnect()
    // service worker 가 끊기면 진행 중이던 조회는 내부 오류로 알린다
    for (const [id, info] of pendingLookups) {
      if (info.ver === 2) {
        toPage({
          source: V2_EXT_SOURCE, v: PROTOCOL_V2, ns: info.ns ?? 'postal-converter', type: 'result', id, ok: false,
          error: V2_ERRORS.internal('확장 연결이 끊겼습니다', 'worker_restarted'),
        })
      } else {
        toPage({ source: BRIDGE_SOURCE, v: PROTOCOL_V, type: 'result', id, ok: false, error: ERRORS.internal('확장 연결이 끊겼습니다') })
      }
    }
    pendingLookups.clear()
  })

  port = p
  return p
}

// manifest 매치와 별개로, 앱 프레임 origin 이고 claude.ai 안에 임베드된 경우에만 동작한다
const active = isAllowedAppOrigin(location.origin) && hasAllowedParent(Array.from(location.ancestorOrigins ?? []))

/**
 * 포트를 앱의 첫 메시지를 기다리지 않고 미리 연결해 둔다. 확장(서비스 워커)이 먼저 앱 프레임을 찾아 판정을 요청하려면
 * 연결이 있어야 한다. 서비스 워커가 재시작돼 포트가 끊기면 다시 연결한다(확장이 갱신·제거돼 컨텍스트가 무효화되면 중단).
 */
let retryDelay = 500
function scheduleReconnect() {
  if (!active) return
  setTimeout(() => {
    try {
      getPort()
      retryDelay = 500
    } catch {
      retryDelay = Math.min(retryDelay * 2, 8000)
      if (chrome.runtime?.id) scheduleReconnect()
    }
  }, retryDelay)
}
if (active) {
  try { getPort() } catch { scheduleReconnect() }
}

window.addEventListener('message', (event: MessageEvent) => {
  if (!active) return
  if (event.source !== window) return
  const data = event.data
  if (isV2Envelope(data)) {
    if (data.type === 'call') pendingLookups.set(data.id, { ver: 2, ns: data.ns })
    try {
      getPort().postMessage(data)
    } catch {
      if (data.type === 'call') {
        pendingLookups.delete(data.id)
        toPage({ source: V2_EXT_SOURCE, v: PROTOCOL_V2, ns: data.ns, type: 'result', id: data.id, ok: false, error: V2_ERRORS.internal('확장과 통신할 수 없습니다') })
      }
    }
    return
  }
  if (!isAppEnvelope(data)) return

  if (data.type === 'lookup') pendingLookups.set(data.id, { ver: 1 })
  try {
    getPort().postMessage(data)
  } catch {
    if (data.type === 'lookup') {
      pendingLookups.delete(data.id)
      toPage({ source: BRIDGE_SOURCE, v: PROTOCOL_V, type: 'result', id: data.id, ok: false, error: ERRORS.internal('확장과 통신할 수 없습니다') })
    }
  }
})
