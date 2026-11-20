// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as TypeMoq from 'typemoq';
import {
    commands,
    Disposable,
    EventEmitter,
    NotebookController,
    NotebookDocument,
    NotebookEditor,
    QuickPickItem,
    TextDocument,
    TextEditor,
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
import * as nativeReplModule from '../../client/repl/nativeRepl';
import {
    getNativeRepl,
    NativeRepl,
    NativeReplSession,
    NATIVE_REPL_URI_MEMENTO,
    registerNativeRepl,
} from '../../client/repl/nativeRepl';
import * as pythonServer from '../../client/repl/pythonServer';
import * as commandHandler from '../../client/repl/replCommandHandler';
import * as controllerFactory from '../../client/repl/replController';
import * as commandApis from '../../client/common/vscodeApis/commandApis';
import { disposeAll } from '../../client/common/utils/resourceLifecycle';
import { Commands } from '../../client/common/constants';
import { ICommandManager } from '../../client/common/application/types';
import { IInterpreterService } from '../../client/interpreter/contracts';
import { registerReplExecuteOnEnter, registerStartNativeReplCommand } from '../../client/repl/replCommands';
import * as replUtils from '../../client/repl/replUtils';

suite('Native REPL lifetime', () => {
    const interpreter: PythonEnvironment = {
        path: '/python',
        architecture: Architecture.x64,
        sysPrefix: '/python',
        envType: EnvironmentType.Venv,
    };
    let registry: Disposable[];
    let session: NativeReplSession;
    let notebook: NotebookDocument;
    let notebookClosed: boolean;
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
    let serverIdleEvents: EventEmitter<void>[];
    let busyServers: Set<pythonServer.PythonServer>;
    let createServer: sinon.SinonStub;
    let validateCode: sinon.SinonStub;
    let closedText: EventEmitter<TextDocument>;
    let activeTextChanged: EventEmitter<TextEditor | undefined>;
    let createRepl: sinon.SinonSpy;
    let workspaceFolders: sinon.SinonStub;

    async function closeNotebook(document: NotebookDocument = notebook): Promise<void> {
        closed.fire(document);
        await Promise.all(closeWork.splice(0));
    }

    function createNotebookEditor(name: string, isClosed: () => boolean = () => false): NotebookEditor {
        const document = TypeMoq.Mock.ofType<NotebookDocument>();
        document.setup((d) => d.uri).returns(() => Uri.parse(`vscode-interactive:/${name}`));
        document.setup((d) => d.isClosed).returns(isClosed);
        return { notebook: document.object, replOptions: { appendIndex: 0 } } as NotebookEditor;
    }

    function mockReplInput(title = 'Python REPL') {
        const editor = TypeMoq.Mock.ofType<TextEditor>();
        const document = TypeMoq.Mock.ofType<TextDocument>();
        document.setup((d) => d.getText()).returns(() => 'print(1)');
        document.setup((d) => d.isClosed).returns(() => false);
        document.setup((d) => d.lineCount).returns(() => 1);
        document.setup((d) => d.version).returns(() => 1);
        editor.setup((e) => e.document).returns(() => document.object);
        sinon.stub(windowApis, 'getActiveNotebookEditor').returns(notebookEditor);
        sinon.stub(replUtils, 'getTabNameForUri').returns(title);
        return sinon.stub(windowApis, 'getActiveTextEditor').returns(editor.object);
    }

    async function registerNativeEnter(
        lookup: () => Promise<PythonEnvironment>,
        command: string = Commands.Exec_In_REPL_Enter,
    ) {
        const interpreterService = TypeMoq.Mock.ofType<IInterpreterService>();
        interpreterService.setup((value) => value.getActiveInterpreter(TypeMoq.It.isAny())).returns(lookup);
        const registerCommand = sinon.stub().returns({ dispose: () => undefined });
        const commandManager = ({ registerCommand } as unknown) as ICommandManager;
        await registerReplExecuteOnEnter(registry, session, interpreterService.object, commandManager);
        return registerCommand.withArgs(command).firstCall.args[1];
    }

    setup(() => {
        registry = [];
        session = registerNativeRepl(registry);
        closed = new EventEmitter<NotebookDocument>();
        closedText = new EventEmitter<TextDocument>();
        activeTextChanged = new EventEmitter<TextEditor | undefined>();
        sinon.stub(workspaceApis, 'onDidCloseTextDocument').callsFake(closedText.event);
        sinon.stub(windowApis, 'onDidChangeActiveTextEditor').callsFake(activeTextChanged.event);
        closeWork = [];
        listenerDisposals = [];
        serverDisposals = [];
        controllerDisposals = [];
        serverIdleEvents = [];
        busyServers = new Set();
        notebookClosed = false;
        notebookEditor = createNotebookEditor('memory-lifetime', () => notebookClosed);
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
        validateCode = sinon.stub().resolves(true);
        createServer = sinon.stub(pythonServer, 'createPythonServer').callsFake(() => {
            const executed = new EventEmitter<void>();
            const idle = new EventEmitter<void>();
            serverIdleEvents.push(idle);
            const dispose = sinon.stub().callsFake(() => {
                executed.dispose();
                idle.dispose();
            });
            const server: pythonServer.PythonServer = {
                onCodeExecuted: executed.event,
                onDidBecomeIdle: idle.event,
                get isExecuting() {
                    return busyServers.has(this);
                },
                runWhileBusy: (run) => run(),
                isDisposed: false,
                execute: async () => ({ status: true, output: '' }),
                executeSilently: async () => ({ status: true, output: '' }),
                checkValidCommand: validateCode,
                interrupt: () => undefined,
                input: () => undefined,
                dispose,
            };
            serverDisposals.push(dispose);
            return server;
        });
        sinon.stub(controllerFactory, 'createReplController').callsFake(() => {
            const controller = TypeMoq.Mock.ofType<NotebookController>();
            const dispose = sinon.spy();
            controller.setup((c) => c.id).returns(() => 'pythonREPL');
            controller.setup((c) => c.dispose()).callback(dispose);
            controllerDisposals.push(dispose);
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
                closedText.dispose();
                activeTextChanged.dispose();
                sinon.restore();
            }
        }
    });

    test('closing the notebook releases its session without starting another server', async () => {
        const repl = await getNativeRepl(interpreter, session);
        await repl.sendToNativeRepl();
        await closeNotebook();
        assert.strictEqual(createServer.callCount, 1);
        assert.strictEqual(serverDisposals[0].callCount, 1);
        assert.strictEqual(controllerDisposals[0].callCount, 1);
        assert.strictEqual(listenerDisposals[0].callCount, 1);
    });

    test('closing and reopening keeps one registration and shutdown releases the live replacement', async () => {
        const first = await getNativeRepl(interpreter, session);
        await first.sendToNativeRepl('first');
        await closeNotebook();

        const replacementEditor = createNotebookEditor('replacement');
        openNotebook.resolves({ notebookEditor: replacementEditor, documentCreated: true });
        const replacement = await getNativeRepl(interpreter, session);
        assert.notStrictEqual(first, replacement);
        await replacement.sendToNativeRepl('second');
        assert.deepStrictEqual(
            executeCell.args.map((args) => args.slice(0, 2)),
            [
                [notebookEditor, 'first'],
                [replacementEditor, 'second'],
            ],
        );
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
        await assert.rejects(getNativeRepl(interpreter, session), /disposed/);
    });

    test('simultaneous commands share the same pending session creation', async () => {
        const [first, second] = await Promise.all([
            getNativeRepl(interpreter, session),
            getNativeRepl(interpreter, session),
        ]);
        assert.strictEqual(first, second);
        assert.strictEqual(createRepl.callCount, 1);
    });

    test('the registered Start command cannot create a REPL after its activation shuts down', async () => {
        const lookup = createDeferred<PythonEnvironment>();
        const started = createDeferred();
        const finishShutdown = createDeferred();
        const service = TypeMoq.Mock.ofType<IInterpreterService>();
        service
            .setup((value) => value.getActiveInterpreter(TypeMoq.It.isAny()))
            .returns(() => {
                started.resolve();
                return lookup.promise;
            });
        const register = sinon.stub(commandApis, 'registerCommand').returns({ dispose: () => undefined });
        await registerStartNativeReplCommand(registry, session, service.object);
        const oldStart = register.lastCall.args[1];
        const start = oldStart(Uri.file('/workspace/source.py'));
        await started.promise;

        registry.push({ dispose: () => finishShutdown.promise });
        const shutdown = disposeAll(registry);
        try {
            lookup.resolve(interpreter);
            await start;
            sinon.assert.notCalled(createServer);
        } finally {
            finishShutdown.resolve();
            await shutdown;
        }
        registry.length = 0;
        session = registerNativeRepl(registry);
        await registerStartNativeReplCommand(registry, session, service.object);
        await oldStart(Uri.file('/workspace/source.py'));
        sinon.assert.notCalled(createServer);
        await register.lastCall.args[1](Uri.file('/workspace/source.py'));
        sinon.assert.calledOnce(createServer);
    });

    test('an unusable first open releases the unbound session', async () => {
        const repl = await getNativeRepl(interpreter, session);
        const opening = createDeferred<{ notebookEditor: NotebookEditor; documentCreated: boolean } | undefined>();
        const started = createDeferred();
        openNotebook.callsFake(() => {
            started.resolve();
            return opening.promise;
        });
        const send = repl.sendToNativeRepl();
        await started.promise;
        await closeNotebook();
        opening.resolve(undefined);
        await send;

        sinon.assert.calledOnce(serverDisposals[0]);
        sinon.assert.calledOnce(controllerDisposals[0]);
        sinon.assert.calledOnce(listenerDisposals[0]);
        assert.notStrictEqual(await getNativeRepl(interpreter, session), repl);
    });

    test('a queued send can recover after a failed first open', async () => {
        const repl = await getNativeRepl(interpreter, session);
        const opening = createDeferred<never>();
        const started = createDeferred();
        openNotebook.onFirstCall().callsFake(() => {
            started.resolve();
            return opening.promise;
        });
        const first = assert.rejects(repl.sendToNativeRepl(), /editor closed/);
        await started.promise;
        const second = repl.sendToNativeRepl('deliver');
        opening.reject(new Error('editor closed'));
        await Promise.all([first, second]);

        sinon.assert.calledOnceWithExactly(executeCell, notebookEditor, 'deliver', sinon.match.func);
        sinon.assert.notCalled(serverDisposals[0]);
        await closeNotebook();
        sinon.assert.calledOnce(serverDisposals[0]);
    });

    test('Enter associates a restored Native REPL notebook so closing it releases the owner', async () => {
        mockReplInput();
        const execute = sinon.stub(commands, 'executeCommand').resolves();
        const enter = await registerNativeEnter(() => Promise.resolve(interpreter));
        await enter(notebook.uri);
        const owner = await getNativeRepl(interpreter, session);
        sinon.assert.notCalled(openNotebook);
        sinon.assert.calledOnce(createServer);
        sinon.assert.calledOnceWithExactly(execute, 'repl.execute', notebook.uri);

        await closeNotebook();
        sinon.assert.calledOnce(serverDisposals[0]);
        sinon.assert.calledOnce(controllerDisposals[0]);
        assert.notStrictEqual(await getNativeRepl(interpreter, session), owner);
    });

    test('Enter does not acquire a session or edit another editor after its input loses focus', async () => {
        const activeEditor = mockReplInput();
        const insertLine = sinon.stub(replUtils, 'insertNewLineToREPLInput');
        const lookingUp = createDeferred();
        const lookup = createDeferred<PythonEnvironment>();
        const enter = await registerNativeEnter(() => {
            lookingUp.resolve();
            return lookup.promise;
        });
        const oldEnter = enter(notebook.uri);
        await lookingUp.promise;
        activeEditor.returns(TypeMoq.Mock.ofType<TextEditor>().object);
        lookup.resolve(interpreter);
        await oldEnter;

        sinon.assert.notCalled(createServer);
        sinon.assert.notCalled(insertLine);
    });

    test('Enter does not execute code after focus changes during validation', async () => {
        const activeEditor = mockReplInput();
        const execute = sinon.stub(commands, 'executeCommand').resolves();
        const insertLine = sinon.stub(replUtils, 'insertNewLineToREPLInput');
        const validating = createDeferred();
        const validation = createDeferred<boolean>();
        validateCode.callsFake(() => {
            validating.resolve();
            return validation.promise;
        });
        const enter = await registerNativeEnter(() => Promise.resolve(interpreter));
        const pending = enter(notebook.uri);
        await validating.promise;
        activeEditor.returns(TypeMoq.Mock.ofType<TextEditor>().object);
        validation.resolve(true);
        await pending;

        sinon.assert.notCalled(execute);
        sinon.assert.notCalled(insertLine);
    });

    test('Enter delegates another REPL to the workbench without creating a Python owner', async () => {
        mockReplInput('Other REPL');
        const execute = sinon.stub(commands, 'executeCommand').resolves();
        const lookup = sinon.stub().resolves(interpreter);
        const enter = await registerNativeEnter(lookup);
        await enter(notebook.uri);

        sinon.assert.calledOnceWithExactly(execute, 'repl.execute', notebook.uri);
        sinon.assert.notCalled(lookup);
        sinon.assert.notCalled(createServer);
    });

    test('Interactive Window releases its syntax checker before workbench execution finishes', async () => {
        mockReplInput();
        const started = createDeferred();
        const execution = createDeferred();
        const execute = sinon.stub(commands, 'executeCommand').callsFake(() => {
            started.resolve();
            return execution.promise;
        });
        const enter = await registerNativeEnter(() => Promise.resolve(interpreter), Commands.Exec_In_IW_Enter);
        const pending = enter(notebook.uri);
        await started.promise;

        try {
            sinon.assert.calledOnceWithExactly(execute, 'interactive.execute');
            sinon.assert.calledOnceWithExactly(validateCode, 'print(1)');
            sinon.assert.calledOnce(serverDisposals[0]);
            assert.strictEqual(controllerDisposals.length, 0);
            assert.strictEqual(listenerDisposals.length, 0);
            assert.strictEqual(session.current, undefined);
        } finally {
            execution.resolve();
            await pending;
        }
    });

    test('closing Interactive Window input releases a checker with a held syntax reply', async () => {
        const editor = mockReplInput()();
        const execute = sinon.stub(commands, 'executeCommand').resolves();
        const validation = createDeferred<boolean>();
        const started = createDeferred();
        validateCode.callsFake(() => {
            started.resolve();
            return validation.promise;
        });
        const enter = await registerNativeEnter(() => Promise.resolve(interpreter), Commands.Exec_In_IW_Enter);
        const pending = enter(notebook.uri);
        await started.promise;
        serverDisposals[0].callsFake(() => validation.reject(new Error('closed transport')));

        closedText.fire(editor!.document);
        sinon.assert.calledOnce(serverDisposals[0]);
        await pending;
        sinon.assert.notCalled(execute);
    });

    test('another Interactive Window Enter supersedes a pending checker, and shutdown releases its replacement', async () => {
        mockReplInput();
        const execute = sinon.stub(commands, 'executeCommand').resolves();
        const firstStarted = createDeferred();
        const secondStarted = createDeferred();
        const firstReply = createDeferred<boolean>();
        const secondReply = createDeferred<boolean>();
        validateCode.onFirstCall().callsFake(() => {
            firstStarted.resolve();
            return firstReply.promise;
        });
        validateCode.onSecondCall().callsFake(() => {
            secondStarted.resolve();
            return secondReply.promise;
        });
        const enter = await registerNativeEnter(() => Promise.resolve(interpreter), Commands.Exec_In_IW_Enter);
        const first = enter(notebook.uri);
        await firstStarted.promise;
        serverDisposals[0].callsFake(() => firstReply.reject(new Error('superseded')));
        const second = enter(notebook.uri);
        await secondStarted.promise;
        serverDisposals[1].callsFake(() => secondReply.reject(new Error('shutdown')));
        await first;
        sinon.assert.calledOnce(serverDisposals[0]);
        sinon.assert.notCalled(serverDisposals[1]);

        await disposeAll(registry);
        sinon.assert.calledOnce(serverDisposals[1]);
        await second;
        sinon.assert.notCalled(execute);
    });

    test('a closed restored notebook does not discard Start already waiting for the same owner', async () => {
        mockReplInput();
        workspaceFolders.returns([
            { uri: Uri.file('/one'), name: 'one', index: 0 },
            { uri: Uri.file('/two'), name: 'two', index: 1 },
        ]);
        const selecting = createDeferred();
        const selection = createDeferred<QuickPickItem>();
        sinon.stub(windowApis, 'showQuickPick').callsFake(() => {
            selecting.resolve();
            return selection.promise;
        });
        const waitingForBoth = createDeferred();
        const useNativeRepl = nativeReplModule.withNativeRepl;
        sinon.stub(nativeReplModule, 'withNativeRepl').callsFake((...args) => {
            const result = useNativeRepl(...args);
            if (session.activeCommands === 2) {
                waitingForBoth.resolve();
            }
            return result;
        });
        const interpreterService = TypeMoq.Mock.ofType<IInterpreterService>();
        interpreterService
            .setup((value) => value.getActiveInterpreter(TypeMoq.It.isAny()))
            .returns(() => Promise.resolve(interpreter));
        const registerStart = sinon.stub(commandApis, 'registerCommand').returns({ dispose: () => undefined });
        await registerStartNativeReplCommand(registry, session, interpreterService.object);
        const enter = await registerNativeEnter(() => Promise.resolve(interpreter));
        const endingEnter = enter(notebook.uri);
        await selecting.promise;
        const start = registerStart.firstCall.args[1](Uri.file('/one/source.py'));
        await waitingForBoth.promise;

        notebookClosed = true;
        await closeNotebook();
        const replacement = createNotebookEditor('replacement');
        openNotebook.resolves({ notebookEditor: replacement, documentCreated: true });
        selection.resolve({ label: 'one', description: '/one' });
        await Promise.all([endingEnter, start]);

        sinon.assert.calledOnce(createServer);
        sinon.assert.calledOnceWithExactly(selectKernel, replacement, 'pythonREPL', 'ms-python.python');
        sinon.assert.notCalled(serverDisposals[0]);
    });

    test('overlapping sends open one notebook and run each submission after kernel selection', async () => {
        const repl = await getNativeRepl(interpreter, session);
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

        assert.deepStrictEqual(
            openNotebook.args.map((args) => args.slice(0, 2)),
            [
                [undefined, false],
                [notebook, true],
            ],
        );
        sinon.assert.calledOnce(selectKernel);
        sinon.assert.callOrder(selectKernel, executeCell);
        assert.deepStrictEqual(
            executeCell.args.map((args) => args.slice(0, 2)),
            [
                [notebookEditor, 'first'],
                [notebookEditor, 'second'],
            ],
        );
    });

    test('closing during a memento save skips the old send and orders the replacement save after the clear', async () => {
        const saving = createDeferred();
        const savingStarted = createDeferred();
        updateMemento.withArgs(NATIVE_REPL_URI_MEMENTO, notebook.uri.toString()).callsFake(() => {
            savingStarted.resolve();
            return saving.promise;
        });
        openNotebook.resolves({ notebookEditor, documentCreated: true });
        const first = await getNativeRepl(interpreter, session);
        const oldSend = first.sendToNativeRepl('closed');
        await savingStarted.promise;
        const closing = closeNotebook();

        const replacementEditor = createNotebookEditor('replacement');
        openNotebook.resolves({ notebookEditor: replacementEditor, documentCreated: true });
        const replacement = await getNativeRepl(interpreter, session);
        const newSend = replacement.sendToNativeRepl('live');
        saving.resolve();
        await Promise.all([oldSend, closing, newSend]);

        assert.deepStrictEqual(
            updateMemento.args.map(([, uri]) => uri),
            [undefined, notebook.uri.toString(), undefined, undefined, replacementEditor.notebook.uri.toString()],
        );
        sinon.assert.calledOnceWithExactly(selectKernel, replacementEditor, 'pythonREPL', 'ms-python.python');
        sinon.assert.calledOnceWithExactly(executeCell, replacementEditor, 'live', sinon.match.func);
    });

    test('closing during kernel selection skips execution', async () => {
        const selecting = createDeferred();
        const selectionStarted = createDeferred();
        selectKernel.callsFake(() => {
            selectionStarted.resolve();
            return selecting.promise;
        });
        openNotebook.resolves({ notebookEditor, documentCreated: true });
        const repl = await getNativeRepl(interpreter, session);
        const sending = repl.sendToNativeRepl('closed');
        await selectionStarted.promise;
        await closeNotebook();
        selecting.resolve();
        await sending;

        sinon.assert.notCalled(executeCell);
    });

    test('the production submission guard invalidates an old edit while its document stays open', async () => {
        const editing = createDeferred();
        const edit = createDeferred();
        executeCell.callsFake(async (_editor, _code, isCurrentOwner) => {
            assert.strictEqual(isCurrentOwner(), true);
            editing.resolve();
            await edit.promise;
            assert.strictEqual(isCurrentOwner(), false);
        });
        const repl = await getNativeRepl(interpreter, session);
        const send = repl.sendToNativeRepl('old owner');
        await editing.promise;
        await disposeAll(registry);
        assert.strictEqual(notebook.isClosed, false);
        edit.resolve();
        await send;
    });

    test('a throwing server disposer still releases the controller and allows a new session', async () => {
        const first = await getNativeRepl(interpreter, session);
        await first.sendToNativeRepl();
        serverDisposals[0].throws('closed transport');
        await closeNotebook();

        sinon.assert.calledOnce(controllerDisposals[0]);
        sinon.assert.calledOnce(listenerDisposals[0]);
        assert.deepStrictEqual(updateMemento.lastCall.args, [NATIVE_REPL_URI_MEMENTO, undefined]);
        const replacement = await getNativeRepl(interpreter, session);
        assert.notStrictEqual(first, replacement);
        assert.strictEqual(createServer.callCount, 2);
    });

    test('notebook closure and extension shutdown dispose each resource once', async () => {
        const repl = await getNativeRepl(interpreter, session);
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

    test('extension shutdown cancels a pending directory selection', async () => {
        const selection = createDeferred<QuickPickItem | undefined>();
        workspaceFolders.returns([
            { uri: Uri.file('/one'), name: 'one', index: 0 },
            { uri: Uri.file('/two'), name: 'two', index: 1 },
        ]);
        const picker = sinon.stub(windowApis, 'showQuickPick').callsFake((_items, _options, token) => {
            const subscription = token?.onCancellationRequested(() => selection.resolve(undefined));
            return selection.promise.finally(() => subscription?.dispose());
        });
        const pending = getNativeRepl(interpreter, session);
        registry.forEach((disposable) => disposable.dispose());
        assert.ok(picker.firstCall.args[2]?.isCancellationRequested);
        assert.ok(selection.resolved);
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
        const pending = getNativeRepl(interpreter, session);
        registry.forEach((disposable) => disposable.dispose());
        await assert.rejects(getNativeRepl(interpreter, session), /disposed/);
        registry.length = 0;
        session = registerNativeRepl(registry);
        workspaceFolders.returns([]);
        const replacement = await getNativeRepl(interpreter, session);
        await replacement.sendToNativeRepl();
        selection.resolve({ label: 'one', description: '/one' });
        await assert.rejects(pending, /disposed/);

        sinon.assert.calledOnce(createServer);
        sinon.assert.notCalled(serverDisposals[0]);
        assert.strictEqual(listenerDisposals.length, 1);
        sinon.assert.notCalled(listenerDisposals[0]);
        assert.strictEqual(await getNativeRepl(interpreter, session), replacement);
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
            const repl = await getNativeRepl(interpreter, session);
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

    test('interpreter changes wait for work started during lookup and use the replacement idle event', async () => {
        const changeEvents = new EventEmitter<DidChangeEnvironmentEventArgs>();
        useEnvExtension.returns(true);
        sinon.stub(envApi, 'onDidChangeEnvironmentEnvExt').callsFake(changeEvents.event);
        const lookup = createDeferred<PythonEnvironment | undefined>();
        const second = { ...interpreter, path: '/another/python' };
        const third = { ...interpreter, path: '/third/python' };
        const resolveInterpreter = sinon.stub(legacyEnvApi, 'getActiveInterpreterLegacy');
        resolveInterpreter.onFirstCall().returns(lookup.promise);
        resolveInterpreter.onSecondCall().resolves(second);
        resolveInterpreter.onThirdCall().resolves(third);
        const selectedSecond = createDeferred();
        const selectedThird = createDeferred();
        selectKernel.onFirstCall().callsFake(() => {
            selectedSecond.resolve();
            return Promise.resolve();
        });
        selectKernel.onSecondCall().callsFake(() => {
            selectedThird.resolve();
            return Promise.resolve();
        });

        try {
            const repl = await getNativeRepl(interpreter, session);
            await repl.sendToNativeRepl();
            const change = { uri: undefined, old: undefined, new: undefined };
            changeEvents.fire(change);
            sinon.assert.calledOnce(resolveInterpreter);
            const initialServer: pythonServer.PythonServer = createServer.firstCall.returnValue;
            busyServers.add(initialServer);
            lookup.resolve(second);
            await lookup.promise;
            sinon.assert.notCalled(serverDisposals[0]);

            busyServers.delete(initialServer);
            serverIdleEvents[0].fire();
            await selectedSecond.promise;
            sinon.assert.calledOnce(serverDisposals[0]);
            sinon.assert.calledOnce(controllerDisposals[0]);

            const secondServer: pythonServer.PythonServer = createServer.secondCall.returnValue;
            busyServers.add(secondServer);
            changeEvents.fire(change);
            sinon.assert.calledTwice(resolveInterpreter);
            busyServers.delete(secondServer);
            serverIdleEvents[1].fire();
            await selectedThird.promise;
            sinon.assert.calledOnce(serverDisposals[1]);
            sinon.assert.calledOnce(controllerDisposals[1]);
            assert.deepStrictEqual(
                createServer.args.map(([args]) => args),
                [[interpreter.path], [second.path], [third.path]],
            );
            await closeNotebook();
            [...serverDisposals, ...controllerDisposals].forEach((disposal) => sinon.assert.calledOnce(disposal));
        } finally {
            lookup.resolve(undefined);
            changeEvents.dispose();
        }
    });

    test('closing another notebook preserves the active session', async () => {
        const repl = await getNativeRepl(interpreter, session);
        await repl.sendToNativeRepl();
        const other = TypeMoq.Mock.ofType<NotebookDocument>();
        other.setup((d) => d.uri).returns(() => Uri.parse('vscode-interactive:/other'));
        await closeNotebook(other.object);
        assert.strictEqual(serverDisposals[0].callCount, 0);
        assert.strictEqual(await getNativeRepl(interpreter, session), repl);
    });
});
