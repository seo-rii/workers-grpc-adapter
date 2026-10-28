// Keep deadline checks internal without adding methods to grpc-js's public
// interceptor interface. Standalone interceptor wrappers have no logical call.
const expiryChecks = new WeakMap<object, { check: () => boolean; fail: (details: string) => void }>();

export function setCallExpiryCheck(call: object, check: () => boolean, fail: (details: string) => void): void {
    expiryChecks.set(call, { check, fail });
}

export function inheritCallExpiryCheck(call: object, nextCall: object): void {
    const check = expiryChecks.get(nextCall);
    if (check) expiryChecks.set(call, check);
}

export function stopExpiredCall(call: object): boolean {
    return expiryChecks.get(call)?.check() ?? false;
}

// Async requester failures need the logical owner even when startup has not
// forwarded a listener. Return false for standalone wrappers without an owner.
export function failCall(call: object, details: string): boolean {
    const lifetime = expiryChecks.get(call);
    if (!lifetime) return false;
    if (!lifetime.check()) lifetime.fail(details);
    return true;
}

export function invokeWithCallExpiry(call: object, operation: () => void): void {
    try { operation(); }
    catch (error) {
        // A resumed requester can run outside the lifetime's initial stack.
        // Its exception must not escape after the deadline selects completion.
        if (!stopExpiredCall(call)) throw error;
    }
}
