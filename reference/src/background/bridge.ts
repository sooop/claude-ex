import { LIMITS, PORT_NAME, isAllowedAppOrigin } from '@/lib/protocol'
import { setQueued } from './badge'
import { DecideClient } from './decide'
import { fetchers } from './fetchers'
import { RequestQueue } from './queue'
import { BridgeSession, type SessionDeps } from './session'

const queue = new RequestQueue({ minIntervalMs: LIMITS.minIntervalMs, maxLength: LIMITS.maxQueue, onChange: setQueued })

export const decideClient = new DecideClient({
  uuid: () => crypto.randomUUID(),
  openTab: async (url) => (await chrome.tabs.create({ url, active: false })).id,
  closeTab: (id) => chrome.tabs.remove(id),
  activateTab: async (id) => { await chrome.tabs.update(id, { active: true }) },
})

const deps: SessionDeps = {
  queue,
  decide: decideClient,
  extVersion: chrome.runtime.getManifest().version,
  fetchPage: (keyword, pageIdx, pageSize, source, signal) => fetchers[source](keyword, pageIdx, pageSize, signal),
  now: Date.now,
}

function isAllowedSender(sender: chrome.runtime.MessageSender | undefined): boolean {
  if (!sender || sender.id !== chrome.runtime.id) return false
  const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : '')
  return isAllowedAppOrigin(origin)
}

export function initBridge(): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return
    if (!isAllowedSender(port.sender)) {
      port.disconnect()
      return
    }

    const session = new BridgeSession((msg) => {
      try { port.postMessage(msg) } catch { /* 포트가 이미 닫힘 */ }
    }, deps, port.sender?.tab?.id)

    port.onMessage.addListener((msg) => session.handle(msg))
    port.onDisconnect.addListener(() => session.dispose())
    // 앱 프레임이 연결되면 바로 판정 준비 상태를 묻는다(앱의 최초 ready 를 놓쳐도, 서비스 워커가 재시작돼도 다시 찾는다)
    decideClient.greet(session)
    // v2: 확장도 먼저 hello 를 보낸다(앱이 v1 만 알면 source 가 달라 무시한다)
    session.hello()
  })
}
