// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import childProcess from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as sinon from 'sinon';
import * as rpc from 'vscode-jsonrpc/node';
import * as windowApis from '../../client/common/vscodeApis/windowApis';
import { createDeferred } from '../../client/common/utils/async';
import { createPythonServer, ExecutionResult, PythonServer } from '../../client/repl/pythonServer';

suite('Native REPL Python server lifetime', () => {
    const createRealConnection = rpc.createMessageConnection;
    let clock: sinon.SinonFakeTimers;
    let children: ReturnType<typeof createChild>[];
    let sendNotification: sinon.SinonStub;
    let sendRequest: sinon.SinonStub;
    let disposeConnection: sinon.SinonStub;
    let createConnection: sinon.SinonStub;
    let onRequest: sinon.SinonStub;
    let servers: PythonServer[];

    function createChild() {
        return Object.assign(new EventEmitter(), {
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            kill: sinon.stub().returns(true),
        });
    }

    function startServer(): PythonServer {
        const server = createPythonServer(['/python']);
        servers.push(server);
        return server;
    }

    setup(() => {
        clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        children = [];
        servers = [];
        sinon.stub(childProcess, 'spawn').callsFake(() => {
            const child = createChild();
            children.push(child);
            return (child as unknown) as childProcess.ChildProcess;
        });
        sendNotification = sinon.stub().resolves();
        sendRequest = sinon.stub();
        disposeConnection = sinon.stub();
        onRequest = sinon.stub().returns({ dispose: () => undefined });
        createConnection = sinon.stub(rpc, 'createMessageConnection').returns(({
            listen: () => undefined,
            onNotification: () => ({ dispose: () => undefined }),
            onRequest,
            sendNotification,
            sendRequest,
            dispose: disposeConnection,
        } as unknown) as rpc.MessageConnection);
    });

    teardown(() => {
        try {
            servers.forEach((server) => server.dispose());
        } finally {
            clock.restore();
            sinon.restore();
        }
    });

    test('a graceful exit cancels the forced shutdown', () => {
        const server = startServer();
        server.dispose();

        sinon.assert.calledOnceWithExactly(sendNotification, 'exit');
        children[0].emit('exit', 0, null);
        clock.runAll();

        sinon.assert.notCalled(children[0].kill);
        sinon.assert.calledOnce(disposeConnection);
    });

    test('a child that does not exit is terminated and a late response cannot notify old listeners', async () => {
        const server = startServer();
        const result = createDeferred<ExecutionResult>();
        sendRequest.returns(result.promise);
        const listener = sinon.spy();
        server.onCodeExecuted(listener);
        const running = server.execute('wait()');
        sinon.assert.calledOnceWithExactly(sendRequest, 'execute', 'wait()');

        server.dispose();
        const replacement = startServer();
        assert.notStrictEqual(replacement, server);
        clock.runAll();
        result.resolve({ status: true, output: '' });
        await running;
        children[0].emit('exit', null, 'SIGKILL');

        sinon.assert.calledOnceWithExactly(children[0].kill, 'SIGKILL');
        sinon.assert.notCalled(children[1].kill);
        sinon.assert.notCalled(listener);
        assert.strictEqual(replacement.isDisposed, false);
    });

    test('a closed transport still releases the server and preserves the forced shutdown', () => {
        const server = startServer();
        sendNotification.throws(new Error('Connection closed'));
        server.dispose();

        assert.strictEqual(server.isDisposed, true);
        sinon.assert.calledOnce(disposeConnection);
        clock.runAll();
        sinon.assert.calledOnceWithExactly(children[0].kill, 'SIGKILL');
        assert.notStrictEqual(startServer(), server);
    });

    test('a truncated JSON-RPC reply leaves no partial-message timer after shutdown', () => {
        createConnection.callsFake(createRealConnection);
        const server = startServer();
        children[0].stdout.write('Content-Length: 64\r\n\r\n{"jsonrpc":');
        server.dispose();
        children[0].emit('exit', null, 'SIGKILL');

        assert.strictEqual(clock.countTimers(), 0);
    });

    test('shutdown cancels only prompts belonging to the closed server', async () => {
        const oldPrompt = createDeferred<string | undefined>();
        const newPrompt = createDeferred<string | undefined>();
        const showInput = sinon.stub(windowApis, 'showInputBox');
        showInput.onFirstCall().callsFake((_options, token) => {
            token?.onCancellationRequested(() => oldPrompt.resolve(undefined));
            return oldPrompt.promise;
        });
        showInput.onSecondCall().callsFake((_options, token) => {
            token?.onCancellationRequested(() => newPrompt.resolve(undefined));
            return newPrompt.promise;
        });

        const server = startServer();
        const oldInput = onRequest.firstCall.args[1]({ prompt: 'old' });
        server.dispose();
        const replacement = startServer();
        const newInput = onRequest.secondCall.args[1]({ prompt: 'new' });
        assert.strictEqual(showInput.firstCall.args[1]?.isCancellationRequested, true);
        assert.notStrictEqual(showInput.secondCall.args[1]?.isCancellationRequested, true);
        assert.deepStrictEqual(await oldInput, { userInput: undefined });
        newPrompt.resolve('still working');
        assert.deepStrictEqual(await newInput, { userInput: 'still working' });
        replacement.dispose();
    });

    test('the idle event fires after unsuccessful execution and the final pending request', async () => {
        const execution = createDeferred<ExecutionResult>();
        const validation = createDeferred<ExecutionResult>();
        sendRequest.withArgs('execute').returns(execution.promise);
        sendRequest.withArgs('check_valid_command').returns(validation.promise);
        const server = startServer();
        const idle = sinon.spy();
        server.onDidBecomeIdle(idle);
        const running = server.execute('invalid()');
        const checking = server.checkValidCommand('incomplete(');

        execution.resolve({ status: false, output: '' });
        await running;
        assert.strictEqual(server.isExecuting, true);
        sinon.assert.notCalled(idle);
        validation.resolve({ status: true, output: 'False' });
        assert.strictEqual(await checking, false);
        assert.strictEqual(server.isExecuting, false);
        sinon.assert.calledOnce(idle);
    });
});
