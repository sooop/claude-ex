<script lang="ts">
  import { onMount } from 'svelte'
  import {
    TIERS,
    TIER_LABEL,
    TRANSLATE_MAX_CHARS,
    type PluginInfo,
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
  let plugins = $state<PluginInfo[]>([])

  const pendingPlugins = $derived(plugins.filter((p) => p.status === 'pending'))
  const knownPlugins = $derived(plugins.filter((p) => p.status !== 'pending'))
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

  async function refreshPlugins() {
    try {
      plugins = await send<PluginInfo[]>({ kind: 'plugins' })
    } catch (e) {
      formError = msg(e)
    }
  }

  async function pluginAction(kind: 'approvePlugin' | 'denyPlugin' | 'removePlugin', p: PluginInfo) {
    try {
      // 승인·거부는 카드에 보이는 카탈로그(hash)에만 적용된다
      await send(kind === 'removePlugin' ? { kind, extId: p.extId } : { kind, extId: p.extId, hash: p.hash })
    } catch (e) {
      formError = msg(e)
    }
    refreshPlugins()
  }

  /** 승인 카드의 변경 요약. 추가·삭제가 없으면 설명·스키마 변경으로 본다 */
  function diffLines(p: PluginInfo): string[] {
    const d = p.diff
    if (!d) return []
    const out: string[] = []
    if (d.addedOps.length) out.push(`추가 op: ${d.addedOps.join(', ')}`)
    if (d.removedOps.length) out.push(`삭제 op: ${d.removedOps.join(', ')}`)
    if (d.addedAdapters.length) out.push(`추가 어댑터: ${d.addedAdapters.join(', ')}`)
    if (d.removedAdapters.length) out.push(`삭제 어댑터: ${d.removedAdapters.join(', ')}`)
    if (d.modified.length || out.length === 0) out.push(`설명·스키마 변경${d.modified.length ? `: ${d.modified.join(', ')}` : ''}`)
    return out
  }

  onMount(() => {
    refresh()
    refreshPlugins()
    return onEvent((e) => {
      if (e.kind === 'pluginsChanged') {
        refreshPlugins()
      } else if (e.kind === 'jobUpdate') {
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

  {#if pendingPlugins.length > 0}
    <section class="pending" aria-live="polite">
      <h2>플러그인 승인 대기</h2>
      {#each pendingPlugins as p (p.extId)}
        <div class="card">
          <p class="name">{p.name} <span class="hint">v{p.version}</span></p>
          <p class="hint id">{p.extId}</p>
          <ul>
            {#each p.ops as o (o.name + o.ver)}
              <li>op <b>{o.name}</b> — {o.summary}</li>
            {/each}
            {#each p.adapters as a (a.op + a.id)}
              <li>어댑터 <b>{a.op}/{a.id}</b> — {a.summary}</li>
            {/each}
          </ul>
          {#if p.diff}
            <p class="diff">이전 승인과의 차이</p>
            <ul>
              {#each diffLines(p) as line (line)}
                <li>{line}</li>
              {/each}
            </ul>
          {/if}
          <div class="row">
            <span class="hint">허용하면 아티팩트가 이 기능을 호출할 수 있습니다</span>
            <span class="actions">
              <button type="button" class="ghost" onclick={() => pluginAction('denyPlugin', p)}>거부</button>
              <button type="button" class="primary" onclick={() => pluginAction('approvePlugin', p)}>허용</button>
            </span>
          </div>
        </div>
      {/each}
    </section>
  {/if}

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

  <section>
    <h2>플러그인</h2>
    {#if knownPlugins.length === 0}
      <p class="hint">승인된 플러그인이 없습니다</p>
    {:else}
      {#each knownPlugins as p (p.extId)}
        <div class="row plugin">
          <span>
            {p.name} <span class="hint">v{p.version}{p.status === 'denied' ? ' · 거부됨' : ''}</span>
            <span class="hint block">{p.adapters.map((a) => a.id).concat(p.ops.map((o) => o.name)).join(', ') || '선언 없음'}</span>
          </span>
          <button type="button" class="ghost" onclick={() => pluginAction('removePlugin', p)}>해제</button>
        </div>
      {/each}
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
  .pending .card {
    padding: 10px;
    background: var(--surface);
    border: 1px solid #ef6c00;
    border-radius: var(--radius);
  }
  .pending .card + .card {
    margin-top: 8px;
  }
  .name {
    font-weight: 600;
  }
  .id {
    word-break: break-all;
  }
  .card ul {
    margin: 6px 0 0;
    padding-left: 16px;
    font-size: 12px;
    word-break: break-word;
  }
  .diff {
    margin-top: 6px;
    font-size: 11px;
    color: var(--text-sub);
  }
  .plugin {
    gap: 8px;
  }
  .block {
    display: block;
    word-break: break-word;
  }
  .src {
    margin-top: 6px;
    word-break: break-word;
    white-space: pre-wrap;
  }
</style>
