# 예시 1: 첫 연동 (calc.eval) 호출

가장 작은 op로 hello, 카탈로그, describe, call, result, 오류 경로를 한 번에 확인한다. 외부 권한이 없어 설치 직후 `ready`이고, 오류는 `invalid_request`(`detail.pos`)와 `math_error` 두 가지다. 모의 확장(`mock.js`)에 같은 op가 있다.

```js
const cleanText=(s,n)=>String(s==null?'':s).replace(/<[^>]*>/g,' ').replace(/[<>]/g,'').replace(/\s+/g,' ').trim().slice(0,n);
if(ABP.has('calc.eval')){
  try{
    const r=await ABP.call('calc.eval',{expr:'sqrt(x^2 + y^2)',vars:{x:3,y:4}},{timeoutMs:5000});
    show(cleanText(r.data.text,40));            /* "5" */
  }catch(e){show(ABP.errText(e))}               /* 0으로 나누기: math_error, 문법: invalid_request */
}
```

규격: args `{expr:string(1~500자), vars?:object(값 number), precision?:integer(0~15, 기본 12)}`, result `{value:number, text:string}`. 연산 `+ - * / % ^`, 괄호, 단항 `-`(거듭제곱보다 낮게 묶는다: `-2^2`는 -4). 함수 `sqrt abs round floor ceil min max log ln exp sin cos tan`, 상수 `pi e`. 모의 확장의 파서는 확장 쪽 참조 구현으로 써도 된다.
