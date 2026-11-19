// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import { randomUUID } from 'crypto';
import { errorMonitor, once } from 'events';
import { tmpdir } from 'os';
import { join } from 'path';
import { CancellationTokenSource, OutputChannel } from 'vscode';
import { execObservable, plainExec, shellExec } from '../../../client/common/process/rawProcessApis';
import { IDisposable } from '../../../client/common/types';
import { createDeferred } from '../../../client/common/utils/async';

const fallbackExitCode = 29;
const exitIfNotStopped = `setTimeout(() => { process.stdout.write("fallback"); process.exit(${fallbackExitCode}); }, 5000)`;
const ignoreFirstSignal = 'process.once("SIGTERM", () => process.stdout.write("survived"));';

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
        const result = await shellExec('echo complete', { doNotLog: true }, undefined, handles);
        assert.strictEqual(result.stdout.trim(), 'complete');
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
        assert.ok(result.proc);
        const closed = once(result.proc, 'close');
        result.proc.stdout?.resume();
        result.proc.stderr?.resume();
        await closed;
        assert.strictEqual(handles.size, 0);
        assert.strictEqual(result.proc.listenerCount('error'), 0);
        assert.strictEqual(result.proc.listenerCount(errorMonitor), 0);
    });

    test('a raw spawn failure releases the handle and reaches the consumer', async () => {
        const handles = new Set<IDisposable>();
        const missing = join(tmpdir(), `python-process-missing-${randomUUID()}`);
        const { proc } = execObservable(missing, [], { doNotLog: true }, undefined, handles);
        assert.ok(proc);
        const closed = new Promise<void>((resolve) => proc.once('close', () => resolve()));
        const existingErrorListeners = proc.listenerCount('error');
        const failed = new Promise<{ error: NodeJS.ErrnoException; remainingHandles: number }>((resolve) => {
            proc.once('error', (error) => resolve({ error, remainingHandles: handles.size }));
        });

        const { error, remainingHandles } = await failed;
        await closed;
        assert.strictEqual(existingErrorListeners, 0);
        assert.strictEqual(error.code, 'ENOENT');
        assert.strictEqual(remainingHandles, 0);
        assert.strictEqual(proc.listenerCount(errorMonitor), 0);
    });

    test('disposing an active observable stops it after a sibling completes', async () => {
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
            await once(proc.stdout, 'data');
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
            result.dispose();
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
        test('shutdown retries after a child handles the first observable disposal signal', async () => {
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
                assert.strictEqual((await once(proc.stdout, 'data'))[0].toString(), 'ready');
                const nextOutput = once(proc.stdout, 'data');
                result.dispose();
                assert.strictEqual((await nextOutput)[0].toString(), 'survived');
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
