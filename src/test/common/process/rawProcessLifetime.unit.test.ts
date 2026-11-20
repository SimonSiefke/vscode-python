// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import childProcess from 'child_process';
import { randomUUID } from 'crypto';
import { errorMonitor, once } from 'events';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { spy } from 'sinon';
import { CancellationTokenSource, OutputChannel } from 'vscode';
import { CancellationTokenSource as ReplayingCancellationTokenSource } from 'vscode-jsonrpc/node';
import { ProcessService } from '../../../client/common/process/proc';
import { execObservable, plainExec, shellExec } from '../../../client/common/process/rawProcessApis';
import { IDisposable } from '../../../client/common/types';
import { createDeferred } from '../../../client/common/utils/async';

const fallbackExitCode = 29;
const exitIfNotStopped = `setTimeout(() => { process.stdout.write("fallback"); process.exit(${fallbackExitCode}); }, 5000)`;
const ignoreFirstSignal = 'process.once("SIGTERM", () => process.stdout.write("survived"));';
// The remaining close listener belongs to the test's completion probe.
const detachedOwnership = { handles: 0, exitListeners: 0, closeListeners: 1, errorMonitors: 0 };

function processOwnership(proc: childProcess.ChildProcess, handles: Set<IDisposable>) {
    return {
        handles: handles.size,
        exitListeners: proc.listenerCount('exit'),
        closeListeners: proc.listenerCount('close'),
        errorMonitors: proc.listenerCount(errorMonitor),
    };
}

function nextOutput(stdout: Readable, closed: Promise<unknown>): Promise<string | undefined> {
    return Promise.race([once(stdout, 'data').then(([data]) => data.toString()), closed.then(() => undefined)]);
}

suite('Completed process handle lifetime', () => {
    test('plain execution releases its shutdown handle after completion', async () => {
        const handles = new Set<IDisposable>();
        const result = await plainExec(
            process.execPath,
            ['-e', 'process.stdout.write("complete")'],
            { doNotLog: true },
            undefined,
            handles,
        );
        assert.strictEqual(result.stdout, 'complete');
        assert.strictEqual(handles.size, 0);
    });

    test('plain execution releases its shutdown handle after spawn failure', async () => {
        const handles = new Set<IDisposable>();
        const missing = join(tmpdir(), `python-process-missing-${randomUUID()}`);
        await assert.rejects(plainExec(missing, [], { doNotLog: true }, undefined, handles));
        assert.strictEqual(handles.size, 0);
    });

    test('shell execution releases its shutdown handle after completion', async () => {
        const handles = new Set<IDisposable>();
        const result = shellExec('echo complete', { doNotLog: true }, undefined, handles);
        assert.strictEqual(handles.size, 1);
        assert.strictEqual((await result).stdout.trim(), 'complete');
        assert.strictEqual(handles.size, 0);
    });

    test('shell execution releases its shutdown handle after spawn failure', async () => {
        const handles = new Set<IDisposable>();
        const shell = join(tmpdir(), `python-process-missing-${randomUUID()}`);
        await assert.rejects(shellExec('echo complete', { doNotLog: true, shell }, undefined, handles), {
            code: 'ENOENT',
        });
        assert.strictEqual(handles.size, 0);
    });

    test('observable execution releases its shutdown handle after completion', async () => {
        const handles = new Set<IDisposable>();
        const result = execObservable(
            process.execPath,
            ['-e', 'process.stdout.write("complete")'],
            { doNotLog: true },
            undefined,
            handles,
        );
        assert.ok(result.proc);
        const closed = once(result.proc, 'close');
        let output = '';
        result.out.subscribe((item) => {
            output += item.out;
        });
        await closed;
        assert.strictEqual(output, 'complete');
        assert.strictEqual(handles.size, 0);
    });

    test('direct stream consumers release the handle without subscribing to the observable', async () => {
        const handles = new Set<IDisposable>();
        const result = execObservable(
            process.execPath,
            ['-e', 'process.stdout.write("complete")'],
            { doNotLog: true },
            undefined,
            handles,
        );
        const { proc } = result;
        assert.ok(proc);
        const closed = once(proc, 'close');
        let ownershipAtExit: ReturnType<typeof processOwnership> | undefined;
        proc.once('exit', () => {
            ownershipAtExit = processOwnership(proc, handles);
        });
        proc.stdout?.resume();
        proc.stderr?.resume();
        await closed;
        assert.deepStrictEqual(ownershipAtExit, detachedOwnership);
        assert.strictEqual(handles.size, 0);
        assert.strictEqual(proc.listenerCount('error'), 0);
    });

    test('a raw spawn failure releases the handle and reaches the consumer', async () => {
        const handles = new Set<IDisposable>();
        const missing = join(tmpdir(), `python-process-missing-${randomUUID()}`);
        const { proc } = execObservable(missing, [], { doNotLog: true }, undefined, handles);
        assert.ok(proc);
        const closed = new Promise<void>((resolve) => proc.once('close', () => resolve()));
        const existingErrorListeners = proc.listenerCount('error');
        const failed = new Promise<{
            error: NodeJS.ErrnoException;
            ownershipAtError: ReturnType<typeof processOwnership>;
        }>((resolve) => {
            proc.once('error', (error) => resolve({ error, ownershipAtError: processOwnership(proc, handles) }));
        });

        const { error, ownershipAtError } = await failed;
        await closed;
        assert.strictEqual(existingErrorListeners, 0);
        assert.strictEqual(error.code, 'ENOENT');
        assert.deepStrictEqual(ownershipAtError, detachedOwnership);
    });

    test('shutdown still stops the live observable after a sibling completes', async () => {
        const handles = new Set<IDisposable>();
        const result = execObservable(
            process.execPath,
            ['-e', `process.stdout.write("ready"); ${exitIfNotStopped}`],
            { doNotLog: true },
            undefined,
            handles,
        );
        const { proc } = result;
        assert.ok(proc?.stdout);
        const closed = once(proc, 'close');
        try {
            assert.strictEqual(await nextOutput(proc.stdout, closed), 'ready');
            const finished = plainExec(
                process.execPath,
                ['-e', 'process.stdout.write("complete")'],
                { doNotLog: true },
                undefined,
                handles,
            );
            assert.strictEqual(handles.size, 2);
            assert.strictEqual((await finished).stdout, 'complete');
            assert.strictEqual(handles.size, 1);
            handles.forEach((handle) => handle.dispose());
            const [code] = await closed;
            assert.notStrictEqual(code, fallbackExitCode);
            assert.strictEqual(handles.size, 0);
        } finally {
            if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
            await closed;
        }
    });

    test('a live observable child remains registered after an IPC error', async () => {
        const handles = new Set<IDisposable>();
        const { proc } = execObservable(
            process.execPath,
            ['-e', `process.disconnect(); ${exitIfNotStopped}`],
            { doNotLog: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
            undefined,
            handles,
        );
        assert.ok(proc);
        const closed = new Promise<number | null>((resolve) => proc.once('close', resolve));
        try {
            await once(proc, 'disconnect');
            const failed = once(proc, 'error');
            proc.send('message');
            assert.strictEqual((await failed)[0].code, 'ERR_IPC_CHANNEL_CLOSED');
            assert.strictEqual(handles.size, 1);
            handles.forEach((handle) => handle.dispose());
            assert.notStrictEqual(await closed, fallbackExitCode);
            assert.strictEqual(handles.size, 0);
        } finally {
            if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
            await closed;
        }
    });

    if (process.platform !== 'win32') {
        test('shell abort does not signal a child again while it handles SIGTERM', async () => {
            const service = new ProcessService();
            const controller = new AbortController();
            const exec = spy(childProcess, 'exec');
            const result = service
                .shellExec('exec "$TEST_NODE" -e "$TEST_SCRIPT"', {
                    signal: controller.signal,
                    env: {
                        ...process.env,
                        TEST_NODE: process.execPath,
                        TEST_SCRIPT: `process.once("SIGTERM", () => {}); process.stdout.write("ready"); setTimeout(() => process.exit(${fallbackExitCode}), 5000);`,
                    },
                })
                .catch((error: unknown) => error);
            const proc = exec.firstCall?.returnValue;
            exec.restore();
            assert.ok(proc?.stdout);

            const closed = new Promise<void>((resolve) => proc.once('close', () => resolve()));
            const kill = spy(process, 'kill');
            try {
                assert.strictEqual(await nextOutput(proc.stdout, closed), 'ready');
                controller.abort();
                const error = await result;
                assert.ok(error instanceof Error);
                assert.strictEqual(error.name, 'AbortError');
                assert.strictEqual(proc.killed, true);
                assert.strictEqual(kill.withArgs(proc.pid).callCount, 0);
            } finally {
                kill.restore();
                controller.abort();
                if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
                await closed;
                service.dispose();
            }
        });

        for (const stop of ['observable disposal', 'raw child kill']) {
            test(`shutdown retries after a child handles the first ${stop} signal`, async () => {
                const handles = new Set<IDisposable>();
                const result = execObservable(
                    process.execPath,
                    ['-e', `${ignoreFirstSignal} process.stdout.write("ready"); ${exitIfNotStopped}`],
                    { doNotLog: true },
                    undefined,
                    handles,
                );
                const { proc } = result;
                assert.ok(proc?.stdout);
                const closed = once(proc, 'close');
                try {
                    assert.strictEqual(await nextOutput(proc.stdout, closed), 'ready');
                    const survived = nextOutput(proc.stdout, closed);
                    if (stop === 'raw child kill') {
                        assert.strictEqual(proc.kill(), true);
                        assert.strictEqual(proc.killed, true);
                    } else {
                        result.dispose();
                    }
                    assert.strictEqual(await survived, 'survived');
                    assert.strictEqual(handles.size, 1);
                    handles.forEach((handle) => handle.dispose());
                    const [, signal] = await closed;
                    assert.strictEqual(signal, 'SIGTERM');
                    assert.strictEqual(handles.size, 0);
                } finally {
                    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
                    await closed;
                }
            });
        }

        for (const firstStop of ['an observable subscription', 'a raw process consumer']) {
            test(`late subscription shares one cancellation signal with ${firstStop}`, async () => {
                const handles = new Set<IDisposable>();
                const cancellation = new ReplayingCancellationTokenSource();
                const result = execObservable(
                    process.execPath,
                    ['-e', `${ignoreFirstSignal} process.stdout.write("ready"); ${exitIfNotStopped}`],
                    { doNotLog: true, token: cancellation.token },
                    undefined,
                    handles,
                );
                const { proc } = result;
                assert.ok(proc?.stdout);
                const closed = once(proc, 'close');
                const kill = spy(process, 'kill');
                try {
                    const ready = nextOutput(proc.stdout, closed);
                    const rawConsumer = firstStop === 'a raw process consumer';
                    if (rawConsumer) {
                        cancellation.token.onCancellationRequested(() => proc.kill());
                    } else {
                        result.out.subscribe();
                    }
                    assert.strictEqual(await ready, 'ready');
                    const survived = nextOutput(proc.stdout, closed);
                    cancellation.cancel();
                    assert.strictEqual(await survived, 'survived');
                    assert.strictEqual(proc.killed, rawConsumer);

                    result.out.subscribe();
                    await new Promise<void>((resolve) => cancellation.token.onCancellationRequested(resolve));
                    assert.strictEqual(kill.withArgs(proc.pid).callCount, rawConsumer ? 0 : 1);
                    assert.strictEqual(handles.size, 1);
                    handles.forEach((handle) => handle.dispose());
                    const [, signal] = await closed;
                    assert.strictEqual(signal, 'SIGTERM');
                    assert.strictEqual(handles.size, 0);
                } finally {
                    kill.restore();
                    cancellation.dispose();
                    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
                    await closed;
                }
            });
        }

        test('plain cancellation preserves a native timeout signal and shutdown can retry', async () => {
            const service = new ProcessService();
            const cancellation = new CancellationTokenSource();
            const survived = createDeferred<void>();
            const outputChannel = {
                append(text: string) {
                    if (text === 'survived') survived.resolve();
                },
            } as OutputChannel;
            const spawn = spy(childProcess, 'spawn');
            const result = service.exec(process.execPath, ['-e', `${ignoreFirstSignal} ${exitIfNotStopped}`], {
                timeout: 1500,
                token: cancellation.token,
                outputChannel,
            });
            const proc = spawn.firstCall?.returnValue;
            spawn.restore();
            assert.ok(proc);
            const kill = spy(process, 'kill');
            try {
                await Promise.race([survived.promise, result]);
                assert.ok(survived.completed);
                assert.strictEqual(proc.killed, true);

                cancellation.cancel();
                assert.strictEqual(kill.withArgs(proc.pid).callCount, 0);
                service.dispose();
                assert.strictEqual(kill.withArgs(proc.pid).callCount, 1);
                assert.strictEqual((await result).stdout, 'survived');
            } finally {
                kill.restore();
                cancellation.dispose();
                if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
                await result;
                service.dispose();
            }
        });

        test('shutdown retries after a child handles the first plain cancellation signal', async () => {
            const handles = new Set<IDisposable>();
            const cancellation = new CancellationTokenSource();
            const ready = createDeferred<void>();
            const survived = createDeferred<void>();
            const outputChannel = {
                append(text: string) {
                    if (text === 'ready') ready.resolve();
                    if (text === 'survived') survived.resolve();
                },
            } as OutputChannel;
            const result = plainExec(
                process.execPath,
                ['-e', `${ignoreFirstSignal} process.stdout.write("ready"); ${exitIfNotStopped}`],
                { doNotLog: true, token: cancellation.token, outputChannel },
                undefined,
                handles,
            );
            try {
                await Promise.race([ready.promise, result]);
                assert.ok(ready.completed);
                cancellation.cancel();
                await Promise.race([survived.promise, result]);
                assert.ok(survived.completed);
                assert.strictEqual(handles.size, 1);
                handles.forEach((handle) => handle.dispose());
                assert.strictEqual((await result).stdout, 'readysurvived');
                assert.strictEqual(handles.size, 0);
            } finally {
                cancellation.dispose();
                await result;
            }
        });
    }
});
