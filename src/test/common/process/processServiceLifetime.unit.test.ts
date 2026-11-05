// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import { once } from 'events';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import * as sinon from 'sinon';
import { instance, mock, when } from 'ts-mockito';
import { ProcessLogger } from '../../../client/common/process/logger';
import { ProcessServiceFactory } from '../../../client/common/process/processFactory';
import { ObservableExecutionResult } from '../../../client/common/process/types';
import { IDisposableRegistry } from '../../../client/common/types';
import { EnvironmentVariablesProvider } from '../../../client/common/variables/environmentVariablesProvider';

suite('Process service shutdown ownership', () => {
    let registry: IDisposableRegistry;
    let factory: ProcessServiceFactory;
    const children = new Set<ObservableExecutionResult<string>>();

    setup(() => {
        registry = [];
        const environment = mock(EnvironmentVariablesProvider);
        when(environment.getEnvironmentVariables(undefined)).thenResolve({});
        const logger = mock(ProcessLogger);
        factory = new ProcessServiceFactory(instance(environment), instance(logger), registry);
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

    test('factories share one shutdown owner across idle services', async () => {
        await factory.create();
        await factory.create();
        await factory.create();
        assert.strictEqual(registry.length, 1);
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

    test('one completed process does not release another active process on the same service', async () => {
        const service = await factory.create();
        const proc = await live(service.execObservable(process.execPath, waitingArgs));
        await service.exec(process.execPath, ['-e', '']);
        const closed = once(proc, 'close');
        registry.forEach((item) => item.dispose());
        await closed;
    });
});
