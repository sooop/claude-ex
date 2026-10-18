# claude-ex (가칭)

아티팩트의 외부 동작(fetch, 파일 저장, 탭 입력 등)을 대신 수행하는 범용 위임 브라우저 확장. 우편번호 확장의 위임 프로토콜 v2 를 일반화하는 프로젝트다.

**현재 상태: 개념 실증(PoC) 확장.** `calc.eval`(앱 → 확장)과 `text.translate`(확장 → 앱) 두 op 로 양방향 경로를 확인한다. 계획은 `docs/plans/2026-10-17-poc-extension.md`, 아티팩트 요구사항은 `docs/spec/04-…`. `reference/` 는 postal 구현의 복사본(참고용)이다.

```
npm i
npm test        # vitest
npm run build   # dist/ 를 chrome://extensions 에서 '압축해제된 확장 로드'
```

시작은 [HANDOFF.md](HANDOFF.md) 를 읽는다. 설계 원본은 `docs/spec/`.
