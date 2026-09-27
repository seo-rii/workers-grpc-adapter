import { Metadata, status, ServiceError } from '@grpc/grpc-js';
import { decodeGrpcStatusDetails, GrpcStatusDetailsOptions, DecodedGrpcStatusDetails } from '@grpc/grpc-js/status-details';
const original: ServiceError = Object.assign(new Error('denied'), { code: status.PERMISSION_DENIED, details: 'denied', metadata: new Metadata() });
const options: GrpcStatusDetailsOptions = { maxBytes: 65536, maxDetails: 8, decoders: { 'type.test/Example': value => ({ size: value.byteLength }) } };
const result = decodeGrpcStatusDetails(original, options);
const sameError: ServiceError = result.status;
const decoded: DecodedGrpcStatusDetails | undefined = result.details;
if (decoded) {
    const code: number = decoded.code;
    // @ts-expect-error rich status envelopes are readonly
    decoded.code = 0;
    // @ts-expect-error detail list is readonly
    decoded.details.push({ typeUrl: 'x', value: Buffer.alloc(0) });
    void code;
}
// @ts-expect-error original status must expose metadata.get
decodeGrpcStatusDetails({ code: 7, details: 'missing metadata' });
// @ts-expect-error byte ceiling is numeric
decodeGrpcStatusDetails(original, { maxBytes: 'large' });
void sameError;
