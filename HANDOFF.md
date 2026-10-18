# claude-ex 핸드오프

가칭 `claude-ex`. 우편번호 확장(`D:\Projects\postal`)에서 만든 **위임 프로토콜 v2** 코어를 가져와, 여러 아티팩트가 공유하는 범용 위임 확장으로 키우는 프로젝트다. 이 문서는 새 저장소에서 작업을 이어받기 위한 출발점이다. (작성 2026-10-16)

## 1. 배경과 목표

- 아티팩트(claude.ai 샌드박스 iframe)는 외부 fetch, 파일 저장, 다른 탭 접근이 막혀 있다. 브라우저 확장이 이를 **op 단위 RPC**로 대신 수행한다.
- 우편번호 확장에는 v1(전용 프로토콜)이 있었고, 그 위에 v2(범용 op RPC)를 **병행 추가**해 `web.query` 하나를 노출했다(postal 커밋 `e74360b`).
- 이 저장소의 목표: 우편번호 전용 코드를 떼어내고, v2 코어 + **어댑터 레지스트리** + **권한·동의 계층**을 갖춘 범용 확장을 만든다.
- 계약 문서(`docs/spec/`)가 원본 설계다. 코드와 문서가 어긋나면 문서를 기준으로 하되, postal 에서 실측으로 정정한 사항은 `docs/postal-notes/`에 있다.

## 2. 디렉터리 안내

| 경로 | 내용 |
| --- | --- |
| `docs/spec/01-…` | 공통 계약(봉투, 메시지 유형, 핸드셰이크, 수명주기, 오류 코드, 제한, 버전) + 아티팩트 측 설계 + 활용 예 5가지 |
| `docs/spec/02-…` | 확장 측 설계(구성요소, SW 수명, op 레지스트리, 권한 4겹, 보안, 오류 매핑, 테스트) |
| `docs/postal-notes/` | postal 구현 노트(v1·v1-decide·v2). 프레임 origin 실측 등 함정이 적혀 있다 |
| `docs/app-side/` | 아티팩트 쪽 참고: 핸드오프, 앱 프롬프트, 앱 소스 v1.1.0. v2 브리지 작성 시 참고 |
| `reference/src/` | postal 의 v2 구현 원본(**읽기 전용 참고용**, 빌드 대상 아님) |
| `reference/config/` | postal 의 manifest, package.json, tsconfig, vite·vitest 설정 |

`reference/` 는 복사본이다. 새 코드는 저장소 루트의 `src/` 에 만들고, 필요한 부분을 `reference/` 에서 복사해 편집한다.

## 3. 가져갈 것 / 버릴 것

### 가져갈 것 (일반화 필요 표시)

| 파일 | 용도 | 일반화할 점 |
| --- | --- | --- |
| `lib/protocolV2.ts` | 봉투 검증, 오류 코드, call 검증 | `PROVIDES`, `WEB_QUERY_ADAPTERS`, `toLookupRequest` 가 우편번호 전용 → 어댑터 레지스트리로 대체. `ns` 정규식·봉투 검증은 그대로 사용 가능 |
| `background/session.ts` | 포트별 세션, v2 hello/call/cancel, `runQueued` | v1 처리와 `lookup` 결합 제거. op 레지스트리 디스패치로 교체 |
| `content/bridge.ts` | window ↔ SW 포트 중계, 끊김 시 오류 반환 | origin 허용(`isAllowedAppOrigin`, `hasAllowedParent`)을 설정화. v1 분기 제거 |
| `background/bridge.ts` | `onConnect` 검증(`sender.origin`), 세션 생성 | `decideClient` 제거 |
| `background/queue.ts` | 직렬 큐, 최소 간격, 취소, 타임아웃 | 거의 그대로. 간격은 어댑터별로 |
| `background/session.test.ts` 의 `프로토콜 v2` 블록 | 핸드셰이크, busy, cancel, timeout 시나리오 | v2 부분만 발췌해 mock 어댑터로 재작성 |
| `config/*` | MV3 + crxjs + vitest 구성 | 이름·권한만 수정 |

### 버릴 것 (postal 전용, 복사하지 않았다)

`lookup`, `decide`, `match/*`, `fuzzy`, `learn`, `db`, `pageCache`, `decideCache`, 팝업(React UI), 골드셋 평가 스크립트, v1 프로토콜(`protocol.ts` 는 **참고용**으로만 복사).

## 4. 첫 작업 목록 (권장 순서)

1. **스캐폴딩**: `reference/config/` 에서 루트로 복사 후 편집. 이름 `claude-ex`, manifest 의 `host_permissions`·콘텐츠 스크립트 매치 정리(`optional_host_permissions` 로 전환). `npm i`, `tsc`, `vitest` 가 빈 상태로 통과하게 만든다.
2. **프로토콜 코어 이식**: `protocolV2.ts` 에서 우편번호 전용 부분을 걷어내고, 봉투·검증·오류·`validateCall` 만 남긴다. 테스트 먼저.
3. **op 레지스트리**: 명세 2/2 4.1의 정의 객체(`name, ver, kind, argsSchema, resultSchema, permissions, consent, limits, handler`)와 실행 순서(봉투 → 오리진 → op → 스키마 → 권한 → 동의 → 동시성 → 핸들러 → 정제 → 전송). `session.ts` 를 이 디스패치로 교체.
4. **어댑터 레지스트리**: `{id, hosts[], buildRequest(params), parse(body) → items}`. 번들 안에만 둔다. mock 어댑터 + 저장 샘플 기반 파싱 테스트로 시작.
5. **오리진 허용 목록 설정화**: 매치 오리진을 코드에 박지 않는다(명세 2장). 옵션 페이지에서 사용자가 허용.
6. **권한·동의 계층**: 호스트 권한(옵션 페이지, 사용자 제스처), 오리진·op 허용, 호출 동의(`first_use`/`every_time`)를 확장 UI 로 띄운다. **`write`/`sensitive` op 는 이게 끝나기 전에 넣지 않는다.**
7. 감사 로그(최근 500건, 본문 저장 금지), 툴바 배지, 팝업 최근 20건.
8. 이후 op 확장: `file.save` → `kv.*` → `page.fill` 순(위험이 낮은 순).

## 5. 설계 결정 / 함정 (postal 에서 확인한 것)

- **앱 프레임 origin 은 `https://<uuid>.frame.claudeusercontent.com`**, 상위 프레임에 `https://claude.ai` 가 있다. 중간 프레임의 `https://claude.ai` 를 앱 origin 으로 오인하지 않는다. `location.ancestorOrigins` 로 상위 프레임을 확인한다(`docs/postal-notes/protocol-v1-notes.md`).
- 콘텐츠 스크립트는 `all_frames`, `match_about_blank`, `match_origin_as_fallback`, `run_at: document_start`. 포트는 **앱의 첫 메시지를 기다리지 않고 미리 연결**한다(확장발 요청과 SW 재시작 대응).
- 샌드박스 iframe origin 이 `null` 일 수 있어 `postMessage` targetOrigin 은 `'*'` 로 대체한다. 메시지에 비밀을 싣지 않는다.
- postMessage 채널은 인증되지 않는다. 위험 op 는 페이지 안내가 아니라 **확장 UI 동의**로만 통과시킨다.
- SW 는 유휴 시 종료된다. 호출 상태를 메모리에만 두지 않고, 포트가 끊기면 콘텐츠 스크립트가 진행 중 id 마다 `internal`(`detail: worker_restarted`, `retryable: true`)을 돌려준다(postal 구현됨, `chrome.storage.session` 기록은 미구현).
- 큐 타임아웃은 **큐에서 실행이 시작된 시점부터** 센다. v2 동시성은 세션당 op 1건, 초과는 `busy`.
- v2 봉투 `source` 가 v1 과 달라(`ab-app`/`ab-ext`) 병행해도 간섭하지 않는다. 새 프로젝트는 v2 만 구현한다.
- **두 확장 공존 문제**: postal 확장과 claude-ex 가 같은 브라우저에 설치되면 같은 프레임에 콘텐츠 스크립트가 둘 주입되고 둘 다 `hello_ack` 한다. 아티팩트가 `provides` 로 op 를 구분하도록 op 이름을 겹치지 않게 하거나(`web.query` 는 postal 이 이미 사용), 하나가 다른 쪽 `ns` 에는 응답하지 않게 정한다. → **해결(2026-10-18)**: postal 은 v2 에 직접 응답하지 않고 허브의 플러그인으로 등록한다(10절, 명세 02 8장).

## 6. 미결정 / 사용자 확인이 필요한 사항

- 정식 이름과 스토어 설명, 개인정보 고지.
- 지원할 첫 어댑터(후보: 환율, 택배 추적, 사업자 상태, 법령). 쿠키 불필요한 공개 API 우선.
- 아티팩트 쪽 브리지: 이미 `anthropic-skills:artifact-extension-bridge` 스킬(ABP v2 브리지, 진단 패널, 모의 확장)이 있다. 이 스킬이 사용하는 계약이 `docs/spec/01` 과 일치하는지 확인 필요.
- ~~postal 쪽 확장을 계속 v2 로 유지할지~~ → 결정(2026-10-18): postal 은 기존 앱과 v1 직통을 당분간 유지하고, v2 는 허브 경유로만 제공한다. 앱이 v2 로 옮기면 허브가 필수가 된다.
- Firefox 대응: 빌드 도구는 crxjs 유지. Firefox 허브는 별도 프로젝트로 포크할 예정이며, 코어를 공유할지는 포크할 때 정한다. 걸림돌: `location.ancestorOrigins` 미지원, MV3 `service_worker` 배경 미지원.

## 7. postal 저장소 현재 상태 (참고)

- 브랜치 main, v2 병행 구현 커밋 `e74360b`(`web.query` v1, 어댑터 `epost-zip`·`juso-addr`·`zip-auto`). 테스트 193 통과.
- v2 미구현: 권한 게이트, 동의 UI, 옵션 페이지, 감사 로그, `file.save`·`page.fill`·`kv.*`, `ai.decide`(확장 → 앱, 아직 v1 경로), hello 재시도, 능력 캐시 폐기, `idempotencyKey`, `chrome.storage.session` 기록.
- 개발 서버는 사용자가 직접 관리한다. `.next`/빌드/dev 명령은 임의 실행하지 않는다.

## 8. 작업 규칙 (사용자 전역 지침 요약)

- 파일 이동·복사는 `cp` 등 셸 명령으로 하고 `fd` 로 검증한다. Read/Write 전사 금지.
- 검증은 `npx tsc --noEmit`·`vitest` 우선.
- 계획 단계에서는 모호한 점을 임의로 정하지 말고 사용자에게 구체적으로 질문해 컨펌을 받는다.

## 9. PoC 진행 상황 (2026-10-17)

계획: `docs/plans/2026-10-17-poc-extension.md`. 구현은 `src/`, 빌드는 Svelte 5 + Vite + crxjs.

| 경로 | 내용 |
| --- | --- |
| `src/lib/protocol.ts`, `schema.ts`, `calc.ts`, `origin.ts`, `messages.ts` | 봉투·오류·검증, JSON Schema 부분집합, 수식 파서, 오리진 검사, 팝업↔SW 메시지 계약 |
| `src/background/registry.ts`, `ops/calc.ts` | op 레지스트리(`meta.describe` 자동 포함), `calc.eval@1` |
| `src/background/session.ts` | 포트별 세션. 제공자(앱 call 처리·로그)와 호출자(`callApp`, timeout+2초, busy 재시도 2회) |
| `src/background/translate.ts` | `text.translate` 라우팅(최근 연결 앱, 없으면 탭 열고 30초 대기), 작업 상태, 결과 뒤 팝업 재오픈 |
| `src/background/log.ts` | 앱 → 확장 호출 로그(IndexedDB, 본문 포함 — PoC 예외) |
| `src/background/settings.ts` | AI tier(quick/normal/advanced) 저장 |
| `src/popup/` | 팝업 UI(tier, 번역 입력·결과, 연결 상태) |

남은 일: 아티팩트 게시 후 `src/config.ts` 의 `ARTIFACT_URL` 채우기, 실제 브라우저 E2E, 게시 페이지의 프레임 origin 실측, 로그 열람·다운로드 UI.

## 10. 플러그인 구조 (2026-10-18)

계획: `docs/plans/2026-10-18-plugin-hub.md`, 명세: `docs/spec/02-…` 8장. 새 기능은 허브 코드에 op 를 넣는 대신 별도 확장(플러그인)이 허브에 op·어댑터를 등록할 수 있다.

| 경로 | 내용 |
| --- | --- |
| `src/sdk/` | `@claude-ex/sdk`. 허브와 플러그인이 공유하는 계약(오류, 스키마, 플러그인 채널, `serveAsCompanion`). chrome·`@/` 별칭 의존 금지. postal 이 `file:../claude-ex/src/sdk` 로 참조하므로 두 저장소는 `D:\projects` 아래 나란히 둔다 |
| `src/background/plugins.ts` | `PluginHost`: 등록 수신, 승인·거부·해제, 카탈로그 해시가 바뀌면 재승인 대기, 호출 중계 |
| `src/background/registry.ts` | 플러그인 상태로 다시 만드는 레지스트리. 내장 `web.query@1`(어댑터 병합), `meta.describe` 어댑터 상세 |

- 허브 확장 ID 는 manifest `key` 로 `cmnfclffoomldhdnghjbcdgednhaknho` 에 고정했다. 키 쌍은 저장소 밖 `%USERPROFILE%\.claude-ex-keys\` 에 있다(비밀키는 커밋하지 않는다).
- 첫 플러그인은 postal(`web.query` 어댑터 `epost-zip`·`juso-addr`·`zip-auto`). postal 은 manifest 에 `key` 를 넣지 않는다(ID 가 바뀌면 학습 데이터·캐시를 잃는다).
- 플러그인 만들기: SDK 의 `serveAsCompanion({hubId, name, version, catalog, handle})` 을 서비스 워커에서 한 번 부른다. 예시는 postal `src/plugin/`.
