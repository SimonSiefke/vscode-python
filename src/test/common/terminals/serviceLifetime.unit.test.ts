// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as TypeMoq from 'typemoq';
import { Disposable, Event, EventEmitter, Terminal } from 'vscode';
import { IApplicationShell, ITerminalManager } from '../../../client/common/application/types';
import { IFileSystem } from '../../../client/common/platform/types';
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
import { EnvironmentType, PythonEnvironment } from '../../../client/pythonEnvironments/info';
import { ITerminalAutoActivation } from '../../../client/terminals/types';

suite('Terminal service lifetime', () => {
    let registry: Disposable[];
    let closed: EventEmitter<Terminal>;
    let factory: TerminalServiceFactory;
    let terminals: Terminal[];
    let terminalDisposals: sinon.SinonStub[];
    let terminalShows: sinon.SinonSpy[];
    let listenerDisposals: sinon.SinonSpy[];
    let useEnvExtension: sinon.SinonStub;
    let activate: sinon.SinonStub;
    let subscribeToReplState: sinon.SinonStub;
    let subscribeToTerminalData: sinon.SinonStub;

    function createTerminal(exitStatus?: Terminal['exitStatus']): Terminal {
        const dispose = sinon.stub();
        const show = sinon.spy();
        const terminal = ({ dispose, show, exitStatus } as unknown) as Terminal;
        terminals.push(terminal);
        terminalDisposals.push(dispose);
        terminalShows.push(show);
        return terminal;
    }

    setup(() => {
        registry = [];
        terminals = [];
        terminalDisposals = [];
        terminalShows = [];
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
        await factory.createTerminalService().show();
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
