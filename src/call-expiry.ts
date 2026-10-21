// Keep deadline checks internal without adding methods to grpc-js's public
// interceptor interface. Standalone interceptor wrappers have no logical call.
const expiryChecks = new WeakMap<object, () => boolean>();

export function setCallExpiryCheck(call: object, check: () => boolean): void {
    expiryChecks.set(call, check);
}

export function inheritCallExpiryCheck(call: object, nextCall: object): void {
    const check = expiryChecks.get(nextCall);
    if (check) expiryChecks.set(call, check);
}

export function stopExpiredCall(call: object): boolean {
    return expiryChecks.get(call)?.() ?? false;
}

export function invokeWithCallExpiry(call: object, operation: () => void): void {
    try { operation(); }
    catch (error) {
        // A resumed requester can run outside the lifetime's initial stack.
        // Its exception must not escape after the deadline selects completion.
        if (!stopExpiredCall(call)) throw error;
    }
}
