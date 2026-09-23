# 제한 사항과 호환 인증 경계

## 아직 완료되지 않은 출시 gate

- 실제 Cloudflare 계정의 outbound gRPC 변환과 배포된 Worker에서의 Google API 실행.
- 서비스 계정 실제 OAuth/JWT 갱신, IAM/quota 오류, WIF/impersonation/ADC, 실제 transaction conflict와 Commit 응답 유실.
- 원본 189개 계획 시나리오 전체, 전체 grpc-js 공개 API·예외 타이밍의 관찰 동등성, 운영 부하 성능 인증.
- catalog의 부분 검증·미구현 항목. `verification/evidence.json`에서 189개 ID별 실제 증거와 남은 범위를 구분합니다.

## 확인한 구현 경계

Client/factory/interceptor/Metadata/call surface는 grpc-js 1.14.0 소스를 이식했습니다. 빌드·root/deep identity·대표 native event differential을 검증하지만 전체 drop-in 인증을 의미하지 않습니다. 실제 Google SDK는 고정 버전과 통제 로컬 서비스로 검증합니다. 같은 shared CRUD/transaction/오류 모듈을 Node baseline과 workerd에서 실행하고 hash·RPC 순서를 비교했습니다. 공식 auth 10.9.1 override를 사용하는 고정 그래프의 실제 SDK Node16/NodeNext/Bundler 선언은 통과했습니다. 보고서에 적힌 `workerd`/`liveCloud` 값으로 실행 환경을 구분합니다.

Node 전용 `/build` 프리셋은 고정된 Google SDK·GAX·protobuf 설치본과 schema hash에만 적용합니다. 다른 버전/SDK를 자동 추측하여 변환하지 않습니다. Worker 도구 체인은 lockfile로 고정되어 있으며 Wrangler가 사용하는 Miniflare 5 alpha도 보고서에 명시합니다.

통제 서버의 Commit 응답 유실 시험은 mutation 적용 후 응답을 보류하고 1000ms deadline을 발생시킵니다. SDK의 Rollback 호출이 있어도 이미 반영된 쓰기가 취소되었다고 보장하지 않습니다. workerd shared 하네스의 테스트 bridge는 유한 응답을 버퍼링하며, incremental 취소는 별도 Workers SDK 시험으로 검증합니다.

공식 Firestore 1.22.0의 Native/Datastore 모드를 실제 Envoy와 연결한 에뮬레이터 시험도 통과했습니다. 이는 schema·SDK·전송 및 명시된 데이터 처리 사례의 로컬 증거입니다. IAM·복합 인덱스 필요성·quota·운영 transaction 동시성은 에뮬레이터에서 보장하지 않으며 Secret Manager 시험은 통제 서버에 남습니다. 가상 emulator owner 인증은 로컬 Envoy가 주입하며 실제 인증 흐름의 대체 증거가 아닙니다.

## 지원하지 않는 기능

client streaming, bidi, 서버 API, Firestore Listen/Watch, 압축, mTLS·사용자 CA, connection pool/keepalive/LB, 어댑터 자체 retry, remote health/channelz, 임의 resolver scheme는 지원하지 않습니다. `waitForReady()`는 연결 성공을 반환하지 않습니다. 실제 parent propagation과 WriteThrough flag도 비지원입니다.

## 의도적인 차이

- 전송 메시지 안전 상한은 기본 32 MiB입니다. 채널의 -1 옵션도 이 상한을 없애지 않습니다.
- Readable은 upstream의 object-mode 기본 highWaterMark를 사용합니다. SDK의 버퍼와 Fetch chunk 크기는 어댑터의 단일 메시지 lookahead 외에 추가됩니다.
- `getPeer()`는 논리 URL이며 실제 remote IP가 아닙니다. `getAuthContext()`는 null, channelz ref는 비등록 placeholder입니다.
- invocation transformer가 바꾼 argument 및 interceptor가 최종 변경한 method_definition을 실제 호출에 반영합니다. 원본과의 차이는 vendor patch에 명시합니다.
- 사용자 callback 예외를 transport 오류로 변환하지 않으며 microtask에서 다시 throw합니다. 원본과의 예외 재throw 타이밍 전체는 아직 인증하지 않았습니다.
- HTTPS credentials는 Workers Fetch의 TLS를 사용합니다. callback-only legacy Google credential shape는 지원하지 않습니다.

`private:true`를 유지합니다. 일반 gRPC endpoint가 gRPC-Web를 자동 지원한다고 가정하거나 로컬 시험을 실제 Google/배포 Cloudflare 인증으로 해석하지 마세요.
