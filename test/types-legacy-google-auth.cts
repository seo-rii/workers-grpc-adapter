import { credentials, GoogleCredential, LegacyGoogleCredential } from '@grpc/grpc-js';

const modern: GoogleCredential = {
    async getRequestHeaders(url?: string) {
        return new Headers({ authorization: `Bearer ${url}` });
    },
};
const legacy: LegacyGoogleCredential = {
    getRequestMetadata(url, callback) {
        const service: string = url;
        callback(null, { authorization: `Bearer ${service}` });
        callback(new Error('fixture'));
    },
};
credentials.createFromGoogleCredential(modern);
credentials.createFromGoogleCredential(legacy);
credentials.createFromGoogleCredential({ ...modern, ...legacy });
credentials.createFromGoogleCredential({ getRequestHeaders() { return { 'x-fixture': ['first', 'second'] }; } });
// @ts-expect-error neither supported credential API is present
credentials.createFromGoogleCredential({ getAccessToken() { return 'token'; } });
// @ts-expect-error legacy credentials require the callback header record shape
const badHeaders: LegacyGoogleCredential = { getRequestMetadata(_url, callback) { callback(null, new Headers()); } };
// @ts-expect-error legacy header values do not accept arrays
const badValues: LegacyGoogleCredential = { getRequestMetadata(_url, callback) { callback(null, { authorization: ['token'] }); } };
void badHeaders;
void badValues;
