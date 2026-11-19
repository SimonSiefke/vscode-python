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
import * as legacyEnvApi from '../../client/envExt/api.legacy';
import { DidChangeEnvironmentEventArgs } from '../../client/envExt/types';
import { EnvironmentType, PythonEnvironment } from '../../client/pythonEnvironments/info';
import { getNativeRepl, NativeRepl, NATIVE_REPL_URI_MEMENTO } from '../../client/repl/nativeRepl';
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
    let notebookEditor: NotebookEditor;
    let openNotebook: sinon.SinonStub;
    let selectKernel: sinon.SinonStub;
    let executeCell: sinon.SinonStub;
    let updateMemento: sinon.SinonStub;
    let useEnvExtension: sinon.SinonStub;
    let closed: EventEmitter<NotebookDocument>;
    let closeWork: Promise<void>[];
    let listenerDisposals: sinon.SinonSpy[];
    let serverDisposals: sinon.SinonStub[];
    let controllerDisposals: sinon.SinonSpy[];
    let servers: pythonServer.PythonServer[];
    let createServer: sinon.SinonStub;
    let createRepl: sinon.SinonSpy;
    let workspaceFolders: sinon.SinonStub;

    async function closeNotebook(document: NotebookDocument = notebook): Promise<void> {
        closed.fire(document);
        await Promise.all(closeWork.splice(0));
    }

    function createNotebookEditor(name: string): NotebookEditor {
        const document = TypeMoq.Mock.ofType<NotebookDocument>();
        document.setup((d) => d.uri).returns(() => Uri.parse(`vscode-interactive:/${name}`));
        document.setup((d) => d.isClosed).returns(() => false);
        const editor = TypeMoq.Mock.ofType<NotebookEditor>();
        editor.setup((e) => e.notebook).returns(() => document.object);
        return editor.object;
    }

    setup(() => {
        registry = [];
        closed = new EventEmitter<NotebookDocument>();
        closeWork = [];
        listenerDisposals = [];
        serverDisposals = [];
        controllerDisposals = [];
        servers = [];
        notebookEditor = createNotebookEditor('memory-lifetime');
        notebook = notebookEditor.notebook;
        workspaceFolders = sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([]);
        sinon.stub(workspaceApis, 'onDidCloseNotebookDocument').callsFake((handler) => {
            const subscription = closed.event((document) => closeWork.push(Promise.resolve(handler(document))));
            const dispose = sinon.spy(() => subscription.dispose());
            listenerDisposals.push(dispose);
            return { dispose };
        });
        useEnvExtension = sinon.stub(envApi, 'useEnvExtension').returns(false);
        sinon.stub(persistentState, 'getWorkspaceStateValue').returns(undefined);
        updateMemento = sinon.stub(persistentState, 'updateWorkspaceStateValue').resolves();
        openNotebook = sinon
            .stub(commandHandler, 'openInteractiveREPL')
            .resolves({ notebookEditor, documentCreated: false });
        selectKernel = sinon.stub(commandHandler, 'selectNotebookKernel').resolves();
        executeCell = sinon.stub(commandHandler, 'executeNotebookCell').resolves();
        createServer = sinon.stub(pythonServer, 'createPythonServer').callsFake(() => {
            const executed = new EventEmitter<void>();
            const dispose = sinon.stub().callsFake(() => executed.dispose());
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
        try {
            await Promise.all(closeWork.splice(0));
        } finally {
            try {
                registry.forEach((disposable) => disposable.dispose());
            } finally {
                closed.dispose();
                sinon.restore();
            }
        }
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

    test('closing and reopening keeps one registration and shutdown releases the live replacement', async () => {
        const first = await getNativeRepl(interpreter, registry);
        await first.sendToNativeRepl('first');
        await closeNotebook();

        const replacementEditor = createNotebookEditor('replacement');
        openNotebook.resolves({ notebookEditor: replacementEditor, documentCreated: true });
        const replacement = await getNativeRepl(interpreter, registry);
        assert.notStrictEqual(first, replacement);
        await replacement.sendToNativeRepl('second');
        assert.deepStrictEqual(executeCell.args, [
            [notebookEditor, 'first'],
            [replacementEditor, 'second'],
        ]);
        sinon.assert.calledOnceWithExactly(selectKernel, replacementEditor, 'pythonREPL', 'ms-python.python');
        assert.strictEqual(registry.length, 1);
        sinon.assert.calledOnce(listenerDisposals[0]);
        sinon.assert.notCalled(listenerDisposals[1]);
        sinon.assert.notCalled(serverDisposals[1]);
        sinon.assert.notCalled(controllerDisposals[1]);

        registry.forEach((disposable) => disposable.dispose());
        [...listenerDisposals, ...serverDisposals, ...controllerDisposals].forEach((disposable) =>
            sinon.assert.calledOnce(disposable),
        );
        await assert.rejects(getNativeRepl(interpreter, registry), /disposed/);
    });

    test('simultaneous commands share the same pending session creation', async () => {
        const [first, second] = await Promise.all([
            getNativeRepl(interpreter, registry),
            getNativeRepl(interpreter, registry),
        ]);
        assert.strictEqual(first, second);
        assert.strictEqual(createRepl.callCount, 1);
    });

    test('overlapping sends open one notebook and run each submission after kernel selection', async () => {
        const repl = await getNativeRepl(interpreter, registry);
        const opening = createDeferred<{ notebookEditor: NotebookEditor; documentCreated: boolean }>();
        const openingStarted = createDeferred();
        // If the second send opens another untitled document, return a distinct notebook.
        openNotebook.withArgs(undefined).resolves({
            notebookEditor: createNotebookEditor('unexpected'),
            documentCreated: true,
        });
        openNotebook
            .withArgs(undefined)
            .onFirstCall()
            .callsFake(() => {
                openingStarted.resolve();
                return opening.promise;
            });

        const first = repl.sendToNativeRepl('first', false);
        await openingStarted.promise;
        const second = repl.sendToNativeRepl('second');
        opening.resolve({ notebookEditor, documentCreated: true });
        await Promise.all([first, second]);

        assert.deepStrictEqual(openNotebook.args, [
            [undefined, false],
            [notebook, true],
        ]);
        sinon.assert.calledOnce(selectKernel);
        sinon.assert.callOrder(selectKernel, executeCell);
        assert.deepStrictEqual(executeCell.args, [
            [notebookEditor, 'first'],
            [notebookEditor, 'second'],
        ]);
    });

    test('closing during a memento save skips the old send and orders the replacement save after the clear', async () => {
        const saving = createDeferred();
        const savingStarted = createDeferred();
        updateMemento.withArgs(NATIVE_REPL_URI_MEMENTO, notebook.uri.toString()).callsFake(() => {
            savingStarted.resolve();
            return saving.promise;
        });
        openNotebook.resolves({ notebookEditor, documentCreated: true });
        const first = await getNativeRepl(interpreter, registry);
        const oldSend = first.sendToNativeRepl('closed');
        await savingStarted.promise;
        const closing = closeNotebook();

        const replacementEditor = createNotebookEditor('replacement');
        openNotebook.resolves({ notebookEditor: replacementEditor, documentCreated: true });
        const replacement = await getNativeRepl(interpreter, registry);
        const newSend = replacement.sendToNativeRepl('live');
        saving.resolve();
        await Promise.all([oldSend, closing, newSend]);

        assert.deepStrictEqual(
            updateMemento.args.map(([, uri]) => uri),
            [undefined, notebook.uri.toString(), undefined, undefined, replacementEditor.notebook.uri.toString()],
        );
        sinon.assert.calledOnceWithExactly(selectKernel, replacementEditor, 'pythonREPL', 'ms-python.python');
        sinon.assert.calledOnceWithExactly(executeCell, replacementEditor, 'live');
    });

    test('closing during kernel selection skips execution', async () => {
        const selecting = createDeferred();
        const selectionStarted = createDeferred();
        selectKernel.callsFake(() => {
            selectionStarted.resolve();
            return selecting.promise;
        });
        openNotebook.resolves({ notebookEditor, documentCreated: true });
        const repl = await getNativeRepl(interpreter, registry);
        const sending = repl.sendToNativeRepl('closed');
        await selectionStarted.promise;
        await closeNotebook();
        selecting.resolve();
        await sending;

        sinon.assert.notCalled(executeCell);
    });

    test('a throwing server disposer still releases the controller and allows a new session', async () => {
        const first = await getNativeRepl(interpreter, registry);
        await first.sendToNativeRepl();
        serverDisposals[0].throws('closed transport');
        await closeNotebook();

        sinon.assert.calledOnce(controllerDisposals[0]);
        sinon.assert.calledOnce(listenerDisposals[0]);
        assert.deepStrictEqual(updateMemento.lastCall.args, [NATIVE_REPL_URI_MEMENTO, undefined]);
        const replacement = await getNativeRepl(interpreter, registry);
        assert.notStrictEqual(first, replacement);
        assert.strictEqual(createServer.callCount, 2);
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
        sinon.assert.notCalled(createServer);
        assert.strictEqual(controllerDisposals.length, 0);
        assert.strictEqual(listenerDisposals.length, 0);
    });

    test('reactivation can reuse the subscriptions array while an older directory selection completes', async () => {
        const selection = createDeferred<QuickPickItem | undefined>();
        workspaceFolders.returns([
            { uri: Uri.file('/one'), name: 'one', index: 0 },
            { uri: Uri.file('/two'), name: 'two', index: 1 },
        ]);
        sinon.stub(windowApis, 'showQuickPick').returns(selection.promise);
        const pending = getNativeRepl(interpreter, registry);
        registry.forEach((disposable) => disposable.dispose());
        await assert.rejects(getNativeRepl(interpreter, registry), /disposed/);
        registry.length = 0;
        workspaceFolders.returns([]);
        const replacement = await getNativeRepl(interpreter, registry);
        await replacement.sendToNativeRepl();
        selection.resolve({ label: 'one', description: '/one' });
        await assert.rejects(pending, /disposed/);

        sinon.assert.calledOnce(createServer);
        sinon.assert.notCalled(serverDisposals[0]);
        assert.strictEqual(listenerDisposals.length, 1);
        sinon.assert.notCalled(listenerDisposals[0]);
        assert.strictEqual(await getNativeRepl(interpreter, registry), replacement);
    });

    test('closing releases the environment subscription and ignores an interpreter lookup result that arrives late', async () => {
        const changeEvents = new EventEmitter<DidChangeEnvironmentEventArgs>();
        const subscribed = sinon.spy();
        const unsubscribed = sinon.spy();
        useEnvExtension.returns(true);
        sinon.stub(envApi, 'onDidChangeEnvironmentEnvExt').callsFake((listener) => {
            subscribed();
            const subscription = changeEvents.event(listener);
            return {
                dispose: () => {
                    unsubscribed();
                    subscription.dispose();
                },
            };
        });
        const lookup = createDeferred<PythonEnvironment | undefined>();
        const getInterpreter = sinon.stub(legacyEnvApi, 'getActiveInterpreterLegacy').returns(lookup.promise);
        try {
            const repl = await getNativeRepl(interpreter, registry);
            await repl.sendToNativeRepl();
            changeEvents.fire({ uri: undefined, old: undefined, new: undefined });
            sinon.assert.calledOnce(getInterpreter);
            await closeNotebook();
            lookup.resolve({ ...interpreter, path: '/another/python' });
            await lookup.promise;

            sinon.assert.calledOnce(subscribed);
            sinon.assert.calledOnce(unsubscribed);
            sinon.assert.calledOnce(createServer);
            changeEvents.fire({ uri: undefined, old: undefined, new: undefined });
            sinon.assert.calledOnce(getInterpreter);
        } finally {
            lookup.resolve(undefined);
            changeEvents.dispose();
        }
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
