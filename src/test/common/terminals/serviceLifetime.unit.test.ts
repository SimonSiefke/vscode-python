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
import { Architecture } from '../../../client/common/utils/platform';
import * as envApi from '../../../client/envExt/api.internal';
import { IInterpreterService } from '../../../client/interpreter/contracts';
import { IServiceContainer } from '../../../client/ioc/types';
import { EnvironmentType, PythonEnvironment } from '../../../client/pythonEnvironments/info';
import { ITerminalAutoActivation } from '../../../client/terminals/types';

suite('Terminal service lifetime', () => {
    let registry: Disposable[];
    let closed: EventEmitter<Terminal>;
    let factory: TerminalServiceFactory;
    let terminals: Terminal[];
    let terminalDisposals: sinon.SinonSpy[];
    let listenerDisposals: sinon.SinonSpy[];

    setup(() => {
        registry = [];
        terminals = [];
        terminalDisposals = [];
        listenerDisposals = [];
        closed = new EventEmitter<Terminal>();
        sinon.stub(envApi, 'useEnvExtension').returns(false);
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
        manager
            .setup((m) => m.createTerminal(TypeMoq.It.isAny()))
            .returns(() => {
                const terminal = TypeMoq.Mock.ofType<Terminal>();
                const dispose = sinon.spy();
                terminal.setup((t) => t.dispose()).callback(dispose);
                terminal.setup((t) => t.shellIntegration).returns(() => undefined);
                terminals.push(terminal.object);
                terminalDisposals.push(dispose);
                return terminal.object;
            });
        const helper = TypeMoq.Mock.ofType<ITerminalHelper>();
        helper.setup((h) => h.identifyTerminalShell(TypeMoq.It.isAny())).returns(() => TerminalShellType.bash);
        const activator = TypeMoq.Mock.ofType<ITerminalActivator>();
        activator
            .setup((a) => a.activateEnvironmentInTerminal(TypeMoq.It.isAny(), TypeMoq.It.isAny()))
            .returns(async () => false);
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
        container.setup((c) => c.get(IApplicationShell)).returns(() => TypeMoq.Mock.ofType<IApplicationShell>().object);
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

    test('closed uncached terminals do not accumulate shutdown registrations', async () => {
        const first = factory.createTerminalService();
        await first.show();
        closed.fire(terminals[0]);
        const second = factory.createTerminalService();
        await second.show();
        closed.fire(terminals[1]);
        assert.strictEqual(registry.length, 1);
        assert.strictEqual(
            listenerDisposals.every((dispose) => dispose.calledOnce),
            true,
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

    test('a cached service can open another terminal after its terminal closes', async () => {
        const service = factory.getTerminalService({});
        await service.show();
        closed.fire(terminals[0]);
        assert.strictEqual(listenerDisposals[0].callCount, 0);
        await service.show();
        assert.strictEqual(terminals.length, 2);
        closed.fire(terminals[1]);
        assert.strictEqual(listenerDisposals[0].callCount, 0);
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
