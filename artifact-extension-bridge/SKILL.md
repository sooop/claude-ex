---
name: "artifact-extension-bridge"
description: "브라우저 확장과 연동하는 아티팩트를 만들 때 ABP v2 브리지(능력 카탈로그·meta.describe 포함), 진단 패널, 모의 확장을 적용하고 확장 개발용 어댑터 명세서를 출력한다. 외부 fetch, 파일 저장, 탭 입력 등을 확장에 위임할 때 사용."
---

# 아티팩트-확장 브리지 (ABP v2, 카탈로그 개정판)

아티팩트 환경이 못 하는 동작(외부 사이트 fetch, 로컬 파일 저장, 다른 탭 DOM 입력, 영속 저장 등)을 브라우저 확장에 위임하거나, 확장이 보내는 요청(예: AI 판정)에 아티팩트가 답하게 하는 프로토콜의 아티팩트 측 구현이다. 2026-10-16 개정 계약(능력 카탈로그, `meta.describe`, `catalog_changed`, 첫 구현 op `calc.eval`)을 반영했다. 코드와 동작 유형별 예시는 이 문서에 넣지 않고 프로젝트 "아티팩트 확장"의 `abp/` 문서로 분리했다. 설계 근거는 "확장 위임 프로토콜 설계 (1/2) 아티팩트 측과 공통 계약"(3.8, 4.2~4.3, 6.6)과 "(2/2) 브라우저 확장 측" 문서에 있다.

## 언제 쓰는가

- 아티팩트가 확장에 무언가를 시켜야 할 때(조회, 저장, 입력, 영속화).
- 확장이 아티팩트에 요청을 보낼 때(AI 판정 등)의 응답부를 만들 때.
- 확장 연결 상태 표시, 능력 카탈로그 확인, ping 진단 패널이 필요할 때.
- 쓰지 않는 경우: 확장이 전혀 관여하지 않는 아티팩트, 기존 v1(ping/pong, lookup, decide) 전용 코드의 단순 수정.

## 참고 파일 (프로젝트 "아티팩트 확장"의 abp/ 문서)

이 폴더의 `abp/` 디렉터리에 아래 파일이 함께 들어 있다. 파일을 직접 읽어 `cp`로 복사한다. 폴더가 없으면 프로젝트 "아티팩트 확장"의 같은 이름 문서를 `project_read`로 읽는다.

필요한 파일만 `Projects` 도구의 `project_read`로 읽는다. 코드 파일은 내용을 다시 쓰지 말고, 읽은 결과가 저장된 작업 폴더 파일을 `cat`이나 `cp`로 조립해 그대로 옮긴다.

| 파일 | 내용 | 읽는 때 |
| --- | --- | --- |
| `abp/bridge.js` | ABP 브리지 단일 블록(약 21KB). 호출자·제공자 역할, 카탈로그, describe, 호환 확인, 스키마 검증 | 항상. 앱 `<script>` 맨 앞에 복사 |
| `abp/diag.html` | 상태줄, 접이식 진단 패널(HTML+CSS+`ABPUI`) | 항상(상태 표시와 테스트용) |
| `abp/mock.js` | 모의 확장 `ABP_MOCK`(calc.eval, web.query, setup.demo, test.*) | 개발 중 테스트. 배포 전 제거 |
| `abp/example-calc-eval.md` | 가장 작은 첫 연동 예시 `calc.eval` | 처음 연동할 때 |
| `abp/example-call-adapter.md` | 확장 호출 + 폴백 어댑터 체인, 발견 순서, 재시도 규칙 | 확장에 일을 시킬 때 |
| `abp/example-serve.md` | 확장의 요청에 응답(`ABP.serve`, `ABP.policy`, 레이트 리밋) | 앱이 op를 제공할 때 |
| `abp/spec-template.md` | 확장 어댑터 명세서 마크다운 템플릿 | 명세서를 출력할 때 |

프로젝트나 문서에 접근할 수 없으면 코드를 기억으로 다시 쓰지 말고 사용자에게 알리고 문서를 첨부해 달라고 요청한다. 새로운 동작 유형(예: 파일 저장, 탭 입력)의 예시가 필요하면 같은 형식으로 `abp/example-<유형>.md`를 추가한다.

## 적용 순서

1. 만들려는 기능에서 필요한 op와 어댑터를 뽑아 "확장 어댑터 명세서" 초안을 먼저 출력한다(아래 절).
2. `abp/bridge.js`를 아티팩트 `<script>` 맨 앞에 복사한다. 복사한 뒤 `ABP.CFG.ns`(확장 쪽 설정과 동일)와 `appVersion`만 고친다.
3. 앱이 제공할 op는 `ABP.serve`로 등록한다(`example-serve.md`). `summary`와 `args` 스키마를 함께 준다.
4. 확장에 시킬 op는 `ABP.has`로 확인한 뒤 `ABP.call`로 호출하고, 확장이 없을 때의 폴백 체인을 둔다(`example-call-adapter.md`). 처음에는 `calc.eval`로 전체 경로를 확인한다(`example-calc-eval.md`).
5. `abp/diag.html`의 상태줄은 헤더에, `<details id="abpDiag">`는 페이지 맨 아래에 넣고 그 `<script>`(ABPUI)를 ABP 블록 뒤에 둔다.
6. 개발 중에는 `abp/mock.js`를 붙이고 `ABP_MOCK.install({ns: ABP.CFG.ns})`로 테스트한다. 배포 전에 반드시 제거한다.
7. 아래 점검 목록으로 확인한다.
8. 완료 후 확장 어댑터 명세서 최종본을 출력한다.

앱 초기화는 아래 세 줄이 기본이다.

```js
ABP.CFG.ns='my-app';ABP.CFG.appVersion='1.0.0';
/* ABP.serve(...) 등록들 */
ABP.start();ABPUI.mount();
```

게시 형식 주의: 외부 스크립트를 쓰지 않고 모든 JS와 CSS를 한 파일에 인라인한다. 브라우저 저장소를 쓰면 try/catch로 감싸고 없어도 동작하게 한다. 브리지 코드는 저장소를 쓰지 않는다.

## 확장 어댑터 명세서 출력 (개발 전 또는 중)

확장 측 개발자가 이 명세서만 보고 어댑터를 구현할 수 있어야 한다. 아티팩트를 만들 때 다음 시점에 채팅으로 출력한다.

- 개발 전: 요구에서 필요한 op와 어댑터를 뽑아 초안을 출력한다. 불확실한 부분은 가정으로 표시한다.
- 개발 중: op, 어댑터, 스키마가 바뀌면 변경 부분만 다시 출력한다.
- 완료 후: 앱 코드와 일치하는 최종본을 출력한다.

단일 출처 규칙: 명세서의 입출력 스키마는 앱 코드의 `ABP.call` 인자, `ABP.serve`의 `args`, 모의 확장의 `desc`와 같은 값이어야 한다. 한 곳을 고치면 나머지도 고친다. 이는 확장이 `meta.describe`로 돌려줄 값이기도 하다.

명세서에 담을 내용은 `abp/spec-template.md`를 따른다. 요약하면 다음과 같다.

- 연동 개요: op@ver, kind, consent, 어댑터, 필수 여부, 확장이 없을 때의 폴백.
- 확장이 구현할 op별 규격: 목적, 대상 호스트, args와 result 스키마, 오류 코드와 발생 조건, 한도(timeoutMs, 크기, 동시성), 파싱 주의와 앱이 적용하는 정제, 예시 call/result/오류.
- 앱이 제공하는 op(확장이 호출): 같은 형식과 사용자 토글, 분당 한도.
- 확장 구현 요구: `meta.describe`에 같은 규격 싣기, summary 80자·hint 120자 이하, `catalogRev`와 `catalog_changed`, 동의 UI가 필요한 kind, 테스트 방법(`calc.eval` 먼저, 이후 해당 op).

공통 계약(봉투, 메시지 유형, 공통 오류 코드)은 반복하지 않고 "ABP v2 공통 계약"을 참조한다고 적는다. op가 4개 이상이거나 규격이 길면 Claude Docs 문서로 만들고 채팅에는 요약과 링크만 둔다.

## 프로토콜 요약 (v2)

전송은 같은 window의 `postMessage`다. 봉투 필드는 `source`(`ab-app` 또는 `ab-ext`), `v`(2), `ns`, `type`, `id`, `ts`다. 개정 뒤에도 봉투 버전은 2이고 추가 필드는 하위 호환이다.

| type | 방향 | 설명 |
| --- | --- | --- |
| hello / hello_ack | 양방향 | 자기소개와 능력 협상. 본문은 `supportedVersions`, `catalogRev`, `provides[{op,ver,kind,consent,limits,summary,adapters,state,hint}]` |
| call | 호출자 → 제공자 | `op, ver, args, opts{timeoutMs, idempotencyKey}` |
| progress | 제공자 → 호출자 | `stage, detail, pct` |
| result | 제공자 → 호출자 | 호출당 정확히 1회. `ok:true,data,meta` 또는 `ok:false,error{code,message,retryable,detail}` |
| cancel | 호출자 → 제공자 | 진행 중인 id 중단 |
| event | 단방향 | 응답 없는 알림(`name, data`). `catalog_changed`는 `data.catalogRev`를 싣는다 |

오류 코드: invalid_request, unsupported_op, unsupported_version, busy(재시도 가능), timeout(재시도 가능), cancelled, not_granted, blocked, network(재시도 가능), parse_failed, payload_too_large, ai_unavailable, internal. op 고유 코드로 not_found, conflict, math_error가 있다. 알 수 없는 코드는 internal로 취급한다. 브리지가 호출 전에 만드는 `incompatible`(스키마 불일치)은 브리지 내부 코드다.

한도: 메시지 1MiB, 이진 16MiB, timeoutMs 1,000~300,000(기본 60,000), 호출자당 pending 8건, op별 동시 처리 1건, idempotencyKey 60초. 연결 상태는 wait → ok 또는 off이며 hello를 0초, 1.5초, 4초에 재시도하고 6초까지 응답이 없으면 off다. 호출 타이머는 timeoutMs에 2초 유예를 더하고, 타임아웃이 나면 off로 내려 다시 확인한다. 확장이 v2를 지원하지 않으면(`supportedVersions`에 2 없음) off와 안내 문구가 된다.

## 능력 카탈로그와 meta.describe

아티팩트는 확장이 무엇을 제공할지 작성 시점에 모르므로 두 단계로 발견한다. 목록은 hello의 `provides`(summary 80자, adapters[id, summary], state ready/needs_setup, hint 120자, 전체 16KiB 이하)이고, 상세는 `meta.describe` op(일반 call/result)로 가져온다. 인자는 `{op?, adapter?}`이며 op를 생략하면 `{provides, catalogRev}`, 지정하면 `{op, ver, kind, consent, summary, description, args, result, errors[{code,when}], limits, examples(최대 3), adapters[{id,summary,description,params,resultNotes,hosts,notes}]}`를 돌려준다. 없는 op나 어댑터는 `unsupported_op`과 `detail.known`이다. `meta.` 도메인은 예약이라 `ABP.serve`로 등록할 수 없다.

- `catalogRev`가 같은 동안 describe 결과를 캐시하고, 바뀌면(hello 또는 `catalog_changed`) 캐시를 버리고 목록을 다시 받는다. 16KiB를 넘는 provides의 hello는 거부한다.
- 스키마는 JSON Schema 부분집합이다. 허용: type(object, string, number, integer, boolean, array), properties, required, items, enum, minimum, maximum, minLength, maxLength, maxItems, default, description. `$ref`, `oneOf`, `anyOf`, `allOf`, `not`, `pattern`은 만나면 검증을 건너뛴다. 스키마에 없는 필드는 거부한다.
- `state:'needs_setup'`인 op는 보내지 않고 `not_granted`(`detail.hint`)로 바로 거부한다. hint를 사용자에게 안내한다.
- 호출 전 호환 확인: `ABP.call`이 op·어댑터·catalogRev별로 첫 호출 전에 한 번 describe 스키마와 인자를 대조한다. 맞지 않으면 보내지 않고 `incompatible`로 reject하니 다음 어댑터로 넘어간다. `meta.describe`가 없으면(구버전) 확인 없이 호출하고, `{check:false}`로 끌 수 있다.
- describe 텍스트(summary, description, hint, notes 등)는 확장발 외부 입력이다. 길이를 자르고 `<`, `>`를 제거해 textContent로만 출력하며, 앱 코드의 프롬프트나 실행 결정에 그대로 넣지 않는다.
- 아티팩트 안의 AI가 카탈로그로 op를 고르게 할 때, AI는 op 이름과 args 초안만 만든다. 호출 전에 `ABP.describe()` 스키마로 검증하고 `kind`가 `read`가 아니면 사용자 확인 UI를 거친다.

MCP 대응: provides는 `tools/list`, `meta.describe`는 도구 정의, `catalog_changed`는 `tools/list_changed`에 해당한다.

## API 요약

| API | 동작 |
| --- | --- |
| `ABP.start()` | 수신 리스너 등록과 hello 재시도 시작 |
| `ABP.ready()` | wait가 끝날 때까지 기다렸다가 상대 정보 또는 null |
| `ABP.has(op, ver)` | 연결 중이고 확장이 해당 op를 제공하는지(동기) |
| `ABP.catalog()` | `{catalogRev, provides[]}` 스냅샷(동기) |
| `await ABP.describe(op?, adapter?)` | `meta.describe` 결과(정제됨, 캐시). 미제공이면 null |
| `await ABP.refreshCatalog()` | 캐시를 버리고 목록 재수신(off→ok, catalog_changed 때 자동) |
| `ABP.call(op, args, {ver, timeoutMs, signal, onProgress, idempotencyKey, check})` | `{data, meta}`로 resolve, `{code,message,retryable,detail,bridge:true}`로 reject |
| `ABP.serve(op, {ver, kind, consent, summary, adapters, description, args, result, errors, examples, state, hint, limits, validate, handler})` | 확장이 호출할 op 등록. args 스키마 검증 후 `validate`가 `{value}`/`{err}` 반환 |
| `ABP.validateSchema(schema, value)` | `{value, skip}` 또는 `{err}` |
| `ABP.policy = (op, def, msg) => null \| {code, message, retryable}` | 제공자 쪽 사용자 토글 훅 |
| `ABP.rateLimit(key, perMin)` | 분당 한도 검사. 초과 시 false |
| `ABP.ping()` | hello 왕복 시간과 확장 정보 |
| `ABP.on('state' \| 'log' \| 'catalog', fn)`, `ABP.on('event', name, fn)` | 구독. 반환값은 해제 함수 |
| `ABP.emit(name, data)` | 응답 없는 event 전송 |
| `ABP.errText(e)` | 오류 코드를 한국어 문구로 변환 |

진단 패널(`abp/diag.html`)은 접어 두면 렌더하지 않고, 펼치면 확장 정보(버전, catalogRev), 능력 카탈로그(kind, 설정 필요 표시, 어댑터, op별 상세 보기), 카탈로그 새로고침, ping, 다시 확인, 기록 지우기·복사, 테스트 호출(describe 예시 채우기), 최근 100건 송수신 기록(본문 없이 길이만)을 보여준다. 모든 값은 textContent로만 그린다.

## 점검 목록

- [ ] 개발 전 확장 어댑터 명세서 초안을 출력했고, 완료 후 앱 코드와 일치하는 최종본을 출력했다.
- [ ] 명세서 스키마, `ABP.call` 인자, `ABP.serve` args, 모의 확장 `desc`가 같은 값이다.
- [ ] `ABP.CFG.ns`가 확장 쪽과 같고 앱 버전을 넣었다.
- [ ] 상태줄이 확인 중, 연결됨(버전), 연결 없음 + 다시 확인으로 바뀐다.
- [ ] 확장이 없을 때 6초 뒤 off가 되고 폴백 어댑터로 기능이 계속 동작한다.
- [ ] 모의 확장으로 성공, 진행률, 취소, 타임아웃, 알 수 없는 op, 오류 코드(`test.fail`)를 확인했다.
- [ ] 확장 → 앱 방향은 `ABP_MOCK.callApp`으로 스키마 위반(invalid_request), 동시 호출(busy), 정책 거부(not_granted), 멱등 키를 확인했다.
- [ ] 카탈로그 시나리오: describe 미제공(`install({describe:false})`)에서 `describe()`가 null이고 call이 진행된다. 알 수 없는 op는 `unsupported_op`과 `detail.known`이다. `addOp`/`removeOp` 뒤 `catalog_changed`로 목록과 캐시가 갱신된다. needs_setup은 전송 없이 안내가 나온다. 스키마와 다른 인자는 `incompatible`로 막히고 다음 어댑터로 넘어간다.
- [ ] 확장에서 받은 모든 문자열(결과, describe 텍스트 포함)을 정제했고 textContent나 이스케이프로만 출력했다. 프롬프트에 그대로 넣지 않는다.
- [ ] 앱의 비밀이나 저장 데이터 전체를 메시지에 싣지 않는다. write/sensitive op는 확장의 동의 UI와 앱의 사용자 확인을 거친다.
- [ ] 진단 패널은 접힌 기본 상태이고 기록에는 본문이 아닌 길이만 남는다.
- [ ] 배포 전에 모의 확장 코드와 `ABP_MOCK.install` 호출을 제거했다.
- [ ] 아티팩트로 게시할 때 외부 스크립트가 없고 모든 JS와 CSS가 인라인이다.

## 주의

- 이 스킬은 v2 전용이다. 기존 우편번호 변환기의 v1(`postal-converter`/`postal-bridge`, ping/pong, lookup, decide) 확장과는 직접 통신하지 않는다.
- 개정 이전 코드(카탈로그 없는 hello)와도 호환된다. summary, catalogRev, meta.describe가 없어도 `has`와 `call`은 동작하고 `describe()`는 null이다.
- postMessage 채널은 인증되지 않는다. 같은 window의 다른 스크립트가 확장이나 앱을 위장할 수 있으므로 권한이 필요한 동작의 동의는 확장 UI가 맡는다.
- 범용 op(임의 URL fetch, 임의 프롬프트 실행)를 만들지 않는다. op는 항상 좁고 인자 스키마와 접근 대상이 고정되어야 한다. 카탈로그에 있다는 이유만으로 op를 호출하지 않는다.
- 새 op 설계와 확장 구현은 "확장 위임 프로토콜 설계 (2/2) 브라우저 확장 측" 문서의 op 레지스트리, 권한, 서비스 워커 수명 규칙을 따른다.
