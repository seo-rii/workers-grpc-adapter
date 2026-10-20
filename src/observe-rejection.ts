/** Observe a callback's returned rejection without awaiting it or using its catch property. */
export function observeRejection(value: unknown, onRejected: (error: unknown) => void): void {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
    const rejected = (error: unknown) => {
        try { onRejected(error); }
        catch { /* The observation callback must not create another rejected promise. */ }
    };
    try {
        // Native promises may override catch or their own then property. The
        // intrinsic also works across realms and rejects non-Promise receivers.
        Promise.prototype.then.call(value, () => {}, rejected);
        return;
    } catch { /* Ordinary thenables do not have the native Promise brand. */ }
    try {
        if (typeof (value as PromiseLike<unknown>).then === 'function') {
            void Promise.resolve(value).then(() => {}, rejected);
        }
    } catch (error) { rejected(error); }
}
