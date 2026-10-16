# 위임 프로토콜 v2 — 확장 구현 노트

명세: 「확장 위임 프로토콜 설계 (1/2) 공통 계약, (2/2) 브라우저 확장 측」. v1 과 병행하며 v1 동작은 바뀌지 않았다(봉투 source 가 `ab-app`/`ab-ext` 로 달라 서로 간섭하지 않는다).

## 구현한 것 (2026-10-16)

| 항목 | 내용 | 위치 |
| --- | --- | --- |
| 봉투·검증·오류 코드 | `ab-app`/`ab-ext`, v=2, ns, 13개 오류 코드, v1 오류 → v2 매핑 | `src/lib/protocolV2.ts` |
| 핸드셰이크 | 포트 연결 시 확장이 먼저 `hello`, 앱 `hello` 에는 `hello_ack`(provides, supportedVersions `[2]`) | `session.ts` `hello()` |
| op `web.query` v1 (read) | 기존 lookup 을 op 로 노출. 인자 `{adapter, params, limit?, analyze?}`, 어댑터 `epost-zip`·`juso-addr`·`zip-auto`. 선언 외 필드 거부. 결과 `data.items`, `meta.untrusted: true` | `protocolV2.ts`, `session.ts` `callV2` |
| 수명주기 | progress, cancel, 동시 1건 초과 `busy`, timeout, 포트 끊김 시 `internal`(`detail: worker_restarted`) | `session.ts`, `content/bridge.ts` |

## 아직 없는 것 (명세 대비)

- 권한 게이트 4겹, 동의 UI, 옵션 페이지, 감사 로그: 현재 op 가 `read` 뿐이라 `consent: false`. `write`/`sensitive` op 를 넣기 전에 구현해야 한다.
- `file.save`, `page.fill`, `kv.put/get`: 미구현(`unsupported_op`).
- `ai.decide`(확장 → 앱): 아직 v1 `probe/ready/decide` 경로를 쓴다. 앱이 v2 `serve` 를 구현하면 호출자 역할로 이전한다.
- hello 재시도(최대 3회), 능력 캐시 폐기, `idempotencyKey`, `chrome.storage.session` 기록: 미구현.
- 오리진 허용 목록 설정화: 현재는 v1 과 같이 `*.frame.claudeusercontent.com` + `claude.ai` 상위 프레임 고정.

## 앱 쪽 필요 작업

앱(아티팩트)이 v2 hello 를 보내야 `call web.query` 를 쓸 수 있다. 확장은 앱이 v1 만 알아도 지장 없다(v2 hello 는 무시된다).
