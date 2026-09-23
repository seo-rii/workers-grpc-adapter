# 현재 API

이 문서는 **현재 프로토타입**을 설명합니다. v0.3 설계의 최종 API와 다를 수 있습니다. 정확한 signature는 함께 빌드한 `dist/*.d.ts`를 기준으로 합니다.

## Root

`Client`, `Channel`, `Metadata`, `ChannelCredentials`, `CallCredentials`, `credentials`, `status`, `connectivityState`, `compressionAlgorithms`, `propagate`, `makeGenericClientConstructor`, `makeClientConstructor`, `loadPackageDefinition`, `closeClient`, `getClientChannel`, `waitForClientReady`를 제공합니다.

`Client.makeUnaryRequest()`의 callback-only / metadata / options / metadata+options 형태를 시험했습니다. `makeServerStreamRequest()`는 Node Readable을 반환합니다. `makeClientStreamRequest()`와 `makeBidiStreamRequest()`는 호출 표면을 반환한 뒤 UNIMPLEMENTED로 종료하며 인증·네트워크를 시작하지 않습니다.

`InterceptingCall`, `ListenerBuilder`, `RequesterBuilder`, `StatusBuilder`와 client/call interceptor 및 provider를 제공합니다. 동일 호출에서 interceptors와 providers를 함께 지정하면 원본의 구성 오류를 냅니다. `Server`, `ServerCredentials`는 명시적 실패용입니다. 실제 upstream과의 root export 차이는 `compatibility/exports-contract.json`에 기록합니다.

## Metadata

`set`, `add`, `remove`, `get`, `getMap`, `clone`, `merge`, `getOptions`, `setOptions`를 제공합니다. `-bin` 값은 Buffer, 일반 값은 printable ASCII string입니다. transport는 `getMap()`이 아니라 복수 값을 보존하는 내부 entries를 사용합니다.

`waitForReady:true`, `corked:true`는 비지원 호출 오류입니다. idempotent/cacheable hint는 저장하지만 어댑터 재시도·캐시를 활성화하지 않습니다. authorization 중복, CR/LF, transport-owned header를 거부합니다.

## 설정

```ts
configureWorkersGrpc(config: WorkersGrpcConfig): WorkersGrpcConfigSnapshot
getWorkersGrpcConfig(): WorkersGrpcConfigSnapshot
```

| 설정 | 기본값 / 의미 |
|---|---|
| mode | `cloudflare` 또는 `grpc-web` |
| endpoints | grpc-web 모드에서 논리 authority → HTTPS gateway origin의 정확한 mapping |
| defaultTimeoutMs | 없음. 양의 정수만 허용 |
| transportMaxSendBytes | 32 MiB, 메시지 1개의 안전 상한 |
| transportMaxReceiveBytes | 32 MiB, 메시지 1개의 안전 상한 |
| allowInsecureLocalhost | false. grpc-web의 literal 127.0.0.1 / [::1] 시험만 예외 |

상한은 이 패키지 정책이며 Google/Cloudflare의 서비스 한도가 아닙니다. grpc-js 형태의 channel message limit이 더 작으면 그것을 적용합니다. 채널 옵션 -1은 해당 grpc 제한만 제거합니다. 기본 standalone 수신 상한은 4 MiB, GAX가 명시적으로 -1을 넘기는 경우 transport 상한을 사용합니다.

설정은 immutable입니다. 동일한 정규화 설정 재호출은 허용합니다. 다른 두 번째 설정은 `WGA_CONFIG_ALREADY_SET`, 첫 global Channel 이후 변경은 `WGA_CONFIG_LOCKED`입니다. 조회는 잠금이나 네트워크를 유발하지 않습니다.

대상 문자열은 `hostname[:port]`만 허용합니다. URL, `dns:///`, userinfo, query, fragment, 경로는 허용하지 않습니다. endpoint mapping은 origin만 받습니다. 호출별 method는 `/package.Service/Method` 형태입니다.

## 고급 adapter

```ts
createWorkersGrpcTransport(config?)
  → { channelCredentials, grpcOptions(existing?), gaxOptions(existing) }
```

인스턴스별 설정은 전역 설정을 변경하지 않습니다. `gaxOptions()`는 국소적인 facade를 만들지만 **실제 GAX에서 아직 실행하지 않았습니다**. 단순 facade 구성 테스트를 실제 Google SDK 호환 인증으로 해석하지 않습니다.

## 인증

`createSsl()`은 기본 HTTPS만 허용합니다. custom CA / mTLS / verification callback은 구성 오류입니다. `createFromGoogleCredential()`은 Promise 또는 동기 getRequestHeaders 결과를 처리합니다. 다른 legacy callback-only Google credential shape는 아직 지원하지 않습니다.

인증 generator는 callback 방식이며, 반환된 Promise가 reject하더라도 unhandled rejection이 되지 않도록 처리합니다. 중복 callback은 첫 결과만 사용합니다. 채널/호출 credentials는 입력 순서를 유지해 병합합니다. gateway 주소가 아니라 원래 논리적 서비스 URL이 service_url에 들어갑니다.

## 실패 의미

| 상황 | 코드 |
|---|---|
| cancel | CANCELLED |
| deadline | DEADLINE_EXCEEDED |
| 네트워크 실패 / Channel close | UNAVAILABLE |
| 잘린 frame / invalid metadata | INTERNAL |
| 길이 제한 초과 | RESOURCE_EXHAUSTED |
| 비지원 RPC / 메시지 압축 | UNIMPLEMENTED |
| grpc-status 없는 HTTP 200 | UNKNOWN |
| 인증 실패 | 명시적인 허용 코드 보존, 없는 코드는 UNKNOWN, 부적절한 control-plane 코드는 INTERNAL |

redirect는 `manual`로 차단하며 따라가지 않습니다. 오류 details에는 안전한 WGA_* 식별자를 사용합니다. user callback과 status 이벤트를 한 값으로 합치지 않습니다.

## SDK용 build 진입점

`@grpc/grpc-js/build`는 Node 빌드 전용 `createGoogleWorkerBuild`를 제공합니다. `typescript`와 `esbuild`를 개발 의존성으로 설치하고 명시한 SDK profile을 사용합니다. 이 진입점은 Workers runtime import에 포함하지 않습니다. profile에 고정한 패키지·소스·schema hash가 다르면 빌드를 거부합니다. 사용 예와 실제 bundle 시험은 `scripts/workers-sdk-test.cjs`를 참조합니다.

native HTTP/2, 임의 upstream deep imports, gzip, channelz, load-balancing, 연결 health 검사는 제공하지 않습니다. `getConnectivityState()`는 IDLE/SHUTDOWN만 반환하고 waitForReady는 성공하지 않습니다. message write flag는 identity 전송에 맞는 0, BufferHint(1), NoCompress(2) 및 두 hint의 조합만 허용합니다. 실제 parent call propagation은 비지원입니다.
