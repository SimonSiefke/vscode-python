// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { Extension } from 'vscode';
import { State } from 'vscode-languageclient/node';
import { LanguageServerClient } from '../../client/activation/common/languageServerClient';
import { JediLanguageServerProxy } from '../../client/activation/jedi/languageServerProxy';
import { NodeLanguageServerProxy } from '../../client/activation/node/languageServerProxy';
import { PylanceApi } from '../../client/activation/node/pylanceApi';
import { ILanguageClientFactory } from '../../client/activation/types';
import { IWorkspaceService } from '../../client/common/application/types';
import { IExperimentService, IExtensions, IInterpreterPathService } from '../../client/common/types';
import { IEnvironmentVariablesProvider } from '../../client/common/variables/types';
import { createDeferred } from '../../client/common/utils/async';

function createLegacyPylanceProxy(factory: ILanguageClientFactory): NodeLanguageServerProxy {
    const subscribe = () => ({ dispose: () => {} });
    const extension = ({
        isActive: true,
        packageJSON: { version: '1' },
        exports: { client: { isEnabled: () => false } },
    } as unknown) as Extension<PylanceApi>;
    return new NodeLanguageServerProxy(
        factory,
        {} as IExperimentService,
        ({ onDidChange: subscribe } as unknown) as IInterpreterPathService,
        ({ onDidEnvironmentVariablesChange: subscribe } as unknown) as IEnvironmentVariablesProvider,
        ({ onDidGrantWorkspaceTrust: subscribe } as unknown) as IWorkspaceService,
        ({ getExtension: () => extension } as unknown) as IExtensions,
    );
}

const proxyTypes = [
    {
        name: 'Jedi',
        create: (factory: ILanguageClientFactory) => {
            const proxy = new JediLanguageServerProxy(factory);
            return { proxy, getClient: () => proxy['languageClient'] };
        },
    },
    {
        name: 'Legacy Pylance',
        create: (factory: ILanguageClientFactory) => {
            const proxy = createLegacyPylanceProxy(factory);
            return { proxy, getClient: () => proxy.languageClient };
        },
    },
];

for (const { name, create } of proxyTypes) {
    suite(`${name} language server proxy`, () => {
        test('Closing disposes a client acquired later without starting it or registering handlers', async () => {
            const factoryEntered = createDeferred();
            const releaseFactory = createDeferred();
            const client = {
                onNotification: sinon.spy(),
                onTelemetry: sinon.spy(),
                onRequest: sinon.stub().returns({ dispose: () => {} }),
                dispose: sinon.stub().resolves(),
                start: sinon.stub().resolves(),
            };
            const factory = {
                createLanguageClient: async () => {
                    factoryEntered.resolve();
                    await releaseFactory.promise;
                    return (client as unknown) as LanguageServerClient;
                },
            };
            const { proxy, getClient } = create(factory);
            const startup = proxy.start(undefined, undefined, {});
            try {
                await Promise.race([factoryEntered.promise, startup]);
                assert.ok(factoryEntered.completed);
                await proxy.close();
                assert.strictEqual(releaseFactory.completed, false);

                releaseFactory.resolve();
                await startup;
                sinon.assert.calledOnce(client.dispose);
                sinon.assert.notCalled(client.start);
                sinon.assert.notCalled(client.onNotification);
                sinon.assert.notCalled(client.onTelemetry);
                sinon.assert.notCalled(client.onRequest);
                assert.strictEqual(getClient(), undefined);
            } finally {
                releaseFactory.resolve();
                await Promise.all([startup, proxy.close()]);
            }
        });

        test('Closing cancels initialization and disposes the client after a late start', async () => {
            const initializing = createDeferred();
            const finishStartup = createDeferred();
            const client = {
                onNotification: () => {},
                onTelemetry: () => {},
                onRequest: () => ({ dispose: () => {} }),
                cancelStartup: sinon.spy(),
                stop: sinon.stub().resolves(),
                dispose: sinon.stub().resolves(),
                start: async () => {
                    initializing.resolve();
                    await finishStartup.promise;
                },
            };
            const factory = { createLanguageClient: async () => (client as unknown) as LanguageServerClient };
            const { proxy, getClient } = create(factory);
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
                assert.strictEqual(getClient(), undefined);
            } finally {
                finishStartup.resolve();
                await Promise.all([startup, proxy.close()]);
            }
        });

        test('Closing cancels a published client that has started an automatic restart', async () => {
            const client = {
                onNotification: () => {},
                onTelemetry: () => {},
                onRequest: () => ({ dispose: () => {} }),
                state: State.Running,
                cancelStartup: sinon.spy(),
                stop: sinon.stub().resolves(),
                start: sinon.stub().resolves(),
            };
            const factory = { createLanguageClient: async () => (client as unknown) as LanguageServerClient };
            const { proxy, getClient } = create(factory);
            try {
                await proxy.start(undefined, undefined, {});
                assert.strictEqual(getClient(), client);
                client.state = State.Starting;
                await proxy.close();
                sinon.assert.calledOnce(client.cancelStartup);
                sinon.assert.notCalled(client.stop);
                assert.strictEqual(getClient(), undefined);
            } finally {
                await proxy.close();
            }
        });
    });
}
