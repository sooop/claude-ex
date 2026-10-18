import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranslateJob } from '@/lib/messages'
import { createRegistry } from './registry'
import { AppSession } from './session'
import { TranslateHub, type HubDeps } from './translate'

type Msg = Record<string, any>

let t = 1000
function makeSession(hub: TranslateHub) {
  const sent: Msg[] = []
  const s = new AppSession((m) => sent.push(m), {
    registry: createRegistry([]), log: { appendSafe: async () => {} }, extVersion: '0', now: () => ++t,
    uuid: () => crypto.randomUUID(), defaultNs: 'claude-ex-poc', onPeerChange: () => hub.peerChanged(),
  }, 'https://x.frame.claudeusercontent.com', 1)
  hub.add(s)
  const connect = () => s.handle({ source: 'ab-app', v: 2, ns: 'claude-ex-poc', type: 'hello', id: 'h', provides: [{ op: 'text.translate', ver: 1 }] })
  const lastCall = () => sent.filter((m) => m.type === 'call').at(-1)
  const reply = (body: Msg) => s.handle({ source: 'ab-app', v: 2, ns: 'claude-ex-poc', type: 'result', id: lastCall()!.id, ...body })
  return { s, sent, connect, lastCall, reply }
}

function setup(over: Partial<HubDeps> = {}) {
  const jobs: (TranslateJob | null)[] = []
  const deps: HubDeps = {
    now: () => ++t, uuid: () => 'job1', getTier: async () => 'advanced',
    artifactUrl: 'https://claude.ai/artifact/x', appWaitMs: 30_000, timeoutMs: 60_000,
    openTab: vi.fn(async () => {}), onJob: (j) => jobs.push(j), openPopup: vi.fn(async () => {}),
    ...over,
  }
  const hub = new TranslateHub(deps)
  return { hub, deps, jobs, last: () => jobs.at(-1)! }
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

describe('번역 라우팅', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('가장 최근에 연결된 앱으로 tier 를 실어 보내고 결과를 정제한다', async () => {
    const { hub, deps, last } = setup()
    const a = makeSession(hub)
    const b = makeSession(hub)
    a.connect()
    b.connect()
    expect((await hub.start('  안녕하세요  ')).ok).toBe(true)
    await flush()
    expect(a.lastCall()).toBeUndefined()
    expect(b.lastCall()).toMatchObject({ op: 'text.translate', args: { text: '안녕하세요', tier: 'advanced' } })
    b.reply({ ok: true, data: { text: '<b>Hello</b>', tier: 'advanced', modelApplied: 'claude-x' } })
    await flush()
    expect(last()).toMatchObject({ state: 'done', unseen: true, result: { text: 'Hello', tier: 'advanced', modelApplied: 'claude-x' } })
    expect(deps.openTab).not.toHaveBeenCalled()
    expect(deps.openPopup).not.toHaveBeenCalled()
  })

  it('앱이 없으면 탭을 열고, 연결되면 보내고, 결과 뒤 팝업을 연다', async () => {
    const { hub, deps, last } = setup()
    await hub.start('사과')
    await flush()
    expect(deps.openTab).toHaveBeenCalledWith('https://claude.ai/artifact/x')
    expect(last().state).toBe('waiting_app')
    const a = makeSession(hub)
    vi.advanceTimersByTime(5_000)
    a.connect()
    await flush()
    expect(last().state).toBe('running')
    a.reply({ ok: true, data: { text: 'apple' } })
    await flush()
    expect(last()).toMatchObject({ state: 'done', result: { text: 'apple', tier: 'advanced' } })
    expect(deps.openPopup).toHaveBeenCalled()
  })

  it('30초 안에 연결되지 않으면 timeout 오류', async () => {
    const { hub, last } = setup()
    await hub.start('사과')
    await flush()
    vi.advanceTimersByTime(30_000)
    await flush()
    expect(last()).toMatchObject({ state: 'error', error: { code: 'timeout' } })
  })

  it('주소가 없고 앱도 없으면 시작하지 않는다', async () => {
    const { hub } = setup({ artifactUrl: '' })
    expect(await hub.start('사과')).toMatchObject({ ok: false, error: { code: 'not_granted' } })
  })

  it('진행 중이면 busy, 빈 입력·초과 입력은 invalid_request', async () => {
    const { hub } = setup()
    makeSession(hub).connect()
    expect(await hub.start('  ')).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(await hub.start('가'.repeat(2001))).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    await hub.start('가')
    expect(await hub.start('나')).toMatchObject({ ok: false, error: { code: 'busy' } })
  })

  it('앱 결과 스키마가 틀리면 parse_failed', async () => {
    const { hub, last } = setup()
    const a = makeSession(hub)
    a.connect()
    await hub.start('가')
    await flush()
    a.reply({ ok: true, data: { text: 'x', extra: 1 } })
    await flush()
    expect(last()).toMatchObject({ state: 'error', error: { code: 'parse_failed' } })
  })

  it('앱 오류(ai_unavailable)를 그대로 보여 준다', async () => {
    const { hub, last } = setup()
    const a = makeSession(hub)
    a.connect()
    await hub.start('가')
    await flush()
    a.reply({ ok: false, error: { code: 'ai_unavailable', message: 'AI 동의 필요', retryable: false } })
    await flush()
    expect(last()).toMatchObject({ state: 'error', error: { code: 'ai_unavailable', message: 'AI 동의 필요' } })
  })

  it('취소하면 cancelled', async () => {
    const { hub, last } = setup()
    const a = makeSession(hub)
    a.connect()
    await hub.start('가')
    await flush()
    hub.cancel()
    await flush()
    expect(last()).toMatchObject({ state: 'error', error: { code: 'cancelled' } })
    expect(a.sent.some((m) => m.type === 'cancel')).toBe(true)
  })

  it('재시작 복원: 진행 중이던 작업은 중단 처리, markSeen 으로 unseen 해제', () => {
    const { hub, last } = setup()
    hub.restore({ id: 'j', text: 'a', tier: 'quick', state: 'running', startedAt: 1 })
    expect(last()).toMatchObject({ state: 'error', unseen: true, error: { code: 'internal' } })
    hub.markSeen()
    expect(last().unseen).toBe(false)
  })
})
