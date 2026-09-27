'use strict';
const path = require('node:path');
const dist = process.env.WGA_INTERCEPTOR_TEST_DIST ?? path.join(__dirname, '../dist');
const { InterceptingCall } = require(path.join(dist, 'client-interceptors.js'));
const { Metadata } = require(path.join(dist, 'metadata.js'));

function fixture({ asyncStart = true, asyncMessage = true, asyncClose = false, onMessage, onClose } = {}) {
    const trace = [];
    const continuations = { message: [] };
    const nextCall = {
        start() { trace.push(['start']); },
        sendMessageWithContext(context, message) {
            trace.push(['message', message]);
            context.callback?.();
            onMessage?.();
        },
        halfClose() { trace.push(['halfClose']); onClose?.(); },
        cancelWithStatus(code, details) { trace.push(['cancel', code, details]); },
        startRead() {}, getPeer() { return 'test'; }, getAuthContext() { return null; },
    };
    const call = new InterceptingCall(nextCall, {
        start(metadata, listener, next) {
            continuations.start = () => next(metadata, listener);
            if (!asyncStart) continuations.start();
        },
        sendMessage(message, next) {
            const resume = () => next({ ...message, tenant: 'rewritten' });
            continuations.message.push(resume);
            if (!asyncMessage) resume();
        },
        halfClose(next) {
            continuations.close = next;
            if (!asyncClose) next();
        },
    });
    call.start(new Metadata());
    return { call, trace, continuations };
}

module.exports = { fixture, dist };
