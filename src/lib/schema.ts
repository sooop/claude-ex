// JSON Schema 부분집합 검증기. 명세 01 3.8, 스킬 abp/bridge.js 의 validateSchema 와 같은 규칙이다.
// 허용 키워드 밖($ref, oneOf, anyOf, allOf, not, pattern)이나 모르는 type 을 만나면 검증을 건너뛰고 skip 을 켠다.

export interface Schema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array'
  properties?: Record<string, Schema>
  additionalProperties?: Schema | boolean
  required?: string[]
  items?: Schema
  enum?: unknown[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  maxItems?: number
  default?: unknown
  description?: string
}

export type SchemaResult = { value: unknown; skip: boolean; err?: undefined } | { err: string }

const BAD_KW = ['$ref', 'oneOf', 'anyOf', 'allOf', 'not', 'pattern']
const BAD_KEY = ['__proto__', 'constructor', 'prototype']
const MAX_DEPTH = 8

type Walk = { value: unknown; err?: undefined } | { err: string }

export function validateSchema(schema: Schema, value: unknown): SchemaResult {
  let skip = false
  const walk = (s: Schema | undefined, v: unknown, path: string, depth: number): Walk => {
    if (depth > MAX_DEPTH || !s || typeof s !== 'object' || BAD_KW.some((k) => k in s)) {
      skip = true
      return { value: v }
    }
    if (Array.isArray(s.enum) && !s.enum.includes(v)) return { err: `${path}: 허용 값이 아닙니다` }
    switch (s.type) {
      case 'string':
        if (typeof v !== 'string') return { err: `${path}: 문자열이어야 합니다` }
        if (s.minLength != null && v.length < s.minLength) return { err: `${path}: 너무 짧습니다` }
        if (s.maxLength != null && v.length > s.maxLength) return { err: `${path}: 너무 깁니다` }
        return { value: v }
      case 'number':
      case 'integer':
        if (typeof v !== 'number' || !Number.isFinite(v) || (s.type === 'integer' && !Number.isInteger(v)))
          return { err: `${path}: ${s.type === 'integer' ? '정수' : '숫자'}여야 합니다` }
        if (s.minimum != null && v < s.minimum) return { err: `${path}: 최솟값 미만입니다` }
        if (s.maximum != null && v > s.maximum) return { err: `${path}: 최댓값 초과입니다` }
        return { value: v }
      case 'boolean':
        return typeof v === 'boolean' ? { value: v } : { err: `${path}: true/false여야 합니다` }
      case 'array': {
        if (!Array.isArray(v)) return { err: `${path}: 배열이어야 합니다` }
        if (s.maxItems != null && v.length > s.maxItems) return { err: `${path}: 항목이 너무 많습니다` }
        const out: unknown[] = []
        for (let i = 0; i < v.length; i++) {
          const r: Walk = s.items ? walk(s.items, v[i], `${path}[${i}]`, depth + 1) : { value: v[i] }
          if (r.err !== undefined) return r
          out.push(r.value)
        }
        return { value: out }
      }
      case 'object': {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return { err: `${path}: 객체여야 합니다` }
        const src = v as Record<string, unknown>
        const out: Record<string, unknown> = {}
        const props = s.properties
        const ap = s.additionalProperties
        for (const k of Object.keys(src)) {
          if (BAD_KEY.includes(k)) return { err: `${path}: 허용되지 않은 필드 ${k}` }
          if (props && Object.prototype.hasOwnProperty.call(props, k)) {
            const r = walk(props[k], src[k], `${path}.${k}`, depth + 1)
            if (r.err !== undefined) return r
            out[k] = r.value
          } else if (ap && typeof ap === 'object') {
            const r = walk(ap, src[k], `${path}.${k}`, depth + 1)
            if (r.err !== undefined) return r
            out[k] = r.value
          } else if (!props || ap === true) out[k] = src[k]
          else return { err: `${path}: 허용되지 않은 필드 ${k}` }
        }
        if (props)
          for (const k of Object.keys(props)) if (!(k in out) && props[k] && 'default' in props[k]) out[k] = props[k].default
        for (const r of s.required ?? []) if (!(r in out)) return { err: `${path}: 필수 필드 ${r}가 없습니다` }
        return { value: out }
      }
      default:
        skip = true
        return { value: v }
    }
  }
  const r = walk(schema, value, '값', 0)
  return r.err !== undefined ? { err: r.err } : { value: r.value, skip }
}
