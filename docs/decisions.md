# 구현 결정 기록

## D-001: v0.3 목표와 이번 prototype의 경계

고정 upstream의 클라이언트 코어를 재사용합니다. 초기 자체 facade는 실제 npm `@grpc/grpc-js@1.14.0`의 Client/factory/interceptor/Metadata/call surface로 교체했습니다. 원본 소스, SHA-256, npm integrity, git commit 및 재적용 가능한 patch를 `vendor/`에 보존합니다.

하단 bridge에서 native channel을 WorkersChannel로 교체하며 최종 method/options/credentials와 deadline 부재를 보존합니다. transformer argument와 interceptor method_definition을 실제 전송에 반영하는 두 변경도 patch로 명시합니다.

## D-002: 한 개의 CJS 구현, 얇은 ESM wrapper

CJS를 사용하는 GAX와 ESM 앱의 Metadata/credentials/config identity가 갈라지지 않도록 같은 구현을 다시 export한다. Node에서 실제 혼합 import를 시험했다. Workers bundler에서는 별도 시험이 필요하며, 이를 Node 시험으로 대체하지 않는다.

## D-003: 외부 transport 종속성 없이 구현

runtime dependency가 없으며 HTTP/2를 Worker 내부에 구현하지 않는다. binary gRPC-Web, 표준 Fetch/ReadableStream/AbortController, Workers가 제공하는 Node builtin만 사용한다. 로컬 시험에서는 globals를 통제했지만 공개 임의 fetch injection API는 만들지 않았다.

## D-004: 무제한 지원을 주장하지 않는 안전 제한

메시지 ceiling, header/trailer budget, exact endpoint mapping, redirect 차단, HTTPS, 자격증명 없는 localhost만 허용하는 예외를 적용했다. 자체 retry, 압축, mTLS/custom CA, bidi/client streaming, native READY, server는 구현하지 않았다. 지원하지 않는 옵션은 조용히 버리지 않는다.

## D-005: 스트림의 오류가 앞선 메시지를 버리면 안 됨

로컬 시험 중 partial server stream에 오류를 전달하기 위해 `destroy(error)`를 사용하면 buffered 마지막 메시지가 관찰되기 전에 폐기될 수 있었다. 원본 1.14.0 Client source의 terminal 경로를 참고하여 readable 종료 후 error/status를 방출하도록 수정하고 회귀 시험을 추가했다. 실제 upstream native 서버·클라이언트와의 정상/실패/빈 stream 이벤트 비교가 통과했다.

## D-006: 실험의 독립성 표시

local HTTP/2 interop은 실제 소켓과 HTTP/2 trailer를 사용하지만 고정 목적지의 수제 bridge/서버다. 실제 replacement .tgz alias 시험도 실제 npm을 쓰지만 SDK/GAX와 baseline grpc 모듈은 모의 패키지다. 이 결과를 Envoy·실제 Google SDK·배포 Cloudflare 호환 인증으로 승격하지 않는다.

## D-007: 라이브 시험은 분리하고 기본 비활성화

`npm run verify`는 Google API를 절대 호출하지 않는다. 독립 fixture가 실제 SDK dependency를 갖고, project·credential·live/write opt-in을 명시해야만 live runner가 동작한다. Worker entrypoint는 일반 사용자 서비스가 아니라 보호해야 하는 시험 도구다. 원본 요청/응답 데이터나 secret을 보고서에 저장하지 않는다.

## D-008: 라이선스

어댑터의 독자 코드는 MIT이고, grpc-js에서 이식한 파일은 원래 Apache-2.0 저작권 고지와 라이선스를 유지한다. `vendor/LICENSE`, `vendor/NOTICE`, `vendor/UPSTREAM.json`과 patch를 tarball에도 포함한다.

## D-009: 실제 SDK 시험과 클라우드 시험 분리

설치한 실제 Datastore/Firestore/Secret Manager와 원본 grpc-js baseline을 고정된 로컬 native 서버에 연결한다. 같은 shared 파일의 SHA-256, 호출 메서드·상태, binary gRPC-Web Content-Type을 비교한다. 이는 실제 Google API의 IAM/transaction conflict/quota 동작을 인증하지 않는다.

## D-010: Workers protobuf 코드는 빌드 시점에 생성

Node 전용 `/build`에서 설치본·schema hash가 일치하는 profile만 변환한다. SDK 정적 import와 lazy encoder/decoder에서 필요한 코드를 미리 생성하며, node_modules를 직접 수정하거나 전역 protobuf prototype을 바꾸지 않는다. 이 개발 도구의 TypeScript/esbuild peer는 선택 사항이며 Worker transport의 runtime dependency가 아니다.
