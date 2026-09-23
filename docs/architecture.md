# 구현 구조

## 현재 실행 경로

```text
SDK 또는 생성 클라이언트
 → @grpc/grpc-js (설치 alias/override)
 → src/index.ts
 → upstream에서 이식한 Client / factory / interceptors / Metadata
 → src/channel.ts
 → src/call.ts
 → src/wire.ts
 → fetch(application/grpc-web+proto)
 → Cloudflare 변환 또는 명시한 gateway
 → native gRPC 서버
```

클라이언트 코어는 실제 npm `@grpc/grpc-js@1.14.0`에서 가져왔습니다. `vendor/UPSTREAM.json`이 npm integrity, git commit, 원본·수정본 hash와 patch를 고정합니다. `vendor/verify.cjs`는 patch 재적용 결과까지 검증합니다. native Channel/resolver/server는 런타임 그래프에 포함하지 않습니다.

## 모듈 책임

| 모듈 | 현재 구현 |
|---|---|
| `index.ts` | client-only root facade, 인터셉터·builder, 명시적 Server 실패 |
| `factory.ts` | generated constructor, `loadPackageDefinition`, originalName 별칭 |
| `client.ts`, `call-surface.ts` | upstream overload, callback, stream, transform와 호출 표면 |
| `client-interceptors.ts` | upstream interceptor 순서·비동기 listener·직렬화, 최종 method/options bridge |
| `channel.ts` | target/config/credentials, 활성 Call 추적, close |
| `call.ts` | 인증 준비, 1회 fetch, deadline, 취소, 종료·reader 정리 |
| `wire.ts` | 길이 제한을 먼저 검사하는 incremental framing, trailers, metadata |
| `credentials.ts` | CallCredentials 결합, getRequestHeaders 기반 Google 인증 연결 |
| `config-internal.ts` | 순수 validation, 설정 snapshot, canonical routing |
| `config.ts` | 공개 configure/get API만 재노출 |
| `options.ts` | 허용/거부 및 문서화된 무시 옵션 |
| `adapter.ts` | 인스턴스별 고급 설정. 기본 alias 모드의 필수 조건은 아님 |
| `build/` | Node 전용, SDK/schema hash를 확인하고 protobuf codec을 빌드 시점에 생성 |

## Call 수명주기

`start → auth/request 준비 → halfClose → fetch → frame 소비 → terminal`입니다. auth와 request는 독립적으로 준비됩니다. 종료 사유가 먼저 확정되면 늦은 auth 또는 fetch 응답으로 새 요청을 시작하지 않습니다.

`finishObject()`가 먼저 terminal 상태를 기록하고 타이머·요청 버퍼·대기 중 reader 수요를 정리합니다. callback/listener는 그 뒤 통지합니다. 한 Call의 fetch는 최대 1회입니다. parent SDK의 재호출은 별개의 Call입니다.

Decoder는 전체 response를 합치지 않습니다. 현재 Fetch chunk와 현재 frame을 읽고, transport가 최대 한 메시지를 앞서 읽을 수 있습니다. Readable은 upstream의 object-mode 기본 highWaterMark를 사용하므로 SDK stream 버퍼는 transport의 한 메시지 lookahead와 별개입니다. 스트림 종료는 원본 Client의 data/error/status/end 순서를 따릅니다.

타이머는 긴 deadline을 2^31−1ms 이하 구간으로 나누어 재설정합니다. 명시한 Infinity는 패키지 기본 timeout으로 덮어쓰지 않습니다. SDK 초기화 전 시간을 전체적으로 제한하는 타이머는 아닙니다.

## ESM / CJS

`dist/*.js`가 canonical CommonJS 구현이고 `.mjs`는 그 객체의 symbol을 재노출합니다. `Metadata`, credentials, Client, 설정 singleton을 두 번 만들지 않습니다. Node의 혼합 import/require와 실제 tarball 경로에서 identity를 검사했습니다. Workers bundler가 만든 산출물의 identity는 아직 검증하지 않았습니다.

## 프로토콜 오류와 사용자 예외

네트워크 오류의 원문과 인증 오류의 원문은 외부 details에 복사하지 않습니다. 원격 gRPC status/details는 정상 프로토콜 값으로 전달합니다. 호출자 callback이 throw하면 transport 오류로 변환하지 않고 microtask에서 다시 throw합니다. 이 예외 타이밍의 upstream 동등성은 아직 인증되지 않았습니다.

## 이식 경계

`channel.createCallForMethod()`는 최종 method 종류와 CallOptions를 받습니다. 인터셉터가 소비한 옵션은 제거하고 credentials는 한 번만 결합합니다. deadline 부재와 명시적 Infinity를 구분합니다. transformer가 바꾼 argument와 최종 method_definition을 사용하는 변경은 원본과의 차이로 patch에 남깁니다. 실제 native grpc-js 서버·클라이언트와 비교한 결과는 `verification/native-differential.json`에 있습니다.
