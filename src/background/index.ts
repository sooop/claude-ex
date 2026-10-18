// 서비스 워커 진입점: 포트 연결 → 세션, 팝업 메시지, 번역 작업 상태(저장·배지·팝업 알림)를 잇는다.
import { APP_NS, ARTIFACT_URL, EXT_VERSION, POC } from '@/config'
import type { PluginInfo, PopupEvent, PopupRequest, StatusResponse, TranslateJob } from '@/lib/messages'
import { PORT_NAME, isAllowedAppOrigin } from '@/lib/origin'
import { createCallLog } from './log'
import { calcEval } from './ops/calc'
import { PluginHost, type PluginHostDeps } from './plugins'
import { ADAPTER_OPS, createLiveRegistry } from './registry'
import { AppSession, type SessionDeps } from './session'
import { getTier, isTier, setTier } from './settings'
import { TranslateHub } from './translate'

const JOB_KEY = 'translate.job'

const BASE_OPS = [calcEval]
const BUILTIN_OP_NAMES = ['meta.describe', ...ADAPTER_OPS, ...BASE_OPS.map((d) => d.name)]

const log = createCallLog()
const plugins = new PluginHost({
  storage: chrome.storage.local,
  runtime: chrome.runtime as unknown as PluginHostDeps['runtime'],
  reservedOps: BUILTIN_OP_NAMES,
  adapterOps: ADAPTER_OPS,
})
const live = createLiveRegistry(BASE_OPS, plugins)
const sessions = new Set<AppSession>()
// onMessageExternal 은 최상위에서 동기로 등록한다(서비스 워커가 이 이벤트로 깨어나므로)
plugins.listen()

function broadcast(e: PopupEvent) {
  chrome.runtime.sendMessage(e).catch(() => { /* 열린 팝업이 없음 */ })
}

let lastJob: TranslateJob | null = null

/** 번역 작업 배지가 우선이고, 없으면 승인 대기 건수를 주황색으로 보인다. job 을 생략하면 마지막 작업 기준으로 다시 그린다 */
function badge(job: TranslateJob | null = lastJob) {
  lastJob = job
  const text = job?.unseen && (job.state === 'done' || job.state === 'error') ? '1' : job?.state === 'running' || job?.state === 'waiting_app' ? '…' : ''
  if (text) {
    void chrome.action.setBadgeText({ text })
    void chrome.action.setBadgeBackgroundColor({ color: job?.state === 'error' ? '#c62828' : '#2e7d32' })
    return
  }
  const pending = plugins.pendingCount()
  void chrome.action.setBadgeText({ text: pending > 0 ? String(pending) : '' })
  if (pending > 0) void chrome.action.setBadgeBackgroundColor({ color: '#ef6c00' })
}

const hub = new TranslateHub({
  now: Date.now,
  uuid: () => crypto.randomUUID(),
  getTier,
  artifactUrl: ARTIFACT_URL,
  appWaitMs: POC.appWaitMs,
  timeoutMs: POC.translateTimeoutMs,
  openTab: async (url) => { await chrome.tabs.create({ url, active: true }) },
  onJob(job) {
    void chrome.storage.session.set({ [JOB_KEY]: job })
    badge(job)
    broadcast({ kind: 'jobUpdate', job })
  },
  onStatus: () => broadcast({ kind: 'statusChanged' }),
  async openPopup() {
    // 팝업이 이미 열려 있으면 다시 열지 않는다
    const open = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.POPUP] }).catch(() => [])
    if (open.length === 0) await chrome.action.openPopup()
  },
})

// 서비스 워커가 재시작되면 마지막 작업을 복원한다(진행 중이던 작업은 중단 처리)
const restored = chrome.storage.session.get(JOB_KEY).then((r) => {
  hub.restore((r[JOB_KEY] as TranslateJob | undefined) ?? null)
  badge(hub.current)
}).catch(() => {})

// 저장된 플러그인 상태로 레지스트리를 만든 뒤에야 세션이 hello 한다(재시작 뒤 앱에 낡은 provides 를 보내지 않으려고)
const loaded = Promise.all([restored, plugins.ready]).then(() => {
  live.rebuild()
  badge()
})

plugins.onChange(() => {
  live.rebuild()
  badge()
  broadcast({ kind: 'pluginsChanged' })
})
// catalogRev 가 달라질 때만 열린 앱 프레임에 알린다
live.onChange(() => {
  for (const s of sessions) s.notifyCatalog()
})

const deps: SessionDeps = {
  get registry() {
    return live.registry
  },
  log,
  extVersion: EXT_VERSION,
  now: Date.now,
  uuid: () => crypto.randomUUID(),
  defaultNs: APP_NS,
  onPeerChange: () => hub.peerChanged(),
}

function senderOrigin(sender: chrome.runtime.MessageSender | undefined): string {
  if (!sender || sender.id !== chrome.runtime.id) return ''
  return sender.origin ?? (sender.url ? new URL(sender.url).origin : '')
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return
  const origin = senderOrigin(port.sender)
  if (!isAllowedAppOrigin(origin)) {
    port.disconnect()
    return
  }
  const session = new AppSession((msg) => {
    try { port.postMessage(msg) } catch { /* 포트가 이미 닫힘 */ }
  }, deps, origin, port.sender?.tab?.id)
  hub.add(session)
  sessions.add(session)
  // 플러그인 상태 로딩이 끝나기 전의 메시지는 기다렸다가 순서대로 처리한다
  port.onMessage.addListener((msg) => void loaded.then(() => session.handle(msg)))
  port.onDisconnect.addListener(() => {
    session.dispose()
    hub.remove(session)
    sessions.delete(session)
  })
  // 확장도 먼저 hello 한다(로드 순서 무관, 서비스 워커 재시작 뒤 앱의 provides 를 다시 받기 위해)
  void loaded.then(() => session.hello())
})

chrome.runtime.onMessage.addListener((req: PopupRequest, sender, sendResponse) => {
  // 팝업(확장 자신의 페이지)에서 온 메시지만 받는다. 콘텐츠 스크립트는 포트만 쓴다
  if (sender.id !== chrome.runtime.id || sender.tab) return
  void (async () => {
    await loaded
    switch (req?.kind) {
      case 'status': {
        const latest = hub.latest()
        const res: StatusResponse = {
          tier: await getTier(),
          translators: hub.translators().length,
          latest: hub.info(latest),
          sessions: hub.sessionCount,
          job: hub.current,
        }
        if (latest?.tabId !== undefined && res.latest) {
          const tab = await chrome.tabs.get(latest.tabId).catch(() => undefined)
          if (tab?.title) res.latest.title = tab.title.slice(0, 80)
        }
        return sendResponse(res)
      }
      case 'setTier':
        if (!isTier(req.tier)) return sendResponse({ ok: false })
        await setTier(req.tier)
        return sendResponse({ ok: true })
      case 'translate':
        return sendResponse(await hub.start(req.text))
      case 'cancelJob':
        hub.cancel()
        return sendResponse({ ok: true })
      case 'seenJob':
        hub.markSeen()
        return sendResponse({ ok: true })
      case 'plugins':
        return sendResponse(plugins.list() satisfies PluginInfo[])
      case 'approvePlugin':
        return sendResponse({ ok: typeof req.extId === 'string' && typeof req.hash === 'string' && (await plugins.approve(req.extId, req.hash)) })
      case 'denyPlugin':
        return sendResponse({ ok: typeof req.extId === 'string' && typeof req.hash === 'string' && (await plugins.deny(req.extId, req.hash)) })
      case 'removePlugin':
        return sendResponse({ ok: typeof req.extId === 'string' && (await plugins.remove(req.extId)) })
      default:
        return sendResponse({ ok: false })
    }
  })()
  return true
})
