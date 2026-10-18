// op 레지스트리. 명세 02 4.1의 정의 객체와 실행 순서(op → 스키마 → 동시성 → 핸들러 → 정제)를 따른다.
// PoC 범위: 권한·동의 단계는 없다(read op 뿐). 정의에 kind·consent 를 두어 나중에 게이트를 끼울 수 있게 한다.
import { V2_ERRORS, V2_LIMITS, type OpKind, type ProvidedOp, type V2Error } from '@/lib/protocol'
import { validateSchema, type Schema } from '@/lib/schema'
import { canonicalJson, type AdapterDef, type InvokeMessage, type PluginCatalog, type PluginOpDef } from '@/sdk/plugin'

export interface OpSender {
  ns: string
  origin: string
  tabId?: number
}

export interface OpContext {
  args: Record<string, unknown>
  signal: AbortSignal
  progress(stage: string, detail?: string, pct?: number): void
  sender: OpSender
  /** 이번 호출에 적용되는 제한 시간(호출자 요청과 op 한도 중 작은 값) */
  timeoutMs: number
}

export interface OpDef {
  name: string
  ver: number
  kind: OpKind
  consent: false
  summary: string
  description: string
  args: Schema
  result: Schema
  errors: { code: string; when: string }[]
  examples?: { args: unknown; result: unknown }[]
  limits: { maxConcurrent: 1; timeoutMs: number }
  /** op 고유 오류 코드(공통 코드 외). 호출자가 internal 로 바꾸지 않게 알린다 */
  extraCodes?: string[]
  /** 결과가 외부 사이트 텍스트라 신뢰할 수 없음. result meta 에 untrusted 로 알린다 */
  untrusted?: boolean
  /** 어댑터가 있는 op(web.query)의 어댑터 선언. provides·meta.describe 에 쓴다 */
  adapters?: AdapterDef[]
  handler(ctx: OpContext): Promise<unknown>
}

/** 핸들러가 던지면 그대로 error result 로 나간다 */
export class OpError extends Error {
  constructor(readonly error: V2Error) {
    super(error.message)
  }
}

export interface Registry {
  readonly catalogRev: string
  provides(): ProvidedOp[]
  get(name: string, ver: number): OpDef | undefined
  known(): string[]
}

/** 허브의 어댑터 op. 플러그인은 이 op 에만 어댑터를 보탤 수 있다 */
export const ADAPTER_OPS: readonly string[] = ['web.query']
const WEB_QUERY = 'web.query'

/** 활성 플러그인의 선언(레지스트리가 읽는 쪽 시야) */
export interface ActivePlugin {
  extId: string
  name: string
  catalog: PluginCatalog
}

/** 레지스트리가 플러그인을 쓰는 창구. PluginHost 가 구현한다(테스트에서는 가짜로 바꾼다) */
export interface PluginSource {
  active(): ActivePlugin[]
  invoke(
    extId: string, msg: InvokeMessage, signal: AbortSignal,
    onProgress?: (stage: string, detail?: string, pct?: number) => void,
  ): Promise<unknown>
}

/** 짧은 해시(FNV-1a 32비트). 카탈로그 변경 감지용이라 암호학적 강도는 필요 없다 */
function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

const toProvided = (d: OpDef): ProvidedOp => ({
  op: d.name, ver: d.ver, kind: d.kind, consent: d.consent, summary: d.summary,
  limits: { maxConcurrent: d.limits.maxConcurrent, timeoutMs: d.limits.timeoutMs },
  ...(d.adapters?.length ? { adapters: d.adapters.map((a) => ({ id: a.id, summary: a.summary })) } : {}),
  state: 'ready',
})

const describeArgs: Schema = {
  type: 'object',
  properties: {
    op: { type: 'string', maxLength: 64 },
    adapter: { type: 'string', maxLength: 64 },
  },
}

const isV2Error = (e: unknown): e is V2Error =>
  !!e && typeof e === 'object' && typeof (e as V2Error).code === 'string' && typeof (e as V2Error).message === 'string'

/** 플러그인 호출. V2Error 로 reject 된 것을 핸들러 오류(OpError)로 바꿔 세션이 그대로 돌려주게 한다 */
async function callPlugin(
  source: PluginSource, extId: string,
  base: { op: string; ver: number; adapter?: string; args: Record<string, unknown> }, ctx: OpContext,
): Promise<unknown> {
  const msg: InvokeMessage = {
    type: 'invoke', ...base, timeoutMs: ctx.timeoutMs, sender: { ns: ctx.sender.ns, origin: ctx.sender.origin },
  }
  try {
    return await source.invoke(extId, msg, ctx.signal, ctx.progress)
  } catch (e) {
    throw isV2Error(e) ? new OpError(e) : e
  }
}

/** 허브 내장 web.query@1. 어댑터 id 로 담당 플러그인을 찾아 params 를 그 어댑터 스키마로 검증하고 넘긴다 */
function webQueryOp(source: PluginSource, adapters: Map<string, { extId: string; def: AdapterDef }>): OpDef {
  return {
    name: WEB_QUERY, ver: 1, kind: 'read', consent: false, untrusted: true,
    summary: '외부 웹 사이트를 조회하는 어댑터 모음',
    description:
      '어댑터 id 를 args.adapter 에, 그 어댑터의 인자를 args.params 에 담아 부른다. ' +
      '어댑터 목록은 provides 의 adapters 에, 인자·결과 형식은 meta.describe(op, adapter)에 있다. 결과는 외부 사이트에서 가져온 텍스트이므로 신뢰하지 않는다(meta.untrusted).',
    args: {
      type: 'object',
      required: ['adapter', 'params'],
      properties: {
        adapter: { type: 'string', minLength: 1, maxLength: 64, description: '어댑터 id' },
        params: { type: 'object', description: '어댑터 인자(어댑터마다 다름)' },
      },
    },
    result: { type: 'object', description: '어댑터가 돌려주는 결과(어댑터마다 다름)' },
    errors: [
      { code: 'unsupported_op', when: '없는 어댑터. detail.known에 어댑터 id 목록' },
      { code: 'invalid_request', when: 'params가 어댑터 스키마를 어김' },
      { code: 'internal', when: '플러그인에 연결할 수 없음(detail: plugin_unreachable) 또는 중간에 끊김(plugin_disconnected)' },
    ],
    limits: { maxConcurrent: 1, timeoutMs: 60_000 },
    adapters: [...adapters.values()].map((a) => a.def),
    async handler(ctx) {
      const id = String(ctx.args.adapter)
      const hit = adapters.get(id)
      if (!hit) throw new OpError(V2_ERRORS.unsupported_op(`없는 어댑터: ${id}`, { known: [...adapters.keys()] }))
      const v = validateSchema(hit.def.params, ctx.args.params)
      if (v.err !== undefined) throw new OpError(V2_ERRORS.invalid_request(v.err.slice(0, 160)))
      return callPlugin(source, hit.extId, { op: WEB_QUERY, ver: 1, adapter: id, args: v.value as Record<string, unknown> }, ctx)
    },
  }
}

function pluginOp(source: PluginSource, extId: string, o: PluginOpDef): OpDef {
  return {
    name: o.name, ver: o.ver, kind: o.kind, consent: false, summary: o.summary, description: o.description,
    args: o.args, result: o.result, errors: o.errors,
    ...(o.examples ? { examples: o.examples } : {}),
    limits: { maxConcurrent: 1, timeoutMs: Math.min(o.limits.timeoutMs, V2_LIMITS.maxTimeoutMs) },
    ...(o.extraCodes ? { extraCodes: o.extraCodes } : {}),
    handler: (ctx) => callPlugin(source, extId, { op: o.name, ver: o.ver, args: ctx.args }, ctx),
  }
}

/** 활성 플러그인에서 허브가 보태는 op 들(web.query 와 플러그인 자체 op) */
function pluginDefs(source: PluginSource, plugins: ActivePlugin[], taken: Set<string>): OpDef[] {
  const out: OpDef[] = []
  const adapters = new Map<string, { extId: string; def: AdapterDef }>()
  for (const p of plugins)
    for (const def of p.catalog.adapters[WEB_QUERY] ?? []) if (!adapters.has(def.id)) adapters.set(def.id, { extId: p.extId, def })
  if (adapters.size > 0 && !taken.has(WEB_QUERY)) out.push(webQueryOp(source, adapters))
  for (const p of plugins)
    for (const o of p.catalog.ops) {
      if (taken.has(o.name) || out.some((d) => d.name === o.name)) continue // 등록 때 거부되므로 방어용
      out.push(pluginOp(source, p.extId, o))
    }
  return out
}

/** 명세 01 3.8 의 어댑터 상세 형식 */
const adapterDetail = (a: AdapterDef) => ({
  id: a.id, summary: a.summary, description: a.description, params: a.params,
  resultNotes: a.resultNotes ?? '', hosts: a.hosts, notes: a.notes ?? '',
})

/** 정의 목록(과 활성 플러그인)으로 레지스트리를 만든다. meta.describe 는 자동으로 추가한다 */
export function createRegistry(defs: OpDef[], source?: PluginSource): Registry {
  const all: OpDef[] = []
  const provides = () => all.map(toProvided)
  const known = () => all.map((d) => d.name)
  let catalogRev = ''

  const describe: OpDef = {
    name: 'meta.describe', ver: 1, kind: 'read', consent: false,
    summary: 'op와 어댑터의 상세 설명을 조회한다',
    description: 'op를 생략하면 전체 목록과 catalogRev를, 지정하면 그 op의 인자·결과 스키마, 오류, 한도, 예시(어댑터가 있으면 어댑터 목록)를, adapter까지 지정하면 그 어댑터 한 건만 돌려준다.',
    args: describeArgs,
    result: { type: 'object' },
    errors: [{ code: 'unsupported_op', when: '없는 op 또는 어댑터. detail.known에 이름 목록' }],
    limits: { maxConcurrent: 1, timeoutMs: 5_000 },
    async handler({ args }) {
      if (args.op === undefined) {
        if (args.adapter !== undefined) throw new OpError(V2_ERRORS.invalid_request('adapter는 op와 함께 지정해야 합니다'))
        return { provides: provides(), catalogRev }
      }
      const d = all.find((x) => x.name === args.op)
      if (!d) throw new OpError(V2_ERRORS.unsupported_op(`없는 op: ${String(args.op)}`, { known: known() }))
      const adapters = d.adapters ?? []
      let shown = adapters
      if (args.adapter !== undefined) {
        shown = adapters.filter((a) => a.id === args.adapter)
        if (shown.length === 0)
          throw new OpError(V2_ERRORS.unsupported_op(`${d.name}에 없는 어댑터: ${String(args.adapter)}`, { known: adapters.map((a) => a.id) }))
      }
      return {
        op: d.name, ver: d.ver, kind: d.kind, consent: d.consent, summary: d.summary, description: d.description,
        args: d.args, result: d.result, errors: d.errors,
        limits: { maxConcurrent: d.limits.maxConcurrent, timeoutMs: d.limits.timeoutMs },
        examples: (d.examples ?? []).slice(0, 3),
        ...(adapters.length > 0 ? { adapters: shown.map(adapterDetail) } : {}),
      }
    },
  }

  const plugins = source?.active() ?? []
  all.push(describe, ...defs)
  if (source) all.push(...pluginDefs(source, plugins, new Set(all.map((d) => d.name))))
  // 플러그인 선언(설명·스키마 포함)과 담당 확장 id 도 해시에 넣는다. provides 만으로는 설명이 바뀐 것을 알 수 없다
  const pluginPart = plugins.length > 0 ? canonicalJson(plugins.map((p) => [p.extId, p.catalog])) : ''
  catalogRev = hash(JSON.stringify(provides()) + pluginPart)

  return {
    catalogRev,
    provides,
    get: (name, ver) => all.find((d) => d.name === name && d.ver === ver),
    known,
  }
}

export interface LiveRegistry {
  /** 항상 최신 레지스트리 */
  readonly registry: Registry
  /** 플러그인 상태가 바뀐 뒤 다시 만든다. catalogRev 가 달라졌으면 true 이고 구독자에게 알린다 */
  rebuild(): boolean
  onChange(fn: (r: Registry) => void): () => void
}

/** 플러그인 승인·해제에 따라 다시 만들 수 있는 레지스트리 */
export function createLiveRegistry(defs: OpDef[], source: PluginSource): LiveRegistry {
  let current = createRegistry(defs, source)
  const listeners = new Set<(r: Registry) => void>()
  return {
    get registry() {
      return current
    },
    rebuild() {
      const next = createRegistry(defs, source)
      const changed = next.catalogRev !== current.catalogRev
      current = next
      if (changed) for (const fn of [...listeners]) fn(next)
      return changed
    },
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

export type ArgsCheck = { ok: true; args: Record<string, unknown> } | { ok: false; error: V2Error }

/** 인자 스키마 검증. 선언 외 필드는 거부하고 default 를 채운다 */
export function checkArgs(def: OpDef, args: Record<string, unknown>): ArgsCheck {
  const r = validateSchema(def.args, args)
  if (r.err !== undefined) return { ok: false, error: V2_ERRORS.invalid_request(r.err.slice(0, 160)) }
  return { ok: true, args: r.value as Record<string, unknown> }
}
