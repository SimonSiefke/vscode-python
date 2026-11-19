// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import { randomUUID } from 'crypto';
import { once } from 'events';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { Container } from 'inversify';
import { tmpdir } from 'os';
import { join } from 'path';
import * as sinon from 'sinon';
import { setTimeout } from 'timers/promises';
import { instance, mock, when } from 'ts-mockito';
import { OutputChannel } from 'vscode';
import { PythonSettings } from '../../../client/common/configSettings';
import { ConfigurationService } from '../../../client/common/configuration/service';
import { IFileSystem } from '../../../client/common/platform/types';
import { ProcessLogger } from '../../../client/common/process/logger';
import { ProcessService } from '../../../client/common/process/proc';
import { registerTypes } from '../../../client/common/process/serviceRegistry';
import {
    IProcessLogger,
    IProcessServiceFactory,
    IPythonExecutionFactory,
    ObservableExecutionResult,
} from '../../../client/common/process/types';
import { IConfigurationService, IDisposableRegistry, IInterpreterPathService } from '../../../client/common/types';
import { createDeferred } from '../../../client/common/utils/async';
import { disposeAll } from '../../../client/common/utils/resourceLifecycle';
import { EnvironmentVariablesProvider } from '../../../client/common/variables/environmentVariablesProvider';
import { IEnvironmentVariablesProvider } from '../../../client/common/variables/types';
import { IEnvironmentActivationService } from '../../../client/interpreter/activation/types';
import { IInterpreterAutoSelectionService } from '../../../client/interpreter/autoSelection/types';
import { IComponentAdapter } from '../../../client/interpreter/contracts';
import { ServiceContainer } from '../../../client/ioc/container';
import { ServiceManager } from '../../../client/ioc/serviceManager';
import { IServiceContainer } from '../../../client/ioc/types';
import * as pixi from '../../../client/pythonEnvironments/common/environmentManagers/pixi';

suite('Process service shutdown ownership', () => {
    let registry: IDisposableRegistry;
    let factory: IProcessServiceFactory;
    let services: ServiceManager;
    const children = new Set<ObservableExecutionResult<string>>();

    function createServices(): ServiceManager {
        const container = new Container({ skipBaseClassChecks: true });
        const serviceManager = new ServiceManager(container);
        const environment = mock(EnvironmentVariablesProvider);
        when(environment.getEnvironmentVariables(undefined)).thenResolve({});
        serviceManager.addSingletonInstance(IServiceContainer, new ServiceContainer(container));
        serviceManager.addSingletonInstance(IDisposableRegistry, registry);
        serviceManager.addSingletonInstance(IEnvironmentVariablesProvider, instance(environment));
        serviceManager.addSingletonInstance(IProcessLogger, instance(mock(ProcessLogger)));
        registerTypes(serviceManager);
        return serviceManager;
    }

    setup(() => {
        registry = [];
        services = createServices();
        factory = services.get<IProcessServiceFactory>(IProcessServiceFactory);
    });

    teardown(async () => {
        for (const result of children) {
            assert.ok(result.proc);
            const closed = once(result.proc, 'close');
            result.dispose();
            await closed;
        }
        registry.forEach((item) => item.dispose());
        sinon.restore();
    });

    const live = async (result: ObservableExecutionResult<string>) => {
        assert.ok(result.proc);
        children.add(result);
        result.proc.once('close', () => children.delete(result));
        assert.ok(result.proc.stdout);
        const ready = once(result.proc.stdout, 'data');
        result.out.subscribe();
        await ready;
        return result.proc;
    };
    const waitingArgs = ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'];

    test('ordinary and activated factories share one shutdown owner', async () => {
        const settings = mock(PythonSettings);
        when(settings.pythonPath).thenReturn(process.execPath);
        const config = mock(ConfigurationService);
        when(config.getSettings(undefined)).thenReturn(instance(settings));
        services.addSingletonInstance(IConfigurationService, instance(config));
        services.addSingletonInstance(IFileSystem, {});
        services.addSingletonInstance(IComponentAdapter, { getCondaEnvironment: async () => undefined });
        services.addSingletonInstance(IEnvironmentActivationService, {
            getActivatedEnvironmentVariables: async () => ({ TEST_PROCESS_SHUTDOWN_OWNER: 'activated' }),
        });
        services.addSingletonInstance(IInterpreterAutoSelectionService, {});
        services.addSingletonInstance(IInterpreterPathService, {});
        sinon.stub(pixi, 'getPixi').resolves(undefined);

        const ordinary = await factory.create();
        const disposed = sinon.spy(ProcessService.prototype, 'dispose');
        const ordinaryResult = await ordinary.exec(process.execPath, ['-e', 'process.stdout.write("ordinary")']);
        assert.strictEqual(ordinaryResult.stdout, 'ordinary');

        const activated = services.get<IPythonExecutionFactory>(IPythonExecutionFactory);
        const completed = await activated.createActivatedEnvironment({});
        const activatedResult = await completed.exec(
            ['-e', 'process.stdout.write(process.env.TEST_PROCESS_SHUTDOWN_OWNER)'],
            {},
        );
        assert.strictEqual(activatedResult.stdout, 'activated');

        const active = await activated.createActivatedEnvironment({});
        const child = await live(active.execObservable(waitingArgs, {}));
        const closed = once(child, 'close');
        await disposeAll(registry);
        await closed;
        assert.strictEqual(registry.length, 1);
        assert.strictEqual(disposed.callCount, 1);
    });

    test('reactivation with the same registry creates a new shutdown owner', async () => {
        const previousFactory = factory;
        const previous = await previousFactory.create();
        await disposeAll(registry);
        registry.length = 0;

        services = createServices();
        factory = services.get<IProcessServiceFactory>(IProcessServiceFactory);
        const current = await factory.create();
        assert.strictEqual(
            (await current.exec(process.execPath, ['-e', 'process.stdout.write("new activation")'])).stdout,
            'new activation',
        );
        assert.strictEqual(registry.length, 1);
        await assert.rejects(previous.exec(process.execPath, ['-e', '']), /disposed/);
        const late = await previousFactory.create();
        await assert.rejects(late.exec(process.execPath, ['-e', '']), /disposed/);
    });

    test('a synchronous execution listener cannot start a child after shutdown', async () => {
        const service = await factory.create();
        service.on('exec', () => registry.forEach((entry) => entry.dispose()));
        assert.throws(() => service.execObservable(process.execPath, ['-e', '']), /disposed/);
    });

    test('an unused service is not retained by the shutdown owner', async () => {
        const service = await factory.create();
        const disposed = sinon.spy(service, 'dispose');
        registry.forEach((item) => item.dispose());
        assert.strictEqual(disposed.callCount, 0);
    });

    test('a completed plain execution leaves the shutdown owner', async () => {
        const service = await factory.create();
        const result = await service.exec(process.execPath, ['-e', 'process.stdout.write("complete")']);
        assert.strictEqual(result.stdout, 'complete');
        const disposed = sinon.spy(service, 'dispose');
        registry.forEach((item) => item.dispose());
        assert.strictEqual(disposed.callCount, 0);
    });

    test('a completed shell execution leaves the shutdown owner', async () => {
        const service = await factory.create();
        const result = await service.shellExec('echo complete');
        assert.strictEqual(result.stdout.trim(), 'complete');
        const disposed = sinon.spy(service, 'dispose');
        registry.forEach((item) => item.dispose());
        assert.strictEqual(disposed.callCount, 0);
    });

    test('a completed observable execution leaves the shutdown owner', async () => {
        const service = await factory.create();
        const result = service.execObservable(process.execPath, ['-e', 'process.stdout.write("complete")']);
        assert.ok(result.proc);
        const closed = once(result.proc, 'close');
        result.out.subscribe();
        await closed;
        const disposed = sinon.spy(service, 'dispose');
        registry.forEach((item) => item.dispose());
        assert.strictEqual(disposed.callCount, 0);
    });

    test('a failed execution leaves the shutdown owner', async () => {
        const service = await factory.create();
        await assert.rejects(service.exec(join(tmpdir(), `python-service-missing-${randomUUID()}`), []));
        const disposed = sinon.spy(service, 'dispose');
        registry.forEach((item) => item.dispose());
        assert.strictEqual(disposed.callCount, 0);
    });

    test('shutdown stops every active service through the shared owner', async () => {
        const first = await factory.create();
        const second = await factory.create();
        const firstProc = await live(first.execObservable(process.execPath, waitingArgs));
        const secondProc = await live(second.execObservable(process.execPath, waitingArgs));
        const firstClosed = once(firstProc, 'close');
        const secondClosed = once(secondProc, 'close');
        registry.forEach((item) => item.dispose());
        await Promise.all([firstClosed, secondClosed]);
        assert.strictEqual(registry.length, 1);
    });

    test('a reused service rejoins shutdown ownership for its next process', async () => {
        const service = await factory.create();
        await service.exec(process.execPath, ['-e', '']);
        const proc = await live(service.execObservable(process.execPath, waitingArgs));
        const closed = once(proc, 'close');
        registry.forEach((item) => item.dispose());
        await closed;
    });

    test('shutdown stops pending plain execution after a shorter observable closes', async () => {
        const service = await factory.create();
        const ready = createDeferred<void>();
        const channel = mock<OutputChannel>();
        when(channel.append('ready')).thenCall(() => ready.resolve());
        const running = service.exec(
            process.execPath,
            ['-e', 'process.stdout.write("ready"); setTimeout(() => process.stdout.write("finished"), 10000)'],
            { outputChannel: instance(channel) },
        );
        await ready.promise;

        const shorter = service.execObservable(process.execPath, ['-e', '']);
        assert.ok(shorter.proc);
        await once(shorter.proc, 'close');

        await disposeAll(registry);
        assert.strictEqual((await running).stdout, 'ready');
    });

    test('shutdown stops a pending shell execution', async () => {
        const service = await factory.create();
        const folder = await mkdtemp(join(tmpdir(), 'python-service-shell-'));
        const script = join(folder, 'wait.js');
        const ready = join(folder, 'ready.txt');
        await writeFile(script, 'require("fs").writeFileSync(process.argv[2], "ready"); setTimeout(() => {}, 10000);');
        const prefix = process.platform === 'win32' ? '' : 'exec ';
        const running = service.shellExec(`${prefix}"${process.execPath}" "${script}" "${ready}"`);
        const result = running.then(
            () => 'completed',
            () => 'stopped',
        );
        try {
            for (let i = 0; i < 300; i += 1) {
                if (await readFile(ready, 'utf8').catch(() => undefined)) {
                    break;
                }
                await setTimeout(10);
            }
            assert.strictEqual(await readFile(ready, 'utf8'), 'ready');
            await disposeAll(registry);
            assert.strictEqual(await result, 'stopped');
        } finally {
            await result;
            await rm(folder, { recursive: true, force: true });
        }
    });

    test('closed children release kill handles and service listeners on a reused service', async () => {
        const service = await factory.create();
        assert.ok(service instanceof ProcessService);
        for (let i = 0; i < 3; i += 1) {
            await service.exec(process.execPath, ['-e', '']);
            const observable: ObservableExecutionResult<string> = service.execObservable(process.execPath, ['-e', '']);
            assert.ok(observable.proc);
            await once(observable.proc, 'close');
            assert.strictEqual(observable.proc.listenerCount('error'), 0);
            assert.strictEqual(service['processesToKill'].size, 0);
        }
    });

    test('observable child errors keep the live child owned through shutdown', async () => {
        const service = await factory.create();
        const result = service.execObservable(
            process.execPath,
            ['-e', 'process.stdout.write("ready"); setTimeout(() => {}, 10000)'],
            { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
        );
        const proc = result.proc;
        const stdout = proc?.stdout;
        assert.ok(proc && stdout);
        const exit = new Promise<number | null>((resolve) => proc.once('exit', resolve));
        try {
            await once(stdout, 'data');
            const disconnected = once(proc, 'disconnect');
            proc.disconnect();
            await disconnected;

            const error = once(proc, 'error');
            proc.send('test after disconnect');
            const [failure] = await error;
            assert.strictEqual(failure.code, 'ERR_IPC_CHANNEL_CLOSED');
            assert.strictEqual(proc.exitCode, null);
            await disposeAll(registry);
            assert.notStrictEqual(await exit, 0);
        } finally {
            result.dispose();
            await exit;
        }
    });

    test('one completed process does not release another active process on the same service', async () => {
        const service = await factory.create();
        const proc = await live(service.execObservable(process.execPath, waitingArgs));
        await service.exec(process.execPath, ['-e', '']);
        const closed = once(proc, 'close');
        registry.forEach((item) => item.dispose());
        await closed;
    });
});
