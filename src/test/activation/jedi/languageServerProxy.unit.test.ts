// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { State } from 'vscode-languageclient/node';
import { LanguageServerClient } from '../../../client/activation/common/languageServerClient';
import { JediLanguageServerProxy } from '../../../client/activation/jedi/languageServerProxy';
import { createDeferred } from '../../../client/common/utils/async';

suite('Jedi Language Server proxy', () => {
    test('Closing cancels initialization and disposes the client after a late start', async () => {
        const initializing = createDeferred();
        const finishStartup = createDeferred();
        const client = {
            onNotification: () => {},
            cancelStartup: sinon.spy(),
            stop: sinon.stub().resolves(),
            dispose: sinon.stub().resolves(),
            start: async () => {
                initializing.resolve();
                await finishStartup.promise;
            },
        };
        const factory = { createLanguageClient: async () => (client as unknown) as LanguageServerClient };
        const proxy = new JediLanguageServerProxy(factory);
        const startup = proxy.start(undefined, undefined, {});
        try {
            await Promise.race([initializing.promise, startup]);
            assert.ok(initializing.completed);
            await proxy.close();
            sinon.assert.calledOnce(client.cancelStartup);
            assert.strictEqual(finishStartup.completed, false);

            finishStartup.resolve();
            await startup;
            sinon.assert.calledOnce(client.dispose);
            assert.strictEqual(proxy['languageClient'], undefined);
        } finally {
            finishStartup.resolve();
            await Promise.all([startup, proxy.close()]);
        }
    });

    test('Closing cancels a published client that has started an automatic restart', async () => {
        const client = {
            onNotification: () => {},
            state: State.Running,
            cancelStartup: sinon.spy(),
            stop: sinon.stub().resolves(),
            start: sinon.stub().resolves(),
        };
        const factory = { createLanguageClient: async () => (client as unknown) as LanguageServerClient };
        const proxy = new JediLanguageServerProxy(factory);
        try {
            await proxy.start(undefined, undefined, {});
            assert.strictEqual(proxy['languageClient'], client);
            client.state = State.Starting;
            await proxy.close();
            sinon.assert.calledOnce(client.cancelStartup);
            sinon.assert.notCalled(client.stop);
            assert.strictEqual(proxy['languageClient'], undefined);
        } finally {
            await proxy.close();
        }
    });
});
