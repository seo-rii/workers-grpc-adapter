# workers-grpc-adapter

`@grpc/grpc-js`의 클라이언트 코어를 Cloudflare Workers에서 binary gRPC-Web + `fetch()`로 사용하는 실험용 어댑터입니다. Unary와 server streaming을 구현합니다.

**버전: `0.0.0-prototype.1`. npm 미배포, 실제 Google/Cloudflare 운영 호환 인증 전입니다.**

Client·factory·Metadata·interceptor·stream surface는 실제 npm `@grpc/grpc-js@1.14.0` 소스를 사용합니다. native HTTP/2 channel 대신 어댑터의 요청별 전송 계층을 연결했습니다. 원본 LICENSE, commit, integrity, 파일 hash와 재적용 가능한 patch는 [`vendor/`](vendor/)에 있습니다.

## 설치와 로컬 검증

전체 로컬 검증은 Linux x64와 Node.js 22 이상에서 다음 명령을 실행합니다. root와 Google/native/Worker fixture의 의존성은 lockfile로 고정합니다.

```sh
npm ci
npm run fixtures:install
node fixtures/envoy/download.cjs
npm run emulators:install
npm run verify
```

`fixtures:install`은 현재 소스를 tarball로 만들고 fixture가 그 산출물을 설치하도록 integrity를 갱신한 뒤 `npm ci`를 실행합니다. `verify`는 Google live/write opt-in을 강제로 끄며 외부 클라우드 데이터를 변경하지 않습니다.

| 명령 | 검증 범위 |
|---|---|
| `npm test` | framing·API·interceptor·인증·deadline·cancel·stream·fuzz |
| `npm run test:types` | 어댑터 선언의 Node16/NodeNext/Bundler 소비자 |
| `npm run test:sdk:types` | 실제 Google SDK 선언 + 원본 grpc-js baseline |
| `npm run test:sdk:local` | 동일 비즈니스 코드의 native/adapter SDK 왕복 |
| `npm run test:differential` | 실제 grpc-js 서버와 callback/metadata/status/stream 이벤트 비교 |
| `npm run test:envoy` | 실제 Envoy를 통한 native gRPC 상호운용 |
| `npm run test:auth` | 실제 Google auth의 OAuth 갱신·경합·취소 및 JWT 서명·교환 |
| `npm run test:contract` | CJS/ESM/deep Client identity와 Worker import closure |
| `npm run test:workers` | workerd 정적 import 및 기본 RPC |
| `npm run test:workers:sdk` | SDK 정적 bundle·protobuf build preset·workerd RPC |
| `npm run test:workers:shared` | 같은 shared 코드의 native/workerd CRUD·transaction·오류 비교 |
| `npm run test:emulators` | 공식 Firestore/Datastore-mode 에뮬레이터 × native/adapter/workerd |
| `npm run test:emulators:lifecycle` | 에뮬레이터 정상 종료·SIGINT·SIGTERM 자식 정리 |
| `npm run test:evidence` | 189개 catalog 증거·소스·lock·artifact·보고서 drift 검사 |
| `npm run test:pack` | 실제 tarball의 alias/override/npm ci 시험 |
| `npm run test:benchmark` | 로컬 Node 자원·지연시간 측정 |

정확한 실행 상태와 개수는 [`verification/report.json`](verification/report.json)을 기준으로 합니다. 실제 SDK와 원본 baseline 모두 Node16/NodeNext/Bundler의 ESM/CJS 소비자가 strict·`skipLibCheck:false`로 통과합니다. `google-auth-library@10.5.0`만 공식 `10.9.1`로 고정하여 gtoken 선언 충돌을 해결했고, Secret Manager의 별도 `11.1.0`은 유지했습니다. [`타입 보고서`](compatibility/google-types.json)

## 실제 SDK 검증

Datastore **10.1.0**, Firestore **8.3.0**, Secret Manager **7.1.0**을 실제 npm에서 설치했습니다. SDK별 GAX/auth/protobuf/grpc 전체 그래프, integrity와 replacement 해석은 [`compatibility/google-graph.json`](compatibility/google-graph.json)에 있습니다.

`fixtures/google/shared/`의 같은 파일을 원본 grpc-js와 어댑터에서 실행하고 SHA-256 및 서버 메서드·상태를 비교합니다. 로컬 native gRPC 서버를 대상으로 다음을 검증합니다.

- Datastore CRUD/query/transaction, 읽기 스트림과 조기 종료, ABORTED와 Commit 응답 유실.
- Firestore CRUD/query/transaction, 응답 순서가 뒤바뀐 여러 문서와 누락 문서, transaction 충돌 후 SDK 재시도, Listen의 명시적 비지원.
- Secret Manager 읽기, NOT_FOUND, PERMISSION_DENIED.

Node native/adapter 25개 시나리오는 [`compatibility/google-local.json`](compatibility/google-local.json), 같은 shared 파일을 실제 workerd에서 두 요청으로 실행한 26개 시나리오·104 RPC는 [`verification/workers-shared.json`](verification/workers-shared.json)에 있습니다. Commit을 반영한 뒤 응답을 보내지 않아 deadline이 발생하는 시험에서는 SDK의 Rollback 후에도 쓰기가 남는지 확인합니다. 이 통제 서버 시험은 실제 Google IAM·데이터베이스 동작·토큰 갱신·Cloudflare 변환 기능을 인증하지 않습니다.

## 공식 GCP 에뮬레이터 검증

Firestore **1.22.0** 공식 에뮬레이터를 Native 모드와 Datastore 모드로 각각 실행합니다. 고정된 Java 21 JRE와 에뮬레이터는 프로젝트 캐시에만 설치하며 전역 gcloud·Java·인증 설정을 변경하지 않습니다. 다운로드 URL·SHA-256은 [`toolchain.json`](fixtures/emulators/toolchain.json)에 있습니다.

원본 grpc-js와 Node 어댑터, 실제 workerd가 **같은 비즈니스 파일**로 실제 Envoy를 거쳐 데이터베이스에 요청합니다. RPC 응답을 모의 생성하지 않습니다. 등록된 suite를 네 실행 조합(native, adapter, workerd 두 차례)에서 검사한 결과는 [`google-emulators.json`](verification/google-emulators.json)에 있습니다.

- Datastore: CRUD·transaction, namespace·ancestor·int64·bytes·Date·GeoPoint, callback/Promise·없는 entity, cursor·projection, count/sum/average, ID 할당·예약, rollback, SDK 읽기 스트림·조기 종료, 중복 insert·없는 entity update와 실패한 transaction의 원자성.
- Firestore: CRUD·transaction, Timestamp·GeoPoint·bytes·document reference, getAll·없는 문서·field mask, cursor·집계, 필드 변환, rollback, BulkWriter의 BatchWrite와 문서별 오류, 중복 create·없는 문서 update·오래된 precondition과 실패한 batch의 원자성.

프로세스와 모든 포트는 loopback에 한정하며 가상 `demo-` 프로젝트를 사용합니다. Firestore BatchWrite에 필요한 에뮬레이터 전용 `Bearer owner`는 Envoy가 로컬 서버 방향에만 추가합니다. 클라이언트는 인증 정보를 보내지 않으며 어댑터의 평문 인증 차단은 유지합니다. 실행 후 작성 데이터와 자식 프로세스를 정리합니다.

에뮬레이터는 운영 IAM·인덱스 요구사항·quota·전체 transaction 동시성이나 Cloudflare 배포를 인증하지 않습니다. [공식 Firestore 문서](https://docs.cloud.google.com/firestore/native/docs/emulator) · [공식 Datastore-mode 문서](https://docs.cloud.google.com/datastore/docs/emulator). Secret Manager는 기존 통제 서버 시험과 구분합니다.

## SDK 코드를 바꾸지 않는 설치

아래는 `fixtures/google/package.json` 기준의 로컬 tarball 설정입니다. 공개 npm에 아직 이 이름/버전을 배포하지 않았습니다.

```json
{
  "dependencies": {
    "@grpc/grpc-js": "file:../../artifacts/workers-grpc-adapter-0.0.0-prototype.1.tgz"
  },
  "overrides": {
    "@grpc/grpc-js": "$@grpc/grpc-js",
    "google-auth-library@10.5.0": "10.9.1"
  }
}
```

alias만 지정하면 하위 SDK에 원본 grpc-js가 남을 수 있으므로 root overrides와 `npm run doctor` 검사를 함께 사용합니다.

Workers SDK bundle에는 Node 전용 `@grpc/grpc-js/build` 프리셋을 적용합니다. 정확한 설치본과 schema hash를 확인한 뒤 protobuf constructor/encoder/decoder를 빌드 시점에 생성합니다. node_modules를 직접 수정하지 않습니다. 이 빌드 도구는 TypeScript와 esbuild를 개발 의존성으로 요구하며 런타임 어댑터는 외부 패키지 의존성이 없습니다. 예시는 `scripts/workers-sdk-test.cjs`와 [API 문서](docs/api.md)를 참조합니다.

## 전송 경계와 미지원 기능

일반 Node의 native gRPC endpoint는 binary gRPC-Web를 자동 지원하지 않습니다. Node 시험은 신뢰하는 gRPC-Web gateway를 사용하며, Workers 직접 경로는 해당 계정의 Cloudflare 변환 기능을 실제로 검증해야 합니다. REST로 전환하지 않습니다.

Client streaming/bidi, Firestore 지속 Listen/Watch, 서버 API, mTLS/사용자 CA, 압축, native connection pool/retry/health는 비지원입니다. 상위 SDK 재시도는 별개의 호출이며 어댑터는 한 Call에서 fetch를 최대 한 번만 실행합니다.

실제 Cloudflare 배포·Google API 시험은 전용 계정, 프로젝트, credentials와 명시적 opt-in이 필요합니다. 아직 배포·출시는 수행하지 않았으며 `releaseEligible:false`를 유지합니다.

[계획 및 상태](PLAN.md) · [구현 구조](docs/architecture.md) · [테스트](docs/testing.md) · [Google 시험](docs/google-tests.md) · [제한 사항](docs/limitations.md)
