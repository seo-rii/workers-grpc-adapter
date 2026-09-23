# Google Cloud API 테스트 확장 가이드

## 시작 위치

`fixtures/google/shared/`가 비즈니스 테스트 코드이고 `suites.mjs`가 작은 고정 등록표입니다. 범용 테스트 플러그인 시스템은 만들지 않았습니다. 기존 SDK import/생성자/메서드 호출을 유지한 함수를 작성하고, Node와 Worker가 동일한 파일을 import하게 합니다.

| ID | 작성된 함수 | 현재 실행 |
|---|---|---|
| datastore-crud | save/get/query/delete cleanup | native/adapter/workerd 로컬 통과 |
| datastore-transaction | 초기화/begin/get/save/commit/get/cleanup | native/adapter/workerd 로컬 통과 |
| firestore-crud | set/get/query/delete/terminate | native/adapter/workerd 로컬 통과 |
| firestore-transaction | set/runTransaction/get/delete/terminate | native/adapter/workerd 로컬 통과 |
| secret-manager-read | getSecret/close | native/adapter/workerd 로컬 통과 |

`npm run test:sdk:local`은 실제 설치된 SDK와 native grpc-js 서버를 사용합니다. native와 alias consumer에 같은 shared 파일을 복사하고 SHA-256을 비교합니다. Datastore stream·early destroy, Firestore getAll·누락 문서·onSnapshot 비지원, Secret Manager NOT_FOUND/PERMISSION_DENIED도 검사합니다. `npm run test:workers:shared`는 동일한 모듈의 실제 workerd 실행을 별도로 기록합니다. `shared/controlled-suites.mjs`에는 로컬 전용 오류·transaction fault 시험도 등록합니다. 이는 실제 Google 프로젝트에서 실행한 시험은 아닙니다.

## 설치와 버전

Datastore 10.1.0, Firestore 8.3.0, Secret Manager 7.1.0의 실제 npm 배포물을 설치했습니다. `fixtures/google/package-lock.json`과 `fixtures/native/package-lock.json`은 각각 replacement와 원본 grpc-js의 그래프를 고정합니다. `npm run fixtures:install`은 현재 소스를 pack한 뒤 local tarball integrity를 갱신하고 npm ci 결과를 검사합니다. 버전을 자동 latest로 바꾸지 않습니다.

root overrides는 SDK별 GAX가 요구하는 모든 grpc-js 경로를 교체해야 합니다. `npm run doctor`는 실제 SDK 의존성 closure, GAX 위치 및 grpc root/deep import 해석을 확인합니다. `compatibility/google-graph.json`에 전체 버전·integrity와 해석 결과를 기록합니다. `google-auth-library@10.5.0`만 공식 `10.9.1`로 override하여 Node16 선언 충돌을 해결했으며, 원본과 어댑터 모두 Node16/NodeNext/Bundler strict ESM/CJS 검사와 auth integrity 비교를 통과해야 합니다.

## 공식 에뮬레이터 실행

```sh
npm run emulators:install
npm run test:emulators
```

`fixtures/emulators`가 고정된 공식 Firestore Native/Datastore-mode 프로세스를 로컬에 시작하고 종료합니다. `shared/emulator-suites.mjs`는 기존 CRUD/transaction과 추가 데이터 모델·쿼리·집계·rollback 함수를 등록합니다. 이 등록표는 live Google용 `suites.mjs`와 별개입니다. shared 코드의 내용은 native/adapter/workerd에서 같고 host·credentials 설정만 하네스가 공급합니다.

모든 등록 suite를 네 실행 조합에서 검사합니다. 비즈니스 검사와 파일 hash 외에 Envoy upstream 도달·gRPC 상태를 대조하며 모의 RPC 응답은 사용하지 않습니다. 성공 응답과 ALREADY_EXISTS/NOT_FOUND/FAILED_PRECONDITION 오류, 실패한 쓰기 묶음의 원자성과 SDK 스트림 정리도 포함합니다. 기본 `verify`와 CI에도 포함합니다. 자세한 내용은 [에뮬레이터 README](../fixtures/emulators/README.md)와 [검증 보고서](../verification/google-emulators.json)를 참조합니다.

## 환경 설정

`fixtures/google/.env.example`은 문서이며 자동 로드되지 않습니다. 실행 셸 또는 Worker bindings로 공급합니다. 자격증명 JSON은 파일/로그/테스트 결과에 저장하지 않습니다.

| 변수 | 의미 |
|---|---|
| `WGA_RUN_GOOGLE_TESTS=1` | live 요청 명시적 opt-in |
| `WGA_ALLOW_TEST_WRITES=1` | CRUD/transaction의 데이터 쓰기와 삭제 opt-in |
| `WGA_GOOGLE_SUITES` | 쉼표로 나눈 등록된 테스트 ID |
| `WGA_DATASTORE_PROJECT` | 전용 Datastore 시험 프로젝트 |
| `WGA_FIRESTORE_PROJECT` | 전용 Firestore 시험 프로젝트 |
| `WGA_SECRET_MANAGER_PROJECT` | 읽기 시험용 Secret Manager 프로젝트 |
| `WGA_GOOGLE_CREDENTIALS_JSON` | `client_email`과 `private_key`를 가진 시험 서비스 계정 |
| `WGA_*_DATABASE` | 필요한 경우 지정하는 database ID |
| `WGA_SECRET_NAME` | `projects/프로젝트/secrets/이름` |
| `WGA_TRANSPORT_MODE` | Node는 grpc-web, Worker는 cloudflare 또는 grpc-web |
| `WGA_ENDPOINTS_JSON` | 논리 endpoint별 신뢰 gateway origin mapping |
| `WGA_TEST_KEY` | 테스트 Worker 호출을 보호하는 32자 이상 secret |

Datastore와 Firestore는 서로 별도 프로젝트/DB 설정을 받습니다. 하나의 기본 데이터베이스가 두 시험 대상에 모두 적합하다고 가정하지 않습니다. IAM 최소권한, API 활성화, 데이터베이스 준비, quota는 사용자가 관리해야 하며 이 패키지가 대신 생성하지 않습니다.

Node에서 `cloudflare` 모드를 쓰면 preflight가 거부합니다. Node의 fetch에는 Cloudflare 자동 변환이 없기 때문입니다. gateway는 credentials와 protobuf를 볼 수 있는 신뢰 경계입니다. 샘플 공개 endpoint는 제공하지 않습니다.

## 테스트 추가 방법

1. `shared/서비스.mjs`에 기존 SDK를 import한 `async function test(context)`를 작성합니다. 통과한 검사 이름 배열만 반환합니다. 사용자 데이터나 secret payload는 반환하지 않습니다.
2. 쓰기 테스트는 `requireWrites(context)`로 opt-in과 허용 프로젝트를 먼저 검사합니다.
3. 충돌 없는 `context.runId`와 전용 namespace/collection을 사용합니다. 운영 collection 전체를 지우는 cleanup은 금지합니다.
4. `withCleanup()` 또는 명시적 try/finally로 자신이 만든 리소스만 정리합니다. 원래 실패와 cleanup 실패를 둘 다 보존합니다.
5. `suites.mjs`에 SDK, 프로젝트 변수, 쓰기 여부, loader를 한 줄 등록합니다.
6. 해당 SDK dependency와 doctor 해석 검사를 추가합니다. 현재 preflight의 suite→SDK 분류도 함께 확장합니다.
7. native Node baseline과 adapter에서 **같은 shared 파일**을 사용하고 sha256을 보고서에 기록합니다. `scripts/google-local-test.cjs`에 로컬 서버 응답과 동등성 검사를 추가합니다.

## 우선 확장할 사례

Datastore의 found/missing, Key/namespace/ancestor/int64/bytes, cursor와 다중 페이지, aggregation, callback은 공식 에뮬레이터 시험을 추가했습니다. deferred, 더 많은 오류/limit 경계와 운영 데이터베이스 동작은 계속 확장합니다. 읽기 stream·조기 종료, ABORTED와 Commit 반영 후 응답 유실은 통제 서버에서 native/adapter/workerd 비교를 추가했습니다.

Firestore의 BatchGetDocuments/RunQuery/RunAggregationQuery, 누락 문서, field transforms/Timestamp/GeoPoint/bytes와 BatchWrite/BulkWriter는 공식 에뮬레이터에서 확인했습니다. 추가 transaction retry·운영 concurrency·limit 경계는 별도 확장 대상입니다. `onSnapshot`/Listen은 현재 비지원으로 별도 negative case에 둡니다.

Secret Manager는 getSecret 다음으로 pagination과 permission errors를 추가합니다. accessSecretVersion을 추가할 때 payload를 assertion 내부에서만 비교하고 HTTP 응답·snapshot·로그에 넣지 않습니다.

## Worker 실행

`fixtures/google/worker.mjs`는 POST와 secret header를 확인한 뒤 고정된 suite 이름만 허용합니다. request body로 target, credentials, project를 바꾸지 않습니다. `workers_dev:false`, live/write opt-in=0으로 기본 비활성화했습니다. 실제 노출 경로·Access 정책·bindings는 전용 시험 계정에서 설정합니다.

**예상 결과 / 미검증:** 실제 배포 후 `/datastore-crud` 또는 `/firestore-crud` 등의 경로에 올바른 인증으로 POST하면 검사 이름만 반환합니다. 현재 배포는 하지 않았습니다. Workers/GAX/protobuf 초기화와 같은 shared 비즈니스 코드는 통제 로컬 workerd 하네스에서 통과했으며, 배포 계정의 변환·IAM·실제 Google 데이터 처리는 별도 검증 대상입니다.

## 실패 판정

환경 미구성은 blocked이지 passed가 아닙니다. Google API로 성공했더라도 REST fallback 경로였다면 이 어댑터의 성공으로 세지 않습니다. Firestore는 `preferRest:false`, GAPIC는 `fallback:false`로 명시하며, 실제 request 경로의 증거를 추가해야 최종 인증합니다.

취소나 timeout은 서버에서 이미 실행된 쓰기를 되돌렸다는 뜻이 아닙니다. Commit이 시작된 후 응답이 유실되면 무조건 rollback 성공으로 해석하지 않습니다. 상위 SDK의 retry와 transport의 fetch 횟수를 따로 계측해야 합니다.
