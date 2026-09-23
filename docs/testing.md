# 테스트와 실행 증거

```sh
npm ci
npm run fixtures:install
node fixtures/envoy/download.cjs
npm run emulators:install
npm run verify
```

`fixtures:install`은 현재 tarball과 fixture lock integrity를 맞추고 Google/native/Worker를 npm ci로 설치합니다. `verify`는 live/write 플래그를 강제로 끄며 모든 로컬 검증 보고서를 생성합니다. 외부 Google 데이터는 만들지 않습니다.

전체 gate는 Linux x64용으로 고정된 Envoy binary를 먼저 준비해야 합니다. 다른 플랫폼에서는 core/type/SDK 검사를 개별 실행할 수 있지만 전체 증거 gate 통과로 표시하지 않습니다.

## 검사 계층

| 명령 | 내용 | 증거 |
|---|---|---|
| `npm test` | protocol/API/auth/lifecycle/interceptor, fuzz, doctor negative controls | verification/tests.tap |
| `npm run test:types` | 어댑터 strict Node16/NodeNext/Bundler 소비자 | verification/types.json |
| `npm run test:sdk:types` | 실제 SDK와 원본 baseline 선언 | compatibility/google-types.json |
| `npm run test:sdk:local` | 같은 shared 코드의 native/adapter CRUD/query/transaction/stream | compatibility/google-local.json |
| `npm run test:differential` | 실제 grpc-js 서버의 callback/status/stream 이벤트 비교 | verification/native-differential.json |
| `npm run test:envoy` | 실제 Envoy grpc_web → native grpc-js | verification/envoy.json |
| `npm run test:auth` | 실제 OAuth2Client 갱신·경합·격리·취소 및 서비스 계정 JWT 서명·교환·재사용 | verification/google-auth.json |
| `npm run test:contract` | root/deep CJS/ESM identity, native transport import 배제 | compatibility/exports-contract.json |
| `npm run test:pack` | 실제 tarball, alias-only negative, override, npm ci | verification/packaging.json |
| `npm run test:workers` | workerd 정적 alias import와 기본 RPC | verification/workers.json |
| `npm run test:workers:sdk` | 실제 SDK 정적 bootstrap·protobuf preset·workerd RPC | verification/workers-sdk.json |
| `npm run test:workers:shared` | 동일 shared 소스의 native/workerd CRUD·transaction·stream·오류 | verification/workers-shared.json |
| `npm run test:emulators` | 공식 Firestore/Datastore-mode + 실제 Envoy + native/adapter/workerd | verification/google-emulators.json |
| `npm run test:emulators:lifecycle` | 시작 중/실행 중 SIGINT·SIGTERM 및 반복 stop 정리 | verification/emulator-lifecycle.json |
| `npm run test:evidence` | 189개 ID별 named-test 증거 및 소스·lock·artifact drift | verification/evidence.json |
| `npm run test:benchmark` | 로컬 Node large/small/slow/concurrent 측정 | verification/benchmark.json |
| `npm run test:google` | 별도 opt-in된 live Google 함수 | verification/google-preflight.json |

`vendor/verify.cjs`는 npm 원본 hash, 수정본 hash 및 patch 재적용을 검사합니다. `test:contract`는 Node 전용 `/build`를 Worker runtime closure와 분리합니다.

## 실제 SDK와 native 비교

`fixtures/native`는 원본 grpc-js 1.14.0, `fixtures/google`는 replacement를 설치합니다. 전체 graph/integrity는 doctor 보고서에 남습니다. 두 소비자는 같은 `fixtures/google/shared/` 코드를 사용하고 파일 hash를 비교합니다. 통제 서버의 실제 메서드 도달 횟수·status와 gRPC-Web Content-Type을 기록합니다.

Datastore·Firestore CRUD/query/transaction, 읽기 stream, Firestore 여러/누락 문서, Secret Manager 정상·권한·없는 리소스 오류, Listen 비지원 범위를 검증합니다. 통제된 Datastore ABORTED, Commit 적용 후 응답 보류·deadline, Firestore 충돌 후 정확히 한 번의 SDK transaction 재시도도 비교합니다. 실패한 Commit 이후의 실제 저장 값을 읽어 결과 불확실성을 확인합니다. 실제 Google DB의 consistency/transaction retry/권한 정책은 별도 시험입니다.

Node16/NodeNext/Bundler의 실제 SDK ESM/CJS 선언을 strict·skipLibCheck=false로 검사하며 모든 진단을 실패 처리합니다. 양쪽 fixture는 `google-auth-library@10.5.0`을 공식 `10.9.1`로만 override하고 auth 11.1.0은 유지합니다. 원본과 어댑터의 auth 버전·integrity가 같은지도 검사합니다.

## 공식 데이터베이스 에뮬레이터

`scripts/google-emulator-test.cjs`는 `fixtures/emulators`의 고정 Firestore 1.22.0/Java21을 시작합니다. 두 모드를 독립 포트에서 실행하고 실제 Envoy 1.39.1의 grpc_web filter로 연결합니다. 모든 SDK RPC는 실제 에뮬레이터가 처리합니다. `fixtures/google/shared/emulator-suites.mjs`의 같은 파일을 세 런타임에서 실행하고 workerd에서는 각 suite를 두 번의 별도 요청으로 반복합니다.

등록된 모든 suite를 native·adapter·workerd 두 차례에서 실행합니다. 실제 business assertion 배열, shared SHA-256, 메서드·gRPC 상태별 호출 횟수를 비교하고 adapter fetch마다 upstream 도달을 확인합니다. 최신 실행 개수는 `verification/google-emulators.json`에 기록합니다. gRPC-Web 변환이 trailer를 소비하므로 상태는 downstream logger가 아닌 Envoy router의 **upstream access log**에서 관찰합니다. 로그에는 RPC 경로·상태만 포함하며 문서나 토큰 내용은 기록하지 않습니다.

Firestore BatchWrite는 에뮬레이터 관리 권한이 필요합니다. 로컬 Envoy의 Firestore 경로에만 가상 `Bearer owner`를 주입하며, 클라이언트가 실제 credentials/ADC를 사용하거나 평문으로 인증 정보를 전송하면 실패합니다. workerd의 host service는 HTTP framing header를 재계산하고 원래 protobuf body와 streaming response를 그대로 Envoy와 전달합니다.

Datastore 자료형·namespace·ancestor·batch/missing·callback·cursor·projection·집계·allocate/reserve IDs·rollback·SDK 읽기 스트림·조기 종료, Firestore 자료형·getAll·mask·cursor·집계·transform·rollback·BulkWriter를 실제로 검사합니다. 두 서비스 모두 실제 ALREADY_EXISTS/NOT_FOUND 및 실패한 쓰기 묶음의 원자성을 검사하고, Firestore는 오래된 precondition의 FAILED_PRECONDITION도 확인합니다. 기존 CRUD/transaction 함수도 변경 없이 재사용합니다. 공식 에뮬레이터의 인덱스·제한·동시성 차이는 [공식 문서](https://docs.cloud.google.com/firestore/native/docs/emulator)를 따르며 운영 인증으로 확대하지 않습니다.

에뮬레이터는 RAM과 임시 작업 폴더만 사용합니다. 프로세스 생성 시부터 0600 로그와 PID를 남기고 종료 코드·signal을 별도 기록합니다. 중단 회귀 시험은 Java PID 소멸과 임시 폴더 제거까지 확인합니다. 다운로드 캐시만 남깁니다.

## protocol과 자원

원래 framing/metadata/lifecycle 시험에 모든 frame flag, 고정 seed의 메시지·chunk 분할, 모든 truncation 위치, canonical/noncanonical base64 및 상한 검사를 추가했습니다. fuzz는 결정적으로 재현할 수 있습니다.

native differential은 콜백·초기/종료 metadata·status·data/error/end 순서와 Metadata 객체 동작을 비교합니다. Envoy 시험은 수제 bridge 시험과 별도로 실제 proxy를 실행하고 deadline/cancel도 확인합니다. 프록시 버전/hash와 실행 방법은 `fixtures/envoy/README.md`에 있습니다.

benchmark는 큰 메시지, 많은 작은 메시지, 느린 소비자, 동시 호출의 p50/p95, cold require, 번들 크기와 관찰한 버퍼/프로세스 메모리를 기록합니다. Fetch allocator까지 포함한 owned bytes 보장이나 배포 Worker 성능 수치로 해석하지 않습니다. 예산은 아직 정하지 않았습니다.

## Workers

실제 workerd에서 정적 SDK import와 생성자, protobuf encode/decode/reflection, 인증 header, 첫 RPC와 다음 요청을 검사합니다. `/build` preset 없이 실패하는 대조군과 profile/schema hash가 다른 경우 거부되는 negative control도 포함합니다. node_modules를 수동 수정하지 않으며 범용 require shim으로 SDK를 우회하지 않습니다.

`test:workers:shared`는 원본 비즈니스 모듈을 그대로 bundle하고 native baseline에 같은 바이트를 복사합니다. 각 파일 hash, SDK/GAX/auth/protobuf 버전, 메서드·상태·호출 횟수, 두 credentials의 분리를 기록합니다. 유한 응답을 버퍼링하는 통제 bridge를 사용하므로 incremental stream 취소 증거는 `test:workers:sdk`에서 구분합니다.

Worker lockfile에는 Wrangler가 사용하는 Miniflare alpha가 명시되어 있습니다. 실행 보고서의 실제 Wrangler/Miniflare/workerd 및 compatibility_date를 확인하세요. 이 실행은 Cloudflare 계정의 outbound gRPC 변환이나 배포 E2E가 아닙니다.

## 판정

`verification/report.json`은 subprocess 결과에서 생성합니다. required 시험의 blocked/미실행을 passed로 바꾸지 않으며 `releaseEligible:false`를 유지합니다. 원래 189개 계획 시나리오는 별도 catalog이고, 로컬 테스트 개수를 그 189개와 합산하지 않습니다. `compatibility/test-evidence.json`은 각 ID를 정확한 TAP 이름이나 실행 결과의 case/suite ID에 연결하고, `verification/evidence.json`은 covered/partial/unimplemented를 구분합니다.

`verify`는 실행 전에 입력 hash를 저장하고 마지막에 artifact integrity, 고정 설치 그래프·profile·후보 버전, 보고서와 소스의 일치를 검사합니다. 이후 `test:evidence`만 실행하면 낡은 증거나 변경된 source/lock/artifact를 거부합니다. 입력을 바꾼 경우 fixture 재설치와 전체 `verify`를 다시 실행해야 합니다.
