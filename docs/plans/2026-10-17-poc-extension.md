# claude-ex 개념 실증(PoC) 확장 계획

## Context

`claude-ex`는 아직 빌드 가능한 코드가 없다. `reference/`에는 postal의 v2 구현 복사본만 있다. 이번 PoC의 목표는 ABP v2 양방향 RPC가 실제 아티팩트와 확장 사이에서 동작하는지 확인하는 것이다. 기능은 방향별로 하나씩이다.

- **앱 → 확장: `calc.eval@1`.** 명세 03 6장 규격을 그대로 따른다. 수식, 변수, 정밀도를 받아 계산한다.
- **확장 → 앱: `text.translate@1`.** 한국어를 영어로 번역한다. 아티팩트가 `sample` capability로 Claude를 부른다.
- **공통 AI 설정:** quick/보통/고급 중 하나를 확장 팝업에서 고르면 `chrome.storage.local`에 기억한다. 확장이 앱에 보내는 모든 AI op의 `args.tier`에 실어 보낸다.
- **로그:** 앱 → 확장 호출만 IndexedDB에 쌓는다. 시점, 요청, 응답을 남긴다. 열람과 다운로드 UI는 이번 범위가 아니다.

인터뷰로 확정한 사항:

| 항목 | 결정 |
| --- | --- |
| UI | Svelte 5. 팝업 하나로 구성(설정, 번역 입력·결과, 연결 상태) |
| tier 전달 | 확장 설정을 `args.tier`(`quick` / `normal` / `advanced`)로 보낸다. 앱이 이를 `sample`의 `modelTier`(`quick` / `default` / `complex`)로 바꾼다 |
| 번역 시작점 | 팝업의 입력창 |
| 번역 대상 | `text.translate`를 제공하는 세션 중 가장 최근에 hello한 하나 |
| 대상이 없을 때 | 고정 URL을 전면 새 탭으로 연다. 서비스 워커가 요청을 보관했다가 연결되면 자동으로 다시 보낸다(최대 30초). 결과가 오면 `chrome.action.openPopup()`을 부르고, 실패하면 툴바 배지로 알린다 |
| 로그 | 요청과 응답 본문을 저장한다(명세 02의 "본문 저장 금지"에 대한 PoC 예외). 항목당 본문 8KiB에서 자르고 최근 1,000건만 유지한다. 실패한 호출과 `meta.describe`도 남기고 hello는 남기지 않는다 |
| 보안 계층 | 최소로 둔다. 콘텐츠 스크립트 매칭은 `*.frame.claudeusercontent.com` + 상위 프레임 `claude.ai`로 고정한다. 옵션 페이지, 오리진 허용 목록, 동의 UI는 넣지 않는다. op 레지스트리 구조는 명세대로 만들어 나중에 이 계층들을 붙일 수 있게 한다 |
| 아티팩트 | 내가 요구사항 문서(명세 04)를 쓴다. 사용자가 클로드 웹에서 스킬과 함께 아티팩트를 만들고 URL을 넘겨준다 |
| ns | `claude-ex-poc` |

## 구조 (저장소 루트 `src/`)

```
src/
  config.ts                 ARTIFACT_URL(나중에 받음), NS, 한도 상수
  lib/protocol.ts           ← reference/src/lib/protocolV2.ts 복사 후 편집: 봉투·오류·validateCall만 남김
  lib/schema.ts             JSON Schema 부분집합 검증기(스킬 bridge.js의 validateSchema와 같은 규칙)
  lib/calc.ts               재귀 하강 파서(eval·Function 금지). 오류 위치 pos, math_error
  background/index.ts       진입점
  background/bridge.ts      ← reference 복사: onConnect, sender.origin 검증. decideClient 제거
  background/session.ts     ← reference 복사 후 재작성: 포트별 세션, hello/hello_ack(provides·catalogRev), 상대 provides 보관, call 디스패치, 호출자 역할
  background/registry.ts    op 정의 {name, ver, kind, summary, argsSchema, resultSchema, limits, handler}. meta.describe, calc.eval 등록. 실행 순서: 봉투 → op → 스키마 → 동시성 → 핸들러 → 정제 → 전송
  background/queue.ts       ← reference 그대로(동시성·타임아웃)
  background/caller.ts      확장 → 앱 call. pending 관리, timeoutMs + 2초, busy는 지수 백오프로 최대 2회, result 스키마 검증
  background/router.ts      세션 목록에서 최근 provider 선택. 없으면 탭을 열고 hello를 기다린 뒤(30초) 전송
  background/translateJob.ts 진행 중이거나 마지막 번역 작업을 chrome.storage.session에 보관. 배지, openPopup
  background/log.ts         IndexedDB(`claude-ex` DB, `calls` 스토어, ts 인덱스). 8KiB에서 자름, 1,000건 초과분 정리
  background/settings.ts    tier 읽기·쓰기(chrome.storage.local, 기본값 normal)
  content/bridge.ts         ← reference 복사: window ↔ 포트 중계. v1 분기 제거. 앱발 result·progress·hello_ack도 SW로 중계(확장 → 앱 호출용)
  popup/App.svelte, main.ts 상태(연결된 앱 수, 최근 앱), tier 선택, 번역 입력·결과, 진행·오류 표시. 열면 마지막 작업을 복원
```

설정 파일은 `reference/config/`에서 `cp`로 복사한 뒤 편집한다. React와 tailwind는 빼고 `svelte`, `@sveltejs/vite-plugin-svelte`, `fake-indexeddb`(테스트용)를 넣는다. manifest 권한은 `storage`뿐이다(`tabs.create`와 `action.openPopup`에는 별도 권한이 필요 없다). `host_permissions`는 두지 않는다.

## op 규격

- **`calc.eval@1`** (read, consent false): 명세 03 6장 그대로다. args는 `{expr: 1~500자, vars?: 최대 16개, precision?: 0~15}`, 결과는 `{value, text}`다. 오류는 `invalid_request`(`detail.pos` 포함)와 `math_error`다.
- **`meta.describe@1`**: 명세 01 3.8대로 `{op?, adapter?}`를 받는다. 레지스트리 정의에서 생성하고, `catalogRev`는 provides의 해시다.
- **`text.translate@1`** (앱이 제공, 확장이 호출):
  - args: `{text: string 1~2000자, tier: enum quick|normal|advanced}`
  - result: `{text: string ≤8000자, tier, modelApplied?: string}`
  - 오류: `ai_unavailable`(sample이 null이거나 거부·실패), `not_granted`(앱 토글이 꺼짐), `busy`(분당 한도 초과나 처리 중), `invalid_request`
  - timeoutMs 60,000
  - 확장은 결과를 검증하고 정제(태그 제거, 길이 제한)한 뒤 textContent로만 보여 준다.

## 작업 순서

1. **스캐폴딩(순차):** 설정 파일을 복사·편집하고 `npm i`를 실행한다. 빈 상태에서 `tsc`와 `vitest`가 통과하는지 확인한다.
2. **프로토콜 코어(순차):** `lib/protocol.ts`와 `lib/schema.ts`를 테스트부터 작성한다. 이후 단계가 모두 여기에 의존한다.
3. **병렬 팬아웃(서로 간섭 없음):**
   - A `lib/calc.ts` + 테스트(builder). 명세 03 6장 연산과 오류 사례가 정답 기준이다.
   - B `background/log.ts` + 테스트(builder, fake-indexeddb). 자르기와 1,000건 정리가 기준이다.
   - C 명세 04 `docs/spec/04-poc-artifact-requirements.md`(나). 내용은 아래 "명세 04 요지"에 있다.
   - D `popup/` Svelte UI(worker). 메시지 계약을 먼저 고정해 주고, 목(mock) 응답으로 작업하게 한다.
4. **통합(순차, 나):** registry, session, caller, router, translateJob, content bridge, settings를 만들고 시나리오 테스트를 쓴다. 테스트는 reference의 `session.test.ts` v2 블록을 발췌해 재작성한다.
5. **문서:** 명세 02에 PoC 예외(로그 본문 저장, 보안 계층 축소)를 표시하고 HANDOFF를 갱신한다. 마지막으로 확장 어댑터 명세서 최종본을 출력한다.

## 명세 04 요지 (아티팩트 요구사항, PoC판)

- 스킬 `artifact-extension-bridge`를 적용한다. `ABP.CFG.ns='claude-ex-poc'`.
- 계산기 UI: `calc.eval`을 호출하고, 확장이 없으면 내장 계산기로 폴백한다(명세 03 6~7장을 그대로 쓴다).
- `ABP.serve('text.translate', …)`: 위 args·result 스키마를 쓴다. 고정 프롬프트 템플릿에 원문을 데이터로 구획해 넣는다. tier는 다음처럼 바꾼다.

  | tier | modelTier |
  | --- | --- |
  | quick | quick |
  | normal | default |
  | advanced | complex |

  결과에 `modelApplied`를 담는다.
- `sample` capability를 선언한다. "AI 사용 허용" 버튼으로 첫 동의를 미리 받는다. 거부되면 `ai_unavailable`로 돌려준다.
- `ABP.policy`에 "확장의 번역 요청 허용" 토글과 분당 12건 한도를 둔다. 최근 번역 요청 내역을 화면에 표시한다.
- 모의 확장으로 `ABP_MOCK.callApp`을 테스트한다. 배포 전에 모의 확장 코드를 제거한다.
- 게시 후 URL을 확장 개발자에게 넘긴다(`config.ts`의 ARTIFACT_URL).

## 검증

- `npx tsc --noEmit`, `npx vitest run`
  - 프로토콜: 봉투 4중 필터, validateCall
  - 스키마 검증기
  - calc: `sqrt(x^2+y^2)`가 5, `1/0`이 math_error, `2+*3`이 invalid_request와 pos
  - registry: unsupported_op와 `detail.known`, 동시 호출 busy
  - caller: 타임아웃(+2초), busy 재시도 2회, 늦게 온 result 무시
  - router: 최근 세션 선택, 세션이 없으면 탭을 열고 30초 대기 후 실패, 늦은 연결 시 자동 재전송
  - log: 자르기, 1,000건 정리
- `npm run build`로 `dist/`를 만든다. 이 프로젝트는 Next가 아니어서 bash-guard 대상이 아니다.
- 수동 E2E(사용자가 `dist/`를 압축 해제된 확장으로 로드하고 아티팩트 URL을 넘겨준 뒤):
  1. 아티팩트에서 계산을 하면 경로가 "확장"으로 표시되고, IndexedDB `calls`에 기록된다(DevTools Application 탭).
  2. 팝업에서 tier를 바꾸고 다시 열어도 유지된다.
  3. 아티팩트 탭이 열린 상태에서 번역하면 팝업에 결과와 modelApplied가 나온다.
  4. 탭을 모두 닫고 번역하면 새 탭이 열리고, 필요하면 동의를 거친 뒤 결과가 오면 팝업이 다시 열린다(실패하면 배지가 뜬다).
  5. 게시된 아티팩트 페이지와 채팅 미리보기 두 화면에서 프레임 origin을 실측한다.

## 남은 위험

- `openPopup()`은 창 포커스 조건에 따라 실패할 수 있다. 그때는 배지 경로로 대신한다.
- 게시된 `claude.ai/artifact/...` 페이지의 프레임 origin이 채팅 미리보기와 다를 수 있다. 실측 후 manifest 매칭을 조정한다.
- postal 확장과 같이 켜져 있으면 둘 다 hello_ack를 보낸다. PoC 중에는 postal을 꺼 두는 것을 전제로 한다.
