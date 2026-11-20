// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as TypeMoq from 'typemoq';
import { Disposable, Event, EventEmitter, Terminal } from 'vscode';
import {
    IApplicationShell,
    ICommandManager,
    ITerminalManager,
    IWorkspaceService,
} from '../../../client/common/application/types';
import { IFileSystem, IPlatformService } from '../../../client/common/platform/types';
import { TerminalServiceFactory } from '../../../client/common/terminal/factory';
import { ITerminalActivator, ITerminalHelper, TerminalShellType } from '../../../client/common/terminal/types';
import { IConfigurationService, IDisposableRegistry, IPythonSettings } from '../../../client/common/types';
import { createDeferred } from '../../../client/common/utils/async';
import { Architecture } from '../../../client/common/utils/platform';
import { disposeAll } from '../../../client/common/utils/resourceLifecycle';
import * as envApi from '../../../client/envExt/api.internal';
import * as envLegacy from '../../../client/envExt/api.legacy';
import { IInterpreterService } from '../../../client/interpreter/contracts';
import { IServiceContainer } from '../../../client/ioc/types';
import { buildPythonExecInfo } from '../../../client/pythonEnvironments/exec';
import { EnvironmentType, PythonEnvironment } from '../../../client/pythonEnvironments/info';
import { TerminalCodeExecutionProvider } from '../../../client/terminals/codeExecution/terminalCodeExecution';
import { ITerminalAutoActivation } from '../../../client/terminals/types';

suite('Terminal service lifetime', () => {
    let registry: Disposable[];
    let closed: EventEmitter<Terminal>;
    let factory: TerminalServiceFactory;
    let terminals: Terminal[];
    let terminalDisposals: sinon.SinonStub[];
    let terminalShows: sinon.SinonSpy[];
    let terminalWrites: sinon.SinonSpy[];
    let listenerDisposals: sinon.SinonSpy[];
    let useEnvExtension: sinon.SinonStub;
    let activate: sinon.SinonStub;
    let subscribeToReplState: sinon.SinonStub;
    let subscribeToTerminalData: sinon.SinonStub;

    function createTerminal(exitStatus?: Terminal['exitStatus']): Terminal {
        const dispose = sinon.stub();
        const show = sinon.spy();
        const sendText = sinon.spy();
        const terminal = ({ dispose, show, sendText, exitStatus } as unknown) as Terminal;
        terminals.push(terminal);
        terminalDisposals.push(dispose);
        terminalShows.push(show);
        terminalWrites.push(sendText);
        return terminal;
    }

    setup(() => {
        registry = [];
        terminals = [];
        terminalDisposals = [];
        terminalShows = [];
        terminalWrites = [];
        listenerDisposals = [];
        closed = new EventEmitter<Terminal>();
        useEnvExtension = sinon.stub(envApi, 'useEnvExtension').returns(false);
        activate = sinon.stub().resolves(false);
        subscribeToReplState = sinon.stub().returns({ dispose: () => {} });
        subscribeToTerminalData = sinon.stub().returns({ dispose: () => {} });
        const container = TypeMoq.Mock.ofType<IServiceContainer>();
        const manager = TypeMoq.Mock.ofType<ITerminalManager>();
        const onClose: Event<Terminal> = (listener, thisArgs, disposables) => {
            const subscription = closed.event(listener, thisArgs);
            const dispose = sinon.spy(() => subscription.dispose());
            const owned = { dispose };
            listenerDisposals.push(dispose);
            disposables?.push(owned);
            return owned;
        };
        manager.setup((m) => m.onDidCloseTerminal).returns(() => onClose);
        manager.setup((m) => m.onDidChangeTerminalState(TypeMoq.It.isAny())).returns(() => subscribeToReplState());
        manager.setup((m) => m.createTerminal(TypeMoq.It.isAny())).returns(() => createTerminal());
        const helper = TypeMoq.Mock.ofType<ITerminalHelper>();
        helper.setup((h) => h.identifyTerminalShell(TypeMoq.It.isAny())).returns(() => TerminalShellType.bash);
        const activator = TypeMoq.Mock.ofType<ITerminalActivator>();
        activator
            .setup((a) => a.activateEnvironmentInTerminal(TypeMoq.It.isAny(), TypeMoq.It.isAny()))
            .returns((terminal) => activate(terminal));
        const applicationShell = TypeMoq.Mock.ofType<IApplicationShell>();
        applicationShell.setup((s) => s.onDidWriteTerminalData).returns(() => subscribeToTerminalData);
        const settings = TypeMoq.Mock.ofType<IPythonSettings>();
        settings.setup((s) => s.pythonPath).returns(() => '/python');
        const configuration = TypeMoq.Mock.ofType<IConfigurationService>();
        configuration.setup((c) => c.getSettings(TypeMoq.It.isAny())).returns(() => settings.object);
        const interpreter: PythonEnvironment = {
            path: '/python',
            architecture: Architecture.x64,
            sysPrefix: '/python',
            envType: EnvironmentType.Venv,
        };
        const interpreters = TypeMoq.Mock.ofType<IInterpreterService>();
        interpreters.setup((i) => i.getInterpreterDetails(TypeMoq.It.isAny())).returns(async () => interpreter);
        container.setup((c) => c.get(IDisposableRegistry)).returns(() => registry);
        container.setup((c) => c.get(ITerminalManager)).returns(() => manager.object);
        container.setup((c) => c.get(ITerminalHelper)).returns(() => helper.object);
        container.setup((c) => c.get(ITerminalActivator)).returns(() => activator.object);
        container
            .setup((c) => c.get(ITerminalAutoActivation))
            .returns(() => TypeMoq.Mock.ofType<ITerminalAutoActivation>().object);
        container.setup((c) => c.get(IApplicationShell)).returns(() => applicationShell.object);
        container.setup((c) => c.get(IConfigurationService)).returns(() => configuration.object);
        container.setup((c) => c.get(IInterpreterService)).returns(() => interpreters.object);
        factory = new TerminalServiceFactory(
            container.object,
            TypeMoq.Mock.ofType<IFileSystem>().object,
            interpreters.object,
        );
    });

    teardown(() => {
        registry.slice().forEach((disposable) => disposable.dispose());
        closed.dispose();
        sinon.restore();
    });

    test('a closed uncached terminal releases its close subscription', async () => {
        const service = factory.createTerminalService();
        await service.show();
        closed.fire(terminals[0]);
        assert.strictEqual(listenerDisposals[0].callCount, 1);
    });

    test('shutdown skips closed uncached services and disposes a live one', async () => {
        const first = factory.createTerminalService();
        const firstDispose = sinon.spy(first, 'dispose');
        await first.show();
        closed.fire(terminals[0]);
        const second = factory.createTerminalService();
        const secondDispose = sinon.spy(second, 'dispose');
        await second.show();
        closed.fire(terminals[1]);
        await factory.createTerminalService().show();

        assert.strictEqual(registry.length, 1);
        await disposeAll(registry);
        assert.strictEqual(firstDispose.callCount, 1);
        assert.strictEqual(secondDispose.callCount, 1);
        assert.deepStrictEqual(
            terminalDisposals.map((dispose) => dispose.callCount),
            [0, 0, 1],
        );
        assert.deepStrictEqual(
            listenerDisposals.map((dispose) => dispose.callCount),
            [1, 1, 1],
        );
    });

    test('disposing a terminal service twice releases each resource once', async () => {
        const service = factory.createTerminalService();
        await service.show();
        service.dispose();
        service.dispose();
        assert.strictEqual(terminalDisposals[0].callCount, 1);
        assert.strictEqual(listenerDisposals[0].callCount, 1);
    });

    test('a disposed service cannot create an unowned terminal', async () => {
        const service = factory.createTerminalService();
        service.dispose();
        await assert.rejects(service.show(), /disposed/);
        assert.strictEqual(terminals.length, 0);
    });

    test('extension shutdown closes an active terminal and its subscription', async () => {
        const service = factory.createTerminalService();
        await service.show();
        registry.slice().forEach((disposable) => disposable.dispose());
        assert.strictEqual(terminalDisposals[0].callCount, 1);
        assert.strictEqual(listenerDisposals[0].callCount, 1);
    });

    test('reusing a drained registry registers cleanup for each new activation', async () => {
        await factory.createTerminalService().show();
        const previousShutdown = registry[0];
        await disposeAll(registry);
        registry.length = 0;

        await factory.createTerminalService().show();
        previousShutdown.dispose();
        await factory.createTerminalService().show();

        assert.strictEqual(registry.length, 1);
        await disposeAll(registry);
        assert.deepStrictEqual(
            terminalDisposals.map((dispose) => dispose.callCount),
            [1, 1, 1],
        );
        assert.deepStrictEqual(
            listenerDisposals.map((dispose) => dispose.callCount),
            [1, 1, 1],
        );
    });

    test('shutdown disposes remaining services after one terminal disposal throws', async () => {
        const disposeReplState = sinon.spy();
        const disposeTerminalData = sinon.spy();
        subscribeToReplState.returns({ dispose: disposeReplState });
        subscribeToTerminalData.returns({ dispose: disposeTerminalData });
        const first = factory.createTerminalService();
        await first.show();
        await first.executeCommand('print(1)', true);
        sinon.assert.calledOnce(subscribeToReplState);
        sinon.assert.calledOnce(subscribeToTerminalData);
        await factory.createTerminalService().show();
        terminalDisposals[0].throws(new Error('terminal disposal failed'));

        await disposeAll(registry);

        assert.deepStrictEqual(
            terminalDisposals.map((dispose) => dispose.callCount),
            [1, 1],
        );
        assert.deepStrictEqual(
            listenerDisposals.map((dispose) => dispose.callCount),
            [1, 1],
        );
        sinon.assert.calledOnce(disposeReplState);
        sinon.assert.calledOnce(disposeTerminalData);
    });

    test('a cached service can open another terminal after its terminal closes', async () => {
        const service = factory.getTerminalService({});
        await service.show();
        closed.fire(terminals[0]);
        assert.strictEqual(listenerDisposals[0].callCount, 0);
        await service.show();
        assert.strictEqual(terminals.length, 2);
        await disposeAll(registry);
        assert.deepStrictEqual(
            terminalDisposals.map((dispose) => dispose.callCount),
            [0, 1],
        );
        assert.strictEqual(listenerDisposals[0].callCount, 1);
    });

    test('late activation does not show a cached replacement', async () => {
        const activationStarted = createDeferred<void>();
        const firstActivation = createDeferred<boolean>();
        activate.onFirstCall().callsFake(() => {
            activationStarted.resolve();
            return firstActivation.promise;
        });
        const service = factory.getTerminalService({});
        const opening = assert.rejects(service.show(false), /closed/);
        await activationStarted.promise;

        closed.fire(terminals[0]);
        await service.show();
        const replacementShows = terminalShows[1].callCount;
        firstActivation.resolve(false);
        await opening;

        assert.deepStrictEqual(activate.args, [[terminals[0]], [terminals[1]]]);
        assert.strictEqual(terminalShows[0].callCount, 0);
        assert.strictEqual(terminalShows[1].callCount, replacementShows);
    });

    test('closing a terminal during startup skips environment activation', async () => {
        const service = factory.createTerminalService();
        const serviceDispose = sinon.spy(service, 'dispose');
        const opening = assert.rejects(service.show(), /closed/);
        assert.strictEqual(terminals.length, 1);
        closed.fire(terminals[0]);
        await opening;

        sinon.assert.notCalled(activate);
        sinon.assert.calledOnce(listenerDisposals[0]);
        const disposalCallsBeforeShutdown = serviceDispose.callCount;
        await disposeAll(registry);
        assert.strictEqual(serviceDispose.callCount, disposalCallsBeforeShutdown);
    });

    test('a second cached caller sends text after environment activation', async () => {
        const activationStarted = createDeferred<void>();
        const finishActivation = createDeferred<void>();
        const activationComplete = sinon.spy();
        activate.callsFake(async () => {
            activationStarted.resolve();
            await finishActivation.promise;
            activationComplete();
            return false;
        });

        const opening = factory.getTerminalService({}).show();
        await activationStarted.promise;
        const writing = factory.getTerminalService({}).sendText('print(1)');
        finishActivation.resolve();
        await Promise.all([opening, writing]);

        assert.strictEqual(terminals.length, 1);
        sinon.assert.calledOnce(activate);
        sinon.assert.calledOnceWithExactly(terminalWrites[0], 'print(1)');
        sinon.assert.callOrder(activationComplete, terminalWrites[0]);
    });

    test('a native activation rejection releases the uncached terminal and its ownership', async () => {
        const failure = new Error('environment activation failed');
        activate.onFirstCall().rejects(failure);
        const service = factory.createTerminalService();
        const serviceDispose = sinon.spy(service, 'dispose');

        await assert.rejects(service.show(), (error) => error === failure);

        assert.strictEqual(terminals.length, 1);
        sinon.assert.calledOnce(terminalDisposals[0]);
        sinon.assert.calledOnce(listenerDisposals[0]);
        await disposeAll(registry);
        sinon.assert.calledOnce(serviceDispose);
    });

    test('a cached service retries native activation after disposing the failed terminal', async () => {
        const failure = new Error('environment activation failed');
        activate.onFirstCall().rejects(failure);
        const service = factory.getTerminalService({});
        const close = sinon.spy();
        service.onDidCloseTerminal(close);

        await assert.rejects(service.show(), (error) => error === failure);
        await service.sendText('print(1)');

        assert.strictEqual(terminals.length, 2);
        assert.deepStrictEqual(activate.args, [[terminals[0]], [terminals[1]]]);
        sinon.assert.calledOnce(terminalDisposals[0]);
        sinon.assert.notCalled(listenerDisposals[0]);
        sinon.assert.calledOnce(close);
        sinon.assert.notCalled(terminalWrites[0]);
        sinon.assert.calledOnceWithExactly(terminalWrites[1], 'print(1)');
    });

    test('a retired REPL startup rejects promptly and leaves its replacement ready', async () => {
        const firstActivation = createDeferred<boolean>();
        const replacementActivation = createDeferred<boolean>();
        activate.onFirstCall().returns(firstActivation.promise);
        activate.onSecondCall().returns(replacementActivation.promise);
        const promptDisposals: sinon.SinonSpy[] = [];
        const onData = () => {
            const dispose = sinon.spy();
            promptDisposals.push(dispose);
            return { dispose };
        };
        const shell = TypeMoq.Mock.ofType<IApplicationShell>();
        shell.setup((s) => s.onDidWriteTerminalData).returns(() => onData);
        const provider = new TerminalCodeExecutionProvider(
            factory,
            TypeMoq.Mock.ofType<IConfigurationService>().object,
            TypeMoq.Mock.ofType<IWorkspaceService>().object,
            registry,
            TypeMoq.Mock.ofType<IPlatformService>().object,
            TypeMoq.Mock.ofType<IInterpreterService>().object,
            TypeMoq.Mock.ofType<ICommandManager>().object,
            shell.object,
        );
        sinon.stub(provider, 'getExecutableInfo').resolves(buildPythonExecInfo('python'));
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        try {
            const opening = assert.rejects(provider.initializeRepl(undefined), /closed/);
            await clock.tickAsync(100);
            sinon.assert.calledOnce(activate);

            closed.fire(terminals[0]);
            const replacement = provider.initializeRepl(undefined);
            await clock.tickAsync(100);
            assert.strictEqual(activate.callCount, 2);
            const replacementWrites = sinon.spy();
            Object.assign(terminals[1], { shellIntegration: { executeCommand: replacementWrites } });
            replacementActivation.resolve(false);
            await clock.tickAsync(0);
            firstActivation.resolve(false);
            await clock.tickAsync(0);

            sinon.assert.calledOnce(promptDisposals[0]);
            sinon.assert.notCalled(promptDisposals[1]);
            await opening;
            await clock.tickAsync(3000);
            await replacement;

            const reuse = provider.initializeRepl(undefined);
            await clock.tickAsync(3000);
            await reuse;
            assert.strictEqual(promptDisposals.length, 2);
            sinon.assert.calledOnce(promptDisposals[1]);
            sinon.assert.calledOnce(replacementWrites);
            sinon.assert.notCalled(terminalWrites[0]);
        } finally {
            clock.restore();
        }
    });

    test('a late REPL command cannot attach listeners to a disposed service', async () => {
        const service = factory.getTerminalService({});
        await service.show();
        service.dispose();

        await service.executeCommand('print(1)', true);

        sinon.assert.notCalled(subscribeToReplState);
        sinon.assert.notCalled(subscribeToTerminalData);
    });

    test('an uncached service releases both owners when Environments creation rejects after close', async () => {
        useEnvExtension.returns(true);
        const pending = createDeferred<Terminal>();
        const opened = createTerminal();
        sinon.stub(envLegacy, 'ensureTerminalLegacy').returns(pending.promise);
        const service = factory.createTerminalService();
        const serviceDispose = sinon.spy(service, 'dispose');
        const opening = assert.rejects(service.show(), /activation failed/);

        closed.fire(opened);
        pending.reject(new Error('activation failed after close'));
        await opening;

        assert.strictEqual(listenerDisposals[0].callCount, 1);
        await disposeAll(registry);
        assert.strictEqual(serviceDispose.callCount, 1);
    });

    test('a cached service can retry failed Environments creation and share its pending retry', async () => {
        useEnvExtension.returns(true);
        const pending = createDeferred<Terminal>();
        const create = sinon.stub(envLegacy, 'ensureTerminalLegacy');
        create.onFirstCall().rejects(new Error('no environment'));
        create.onSecondCall().returns(pending.promise);
        const service = factory.getTerminalService({});
        await assert.rejects(service.show(), /no environment/);
        assert.strictEqual(listenerDisposals[0].callCount, 0);

        const first = service.show();
        const second = service.show();
        pending.resolve(createTerminal());
        await Promise.all([first, second]);

        assert.strictEqual(create.callCount, 2);
        assert.strictEqual(terminalShows[0].callCount, 2);
    });

    test('a terminal delivered after disposal is closed without being shown', async () => {
        useEnvExtension.returns(true);
        const pending = createDeferred<Terminal>();
        sinon.stub(envLegacy, 'ensureTerminalLegacy').returns(pending.promise);
        const service = factory.createTerminalService();
        const opening = assert.rejects(service.show(), /disposed/);

        service.dispose();
        pending.resolve(createTerminal());
        await opening;

        assert.strictEqual(terminalDisposals[0].callCount, 1);
        assert.strictEqual(terminalShows[0].callCount, 0);
        assert.strictEqual(listenerDisposals[0].callCount, 1);
    });

    test('a terminal already closed when Environments returns it is never shown', async () => {
        useEnvExtension.returns(true);
        const terminal = createTerminal({ code: 0, reason: 2 });
        sinon.stub(envLegacy, 'ensureTerminalLegacy').resolves(terminal);
        const service = factory.createTerminalService();

        await assert.rejects(service.show(), /closed/);

        assert.strictEqual(terminalShows[0].callCount, 0);
        assert.strictEqual(listenerDisposals[0].callCount, 1);
    });

    test('closing another terminal preserves the active service', async () => {
        const service = factory.createTerminalService();
        await service.show();
        closed.fire(TypeMoq.Mock.ofType<Terminal>().object);
        assert.strictEqual(listenerDisposals[0].callCount, 0);
        await service.show();
        assert.strictEqual(terminals.length, 1);
    });

    test('closing one uncached service leaves another service active', async () => {
        const first = factory.createTerminalService();
        const second = factory.createTerminalService();
        await first.show();
        await second.show();
        closed.fire(terminals[0]);
        assert.strictEqual(listenerDisposals[0].callCount, 1);
        assert.strictEqual(listenerDisposals[1].callCount, 0);
        closed.fire(terminals[1]);
        assert.strictEqual(listenerDisposals[0].callCount, 1);
        assert.strictEqual(listenerDisposals[1].callCount, 1);
    });
});
