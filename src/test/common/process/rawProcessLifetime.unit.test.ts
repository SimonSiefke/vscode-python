// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import { randomUUID } from 'crypto';
import { once } from 'events';
import { tmpdir } from 'os';
import { join } from 'path';
import { execObservable, plainExec, shellExec } from '../../../client/common/process/rawProcessApis';
import { IDisposable } from '../../../client/common/types';

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
    });

    test('disposing an active observable process stops it and releases its shutdown handle', async () => {
        const handles = new Set<IDisposable>();
        const result = execObservable(
            process.execPath,
            ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'],
            { doNotLog: true },
            undefined,
            handles,
        );
        assert.ok(result.proc);
        let isClosed = false;
        result.proc.once('close', () => {
            isClosed = true;
        });
        assert.ok(result.proc);
        const closed = once(result.proc, 'close');
        try {
            assert.ok(result.proc.stdout);
            await once(result.proc.stdout, 'data');
            assert.strictEqual(handles.size, 1);
            result.dispose();
            await closed;
            assert.strictEqual(handles.size, 0);
        } finally {
            if (!isClosed) result.dispose();
            await closed;
        }
    });
});
