export type QueueOutcome<R> =
  | { status: 'ok'; value: R }
  | { status: 'cancelled' }
  | { status: 'timeout' }
  | { status: 'full' }
  | { status: 'error'; error: unknown }

export interface JobContext {
  signal: AbortSignal
  /** 우체국 요청 직전에 호출. 직전 요청과 최소 간격이 나도록 대기한다 */
  throttle(): Promise<void>
}

interface Job<R> {
  id: string
  timeoutMs: number
  run: (ctx: JobContext) => Promise<R>
  controller: AbortController
  resolve: (o: QueueOutcome<R>) => void
  settled: boolean
}

export interface QueueOptions {
  minIntervalMs: number
  maxLength: number
  now?: () => number
  /** 대기·실행 중인 작업 수가 바뀔 때(배지 표시용) */
  onChange?: (length: number) => void
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(t); reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 직렬 처리 큐. 한 번에 한 작업만 실행하고, 중단된 작업의 결과는 더 내보내지 않는다 */
export class RequestQueue {
  private jobs: Job<unknown>[] = []
  private running: Job<unknown> | null = null
  private lastAt = -Infinity
  private readonly now: () => number

  constructor(private opts: QueueOptions) {
    this.now = opts.now ?? Date.now
  }

  private notify() {
    this.opts.onChange?.(this.length)
  }

  get length(): number {
    return this.jobs.length + (this.running ? 1 : 0)
  }

  enqueue<R>(id: string, timeoutMs: number, run: (ctx: JobContext) => Promise<R>): Promise<QueueOutcome<R>> {
    return new Promise((resolve) => {
      if (this.length >= this.opts.maxLength) return resolve({ status: 'full' })
      this.jobs.push({
        id, timeoutMs, run: run as Job<unknown>['run'],
        controller: new AbortController(),
        resolve: resolve as Job<unknown>['resolve'],
        settled: false,
      })
      this.notify()
      void this.pump()
    })
  }

  /** 대기 중이면 제거, 실행 중이면 중단. 해당 id 가 있었으면 true */
  cancel(id: string): boolean {
    const queued = this.jobs.findIndex((j) => j.id === id)
    if (queued >= 0) {
      const [job] = this.jobs.splice(queued, 1)
      this.settle(job, { status: 'cancelled' })
      this.notify()
      return true
    }
    if (this.running?.id === id) {
      this.running.controller.abort('cancelled')
      return true
    }
    return false
  }

  private settle(job: Job<unknown>, outcome: QueueOutcome<unknown>) {
    if (job.settled) return
    job.settled = true
    job.resolve(outcome)
  }

  private async throttle(signal: AbortSignal): Promise<void> {
    const wait = this.lastAt + this.opts.minIntervalMs - this.now()
    if (wait > 0) await sleep(wait, signal)
    this.lastAt = this.now()
  }

  private async pump(): Promise<void> {
    if (this.running) return
    const job = this.jobs.shift()
    if (!job) return
    this.running = job

    const { signal } = job.controller
    const timer = setTimeout(() => job.controller.abort('timeout'), job.timeoutMs)
    try {
      const value = await job.run({ signal, throttle: () => this.throttle(signal) })
      if (signal.aborted) {
        this.settle(job, { status: signal.reason === 'timeout' ? 'timeout' : 'cancelled' })
      } else {
        this.settle(job, { status: 'ok', value })
      }
    } catch (error) {
      if (signal.aborted) {
        this.settle(job, { status: signal.reason === 'timeout' ? 'timeout' : 'cancelled' })
      } else {
        this.settle(job, { status: 'error', error })
      }
    } finally {
      clearTimeout(timer)
      this.running = null
      this.notify()
      void this.pump()
    }
  }
}
