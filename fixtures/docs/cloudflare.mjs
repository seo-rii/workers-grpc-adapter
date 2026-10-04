import { Client, credentials } from '@grpc/grpc-js';
import { configureWorkersGrpc } from '@grpc/grpc-js/config';

configureWorkersGrpc({
  mode: 'cloudflare',
  defaultTimeoutMs: 10_000,
});

const client = new Client('service.example:443', credentials.createSsl());

// Test harness export; the preceding bytes are the complete README example.
export { client };
