# 플러그인 허브 + postal 동반 플러그인 계획

## Context

새 기능을 만들 때마다 claude-ex 코드에 op를 직접 추가하는 대신, **다른 확장이 허브(claude-ex)에 op와 어댑터를 등록**하는 구조를 만든다. 첫 플러그인은 postal이다. postal의 우편번호 조회(`web.query`의 어댑터 `epost-zip`, `juso-addr`, `zip-auto`)를 허브를 거쳐 아티팩트에 제공한다.

MV3는 원격 코드 실행을 금지하므로 플러그인 코드를 허브가 내려받아 실행할 수 없다. 그래서 플러그인은 **자기 코드를 담은 별도 확장**이고, 허브와는 확장 간 메시지(`chrome.runtime.connect(extId)` / `onConnectExternal`)로 통신한다. 아티팩트는 지금처럼 허브 하나와만 v2로 대화한다.

인터뷰로 확정한 사항:

| 항목 | 결정 |
| --- | --- |
| 배포 | 개인용(압축해제 설치). 스토어 심사를 고려하지 않는다 |
| postal의 v1 | 당분간 기존 앱과 v1으로 직접 통신한다. 이번 작업에서 v1 경로는 건드리지 않는다 |
| postal의 v2 | **postal은 v2에 직접 응답하지 않는다.** v2는 허브를 거쳐서만 제공한다. 허브가 없으면 v1만 동작한다. 같은 프레임에서 허브와 postal이 둘 다 `hello_ack`하는 공존 문제가 이걸로 사라진다. 대가: 앱이 v2로 옮긴 뒤에는 허브가 필수가 된다 |
| op 이름 | `web.query` 하나를 공유하고, 플러그인이 어댑터를 보탠다. 허브는 `args.adapter`로 담당 플러그인을 찾는다. 같은 어댑터 id나 op 이름을 다른 플러그인이 이미 쓰고 있으면 등록을 거부한다 |
| 신뢰 | 승인한 플러그인의 선언(kind, 설명, 스키마)은 그대로 믿는다 |
| 등록 승인 | 처음 등록할 때 사용자가 승인한다. 요청이 오면 허브 툴바에 배지를 띄우고, 팝업의 "승인 대기" 카드에서 허용 또는 거부한다 |
| 카탈로그가 바뀔 때 | **바뀔 때마다 다시 승인한다.** 카탈로그(op, 어댑터, 스키마, 설명)의 해시가 승인 때와 다르면 그 플러그인을 끄고 승인 대기로 돌린다. 이전 카탈로그를 계속 쓰지 않는 이유는, 새 코드가 옛 어댑터를 더 이상 지원하지 않을 수 있기 때문이다. 코드만 바뀌고 카탈로그가 같으면 다시 묻지 않는다 |
| SDK 공유 | claude-ex에 `src/sdk/`(chrome과 프레임워크에 의존하지 않음)를 만들고, postal은 `file:../claude-ex/src/sdk`로 참조한다. 두 저장소가 `D:\projects` 아래 나란히 있어야 한다 |
| 범위 | 허브와 postal을 이 계획 하나에서 다루고, 저장소별·단계별로 나눠 커밋한다 |
| 빌드 도구 | crxjs를 유지한다. Firefox 대응(별도 프로젝트로 포크)은 나중에 정한다. 이번 계획은 Firefox를 고려하지 않는다 |

## 확장 간 통신 계약 (플러그인 채널)

허브와 플러그인 사이에만 쓰는 내부 계약이다. 아티팩트와 주고받는 v2 봉투와는 별개다.

**등록** — 플러그인 → 허브, `chrome.runtime.sendMessage(HUB_ID, msg)`

```ts
{ kind: 'abp-plugin/register', sdk: 1, name: 'postal', version: '1.0.0', catalog: PluginCatalog }
// 응답: { status: 'active' | 'pending' | 'rejected', reason?: string }
```

- 플러그인은 서비스 워커가 시작될 때마다 등록을 보낸다. 허브가 없으면 `lastError`가 나고, 플러그인은 그냥 무시한다.
- `PluginCatalog = { ops: PluginOpDef[], adapters: { [op]: AdapterDef[] } }`. 함수는 담지 않고, 직렬화 가능한 선언만 담는다.
- `AdapterDef = { id, summary, description, params: Schema, resultNotes?, hosts[], notes? }`. 명세 01의 `meta.describe` 어댑터 상세 형식과 같다.
- `PluginOpDef`는 허브의 `OpDef`에서 `handler`를 뺀 형태다. postal은 이번에 쓰지 않지만, "플러그인이 자기 op를 추가하는" 경우를 위해 계약에 포함한다.
- 허브는 `sdk` 버전이 맞지 않거나, 크기가 상한(32KiB)을 넘거나, 형식이 틀리면 `rejected`를 돌려준다.

**호출** — 허브 → 플러그인. 호출 1건마다 포트 1개: `chrome.runtime.connect(pluginId, { name: 'abp-plugin/call' })`

```
허브 → { type: 'invoke', op, ver, adapter?, args, timeoutMs, sender: { ns, origin } }
플러그인 → { type: 'progress', stage, detail?, pct? }*  →  { type: 'result', ok, data? | error? }
허브 → { type: 'cancel' }        // 또는 포트 끊기 = 취소
```

- 포트 연결이 플러그인의 서비스 워커를 깨운다. 연결이 끊기면 양쪽 모두 그 호출을 끝낸다.
- 플러그인은 `sender.id === HUB_ID`인 연결만 받는다. 허브는 승인된 플러그인 id에만 연결한다.
- 플러그인에 연결하지 못하면(삭제·비활성화) `internal`, `detail: 'plugin_unreachable'`, `retryable: true`로 응답한다.

**v2 `web.query` 인자 형식 변경**: postal의 기존 v2 인자는 `{adapter, params:{searchText, oldAddr, oldZip}, limit?, analyze?}`였다. 이를 명세 01의 공통 형식 `{adapter, params}`로 바꾸고, `limit`과 `analyze`는 `params` 안으로 옮긴다. 허브의 `web.query`가 플러그인마다 다른 최상위 필드를 알 수 없기 때문이다. 지금 v2를 쓰는 앱이 없으므로 깨지는 소비자는 없다.

## 단계

### 1단계 — claude-ex: SDK 분리 (순차, 다른 단계의 선행 조건)

- `src/sdk/` 생성. `package.json`은 `{ "name": "@claude-ex/sdk", "type": "module", "exports": "./index.ts" }`. 내부 import는 상대 경로만 쓴다. `@/` 별칭을 쓰면 postal에서는 postal의 `src`를 가리키므로 금지한다.
  - `schema.ts`: `src/lib/schema.ts`를 `git mv`로 옮긴다. `src/lib/schema.ts`는 재수출만 하는 파일로 남겨 기존 import를 유지한다.
  - `errors.ts`: `V2Error`, `V2_ERRORS`, `V2_ERROR_CODES`, `normalizeError`를 `src/lib/protocol.ts`에서 옮긴다. `protocol.ts`는 이것을 재수출한다.
  - `plugin.ts`: `PluginCatalog`, `PluginOpDef`, `AdapterDef`, 채널 메시지 타입, `SDK_VERSION = 1`, `catalogHash()`(키 정렬 JSON의 FNV-1a 해시), `validateCatalog()`.
  - `companion.ts`: 플러그인 쪽 헬퍼. `serveAsCompanion({ hubId, name, version, catalog, handle(invoke, ctx) })`는 다음을 묶는다.
    - 시작할 때 등록 요청을 보낸다.
    - `onConnectExternal`에서 허브 id를 검사한다.
    - invoke, progress, result, cancel을 처리한다(`AbortSignal` 제공).
    - `params`를 어댑터 스키마로 다시 검증한다(플러그인 쪽 방어).
    - chrome API는 인자로 주입받는다. 그래야 테스트에서 가짜 API로 바꿀 수 있다.
- 검증: `npm test`, `npm run typecheck`가 이전과 같은 결과로 통과한다(재수출이라 동작 변화 없음).

### 2단계 — claude-ex: 허브의 플러그인 수용 (2·3단계는 병렬)

- **`src/background/plugins.ts` (`PluginHost`)**
  - 상태를 `chrome.storage.local`의 `plugins`에 저장한다: `{ [extId]: { name, version, catalog, hash, status: 'active' | 'pending' | 'denied', approvedHash? } }`.
  - `onMessageExternal`에서 register를 받는다.
    - 승인된 해시와 같으면 `active`로 둔다.
    - 해시가 다르면 플러그인을 끄고 `pending`으로 바꾼다.
    - 같은 해시로 이미 거부했던 요청이면 다시 묻지 않는다.
    - 다른 플러그인과 어댑터 id나 op 이름이 겹치면 `rejected`로 응답한다.
  - `approve(extId)`, `deny(extId)`, `remove(extId)`를 제공한다.
  - `invoke(extId, req, signal, onProgress)`로 호출 1건마다 포트를 열고 결과를 기다린다.
  - chrome API는 주입받는다.
- **레지스트리를 동적으로 바꾼다** (`src/background/registry.ts`)
  - `createRegistry`가 기본 op에 더해 플러그인 op와 어댑터를 반영해 다시 만들 수 있게 한다(`rebuild(pluginState)`). `catalogRev`도 다시 계산한다.
  - 허브 자체 op로 **`web.query@1`**(kind `read`)을 둔다. 인자는 `{adapter: string, params: object}`다.
    - 핸들러가 어댑터 id로 담당 플러그인을 찾고, `params`를 그 어댑터의 스키마로 검증한 뒤 `PluginHost.invoke`로 넘긴다.
    - 활성 어댑터가 하나도 없으면 `provides`에서 빠진다.
    - 결과에는 `meta.untrusted: true`를 붙인다(외부 사이트에서 가져온 텍스트이기 때문).
  - `meta.describe`가 `adapter` 인자를 지원하게 한다. 명세 01 3.8의 어댑터 상세 형식을 돌려주고, 지금은 거부하는 분기를 바꾼다. `provides`의 `adapters: [{id, summary}]`도 채운다.
  - 플러그인이 가진 op도 같은 방식으로 등록한다. 핸들러는 `PluginHost.invoke`로 보낸다.
- **카탈로그 변경 알림**: 레지스트리를 다시 만들면 열린 모든 세션에 `event` `catalog_changed { catalogRev }`를 보낸다(명세 01 3.8). `AppSession`에 `notifyCatalog()`를 추가한다.
- **서비스 워커 재시작**: `index.ts`가 저장된 플러그인 상태를 불러온 다음 레지스트리를 만든다. 세션의 첫 `hello`는 이 로딩이 끝난 뒤에 보낸다. 지금 `restored` promise로 번역 작업을 기다리는 것과 같은 방식이다.
- **허브 ID 고정**: manifest에 `key`를 추가한다. 키 쌍은 생성해서 저장소 밖(사용자 폴더)에 보관한다. 처음 한 번 확장 ID가 바뀌므로, 지금 허브에 쌓인 PoC 로그와 tier 설정이 사라진다(되돌릴 수 없지만 PoC 데이터다). 고정된 ID는 `docs/`에 기록한다.
- **팝업 UI** (`App.svelte`, `messages.ts`)
  - "플러그인" 섹션을 추가한다.
    - 승인 대기 카드: 확장 이름, ID, 버전, 제공할 op와 어댑터 목록, 이전 승인과의 차이(어댑터 추가·삭제). 허용/거부 버튼을 둔다.
    - 승인된 플러그인 목록: 해제 버튼을 둔다.
  - 메시지 추가: `PopupRequest`에 `plugins`, `approvePlugin`, `denyPlugin`, `removePlugin`을, `PopupEvent`에 `pluginsChanged`를 추가한다.
- **배지**: 번역 작업 배지(`1`, `…`)가 우선한다. 번역 작업이 없을 때 승인 대기가 있으면 대기 건수를 주황색으로 표시한다.
- **테스트** (vitest, 가짜 chrome 주입)
  - PluginHost: 등록 → 대기 → 승인 → 활성. 해시가 바뀌면 다시 대기로 돌아가고 플러그인이 꺼진다. 같은 해시로 거부했으면 다시 묻지 않는다. 어댑터 id가 겹치면 거부한다. sdk 버전이 다르거나 크기를 넘으면 거부한다.
  - 레지스트리: 어댑터를 추가·삭제하면 `catalogRev`가 바뀐다. `web.query`가 provides에 나타나거나 사라진다. `describe(op, adapter)`가 동작한다.
  - 세션: `web.query`를 어댑터별 플러그인으로 보낸다. params가 스키마를 위반하면 `invalid_request`가 난다. 취소하면 포트가 끊긴다. timeout이 동작한다. 플러그인에 연결할 수 없으면 `plugin_unreachable`이 난다. 승인하면 `catalog_changed` 이벤트가 나간다.

### 3단계 — postal: 동반 플러그인 전환 (2단계와 병렬, 1단계에만 의존)

- `package.json`에 `"@claude-ex/sdk": "file:../claude-ex/src/sdk"`를 추가한다. Vite와 vitest가 저장소 밖의 TS 소스를 처리하는지 확인한다. 필요하면 Vite의 `server.fs.allow`나 vitest의 `deps` 설정을 조정한다.
- **`src/plugin/catalog.ts`**: `web.query`용 어댑터 3개의 선언(id, summary, description, `params` 스키마 `{searchText?, oldAddr?, oldZip?, limit?, analyze?}`, hosts). `protocolV2.ts`의 `WEB_QUERY_ADAPTERS`와 설명을 옮겨 온다.
- **`src/plugin/index.ts`**: `serveAsCompanion`에 연결한다. `handle`은 `toLookupRequest`를 새 인자 형식에 맞게 고쳐 조회 요청으로 바꾸고, 기존 `RequestQueue`를 거쳐 `runLookup`을 실행한다. 팝업 검색과 v1 조회가 같은 큐를 쓰므로 우체국 요청 간격 규칙이 그대로 지켜진다. 이를 위해 `BridgeSession.runQueued`의 큐 실행 부분을 세션 밖의 함수로 꺼내 v1과 플러그인이 함께 쓴다.
- `HUB_ID`는 `src/lib/settings.ts` 쪽의 상수로 둔다. 2단계에서 정해지는 고정 ID를 넣는다.
- **v2 직접 응답 제거**
  - `session.ts`: `handleV2`, `callV2`, `hello`, `sendV2`, `activeV2`를 지운다.
  - `bridge.ts`: `session.hello()` 호출을 지운다.
  - `content/bridge.ts`: v2 봉투 전달 분기와 `pendingLookups`의 v2 처리를 지운다.
  - `protocolV2.ts`: `PROVIDES`와 봉투 관련 코드를 지우고, 조회 변환과 오류 변환(`toV2Error`)만 남긴다.
  - v1(`ping`, `lookup`, `decide`) 경로는 바꾸지 않는다.
- postal manifest는 바꾸지 않는다(`key`를 넣지 않음). `key`를 넣으면 postal의 확장 ID가 바뀌어 학습 데이터, 캐시, 설정을 잃는다. `externally_connectable`이 없으면 다른 확장이 연결할 수 있으므로 별도 선언은 필요 없다.
- **테스트**
  - `session.test.ts`의 v2 테스트 블록을 지우고, v1 테스트가 그대로 통과하는지 확인한다.
  - 플러그인 핸들러 테스트(가짜 포트): 정상 조회, params 위반, 취소, 큐 timeout, 허브가 아닌 확장 id의 연결 거부.
  - 등록 메시지의 카탈로그가 SDK의 `validateCatalog`를 통과하는지 확인한다.

### 4단계 — 문서와 실제 브라우저 확인 (순차)

- **문서**
  - 명세 02: 플러그인 채널, 등록 승인, 어댑터 병합, 카탈로그가 바뀌면 다시 승인하는 규칙을 추가한다.
  - `HANDOFF.md`: 5절의 공존 문제를 해결된 것으로 표시하고, 6절의 "postal을 v2로 유지할지"에 결정을 기록한다.
  - postal `docs`: v2 노트에 "v2는 허브 경유"를 기록한다.
- **실제 브라우저 확인** (Chrome, 두 확장 모두 압축해제 설치)
  1. 허브만 설치: `web.query`가 provides에 없다.
  2. postal을 설치하거나 다시 불러오면 허브 배지에 대기 건수가 뜬다. 팝업에서 승인하면 열린 아티팩트에 `catalog_changed`가 오고, `web.query`와 어댑터 3개가 나타난다.
  3. 진단 패널(`artifact-extension-bridge/abp/diag.html` 기반 아티팩트)에서 `describe(web.query, zip-auto)`를 확인하고 실제로 조회한다. 진행 표시, 취소, 결과의 `untrusted` 표시를 확인한다.
  4. postal의 카탈로그 설명을 한 글자 바꿔 다시 불러오면, 플러그인이 꺼지고 다시 승인 대기가 된다.
  5. postal을 비활성화한 상태에서 호출하면 `plugin_unreachable`이 난다.
  6. 허브를 끈 상태에서 postal 기존 앱의 v1 조회와 판정이 이전처럼 동작한다(회귀 확인).
  7. 두 확장이 모두 켜진 상태에서 v2 `hello_ack`가 한 번만 온다.

## 병렬 처리와 에이전트

- 1단계는 직접 수행한다(경계 설계라 판단이 필요하다).
- 1단계가 끝나면 2단계와 3단계를 서브 에이전트로 병렬 진행한다. 두 단계는 서로 다른 저장소를 다루고, 공통으로 쓰는 것은 SDK 계약뿐이다.
  - 2단계: `worker`(sonnet). 동적 레지스트리, 승인 흐름, UI 설계 판단이 들어간다.
  - 3단계: `worker`. postal의 큐와 세션을 리팩터링하고 회귀를 판단해야 한다.
  - 테스트 보강이나 기계적 삭제처럼 완료를 실행으로 확인할 수 있는 하위 작업은 `builder`(haiku 5.5)에 맡긴다.
- 통합 뒤 `verifier`로 다음을 검토한다: 플러그인 채널의 id 검사, 취소와 타임아웃 전파, postal의 v1 회귀.

## 회귀 위험과 대응

| 위험 | 대응 |
| --- | --- |
| 허브의 확장 ID가 바뀌어 PoC 로그와 tier 설정이 사라진다 | PoC 데이터라 감수한다. 필요하면 진행 전에 로그를 내보낸다 |
| postal의 v2 제거로, 허브 없이는 v2를 쓸 수 없다 | 결정된 사항이다. 앱을 v2로 옮길 때 허브를 함께 설치해야 한다고 문서에 적는다 |
| 카탈로그가 바뀔 때마다 다시 승인해야 해서 postal 개발 중 승인 대기가 잦다 | 결정된 사항이다. 승인 카드에 이전 승인과의 차이를 보여 줘 빨리 판단할 수 있게 한다 |
| `file:` 참조 때문에 postal 빌드가 claude-ex 경로에 의존한다 | 두 저장소를 같은 상위 폴더에 두는 것을 README에 적는다. SDK에 `@/` 별칭 금지를 지켜 경로 문제를 막는다 |
| runQueued 분리 중에 v1 조회 동작이 바뀔 수 있다 | v1 테스트를 수정 없이 통과시키는 것을 완료 조건으로 삼는다 |
