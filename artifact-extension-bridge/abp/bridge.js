/* ===== ABP v2 Bridge: 아티팩트 측 (복사해서 쓰는 단일 블록) ===== */
const ABP=(()=>{
  const CFG={ns:'my-app',appVersion:'1.0.0',helloRetryMs:[0,1500,4000],offAfterMs:6000,maxPending:8,
    maxBytes:1048576,maxProvidesBytes:16384,defaultTimeoutMs:60000,graceMs:2000,idemTtlMs:60000};
  const SRC_APP='ab-app',SRC_EXT='ab-ext',V=2;
  const uid=()=>(window.crypto&&crypto.randomUUID)?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2,10);
  const S={status:'wait',peer:null,note:''};
  const pending=new Map(),served=new Map(),running=new Map(),active=new Map(),idem=new Map(),waiters=new Map(),buckets=new Map();
  const descCache=new Map(),checked=new Set();
  const subs={state:new Set(),log:new Set(),catalog:new Set(),event:new Map()};
  const LOG=[],LOG_MAX=100;
  let timers=[],started=false;
  const sizeOf=o=>{try{return JSON.stringify(o).length}catch(e){return -1}};
  const clampTimeout=n=>{n=Number(n);return n>=1000&&n<=300000?n:CFG.defaultTimeoutMs};
  const clip=(s,n)=>String(s==null?'':s).replace(/\s+/g,' ').trim().slice(0,n);
  const clipRaw=(s,n)=>String(s==null?'':s).replace(/[<>]/g,'').slice(0,n);
  const fnv=s=>{let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0}return h.toString(16)};
  const E=(code,message,retryable,detail)=>({code,message:message||code,retryable:!!retryable,detail,bridge:true});
  const notify=(set,...a)=>set.forEach(f=>{try{f(...a)}catch(e){}});

  function log(dir,m,note){
    const r={t:Date.now(),dir,type:m&&m.type,op:m&&m.op,id:m&&m.id,v:m&&m.v,ok:m&&m.ok,
      code:m&&m.error&&m.error.code,note:note||'',size:sizeOf(m)};
    LOG.push(r);if(LOG.length>LOG_MAX)LOG.shift();notify(subs.log,r);
  }
  function post(msg){
    const m={source:SRC_APP,v:V,ns:CFG.ns,ts:Date.now(),...msg};
    log('out',m);
    try{window.postMessage(m,'*')}catch(e){log('out',m,'postMessage 실패: '+e.message)}
  }
  function setStatus(s,note){
    const ch=S.status!==s;S.status=s;S.note=note||'';
    if(ch)notify(subs.state,S.status,S.peer);
  }

  /* ---- 스키마 검증 (JSON Schema 부분집합: 3.8) ---- */
  const BAD_KW=['$ref','oneOf','anyOf','allOf','not','pattern'],BAD_KEY=['__proto__','constructor','prototype'];
  function validateSchema(sc,val){
    let skip=false;
    const walk=(s,v,P,d)=>{
      if(d>8||!s||typeof s!=='object'||BAD_KW.some(k=>k in s)){skip=true;return{value:v}}
      if(Array.isArray(s.enum)&&!s.enum.includes(v))return{err:P+': 허용 값이 아닙니다'};
      const t=s.type;
      if(t==='string'){
        if(typeof v!=='string')return{err:P+': 문자열이어야 합니다'};
        if(s.minLength!=null&&v.length<s.minLength)return{err:P+': 너무 짧습니다'};
        if(s.maxLength!=null&&v.length>s.maxLength)return{err:P+': 너무 깁니다'};
        return{value:v};
      }
      if(t==='number'||t==='integer'){
        if(typeof v!=='number'||!isFinite(v)||(t==='integer'&&!Number.isInteger(v)))return{err:P+': '+(t==='integer'?'정수':'숫자')+'여야 합니다'};
        if(s.minimum!=null&&v<s.minimum)return{err:P+': 최솟값 미만입니다'};
        if(s.maximum!=null&&v>s.maximum)return{err:P+': 최댓값 초과입니다'};
        return{value:v};
      }
      if(t==='boolean')return typeof v==='boolean'?{value:v}:{err:P+': true/false여야 합니다'};
      if(t==='array'){
        if(!Array.isArray(v))return{err:P+': 배열이어야 합니다'};
        if(s.maxItems!=null&&v.length>s.maxItems)return{err:P+': 항목이 너무 많습니다'};
        const out=[];
        for(let i=0;i<v.length;i++){const r=s.items?walk(s.items,v[i],P+'['+i+']',d+1):{value:v[i]};if(r.err)return r;out.push(r.value)}
        return{value:out};
      }
      if(t==='object'){
        if(!v||typeof v!=='object'||Array.isArray(v))return{err:P+': 객체여야 합니다'};
        const out={},props=s.properties,ap=s.additionalProperties;
        for(const k of Object.keys(v)){
          if(BAD_KEY.includes(k))return{err:P+': 허용되지 않은 필드 '+k};
          if(props&&Object.prototype.hasOwnProperty.call(props,k)){const r=walk(props[k],v[k],P+'.'+k,d+1);if(r.err)return r;out[k]=r.value}
          else if(ap&&typeof ap==='object'){const r=walk(ap,v[k],P+'.'+k,d+1);if(r.err)return r;out[k]=r.value}
          else if(!props||ap===true)out[k]=v[k];
          else return{err:P+': 허용되지 않은 필드 '+k};
        }
        if(props)for(const k of Object.keys(props))if(!(k in out)&&props[k]&&'default' in props[k])out[k]=props[k].default;
        for(const r of(s.required||[]))if(!(r in out))return{err:P+': 필수 필드 '+r+'가 없습니다'};
        return{value:out};
      }
      skip=true;return{value:v};
    };
    const r=walk(sc,val,'값',0);
    return r.err?{err:r.err}:{value:r.value,skip};
  }

  /* ---- 카탈로그 정제 (확장이 보낸 값은 외부 입력) ---- */
  const cleanSchema=s=>(s&&typeof s==='object'&&sizeOf(s)<=8192)?s:null;
  function cleanProvides(arr){
    return(Array.isArray(arr)?arr:[]).filter(p=>p&&typeof p.op==='string'&&p.op).slice(0,200).map(p=>({
      op:clip(p.op,64),ver:Number(p.ver)||1,kind:['read','write','sensitive'].includes(p.kind)?p.kind:'read',
      consent:(typeof p.consent==='boolean')?p.consent:clip(p.consent||'none',20),limits:(p.limits&&typeof p.limits==='object')?p.limits:{},
      summary:clip(p.summary,80),
      adapters:(Array.isArray(p.adapters)?p.adapters:[]).filter(a=>a&&/^[a-z0-9-]{1,32}$/.test(a.id)).slice(0,32).map(a=>({id:a.id,summary:clip(a.summary,80)})),
      state:p.state==='needs_setup'?'needs_setup':'ready',hint:clip(p.hint,120)}));
  }
  function cleanDescribe(d){
    d=(d&&typeof d==='object')?d:{};
    return{op:clip(d.op,64),ver:Number(d.ver)||1,kind:clip(d.kind,12),consent:clip(d.consent,20),summary:clip(d.summary,80),
      description:clipRaw(d.description,2000),args:cleanSchema(d.args),result:cleanSchema(d.result),
      errors:(Array.isArray(d.errors)?d.errors:[]).slice(0,20).map(e=>({code:clip(e&&e.code,40),when:clip(e&&e.when,200)})),
      limits:(d.limits&&typeof d.limits==='object')?d.limits:{},
      examples:(Array.isArray(d.examples)?d.examples:[]).slice(0,3).filter(x=>x&&sizeOf(x)<=2200).map(x=>({title:clip(x.title,80),args:x.args,result:x.result})),
      adapters:(Array.isArray(d.adapters)?d.adapters:[]).slice(0,32).map(a=>({id:clip(a&&a.id,32),summary:clip(a&&a.summary,80),
        description:clipRaw(a&&a.description,2000),params:cleanSchema(a&&a.params),resultNotes:clipRaw(a&&a.resultNotes,500),
        hosts:(Array.isArray(a&&a.hosts)?a.hosts:[]).slice(0,10).map(h=>clip(h,100)),notes:clipRaw(a&&a.notes,500)}))};
  }
  function setPeer(m){
    const sv=Array.isArray(m.supportedVersions)?m.supportedVersions:[];
    if(sv.length&&!sv.includes(V)){S.peer=null;return setStatus('off','확장이 프로토콜 v'+V+'을 지원하지 않습니다');}
    if(sizeOf(m.provides)>CFG.maxProvidesBytes){log('drop',m,'provides가 16KiB 초과');return;}
    const wasOff=S.status==='off',prev=S.peer&&S.peer.catalogRev,rev=clip(m.catalogRev,32);
    S.peer={version:clip(m.version,40),supportedVersions:sv,provides:cleanProvides(m.provides),catalogRev:rev,
      limits:(m.limits&&typeof m.limits==='object')?m.limits:{}};
    if(prev!==rev){descCache.clear();checked.clear();notify(subs.catalog)}
    setStatus('ok');
    if(wasOff)refreshCatalog().catch(()=>{});
  }

  /* ---- 내 카탈로그 (제공자) ---- */
  const providesList=()=>[...served.entries()].map(([op,d])=>{
    const o={op,ver:d.ver,kind:d.kind,consent:d.consent,limits:{maxConcurrent:d.maxConcurrent},summary:clip(d.summary||op,80),state:d.state||'ready'};
    if(d.adapters&&d.adapters.length)o.adapters=d.adapters.map(a=>({id:a.id,summary:clip(a.summary,80)}));
    if(d.hint)o.hint=clip(d.hint,120);return o;});
  const myRev=()=>fnv(JSON.stringify(providesList()));
  const helloBody=()=>({role:'app',version:CFG.appVersion,supportedVersions:[V],provides:providesList(),catalogRev:myRev(),
    limits:{maxPending:CFG.maxPending,maxBytes:CFG.maxBytes}});
  function hello(id){post({type:'hello',id:id||uid(),...helloBody()})}
  function rescan(){
    timers.forEach(clearTimeout);timers=[];
    if(S.status!=='ok')setStatus('wait');
    CFG.helloRetryMs.forEach(ms=>timers.push(setTimeout(()=>{if(S.status!=='ok')hello()},ms)));
    timers.push(setTimeout(()=>{if(S.status==='wait')setStatus('off')},CFG.offAfterMs));
  }
  function ping(timeoutMs=3000){
    return new Promise((resolve,reject)=>{
      const id=uid(),t0=Date.now();
      const to=setTimeout(()=>{waiters.delete(id);reject(E('timeout','응답 없음',true))},timeoutMs);
      waiters.set(id,m=>{clearTimeout(to);resolve({ms:Date.now()-t0,peer:S.peer,raw:{version:m.version,supportedVersions:m.supportedVersions,catalogRev:m.catalogRev,provides:m.provides,limits:m.limits}})});
      hello(id);
    });
  }
  const find=(op,ver=1)=>(S.status==='ok'&&S.peer)?S.peer.provides.find(p=>p.op===op&&p.ver===ver):undefined;
  const has=(op,ver=1)=>!!find(op,ver);
  const ready=()=>new Promise(res=>{if(S.status!=='wait')return res(S.peer);const un=on('state',()=>{if(S.status!=='wait'){un();res(S.peer)}})});

  /* ---- 호출자 역할 ---- */
  function rawCall(op,args,o={}){
    return new Promise((resolve,reject)=>{
      const ver=o.ver||1,p=find(op,ver);
      if(!p)return reject(E('unsupported_op','확장이 이 op를 제공하지 않습니다'));
      if(p.state==='needs_setup')return reject(E('not_granted',p.hint||'확장에서 설정이 필요합니다',false,{hint:p.hint}));
      if(pending.size>=CFG.maxPending)return reject(E('busy','대기 중인 호출이 너무 많습니다',true));
      if(o.signal&&o.signal.aborted)return reject(E('cancelled','취소되었습니다'));
      const id=uid(),timeoutMs=clampTimeout(o.timeoutMs);
      let done=false,timer;
      const finish=(fn,v)=>{if(done)return;done=true;clearTimeout(timer);
        if(o.signal)o.signal.removeEventListener('abort',onAbort);pending.delete(id);fn(v)};
      const onAbort=()=>{post({type:'cancel',id});finish(reject,E('cancelled','취소되었습니다'))};
      pending.set(id,m=>{
        if(m.type==='progress'){
          if(o.onProgress)o.onProgress({stage:clip(m.stage,40),detail:clip(m.detail,200),pct:typeof m.pct==='number'?m.pct:null});
          return;
        }
        if(m.ok===true)return finish(resolve,{data:m.data,meta:(m.meta&&typeof m.meta==='object')?m.meta:{}});
        const er=(m.error&&typeof m.error==='object')?m.error:{};
        finish(reject,E(typeof er.code==='string'?er.code:'internal',clip(er.message,200),er.retryable,er.detail));
      });
      if(o.signal)o.signal.addEventListener('abort',onAbort);
      timer=setTimeout(()=>{post({type:'cancel',id});finish(reject,E('timeout','시간이 초과되었습니다',true));
        if(S.status==='ok'&&pending.size===0){setStatus('off','호출 시간 초과로 연결을 다시 확인합니다');rescan();}},timeoutMs+CFG.graceMs);
      post({type:'call',id,op,ver,args,opts:{timeoutMs,idempotencyKey:o.idempotencyKey}});
    });
  }
  /* call: 첫 호출 전에 describe 스키마와 인자가 맞는지 한 번 확인한다 (o.check:false로 끔) */
  function call(op,args,o={}){
    const p=find(op,o.ver||1);
    if(!p||p.state==='needs_setup'||o.check===false||op.startsWith('meta.'))return rawCall(op,args,o);
    const key=[op,p.ver,args&&args.adapter||'',S.peer.catalogRev].join('|');
    if(checked.has(key))return rawCall(op,args,o);
    return compat(op,args).then(c=>{
      if(!c.ok)throw E('incompatible','확장의 이 기능 형식이 앱 코드와 맞지 않습니다',false,{reason:c.err});
      checked.add(key);
      if(o.signal&&o.signal.aborted)throw E('cancelled','취소되었습니다');
      return rawCall(op,args,o);
    });
  }
  async function compat(op,args){
    const ad=args&&typeof args.adapter==='string'?args.adapter:undefined;
    const d=await describe(op,ad);
    if(!d||!d.args)return{ok:true,skipped:true};
    const r=validateSchema(d.args,args);
    if(r.err)return{ok:false,err:r.err};
    const a=ad&&d.adapters&&d.adapters[0];
    if(a&&a.params){const r2=validateSchema(a.params,args.params);if(r2.err)return{ok:false,err:'params'+r2.err.slice(2)}}
    return{ok:true,skipped:!!r.skip};
  }
  async function describe(op,adapter){
    if(!has('meta.describe'))return null;
    const key=op?op+'|'+(adapter||''):'*',c=descCache.get(key);
    if(c&&c.rev===S.peer.catalogRev)return c.v;
    const r=await rawCall('meta.describe',op?(adapter?{op,adapter}:{op}):{},{timeoutMs:8000});
    const v=op?cleanDescribe(r.data):{provides:cleanProvides(r.data&&r.data.provides),catalogRev:clip(r.data&&r.data.catalogRev,32)};
    descCache.set(key,{rev:S.peer?S.peer.catalogRev:'',v});
    return v;
  }
  async function refreshCatalog(){
    descCache.clear();checked.clear();
    const c=await describe();
    if(c&&S.peer){S.peer.provides=c.provides;S.peer.catalogRev=c.catalogRev;descCache.clear();notify(subs.catalog)}
    return catalog();
  }
  const catalog=()=>({catalogRev:S.peer?S.peer.catalogRev:'',provides:S.peer?S.peer.provides.map(p=>({...p})):[]});

  /* ---- 제공자 역할 ---- */
  function serve(op,def){
    if(/^meta\./.test(op))throw new Error('meta. 도메인은 프로토콜 예약입니다');
    served.set(op,{ver:def.ver||1,kind:def.kind||'read',consent:def.consent||'none',summary:def.summary||'',adapters:def.adapters||[],
      description:def.description,args:def.args,result:def.result,errors:def.errors,examples:def.examples,state:def.state,hint:def.hint,
      maxConcurrent:(def.limits&&def.limits.maxConcurrent)||1,validate:def.validate,handler:def.handler});
    if(started&&S.status==='ok'){hello();emit('catalog_changed',{catalogRev:myRev()})}
  }
  function describeOwn(a){
    if(!a||!a.op)return{provides:providesList(),catalogRev:myRev()};
    const d=served.get(a.op);
    if(!d)throw{code:'unsupported_op',message:'제공하지 않는 op입니다',detail:{known:[...served.keys()]}};
    let ads=d.adapters;
    if(a.adapter){ads=ads.filter(x=>x.id===a.adapter);if(!ads.length)throw{code:'unsupported_op',message:'없는 어댑터입니다',detail:{known:d.adapters.map(x=>x.id)}}}
    const o={op:a.op,ver:d.ver,kind:d.kind,consent:d.consent,summary:d.summary,description:d.description,args:d.args,result:d.result,
      errors:d.errors,limits:{maxConcurrent:d.maxConcurrent},examples:d.examples,adapters:ads.length?ads:undefined};
    Object.keys(o).forEach(k=>o[k]===undefined&&delete o[k]);return o;
  }
  served.set('meta.describe',{ver:1,kind:'read',consent:'none',summary:'이 앱이 제공하는 op의 설명을 돌려준다',adapters:[],maxConcurrent:4,
    validate:a=>(a==null||typeof a==='object')?{value:a||{}}:{err:'args는 객체'},handler:async({args})=>describeOwn(args)});

  async function handleCall(m){
    const reply=o=>post({type:'result',id:m.id,...o});
    const bad=(code,message,retryable,detail)=>reply({ok:false,error:{code,message,retryable:!!retryable,detail}});
    if(typeof m.id!=='string'||!m.id)return;
    if(running.has(m.id))return bad('invalid_request','id가 중복되었습니다');
    const def=served.get(m.op);
    if(!def||(m.ver||1)!==def.ver)return bad('unsupported_op','제공하지 않는 op입니다',false,{known:[...served.keys()]});
    let args=m.args;
    if(def.args){const r=validateSchema(def.args,args);if(r.err)return bad('invalid_request',r.err.slice(0,160));if(!r.skip)args=r.value}
    if(def.validate){
      const v=def.validate(args);
      if(!v||v.err)return bad('invalid_request',String((v&&v.err)||'검증 실패').slice(0,160));
      args=v.value;
    }
    const o=(m.opts&&typeof m.opts==='object')?m.opts:{};
    const key=(def.kind==='write'&&typeof o.idempotencyKey==='string')?m.op+'|'+o.idempotencyKey.slice(0,128):null;
    if(key){const c=idem.get(key);if(c&&Date.now()-c.t<CFG.idemTtlMs)return reply(c.res);}
    if(ABP.policy){const p=ABP.policy(m.op,def,m);if(p)return bad(p.code||'not_granted',p.message||'허용되지 않았습니다',p.retryable,p.detail);}
    const n=active.get(m.op)||0;
    if(n>=def.maxConcurrent)return bad('busy','처리 중인 요청이 있습니다',true);
    const ctl=new AbortController(),act={ctl,done:false};
    running.set(m.id,act);active.set(m.op,n+1);
    const end=res=>{
      if(act.done)return;act.done=true;clearTimeout(act.timer);
      running.delete(m.id);active.set(m.op,Math.max(0,(active.get(m.op)||1)-1));
      if(key&&res.ok)idem.set(key,{t:Date.now(),res});
      reply(res);
    };
    act.end=end;
    act.timer=setTimeout(()=>{ctl.abort();end({ok:false,error:{code:'timeout',message:'처리 시간이 초과되었습니다',retryable:true}})},clampTimeout(o.timeoutMs));
    try{
      const data=await def.handler({args,signal:ctl.signal,
        progress:(stage,detail,pct)=>{if(!act.done)post({type:'progress',id:m.id,stage:String(stage).slice(0,40),detail:detail==null?undefined:String(detail).slice(0,200),pct})}});
      if(act.done)return;
      if(sizeOf(data)>CFG.maxBytes)return end({ok:false,error:{code:'payload_too_large',message:'결과가 너무 큽니다',retryable:false}});
      end({ok:true,data,meta:{appVersion:CFG.appVersion}});
    }catch(e){
      if(act.done)return;
      const known=e&&typeof e.code==='string';
      end({ok:false,error:{code:known?e.code:'internal',message:known?String(e.message||e.code).slice(0,160):'앱 내부 오류가 발생했습니다',retryable:!!(e&&e.retryable),detail:known?e.detail:undefined}});
    }
  }

  /* ---- 수신 ---- */
  function onMessage(e){
    if(e.source!==window)return;
    const m=e.data;
    if(!m||typeof m!=='object'||m.source!==SRC_EXT)return;
    if(m.ns!==CFG.ns){log('drop',m,'ns 불일치');return;}
    if(m.v!==V){log('drop',m,'v 불일치('+m.v+')');return;}
    if(typeof m.type!=='string'||typeof m.id!=='string'&&m.type!=='event'){log('drop',m,'형식 오류');return;}
    log('in',m);
    switch(m.type){
      case 'hello':setPeer(m);post({type:'hello_ack',id:m.id,ok:true,...helloBody()});break;
      case 'hello_ack':{
        if(m.ok===false)break;
        setPeer(m);
        const w=waiters.get(m.id);if(w){waiters.delete(m.id);w(m);}
        break;
      }
      case 'progress':case 'result':{const p=pending.get(m.id);if(p)p(m);else log('drop',m,'알 수 없는 id');break;}
      case 'call':handleCall(m);break;
      case 'cancel':{const a=running.get(m.id);if(a){a.ctl.abort();a.end({ok:false,error:{code:'cancelled',message:'중단되었습니다',retryable:false}});}break;}
      case 'event':{
        if(m.name==='catalog_changed'&&S.status==='ok'&&(!m.data||m.data.catalogRev!==S.peer.catalogRev))refreshCatalog().catch(()=>{});
        const set=subs.event.get(String(m.name||''));if(set)notify(set,m.data);
        break;
      }
    }
  }
  function start(){if(started)return;started=true;window.addEventListener('message',onMessage);rescan();}
  function on(kind,a,b){
    if(kind==='event'){if(!subs.event.has(a))subs.event.set(a,new Set());subs.event.get(a).add(b);return()=>subs.event.get(a).delete(b);}
    subs[kind].add(a);return()=>subs[kind].delete(a);
  }
  const emit=(name,data)=>post({type:'event',id:uid(),name,data});
  function rateLimit(key,perMin){
    const now=Date.now(),a=(buckets.get(key)||[]).filter(t=>now-t<60000);
    if(a.length>=perMin){buckets.set(key,a);return false;}
    a.push(now);buckets.set(key,a);return true;
  }
  const ERR={
    unsupported_op:'확장이 이 기능을 지원하지 않습니다. 확장을 업데이트하세요.',invalid_request:'요청 형식이 올바르지 않습니다.',
    busy:'다른 요청을 처리 중입니다. 잠시 후 다시 시도하세요.',timeout:'시간이 초과되었습니다. 다시 시도하세요.',cancelled:'취소했습니다.',
    not_granted:'확장에서 이 동작이 허용되지 않았습니다. 확장 설정에서 허용하세요.',blocked:'대상 사이트가 접근을 차단했습니다.',
    network:'네트워크 연결에 실패했습니다.',parse_failed:'대상 응답을 해석하지 못했습니다.',payload_too_large:'데이터가 너무 큽니다.',
    ai_unavailable:'AI 호출을 사용할 수 없습니다.',unsupported_version:'프로토콜 버전이 맞지 않습니다.',internal:'내부 오류가 발생했습니다.',
    not_found:'대상을 찾지 못했습니다.',conflict:'저장된 값과 충돌합니다. 최신 값을 확인하세요.',math_error:'계산할 수 없는 수식입니다.',
    incompatible:'확장 버전과 앱 형식이 맞지 않습니다. 확장을 업데이트하세요.'};
  const errText=e=>{
    let t=ERR[e&&e.code]||'처리 중 오류가 발생했습니다.';
    if(e&&e.code==='not_granted'&&e.detail&&e.detail.hint)t+=' ('+clip(e.detail.hint,120)+')';
    else if(e&&e.bridge&&e.message&&e.code==='internal')t+=' ('+clip(e.message,80)+')';
    return t;
  };
  return {CFG,start,rescan,ready,ping,hello,has,catalog,describe,refreshCatalog,call,serve,on,emit,rateLimit,validateSchema,errText,policy:null,
    get status(){return S.status},get peer(){return S.peer},get note(){return S.note},get log(){return LOG}};
})();
