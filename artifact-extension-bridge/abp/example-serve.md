# 예시 3: 확장의 요청에 응답하기 (ai.decide, serve)

제공할 op는 고정된 입력 스키마와 고정 프롬프트 템플릿만 쓴다. `args` 스키마를 주면 브리지가 먼저 검증하고(스키마에 없는 필드 거부), 추가 정제는 `validate`에서 한다. 확장이 보낸 문자열은 데이터로만 취급하고 프롬프트에 넣을 때 길이를 자르고 줄바꿈을 정리한다. 확장발 AI 요청에는 사용자 토글과 분당 한도를 둔다. `cleanText`는 `example-calc-eval.md`에 있다.

```js
let extAiAllowed=true;
ABP.serve('ai.decide',{ver:1,kind:'read',limits:{maxConcurrent:1},
  summary:'후보 중 질의에 가장 맞는 항목을 판정한다',
  args:{type:'object',required:['query','candidates'],properties:{
    query:{type:'string',minLength:1,maxLength:200},
    candidates:{type:'array',maxItems:20,items:{type:'object',properties:{ref:{type:'string',maxLength:64},road:{type:'string',maxLength:300}}}}}},
  errors:[{code:'not_granted',when:'사용자가 확장의 AI 요청을 허용하지 않음'},{code:'busy',when:'분당 한도 초과 또는 처리 중'}],
  validate:a=>{
    if(!a.candidates.length)return{err:'candidates는 1~20건'};
    return{value:{query:a.query.trim(),candidates:a.candidates.map(c=>({ref:cleanText(c&&c.ref,64),road:cleanText(c&&c.road,300)}))}};
  },
  handler:async({args,signal,progress})=>{
    progress('scoring');
    /* 로컬 판정 후 필요하면 AI 호출, AI 출력은 스키마·확률 합(1±0.05)을 검증하고 실패하면 로컬 결과로 폴백 */
    return {scores:[],pNone:1,bestRef:null,verdict:'ambiguous',summary:''};
  }});
ABP.policy=(op)=>{
  if(op==='ai.decide'&&!extAiAllowed)return{code:'not_granted',message:'사용자가 확장의 AI 요청을 허용하지 않았습니다'};
  if(!ABP.rateLimit('ext:'+op,12))return{code:'busy',message:'분당 요청 한도를 넘었습니다',retryable:true};
  return null;
};
```
