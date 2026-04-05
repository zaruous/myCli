# 코드 커버리지 가이드

KYJ CLI의 테스트 실행 및 커버리지 리포트 생성·최신화 방법을 설명합니다.

---

## 목차

1. [환경 요건](#환경-요건)
2. [빠른 시작](#빠른-시작)
3. [테스트 실행](#테스트-실행)
4. [커버리지 리포트 생성](#커버리지-리포트-생성)
5. [커버리지 최신화 절차](#커버리지-최신화-절차)
6. [커버리지 항목 설명](#커버리지-항목-설명)
7. [현재 커버리지 현황](#현재-커버리지-현황)
8. [새 테스트 추가 방법](#새-테스트-추가-방법)
9. [미커버 라인 관리](#미커버-라인-관리)

---

## 환경 요건

| 항목 | 버전 |
|---|---|
| Node.js | 18 이상 (ESM 지원) |
| c8 | `devDependencies`에 포함 (`npm install` 후 자동 설치) |

```bash
# 설치 확인
node --version
node_modules/.bin/c8 --version
```

---

## 빠른 시작

```bash
# 테스트 실행 (결과만 확인)
node test/test-new-features.js

# 커버리지 리포트 생성 (터미널 출력 + HTML)
node_modules/.bin/c8 --reporter=text --reporter=html --include="lib/*.js" --output-dir=coverage node test/test-new-features.js
```

---

## 테스트 실행

### 기본 실행

```bash
node test/test-new-features.js
```

테스트 통과 시:
```
==================================================
 결과: 123개 중 123 PASS / 0 FAIL
==================================================
```

실패 시 exit code 1로 종료됩니다.

### package.json 스크립트

```bash
npm test                # test/test-new-features.js
npm run test:integration  # test/test-integration.js
npm run test:all          # 두 파일 모두 실행
npm run test:coverage     # c8 커버리지 포함 실행 (기존 설정)
```

---

## 커버리지 리포트 생성

### 터미널 텍스트 리포트

```bash
node_modules/.bin/c8 --reporter=text --include="lib/*.js" node test/test-new-features.js
```

### HTML 리포트 (coverage/ 디렉터리 갱신)

```bash
node_modules/.bin/c8 --reporter=text --reporter=html --include="lib/*.js" --output-dir=coverage node test/test-new-features.js
```

생성 후 `coverage/index.html`을 브라우저로 열면 파일별 커버리지를 시각적으로 확인할 수 있습니다.

### index.js 포함 전체 리포트

```bash
node_modules/.bin/c8 --reporter=text --reporter=html --include="lib/*.js" --include="index.js" --output-dir=coverage node test/test-new-features.js
```

### 특정 파일만 확인

```bash
# hooks.js, hook-logger.js 만 확인
node_modules/.bin/c8 --reporter=text --include="lib/hooks.js" --include="lib/hook-logger.js" node test/test-new-features.js
```

---

## 커버리지 최신화 절차

새 기능을 추가하거나 테스트를 작성한 후에는 아래 순서로 커버리지를 최신화합니다.

### 1단계: 테스트 작성 및 통과 확인

```bash
node test/test-new-features.js
```

모든 테스트가 PASS인지 확인합니다.

### 2단계: HTML 리포트 재생성

```bash
node_modules/.bin/c8 --reporter=text --reporter=html --include="lib/*.js" --output-dir=coverage node test/test-new-features.js
```

### 3단계: 결과 확인

```bash
# 새로 생성된 파일 확인
ls coverage/
```

`coverage/index.html`을 열어 커버리지 수치와 미커버 라인을 확인합니다.

### 4단계: (선택) test-report.md 업데이트

새 테스트 그룹이 추가된 경우 `docs/test-report.md`의 요약 테이블을 갱신합니다.

---

## 커버리지 항목 설명

| 항목 | 의미 |
|---|---|
| **% Stmts** | 실행된 구문(statement) 비율 |
| **% Branch** | 실행된 분기(if/else, 삼항 등) 비율 |
| **% Funcs** | 호출된 함수 비율 |
| **% Lines** | 실행된 라인 비율 |
| **Uncovered Line #s** | 한 번도 실행되지 않은 라인 번호 |

Branch 커버리지는 Stmts/Lines보다 낮은 경우가 많습니다. 에러 핸들링용 `else` 분기나 null-guard 조건처럼 정상 흐름에서 도달하기 어려운 경우가 포함되기 때문입니다.

---

## 현재 커버리지 현황

> 기준일: 2026-04-05 | 테스트 수: 123개

```
----------------|---------|----------|---------|---------|--------------------------------------
File            | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
----------------|---------|----------|---------|---------|--------------------------------------
All files       |   96.04 |    80.41 |     100 |   96.04 |
 context.js     |   95.65 |      75  |     100 |   95.65 | 17
 diff.js        |     100 |    96.77 |     100 |     100 | 57
 hook-logger.js |     100 |    61.76 |     100 |     100 | 21,58,62,64-67,74,83,87,92-94,98-102
 hooks.js       |   98.63 |    84.44 |     100 |   98.63 | 79-80
 skills.js      |   96.82 |    72.22 |     100 |   96.82 | 58-59
 state.js       |      72 |    85.71 |     100 |      72 | 12-25
 utils.js       |     100 |      100 |     100 |     100 |
----------------|---------|----------|---------|---------|--------------------------------------
```

### 미커버 라인 사유

| 파일 | 라인 | 사유 |
|---|---|---|
| `state.js:12-25` | `resolveBaseDir()` 내 환경변수 오류 경로 | 모듈 초기화 시점 실행, import 이후 테스트 불가 |
| `hooks.js:79-80` | `spawn` error 이벤트 핸들러 | `shell:true` 환경에서 쉘이 에러를 exit code로 처리하므로 실질적 발생 불가 |
| `hook-logger.js` Branch | `if (!db)` null-guard 분기 | 정상 사용 흐름에서 db 닫힌 상태로 조회 호출 불가 |
| `context.js:17` | `catch` 블록 내 분기 | 파일 읽기 외의 예외 경로 |
| `diff.js:57` | 500줄 초과 폴백 내 조건 | 경계값 분기 |
| `skills.js:58-59` | 스킬 파일 파싱 에러 경로 | 정형 SKILL.md가 항상 입력됨 |

---

## 새 테스트 추가 방법

`test/test-new-features.js`에 테스트 함수를 추가하는 방법입니다.

### 1. 테스트 함수 작성

```js
// Test N: 기능 이름
async function testMyFeature() {
  console.log('\n[Test N] 기능 이름');

  // N-1: 케이스 설명
  {
    const result = myFunction('input');
    assert(result === 'expected', 'N-1: 예상 결과 설명');
  }

  // N-2: 에러 케이스
  {
    let threw = false;
    try { myFunction(null); } catch { threw = true; }
    assert(threw, 'N-2: null 입력 시 에러 발생');
  }
}
```

`assert(condition, label)` 함수는 파일 상단에 이미 정의되어 있습니다.

### 2. run() 함수에 등록

```js
async function run() {
  // ...기존 테스트...
  await testMyFeature();  // ← 추가
  // ...
}
```

### 3. 필요한 import 추가

```js
import { myFunction } from '../lib/my-module.js';
```

### 4. 임시 파일 사용 시 TMP_DIR 활용

```js
const filePath = path.join(TMP_DIR, 'test-file.txt');
await fs.writeFile(filePath, 'content', 'utf-8');
// teardown()에서 TMP_DIR 전체 삭제됨 — 별도 정리 불필요
```

### 5. SQLite DB 사용 시 반드시 닫기

```js
// DB를 열었다면 테스트 종료 전에 반드시 닫아야 teardown 시 EBUSY 방지
closeHookLogger();
```

---

## 미커버 라인 관리

### 커버리지가 낮아졌을 때

1. `Uncovered Line #s` 컬럼에서 새로 추가된 라인 번호 확인
2. 해당 라인이 테스트 가능한지 판단
   - **테스트 가능**: 테스트 케이스 추가 후 커버리지 재생성
   - **테스트 불가** (모듈 초기화, spawn 에러 등): 이 문서의 "미커버 라인 사유" 테이블에 사유 추가

### 커버리지 목표

| 지표 | 목표 |
|---|---|
| Statements | 95% 이상 |
| Functions | 100% |
| Lines | 95% 이상 |
| Branch | 75% 이상 |

Branch 커버리지는 null-guard·에러 핸들링 분기 특성상 100% 달성이 어려우므로 75%를 기준으로 합니다.
