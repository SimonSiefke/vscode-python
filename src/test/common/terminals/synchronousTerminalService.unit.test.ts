// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { assert } from 'chai';
import { rejects } from 'node:assert/strict';
import * as path from 'path';
import * as sinon from 'sinon';
import { anything, deepEqual, instance, mock, verify, when } from 'ts-mockito';
import { CancellationToken, CancellationTokenSource, Disposable, EventEmitter } from 'vscode';
import { CancellationError } from '../../../client/common/cancellation';
import { FileSystem } from '../../../client/common/platform/fileSystem';
import { IFileSystem, TemporaryFile } from '../../../client/common/platform/types';
import { TerminalService } from '../../../client/common/terminal/service';
import { SynchronousTerminalService } from '../../../client/common/terminal/syncTerminalService';
import { createDeferred, createDeferredFrom } from '../../../client/common/utils/async';
import { EXTENSION_ROOT_DIR } from '../../../client/constants';
import { IInterpreterService } from '../../../client/interpreter/contracts';
import { InterpreterService } from '../../../client/interpreter/interpreterService';
import { PythonEnvironment } from '../../../client/pythonEnvironments/info';
import { noop, sleep } from '../../core';

suite('Terminal Service (synchronous)', () => {
    let service: SynchronousTerminalService;
    let fs: IFileSystem;
    let interpreterService: IInterpreterService;
    let terminalService: TerminalService;
    let closed: EventEmitter<void>;
    setup(() => {
        fs = mock(FileSystem);
        interpreterService = mock(InterpreterService);
        terminalService = mock(TerminalService);
        closed = new EventEmitter<void>();
        when(terminalService.onDidCloseTerminal).thenReturn(closed.event);
        service = new SynchronousTerminalService(instance(fs), instance(interpreterService), instance(terminalService));
    });
    teardown(() => closed.dispose());
    suite('Show, sendText and dispose should invoke corresponding methods in wrapped TerminalService', () => {
        test('Show should invoke show in terminal', async () => {
            when(terminalService.show(anything())).thenResolve();
            await service.show();
            verify(terminalService.show(undefined)).once();
        });
        test('Show should invoke show in terminal (without chaning focus)', async () => {
            when(terminalService.show(anything())).thenResolve();
            await service.show(false);
            verify(terminalService.show(false)).once();
        });
        test('Show should invoke show in terminal (without chaning focus)', async () => {
            when(terminalService.show(anything())).thenResolve();
            await service.show(false);
            verify(terminalService.show(false)).once();
        });
        test('Show should invoke show in terminal (without chaning focus)', async () => {
            when(terminalService.show(anything())).thenResolve();
            await service.show(false);
            verify(terminalService.show(false)).once();
        });
        test('Dispose should dipose the wrapped TerminalService', async () => {
            service.dispose();
            verify(terminalService.dispose()).once();
        });
        test('sendText should invokeSendText in wrapped TerminalService', async () => {
            when(terminalService.sendText('Blah')).thenResolve();
            await service.sendText('Blah');
            verify(terminalService.sendText('Blah')).once();
        });
        test('sendText should invokeSendText in wrapped TerminalService (errors should be bubbled up)', async () => {
            when(terminalService.sendText('Blah')).thenReject(new Error('kaboom'));
            const promise = service.sendText('Blah');

            await assert.isRejected(promise, 'kaboom');
            verify(terminalService.sendText('Blah')).once();
        });
    });
    suite('sendCommand', () => {
        const shellExecFile = path.join(EXTENSION_ROOT_DIR, 'python_files', 'shell_exec.py');

        test('run sendCommand in terminalService if there is no cancellation token', async () => {
            when(terminalService.sendCommand('cmd', deepEqual(['1', '2']))).thenResolve();
            await service.sendCommand('cmd', ['1', '2']);
            verify(terminalService.sendCommand('cmd', deepEqual(['1', '2']))).once();
        });
        test('run sendCommand in terminalService should be cancelled', async () => {
            const cancel = new CancellationTokenSource();
            const tmpFile = { filePath: 'tmp with spaces', dispose: noop };
            when(terminalService.sendCommand(anything(), anything(), anything())).thenResolve();
            when(interpreterService.getActiveInterpreter(undefined)).thenResolve(undefined);
            when(fs.createTemporaryFile('.log')).thenResolve(tmpFile);
            when(fs.readFile(anything())).thenResolve('');

            // Send the necessary commands to the terminal.
            const promise = service.sendCommand('cmd', ['1', '2'], cancel.token).catch((ex) => Promise.reject(ex));

            const deferred = createDeferredFrom(promise);
            // required to shutup node (we must handled exceptions).
            deferred.promise.ignoreErrors();

            // Should not have completed.
            assert.isFalse(deferred.completed);

            // Wait for some time, and it should still not be completed
            // Should complete only after command has executed successfully or been cancelled.
            await sleep(500);
            assert.isFalse(deferred.completed);

            // If cancelled, then throw cancellation error.
            cancel.cancel();

            await assert.isRejected(promise, new CancellationError().message);
            verify(fs.createTemporaryFile('.log')).once();
            verify(fs.readFile(tmpFile.filePath)).atLeast(1);
            verify(
                terminalService.sendCommand(
                    'python',
                    deepEqual([shellExecFile, 'cmd', '1', '2', tmpFile.filePath.fileToCommandArgumentForPythonExt()]),
                    anything(),
                ),
            ).once();
        }).timeout(1_000);
        test('run sendCommand in terminalService should complete when command completes', async () => {
            const cancel = new CancellationTokenSource();
            const tmpFile = { filePath: 'tmp with spaces', dispose: noop };
            when(terminalService.sendCommand(anything(), anything(), anything())).thenResolve();
            when(interpreterService.getActiveInterpreter(undefined)).thenResolve(undefined);
            when(fs.createTemporaryFile('.log')).thenResolve(tmpFile);
            when(fs.readFile(anything())).thenResolve('');

            // Send the necessary commands to the terminal.
            const promise = service.sendCommand('cmd', ['1', '2'], cancel.token).catch((ex) => Promise.reject(ex));

            const deferred = createDeferredFrom(promise);
            // required to shutup node (we must handled exceptions).
            deferred.promise.ignoreErrors();

            // Should not have completed.
            assert.isFalse(deferred.completed);

            // Wait for some time, and it should still not be completed
            // Should complete only after command has executed successfully or been cancelled.
            await sleep(500);
            assert.isFalse(deferred.completed);

            // Write `END` into file, to trigger completion of the command.
            when(fs.readFile(anything())).thenResolve('END');

            await promise;
            verify(fs.createTemporaryFile('.log')).once();
            verify(fs.readFile(tmpFile.filePath)).atLeast(1);
            verify(
                terminalService.sendCommand(
                    'python',
                    deepEqual([shellExecFile, 'cmd', '1', '2', tmpFile.filePath.fileToCommandArgumentForPythonExt()]),
                    anything(),
                ),
            ).once();
        }).timeout(2_000);

        test('Closing the terminal cancels completion and lets a later command finish', async () => {
            const clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
            const token = new CancellationTokenSource();
            const firstFile = { filePath: 'first lock file', dispose: sinon.spy() };
            const secondFile = { filePath: 'second lock file', dispose: sinon.spy() };
            const read = createDeferred<string>();
            const dispatched = [createDeferred<void>(), createDeferred<void>()];
            let sends = 0;
            const disposedCloseListener = sinon.spy();
            const disposedCancelListener = sinon.spy();
            const cancellation: CancellationToken = {
                get isCancellationRequested() {
                    return token.token.isCancellationRequested;
                },
                onCancellationRequested: (listener) => {
                    const subscription = token.token.onCancellationRequested(listener);
                    return new Disposable(() => {
                        subscription.dispose();
                        disposedCancelListener();
                    });
                },
            };
            when(terminalService.onDidCloseTerminal).thenReturn((listener) => {
                const subscription = closed.event(listener);
                return new Disposable(() => {
                    subscription.dispose();
                    disposedCloseListener();
                });
            });
            when(terminalService.sendCommand(anything(), anything(), anything())).thenCall(async () => {
                dispatched[sends++].resolve();
            });
            when(interpreterService.getActiveInterpreter(undefined)).thenResolve(undefined);
            when(fs.createTemporaryFile('.log')).thenResolve(firstFile, secondFile);
            when(fs.readFile(firstFile.filePath)).thenReturn(read.promise);
            when(fs.readFile(secondFile.filePath)).thenResolve('END');
            const unhandled: unknown[] = [];
            const capture = (error: unknown) => unhandled.push(error);
            process.on('unhandledRejection', capture);
            try {
                const canceled = rejects(service.sendCommand('first', [], cancellation), CancellationError);
                await dispatched[0].promise;
                await clock.tickAsync(100);
                verify(fs.readFile(firstFile.filePath)).once();

                closed.fire();
                await canceled;
                sinon.assert.calledOnce(firstFile.dispose);
                sinon.assert.calledOnce(disposedCloseListener);
                sinon.assert.calledOnce(disposedCancelListener);
                assert.isFalse(Boolean(token.token.isCancellationRequested));

                read.reject(new Error('Lock file was removed'));
                await clock.tickAsync(400);
                await new Promise<void>((resolve) => setImmediate(resolve));
                verify(fs.readFile(firstFile.filePath)).once();
                assert.deepEqual(unhandled, []);

                const replacement = service.sendCommand('second', [], cancellation);
                await dispatched[1].promise;
                await clock.tickAsync(100);
                await replacement;
                verify(fs.readFile(secondFile.filePath)).once();
                sinon.assert.calledOnce(secondFile.dispose);
                sinon.assert.calledTwice(disposedCloseListener);
                sinon.assert.calledTwice(disposedCancelListener);
            } finally {
                process.off('unhandledRejection', capture);
                token.cancel();
                token.dispose();
                clock.restore();
            }
        }).timeout(2_000);

        for (const closeTerminal of [false, true]) {
            const reason = closeTerminal ? 'terminal closure' : 'caller cancellation';
            test(`Ending a pending dispatch through ${reason} releases its lock and signals the terminal`, async () => {
                const source = new CancellationTokenSource();
                const lock = { filePath: 'lock file', dispose: sinon.spy() };
                const started = createDeferred<CancellationToken>();
                const dispatch = createDeferred<void>();
                when(interpreterService.getActiveInterpreter(undefined)).thenResolve(undefined);
                when(fs.createTemporaryFile('.log')).thenResolve(lock);
                when(fs.readFile(lock.filePath)).thenResolve('');
                when(terminalService.sendCommand(anything(), anything(), anything())).thenCall(
                    (_command, _args, token) => {
                        started.resolve(token);
                        return dispatch.promise;
                    },
                );
                try {
                    const canceled = rejects(service.sendCommand('install', [], source.token), CancellationError);
                    const terminalToken = await started.promise;
                    if (closeTerminal) {
                        closed.fire();
                    } else {
                        source.cancel();
                    }
                    await canceled;
                    assert.equal(Boolean(source.token.isCancellationRequested), !closeTerminal);
                    assert.isTrue(terminalToken.isCancellationRequested);
                    sinon.assert.calledOnce(lock.dispose);
                    assert.isFalse(dispatch.completed);
                } finally {
                    dispatch.resolve();
                    source.dispose();
                }
            });
        }

        test('Canceling a pending lock allocation disposes the file when it arrives', async () => {
            const source = new CancellationTokenSource();
            const starting = createDeferred<void>();
            const allocation = createDeferred<TemporaryFile>();
            const file = { filePath: 'late lock file', dispose: sinon.spy() };
            when(interpreterService.getActiveInterpreter(undefined)).thenResolve(undefined);
            when(fs.createTemporaryFile('.log')).thenCall(() => {
                starting.resolve();
                return allocation.promise;
            });
            try {
                const canceled = rejects(service.sendCommand('install', [], source.token), CancellationError);
                await starting.promise;
                source.cancel();
                await canceled;
                allocation.resolve(file);
                await new Promise<void>((resolve) => setImmediate(resolve));
                sinon.assert.calledOnce(file.dispose);
                verify(terminalService.sendCommand(anything(), anything(), anything())).never();
            } finally {
                allocation.resolve(file);
                source.dispose();
            }
        });

        test('Canceling interpreter lookup returns before allocating a lock or opening the terminal', async () => {
            const source = new CancellationTokenSource();
            const checking = createDeferred<void>();
            const interpreter = createDeferred<PythonEnvironment | undefined>();
            when(interpreterService.getActiveInterpreter(undefined)).thenCall(() => {
                checking.resolve();
                return interpreter.promise;
            });
            try {
                const canceled = rejects(service.sendCommand('install', [], source.token), CancellationError);
                await checking.promise;
                source.cancel();
                await canceled;
                assert.isFalse(interpreter.completed);
                interpreter.resolve(undefined);
                await new Promise<void>((resolve) => setImmediate(resolve));
                verify(fs.createTemporaryFile('.log')).never();
                verify(terminalService.sendCommand(anything(), anything(), anything())).never();
            } finally {
                interpreter.resolve(undefined);
                source.dispose();
            }
        });

        for (const { marker, expected, description } of [
            { marker: 'CANCELED\n', expected: CancellationError, description: 'the shell interrupts the command' },
            {
                marker: 'FAIL\nexample: waiting for END',
                expected: /example: waiting for END/,
                description: 'the command reports failure details',
            },
        ]) {
            test(`A terminal marker settles the wait when ${description}`, async () => {
                const clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
                const source = new CancellationTokenSource();
                const lock = { filePath: 'status marker', dispose: sinon.spy() };
                const dispatched = createDeferred<void>();
                when(interpreterService.getActiveInterpreter(undefined)).thenResolve(undefined);
                when(fs.createTemporaryFile('.log')).thenResolve(lock);
                when(fs.readFile(lock.filePath)).thenResolve(marker);
                when(terminalService.sendCommand(anything(), anything(), anything())).thenCall(async () => {
                    dispatched.resolve();
                });
                try {
                    const rejected = rejects(service.sendCommand('install', [], source.token), expected);
                    await dispatched.promise;
                    await clock.tickAsync(100);
                    await rejected;
                    sinon.assert.calledOnce(lock.dispose);
                    verify(fs.readFile(lock.filePath)).once();
                } finally {
                    source.cancel();
                    source.dispose();
                    clock.restore();
                }
            });
        }

        test('Transient file sharing failures do not replace the canceled result', async () => {
            const clock = sinon.useFakeTimers();
            const source = new CancellationTokenSource();
            const sharingError = Object.assign(new Error('File in use'), { code: 'EBUSY' });
            const lock = { filePath: 'status marker', dispose: sinon.stub().throws(sharingError) };
            const dispatched = createDeferred<void>();
            when(interpreterService.getActiveInterpreter(undefined)).thenResolve(undefined);
            when(fs.createTemporaryFile('.log')).thenResolve(lock);
            when(fs.deleteFile(lock.filePath)).thenReject(sharingError).thenResolve();
            when(terminalService.sendCommand(anything(), anything(), anything())).thenCall(async () => {
                dispatched.resolve();
            });
            try {
                const canceled = rejects(service.sendCommand('install', [], source.token), CancellationError);
                await dispatched.promise;
                source.cancel();
                await clock.tickAsync(75);
                await canceled;
                sinon.assert.calledOnce(lock.dispose);
                verify(fs.deleteFile(lock.filePath)).twice();
            } finally {
                source.dispose();
                clock.restore();
            }
        });
    });
});
