/* ===== ABP 모의 확장 (테스트 전용, 배포 전 제거) ===== */
const ABP_MOCK=(()=>{
  let ns='my-app',on=false,ver='mock-0.1',withDescribe=true;const run=new Map(),pend=new Map();
  const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,8);
  const post=m=>window.postMessage({source:'ab-ext',v:2,ns,ts:Date.now(),...m},'*');
  const wait=(ms,sig)=>new Promise((res,rej)=>{const t=setTimeout(res,ms);sig.addEventListener('abort',()=>{clearTimeout(t);rej({code:'cancelled'})})});
  const fnv=s=>{let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0}return h.toString(16)};

  /* calc.eval: 재귀 하강 파서 (eval/Function 미사용). 계약 6.6 */
  function calcEval(a){
    const src=a.expr,vars=a.vars||{},prec=a.precision==null?12:a.precision;
    const F={sqrt:Math.sqrt,abs:Math.abs,round:Math.round,floor:Math.floor,ceil:Math.ceil,min:Math.min,max:Math.max,log:Math.log10,ln:Math.log,exp:Math.exp,sin:Math.sin,cos:Math.cos,tan:Math.tan};
    const K={pi:Math.PI,e:Math.E};
    let i=0,terms=0;
    const bad=(msg,pos)=>{throw{code:'invalid_request',message:msg,detail:{pos:pos==null?i:pos}}};
    const math=(msg,pos)=>{throw{code:'math_error',message:msg,retryable:false,detail:{pos:pos==null?i:pos}}};
    const ws=()=>{while(src[i]===' ')i++};
    const peek=()=>{ws();return src[i]};
    function expr(d){if(d>64)bad('수식이 너무 깊습니다');let v=term(d);for(;;){const c=peek();if(c==='+'){i++;v+=term(d)}else if(c==='-'){i++;v-=term(d)}else return v}}
    function term(d){let v=unary(d);for(;;){const c=peek();
      if(c==='*'){i++;v*=unary(d)}
      else if(c==='/'||c==='%'){const p=i;i++;const r=unary(d);if(r===0)math('0으로 나눌 수 없습니다',p);v=c==='/'?v/r:v%r}
      else return v}}
    function pow(d){const b=atom(d);if(peek()==='^'){i++;return Math.pow(b,unary(d))}return b}
    function unary(d){if(peek()==='-'){i++;return -unary(d)}return pow(d)}
    function atom(d){
      ws();const p=i;if(++terms>200)bad('항이 너무 많습니다');
      if(src[i]==='('){i++;const v=expr(d+1);if(peek()!==')')bad('닫는 괄호가 없습니다');i++;return v}
      let m=/^\d+(\.\d+)?/.exec(src.slice(i));
      if(m){i+=m[0].length;return Number(m[0])}
      m=/^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      if(m){
        const n=m[0];i+=n.length;
        if(peek()==='('){
          if(!Object.prototype.hasOwnProperty.call(F,n))bad('모르는 함수: '+n,p);
          i++;const args=[];if(peek()!==')'){for(;;){args.push(expr(d+1));if(peek()===','){i++;continue}break}}
          if(peek()!==')')bad('닫는 괄호가 없습니다');i++;
          const v=F[n](...args);if(!isFinite(v))math('계산 결과가 유효하지 않습니다',p);return v;
        }
        if(Object.prototype.hasOwnProperty.call(vars,n))return vars[n];
        if(Object.prototype.hasOwnProperty.call(K,n))return K[n];
        bad('모르는 이름: '+n,p);
      }
      bad('예상하지 못한 문자',p);
    }
    const v=expr(0);ws();if(i<src.length)bad('예상하지 못한 문자',i);
    if(!isFinite(v))math('계산 결과가 유효하지 않습니다',0);
    return{value:v,text:String(Number(v.toPrecision(Math.max(1,prec||1))))};
  }

  const OPS={
    'calc.eval':{ver:1,kind:'read',summary:'사칙·거듭제곱·함수가 들어간 수식을 계산한다',
      desc:{description:'수식 문자열을 계산한다. 연동 시험용이다.',
        args:{type:'object',required:['expr'],properties:{expr:{type:'string',minLength:1,maxLength:500},
          vars:{type:'object',additionalProperties:{type:'number'}},precision:{type:'integer',minimum:0,maximum:15,default:12}}},
        result:{type:'object',properties:{value:{type:'number'},text:{type:'string'}}},
        errors:[{code:'invalid_request',when:'문법 오류, 모르는 이름이나 함수 (detail.pos)'},{code:'math_error',when:'0으로 나누기, NaN, Infinity'}],
        examples:[{title:'피타고라스',args:{expr:'sqrt(x^2 + y^2)',vars:{x:3,y:4}},result:{value:5,text:'5'}}]},
      fn:async({args})=>calcEval(args)},
    'web.query':{ver:1,kind:'read',summary:'허용된 사이트에서 정보를 조회한다',adapters:[{id:'epost-zip',summary:'우체국 우편번호 조회'}],
      desc:{description:'어댑터를 지정해 외부 조회를 위임한다.',
        args:{type:'object',required:['adapter'],properties:{adapter:{type:'string'},params:{type:'object'}}},
        adapters:[{id:'epost-zip',summary:'우체국 우편번호 조회',description:'도로명 주소로 우편번호를 찾는다.',
          params:{type:'object',required:['query'],properties:{query:{type:'string',minLength:2,maxLength:100}}},
          resultNotes:'zip(5자리), address 배열',hosts:['epost.go.kr'],notes:''}]},
      fn:async({args})=>({adapter:args.adapter,rows:[{zip:'06236',address:'서울 강남구 테헤란로 1'}]})},
    'setup.demo':{ver:1,kind:'read',summary:'설정이 필요한 기능 예시',state:'needs_setup',hint:'확장 옵션에서 사이트 접근을 허용하세요',
      desc:{description:'needs_setup 시험용'},fn:async()=>({ok:true})},
    'test.echo':{ver:1,kind:'read',summary:'받은 인자를 그대로 돌려준다',fn:async({args})=>({echo:args})},
    'test.slow':{ver:1,kind:'read',summary:'진행률 시험',fn:async({args,sig,progress})=>{const n=3,ms=Number(args&&args.ms)||600;for(let i=1;i<=n;i++){await wait(ms/n,sig);progress('step',i+'/'+n,i/n)}return{ok:true}}},
    'test.fail':{ver:1,kind:'read',summary:'지정한 오류를 돌려준다',fn:async({args})=>{throw{code:(args&&args.code)||'internal',message:'모의 오류',retryable:false}}},
    'test.save':{ver:1,kind:'write',summary:'쓰기 시험',fn:async({args})=>({saved:(args&&args.name)||'x',n:++OPS['test.save'].count})}
  };OPS['test.save'].count=0;
  const provides=()=>Object.entries(OPS).map(([op,d])=>{
    const o={op,ver:d.ver,kind:d.kind,consent:'none',limits:{maxConcurrent:2},summary:d.summary||op,state:d.state||'ready'};
    if(d.adapters)o.adapters=d.adapters;if(d.hint)o.hint=d.hint;return o});
  const listAll=()=>withDescribe?[...provides(),{op:'meta.describe',ver:1,kind:'read',consent:'none',summary:'op 상세 조회',limits:{maxConcurrent:4}}]:provides();
  const rev=()=>fnv(JSON.stringify(provides()));
  const body=()=>({role:'ext',version:ver,supportedVersions:[1,2],provides:listAll(),catalogRev:rev(),limits:{maxBytes:1048576}});
  function describeOp(a){
    a=a||{};
    if(!a.op)return{provides:listAll(),catalogRev:rev()};
    const d=OPS[a.op];if(!d)throw{code:'unsupported_op',message:'없는 op',detail:{known:Object.keys(OPS)}};
    const o={op:a.op,ver:d.ver,kind:d.kind,consent:'none',summary:d.summary,...(d.desc||{})};
    if(a.adapter){const ad=(o.adapters||[]).filter(x=>x.id===a.adapter);if(!ad.length)throw{code:'unsupported_op',message:'없는 어댑터',detail:{known:(o.adapters||[]).map(x=>x.id)}};o.adapters=ad}
    return o;
  }
  async function onMsg(e){
    if(!on||e.source!==window)return;const m=e.data;
    if(!m||m.source!=='ab-app'||m.ns!==ns)return;
    if(m.type==='hello'){post({type:'hello_ack',id:m.id,ok:true,...body()});return}
    if(m.type==='hello_ack'||m.type==='progress')return;
    if(m.type==='result'){const p=pend.get(m.id);if(p)p(m);return}
    if(m.type==='cancel'){const r=run.get(m.id);if(r)r.abort();return}
    if(m.type==='call'){
      const fail=(code,message,detail)=>post({type:'result',id:m.id,ok:false,error:{code,message,retryable:false,detail}});
      if(m.op==='meta.describe'&&withDescribe){try{return post({type:'result',id:m.id,ok:true,data:describeOp(m.args),meta:{}})}catch(x){return fail(x.code,x.message,x.detail)}}
      const d=OPS[m.op];if(!d)return fail('unsupported_op','없음',{known:Object.keys(OPS)});
      const ctl=new AbortController();run.set(m.id,ctl);
      try{const data=await d.fn({args:m.args,sig:ctl.signal,progress:(stage,detail,pct)=>post({type:'progress',id:m.id,stage,detail,pct})});
        post({type:'result',id:m.id,ok:true,data,meta:{engine:'mock'}})}
      catch(x){post({type:'result',id:m.id,ok:false,error:{code:x.code||'internal',message:x.message||'',retryable:!!x.retryable,detail:x.detail}})}
      finally{run.delete(m.id)}
    }
  }
  function callApp(op,args,opts={}){
    return new Promise(res=>{const id=uid();pend.set(id,m=>{if(m.type==='result'){pend.delete(id);res(m)}});
      post({type:'call',id,op,ver:1,args,opts});});
  }
  /* 카탈로그 변경 재현: op 추가/제거 뒤 catalog_changed 이벤트 전송 */
  function addOp(op,def){OPS[op]=def;post({type:'event',id:uid(),name:'catalog_changed',data:{catalogRev:rev()}})}
  function removeOp(op){delete OPS[op];post({type:'event',id:uid(),name:'catalog_changed',data:{catalogRev:rev()}})}
  return{install(o={}){ns=o.ns||ns;ver=o.version||ver;if('describe' in o)withDescribe=!!o.describe;if(!on){on=true;window.addEventListener('message',onMsg)}post({type:'hello',id:uid(),...body()})},
    uninstall(){on=false},callApp,addOp,removeOp,calcEval,OPS,rev};
})();
