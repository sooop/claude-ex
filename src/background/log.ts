// 앱 → 확장 호출 로그를 IndexedDB 에 쌓는 모듈.
// 확장 서비스 워커에서 실행되며 외부 라이브러리 없이 원시 IndexedDB API 만 쓴다.
import { POC } from '../config'

export interface CallLogEntry {
  id?: number // autoIncrement 키
  ts: number // 요청 수신 시각(ms)
  endTs: number // 응답 전송 시각
  elapsedMs: number
  ns: string
  origin: string // 앱 프레임 origin
  op: string
  ver: number
  args: unknown // 요청 본문(잘린 경우 문자열)
  ok: boolean
  data?: unknown // 성공 시 결과(잘린 경우 문자열)
  error?: { code: string; message: string }
  truncated?: boolean // args나 data를 잘랐으면 true
}

export interface CallLogOptions {
  dbName?: string
  maxBodyBytes?: number
  maxEntries?: number
  indexedDB?: IDBFactory
}

const DB_VERSION = 1
const STORE = 'calls'
const INDEX_TS = 'ts'
const SUFFIX = '…[truncated]'
const UNSERIALIZABLE = '[unserializable]'

const encoder = new TextEncoder()

/** 코드 포인트 하나를 UTF-8 로 인코딩했을 때의 바이트 수 */
function utf8Len(cp: number): number {
  if (cp < 0x80) return 1
  if (cp < 0x800) return 2
  if (cp < 0x10000) return 3
  return 4
}

/**
 * 본문을 JSON 직렬화 기준 UTF-8 바이트 한도 안에 맞춘다.
 * 한도 이하이면 원래 값을 JSON 왕복한 값(복제 가능한 값)을 그대로 돌려준다.
 * 초과하면 직렬화 문자열을 코드 포인트 단위로 자르고 접미사를 붙인다(멀티바이트 문자가 깨지지 않게).
 */
function clipBody(value: unknown, maxBytes: number): { value: unknown; truncated: boolean } {
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    // 순환 참조 등 직렬화 불가
    return { value: UNSERIALIZABLE, truncated: false }
  }
  if (json === undefined) return { value: undefined, truncated: false }
  if (encoder.encode(json).length <= maxBytes) {
    return { value: JSON.parse(json) as unknown, truncated: false }
  }
  // 접미사까지 한도 안에 들어갈 때만 붙인다
  const suffix = maxBytes >= encoder.encode(SUFFIX).length ? SUFFIX : ''
  const budget = maxBytes - encoder.encode(suffix).length
  let out = ''
  let used = 0
  for (const ch of json) {
    const n = utf8Len(ch.codePointAt(0) ?? 0)
    if (used + n > budget) break
    out += ch
    used += n
  }
  return { value: out + suffix, truncated: true }
}

/** IDBRequest 를 Promise 로 감싼다 */
function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** 트랜잭션이 커밋되거나 중단될 때까지 기다린다 */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 트랜잭션이 중단됨'))
  })
}

export function createCallLog(opts: CallLogOptions = {}): {
  append(e: Omit<CallLogEntry, 'id' | 'truncated'>): Promise<void>
  appendSafe(e: Omit<CallLogEntry, 'id' | 'truncated'>): Promise<void>
  list(limit?: number): Promise<CallLogEntry[]>
  count(): Promise<number>
  clear(): Promise<void>
} {
  const dbName = opts.dbName ?? 'claude-ex'
  const maxBodyBytes = opts.maxBodyBytes ?? POC.logBodyMaxBytes
  const maxEntries = opts.maxEntries ?? POC.logMaxEntries

  // 지연 열기: 첫 호출 때 연결을 만들고 이후 재사용한다. 실패하면 다음 호출에서 다시 연다.
  let dbPromise: Promise<IDBDatabase> | null = null

  function openDb(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const factory = opts.indexedDB ?? globalThis.indexedDB
      if (!factory) throw new Error('IndexedDB 를 사용할 수 없다')
      const req = factory.open(dbName, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true })
        store.createIndex(INDEX_TS, 'ts')
      }
      req.onsuccess = () => {
        const db = req.result
        // 다른 곳에서 버전 변경을 하려 하면 연결을 닫고 다음 호출에서 다시 연다
        db.onversionchange = () => {
          db.close()
          dbPromise = null
        }
        resolve(db)
      }
      req.onerror = () => reject(req.error)
    })
  }

  function getDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise
    const p = openDb()
    dbPromise = p
    p.catch(() => {
      if (dbPromise === p) dbPromise = null
    })
    return p
  }

  async function append(e: Omit<CallLogEntry, 'id' | 'truncated'>): Promise<void> {
    const db = await getDb()
    // id 는 넣지 않아 autoIncrement 에 맡긴다. truncated 는 아래에서 계산한다.
    const args = clipBody(e.args, maxBodyBytes)
    const hasData = e.data !== undefined
    const data = hasData ? clipBody(e.data, maxBodyBytes) : undefined
    const record: CallLogEntry = {
      ts: e.ts,
      endTs: e.endTs,
      elapsedMs: e.elapsedMs,
      ns: e.ns,
      origin: e.origin,
      op: e.op,
      ver: e.ver,
      args: args.value,
      ok: e.ok,
      truncated: args.truncated || (data?.truncated ?? false),
    }
    if (data) record.data = data.value
    if (e.error) record.error = { code: e.error.code, message: e.error.message }

    const tx = db.transaction(STORE, 'readwrite')
    const done = txDone(tx)
    const store = tx.objectStore(STORE)
    store.add(record)
    // 같은 트랜잭션 안에서 건수를 세고 초과분을 가장 오래된 것부터(id 오름차순) 지운다.
    // 요청은 순서대로 실행되므로 방금 넣은 건도 건수에 포함된다.
    const countReq = store.count()
    countReq.onsuccess = () => {
      let excess = countReq.result - maxEntries
      if (excess <= 0) return
      const cursorReq = store.openCursor()
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (!cursor || excess <= 0) return
        cursor.delete()
        excess--
        cursor.continue()
      }
    }
    await done
  }

  async function appendSafe(e: Omit<CallLogEntry, 'id' | 'truncated'>): Promise<void> {
    try {
      await append(e)
    } catch (err) {
      // 로그 실패가 RPC 응답을 막지 않도록 삼킨다
      console.warn('[call-log] 로그 기록 실패', err)
    }
  }

  async function list(limit = 100): Promise<CallLogEntry[]> {
    if (limit <= 0) return []
    const db = await getDb()
    const tx = db.transaction(STORE, 'readonly')
    const done = txDone(tx)
    const out: CallLogEntry[] = []
    // ts 인덱스를 역방향으로 읽으면 ts 내림차순, 같은 ts 안에서는 id 내림차순이다
    const cursorReq = tx.objectStore(STORE).index(INDEX_TS).openCursor(null, 'prev')
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (!cursor || out.length >= limit) return
      out.push(cursor.value as CallLogEntry)
      cursor.continue()
    }
    await done
    return out
  }

  async function count(): Promise<number> {
    const db = await getDb()
    const tx = db.transaction(STORE, 'readonly')
    return request(tx.objectStore(STORE).count())
  }

  async function clear(): Promise<void> {
    const db = await getDb()
    const tx = db.transaction(STORE, 'readwrite')
    const done = txDone(tx)
    tx.objectStore(STORE).clear()
    await done
  }

  return { append, appendSafe, list, count, clear }
}
