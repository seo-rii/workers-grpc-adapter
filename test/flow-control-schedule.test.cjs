'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');

const fixture = import('../fixtures/shared/flow-control.mjs');

function fakeClock(start = 1000) {
    let current = start;
    const queue = [], requestedDelays = [];
    return {
        queue, requestedDelays,
        now: () => current,
        schedule(delay, callback) {
            assert.ok(Number.isFinite(delay) && delay >= 1, 'a retry must yield to a timer');
            requestedDelays.push(delay); queue.push(callback);
            assert.equal(queue.length, 1, 'at most one pause timer is pending');
        },
        fireAt(elapsed) {
            assert.equal(queue.length, 1, 'a real scheduled callback must exist');
            current = start + elapsed;
            queue.shift()();
        },
    };
}

test('FLOW pause re-arms a 20 ms timer observed at 19 ms instead of resuming early', async () => {
    const { schedulePauseWindow } = await fixture;
    const clock = fakeClock(), completions = [];
    schedulePauseWindow(clock.schedule, clock.now, 20, elapsed => completions.push(elapsed));
    assert.deepEqual(clock.requestedDelays, [20]);
    assert.deepEqual(completions, []);

    clock.fireAt(19);
    assert.deepEqual(clock.requestedDelays, [20, 1]);
    assert.deepEqual(completions, [], 'the measured 20 ms pause is still incomplete');
    clock.fireAt(20);
    assert.deepEqual(completions, [20]);
    assert.equal(clock.queue.length, 0);
});

test('FLOW pause tolerates repeated early callbacks without moving its original deadline', async () => {
    const { schedulePauseWindow } = await fixture;
    const clock = fakeClock(50000), completions = [];
    schedulePauseWindow(clock.schedule, clock.now, 20, elapsed => completions.push(elapsed));
    for (const elapsed of [3, 7, 7, 19, 19]) {
        clock.fireAt(elapsed);
        assert.deepEqual(completions, [], `must stay paused after only ${elapsed} ms`);
    }
    assert.deepEqual(clock.requestedDelays, [20, 17, 13, 13, 1, 1]);
    clock.fireAt(20);
    assert.deepEqual(completions, [20]);
    assert.equal(clock.queue.length, 0);
});

test('FLOW pause accepts a late timer once and leaves no follow-up callback queued', async () => {
    const { schedulePauseWindow } = await fixture;
    const clock = fakeClock(), completions = [];
    schedulePauseWindow(clock.schedule, clock.now, 20, elapsed => completions.push(elapsed));
    clock.fireAt(27);
    assert.deepEqual(completions, [27], 'report the actual measured pause');
    assert.deepEqual(clock.requestedDelays, [20]);
    assert.equal(clock.queue.length, 0, 'completion does not schedule another timer');
});
