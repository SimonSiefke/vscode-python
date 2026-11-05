// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as TypeMoq from 'typemoq';
import { CancellationToken, CancellationTokenSource, Disposable, TestController, tests } from 'vscode';
import { ICommandManager, IWorkspaceService } from '../../../client/common/application/types';
import { IPythonExecutionFactory } from '../../../client/common/process/types';
import { IConfigurationService } from '../../../client/common/types';
import { createDeferred } from '../../../client/common/utils/async';
import { IEnvironmentVariablesProvider } from '../../../client/common/variables/types';
import { IInterpreterService } from '../../../client/interpreter/contracts';
import { ITestDebugLauncher } from '../../../client/testing/common/types';
import { ITestFrameworkController } from '../../../client/testing/testController/common/types';
import { PythonTestController } from '../../../client/testing/testController/controller';

suite('Test refresh subscription lifetime', () => {
    let controller: PythonTestController;
    let testController: TestController;
    let registry: Disposable[];
    let tokens: CancellationTokenSource[];

    setup(() => {
        registry = [];
        tokens = [];
        const factory = sinon.spy(tests, 'createTestController');
        controller = new PythonTestController(
            TypeMoq.Mock.ofType<IWorkspaceService>().object,
            TypeMoq.Mock.ofType<IConfigurationService>().object,
            TypeMoq.Mock.ofType<ITestFrameworkController>().object,
            TypeMoq.Mock.ofType<ITestFrameworkController>().object,
            registry,
            TypeMoq.Mock.ofType<IInterpreterService>().object,
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
});
