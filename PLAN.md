# 구현 계획 및 현재 상태

기준: 2026-09-23 / `0.0.0-prototype.1`. 체크는 **해당 범위의 완료**만 의미합니다. 코드 작성, 로컬 실행, 실제 SDK 실행, 배포 E2E를 구분합니다. 최신 실제 실행 증거는 [`verification/report.json`](verification/report.json)에 있습니다.


## 2026-09-23 실행 결과

- root 및 Google/native/Worker lockfile, 실제 npm SDK 설치, 전체 grpc import doctor, npm ci 재현을 구현했다.
- grpc-js 1.14.0 Client/interceptor/Metadata/factory를 이식하고 원본·patch·license·hash 검증을 추가했다.
- 실제 SDK의 통제 서버 시험 25개와 native event differential 6개가 통과했다. native와 adapter는 동일 shared 소스 hash를 사용한다. 이는 live Google 시험이 아니다.
- 실제 Envoy grpc_web → native grpc-js 시험 6개(unary/stream, non-OK, deadline/cancel)가 통과했다.
- deterministic fuzz와 large/many-small/slow/concurrent benchmark를 실행했다. 수치 예산과 배포 성능 인증은 아직 정하지 않았다.
- 공식 auth 10.9.1을 양쪽 fixture의 10.5.0 경로에만 override하여 TYPE-001을 해결했다. 실제 SDK Node16/NodeNext/Bundler strict ESM/CJS 소비자 12개가 통과했다. auth 11.1.0 경로는 유지한다.
- 실제 OAuth2Client/Gaxios의 갱신·실패·12개 동시 호출·두 credentials 격리·갱신 중 취소 및 임시 RSA 서비스 계정 JWT 서명·교환·재사용 시험 7개가 통과했다. 실제 OAuth 서버 통신은 아니다.
- workerd에서 실제 SDK 정적 import/constructor/proto/auth와 Lookup·BatchGetDocuments·GetSecret, 중도 stream 취소 및 두 번째 credentials 요청까지 7개 RPC가 통과했다. `verification/workers-sdk.json`에 기록한다.
- 동일 shared 비즈니스 모듈 8개의 SHA-256을 비교하고, workerd 13개 suite × 두 요청(104 RPC)을 native 12개 suite와 비교했다. Datastore ABORTED·Commit 응답 유실, Firestore conflict/retry와 역순 BatchGet도 통과했다.
- 189개 catalog ID를 개별 실행 증거에 연결하고 covered/partial/unimplemented로 구분했다. 소스·lock·artifact·profile·보고서 drift와 증거 과대주장 negative test를 추가했다.
- 공식 Firestore 1.22.0 Native/Datastore-mode 에뮬레이터와 실제 Envoy로 20개 suite × 네 실행 조합(native/adapter/workerd 두 차례)을 실행했다. 80개 결과, gRPC-Web 393요청과 upstream 524도달의 메서드·상태·공유 소스 hash가 일치했다. 실제 ALREADY_EXISTS/NOT_FOUND/FAILED_PRECONDITION, 실패한 transaction/batch의 원자성, Datastore SDK 스트림·조기 종료를 포함한다.
- 독립 Java21 캐시 설치, 가상 demo 프로젝트, loopback·임시 데이터, 정상 및 signal 종료 프로세스 정리를 구현했다. 에뮬레이터의 운영 IAM·인덱스·quota·동시성 한계는 별도로 유지한다.
- 배포/실제 Google API/IAM/토큰 갱신·전체 189개 catalog 인증은 별도 gate이며 `releaseEligible:false`를 유지한다.

## 완료된 기반

- [x] 외부 runtime dependency 없이 TypeScript 소스, CJS/ESM 진입점, 선언 파일을 빌드했다.
- [x] Metadata·HTTPS credentials·설정 검증·endpoint mapping·unary·server streaming을 구현했다.
- [x] frame/trailer parser, 메시지·헤더 상한, deadline·취소·단일 종료·단일 fetch를 로컬에서 시험했다.
- [x] 생성 client/직접 Client/extends 경로, overload, callback·status 표면의 부분 구현을 시험했다.
- [x] 실제 localhost HTTP/1 gRPC-Web → HTTP/2 테스트 서버 왕복을 실행했다. **이 초기 시험 외에 실제 Envoy 및 upstream grpc-js differential을 별도로 추가했다.**
- [x] 실제 replacement tarball과 모의 SDK/GAX를 임시 npm registry에 설치하여 alias-only negative, alias+override, npm ci를 실행했다.
- [x] Node16/NodeNext/Bundler 타입 소비자 검사를 strict·skipLibCheck=false로 실행했다. **실제 SDK 선언까지 세 모드 모두 통과했다.**
- [x] Datastore CRUD·transaction, Firestore CRUD·transaction, Secret Manager metadata 읽기 함수와 공통 runner를 **작성**했다. 통제 로컬 서버에서 실제 SDK 실행을 완료했다. 실제 Google API 실행은 아래 미완료다.
- [x] Miniflare용 static-import smoke fixture와 Google 테스트 전용 Worker entrypoint를 **작성**했다. core smoke의 workerd 실행을 완료했으며 SDK 결과는 아래 실행 보고서와 구분한다.
- [x] README, API, 구조, 제한, 테스트, Google 테스트 추가 가이드와 기존 v0.3 명세를 프로젝트에 포함했다.

## P0 — 실제 SDK 연결 전 가장 먼저 할 일

### P0-1. 설치 가능한 의존성 그래프 고정

- [x] root에서 개발 의존성을 설치하고 실제 `package-lock.json`을 생성한다. `npm ci`와 TypeScript 5.8.3 / @types/node 22.15.30 조합으로 빌드·타입 검사를 재실행했다.
- [x] `fixtures/google/package.json`의 후보 SDK 버전이 npm에 실제 존재하는지 확인한다. 세 후보 버전의 실제 npm artifact와 integrity를 확보했다.
- [x] Datastore, Firestore, Secret Manager의 GAX·auth·protobuf·grpc 관련 전체 그래프를 고정한다. 의도하지 않은 beta/RC 의존성도 검토한다.
- [x] SDK 위치에서 GAX를, 각 GAX 위치에서 replacement를 resolve하는 doctor를 실제 설치 그래프에서 통과시킨다.
- [x] SDK별 graph·integrity·lockfile·실행환경을 `compatibility/` 보고서에 저장한다.

**위치:** `fixtures/google/package.json`, `scripts/doctor.cjs`, `compatibility/candidates.json`  
**완료 기준:** 깨끗한 설치와 npm ci가 같은 graph를 만들고, 관련 모든 grpc-js import가 replacement를 가리킨다. 알 수 없는 설치/타입 오류를 `skipLibCheck`·`as any`로 감추지 않는다.

### P0-2. 부분 Client를 최종 drop-in Client 계약으로 교체

- [x] upstream grpc-js 클라이언트 소스를 실제 npm 배포본/commit/integrity로 고정한다. 1.14.0 원본, gitHead, npm integrity와 파일별 hash를 vendor/UPSTREAM.json에 고정했다.
- [x] v0.3의 P-01~P-06 패치를 적용하는 작은 vendor 경계를 만든다. 원본 LICENSE/NOTICE, 파일 hash, patch를 보존한다.
- [x] 원본 Client·factory·client interceptor·metadata·call surface를 재사용하되 native HTTP/2·resolver·server의 runtime import closure를 제거한다.
- [x] 최종 메서드 정의·deadline provenance·CallOptions를 하단 bridge에서 현재 `WorkersCall`로 전달한다.
- [x] client/call interceptors, builder, transform 계약, getAuthContext, flags와 deep exports를 실제 SDK 소비자 선언으로 검증한다. runtime 순서/지원 범위는 별도의 interceptor 시험과 제한 문서를 따른다.
- [x] 현재 자체 구현의 의도적 차이(highWaterMark, observer 예외 타이밍, getMap 객체 형태 등)를 native event trace와 비교하여 제거하거나 명시한다.
- [x] `exports-contract.json`을 실제 설치본에서 만들고 CJS/ESM 동일 identity를 다시 검사한다.

**위치:** `src/client.ts`, `src/factory.ts`, `src/metadata.ts`, `src/credentials.ts`, `src/index.ts`, 향후 `vendor/`  
**완료 기준:** 동일한 실제 Google SDK TypeScript 소비자가 root/deep import를 포함하여 통과한다. 인터셉터와 대표 소비자 검사는 통과했다. 공식 auth 의존성 pin 조합에서 Node16/NodeNext/Bundler 모두 통과한다.

### P0-3. Workers 실제 초기화

- [x] `fixtures/worker`의 Miniflare/esbuild를 설치·고정하고 `npm run test:workers`를 실행한다.
- [x] prototype smoke 다음에는 **실제 SDK의 정적 import** fixture를 추가한다. 현재 Google runner의 dynamic loader 성공만으로 static bootstrap 완료로 판단하지 않는다.
- [x] Datastore/Firestore/GAX cold import → constructor → proto loader → auth → 첫 RPC → 다음 요청의 전 경로를 workerd에서 실행한다.
- [x] lazy protobuf constructor/encode/decode/reflection의 runtime code generation·파일/asset 접근을 관찰한다.
- [x] 필요한 경우에만 v0.3의 SDK별 version/hash 검증 build preset을 구현한다. `/build`의 `google-static-v1` profile이 실제 workerd bootstrap을 통과했다.
- [x] Worker의 서로 다른 두 요청·두 credentials·중도 취소 시 I/O와 인증 state 분리를 검사한다.

**위치:** `scripts/workers-test.cjs`, `fixtures/worker/`, `fixtures/google/worker.mjs`, 향후 `src/build/`  
**완료 기준:** Node에서 실행한 결과가 아닌 workerd 결과가 남고, fixture를 수동 node_modules patch 없이 빌드한다. prototype용 유한 builtin bridge를 SDK 전체용 범용 require shim으로 확대하지 않는다.

## P1 — 사용자 중심 Google API 호환성 시험

### 공통 하네스

- [x] 원본 grpc-js를 쓰는 별도 native Node baseline consumer와 runner를 만든다. `fixtures/native`와 `scripts/google-local-test.cjs`에서 같은 shared 파일을 실행한다.
- [x] baseline과 alias Worker가 같은 shared 파일을 사용하는지 SHA-256으로 검사한다. `verification/workers-shared.json`에 실제 bundle 입력 8개의 hash를 기록한다.
- [x] 테스트 기록에 SDK/GAX/auth/protobuf/런타임 버전, gRPC-Web Content-Type, 서버 도달 횟수와 상태·auth 분리, SDK code/details, stream events를 추가했다. metadata callback/status 상세 비교는 native differential에 별도 기록한다. 토큰·엔터티·secret payload는 기록하지 않는다.
- [x] 성공/실패/blocked/미실행을 SDK·메서드·runtime별로 구분한다.
- [ ] 테스트 전용 프로젝트·최소권한 credentials·API 활성화·데이터베이스·quota를 준비한다. 일반 CI PR에서 실제 cloud 요청을 하지 않는다.

### Datastore

- [ ] 작성된 `datastore-crud`, `datastore-transaction`을 실제 SDK·테스트 GCP에서 실행한다.
- [ ] 없는 entity, 배치 found/missing/deferred, Key/namespace/ancestor/int64/bytes/Date의 native 결과를 비교한다. **deferred를 제외한 열거 항목은 공식 에뮬레이터에서 native/adapter/workerd 비교를 완료했다.**
- [x] Query 필터·정렬·ancestor·cursor 페이지네이션·projection·count/sum/average와 빈 집계 사례를 공식 에뮬레이터에서 추가·비교했다.
- [ ] `runQueryStream`, `createReadStream`의 data/info/error/end와 early destroy를 검사한다. **공식 에뮬레이터의 정상 data/info/end, found/missing, 조기 destroy 이후 data/end 부재와 후속 RPC·정리는 네 실행 조합에서 일치했다. stream 자체의 원격 오류 변형은 남아 있다. Datastore SDK의 unary query 페이지를 감싼 readable 시험이며 HTTP/2 streaming 취소 증거는 아니다.**
- [ ] callback/Promise tuple, allocate/reserve IDs, 여러 GAX 버전의 기본 options를 검사한다. **callback/Promise·allocateIds·공개 v1.reserveIds는 고정 SDK/GAX 조합에서 통과했다. 다른 GAX 조합은 남아 있다.**
- [x] ABORTED와 Commit 반영 후 응답 유실을 통제 서버에서 재현했다. 응답을 보류하여 deadline을 발생시키고 SDK Rollback 이후에도 반영된 값을 확인했다. native/workerd의 Commit 횟수·전체 RPC 수가 일치하며, 단일 Call의 fetch 상한은 core 시험으로 별도 검사한다.
- [x] 공식 에뮬레이터에서 중복 insert의 ALREADY_EXISTS(6), 없는 entity update의 NOT_FOUND(5), 원격 details와 실패한 transaction의 원자성을 native/adapter/workerd에서 비교했다.

**시작 파일:** `fixtures/google/shared/datastore.mjs`  
**완료 기준:** 최소 CRUD/query/transaction/SDK stream과 오류 의미가 native와 일치한다. unary wire 성공만으로 SDK 전체를 인증하지 않는다.

### Firestore

- [ ] 작성된 `firestore-crud`, `firestore-transaction`을 실제 SDK·테스트 GCP에서 실행한다.
- [ ] BatchGetDocuments·RunQuery의 server streaming과 여러 문서/누락 문서/순서/오류를 검사한다. **정상 여러 문서/누락/순서/mask/cursor는 공식 에뮬레이터에서 완료했고 중도 오류의 모든 변형은 남아 있다.**
- [x] getAll·paging·aggregation·writes/transforms/Timestamp/GeoPoint/bytes·rollback·BulkWriter를 공식 에뮬레이터에서 확장했다. BulkWriter는 unary BatchWrite와 문서별 ALREADY_EXISTS를 검사한다. conflict/retry는 기존 통제 서버 시험을 유지하며 운영 동시성 인증과 구분한다.
- [x] 공식 에뮬레이터에서 중복 create(6), 없는 문서 update(5), 오래된 lastUpdateTime(9), 원격 details와 실패한 batch의 원자성을 native/adapter/workerd에서 비교했다.
- [x] Firestore가 전달하는 실제 Channel/Call options와 auth·GAX 초기화 경로를 확인한다.
- [x] `onSnapshot`/Listen 등 bidi 경로는 명확한 negative test로 유지한다. 이를 polling이나 REST로 몰래 대체하지 않는다.
- [x] `preferRest:false`와 실제 wire 증거를 모두 확인한다. 옵션만으로 gRPC 경로를 입증하지 않는다.

**시작 파일:** `fixtures/google/shared/firestore.mjs`  
**완료 기준:** 읽기·쓰기·query·transaction 각각의 실제 메서드/버전 인증. listen 미지원은 계속 공개한다.

### Secret Manager 및 다음 SDK

- [ ] 작성된 `secret-manager-read`를 실행하고 NOT_FOUND/PERMISSION_DENIED·pagination을 추가한다.
- [ ] accessSecretVersion은 payload를 내부 assertion에서만 비교한다.
- [ ] 다른 Google SDK는 `suites.mjs`에 등록하고 실제 필요한 exports/options를 확인한 뒤 인증한다. “모든 Google Cloud API 지원” 표기는 하지 않는다.

## P2 — 상호운용·자원·보안 강화

- [x] 실제 Envoy grpc_web → native grpc-js 서버 interop fixture를 추가한다. 수제 테스트 bridge 결과와 별도로 `verification/envoy.json`에 기록한다.
- [x] 원본 grpc-js callback/status/stream event differential suite, upstream-derived independent golden vectors를 추가한다.
- [x] 189개 원본 카탈로그를 실제 named test와 report case ID에 연결했다. `compatibility/test-evidence.json`과 `verification/evidence.json`이 covered/partial/unimplemented 및 구체적인 gap을 구분한다. catalog 전체 통과를 의미하지 않는다.
- [ ] 큰 메시지·많은 작은 메시지·느린 소비자·동시 RPC에서 owned bytes, parser CPU, 번들, cold initialize, p50/p95를 측정한다. 숫자 예산은 측정 뒤 결정한다.
- [x] frame fuzz, metadata 중복·malformed base64·URL/authority·redirect·인증 audience 검사를 강화한다.
- [x] 만료 토큰/갱신/권한 실패/인증 경합을 실제 auth 라이브러리로 검사한다. legacy callback auth, WIF·impersonation·ADC 등은 별도 인증이다.
- [x] server streaming 마지막 메시지 보존 및 abort 후 자원 해제의 스트레스/누수 시험을 반복한다.

## P3 — 배포 및 출시 gate

- [ ] 실제 Cloudflare 계정의 outbound translation 사용 가능 여부를 확인한다. 발표 문서의 private beta 표기와 실제 계정 상태를 구분한다.
- [ ] 통제 native 서버로 unary/server stream/non-OK trailer/deadline/cancel을 배포 Worker에서 검증한다.
- [ ] 보호된 테스트 배포에서 Datastore·Firestore·Secret Manager suite를 실행한다. 테스트 함수 접근은 secret/Access, 고정 suite, 쓰기 opt-in으로 제한한다.
- [ ] 실패한 리소스 cleanup 목록을 안전하게 기록하고 전용 계정에서 정리한다. 클라이언트 취소는 서버 작업 취소를 보장하지 않는다.
- [ ] 문서 예제·후보 버전·실행 보고서·artifact hash·출시 allowlist의 drift를 CI에서 검사한다. `verify`/`test:evidence`의 source·lock·artifact·profile·보고서 drift gate와 CI 실행 단계를 연결했다. CI에는 Envoy·에뮬레이터 설치 단계도 포함한다. 원격 CI 실행 결과와 실제 출시 allowlist는 아직 인증하지 않았다.
- [ ] root와 fixture lockfile, provenance, 보안 및 license 검토가 끝난 후에만 `private:true` 해제와 실제 배포 버전을 결정한다.

**출시 불가 조건:** required 테스트가 skipped/blocked, 실제 SDK import/type 실패, Workers bootstrap 미검증, native differential 미실행, live E2E 미실행. 현재 `releaseEligible:false`가 정상 상태다.

## 다음 실행 순서

1. catalog의 남은 deferred·오류/경계·retry 변형과 grpc-js 세부 계약을 추가한다. 현재 공식 에뮬레이터에서 확인한 data model/query/pagination/aggregation 범위를 전체 기능 인증으로 확대하지 않는다.
2. 정확한 owned bytes/parser CPU, 배포 성능과 수치 예산을 확정한다.
3. 승인된 전용 Cloudflare/GCP 환경에서 outbound 변환 및 live CRUD/transaction을 검증한다. 로컬 Envoy/workerd 결과를 live 인증으로 바꾸지 않는다.
4. 연결된 CI의 원격 실행을 확인하고 실제 cloud gate, 보안·license·출시 allowlist 검토 후 배포 버전과 공개 여부를 결정한다.

이 계획은 후속 작업 목록이며 자동/백그라운드로 실행되는 작업이 아니다.
