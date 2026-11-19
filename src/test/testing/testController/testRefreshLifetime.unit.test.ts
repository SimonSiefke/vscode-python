// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as TypeMoq from 'typemoq';
import {
    CancellationToken,
    CancellationTokenSource,
    Disposable,
    EventEmitter,
    TestController,
    tests,
    Uri,
    WorkspaceFoldersChangeEvent,
} from 'vscode';
import { ICommandManager, IWorkspaceService } from '../../../client/common/application/types';
import { IPythonExecutionFactory } from '../../../client/common/process/types';
import { IConfigurationService, IPythonSettings } from '../../../client/common/types';
import { createDeferred } from '../../../client/common/utils/async';
import { Architecture } from '../../../client/common/utils/platform';
import { IEnvironmentVariablesProvider } from '../../../client/common/variables/types';
import * as envExtApiInternal from '../../../client/envExt/api.internal';
import { IInterpreterService } from '../../../client/interpreter/contracts';
import { EnvironmentType } from '../../../client/pythonEnvironments/info';
import { ITestDebugLauncher } from '../../../client/testing/common/types';
import { ITestFrameworkController } from '../../../client/testing/testController/common/types';
import { PythonTestController } from '../../../client/testing/testController/controller';
import { WorkspaceTestAdapter } from '../../../client/testing/testController/workspaceTestAdapter';

suite('Test refresh subscription lifetime', () => {
    let controller: PythonTestController;
    let testController: TestController;
    let registry: Disposable[];
    let tokens: CancellationTokenSource[];
    let workspaceService: TypeMoq.IMock<IWorkspaceService>;
    let configSettings: TypeMoq.IMock<IConfigurationService>;
    let interpreterService: TypeMoq.IMock<IInterpreterService>;

    setup(() => {
        registry = [];
        tokens = [];
        workspaceService = TypeMoq.Mock.ofType<IWorkspaceService>();
        configSettings = TypeMoq.Mock.ofType<IConfigurationService>();
        interpreterService = TypeMoq.Mock.ofType<IInterpreterService>();
        const factory = sinon.spy(tests, 'createTestController');
        controller = new PythonTestController(
            workspaceService.object,
            configSettings.object,
            TypeMoq.Mock.ofType<ITestFrameworkController>().object,
            TypeMoq.Mock.ofType<ITestFrameworkController>().object,
            registry,
            interpreterService.object,
            TypeMoq.Mock.ofType<ICommandManager>().object,
            TypeMoq.Mock.ofType<IPythonExecutionFactory>().object,
            TypeMoq.Mock.ofType<ITestDebugLauncher>().object,
            TypeMoq.Mock.ofType<IEnvironmentVariablesProvider>().object,
        );
        testController = factory.returnValues[0];
    });

    teardown(() => {
        registry.forEach((item) => item.dispose());
        tokens.forEach((token) => token.dispose());
        sinon.restore();
    });

    function cancellation() {
        const source = new CancellationTokenSource();
        tokens.push(source);
        const dispose = sinon.spy();
        const token: CancellationToken = {
            get isCancellationRequested() {
                return source.token.isCancellationRequested;
            },
            onCancellationRequested: (listener, thisArgs, disposables) => {
                const subscription = source.token.onCancellationRequested(listener, thisArgs);
                const owned = {
                    dispose: () => {
                        dispose();
                        subscription.dispose();
                    },
                };
                disposables?.push(owned);
                return owned;
            },
        };
        return { source, token, dispose };
    }

    async function refresh(token: CancellationToken): Promise<void> {
        assert.ok(testController.refreshHandler);
        await testController.refreshHandler(token);
    }

    test('releases the cancellation subscription after successful refresh', async () => {
        const gate = createDeferred<void>();
        sinon.stub(controller, 'refreshTestData').returns(gate.promise);
        const cancellationToken = cancellation();
        const pending = refresh(cancellationToken.token);
        assert.strictEqual(cancellationToken.dispose.callCount, 0);
        gate.resolve();
        await pending;
        assert.strictEqual(cancellationToken.dispose.callCount, 1);
    });

    test('releases the cancellation subscription after failed refresh', async () => {
        const failure = new Error('Discovery failed');
        sinon.stub(controller, 'refreshTestData').rejects(failure);
        const cancellationToken = cancellation();
        await assert.rejects(refresh(cancellationToken.token), failure);
        assert.strictEqual(cancellationToken.dispose.callCount, 1);
    });

    test('releases the cancellation subscription after synchronous refresh failure', async () => {
        const failure = new Error('Cannot start discovery');
        sinon.stub(controller, 'refreshTestData').throws(failure);
        const cancellationToken = cancellation();
        await assert.rejects(refresh(cancellationToken.token), failure);
        assert.strictEqual(cancellationToken.dispose.callCount, 1);
    });

    test('completed refreshes do not grow the extension shutdown registry', async () => {
        sinon.stub(controller, 'refreshTestData').resolves();
        const registrations = registry.length;
        await refresh(cancellation().token);
        await refresh(cancellation().token);
        await refresh(cancellation().token);
        assert.strictEqual(registry.length, registrations);
    });

    test('an old refresh token cannot cancel a later discovery', async () => {
        const gate = createDeferred<void>();
        const discover = sinon.stub(controller, 'refreshTestData');
        discover.onFirstCall().resolves();
        discover.onSecondCall().returns(gate.promise);
        const stop = sinon.spy(controller, 'stopRefreshing');
        const old = cancellation();
        await refresh(old.token);
        const current = cancellation();
        const pending = refresh(current.token);
        try {
            old.source.cancel();
            assert.strictEqual(stop.callCount, 0);
            current.source.cancel();
            assert.strictEqual(stop.callCount, 1);
        } finally {
            gate.resolve();
            await pending;
        }
        assert.strictEqual(current.dispose.callCount, 1);
    });

    test('finishing one refresh keeps an overlapping discovery cancellable', async () => {
        const folder = { uri: Uri.file('/workspace'), name: 'workspace', index: 0 };
        const foldersChanged = new EventEmitter<WorkspaceFoldersChangeEvent>();
        registry.push(foldersChanged);
        workspaceService.setup((service) => service.workspaceFolders).returns(() => [folder]);
        workspaceService.setup((service) => service.onDidChangeWorkspaceFolders).returns(() => foldersChanged.event);
        workspaceService.setup((service) => service.getWorkspaceFolder(folder.uri)).returns(() => folder);
        configSettings
            .setup((service) => service.getSettings(folder.uri))
            .returns(
                () => ({ testing: { unittestEnabled: true, autoTestDiscoverOnSaveEnabled: false } } as IPythonSettings),
            );
        interpreterService
            .setup((service) => service.getActiveInterpreter(folder.uri))
            .returns(async () => ({
                path: 'python',
                sysPrefix: folder.uri.fsPath,
                architecture: Architecture.Unknown,
                envType: EnvironmentType.Unknown,
            }));
        sinon.stub(envExtApiInternal, 'useEnvExtension').returns(false);
        await controller.activate();

        const firstStarted = createDeferred<void>();
        const secondStarted = createDeferred<CancellationToken>();
        const firstComplete = createDeferred<void>();
        const secondComplete = createDeferred<void>();
        const discover = sinon.stub(WorkspaceTestAdapter.prototype, 'discoverTests');
        discover.onFirstCall().callsFake(() => {
            firstStarted.resolve();
            return firstComplete.promise;
        });
        discover.onSecondCall().callsFake((_testController, _executionFactory, token) => {
            assert.ok(token);
            secondStarted.resolve(token);
            return secondComplete.promise;
        });
        const first = cancellation();
        const second = cancellation();
        const firstPending = refresh(first.token);
        let secondPending: Promise<void> | undefined;
        try {
            await Promise.race([
                firstStarted.promise,
                firstPending.then(() => assert.fail('The first refresh finished before discovery started')),
            ]);
            secondPending = refresh(second.token);
            const discoveryToken = await Promise.race([
                secondStarted.promise,
                secondPending.then(() => assert.fail('The second refresh finished before discovery started')),
            ]);
            const onDiscoveryCancellation = sinon.spy();
            registry.push(discoveryToken.onCancellationRequested(onDiscoveryCancellation));

            firstComplete.resolve();
            await firstPending;
            assert.strictEqual(first.dispose.callCount, 1);
            assert.strictEqual(second.dispose.callCount, 0);
            assert.strictEqual(onDiscoveryCancellation.callCount, 0);

            second.source.cancel();
            assert.strictEqual(onDiscoveryCancellation.callCount, 1);

            secondComplete.resolve();
            await secondPending;
            assert.strictEqual(second.dispose.callCount, 1);
        } finally {
            firstComplete.resolve();
            secondComplete.resolve();
            await Promise.allSettled([firstPending, secondPending]);
        }
    });
});
