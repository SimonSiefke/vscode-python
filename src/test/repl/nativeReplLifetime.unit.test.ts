// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as TypeMoq from 'typemoq';
import {
    Disposable,
    EventEmitter,
    NotebookController,
    NotebookDocument,
    NotebookEditor,
    QuickPickItem,
    Uri,
} from 'vscode';
import { Architecture } from '../../client/common/utils/platform';
import { createDeferred } from '../../client/common/utils/async';
import * as persistentState from '../../client/common/persistentState';
import * as windowApis from '../../client/common/vscodeApis/windowApis';
import * as workspaceApis from '../../client/common/vscodeApis/workspaceApis';
import * as envApi from '../../client/envExt/api.internal';
import { EnvironmentType, PythonEnvironment } from '../../client/pythonEnvironments/info';
import { getNativeRepl, NativeRepl } from '../../client/repl/nativeRepl';
import * as pythonServer from '../../client/repl/pythonServer';
import * as commandHandler from '../../client/repl/replCommandHandler';
import * as controllerFactory from '../../client/repl/replController';

suite('Native REPL lifetime', () => {
    const interpreter: PythonEnvironment = {
        path: '/python',
        architecture: Architecture.x64,
        sysPrefix: '/python',
        envType: EnvironmentType.Venv,
    };
    let registry: Disposable[];
    let notebook: NotebookDocument;
    let closed: EventEmitter<NotebookDocument>;
    let closeWork: Promise<void>[];
    let listenerDisposals: sinon.SinonSpy[];
    let serverDisposals: sinon.SinonSpy[];
    let controllerDisposals: sinon.SinonSpy[];
    let servers: pythonServer.PythonServer[];
    let createServer: sinon.SinonStub;
    let createRepl: sinon.SinonSpy;
    let workspaceFolders: sinon.SinonStub;

    async function closeNotebook(document: NotebookDocument = notebook): Promise<void> {
        closed.fire(document);
        await Promise.all(closeWork.splice(0));
    }

    setup(() => {
        registry = [];
        closed = new EventEmitter<NotebookDocument>();
        closeWork = [];
        listenerDisposals = [];
        serverDisposals = [];
        controllerDisposals = [];
        servers = [];
        const document = TypeMoq.Mock.ofType<NotebookDocument>();
        document.setup((d) => d.uri).returns(() => Uri.parse('vscode-interactive:/memory-lifetime'));
        notebook = document.object;
        const editor = TypeMoq.Mock.ofType<NotebookEditor>();
        editor.setup((e) => e.notebook).returns(() => notebook);
        workspaceFolders = sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([]);
        sinon.stub(workspaceApis, 'onDidCloseNotebookDocument').callsFake((handler) => {
            const subscription = closed.event((document) => closeWork.push(Promise.resolve(handler(document))));
            const dispose = sinon.spy(() => subscription.dispose());
            listenerDisposals.push(dispose);
            return { dispose };
        });
        sinon.stub(envApi, 'useEnvExtension').returns(false);
        sinon.stub(persistentState, 'getWorkspaceStateValue').returns(undefined);
        sinon.stub(persistentState, 'updateWorkspaceStateValue').resolves();
        sinon
            .stub(commandHandler, 'openInteractiveREPL')
            .resolves({ notebookEditor: editor.object, documentCreated: false });
        createServer = sinon.stub(pythonServer, 'createPythonServer').callsFake(() => {
            const executed = new EventEmitter<void>();
            const dispose = sinon.spy(() => executed.dispose());
            const server: pythonServer.PythonServer = {
                onCodeExecuted: executed.event,
                isExecuting: false,
                isDisposed: false,
                execute: async () => ({ status: true, output: '' }),
                executeSilently: async () => ({ status: true, output: '' }),
                checkValidCommand: async () => true,
                interrupt: () => undefined,
                input: () => undefined,
                dispose,
            };
            servers.push(server);
            serverDisposals.push(dispose);
            return server;
        });
        sinon.stub(controllerFactory, 'createReplController').callsFake((_path, disposables) => {
            const controller = TypeMoq.Mock.ofType<NotebookController>();
            const dispose = sinon.spy();
            controller.setup((c) => c.id).returns(() => 'pythonREPL');
            controller.setup((c) => c.dispose()).callback(dispose);
            controllerDisposals.push(dispose);
            // The real controller factory registers the same server a second time.
            disposables.push(servers[servers.length - 1], controller.object);
            return controller.object;
        });
        createRepl = sinon.spy(NativeRepl, 'create');
    });

    teardown(async () => {
        // Close every actual instance even when an ownership assertion fails on the baseline.
        const created = await Promise.allSettled<NativeRepl>(createRepl.returnValues);
        for (const result of created) {
            if (result.status === 'fulfilled') {
                await result.value.sendToNativeRepl();
            }
        }
        await closeNotebook();
        registry.forEach((disposable) => disposable.dispose());
        closed.dispose();
        sinon.restore();
    });

    test('closing the notebook releases its session without starting another server', async () => {
        const repl = await getNativeRepl(interpreter, registry);
        await repl.sendToNativeRepl();
        await closeNotebook();
        assert.strictEqual(createServer.callCount, 1);
        assert.strictEqual(serverDisposals[0].callCount, 1);
        assert.strictEqual(controllerDisposals[0].callCount, 1);
        assert.strictEqual(listenerDisposals[0].callCount, 1);
    });

    test('closed sessions do not accumulate extension shutdown registrations', async () => {
        const first = await getNativeRepl(interpreter, registry);
        await first.sendToNativeRepl();
        await closeNotebook();
        const second = await getNativeRepl(interpreter, registry);
        assert.notStrictEqual(first, second);
        await second.sendToNativeRepl();
        await closeNotebook();
        assert.strictEqual(registry.length, 1);
        assert.strictEqual(
            listenerDisposals.every((dispose) => dispose.calledOnce),
            true,
        );
    });

    test('simultaneous commands share the same pending session creation', async () => {
        const [first, second] = await Promise.all([
            getNativeRepl(interpreter, registry),
            getNativeRepl(interpreter, registry),
        ]);
        assert.strictEqual(first, second);
        assert.strictEqual(createRepl.callCount, 1);
    });

    test('notebook closure and extension shutdown dispose each resource once', async () => {
        const repl = await getNativeRepl(interpreter, registry);
        await repl.sendToNativeRepl();
        await closeNotebook();
        registry.forEach((disposable) => disposable.dispose());
        repl.dispose();
        assert.strictEqual(serverDisposals[0].callCount, 1);
        assert.strictEqual(controllerDisposals[0].callCount, 1);
        assert.strictEqual(listenerDisposals[0].callCount, 1);
    });

    test('failed initialization releases the notebook close subscription', async () => {
        const failure = new Error('server creation failed');
        createServer.throws(failure);
        await assert.rejects(NativeRepl.create(interpreter), (error) => error === failure);
        assert.strictEqual(listenerDisposals[0].callCount, 1);
    });

    test('extension shutdown disposes a session whose directory selection is pending', async () => {
        const selection = createDeferred<QuickPickItem | undefined>();
        workspaceFolders.returns([
            { uri: Uri.file('/one'), name: 'one', index: 0 },
            { uri: Uri.file('/two'), name: 'two', index: 1 },
        ]);
        sinon.stub(windowApis, 'showQuickPick').returns(selection.promise);
        const pending = getNativeRepl(interpreter, registry);
        registry.forEach((disposable) => disposable.dispose());
        selection.resolve({ label: 'one', description: '/one' });
        await assert.rejects(pending, /disposed/);
        assert.strictEqual(serverDisposals[0].callCount, 1);
        assert.strictEqual(controllerDisposals[0].callCount, 1);
        assert.strictEqual(listenerDisposals[0].callCount, 1);
    });

    test('closing another notebook preserves the active session', async () => {
        const repl = await getNativeRepl(interpreter, registry);
        await repl.sendToNativeRepl();
        const other = TypeMoq.Mock.ofType<NotebookDocument>();
        other.setup((d) => d.uri).returns(() => Uri.parse('vscode-interactive:/other'));
        await closeNotebook(other.object);
        assert.strictEqual(serverDisposals[0].callCount, 0);
        assert.strictEqual(await getNativeRepl(interpreter, registry), repl);
    });
});
