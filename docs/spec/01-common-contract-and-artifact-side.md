# 확장 위임 프로토콜 설계 (1/2) 아티팩트 측과 공통 계약

Oct 16, 2026 · @sooop

개정(2026-10-16): 능력 카탈로그(hello의 `summary`·`adapters`·`catalogRev`)와 상세 조회 op `meta.describe`를 추가했다(3.3, 3.8). 첫 구현 op로 수식 계산 `calc.eval`을 추가했다(6.6). 봉투 버전 `v`는 2로 유지한다(필드 추가는 하위 호환, 3.7).

## 요약

결론: 현행 우편번호 변환기의 전용 postMessage 프로토콜(v1)을, 어떤 아티팩트에도 쓸 수 있는 op 단위 양방향 RPC(v2)로 일반화한다. 아티팩트는 확장에 동작을 위임하는 호출자이면서, 확장의 요청에 답하는 제공자도 된다. 확장은 op 레지스트리로 권한이 필요한 동작을 실행한다.

설계 원칙은 여섯 가지다.

- 좁은 op: 임의 URL fetch나 임의 프롬프트 같은 범용 op는 두지 않는다. 모든 op는 고정된 인자 스키마를 갖고, 접근 대상(도메인, 프롬프트 템플릿)이 op에 묶여 있다.
- 상호 불신: 양측 모두 상대 메시지를 스키마, 크기, 텍스트 정제로 검증한다. 웹 페이지에서 긁어온 값은 데이터일 뿐 지시문이 아니다.
- 확장 없이도 동작: 확장이 없으면 Claude 호출, 그것도 안 되면 수동 입력으로 내려가는 어댑터 체인을 유지한다.
- 능력 협상: 핸드셰이크에서 op 목록과 버전을 교환하고, 상대가 제공하지 않는 op는 보내지 않는다.
- 능력 발견: 아티팩트는 작성 시점에 확장이 무엇을 제공할지 알 수 없다. 그래서 hello에서 op·어댑터의 목록과 한 줄 용도를 알려 주고, 상세(인자·결과 형식, 오류, 예시)는 `meta.describe`로 물어보게 한다. MCP의 `tools/list`와 도구 정의 조회에 대응하되, 전송·세션·동의는 이 프로토콜의 것을 그대로 쓴다(3.8).
- 호출당 결과 하나: 모든 call은 성공, 오류, 타임아웃, 취소 중 하나로 정확히 한 번 끝난다.

이 문서(1/2)는 공통 계약(3장)과 아티팩트 구현(4장)을 다룬다. 확장 구현은 2/2 문서에 있다.

## 2. 아키텍처

아티팩트는 신뢰 경계가 다른 세 영역을 거쳐서만 확장의 자원에 닿는다.

&#91;embedded content: 아키텍처 · 신뢰 경계 3개\]

위임 호출은 왼쪽에서 오른쪽으로, 확장발 요청(`ai.decide` 등)은 오른쪽에서 왼쪽으로 같은 통로를 지난다. 강조한 두 박스가 프로토콜의 양 끝점이다.

- 아티팩트: 화면, 판정 로직, Claude 호출을 가진다. 외부 네트워크와 파일 시스템에는 접근하지 못한다.
- 콘텐츠 스크립트: 페이지와 확장 사이를 중계할 뿐, 권한이 필요한 동작을 하지 않는다.
- 서비스 워커: op 레지스트리와 chrome.\* 권한을 가진다. 호출마다 스키마, 권한, 동의를 확인한다.

## 3. 공통 프로토콜 v2

이 장이 아티팩트와 확장 양쪽이 지키는 계약이다. 2/2 문서는 이 장을 그대로 참조한다.

### 3.1 전송과 봉투

전송은 같은 window의 `window.postMessage`다. 확장 콘텐츠 스크립트가 아티팩트 프레임에 주입되어 같은 window를 공유한다. 수신 측은 `e.source === window`를 확인한다. 샌드박스 iframe의 오리진이 불투명(`null`)일 수 있어 targetOrigin은 `'*'`를 쓰되, 동일 window의 다른 스크립트가 읽을 수 있으므로 메시지에 비밀을 싣지 않는다.

| 필드 | 필수 | 설명 |
| --- | --- | --- |
| source | 예 | `ab-app`(아티팩트) 또는 `ab-ext`(확장) |
| v | 예 | 프로토콜 정수 버전. 현재 2 |
| ns | 예 | 앱 식별자(예: `postal-converter`). 한 페이지의 여러 앱과 확장 내 설정을 구분 |
| type | 예 | `hello`, `hello_ack`, `call`, `progress`, `result`, `cancel`, `event` |
| id | 예 | 호출 상관 ID(UUID). 호출자가 만든다. 호출 하나에 id 하나 |
| ts | 아니오 | 송신 시각(ms). 진단용 |

### 3.2 메시지 유형

| type | 방향 | 용도 | 주요 필드 |
| --- | --- | --- | --- |
| hello | 양방향 | 시작 시와 재시도 시 자기 소개 | role, version, supportedVersions, provides\[\], catalogRev, limits |
| hello\_ack | 양방향 | hello에 대한 응답. 같은 id | hello와 동일 + ok |
| call | 호출자 → 제공자 | op 실행 요청 | op, ver, args, opts{timeoutMs, idempotencyKey} |
| progress | 제공자 → 호출자 | 진행 상황 | stage, detail, pct |
| result | 제공자 → 호출자 | 최종 결과. 호출당 정확히 1회 | ok, data, meta 또는 error{code, message, retryable, detail} |
| cancel | 호출자 → 제공자 | 진행 중인 호출 중단 | 없음(id만) |
| event | 단방향 | 응답 없는 알림(권한 변경, 사용자 선택 등) | name, data |

호출자와 제공자는 고정된 역할이 아니다. 아티팩트가 확장의 op를 호출할 수 있고, 확장이 아티팩트의 op를 호출할 수 있다. 같은 봉투와 같은 수명주기를 쓴다.

### 3.3 핸드셰이크와 능력 협상

아티팩트 로드와 확장 주입의 순서는 보장되지 않는다. 그래서 양쪽이 모두 hello를 보내고, 상대의 hello를 받으면 즉시 hello\_ack로 답한다. 아티팩트는 마운트 때 0초, 1.5초, 4초에 hello를 재시도하고, 6초까지 응답이 없으면 "확장 연결 없음"으로 표시한다(현행 v1 값 유지).

`provides` 항목은 다음 필드를 갖는다.

| 필드 | 설명 |
| --- | --- |
| op | `도메인.동사` 형태의 이름(예: `web.query`) |
| ver | op 자체의 버전 정수 |
| kind | `read`(부작용 없음), `write`(외부 변경), `sensitive`(사용자 확인 필수) |
| consent | 실행 전 사용자 동의가 필요한지 여부 |
| limits | op별 제한(maxConcurrent, 최대 페이로드, 허용 대상 등) |
| summary | 한 줄 용도(80자 이하, 필수). 사람과 아티팩트의 능력 목록 화면이 읽는다 |
| adapters | 선택. op 아래에 고르는 하위 대상이 있을 때만 `[{id, summary}]`. id는 `^[a-z0-9-]{1,32}$`, summary는 80자 이하 |
| state | 선택. `ready`(기본) 또는 `needs_setup`(호스트 권한이나 오리진 허용처럼 사용자 조치가 필요). `needs_setup`이면 `hint`(120자 이하)를 함께 둔다 |

hello 최상위의 `catalogRev`(32자 이하 문자열)는 카탈로그 내용의 해시다. 값이 같으면 이전에 받은 설명을 다시 쓸 수 있다. provides 전체의 직렬화 크기는 16KiB 이하로 둔다. 상세 설명은 hello에 싣지 않고 3.8의 `meta.describe`로 가져온다.

호출자는 상대의 `provides`에 op와 ver가 있을 때만 call을 보낸다. 연결 상태는 `wait`, `ok`, `off` 세 가지다. 호출이 timeout을 냈거나 확장이 사라진 것으로 보이면 `off`로 내리고 hello를 다시 보낸다.

### 3.4 호출 수명주기

1. 호출자가 id를 만들고 pending에 등록한 뒤 call을 보낸다. 타이머는 `timeoutMs + 2000ms`(유예 2초)다.
2. 제공자는 스키마와 동시성을 검사한다. 실패하면 작업 없이 즉시 `invalid_request`, `unsupported_op`, `busy` 중 하나로 result를 보낸다.
3. 작업 중 progress를 0회 이상 보낸다(초당 10회 이하).
4. 제공자는 result를 정확히 한 번 보낸다. 그 뒤 같은 id의 메시지는 호출자가 무시한다.
5. 호출자가 취소하면 cancel을 보내고 자신의 프로미스는 즉시 `cancelled`로 reject한다. 제공자는 작업을 중단하고 `cancelled` result를 남긴다.
6. 타이머가 만료되면 호출자는 cancel을 보내고 `timeout`으로 reject한다.

`kind`가 `write`인 op는 `opts.idempotencyKey`를 받아, 같은 키의 재전송을 60초 동안 이전 결과로 답한다. 동시성 기본값은 op당 1건이고, 초과하면 `busy`(재시도 가능)를 돌려준다.

배선 예시 하나는 다음과 같다(호출과 성공 결과).

```json
{"source":"ab-app","v":2,"ns":"postal-converter","type":"call","id":"6f1c…","op":"web.query","ver":1,"args":{"adapter":"epost-zip","params":{"oldAddr":"서울시 강남구 역삼동 736-1"}},"opts":{"timeoutMs":15000}}
{"source":"ab-ext","v":2,"ns":"postal-converter","type":"result","id":"6f1c…","ok":true,"data":{"items":[{"zip5":"06232","road":"…"}]},"meta":{"elapsedMs":812}}
```

### 3.5 오류 코드

오류는 `error{code, message, retryable, detail?}` 형태다. `message`는 사람이 읽는 짧은 문장이고, 호출자는 논리 분기에 `code`만 쓴다. 알 수 없는 코드는 `internal`로 취급한다.

| code | 재시도 | 의미 |
| --- | --- | --- |
| invalid\_request | 아니오 | 스키마·크기 위반 |
| unsupported\_op | 아니오 | op 또는 op 버전 미지원 |
| unsupported\_version | 아니오 | 봉투 버전 불일치 |
| busy | 예 | 동시성 한도 초과 |
| timeout | 예 | 제한 시간 초과 |
| cancelled | 아니오 | 호출자가 취소 |
| not\_granted | 아니오 | 사용자 권한 또는 동의 없음. detail.hint에 안내 문구 |
| blocked | 아니오 | 대상 사이트가 차단하거나 확인 절차 요구 |
| network | 예 | 네트워크 실패 |
| parse\_failed | 아니오 | 대상 응답을 해석하지 못함 |
| payload\_too\_large | 아니오 | 입력 또는 결과 크기 초과 |
| ai\_unavailable | 예 | AI 호출 불가(권한, 한도, 세션 만료) |
| internal | 아니오 | 제공자 내부 오류 |

op 고유 코드는 소문자 snake\_case로 추가할 수 있다. 6장의 예에서는 `not_found`(대상 탭 없음, 재시도 아니오)와 `conflict`(rev 충돌, 재시도 아니오), `math_error`(수식 계산 불가, 재시도 아니오)를 쓴다.

### 3.6 기본 제한

| 항목 | 값 |
| --- | --- |
| 메시지 직렬화 크기 | 1MiB 이하 |
| 바이너리(ArrayBuffer, transfer) | op가 선언한 한도, 최대 16MiB |
| timeoutMs | 1,000\~300,000, 기본 60,000 |
| 동시 pending 호출(호출자당) | 8건 |
| progress 빈도 | 초당 10회 이하 |
| 문자열 필드 | op 스키마가 길이를 명시(현행 후보 필드는 300자) |

### 3.7 버전 정책

봉투 버전 `v`와 op 버전 `ver`는 따로 올린다. 필드 추가는 하위 호환이고, 수신 측은 알 수 없는 필드를 무시한다. 필수 필드를 바꾸면 해당 op의 `ver`를 올리고, 이전 `ver`를 최소 한 릴리스 동안 같이 제공한다.

### 3.8 능력 카탈로그와 `meta.describe`

확장은 기능이 늘고 사용자마다 설치 버전이 다르다. 그래서 아티팩트는 런타임에 두 단계로 능력을 발견한다.

1. 목록(hello): `provides`의 op·ver·kind·summary·adapters·state로 "무엇이 있는지"를 안다.
2. 상세(`meta.describe`): 쓰기로 정한 op나 어댑터 하나에 대해 "어떻게 부르는지"를 묻는다.

`meta.describe`는 일반 op와 같은 call/result 수명주기를 쓴다. 새 메시지 유형을 만들지 않으므로 봉투 검증, 타임아웃, 크기 제한이 그대로 적용된다. 확장은 이 op를 항상 등록한다(kind `read`, consent `none`, 동시성 4건).

인자와 결과는 다음과 같다.

| 구분 | 필드 | 설명 |
| --- | --- | --- |
| args | `op`(선택) | 조회할 op 이름. 생략하면 전체 목록을 돌려준다 |
| args | `adapter`(선택) | `op`가 가진 어댑터 id. 지정하면 그 어댑터의 상세만 담는다 |
| result(op 지정) | `op`, `ver`, `kind`, `consent`, `summary` | provides와 같은 값 |
| result(op 지정) | `description` | 용도, 쓰는 때, 쓰지 않는 때(2,000자 이하) |
| result(op 지정) | `args`, `result` | 인자와 결과의 스키마(아래 부분집합) |
| result(op 지정) | `errors` | `[{code, when}]`. 이 op가 돌려줄 수 있는 오류와 조건. op 고유 코드 포함 |
| result(op 지정) | `limits` | provides.limits와 같은 값에 필드 설명을 더한 것 |
| result(op 지정) | `examples` | 최대 3건 `[{title, args, result}]`, 건당 2KiB 이하 |
| result(op 지정) | `adapters` | 있을 때만. `[{id, summary, description, params, resultNotes, hosts[], notes}]`. 어댑터를 지정하면 한 건만 담는다 |
| result(op 생략) | `provides`, `catalogRev` | hello와 같은 내용. 아티팩트가 목록을 새로 고칠 때 쓴다 |

존재하지 않는 op나 어댑터는 `unsupported_op`이다(`detail.known`에 있는 이름 목록을 담는다).

스키마는 JSON Schema의 부분집합만 쓴다. 허용 키워드는 `type`(object, string, number, integer, boolean, array), `properties`, `required`, `items`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `maxItems`, `default`, `description`이다. `$ref`, `oneOf`, `anyOf`, 정규식 패턴은 쓰지 않는다. 아티팩트가 작은 검증기를 직접 구현할 수 있게 하고, 나중에 MCP의 `inputSchema`로 옮기기 쉽게 하려는 선택이다. 스키마에 없는 필드는 거부한다(`additionalProperties: false`가 기본).

카탈로그가 바뀌는 경우(사용자가 호스트 권한을 줬거나, 어댑터가 추가·제거됐을 때) 확장은 `event`를 보낸다.

```json
{"source":"ab-ext","v":2,"ns":"postal-converter","type":"event","id":"…","name":"catalog_changed","data":{"catalogRev":"a91f03"}}
```

아티팩트는 이 이벤트나 hello의 `catalogRev`가 이전과 다르면 설명 캐시를 버리고 `meta.describe`(op 생략)로 목록을 다시 받는다.

신뢰 규칙: `summary`, `description`, `examples`는 확장이 만든 문자열이지만 아티팩트에게는 외부 입력이다. 화면에는 `textContent`로만 쓰고, AI 프롬프트에 넣을 때는 데이터 구획 안에 넣는다. 아티팩트는 이 텍스트에서 호출 대상이나 인자를 자동으로 만들어 실행하지 않는다.

이 설계가 MCP와 겹치는 부분과 일부러 채택하지 않은 부분은 다음과 같다.

| 이 프로토콜 | MCP | 비고 |
| --- | --- | --- |
| hello.provides | `tools/list` | 목록과 요약 |
| `meta.describe` | 도구 정의(`inputSchema`, `description`) | 상세. MCP는 목록에 스키마까지 싣지만, 여기서는 hello 크기를 줄이려고 나눴다 |
| call / result / progress / cancel | `tools/call` / 결과 / progress 알림 / 취소 알림 | 거의 같은 의미 |
| event `catalog_changed` | `tools/list_changed` | |
| `kind`, `consent`, 확장 UI 동의 | (없음, 클라이언트가 처리) | 브라우저 확장이라 동의를 프로토콜이 규정해야 한다 |
| (채택 안 함) | resources, prompts, sampling, roots, 세션 초기화 협상 | 아티팩트가 필요로 하지 않고, 같은 window를 공유하는 페이지 스크립트에게 공격면을 넓힌다 |

op 이름은 `도메인.동사`이고 `meta.` 도메인은 프로토콜 예약이다. 확장은 한 번에 하나만 켜 두는 것을 전제로 하며, 여러 확장이 동시에 응답하는 경우의 정책은 정하지 않는다.

어댑터가 있는 op의 호출 형식은 모든 op에 같다. 어댑터 id는 `args.adapter`, 어댑터의 인자는 `args.params`에 담는다(3.4의 `web.query` 예시와 같은 형태). 어댑터를 찾고 쓰는 순서(목록 → `describe(op, adapter)` → 스키마로 인자 작성 → call)의 예는 별도 요구사항 문서의 4.4절에 있다.

## 4. 아티팩트 구현 설계

아티팩트는 전송층 하나와 두 가지 역할(호출자, 제공자)을 분리해 구현한다. 기능 코드는 브리지 API만 쓰고 postMessage를 직접 다루지 않는다.

### 4.1 모듈 구성

| 모듈 | 책임 |
| --- | --- |
| Bridge(전송층) | 수신 필터, hello 재시도, 연결 상태(wait, ok, off), pending 맵, 진단 링 버퍼 |
| Catalog | hello의 provides 보관, `meta.describe` 호출과 `catalogRev` 기준 캐시, `catalog_changed` 처리 |
| Caller | `bridge.call`: id 발급, 타이머, 취소, progress 전달, 결과 검증 직전까지 |
| ServeRegistry | `bridge.serve`: op 등록, 스키마 검증, 동시성, 타임아웃, 취소 |
| Adapter chain | 기능별 폴백 순서: 확장 → Claude 호출 → 수동 입력 |
| Policy | 사용자 토글, 레이트 리밋, 사용자 확인 UI |
| Diag | 진단 패널과 수신 거부 사유 기록 |

순수 로직(검증, 정제, 판정)은 현행처럼 한 덩어리(PURE 구간)로 분리해 DOM 없이 단위 테스트할 수 있게 한다.

### 4.2 브리지 API

| API | 동작 |
| --- | --- |
| `bridge.ready()` | wait 상태가 끝날 때까지(최대 6초) 기다렸다가 상대 정보 또는 null을 돌려준다 |
| `bridge.has(op, ver)` | 상대의 provides에 있는지 동기적으로 확인 |
| `bridge.catalog()` | 현재 provides 스냅샷(op, ver, kind, summary, adapters, state)과 `catalogRev`를 동기적으로 돌려준다. 연결 전에는 빈 목록 |
| `bridge.describe(op, adapter?)` | `meta.describe`를 호출해 상세를 돌려준다. `catalogRev`가 같은 동안 캐시하고, 상대가 `meta.describe`를 제공하지 않으면 `null` |
| `bridge.refreshCatalog()` | 캐시를 버리고 목록을 다시 받는다. 연결 상태 `off`에서 `ok`로 돌아왔을 때도 자동 호출 |
| `bridge.call(op, args, {timeoutMs, signal, onProgress, idempotencyKey})` | 성공 시 `{data, meta}`, 실패 시 `{code, message, retryable, bridge:true}`로 reject |
| `bridge.serve(op, {ver, kind, validate, limits, handler})` | 확장이 호출할 op 등록. handler는 `{args, signal, progress(stage, detail, pct)}`를 받아 data를 돌려준다 |
| `bridge.on('state' \| 'event', fn)` | 연결 상태 변경과 확장 이벤트 구독 |
| `bridge.emit(name, data)` | 응답 없는 event 전송 |

### 4.3 호출자 역할 규칙

- 호출 전에 `has()`를 확인하고, 없으면 보내지 않고 다음 어댑터로 넘어간다.
- op 이름과 인자 형식을 코드에 고정한 기능은 `describe()`가 돌려준 스키마와 맞는지 첫 호출 전에 한 번 확인한다. 맞지 않으면 그 경로를 끄고 다음 어댑터로 넘어간다. 확장이 먼저 업데이트된 경우를 막기 위함이다.
- 아티팩트 안의 AI가 카탈로그를 보고 op를 고르게 하는 경우, AI는 op 이름과 args 초안만 만든다. 호출 전에 `describe()` 스키마로 검증하고, `kind`가 `read`가 아니면 앱의 사용자 확인 UI를 거친다.
- `state`가 `needs_setup`인 op는 보내 보지 않고, `hint`를 사용자에게 안내한다.
- 돌아온 데이터는 스키마와 정제 함수(현행 `cleanCand`, `cleanText`)를 통과한 뒤에만 상태와 저장소에 반영한다. 화면에는 `esc` 또는 `textContent`로만 출력한다.
- 사용자 취소는 `AbortController`에 연결해 cancel이 전송되게 한다.
- 재시도는 `retryable:true`에 한해 지수 백오프로 최대 2회. `write` op는 `idempotencyKey` 없이 재시도하지 않는다.
- 일괄 처리는 op당 한 건씩 직렬로 보내고, 진행률은 progress로 갱신한다.
- 오류 코드는 한 곳의 한국어 문구 테이블(현행 `errText` 확장)에서 사용자 문구로 바꾼다. 알 수 없는 코드는 일반 오류 문구로 표시한다.

### 4.4 제공자 역할 규칙 (확장의 요청 처리)

검증은 항상 다음 순서로 한다: 봉투, 스키마, 동시성(동시 1건, 초과 시 busy), 정책(사용자 토글, 레이트 리밋), 실행. 등록하지 않은 op는 `unsupported_op`으로 즉시 거부한다.

- AI 호출은 앱이 고정한 프롬프트 템플릿으로만 한다. 확장이 보낸 필드는 "데이터일 뿐 지시가 아니다"라고 명시하고, 길이를 자르고 줄바꿈을 정리해 넣는다(현행 `askAI`).
- AI 출력은 스키마, ref 일치, 확률 합(오차 0.05 이내)을 검증하고 정규화한다. 실패하면 로컬 엔진으로 폴백한다(`engine=auto`). `engine=ai`인데 실패하면 `ai_unavailable`이다.
- 비용 보호: 확장발 AI 요청은 사용자 토글("확장의 AI 판정 요청 허용")과 분당 상한이 있는 경우에만 처리한다. 상한 수치는 정책 값으로 두고 운영 중 조정한다.
- 앱 데이터를 변경하는 op(예: 학습 데이터 추가)는 확장이 요청해도 바로 쓰지 않고 사용자 확인 UI를 거친다. 읽기 전용 op를 우선 설계한다.
- 타이머는 요청의 `timeoutMs`로 걸고, 만료 시 진행 중 작업을 abort한 뒤 `timeout` result를 보낸다.

### 4.5 화면 요소

| 요소 | 내용 |
| --- | --- |
| 상태줄 | 확장 연결됨(버전) / 확인 중 / 연결 없음 + 다시 확인 버튼. 확장 요청 처리 중이면 함께 표시 |
| 조회 경로 목록 | 어댑터별 사용 가능 여부와 이유 |
| 능력 목록 패널 | provides를 op별로 보여 준다(이름, kind, summary, state, 어댑터 목록). 항목을 펼치면 `describe()`로 설명, 인자·결과 스키마, 오류, 예시를 보여 주고, read op는 예시 인자로 시험 호출하는 버튼을 둔다 |
| 배너 | 확장이 필요한 기능을 쓸 때만 안내 |
| 사용자 설정 | 확장 요청 허용 토글, AI 모델 등급 |
| 진단 패널 | 링 버퍼 100건. id, type, op, v, ok, 수신 거부 사유만 기록하고 본문은 길이만 남긴다 |

현행 아티팩트의 "연동 진단(임시)" 패널을 이 구조로 정식화하고, 출시 빌드에서는 숨김 기본값으로 둔다.

### 4.6 보안 체크리스트

- 수신 필터 4중: `e.source === window`, `source`, `ns`, `v`와 `type` 허용 목록.
- 모든 외부 문자열은 태그 제거와 길이 제한을 거친다.
- 앱의 비밀이나 학습 데이터 전체를 메시지에 싣지 않는다. args는 op에 필요한 최소만 보낸다.
- postMessage 채널은 인증되지 않는다. 같은 window의 다른 스크립트가 위장할 수 있으므로, 위험한 op는 확장의 동의(2/2 문서)와 앱의 사용자 확인을 모두 거친다.
- 동시성 한도와 레이트 리밋으로 폭주를 막는다.

### 4.7 테스트

같은 페이지에 모의 확장(Mock Extension) 스크립트를 넣고 아래 시나리오를 재현한다. 확장 없음(6초 후 off), 늦게 붙은 확장(hello 수신으로 ok 전환), 호출 중 취소, 타임아웃 뒤 뒤늦게 온 result 무시, busy, 중복 result, 알 수 없는 오류 코드, 스키마 위반 결과, 큰 페이로드. 카탈로그 시나리오로 `meta.describe` 미제공(구버전 확장), 알 수 없는 op 조회(`unsupported_op`과 `detail.known`), `catalogRev` 변경 뒤 캐시 폐기, `catalog_changed` 수신, `needs_setup` op, 스키마에 없는 인자를 쓰는 앱 코드의 경로 차단을 추가한다. PURE 구간의 검증·정제 함수는 입력 조합으로 단위 테스트한다.

## 5. 현행 v1 구현과의 대응과 이전

현행 우편번호 변환기의 메시지는 v2의 특수한 사례로 그대로 옮겨진다. 새 아티팩트는 v2만 구현하고, 이 아티팩트는 아래 순서로 이전한다.

| v1 (현행) | v2 |
| --- | --- |
| source `postal-converter` / `postal-bridge` | source `ab-app` / `ab-ext`, ns `postal-converter` |
| ping → pong (앱이 확장 탐색) | hello → hello\_ack |
| probe → ready (확장이 앱 탐색, engines·limits 안내) | hello → hello\_ack. engines·limits는 `provides[].limits`로 이동 |
| lookup → result (우체국 조회) | call `web.query`(adapter `epost-zip`) → result |
| decide → decision (확장이 아티팩트에 AI 판정 요청) | call `ai.decide` → result |
| progress, cancel | 동일(필드 이름 유지) |
| error.code(invalid\_request, busy, timeout, cancelled, ai\_unavailable, internal 등) | 동일 + 3.5의 추가 코드 |

이전 단계는 세 단계다.

1. 아티팩트가 v1과 v2를 모두 수신하고, 확장의 `supportedVersions`에 2가 있을 때만 v2로 보낸다. 없으면 어댑터 내부에서 v1 메시지로 변환한다.
2. 확장을 v2로 올린다(2/2 문서). 이때부터 hello가 양방향으로 오가고 새 op가 열린다.
3. 두 릴리스 뒤 v1 수신·변환 코드를 제거한다. 제거 전 진단 패널의 v1 수신 건수로 잘라도 되는지 확인한다.

## 6. 활용 예 5가지와 첫 구현 op

첫 구현은 6.6의 `calc.eval`이다. 아래 다섯 가지 예는 그 뒤에 늘려 갈 방향이다. 프로토콜로 할 수 있는 동작을 장마다 다른 종류로 다섯 개 골랐다. 조회, AI 판정, 파일 저장, 화면 입력, 영속 저장이고 서로 같은 기능이 겹치지 않는다. 확장 측 구현 포인트는 2/2 문서 7장에 있다.

| # | op | 방향 | kind | 아티팩트가 할 수 없는 이유 | 확장 없을 때 폴백 |
| --- | --- | --- | --- | --- | --- |
| 1 | `web.query` | 앱 → 확장 | read | 외부 fetch가 CSP·CORS로 막힘 | Claude 호출, 수동 붙여넣기 |
| 2 | `ai.decide` | 확장 → 앱 | read | 확장은 AI 호출 수단이 없고 앱만 갖고 있음 | 확장의 로컬 규칙 판정 |
| 3 | `file.save` | 앱 → 확장 | write | 폴더·파일명 지정과 다수 파일 저장이 불가 | 브라우저 기본 다운로드 |
| 4 | `page.fill` | 앱 → 확장 | sensitive | 다른 탭의 DOM에 접근 불가 | 클립보드 복사 |
| 5 | `kv.put` / `kv.get` | 앱 ↔ 확장 | write / read | 아티팩트 로컬 저장소는 비워질 수 있음 | JSON 파일 수동 백업 |

### 6.1 외부 사이트 조회 위임 (`web.query`)

확장의 서비스 워커가 사이트를 조회하고 결과만 돌려준다(현행 우체국 조회). 인자는 `{adapter, params}`이고 어댑터별로 허용 도메인과 파싱 규칙이 확장 안에 고정되어 있다. 결과는 `{items[], meta}`다. 사이트가 차단하면 `blocked`, 화면 구조가 바뀌었으면 `parse_failed`를 돌려주고 아티팩트는 수동 붙여넣기로 내려간다. 사용자의 로그인 쿠키가 필요한 사이트여도 쿠키값은 앱에 돌려주지 않는다.

### 6.2 확장이 모은 후보의 AI 판정 (`ai.decide`)

확장이 우체국 페이지에서 읽은 후보를 보내면 앱이 후보별 확률을 계산해 돌려준다(현행 decide). 인자는 `{query, candidates[{ref, ...}], engine}`, 결과는 `{scores[{ref, p, reason}], pNone, bestRef, verdict, summary}`다. 이 방향은 요청자가 확장이라는 점이 핵심이다. 앱은 고정 프롬프트만 쓰고, 결과를 검증한 뒤 돌려준다.

### 6.3 로컬 파일 저장 (`file.save`)

일괄 변환 결과를 CSV·XLSX로 지정한 하위 폴더에 저장한다. 인자는 `{files[{name, mime, data}], subdir}`이고 data는 ArrayBuffer를 transfer로 보낸다. 결과는 `{saved[{name, bytes}]}`다. `write` op이라 idempotencyKey를 받는다. 확장은 경로에서 `..`와 절대 경로를 거부하고 확장자를 허용 목록으로 제한한다.

### 6.4 열려 있는 업무 화면에 값 입력 (`page.fill`)

변환된 도로명주소와 새 우편번호를 사용자가 연 업무 화면의 입력란에 채운다. 인자는 `{target{urlPattern, form}, fields{...}}`, 결과는 `{filled, skipped[]}`다. 확장이 "n개 필드를 채울까요?"라고 사용자에게 동의를 받고, 제출이나 저장 버튼은 누르지 않는다. 대상 화면별 셀렉터는 확장이 어댑터로 고정해 둔다. 탭이 없으면 `not_found` 계열 오류로 알린다.

### 6.5 영속 저장소 백업과 복원 (`kv.put`, `kv.get`)

학습 데이터 스냅샷을 확장의 `chrome.storage.local`에 보관한다. 액션은 `kv.put{key, value, rev}`와 `kv.get{key}`다. 앱은 변경이 쌓이면 put을 보내고, 시작 시 로컬이 비어 있으면 get으로 복원을 제안한다. 자동 덮어쓰기는 하지 않고, 현행 백업 탭의 검증·미리보기 로직(`validateBackup`)을 그대로 거친다. `rev`가 충돌하면 `conflict` 오류로 돌려주고 사용자가 선택한다.

### 6.6 첫 구현: 수식 계산 (`calc.eval`)

전체 경로(hello, 카탈로그, describe, call, result, 오류)를 가장 작은 기능으로 확인하는 op다. 계산 자체는 아티팩트도 할 수 있으므로 기능의 가치가 아니라 연동 시험이 목적이다. 외부 권한이 없어 설치 직후 바로 `ready`다.

| 항목 | 내용 |
| --- | --- |
| op / kind / consent | `calc.eval` ver 1 / `read` / `none` |
| summary | 사칙·거듭제곱·함수가 들어간 수식을 계산한다 |
| args | `{expr: string(1~500자), vars?: object(최대 16개, 값은 number), precision?: integer(0~15, 기본 12)}` |
| result | `{value: number, text: string}`. `text`는 `precision` 유효숫자로 반올림한 십진 문자열 |
| 연산 | `+ - * / % ^`, 괄호, 단항 `-`. 함수 `sqrt abs round floor ceil min max log ln exp sin cos tan`. 상수 `pi e`. 변수는 `vars`의 이름(영문자·밑줄 시작, 32자 이하) |
| 오류 | 문법 오류와 모르는 이름·함수는 `invalid_request`(`detail.pos`에 위치). 0으로 나누기, 결과가 NaN·Infinity는 op 고유 코드 `math_error`(재시도 아니오) |
| 제한 | 동시성 4건, 수식 깊이 64, 항 개수 200, 처리 제한 1초 |

확장은 `eval`과 `Function`을 쓰지 않는다. 재귀 하강 파서로 직접 해석한다(MV3 CSP도 이를 막는다). 같은 입력은 항상 같은 결과를 돌려주는 순수 함수이므로 확장 쪽 단위 테스트와 아티팩트의 모의 확장이 같은 파서를 쓸 수 있다.

배선 예시는 다음과 같다.

```json
{"source":"ab-app","v":2,"ns":"calc-demo","type":"call","id":"b2e0…","op":"calc.eval","ver":1,"args":{"expr":"sqrt(x^2 + y^2)","vars":{"x":3,"y":4}},"opts":{"timeoutMs":5000}}
{"source":"ab-ext","v":2,"ns":"calc-demo","type":"result","id":"b2e0…","ok":true,"data":{"value":5,"text":"5"},"meta":{"elapsedMs":3}}
{"source":"ab-ext","v":2,"ns":"calc-demo","type":"result","id":"c41d…","ok":false,"error":{"code":"math_error","message":"0으로 나눌 수 없습니다","retryable":false,"detail":{"pos":2}}}
```
