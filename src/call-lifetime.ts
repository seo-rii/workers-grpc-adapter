import { Metadata } from './metadata';
import { status, propagate, TransportError } from './status';
import type { ResourceBudget } from './resources';
import type { CallObservation } from './observer';
import type { CallOptions, WorkersCall } from './call';
import type { InterceptingCallInterface } from './client-interceptors';
import type { InterceptingListener, MessageContext, StatusObject } from './call-interface';

/** Logical completion includes interceptor time, independently of transport EOF. */
export class CallLifetime implements InterceptingCallInterface {
    private readonly createdAt = Date.now();
    private options: CallOptions;
    private deadline = Infinity;
    private nextCall?: InterceptingCallInterface;
    private listener?: Partial<InterceptingListener>;
    private terminal?: StatusObject;
    private delivered = false;
    private started = false;
    private timer?: ReturnType<typeof setTimeout>;
    private removeParent?: () => void;
    private chainStarted = false;
    private readonly pending: Array<() => void> = [];
    private readonly admissionAborter = new AbortController();
    private releaseAdmission?: () => void;
    private readonly transports = new Set<WorkersCall>();
    private readonly writes = new Set<(error?: Error | null) => void>();
    constructor(options: CallOptions, private readonly defaultTimeoutMs: number | undefined,
        private readonly onFinish: () => void, private readonly resources?: ResourceBudget, readonly observation?: CallObservation) {
        this.options = options;
        this.applyOptions(options);
    }
    /** Interceptor constructors are synchronous; snapshot their final call options. */
    applyOptions(options: CallOptions): CallOptions {
        this.options = { ...options };
        const value = options.deadline;
        this.deadline = value === undefined ? (this.defaultTimeoutMs === undefined ? Infinity : this.createdAt + this.defaultTimeoutMs)
            : value instanceof Date ? value.getTime() : value;
        return { ...options, deadline: this.deadline };
    }
    bind(nextCall: InterceptingCallInterface): this { this.nextCall = nextCall; return this; }
    addTransport(call: WorkersCall): void {
        if (this.terminal) call.cancelWithStatus(this.terminal.code, this.terminal.details);
        else this.transports.add(call);
    }
    isTerminal(): boolean { return this.terminal !== undefined; }
    timerActive(): boolean { return this.timer !== undefined; }
    getPeer(): string { return this.nextCall?.getPeer() ?? 'unknown'; }
    getAuthContext() { return this.nextCall?.getAuthContext() ?? null; }
    start(metadata: Metadata, listener?: Partial<InterceptingListener>): void {
        if (this.started) throw new Error('Call already started');
        this.started = true;
        this.observation?.start();
        this.listener = listener;
        if (this.terminal) { this.deliver(); return; }
        if (typeof this.deadline !== 'number' || Number.isNaN(this.deadline) || this.deadline === -Infinity) {
            this.cancelWithStatus(status.INTERNAL, 'WGA_INVALID_DEADLINE'); return;
        }
        const flags = this.options.propagate_flags ?? propagate.DEFAULTS;
        if (!Number.isInteger(flags) || flags < 0 || flags > propagate.DEFAULTS) {
            this.cancelWithStatus(status.UNIMPLEMENTED, 'WGA_CALL_OPTION'); return;
        }
        if (!this.attachParent(flags)) return;
        this.armTimer();
        if (this.terminal) return;
        const begin = () => {
            if (this.terminal) return;
            this.chainStarted = true;
            this.observation?.admitted();
            this.startChain(metadata);
            while (!this.terminal && this.pending.length) this.pending.shift()!();
        };
        if (!this.resources) { begin(); return; }
        if (this.resources.limits.maxConcurrentCalls !== undefined) this.observation?.queue();
        const admission = this.resources.acquire(this.admissionAborter.signal);
        void admission.then(release => {
            if (this.terminal) { release(); return; }
            this.releaseAdmission = release;
            if (!this.chainStarted) begin();
        }, error => {
            if (!this.terminal) this.cancelWithStatus(error instanceof TransportError ? error.code : status.INTERNAL,
                error instanceof TransportError ? error.diagnostic : 'WGA_CALL_ADMISSION');
        });
        // With no admission limit the slot is claimed synchronously. Preserve
        // grpc-js's synchronous requester startup for existing configurations.
        if (this.resources.limits.maxConcurrentCalls === undefined) begin();
    }
    private startChain(metadata: Metadata): void {
        try {
            this.nextCall!.start(metadata, {
                onReceiveMetadata: value => { if (!this.terminal) this.listener?.onReceiveMetadata?.(value); },
                onReceiveMessage: value => { if (!this.terminal) this.listener?.onReceiveMessage?.(value); },
                onReceiveStatus: value => this.finish(value, true),
            });
        } catch { this.cancelWithStatus(status.INTERNAL, 'WGA_INTERCEPTOR_START'); }
    }
    private attachParent(flags: number): boolean {
        const parent = this.options.parent;
        if (parent == null) return true;
        let detach: (() => void) | undefined;
        try {
            if (typeof parent.cancelled !== 'boolean' || typeof parent.getDeadline !== 'function'
                || typeof parent.on !== 'function' || typeof parent.removeListener !== 'function') throw new Error();
            if (flags & propagate.DEADLINE) {
                const value = parent.getDeadline();
                const deadline = value instanceof Date ? value.getTime() : value;
                if (typeof deadline !== 'number' || Number.isNaN(deadline) || deadline === -Infinity) throw new Error();
                this.deadline = Math.min(this.deadline, deadline);
                for (const call of this.transports) call.updateManagedDeadline(this.deadline);
            }
            if (flags & propagate.CANCELLATION) {
                const cancelled = () => this.cancelWithStatus(status.CANCELLED, 'Cancelled by parent call');
                if (parent.cancelled) { cancelled(); return false; }
                const remove = parent.removeListener.bind(parent);
                detach = () => { remove('cancelled', cancelled); };
                this.removeParent = detach;
                parent.on('cancelled', cancelled);
                if (this.terminal) { detach(); return false; }
                if (parent.cancelled) { cancelled(); return false; }
            }
            return !this.terminal;
        } catch {
            try { detach?.(); } catch { /* Cleanup cannot hide the terminal status. */ }
            this.removeParent = undefined;
            this.cancelWithStatus(status.INTERNAL, 'WGA_INVALID_PARENT'); return false;
        }
    }
    private armTimer(): void {
        if (this.terminal || this.deadline === Infinity) return;
        const remaining = this.deadline - Date.now();
        if (remaining <= 0) { this.cancelWithStatus(status.DEADLINE_EXCEEDED, 'WGA_DEADLINE'); return; }
        this.timer = setTimeout(() => { this.timer = undefined; this.armTimer(); }, Math.min(remaining, 2147483647));
    }
    sendMessageWithContext(context: MessageContext, message: unknown): void {
        if (this.terminal) { queueMicrotask(() => context.callback?.(new Error('WGA_CALL_TERMINATED'))); return; }
        let settled = false;
        const done = (error?: Error | null) => {
            if (settled) return;
            settled = true; this.writes.delete(done); context.callback?.(error);
        };
        if (context.callback) this.writes.add(done);
        const send = () => {
            try { this.nextCall!.sendMessageWithContext({ ...context, ...(context.callback ? { callback: done } : {}) }, message); }
            catch { this.cancelWithStatus(status.INTERNAL, 'WGA_INTERCEPTOR_SEND'); }
        };
        if (this.chainStarted) send(); else this.pending.push(send);
    }
    sendMessage(message: unknown): void {
        if (this.terminal) return;
        // Preserve the public entry point: custom InterceptingCall subclasses
        // may override sendMessage to supply flags such as NoCompress.
        const send = () => {
            try { this.nextCall!.sendMessage(message); }
            catch { this.cancelWithStatus(status.INTERNAL, 'WGA_INTERCEPTOR_SEND'); }
        };
        if (this.chainStarted) send(); else this.pending.push(send);
    }
    startRead(): void {
        if (this.terminal) return;
        if (this.chainStarted) this.nextCall?.startRead();
        else this.pending.push(() => this.nextCall?.startRead());
    }
    halfClose(): void {
        if (this.terminal) return;
        const close = () => {
            try { this.nextCall!.halfClose(); } catch { this.cancelWithStatus(status.INTERNAL, 'WGA_INTERCEPTOR_HALF_CLOSE'); }
        };
        if (this.chainStarted) close(); else this.pending.push(close);
    }
    cancelWithStatus(code: status, details: string): void {
        if (this.terminal) return;
        this.finish({ code, details, metadata: new Metadata() });
        // Cancellation requesters are observers of local cancellation, not a veto.
        try { this.nextCall?.cancelWithStatus(code, details); } catch { /* Already completed and cleaned. */ }
    }
    private finish(result: StatusObject, fromListener = false): void {
        if (this.terminal) return;
        this.terminal = result;
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
        const detach = this.removeParent; this.removeParent = undefined;
        try { detach?.(); } catch { /* A custom parent must not prevent cleanup. */ }
        this.onFinish();
        // Queue local completion before aborting upload writes. The transport's
        // listener already runs asynchronously: preserve its status-before-write
        // order instead of inserting another microtask in that path.
        if (!fromListener) this.deliver();
        this.pending.length = 0;
        this.admissionAborter.abort();
        this.releaseAdmission?.(); this.releaseAdmission = undefined;
        try { this.nextCall?.disposePending?.(); } catch { /* Custom cleanup cannot veto completion. */ }
        for (const call of this.transports) call.cancelWithStatus(result.code, result.details);
        this.transports.clear();
        this.observation?.finish(result.code);
        if (fromListener) this.deliver(true);
        for (const done of this.writes) queueMicrotask(() => done(new Error('WGA_CALL_TERMINATED')));
        this.writes.clear();
    }
    private deliver(fromListener = false): void {
        if (!this.listener || !this.terminal || this.delivered) return;
        this.delivered = true;
        const listener = this.listener, result = this.terminal;
        this.listener = undefined;
        if (fromListener) listener.onReceiveStatus?.(result);
        else queueMicrotask(() => listener.onReceiveStatus?.(result));
    }
}
