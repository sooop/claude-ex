// 허브(claude-ex) ↔ 플러그인 확장 사이의 계약(플러그인 채널). 아티팩트와 주고받는 v2 봉투와는 별개다.
// 계획: docs/plans/2026-10-18-plugin-hub.md. 이 폴더는 chrome·프레임워크·`@/` 별칭에 의존하지 않는다.
import type { V2Error } from './errors'
import type { Schema } from './schema'

export const SDK_VERSION = 1

export const CHANNEL = {
  /** 플러그인 → 허브 runtime.sendMessage 의 kind */
  register: 'abp-plugin/register',
  /** 허브 → 플러그인 호출 1건마다 여는 포트 이름 */
  callPort: 'abp-plugin/call',
} as const

export const PLUGIN_LIMITS = {
  maxCatalogBytes: 32 * 1024,
  maxOps: 16,
  maxAdapters: 32,
  maxDescription: 2000,
  maxSummary: 80,
} as const

export const OP_RE = /^[a-z]+\.[a-z_]+$/
export const ADAPTER_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

export type OpKind = 'read' | 'write' | 'sensitive'

/** 어댑터 선언. 명세 01 3.8 의 meta.describe 어댑터 상세와 같은 형식 */
export interface AdapterDef {
  id: string
  summary: string
  description: string
  params: Schema
  resultNotes?: string
  hosts: string[]
  notes?: string
}

/** 플러그인이 직접 제공하는 op 선언(허브 OpDef 에서 handler 를 뺀 것) */
export interface PluginOpDef {
  name: string
  ver: number
  kind: OpKind
  summary: string
  description: string
  args: Schema
  result: Schema
  errors: { code: string; when: string }[]
  examples?: { args: unknown; result: unknown }[]
  limits: { timeoutMs: number }
  /** op 고유 오류 코드(공통 코드 외) */
  extraCodes?: string[]
}

/** 플러그인이 등록하는 능력 목록. 함수 없이 직렬화 가능한 선언만 담는다 */
export interface PluginCatalog {
  ops: PluginOpDef[]
  /** 허브 op 이름(예: web.query) → 그 op 에 보태는 어댑터 */
  adapters: Record<string, AdapterDef[]>
}

export interface RegisterMessage {
  kind: typeof CHANNEL.register
  sdk: number
  name: string
  version: string
  catalog: PluginCatalog
}

export type RegisterStatus = 'active' | 'pending' | 'rejected'
export interface RegisterResponse {
  status: RegisterStatus
  reason?: string
}

export interface CallSender {
  ns: string
  origin: string
}

/** 허브 → 플러그인. adapter 가 있으면 args 는 어댑터 params(허브가 검증함), 없으면 op 인자 */
export interface InvokeMessage {
  type: 'invoke'
  op: string
  ver: number
  adapter?: string
  args: Record<string, unknown>
  timeoutMs: number
  sender: CallSender
}

export type HubToPlugin = InvokeMessage | { type: 'cancel' }

export type PluginToHub =
  | { type: 'progress'; stage: string; detail?: string; pct?: number }
  | { type: 'result'; ok: true; data: unknown }
  | { type: 'result'; ok: false; error: V2Error }

// ── 해시 ─────────────────────────────────────────────────────────────────────

/** 키를 정렬한 JSON. 같은 내용이면 필드 순서와 무관하게 같은 문자열이 된다 */
export function canonicalJson(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(',')}]`
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
  }
  return JSON.stringify(x) ?? 'null'
}

function fnv1a(s: string, seed: number): string {
  let h = seed
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** 카탈로그 변경 감지용 해시(64비트 상당). 승인 비교에만 쓰며 암호학적 강도는 필요 없다 */
export function catalogHash(c: PluginCatalog): string {
  const s = canonicalJson(c)
  return fnv1a(s, 0x811c9dc5) + fnv1a(s, 0x01234567)
}

// ── 검증 ─────────────────────────────────────────────────────────────────────

export type CatalogCheck = { ok: true; catalog: PluginCatalog } | { ok: false; reason: string }

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const isStr = (x: unknown, max: number, min = 1): x is string => typeof x === 'string' && x.length >= min && x.length <= max

function checkOp(o: unknown): string | undefined {
  if (!isObj(o)) return 'op 선언이 객체가 아닙니다'
  if (typeof o.name !== 'string' || !OP_RE.test(o.name) || o.name.startsWith('meta.')) return `op 이름 오류: ${String(o.name)}`
  if (typeof o.ver !== 'number' || !Number.isInteger(o.ver) || o.ver < 1) return `${o.name}: ver 오류`
  if (o.kind !== 'read' && o.kind !== 'write' && o.kind !== 'sensitive') return `${o.name}: kind 오류`
  if (!isStr(o.summary, PLUGIN_LIMITS.maxSummary)) return `${o.name}: summary 오류`
  if (!isStr(o.description, PLUGIN_LIMITS.maxDescription)) return `${o.name}: description 오류`
  if (!isObj(o.args) || !isObj(o.result)) return `${o.name}: args/result 스키마 오류`
  if (!Array.isArray(o.errors)) return `${o.name}: errors 오류`
  if (!isObj(o.limits) || typeof o.limits.timeoutMs !== 'number' || o.limits.timeoutMs <= 0) return `${o.name}: limits 오류`
  return undefined
}

function checkAdapter(a: unknown): string | undefined {
  if (!isObj(a)) return '어댑터 선언이 객체가 아닙니다'
  if (typeof a.id !== 'string' || !ADAPTER_RE.test(a.id)) return `어댑터 id 오류: ${String(a.id)}`
  if (!isStr(a.summary, PLUGIN_LIMITS.maxSummary)) return `${a.id}: summary 오류`
  if (!isStr(a.description, PLUGIN_LIMITS.maxDescription)) return `${a.id}: description 오류`
  if (!isObj(a.params)) return `${a.id}: params 스키마 오류`
  if (!Array.isArray(a.hosts) || !a.hosts.every((h) => isStr(h, 253))) return `${a.id}: hosts 오류`
  return undefined
}

/** 등록 메시지의 카탈로그 형식을 검사한다. 어떤 op 에 어댑터를 보탤 수 있는지는 허브가 따로 본다 */
export function validateCatalog(raw: unknown): CatalogCheck {
  if (!isObj(raw)) return { ok: false, reason: '카탈로그가 객체가 아닙니다' }
  if (canonicalJson(raw).length > PLUGIN_LIMITS.maxCatalogBytes) return { ok: false, reason: '카탈로그가 32KiB를 넘습니다' }
  const ops = raw.ops ?? []
  const adapters = raw.adapters ?? {}
  if (!Array.isArray(ops) || ops.length > PLUGIN_LIMITS.maxOps) return { ok: false, reason: 'ops 오류' }
  if (!isObj(adapters)) return { ok: false, reason: 'adapters 오류' }

  const seenOps = new Set<string>()
  for (const o of ops) {
    const e = checkOp(o)
    if (e) return { ok: false, reason: e }
    const key = `${(o as PluginOpDef).name}@${(o as PluginOpDef).ver}`
    if (seenOps.has(key)) return { ok: false, reason: `중복 op: ${key}` }
    seenOps.add(key)
  }

  const seenAdapters = new Set<string>()
  let count = 0
  for (const [op, list] of Object.entries(adapters)) {
    if (!OP_RE.test(op)) return { ok: false, reason: `어댑터 대상 op 이름 오류: ${op}` }
    if (!Array.isArray(list)) return { ok: false, reason: `${op}: 어댑터 목록 오류` }
    for (const a of list) {
      const e = checkAdapter(a)
      if (e) return { ok: false, reason: e }
      const key = `${op}/${(a as AdapterDef).id}`
      if (seenAdapters.has(key)) return { ok: false, reason: `중복 어댑터: ${key}` }
      seenAdapters.add(key)
      if (++count > PLUGIN_LIMITS.maxAdapters) return { ok: false, reason: '어댑터가 너무 많습니다' }
    }
  }
  return { ok: true, catalog: { ops: ops as PluginOpDef[], adapters: adapters as Record<string, AdapterDef[]> } }
}
