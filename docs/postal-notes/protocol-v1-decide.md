# 우편번호 변환기 연동 프로토콜 v1 — 추가 명세: 후보 판정(`decide`)

Oct 15, 2026 · @sooop

## 개요

기존 프로토콜 v1은 앱이 확장에 우체국 조회를 요청하는 방향(앱 → 확장)만 정의합니다. 이 문서는 **반대 방향**을 추가합니다. 확장이 구주소와 우체국 후보 목록을 앱에 보내면, 앱이 각 후보가 구주소와 일치할 확률을 계산해 돌려줍니다. 확장은 이 확률을 사용자에게 제안으로 보여 주고, 사용자가 확정하면 학습합니다.

이 명세는 `v`를 올리지 않는 추가 메시지입니다. 기존 `ping`, `lookup`, `result` 동작은 바뀌지 않으며, 이 메시지를 모르는 쪽은 "모르는 `type`은 무시"하는 기존 수신 규칙대로 동작합니다.

역할 분담:

- 앱: 후보별 일치 확률 계산(로컬 점수화, 필요하면 AI 판정), 판정 결과 반환.
- 확장: 후보 목록 구성, 앱 프레임 탐색과 호출, 응답 검증, 사용자에게 제안 표시, 사용자 확정 시 학습.

비범위: 앱의 점수화·AI 호출 방식, 확장의 화면, 학습 저장 구조.

## 연결 방식

기존과 같은 `window.postMessage` 중계입니다(앱 프레임의 콘텐츠 스크립트가 확장 백그라운드와 연결). 방향만 반대입니다.

1. 앱 프레임이 로드되면 `ready`를 보내 자신이 `decide`를 받을 수 있음을 알립니다. 확장은 이 메시지를 보낸 프레임을 판정 대상으로 기억합니다.
2. 확장이 `decide`를 보냅니다. 콘텐츠 스크립트가 이를 `window.postMessage`로 앱 프레임에 전달합니다.
3. 앱이 판정하고 `decision`을 `window.postMessage`로 보냅니다. 콘텐츠 스크립트가 확장 백그라운드로 전달합니다.

확장이 앱을 열어 둔 상태가 아닐 수도 있습니다. 확장은 저장된 앱 URL을 새 탭으로 열고 `ready`를 기다릴 수 있습니다(아래 "앱 탐색과 실행").

## 메시지 공통 형식

기존 공통 형식(`source`, `v`, `type`, `id`, `ts`)을 그대로 따릅니다. 방향별 `source`는 다음과 같습니다.

| 방향 | `source` | `type` |
| --- | --- | --- |
| 확장 → 앱 | `"postal-bridge"` | `probe`, `decide`, `cancel` |
| 앱 → 확장 | `"postal-converter"` | `ready`, `decision`, `progress` |

수신 규칙은 기존과 같습니다.

- 앱은 `event.source === window`, `source === "postal-bridge"`, `v`, `type`을 모두 확인한 뒤에만 처리하고, 그렇지 않으면 조용히 무시합니다.
- 모르는 필드와 모르는 `type`은 무시합니다(전방 호환).
- 지원하지 않는 `v`의 `decide`는 `invalid_request`로 응답합니다.
- `cancel`과 `progress`는 기존 프로토콜에도 있는 이름이지만 `source`로 방향이 구분됩니다. 앱이 받는 `cancel`은 항상 `source: "postal-bridge"`입니다.

## 메시지 정의

### probe / ready

앱이 판정 가능한 상태인지 확인합니다. 앱은 로드가 끝나면 요청 없이도 `ready`를 한 번 보내고, `probe`를 받으면 같은 `id`로 다시 `ready`를 보냅니다(`id`가 없는 최초 `ready`는 `id`를 `"init"`으로 합니다).

```json
{ "source": "postal-bridge", "v": 1, "type": "probe", "id": "p1" }

{ "source": "postal-converter", "v": 1, "type": "ready", "id": "p1", "ok": true,
  "appVersion": "2.4.0", "supportedVersions": [1],
  "features": ["decide", "cancel", "progress"],
  "engines": ["local", "ai"],
  "limits": { "maxCandidates": 20, "defaultTimeoutMs": 60000 } }
```

`engines`는 앱이 쓸 수 있는 판정 방식입니다. AI 기능을 쓸 수 없는 상태(비로그인, 한도 초과 등)면 `["local"]`만 알립니다.

### decide

구주소와 후보 목록을 보내 일치 확률을 요청합니다.

```json
{ "source": "postal-bridge", "v": 1, "type": "decide", "id": "d1",
  "query": {
    "oldAddr": "서울시 강남구 역삼동 736-1번지 101호",
    "oldZip": "135924",
    "searchText": "역삼동 736-1" },
  "candidates": [
    { "ref": "c0", "zip5": "06236", "road": "서울특별시 강남구 테헤란로 142",
      "jibun": "서울특별시 강남구 역삼동 736-1", "detail": "캐피탈타워", "oldZip": "135924",
      "prior": { "preferred": true, "confirmedCount": 3 } },
    { "ref": "c1", "zip5": "06237", "road": "서울특별시 강남구 논현로 429",
      "jibun": "서울특별시 강남구 역삼동", "detail": "씨앤씨빌딩" } ],
  "options": { "engine": "auto", "timeoutMs": 60000 } }
```

| 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `query.oldAddr` | string | 예 | 사용자가 입력한 구주소 원문. 200자 이하 |
| `query.oldZip` | string | 아니오 | 6자리 숫자(하이픈 없음) |
| `query.searchText` | string | 아니오 | 확장이 우체국에 보낸 검색어. 200자 이하 |
| `candidates` | array | 예 | 1건 이상 20건 이하 |
| `candidates[].ref` | string | 예 | 후보 식별자. 이 요청 안에서 유일하며 64자 이하. 앱은 응답에서 `ref`로 후보를 가리킵니다(배열 순서에 의존하지 않음) |
| `candidates[].zip5` | string | 예 | 5자리 숫자 |
| `candidates[].road` | string | 예 | 시도부터 시작하는 도로명주소(건물번호까지) |
| `candidates[].jibun` | string | 아니오 | 시도부터 시작하는 지번주소. 도로명 행은 동까지만 올 수 있음 |
| `candidates[].detail` | string | 아니오 | 건물명 등 참고 정보 |
| `candidates[].oldZip` | string | 아니오 | 이 후보에 대해 우체국이 알려 준 6자리 구우편번호 |
| `candidates[].prior` | object | 아니오 | 확장의 학습 정보. `preferred`(대표 주소로 지정됨), `confirmedCount`(사용자가 확정한 횟수). **약한 사전 정보일 뿐 정답이 아닙니다.** 앱은 이를 무시해도 됩니다 |
| `candidates[].name` | string | 아니오 | 건물(단지)명(예: `금암마을휴먼시아데시앙6단지아파트`). **v1 호환 추가 필드** — 모르는 앱은 무시해도 됩니다 |
| `candidates[].dongs` | string | 아니오 | 단지 안 동 목록 원문(예: `101동~103동,105동~108동`, `1동, 2동`). 구주소의 아파트 동이 이 목록에 없으면 다른 단지일 가능성이 큽니다. 동 번호는 다른 단지에도 같은 값이 있으므로 목록에 *있다는 것*은 약한 증거, *없다는 것*은 강한 증거입니다 |
| `candidates[].hint` | object | 아니오 | 확장이 입력을 분석해 매긴 로컬 점수 `{ score, why[] }`(`why` 예: `건물명 일치`, `지번 일치`, `동 없음`, `구우편번호 일치`). 점수 척도는 확장 내부 값이며 확률이 아닙니다. 참고만 하고, 앱의 판단과 다르면 앱의 근거를 우선합니다 |
| `options.engine` | string | 아니오 | `"local"`(AI 호출 없이 앱의 로컬 점수화만), `"ai"`(AI 판정 필수), `"auto"`(앱이 판단, 기본). 사용자가 AI 사용을 끈 경우 확장은 `"local"`로 보냅니다 |
| `options.timeoutMs` | number | 아니오 | 기본 60000. 앱은 이 시간 안에 응답해야 합니다 |

### decision (성공)

모든 후보에 대한 확률을 돌려줍니다.

```json
{ "source": "postal-converter", "v": 1, "type": "decision", "id": "d1", "ok": true,
  "scores": [
    { "ref": "c0", "p": 0.86, "reason": "동·번지 일치, 구우편번호 일치",
      "signals": { "dong": "match", "bunji": "exact", "oldZip": "match" } },
    { "ref": "c1", "p": 0.04, "reason": "도로·건물 불일치",
      "signals": { "dong": "match", "bunji": "different", "oldZip": "unknown" } } ],
  "pNone": 0.10,
  "bestRef": "c0",
  "verdict": "match",
  "summary": "역삼동 736-1은 캐피탈타워(테헤란로 142)로 판단됩니다",
  "meta": { "engine": "ai", "elapsedMs": 4210, "appVersion": "2.4.0" } }
```

| 필드 | 필수 | 설명 |
| --- | --- | --- |
| `scores` | 예 | 요청의 모든 후보를 정확히 한 번씩 포함합니다. 순서는 자유 |
| `scores[].ref` | 예 | 요청의 `ref` |
| `scores[].p` | 예 | 이 후보가 구주소의 실제 신주소일 확률. 0 이상 1 이하의 숫자 |
| `scores[].reason` | 아니오 | 판단 근거 한 줄. 80자 이하, 한국어, 평문 |
| `scores[].signals` | 아니오 | 판단 신호. 키와 값은 아래 표의 열거값만 씁니다 |
| `pNone` | 예 | 어느 후보도 정답이 아닐 확률. 0 이상 1 이하 |
| `bestRef` | 예 | `p`가 가장 큰 후보의 `ref`. `verdict`가 `no_match`면 `null` |
| `verdict` | 예 | `match`, `ambiguous`, `no_match` 중 하나 |
| `summary` | 아니오 | 전체 요약. 200자 이하 평문 |
| `meta.engine` | 예 | 실제로 쓴 방식 `local` 또는 `ai`(로컬 점수 후 AI로 보정했으면 `ai`) |
| `meta.elapsedMs` | 아니오 | 처리 시간 |

**확률 규칙**

- `p` 값들의 합과 `pNone`을 더하면 1입니다(오차 ±0.01 허용). 후보가 서로 배타적인 가설이라는 뜻입니다. 둘 이상이 모두 정답일 수 있는 경우(같은 건물의 다른 도로명 표기 등)에도 합이 1을 넘지 않도록 나눠서 줍니다.
- 소수 셋째 자리까지만 사용합니다.
- 정보가 부족하면 확률을 억지로 한쪽에 몰지 않습니다. 모든 후보가 비슷하면 낮은 값을 고르게 주고 `verdict`를 `ambiguous`로 합니다.

**verdict 권장 기준** (앱 판단, 확장은 이 값에 의존하지 않고 `p`로 다시 판단합니다)

| verdict | 조건 |
| --- | --- |
| `match` | 최고 `p`가 0.7 이상이고 2위와 0.2 이상 차이 |
| `no_match` | `pNone`이 0.5 이상 |
| `ambiguous` | 그 밖 |

**signals 열거값**

| 키 | 값 |
| --- | --- |
| `dong` | `match`, `mismatch`, `unknown` |
| `bunji` | `exact`, `near`, `different`, `unknown` |
| `oldZip` | `match`, `mismatch`, `unknown` |

### decision (실패)

```json
{ "source": "postal-converter", "v": 1, "type": "decision", "id": "d1", "ok": false,
  "error": { "code": "ai_unavailable", "message": "AI 판정을 쓸 수 없습니다", "retryable": false } }
```

`message`는 사람이 읽는 한국어 문장이고, 확장은 `code`로만 분기합니다. 모르는 코드는 `internal`로 취급합니다.

| code | 의미 | retryable | 확장 동작 |
| --- | --- | --- | --- |
| `invalid_request` | 필드 누락, 형식 오류, `ref` 중복, 후보 수 초과, 지원하지 않는 `v` | false | 버그로 간주, 제안 없이 후보만 표시 |
| `busy` | 앱이 이미 다른 `decide`를 처리 중(앱은 동시에 하나만 처리) | true | 잠시 뒤 다시 시도 |
| `ai_unavailable` | `engine`이 `ai`인데 AI를 쓸 수 없음(비로그인, 한도, 권한 등) | false | `engine: "local"`로 다시 요청할지 사용자에게 안내 |
| `timeout` | `timeoutMs` 안에 판정 못함 | true | 사용자가 다시 시도 |
| `cancelled` | 확장의 `cancel`로 중단 | false | 상태만 갱신 |
| `internal` | 그 밖의 앱 내부 오류 | false | 제안 없이 후보만 표시 |

### progress

선택 사항입니다. 오래 걸리는 판정의 진행 상태이며 확장은 표시만 합니다.

```json
{ "source": "postal-converter", "v": 1, "type": "progress", "id": "d1", "stage": "asking_ai" }
```

`stage`는 `scoring`(로컬 점수 계산), `asking_ai`(AI에 질의 중) 중 하나입니다.

### cancel

확장이 진행 중인 판정을 중단합니다. 앱은 판정을 멈추고 `code: "cancelled"`인 `decision`으로 응답합니다. 이미 끝난 `id`의 `cancel`은 무시합니다. 이후 해당 `id`로 다른 `decision`을 보내지 않습니다.

```json
{ "source": "postal-bridge", "v": 1, "type": "cancel", "id": "d1" }
```

## 앱 동작 요구사항

- **응답 보장**: 유효한 `decide`에는 반드시 `decision`을 한 번만 보냅니다(성공이든 실패든). 처리 중 예외가 나도 `internal`로 응답합니다.
- **동시 처리**: 한 번에 하나만 처리합니다. 처리 중에 다른 `decide`가 오면 `busy`로 응답합니다.
- **입력 검증**: 문자열 길이, `ref` 유일성, `candidates` 개수(1~20), `zip5` 5자리 숫자, `oldZip` 6자리 숫자를 확인하고 어긋나면 `invalid_request`로 응답합니다.
- **`engine: "local"`**: AI를 호출하지 않습니다. 로컬 점수화 결과를 확률로 정규화해서 돌려줍니다.
- **`engine: "ai"`**: 로컬 점수를 먼저 계산해 AI의 판단 재료로 쓸 수 있습니다. AI를 쓸 수 없으면 `ai_unavailable`로 응답하고 로컬 결과로 조용히 대체하지 않습니다.
- **`engine: "auto"`**: 로컬 결과가 분명할 때(`verdict`가 `match`이고 최고 `p`가 0.9 이상)는 AI를 호출하지 않아도 됩니다. 모호할 때만 AI를 호출합니다. 실제로 쓴 방식을 `meta.engine`에 적습니다.
- **`prior`**: 후보 순위를 정하는 데 약하게만 반영합니다. 구주소와 명백히 어긋나면 `prior`가 있어도 높은 확률을 주지 않습니다.
- **건물명·동 목록**: 구주소에 건물명이 있으면 `name`과 유사도를 비교하고(공백, `아파트` 접미, `N차`·`N단지` 표기 차이는 감안하되 차수가 서로 다르면 감점), 아파트 동 번호는 `dongs`에 없으면 감점합니다. 같은 이름의 단지가 여러 곳이면 `road`(앞주소)가 다른 후보로 나타납니다.
- **AI 입력 최소화**: AI에 보내는 내용은 `query`와 `candidates`의 주소 정보(`name`, `dongs` 포함)로 제한합니다. `hint`와 `prior`는 AI에 보내지 않아도 됩니다.
- **AI 출력 검증**: AI의 응답은 신뢰하지 않습니다. 형식과 `ref` 존재를 검증하고, 확률 합이 규칙을 벗어나면 정규화하거나(오차가 크면) `internal`로 응답합니다.
- **환각 방지**: `scores`에는 요청에 있는 `ref`만 쓰고, 후보에 없는 주소를 새로 만들어 제안하지 않습니다.

## 확장 동작 요구사항

- **옵트인**: 사용자가 설정에서 이 기능을 켠 경우에만 구주소와 후보를 앱 프레임으로 보냅니다(기본 꺼짐). AI 사용 여부는 별도 설정이며, 꺼져 있으면 `engine: "local"`로 보냅니다.
- **최소 전송**: `query`와 후보 주소 정보, 그리고 확장이 아는 `prior`만 보냅니다. 그 외 검색 이력이나 학습 데이터 전체는 보내지 않습니다.
- **응답 검증**: `scores`가 모든 `ref`를 정확히 한 번씩 포함하는지, `p`와 `pNone`이 0~1인지, 합이 1±0.01인지 확인합니다. 어긋나면 응답을 버리고 제안 없이 후보만 표시합니다. `reason`과 `summary`는 평문으로만 표시하고 HTML로 해석하지 않습니다.
- **제안으로만 표시**: `verdict`가 아니라 `p`로 판단합니다. 최고 `p`가 0.7 이상이고 2위와 0.2 이상 차이면 "추천", 그렇지 않으면 확률만 보여 줍니다(임계값은 설정에서 조정 가능).
- **자동 확정 금지**: 판정 결과로 학습 DB를 갱신하거나 대표 주소를 지정하지 않습니다. 사용자가 후보를 직접 선택해 확정할 때만 학습합니다.
- **저장 금지**: 판정에 쓴 구주소와 후보, 응답을 확장이 별도로 저장하거나 기록하지 않습니다(사용자가 확정한 매치는 학습 규칙에 따라 저장).
- **타임아웃과 취소**: `timeoutMs`가 지나면 `cancel`을 보내고 해당 건을 실패로 처리합니다. 한 번에 하나씩만 `decide`를 보냅니다.

## 앱 탐색과 실행

확장은 `ready`를 보낸 프레임을 판정 대상으로 삼습니다. 앱 프레임이 확장에 연결되면(포트 연결) 확장이 곧바로 `probe`를 보내 `ready`를 받으므로, 앱의 최초 `ready`를 놓쳤거나 확장(서비스 워커)이 재시작된 뒤에도 프레임이 다시 등록됩니다. 사용자가 지금 보고 있는 탭에 앱이 열려 있으면 그 프레임을 먼저 씁니다. 열려 있는 앱이 없으면 사용자가 저장해 둔 앱 URL을 새 탭(백그라운드)으로 엽니다.

- 저장할 수 있는 URL은 `https://claude.ai/` 아래 아티팩트 주소로 제한합니다(임의 URL을 열지 않습니다).
- 확장이 연 탭에서 `ready`가 10초 안에 오지 않으면 탭을 앞으로 가져오고(백그라운드 탭의 지연 로딩·절전 대비), 전체 30초 안에 오지 않으면 `app_unavailable`(확장 내부 오류 코드, 앱은 알 필요 없음)로 처리하고 사용자에게 알립니다.
- 확장이 열었다면 판정이 끝난 뒤 그 탭을 닫습니다. 사용자가 이미 열어 둔 탭은 닫지 않습니다.

## 수용 기준

앱 쪽이 통과해야 하는 시나리오입니다.

| 번호 | 시나리오 | 기대 결과 |
| --- | --- | --- |
| 1 | 앱 로드 후 최초 상태 | 2초 안에 `ready`(`id: "init"`), `features`, `engines`, `limits` 포함 |
| 2 | `probe` 전송 | 같은 `id`로 `ready` |
| 3 | 후보 3건, 정답이 분명한 `decide`(`engine: "local"`) | `ok: true`, `scores`가 3건 모두 포함, `p` 합 + `pNone` = 1±0.01, `bestRef`가 정답 후보, `verdict: "match"` |
| 4 | 정답이 없는 후보들 | `pNone`이 0.5 이상이고 `verdict: "no_match"`, `bestRef: null` |
| 5 | 후보가 모두 비슷한 경우 | `verdict: "ambiguous"`, 한 후보에 확률을 몰아주지 않음 |
| 6 | 후보 1건 | `scores` 1건, `pNone` 포함 |
| 7 | `engine: "local"` | AI를 호출하지 않음 |
| 8 | `engine: "ai"`인데 AI 사용 불가 | `ok: false`, `ai_unavailable` (로컬 결과로 대체하지 않음) |
| 9 | `ref` 중복, 후보 21건, `oldAddr` 누락, 200자 초과, 지원하지 않는 `v` | `invalid_request`, 앱 중단 없음 |
| 10 | 판정 중 다른 `decide` 전송 | 두 번째에 `busy`, 첫 번째는 정상 완료 |
| 11 | 판정 중 `cancel` | `cancelled`로 응답하고 이후 해당 `id`의 `decision`이 더 오지 않음 |
| 12 | `timeoutMs`보다 오래 걸리는 판정 | `timeoutMs` 안에 `timeout` |
| 13 | 허용되지 않은 `source`나 `event.source !== window`인 메시지 | 응답 없이 무시 |
| 14 | `prior.preferred`만 있고 구주소와 명백히 어긋나는 후보 | 높은 확률을 주지 않음 |
| 15 | AI가 후보에 없는 `ref`나 합이 1이 아닌 확률을 돌려준 경우 | 앱이 검증해 정규화하거나 `internal`로 응답 |

확장 쪽이 통과해야 하는 시나리오입니다.

| 번호 | 시나리오 | 기대 결과 |
| --- | --- | --- |
| E1 | 기능이 꺼진 상태에서 조회 | 앱 프레임으로 아무 메시지도 보내지 않음 |
| E2 | `scores`에 `ref` 누락·중복·미지의 `ref` | 응답을 버리고 후보만 표시 |
| E3 | `p` 합이 1±0.01을 벗어남 | 응답을 버리고 후보만 표시 |
| E4 | `reason`에 HTML 태그 | 태그가 그대로 글자로 표시됨 |
| E5 | 추천이 표시된 상태 | 사용자가 선택하기 전에는 학습 DB가 바뀌지 않음 |
| E6 | 앱이 응답하지 않음 | `timeoutMs` 뒤 `cancel`을 보내고 실패 표시, 다음 건 진행 가능 |
| E7 | 허용되지 않은 URL 저장 시도 | 거부 |

## 확인 필요 사항과 버전 정책

앱과 확장 개발 쪽이 실측으로 닫아야 하는 항목입니다.

- 확장이 새 탭(백그라운드 탭)으로 연 앱 프레임에서 `ready`가 정상적으로 오는지, 백그라운드 탭에서도 앱이 동작하는지(브라우저의 탭 절전·타이머 지연 영향).
- 앱의 AI 질의 기능이 사용자 조작 없이 호출될 수 있는지(`decide`는 사용자 클릭 직후가 아닐 수 있습니다). 불가능하면 `engines`에 `ai`를 넣지 않고 `local`만 지원합니다.
- AI 질의 한 건의 평균 소요 시간과 한도. `defaultTimeoutMs`와 `limits.maxCandidates`를 조정할 근거입니다.
- 앱 URL을 새 탭으로 열었을 때 로그인 요구 등으로 앱이 뜨지 않는 경우의 처리.

버전 정책은 기존 프로토콜 v1과 같습니다. 필드 추가는 `v`를 유지하고, 필드 삭제나 의미 변경은 `v`를 올립니다.
