import { IDBFactory } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCallLog, type CallLogEntry } from './log'

type NewEntry = Omit<CallLogEntry, 'id' | 'truncated'>

function makeEntry(over: Partial<NewEntry> = {}): NewEntry {
  return {
    ts: 1000,
    endTs: 1010,
    elapsedMs: 10,
    ns: 'claude-ex-poc',
    origin: 'https://app.example',
    op: 'text.translate',
    ver: 1,
    args: { text: 'hello' },
    ok: true,
    data: { text: '안녕' },
    ...over,
  }
}

/** 테스트마다 새 IndexedDB 팩토리를 주입해 상태를 격리한다 */
function newLog(extra: { maxEntries?: number; maxBodyBytes?: number } = {}) {
  return createCallLog({ indexedDB: new IDBFactory(), ...extra })
}

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createCallLog', () => {
  it('저장한 항목을 최신순(ts 내림차순, 같으면 id 내림차순)으로 조회한다', async () => {
    const log = newLog()
    await log.append(makeEntry({ op: 'a', ts: 100 }))
    await log.append(makeEntry({ op: 'b', ts: 300 }))
    await log.append(makeEntry({ op: 'c', ts: 200 }))
    await log.append(makeEntry({ op: 'd', ts: 300 }))

    const rows = await log.list()
    expect(rows.map((r) => r.op)).toEqual(['d', 'b', 'c', 'a'])
    expect(rows[0].id).toBeTypeOf('number')
    expect(rows[0].id!).toBeGreaterThan(rows[1].id!)
    expect(rows[0].args).toEqual({ text: 'hello' })
    expect(rows[0].data).toEqual({ text: '안녕' })
    expect(rows[0].truncated).toBe(false)
    expect(await log.count()).toBe(4)

    expect((await log.list(2)).map((r) => r.op)).toEqual(['d', 'b'])
  })

  it('8KiB 를 넘는 args 는 잘리고 저장 크기가 한도 이하이며 멀티바이트가 깨지지 않는다', async () => {
    const log = newLog()
    const big = { text: '가나다라마'.repeat(1000) } // 약 15KB 의 UTF-8
    expect(utf8Bytes(JSON.stringify(big))).toBeGreaterThan(8192)

    await log.append(makeEntry({ args: big }))
    const [row] = await log.list(1)

    expect(row.truncated).toBe(true)
    expect(typeof row.args).toBe('string')
    const stored = row.args as string
    expect(stored.endsWith('…[truncated]')).toBe(true)
    expect(utf8Bytes(stored)).toBeLessThanOrEqual(8192)
    expect(stored).not.toContain('�')
    // 잘린 앞부분은 원래 직렬화의 접두사여야 한다
    const prefix = stored.slice(0, -'…[truncated]'.length)
    expect(JSON.stringify(big).startsWith(prefix)).toBe(true)
  })

  it('data 가 잘리면 truncated 가 true 이고 data 만 문자열이 된다', async () => {
    const log = newLog()
    await log.append(makeEntry({ args: { small: 1 }, data: { blob: 'x'.repeat(9000) } }))
    const [row] = await log.list(1)
    expect(row.truncated).toBe(true)
    expect(row.args).toEqual({ small: 1 })
    expect(typeof row.data).toBe('string')
    expect(utf8Bytes(row.data as string)).toBeLessThanOrEqual(8192)
  })

  it('순환 참조 본문은 [unserializable] 로 저장한다', async () => {
    const log = newLog()
    const cyc: Record<string, unknown> = {}
    cyc.self = cyc
    await log.append(makeEntry({ args: cyc }))
    const [row] = await log.list(1)
    expect(row.args).toBe('[unserializable]')
    expect(row.truncated).toBe(false)
  })

  it('maxEntries=5 에 7건을 넣으면 5건만 남고 가장 오래된 2건이 삭제된다', async () => {
    const log = newLog({ maxEntries: 5 })
    for (let i = 1; i <= 7; i++) {
      await log.append(makeEntry({ op: `op${i}`, ts: i }))
    }
    expect(await log.count()).toBe(5)
    const ops = (await log.list(100)).map((r) => r.op).sort()
    expect(ops).toEqual(['op3', 'op4', 'op5', 'op6', 'op7'])
  })

  it('clear 는 모든 항목을 지운다', async () => {
    const log = newLog()
    await log.append(makeEntry())
    await log.append(makeEntry())
    expect(await log.count()).toBe(2)
    await log.clear()
    expect(await log.count()).toBe(0)
    expect(await log.list()).toEqual([])
  })

  it('error 필드를 그대로 저장한다', async () => {
    const log = newLog()
    await log.append(
      makeEntry({
        ok: false,
        data: undefined,
        error: { code: 'E_TIMEOUT', message: '응답 시간 초과' },
      }),
    )
    const [row] = await log.list(1)
    expect(row.ok).toBe(false)
    expect(row.error).toEqual({ code: 'E_TIMEOUT', message: '응답 시간 초과' })
    expect(row.data).toBeUndefined()
  })

  it('appendSafe 는 저장소 실패를 던지지 않고 console.warn 으로 남긴다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = createCallLog({
      indexedDB: {
        open() {
          throw new Error('denied')
        },
      } as unknown as IDBFactory,
    })
    await expect(broken.appendSafe(makeEntry())).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('appendSafe 정상 경로에서도 저장된다', async () => {
    const log = newLog()
    await log.appendSafe(makeEntry({ op: 'safe' }))
    expect((await log.list()).map((r) => r.op)).toEqual(['safe'])
  })
})
