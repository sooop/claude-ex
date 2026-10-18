# 확장 어댑터 명세서 템플릿

아티팩트 개발 전에 초안, 개발 중에 변경 내역, 완료 후에 최종본을 채팅에 출력할 때 쓴다. 스키마는 앱 코드의 `ABP.call` 인자, `ABP.serve`의 `args`, 모의 확장의 `desc`와 같은 값이어야 한다. 스키마는 JSON Schema 부분집합(type, properties, required, items, enum, minimum, maximum, minLength, maxLength, maxItems, default, description)만 쓴다. 공통 계약(봉투, 메시지 유형, 공통 오류 코드)은 반복하지 않고 "ABP v2 공통 계약"을 참조한다고 적는다.

```md
## 확장 어댑터 명세서 v1 (ns: my-app, 앱 v1.0.0, ABP v2)

### 1. 연동 개요
| op@ver | kind | consent | 어댑터 | 필수 | 확장이 없을 때 앱의 폴백 |
| --- | --- | --- | --- | --- | --- |
| web.query@1 | read | none | epost-zip | 선택 | Claude 호출 또는 수동 입력 |

### 2. 확장이 구현할 op
#### web.query@1 / 어댑터 epost-zip
- 목적과 쓰는 때: 도로명 주소로 우편번호를 조회한다. 대상 호스트: epost.go.kr
- args: {adapter:'epost-zip', params:{query: string(2~100자)}}
- result: {rows:[{zip: string(5자리), address: string(300자 이하)}]} (최대 20건)
- 오류: blocked(대상 차단), parse_failed(응답 해석 실패), network(재시도 가능), invalid_request(params 위반)
- 한도: timeoutMs 15000, 결과 1MiB 이하, 동시성 1
- 파싱 주의와 앱이 적용하는 정제: 주소는 300자로 자르고 태그를 제거한다
- 예시 call: {"op":"web.query","ver":1,"args":{"adapter":"epost-zip","params":{"query":"테헤란로 1"}}}
- 예시 result: {"ok":true,"data":{"rows":[{"zip":"06236","address":"서울 강남구 테헤란로 1"}]}}
- 예시 오류: {"ok":false,"error":{"code":"blocked","message":"대상이 접근을 차단했습니다","retryable":false}}

### 3. 앱이 제공하는 op (확장이 호출)
(같은 형식. 사용자 토글과 분당 한도를 함께 적는다. 없으면 "없음")

### 4. 확장 구현 요구
- `meta.describe` 응답에 2번 규격을 그대로 실을 것(앱이 첫 호출 전에 args를 대조하며 어긋나면 incompatible로 막는다)
- summary 80자, hint 120자 이하. `catalogRev`와 카탈로그가 바뀔 때 `catalog_changed` 이벤트
- needs_setup 조건과 hint 문구, 필요한 호스트 권한, write/sensitive의 동의 UI
- 처리할 수 없을 때 돌려줄 오류 코드

### 5. 시험 방법
앱의 연동 진단 패널을 열고 op 목록에서 `상세`로 describe 응답을, `예시 채우기`와 `실행`으로 호출을 확인한다.
```
