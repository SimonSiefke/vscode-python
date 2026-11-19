// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import childProcess from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as sinon from 'sinon';
import * as rpc from 'vscode-jsonrpc/node';
import { createDeferred } from '../../client/common/utils/async';
import { createPythonServer, ExecutionResult, PythonServer } from '../../client/repl/pythonServer';

suite('Native REPL Python server lifetime', () => {
    let clock: sinon.SinonFakeTimers;
    let children: ReturnType<typeof createChild>[];
    let sendNotification: sinon.SinonStub;
    let sendRequest: sinon.SinonStub;
    let disposeConnection: sinon.SinonStub;
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
        sinon.stub(rpc, 'createMessageConnection').returns(({
            listen: () => undefined,
            onNotification: () => ({ dispose: () => undefined }),
            onRequest: () => ({ dispose: () => undefined }),
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
        assert.strictEqual(startServer(), replacement);
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
});
