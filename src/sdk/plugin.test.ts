import { describe, expect, it } from 'vitest'
import { canonicalJson, catalogHash, validateCatalog, type AdapterDef, type PluginCatalog } from './plugin'

const adapter = (id: string, extra: Partial<AdapterDef> = {}): AdapterDef => ({
  id, summary: `${id} 요약`, description: `${id} 설명`, params: { type: 'object', properties: { q: { type: 'string' } } }, hosts: ['example.com'], ...extra,
})

const catalog = (adapters: AdapterDef[] = [adapter('a-one')]): PluginCatalog => ({ ops: [], adapters: { 'web.query': adapters } })

describe('canonicalJson / catalogHash', () => {
  it('키 순서가 달라도 같은 해시', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}')
    const x = catalog()
    const y = JSON.parse(JSON.stringify({ adapters: x.adapters, ops: x.ops })) as PluginCatalog
    expect(catalogHash(x)).toBe(catalogHash(y))
  })

  it('설명이 한 글자만 바뀌어도 해시가 바뀐다', () => {
    expect(catalogHash(catalog([adapter('a-one')]))).not.toBe(catalogHash(catalog([adapter('a-one', { summary: 'x' })])))
  })
})

describe('validateCatalog', () => {
  it('정상 카탈로그', () => {
    const r = validateCatalog(catalog([adapter('a-one'), adapter('b-two')]))
    expect(r.ok).toBe(true)
  })

  it('어댑터 id 형식, 중복, hosts 오류', () => {
    expect(validateCatalog(catalog([adapter('Bad_Id')])).ok).toBe(false)
    expect(validateCatalog(catalog([adapter('a-one'), adapter('a-one')])).ok).toBe(false)
    expect(validateCatalog(catalog([adapter('a-one', { hosts: [''] })])).ok).toBe(false)
  })

  it('op 선언: meta. 예약, kind 오류, 중복', () => {
    const op = {
      name: 'demo.run', ver: 1, kind: 'read', summary: 's', description: 'd',
      args: { type: 'object' }, result: { type: 'object' }, errors: [], limits: { timeoutMs: 1000 },
    }
    expect(validateCatalog({ ops: [op], adapters: {} }).ok).toBe(true)
    expect(validateCatalog({ ops: [{ ...op, name: 'meta.describe' }], adapters: {} }).ok).toBe(false)
    expect(validateCatalog({ ops: [{ ...op, kind: 'admin' }], adapters: {} }).ok).toBe(false)
    expect(validateCatalog({ ops: [op, op], adapters: {} }).ok).toBe(false)
  })

  it('32KiB 초과 거부', () => {
    const r = validateCatalog(catalog([adapter('a-one', { notes: 'x'.repeat(40_000) })]))
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('32KiB') })
  })
})
