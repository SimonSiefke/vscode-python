// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { PassThrough } from 'stream';
import vscode = require('vscode');
import { StreamMessageReader, StreamMessageWriter } from 'vscode-languageclient/node';
import { LanguageServerClient } from '../../client/activation/common/languageServerClient';
import { createDeferred, raceTimeout } from '../../client/common/utils/async';

suite('Native language server client', () => {
    async function cancelAndCheckDiagnostics(transportAlreadyOpen: boolean): Promise<void> {
        const sandbox = sinon.createSandbox();
        const transportRequested = createDeferred();
        const releaseTransport = createDeferred();
        const disposedDiagnostics = createDeferred();
        const initializeSent = createDeferred();
        const disposeDiagnostics = sandbox.spy(() => disposedDiagnostics.resolve());
        const input = new PassThrough();
        const output = new PassThrough();
        const requests = new StreamMessageReader(output);
        const subscription = requests.listen((message) => {
            if ('method' in message && message.method === 'initialize') {
                initializeSent.resolve();
            }
        });
        const version = Object.getOwnPropertyDescriptor(vscode, 'version');
        const kill = sandbox.spy((_signal: NodeJS.Signals) => {
            input.destroy();
            return true;
        });
        let client: LanguageServerClient | undefined;
        let startup: Promise<void> | undefined;
        try {
            Object.defineProperty(vscode, 'version', { configurable: true, value: '1.95.0' });
            sandbox.stub(vscode, 'languages').value({
                createDiagnosticCollection: () => ({ dispose: disposeDiagnostics }),
            });
            sandbox.stub(vscode, 'workspace').value(
                new Proxy(vscode.workspace, {
                    get(target, property) {
                        if (property === 'workspaceFolders') {
                            return [];
                        }
                        if (property === 'getConfiguration') {
                            return () => ({ get: () => undefined });
                        }
                        return target[property as keyof typeof target];
                    },
                }),
            );
            client = new LanguageServerClient(
                'test-client',
                'Test client',
                async () => {
                    transportRequested.resolve();
                    await releaseTransport.promise;
                    return { reader: new StreamMessageReader(input), writer: new StreamMessageWriter(output) };
                },
                {},
            );
            ((client as unknown) as { _serverProcess: { kill: typeof kill } })._serverProcess = { kill };

            startup = client.start();
            await Promise.race([transportRequested.promise, startup]);
            assert.ok(transportRequested.completed);
            if (transportAlreadyOpen) {
                releaseTransport.resolve();
                assert.strictEqual(
                    await raceTimeout(
                        1_000,
                        initializeSent.promise.then(() => true),
                    ),
                    true,
                    'The client should send initialize before cancellation',
                );
            }

            client.cancelStartup();
            sinon.assert.notCalled(kill);
            sinon.assert.notCalled(disposeDiagnostics);
            releaseTransport.resolve();
            assert.strictEqual(
                await raceTimeout(
                    1_000,
                    startup.then(
                        () => true,
                        () => true,
                    ),
                ),
                true,
            );
            assert.strictEqual(
                await raceTimeout(
                    1_000,
                    disposedDiagnostics.promise.then(() => true),
                ),
                true,
            );
            sinon.assert.calledOnceWithExactly(kill, 'SIGKILL');
            sinon.assert.calledOnce(disposeDiagnostics);
        } finally {
            client?.cancelStartup();
            releaseTransport.resolve();
            input.destroy();
            output.destroy();
            await startup?.catch(() => undefined);
            subscription.dispose();
            requests.dispose();
            sandbox.restore();
            if (version) {
                Object.defineProperty(vscode, 'version', version);
            } else {
                Reflect.deleteProperty(vscode, 'version');
            }
        }
    }

    test('Cancellation during transport acquisition releases diagnostics through the connection close handler', () =>
        cancelAndCheckDiagnostics(false));

    test('Cancellation after sending initialize terminates the stalled client and releases diagnostics', () =>
        cancelAndCheckDiagnostics(true));
});
