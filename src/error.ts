/*
 * Copyright 2022 gRPC authors.
 *
 * Modified by workers-grpc-adapter contributors for the Fetch-based Workers
 * transport. See vendor/UPSTREAM.json and vendor/patches for provenance.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

/** Stack formatters may return structured values or throw while the stack is read. */
export function getErrorStack(error: Error): string | undefined {
  try {
    const stack = error.stack;
    return typeof stack === 'string' ? stack : undefined;
  } catch {
    return undefined;
  }
}

export function getErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message = error.message;
      return typeof message === 'string' ? message : 'Unknown error';
    }
    return String(error);
  } catch {
    // Error inspection and coercion can invoke application accessors or proxies.
    // Formatting a codec failure must not prevent its INTERNAL terminal status.
    return 'Unknown error';
  }
}

export function getErrorCode(error: unknown): number | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as Record<string, unknown>).code === 'number'
  ) {
    return (error as Record<string, number>).code;
  } else {
    return null;
  }
}
