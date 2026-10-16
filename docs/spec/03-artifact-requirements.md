# 아티팩트 요구사항: 브라우저 확장 연동 (위임 프로토콜 v2)

2026-10-16 · 이 문서는 Claude 채팅에서 아티팩트를 만들 때 그대로 첨부하는 요구사항이다. 설계 원본은 「확장 위임 프로토콜 설계 (1/2)」(3장 공통 계약, 3.8 능력 카탈로그, 4장 아티팩트 구현)이다. 둘이 어긋나면 원본을 따른다.

## 1. 만들 것

확장(claude-ex, 가칭)에 동작을 위임하고 결과를 받는 아티팩트. 첫 데모는 **수식 계산기**다. 사용자가 수식을 입력하면 확장의 `calc.eval`로 계산해서 결과를 보여 준다. 계산은 앱 안에서도 할 수 있지만, 이 데모의 목적은 연동 경로 전체(연결, 능력 발견, 상세 조회, 호출, 오류)를 확인하는 것이다.

핵심 요구는 두 가지다.

1. 확장이 제공하는 기능을 **하드코딩하지 않고 런타임에 발견**해서 화면에 보여 준다.
2. 확장이 없거나 오래돼도 앱이 깨지지 않는다(수식은 앱 내장 계산기로 폴백).

## 2. 전송과 봉투

- 같은 window의 `window.postMessage(msg, '*')`로 주고받는다. 수신 시 `e.source === window`를 확인한다. 메시지에 비밀을 싣지 않는다.
- 봉투 필드: `source`(앱은 `ab-app`, 확장은 `ab-ext`), `v`(2), `ns`(앱 식별자, 예 `calc-demo`, 정규식 `^[a-z0-9._-]{1,64}$`), `type`, `id`(UUID, 호출자가 만든다), `ts`(선택).
- type: `hello`, `hello_ack`, `call`, `progress`, `result`, `cancel`, `event`.
- 수신 필터 4중: `e.source === window`, `source === 'ab-ext'`, `ns`가 내 것, `v`와 `type`이 허용 목록. 맞지 않으면 조용히 무시하고 진단 패널에 거부 사유만 기록한다.

## 3. 연결(핸드셰이크)

- 마운트 때 0초, 1.5초, 4초에 `hello`를 보낸다. 6초까지 응답이 없으면 연결 상태를 `off`로 한다. 상태는 `wait`, `ok`, `off` 세 가지다.
- 확장의 `hello`를 받으면 즉시 같은 id로 `hello_ack`를 답한다. 확장의 `hello_ack`를 받으면 `ok`로 바꾼다. 확장이 먼저 올 수도, 나중에 올 수도 있다.
- 앱의 hello: `{role:'app', version, supportedVersions:[2], provides:[]}`. 이 데모는 확장이 부를 op가 없으므로 `provides`는 빈 배열이다.
- 호출이 timeout이거나 확장이 사라진 것으로 보이면 `off`로 내리고 hello를 다시 보낸다. `off`에서 `ok`로 돌아오면 카탈로그를 새로 받는다.
- 전제: 확장은 한 번에 하나만 켜 둔다. 한 ns에 `hello_ack`가 둘 이상 오는 경우는 다루지 않는다.

## 4. 능력 발견

### 4.1 1단계: 목록 (hello\_ack의 `provides`)

확장의 hello/hello\_ack에는 다음이 담긴다.

```json
{"type":"hello_ack","ok":true,"role":"ext","version":"0.1.0","supportedVersions":[2],"catalogRev":"a91f03",
 "provides":[
  {"op":"meta.describe","ver":1,"kind":"read","consent":false,"summary":"op와 어댑터의 상세 설명을 조회한다"},
  {"op":"calc.eval","ver":1,"kind":"read","consent":false,"summary":"사칙·거듭제곱·함수가 들어간 수식을 계산한다","state":"ready"},
  {"op":"text.transform","ver":1,"kind":"read","consent":false,"summary":"텍스트를 변환하거나 집계한다","state":"ready",
   "adapters":[{"id":"case-convert","summary":"대소문자·케이스 변환"},{"id":"char-count","summary":"글자·단어·줄 수 세기"}]}
 ]}
```

| 필드 | 의미 |
| --- | --- |
| op, ver | `도메인.동사` 이름과 정수 버전. `meta.`는 예약 도메인 |
| kind | `read`(부작용 없음), `write`(외부 변경), `sensitive`(사용자 확인 필수) |
| consent | 실행 전 확장 UI의 동의가 필요한지 |
| summary | 한 줄 용도(80자 이하) |
| adapters | 선택. op 아래에서 고르는 하위 대상 `[{id, summary}]` |
| state | `ready`(기본) 또는 `needs_setup`. `needs_setup`이면 `hint`를 사용자에게 안내하고 호출하지 않는다 |
| catalogRev | 카탈로그 해시. 바뀌면 캐시한 설명을 버린다 |

### 4.2 2단계: 상세 (`meta.describe`)

특정 op나 어댑터를 쓰기로 정했을 때 상세를 묻는다. 일반 call이다.

```json
{"source":"ab-app","v":2,"ns":"calc-demo","type":"call","id":"…","op":"meta.describe","ver":1,"args":{"op":"calc.eval"},"opts":{"timeoutMs":5000}}
```

| 인자 | 설명 |
| --- | --- |
| op (선택) | 조회할 op. 생략하면 전체 목록과 catalogRev |
| adapter (선택) | op의 어댑터 id. 지정하면 그 어댑터 상세만 |

결과에는 `description`(용도, 쓰는 때/아닌 때), `args`와 `result`(스키마), `errors[{code, when}]`, `limits`, `examples[≤3]`, 그리고 어댑터가 있으면 `adapters[{id, summary, description, params, hosts[], notes}]`가 담긴다. 없는 op나 어댑터는 `unsupported_op`이고 `detail.known`에 이름 목록이 있다.

스키마는 JSON Schema 부분집합이다. 쓰는 키워드는 `type`(object, string, number, integer, boolean, array), `properties`, `required`, `items`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `maxItems`, `default`, `description`이다. 스키마에 없는 필드는 거부된다.

### 4.3 앱이 지켜야 할 것

- `has(op, ver)`가 참일 때만 call을 보낸다. 없으면 다음 어댑터(앱 내장 계산기)로 간다.
- 확장이 `meta.describe`를 제공하지 않으면(구버전) 목록 요약만 보여 주고 상세는 "정보 없음"으로 표시한다.
- 코드에 인자 형식을 고정한 op(`calc.eval`)는 첫 호출 전에 `describe`의 `args` 스키마와 맞는지 한 번 확인한다. 맞지 않으면 그 경로를 끄고 폴백한다.
- `summary`, `description`, `examples`는 외부 입력이다. 화면에는 `textContent`로만 쓴다. 이 텍스트로 호출 대상이나 인자를 자동 생성해 실행하지 않는다.
- 이벤트 `catalog_changed`(`data.catalogRev`)나 hello의 catalogRev가 달라지면 캐시를 버리고 `meta.describe`(op 생략)로 목록을 새로 받는다.

### 4.4 예시: 어댑터를 찾고 사용하는 순서

어댑터는 op 아래에서 고르는 하위 대상이다. 개념 실증용 예시 op는 `text.transform`(어댑터 `case-convert`, `char-count`)이다. 아티팩트는 이름을 미리 알지 못해도 아래 순서로 쓴다.

1. **찾기**: `bridge.catalog()`에서 `adapters`가 있는 op를 고른다. 위 예시에서는 `text.transform`이고 어댑터가 둘이다. 화면에는 `summary`로 보여 주고, 사용자가 고르게 한다.
2. **상세 보기**: 고른 어댑터로 `bridge.describe('text.transform', 'case-convert')`를 부른다. 결과 예시:

```json
{"op":"text.transform","ver":1,"kind":"read","consent":false,"summary":"텍스트를 변환하거나 집계한다",
 "adapters":[{"id":"case-convert","summary":"대소문자·케이스 변환",
   "description":"텍스트를 지정한 케이스로 바꾼다. 줄바꿈은 유지한다.",
   "params":{"type":"object","required":["text","mode"],"properties":{
     "text":{"type":"string","maxLength":2000},
     "mode":{"type":"string","enum":["upper","lower","title","snake","kebab"]}}},
   "resultNotes":"data.text에 변환된 문자열"}],
 "result":{"type":"object","properties":{"text":{"type":"string"}}},
 "errors":[{"code":"invalid_request","when":"mode가 enum에 없거나 text가 2000자 초과"}]}
```

3. **인자 만들기**: `adapters[].params` 스키마로 입력 폼이나 인자를 만든다. 호출 전에 스키마 검증기로 한 번 검증한다.
4. **호출**: 어댑터 id는 `args.adapter`, 어댑터의 인자는 `args.params`에 담는다. 이 형식은 어댑터가 있는 모든 op에 같다.

```json
{"source":"ab-app","v":2,"ns":"calc-demo","type":"call","id":"…","op":"text.transform","ver":1,"args":{"adapter":"case-convert","params":{"text":"Hello World","mode":"snake"}},"opts":{"timeoutMs":5000}}
{"source":"ab-ext","v":2,"ns":"calc-demo","type":"result","id":"…","ok":true,"data":{"text":"hello_world"},"meta":{"elapsedMs":2}}
```

5. **실패 처리**: `unsupported_op`이면 `detail.known`의 어댑터 목록으로 다시 고르게 한다. `state`가 `needs_setup`이면 `hint`를 안내하고 호출하지 않는다.

## 5. 호출 수명주기

1. id를 만들고 pending에 등록한 뒤 `call`을 보낸다: `{op, ver, args, opts:{timeoutMs, idempotencyKey?}}`. 타이머는 `timeoutMs + 2000ms`.
2. 확장이 `progress`를 0회 이상 보낸다(초당 10회 이하). 화면에 반영한다.
3. 확장이 `result`를 정확히 한 번 보낸다. 성공은 `{ok:true, data, meta}`, 실패는 `{ok:false, error:{code, message, retryable, detail?}}`다. 그 뒤 같은 id의 메시지는 무시한다.
4. 사용자가 취소하면 `cancel`(id만)을 보내고 프로미스는 즉시 `cancelled`로 reject한다.
5. 타이머가 만료되면 `cancel`을 보내고 `timeout`으로 reject한다. 뒤늦게 온 result는 무시한다.
6. `retryable:true`일 때만 지수 백오프로 최대 2회 재시도한다. `write` op는 `idempotencyKey` 없이 재시도하지 않는다.

제한: 메시지 직렬화 1MiB 이하, timeoutMs 1,000~300,000(기본 60,000), 동시 pending 8건 이하.

오류 코드(분기는 `code`만 쓴다. 모르는 코드는 `internal`로 취급):
`invalid_request`, `unsupported_op`, `unsupported_version`, `busy`(재시도 가능), `timeout`(가능), `cancelled`, `not_granted`(`detail.hint` 안내), `blocked`, `network`(가능), `parse_failed`, `payload_too_large`, `ai_unavailable`(가능), `internal`. op 고유 코드는 소문자 snake\_case이며 이 데모에서는 `math_error`다. 오류 코드를 한국어 문구로 바꾸는 표를 한 곳에 둔다.

## 6. 첫 op: `calc.eval`

| 항목 | 내용 |
| --- | --- |
| 호출 | `op:'calc.eval'`, `ver:1`, kind `read` |
| args | `{expr: string(1~500자), vars?: {이름: number}(최대 16개), precision?: integer(0~15, 기본 12)}` |
| result.data | `{value: number, text: string}` |
| 연산 | `+ - * / % ^`, 괄호, 단항 `-`. 함수 `sqrt abs round floor ceil min max log ln exp sin cos tan`. 상수 `pi e` |
| 오류 | 문법 오류, 모르는 이름이나 함수는 `invalid_request`(`detail.pos`는 문자 위치). 0으로 나누기와 결과가 NaN·Infinity는 `math_error` |

예시:

```json
{"source":"ab-app","v":2,"ns":"calc-demo","type":"call","id":"b2e0…","op":"calc.eval","ver":1,"args":{"expr":"sqrt(x^2 + y^2)","vars":{"x":3,"y":4}},"opts":{"timeoutMs":5000}}
{"source":"ab-ext","v":2,"ns":"calc-demo","type":"result","id":"b2e0…","ok":true,"data":{"value":5,"text":"5"},"meta":{"elapsedMs":3}}
```

폴백: 확장이 없거나 `has('calc.eval',1)`이 거짓이거나 `off`이면 앱 내장 계산기로 같은 수식을 계산한다. 내장 계산기도 `eval`과 `Function`은 쓰지 않는다(재귀 하강 파서). 결과 화면에 어느 경로로 계산했는지(확장 또는 내장) 표시한다.

## 7. 화면 요구사항

| 요소 | 내용 |
| --- | --- |
| 상태줄 | 확장 연결됨(버전) / 확인 중 / 연결 없음, 다시 확인 버튼 |
| 계산기 | 수식 입력, 변수 입력(이름=값 목록), 계산 버튼, 취소 버튼(진행 중일 때), 결과와 계산 경로 표시, 오류 문구 |
| 능력 목록 패널 | provides를 op별로 표시(이름, kind 배지, summary, state, 어댑터 목록). 항목을 펼치면 `describe` 결과(설명, 인자·결과 스키마, 오류, 예시)를 표시. read op는 "예시로 호출" 버튼 |
| 진단 패널 | 링 버퍼 100건. id, type, op, v, ok, 수신 거부 사유만 기록하고 본문은 길이만 남긴다. 기본은 접힘 |

디자인 지침은 `artifact-design` 스킬을 따른다(라이트·다크 대응, 모바일 폭 대응).

## 8. 코드 구조 요구사항

- 기능 코드는 브리지 API만 쓰고 postMessage를 직접 다루지 않는다.
- 브리지 API(원본 4.2):

| API | 동작 |
| --- | --- |
| `bridge.ready()` | wait가 끝날 때까지(최대 6초) 기다려 상대 정보 또는 null |
| `bridge.has(op, ver)` | provides에 있는지 동기 확인 |
| `bridge.catalog()` | provides 스냅샷과 catalogRev (동기) |
| `bridge.describe(op, adapter?)` | `meta.describe` 호출. catalogRev가 같은 동안 캐시. 미제공이면 null |
| `bridge.refreshCatalog()` | 캐시를 버리고 목록을 다시 받음 |
| `bridge.call(op, args, {timeoutMs, signal, onProgress, idempotencyKey})` | 성공 `{data, meta}`, 실패 `{code, message, retryable, bridge:true}`로 reject |
| `bridge.on('state' \| 'event' \| 'catalog', fn)` | 상태 변경, 확장 이벤트, 카탈로그 변경 구독 |

- 순수 로직(스키마 검증기, 수식 파서, 오류 문구 변환)은 DOM 없이 단위 테스트할 수 있게 한 덩어리로 분리한다.
- 스키마 검증기는 4.2의 부분집합만 구현하면 된다.
- 외부에서 받은 문자열은 태그 제거와 길이 제한을 거친다. 화면에는 `textContent`로만 쓴다.

## 9. 이 데모에서 하지 않는 것

- v1(전용 프로토콜) 수신과 변환. 새 아티팩트는 v2만 구현한다.
- 확장이 앱의 op를 호출하는 경우(`ai.decide` 등). `provides`는 빈 배열이다.
- `write`, `sensitive` op. 확장의 동의 UI가 만들어지기 전에는 호출하지 않는다.
- 확장의 코드나 규칙을 원격에서 받아 실행하는 것.

## 10. 인수 기준 (모의 확장으로 확인)

같은 페이지에 모의 확장 스크립트(Mock Extension)를 넣어 아래를 재현한다. 모의 확장은 위 4.1의 예시와 같은 `hello_ack`를 보내고 `calc.eval`, `meta.describe`를 처리한다.

1. 확장 없음: 6초 뒤 `off`가 되고 계산은 내장 계산기로 되며 경로 표시가 "내장"이다.
2. 늦게 붙은 확장: 확장의 hello를 받으면 `ok`로 바뀌고 능력 목록 패널이 채워진다.
3. 능력 목록: `calc.eval`, `text.transform`, `meta.describe`가 보인다. `text.transform`의 어댑터 목록(`case-convert`, `char-count`)이 보인다. 모의 확장에 `needs_setup` 상태의 op 하나를 더 넣어 hint 표시와 호출 차단도 확인한다.
4. 상세 조회와 어댑터 사용: 어댑터를 고르면 `describe` 스키마로 입력 폼이 만들어지고, `case-convert`(text=`Hello World`, mode=`snake`)가 `hello_world`로 돌아온다. 항목을 펼치면 `describe` 결과(스키마, 오류, 예시)가 표시된다. 없는 op 조회는 `unsupported_op`의 `detail.known`을 안내 문구로 보여 준다.
5. 계산: `sqrt(x^2+y^2)`, x=3, y=4가 `5`로 표시되고 경로가 "확장"이다.
6. 오류: `1/0`은 `math_error`, `2+*3`은 `invalid_request`와 위치 표시, 모르는 함수는 `invalid_request`.
7. 취소와 타임아웃: 진행 중 취소 시 `cancelled`, 모의 확장이 응답하지 않으면 `timeoutMs + 2초` 뒤 `timeout`이고 뒤늦은 result는 무시된다.
8. 이상 메시지: 중복 result, 알 수 없는 오류 코드(→ `internal` 문구), 스키마 위반 결과, 다른 ns 메시지가 앱을 깨뜨리지 않고 진단 패널에만 기록된다.
9. 카탈로그 변경: 모의 확장이 `catalog_changed`를 보내면 캐시를 버리고 목록이 갱신된다.
10. 구버전 확장: `meta.describe` 없이 provides만 보내는 모의 확장에서 목록은 보이고 상세는 "정보 없음"이다. `calc.eval` 스키마 확인은 건너뛰고 호출한다.

## 11. 알려진 열린 쟁점

- 확장은 한 번에 하나만 켜 둔다는 전제다. 여럿이 켜졌을 때의 정책은 정하지 않았다.
- 기존 스킬 `artifact-extension-bridge`(ABP v2 브리지)는 이 문서를 기준으로 수정한다. 스킬에 꼭 들어가야 할 부분은 3장(핸드셰이크), 4장(능력 발견과 어댑터 사용), 5장(수명주기와 오류), 8장(브리지 API)이다.
