# 예시 2: 조회 위임 + 어댑터 발견 + 폴백 (web.query)

외부 사이트 조회처럼 어댑터가 있는 read op의 호출 패턴이다. 순서는 확장 -> Claude 호출(`window.claude`) -> 수동 입력이다. 확장 결과는 신뢰하지 말고 스키마 검증과 정제를 거친 뒤에만 상태에 반영하고, 화면에는 textContent나 이스케이프로만 출력한다.

어댑터 발견 순서: (1) `ABP.has(op)`로 op 유무, (2) `ABP.catalog()`의 `adapters`로 쓰려는 어댑터 id 유무와 `state`, (3) `await ABP.describe(op, adapter)`로 `params` 스키마와 `resultNotes` 확인. 쓰려는 어댑터가 없거나 `needs_setup`이면 사용자에게 안내하고 다음 어댑터로 간다. 첫 호출 전에 브리지가 describe 스키마와 args(adapter, params)를 대조하고, 불일치면 `incompatible`로 막는다.

```js
const cleanText=(s,n)=>String(s==null?'':s).replace(/<[^>]*>/g,' ').replace(/[<>]/g,'').replace(/\s+/g,' ').trim().slice(0,n);
const hasAdapter=(op,id)=>{const p=ABP.catalog().provides.find(x=>x.op===op);return !!(p&&p.state!=='needs_setup'&&p.adapters&&p.adapters.some(a=>a.id===id))};
async function lookup(query,ctl){
  if(hasAdapter('web.query','epost-zip')){
    try{
      const r=await ABP.call('web.query',{adapter:'epost-zip',params:{query}},{timeoutMs:15000,signal:ctl.signal});
      return {via:'ext',items:(Array.isArray(r.data&&r.data.rows)?r.data.rows:[]).slice(0,20).map(x=>({road:cleanText(x.address,300)})).filter(x=>x.road)};
    }catch(e){
      if(e.code==='cancelled')throw e;
      /* blocked, parse_failed, incompatible, not_granted(needs_setup) 등은 사용자에게 알리고 다음 어댑터로 */
      noteSource('ext',ABP.errText(e));
    }
  }
  /* 2) Claude 호출 어댑터  3) 수동 붙여넣기 UI */
  return lookupViaClaude(query,ctl);
}
```

카탈로그가 바뀌면 `ABP.on('catalog', render)`로 화면(기능 사용 가능 여부 표시)을 다시 그린다. 재시도는 `retryable:true`에 한해 지수 백오프로 최대 2회, write op는 `idempotencyKey` 없이 재시도하지 않는다.
