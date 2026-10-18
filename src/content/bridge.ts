// 앱 프레임(window.postMessage) ↔ 확장 service worker 중계. 메시지 내용은 해석하거나 저장하지 않는다.
// reference/src/content/bridge.ts 에서 v1 분기를 걷어내고, 확장 → 앱 호출의 응답(result·progress·hello_ack)도 중계하게 했다.
import { PROTOCOL_V2, V2_ERRORS, V2_EXT_SOURCE, isV2Envelope } from '@/lib/protocol'
import { PORT_NAME, hasAllowedParent, isAllowedAppOrigin } from '@/lib/origin'

// 알려진 origin 이면 그 origin 으로만 응답한다. 불투명 origin 이면 '*' 로 대체한다.
const targetOrigin = location.origin === 'null' ? '*' : location.origin

let port: chrome.runtime.Port | null = null
/** 앱 → 확장 진행 중 call id → ns. 연결이 끊기면 오류 result 를 돌려준다 */
const pendingCalls = new Map<string, string>()

function toPage(msg: unknown) {
  window.postMessage(msg, targetOrigin)
}

function failCall(id: string, ns: string, message: string, detail?: string) {
  toPage({ source: V2_EXT_SOURCE, v: PROTOCOL_V2, ns, type: 'result', id, ok: false,
    error: { ...V2_ERRORS.internal(message, detail), retryable: true } })
}

function getPort(): chrome.runtime.Port {
  if (port) return port
  const p = chrome.runtime.connect({ name: PORT_NAME })

  p.onMessage.addListener((msg: { source?: string; type?: string; id?: string }) => {
    if (msg?.source !== V2_EXT_SOURCE) return
    if (msg.type === 'result' && typeof msg.id === 'string') pendingCalls.delete(msg.id)
    toPage(msg)
  })

  p.onDisconnect.addListener(() => {
    port = null
    scheduleReconnect()
    // service worker 가 끊기면 진행 중이던 호출은 내부 오류로 알린다
    for (const [id, ns] of pendingCalls) failCall(id, ns, '확장 연결이 끊겼습니다', 'worker_restarted')
    pendingCalls.clear()
  })

  port = p
  return p
}

// manifest 매치와 별개로, 앱 프레임 origin 이고 claude.ai 안에 임베드된 경우에만 동작한다
const active = isAllowedAppOrigin(location.origin) && hasAllowedParent(Array.from(location.ancestorOrigins ?? []))

/**
 * 포트를 앱의 첫 메시지를 기다리지 않고 미리 연결해 둔다. 확장이 앱에 번역을 요청하려면 연결이 있어야 한다.
 * 서비스 워커가 재시작돼 포트가 끊기면 다시 연결한다(확장이 갱신·제거돼 컨텍스트가 무효화되면 중단).
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
  if (!isV2Envelope(data)) return
  if (data.type === 'call') pendingCalls.set(data.id, data.ns)
  try {
    getPort().postMessage(data)
  } catch {
    if (data.type === 'call') {
      pendingCalls.delete(data.id)
      failCall(data.id, data.ns, '확장과 통신할 수 없습니다')
    }
  }
})
