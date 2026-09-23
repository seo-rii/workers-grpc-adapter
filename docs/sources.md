# 소스 검토와 확인 범위

검토일: 2026-09-22, 실행 근거 갱신: 2026-09-23. 아래는 기술 설계에 사용한 공식 소스다. 링크의 main branch가 추후 바뀔 수 있으므로 확인한 version/blob을 함께 적었다. **소스의 version은 npm artifact 설치 성공 또는 최신 release 확인을 뜻하지 않는다.**

| 주제 | 공식 소스 | 확인 범위 |
|---|---|---|
| Cloudflare gRPC | https://blog.cloudflare.com/grpc-workers/ | outbound gRPC-Web translation과 발표 당시 private beta. 현재 계정 활성화 미검증 |
| Workers Node 호환성 | https://developers.cloudflare.com/workers/runtime-apis/nodejs/ | 런타임 API 배경. 실제 workerd 결과는 verification/workers*.json |
| npm alias/override | https://docs.npmjs.com/cli/v11/configuring-npm/package-json/ | alias 및 root overrides. 실제 tarball alias/override와 실제 SDK npm ci 그래프 시험; 실행 버전은 보고서에 기록 |
| grpc-js Client reference | https://github.com/grpc/grpc-node/blob/%40grpc%2Fgrpc-js%401.14.0/packages/grpc-js/src/client.ts | tag `@grpc/grpc-js@1.14.0`, blob `dc75ac4828d4db3c9ef84692d30c878357ea8cfc`; 특히 server stream 종료/error/status 경로 |
| gRPC-Web wire protocol | https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-WEB.md | binary message/trailer framing |
| Native gRPC protocol | https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md | timeout, metadata, status와 HTTP/2 interop의 기준 |
| HTTP→gRPC 매핑 | https://github.com/grpc/grpc/blob/master/doc/http-grpc-status-mapping.md | gRPC status가 없을 때만 fallback |
| Datastore manifest | https://github.com/googleapis/nodejs-datastore/blob/main/package.json | source version10.1.0, blob `8e8583e2a64ed9e4515077f22a40e2dd2cce89a4` |
| Firestore manifest | https://github.com/googleapis/nodejs-firestore/blob/main/package.json | source version8.3.0, blob `92ccfa723530c07e6138b1bbb4b5757d5d907d14` |
| Secret Manager manifest | https://github.com/googleapis/google-cloud-node/blob/main/packages/google-cloud-secretmanager/package.json | source version7.1.0, blob `6cc47f202403f96b0683614d8a46e6bce34fbdac` |

원래의 설계 근거와 189개 시험 계획은 `docs/spec/v0.3.md` 및 `compatibility/test-catalog.json`에도 있다. 현재 구현의 차이/제한은 `limitations.md`가 우선하며, 현재 통과 결과는 실행 보고서를 따른다.

실제 npm 원본의 integrity/commit/hash는 `vendor/UPSTREAM.json`과 `compatibility/google-graph.json`을 따른다. SDK manifest 링크만으로 설치·호환 통과를 주장하지 않는다. Envoy 공식 release와 SHA-256은 `fixtures/envoy/binary.json`에 고정한다.
