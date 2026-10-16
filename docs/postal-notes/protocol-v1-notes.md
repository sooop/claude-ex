# 연동 프로토콜 v1 — 확장 구현 노트

명세(우편번호 변환기 확장 연동 프로토콜 명세 v1)를 구현하면서 확정·변경한 사항입니다.

## 사전 검증 결과 (확정, 2026-10-15 정정)

- 앱 프레임의 실제 origin 은 `https://<uuid>.frame.claudeusercontent.com` 입니다(앱이 직접 보고한 `location.origin`).
- 처음 진단에서 보인 `https://claude.ai` 는 앱 프레임 바깥의 중간 프레임이었고, 그곳에는 앱이 없습니다. 이를 앱 origin 으로 오인해 첫 매치가 틀렸습니다.
- 콘텐츠 스크립트 매치는 `https://*.frame.claudeusercontent.com/*`(`manifest.json`)입니다.
- 코드에서도 origin 정규식(`isAllowedAppOrigin`)과, 상위 프레임에 `https://claude.ai` 가 있는지(`location.ancestorOrigins`, `hasAllowedParent`)를 확인합니다. service worker 는 포트의 `sender.origin` 을 같은 정규식으로 검사합니다.
- `externally_connectable` 은 쓰지 않습니다.

## 조회처 (확정)

- 우체국몰 JSON 엔드포인트 `POST https://mall.epost.go.kr/fo/comm/newZipcdList.do` (`keyword`, `pageIdx`, `pageSize`).
- 구우편번호 검색을 지원합니다(`135-924`, `135924` 모두 동일). 하이픈은 필요 없습니다.
- 응답의 `areacd` 는 신우편번호 5자리, `zipcd` 는 구우편번호(`135-924`, 없으면 `""` 또는 `"-"`)입니다.
- `pageSize` 는 100 까지 확인했습니다. 명세의 `limit` 최대는 20 입니다.

## 조회처 이원화 (추가)

- 두 번째 조회처로 행정안전부 도로명주소 안내시스템(`POST https://juso.go.kr/api/solr/solrKeywordSearch`, JSON)을 추가했습니다. 우체국몰은 띄어쓰기가 있는 건물명 검색(`금암마을 휴먼시아 데시앙`)에서 엉뚱한 결과를 주는 경우가 있고, juso 는 도로명과 지번이 쌍으로 완전하게 옵니다.
- juso 는 **구우편번호 검색을 지원하지 않습니다**(`135-924` → 0건). 구우편번호 검색어는 항상 우체국몰로만 조회합니다.
- 팝업: 검색 방식 `자동`(우체국 먼저, 결과가 없거나 실패하면 juso) / `우체국` / `도로명주소`. 결과에 출처를 표시하고 다른 조회처로 다시 검색할 수 있습니다. 더 보기는 첫 페이지를 가져온 조회처로 고정됩니다.
- 프로토콜 `lookup`: `options.source` 를 추가했습니다(`"epost"` 기본, `"juso"`, `"auto"`). 기본이 `epost` 이므로 기존 동작은 그대로입니다. `"auto"` 는 우체국 후보가 0건일 때만 juso 로 대체하고, 실제로 쓴 조회처를 `meta.source`(`"epost"` 또는 `"juso"`)에 적습니다. `pong.features` 에 `jusoSearch` 가 추가되었으니 앱은 이 값을 확인하고 `options.source` 를 보낼 수 있습니다.
- juso 후보의 `road` 는 도로명주소(건물번호까지), `jibun` 은 시도부터의 완전한 지번(동·리·번지), `detail` 은 건물명입니다. `oldZip` 은 없습니다.

## 명세와 달라진 점

| 항목 | 명세 | 구현 |
| --- | --- | --- |
| `oldZip` 만 있는 `lookup` | `unsupported_query` (수용 기준 4) | 구우편번호 검색이 되므로 정상 조회. `pong.features` 에 `oldZipSearch` 포함. 검색어를 만들 수 없는 `oldAddr` 만 오면 `unsupported_query` |
| 후보 필드 | `zip5`, `road`, `jibun`, `detail` | `oldZip`(6자리 숫자) 추가. 모르는 필드는 앱이 무시하므로 v1 호환 |
| `jibun` | 시도부터 시작하는 지번주소 | 지번 행은 전체 지번, 도로명 행은 응답에 번지가 없어 **동까지만**(예: `서울특별시 강남구 역삼동`) |
| 실패 응답 `meta` | 없음 | 검색어를 만든 뒤 실패하면 `meta.{source, parserVersion, queryUsed}` 포함(수용 기준 10) |
| 제외 항목 | 도로명이 비면 폐기 | 번지 범위 행(`736~737`)과 사서함 행은 `road` 가 없으므로 후보에서 제외 |
| 큐 한도 | `rate_limited` | 대기열이 50건을 넘으면 `rate_limited` + `retryAfterMs` |
| 타임아웃 시작 시점 | 앱이 `timeoutMs` 지정 | 큐에서 실행이 시작된 시점부터 계산. 값은 1~60초로 보정 |

## 검색어 추출 (`oldAddr` 만 있을 때)

`searchText` 가 없으면 `oldAddr` 에서 `동/리/가/읍/면 + 번지`를 뽑고(예: `역삼동 736-1`), 없으면 `도로명 + 번호`를 씁니다. 한글로 시작하지 않는 `101동 1203호` 같은 아파트 동·호수는 번지로 오인하지 않습니다.

## 입력 분석 검색 (lookup 의 기본 동작, v1 호환 추가)

`query.oldAddr` 가 있으면 확장은 우체국 검색을 그대로 쓰지 않고 입력을 분석해 조회합니다(`options.analyze: false` 이면 기존처럼 `searchText` 한 번만 조회).

- 구주소 원문을 지역·지번·도로명·건물명·아파트 동으로 분해해 여러 검색어를 만들고, 우체국몰과 도로명주소(juso)를 모두 조회해 도로명주소(앞주소) 단위로 합칩니다. 앱이 보낸 `searchText` 는 마지막 검색어로 함께 씁니다.
- 후보는 확장이 매긴 점수 내림차순으로 오며, 추가 필드 `name`(건물명), `dongs`(단지 안 동 목록 원문), `match`(`{ score, why[] }`, 점수는 확률이 아니라 확장 내부 값)가 붙을 수 있습니다. 모르는 앱은 무시해도 됩니다.
- `meta.analyzed: true`, `meta.confident`(확장이 확신하는 1순위가 있는지), `meta.queryUsed` 는 실제로 쓴 검색어를 ` | ` 로 이은 값입니다. `meta.source` 는 1순위 후보의 조회처입니다.
- `options.source`: `juso` 만 도로명주소로 한정합니다. 그 밖의 값(기본 `epost` 포함)은 분석 검색에서 두 조회처를 함께 씁니다.
- 제한 시간(`timeoutMs`)의 60% 가 지나면 새 검색어를 시작하지 않고, 그때까지 모은 결과를 돌려줍니다. 모든 조회가 실패하면 빈 결과가 아니라 오류(`blocked`, `network` 등)로 응답합니다.
- 단서가 없는 `oldAddr`(예: 시도 이름만) 은 이전처럼 `unsupported_query` 입니다.

## 개인정보

- 외부 경로(`lookup`)는 조회어와 결과를 저장하거나 로그에 남기지 않습니다(`src/background/session.ts`는 저장소와 `console` 을 쓰지 않습니다).
- 팝업에서 사용자가 직접 한 검색의 이력(IndexedDB)과는 코드 경로가 분리되어 있습니다.

## 코드 위치

| 역할 | 파일 |
| --- | --- |
| 메시지 정의·검증 | `src/lib/protocol.ts` |
| 조회 실행·검색어 추출·후보 변환 | `src/lib/lookup.ts` |
| 직렬 큐·최소 간격·취소 | `src/background/queue.ts` |
| 프레임별 세션 처리 | `src/background/session.ts` |
| 포트 수신·출처 검증 | `src/background/bridge.ts` |
| `postMessage` 중계 | `src/content/bridge.ts` |
| 수용 기준 테스트 | `src/background/session.test.ts` |
