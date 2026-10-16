import { describe, expect, it } from 'vitest'
import { RequestQueue } from './queue'

describe('RequestQueue onChange', () => {
  it('작업이 들어오고 끝날 때 대기·실행 건수를 알린다', async () => {
    const seen: number[] = []
    const q = new RequestQueue({ minIntervalMs: 0, maxLength: 5, onChange: (n) => seen.push(n) })
    const out = await q.enqueue('a', 1000, async () => 1)
    expect(out).toEqual({ status: 'ok', value: 1 })
    expect(seen[0]).toBe(1)
    expect(seen[seen.length - 1]).toBe(0)
  })

  it('대기 중 작업을 취소해도 건수를 알린다', async () => {
    const seen: number[] = []
    const q = new RequestQueue({ minIntervalMs: 0, maxLength: 5, onChange: (n) => seen.push(n) })
    let release!: () => void
    const first = q.enqueue('a', 1000, () => new Promise<void>((r) => { release = r }))
    const second = q.enqueue('b', 1000, async () => 2)
    expect(q.cancel('b')).toBe(true)
    expect(await second).toEqual({ status: 'cancelled' })
    release()
    await first
    expect(Math.max(...seen)).toBe(2)
    expect(seen[seen.length - 1]).toBe(0)
  })
})
