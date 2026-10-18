<script lang="ts">
  import { onMount } from 'svelte'
  import {
    TIERS,
    TIER_LABEL,
    TRANSLATE_MAX_CHARS,
    type StatusResponse,
    type Tier,
    type TranslateJob,
    type TranslateResponse,
  } from '../lib/messages'
  import { onEvent, send } from './client'

  let status = $state<StatusResponse | null>(null)
  let job = $state<TranslateJob | null>(null)
  let text = $state('')
  let formError = $state('')
  let copied = $state(false)

  const busy = $derived(job?.state === 'waiting_app' || job?.state === 'running')
  const canTranslate = $derived(text.trim().length > 0 && !busy)
  const elapsed = $derived(
    job?.finishedAt !== undefined ? Math.max(0, Math.round((job.finishedAt - job.startedAt) / 1000)) : null,
  )

  // 작업이 끝났고 아직 안 본 상태면 확인 처리를 알린다.
  function markSeen(j: TranslateJob | null) {
    if (j && (j.state === 'done' || j.state === 'error') && j.unseen) {
      send({ kind: 'seenJob' }).catch(() => {})
    }
  }

  function msg(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
  }

  async function refresh() {
    try {
      const s = await send<StatusResponse>({ kind: 'status' })
      status = s
      job = s.job
      markSeen(s.job)
    } catch (e) {
      formError = msg(e)
    }
  }

  onMount(() => {
    refresh()
    return onEvent((e) => {
      if (e.kind === 'jobUpdate') {
        job = e.job
        markSeen(e.job)
      } else {
        refresh()
      }
    })
  })

  async function pickTier(tier: Tier) {
    if (status) status = { ...status, tier }
    try {
      await send({ kind: 'setTier', tier })
    } catch (e) {
      formError = msg(e)
      refresh()
    }
  }

  async function translate() {
    formError = ''
    try {
      const res = await send<TranslateResponse>({ kind: 'translate', text })
      if (!res.ok) formError = `${res.error.message} (${res.error.code})`
    } catch (e) {
      formError = msg(e)
    }
  }

  async function cancel() {
    try {
      await send({ kind: 'cancelJob' })
    } catch (e) {
      formError = msg(e)
    }
  }

  async function copy() {
    if (job?.result === undefined) return
    try {
      await navigator.clipboard.writeText(job.result.text)
      copied = true
      setTimeout(() => (copied = false), 1500)
    } catch {
      formError = '복사에 실패했습니다'
    }
  }
</script>

<main>
  <header>
    <h1>claude-ex</h1>
    <p class="conn" class:on={(status?.translators ?? 0) > 0}>
      {#if status === null}
        상태 확인 중…
      {:else if status.translators > 0}
        번역 앱 연결됨 ({status.translators}){status.latest ? ` · ${status.latest.title || status.latest.ns}` : ''}
      {:else}
        번역 앱 없음 — 번역 시 새 탭을 엽니다
      {/if}
    </p>
  </header>

  <section>
    <h2>AI 품질 설정</h2>
    <div class="seg" role="group" aria-label="AI 품질">
      {#each TIERS as t (t)}
        <button type="button" class:active={status?.tier === t} aria-pressed={status?.tier === t} onclick={() => pickTier(t)}>
          {TIER_LABEL[t]}
        </button>
      {/each}
    </div>
    <p class="hint">모든 AI 요청에 공통 적용</p>
  </section>

  <section>
    <h2>번역</h2>
    <textarea
      bind:value={text}
      maxlength={TRANSLATE_MAX_CHARS}
      rows="5"
      placeholder="번역할 한국어를 입력하세요"
    ></textarea>
    <div class="row">
      <span class="hint">{text.length} / {TRANSLATE_MAX_CHARS}</span>
      <span class="actions">
        {#if busy}
          <button type="button" class="ghost" onclick={cancel}>취소</button>
        {/if}
        <button type="button" class="primary" disabled={!canTranslate} onclick={translate}>영어로 번역</button>
      </span>
    </div>
    {#if formError}
      <p class="err">{formError}</p>
    {/if}
  </section>

  {#if job}
    <section class="result" aria-live="polite">
      {#if job.state === 'waiting_app'}
        <p>번역 앱 탭을 여는 중… 연결을 기다립니다(최대 30초)</p>
      {:else if job.state === 'running'}
        <p>번역 중…{job.stage ? ` ${job.stage}` : ''}</p>
      {:else if job.state === 'done' && job.result}
        <div class="row">
          <h2>번역 결과</h2>
          <button type="button" class="ghost" onclick={copy}>{copied ? '복사됨' : '복사'}</button>
        </div>
        <pre class="out">{job.result.text}</pre>
        <p class="hint">
          {job.result.tier}{job.result.modelApplied ? ` · ${job.result.modelApplied}` : ''}{elapsed !== null
            ? ` · 소요 ${elapsed}초`
            : ''}
        </p>
      {:else if job.state === 'error'}
        <p class="err">{job.error?.message ?? '알 수 없는 오류'}{job.error ? ` (${job.error.code})` : ''}</p>
      {/if}
      <p class="hint src">원문: {job.text}</p>
    </section>
  {/if}
</main>

<style>
  main {
    padding: 12px 14px 14px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  h1 {
    margin: 0;
    font-size: 16px;
  }
  h2 {
    margin: 0 0 6px;
    font-size: 12px;
    color: var(--text-sub);
    font-weight: 600;
  }
  p {
    margin: 0;
  }
  .conn {
    color: var(--text-sub);
    font-size: 12px;
  }
  .conn.on {
    color: var(--ok);
  }
  .hint {
    color: var(--text-sub);
    font-size: 11px;
  }
  .err {
    color: var(--danger);
    margin-top: 6px;
    word-break: break-word;
  }
  .seg {
    display: flex;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .seg button {
    flex: 1;
    padding: 6px 0;
    border: 0;
    background: var(--surface);
  }
  .seg button + button {
    border-left: 1px solid var(--border);
  }
  .seg button.active {
    background: var(--accent);
    color: var(--accent-text);
    font-weight: 600;
  }
  .seg + .hint {
    margin-top: 4px;
  }
  textarea {
    width: 100%;
    resize: vertical;
    padding: 8px;
    font: inherit;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 6px;
  }
  .row h2 {
    margin: 0;
  }
  .actions {
    display: flex;
    gap: 6px;
  }
  .primary,
  .ghost {
    padding: 5px 12px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface);
  }
  .primary {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
    font-weight: 600;
  }
  .result {
    padding: 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .out {
    margin: 6px 0;
    white-space: pre-wrap;
    word-break: break-word;
    font: inherit;
    user-select: text;
  }
  .src {
    margin-top: 6px;
    word-break: break-word;
    white-space: pre-wrap;
  }
</style>
