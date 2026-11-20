// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/* eslint-disable no-unused-expressions */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as TypeMoq from 'typemoq';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { Disposable } from 'vscode';
import { expect } from 'chai';
import { createDeferred } from '../../client/common/utils/async';

import { IInterpreterService } from '../../client/interpreter/contracts';
import { PythonEnvironment } from '../../client/pythonEnvironments/info';
import * as NativeReplModule from '../../client/repl/nativeRepl';
import * as persistentState from '../../client/common/persistentState';
import * as PythonServer from '../../client/repl/pythonServer';
import * as replController from '../../client/repl/replController';
import * as replCommandHandler from '../../client/repl/replCommandHandler';
import * as workspaceApis from '../../client/common/vscodeApis/workspaceApis';
import * as commandApis from '../../client/common/vscodeApis/commandApis';

suite('REPL - Native REPL', () => {
    let interpreterService: TypeMoq.IMock<IInterpreterService>;

    let disposable: TypeMoq.IMock<Disposable>;
    let disposableArray: Disposable[] = [];
    let session: NativeReplModule.NativeReplSession;
    let setReplDirectoryStub: sinon.SinonStub;
    let getWorkspaceStateValueStub: sinon.SinonStub;
    let updateWorkspaceStateValueStub: sinon.SinonStub;
    let createReplControllerStub: sinon.SinonStub;
    let mockNotebookController: any;

    setup(() => {
        mockNotebookController = {
            id: 'mockController',
            dispose: sinon.stub(),
            updateNotebookAffinity: sinon.stub(),
            createNotebookCellExecution: sinon.stub(),
            variableProvider: null,
        };

        interpreterService = TypeMoq.Mock.ofType<IInterpreterService>();
        interpreterService
            .setup((i) => i.getActiveInterpreter(TypeMoq.It.isAny()))
            .returns(() => Promise.resolve(({ path: 'ps' } as unknown) as PythonEnvironment));
        disposable = TypeMoq.Mock.ofType<Disposable>();
        disposableArray = [disposable.object];
        session = NativeReplModule.registerNativeRepl(disposableArray);

        createReplControllerStub = sinon.stub(replController, 'createReplController').returns(mockNotebookController);
        sinon.stub(replCommandHandler, 'openInteractiveREPL').resolves(undefined);
        setReplDirectoryStub = sinon.stub(NativeReplModule.NativeRepl.prototype as any, 'setReplDirectory').resolves();
        sinon.stub(PythonServer, 'createPythonServer').callsFake(
            () =>
                (({
                    onCodeExecuted: () => ({ dispose: () => undefined }),
                    onDidBecomeIdle: () => ({ dispose: () => undefined }),
                    dispose: () => undefined,
                } as unknown) as PythonServer.PythonServer),
        );
        updateWorkspaceStateValueStub = sinon.stub(persistentState, 'updateWorkspaceStateValue').resolves();
    });

    teardown(() => {
        disposableArray.forEach((d) => {
            if (d) {
                d.dispose();
            }
        });
        disposableArray = [];
        sinon.restore();
    });

    test('getNativeRepl should call create constructor', async () => {
        const interpreter = await interpreterService.object.getActiveInterpreter();
        const instance = await NativeReplModule.NativeRepl.create(interpreter as PythonEnvironment);
        disposableArray.push(instance);
        const createMethodStub = sinon.stub(NativeReplModule.NativeRepl, 'create').resolves(instance);
        await NativeReplModule.getNativeRepl(interpreter as PythonEnvironment, session);

        expect(createMethodStub.calledOnce).to.be.true;
    });

    test('sendToNativeRepl should look for memento URI if notebook document is undefined', async () => {
        getWorkspaceStateValueStub = sinon.stub(persistentState, 'getWorkspaceStateValue').returns(undefined);
        interpreterService
            .setup((i) => i.getActiveInterpreter(TypeMoq.It.isAny()))
            .returns(() => Promise.resolve(({ path: 'ps' } as unknown) as PythonEnvironment));
        const interpreter = await interpreterService.object.getActiveInterpreter();
        const nativeRepl = await NativeReplModule.getNativeRepl(interpreter as PythonEnvironment, session);

        await nativeRepl.sendToNativeRepl(undefined, false);

        expect(getWorkspaceStateValueStub.calledOnce).to.be.true;
    });

    test('sendToNativeRepl should call updateWorkspaceStateValue', async () => {
        getWorkspaceStateValueStub = sinon.stub(persistentState, 'getWorkspaceStateValue').returns('myNameIsMemento');
        interpreterService
            .setup((i) => i.getActiveInterpreter(TypeMoq.It.isAny()))
            .returns(() => Promise.resolve(({ path: 'ps' } as unknown) as PythonEnvironment));
        const interpreter = await interpreterService.object.getActiveInterpreter();
        const nativeRepl = await NativeReplModule.getNativeRepl(interpreter as PythonEnvironment, session);

        await nativeRepl.sendToNativeRepl(undefined, false);

        expect(updateWorkspaceStateValueStub.calledOnce).to.be.true;
    });

    test('create should set the directory and create the controller', async () => {
        const interpreter = await interpreterService.object.getActiveInterpreter();
        interpreterService
            .setup((i) => i.getActiveInterpreter(TypeMoq.It.isAny()))
            .returns(() => Promise.resolve(({ path: 'ps' } as unknown) as PythonEnvironment));

        disposableArray.push(await NativeReplModule.NativeRepl.create(interpreter as PythonEnvironment));

        expect(setReplDirectoryStub.calledOnce).to.be.true;
        expect(createReplControllerStub.calledOnce).to.be.true;
    });

    test('createReplController should publish stdout notebook output for REPL execution', async () => {
        const mockServer = {
            interrupt: sinon.stub(),
            execute: sinon.stub().resolves({ status: true, output: 'hello\nworld' }),
            dispose: sinon.stub(),
        } as any;

        const replaceOutputStub = sinon.stub();
        const execStub = {
            start: sinon.stub(),
            replaceOutput: replaceOutputStub,
            end: sinon.stub(),
        } as any;

        const createNotebookCellExecutionStub = sinon.stub().returns(execStub);
        const mockNotebookController = ({
            id: 'mockController',
            dispose: sinon.stub(),
            updateNotebookAffinity: sinon.stub(),
            createNotebookCellExecution: createNotebookCellExecutionStub,
            supportedLanguages: [] as string[],
            description: '',
            interruptHandler: undefined,
            executeHandler: undefined,
        } as any) as vscode.NotebookController;

        sinon.stub(vscode.notebooks, 'createNotebookController').returns(mockNotebookController);
        createReplControllerStub.restore();

        const controller = replController.createReplController(mockServer);
        try {
            const mockTextDocument = { getText: sinon.stub().returns('print("hi")') } as any;
            const mockCell = { document: mockTextDocument } as any;
            await (controller.executeHandler as any)([mockCell]);

            expect(mockServer.execute.calledOnceWithExactly('print("hi")')).to.be.true;
            expect(createNotebookCellExecutionStub.calledOnce).to.be.true;
            expect(replaceOutputStub.calledOnce).to.be.true;

            const outputs = replaceOutputStub.firstCall.args[0] as vscode.NotebookCellOutput[];
            expect(outputs).to.have.lengthOf(1);
            const output = outputs[0];
            expect(output.items).to.have.lengthOf(1);
            expect(output.items[0].mime).to.equal('application/vnd.code.notebook.stdout');
            expect((output.items[0] as any).metadata).to.be.undefined;
            expect(output.metadata).to.deep.equal({});
            const outputText = Buffer.from((output.items[0] as any).data).toString();
            expect(outputText).to.equal('hello\nworld');
        } finally {
            controller.dispose();
        }
    });
});

suite('REPL - cell submission', () => {
    let closed: boolean;
    let editor: vscode.NotebookEditor;
    let applyEdit: sinon.SinonStub;
    let executeCommand: sinon.SinonStub;

    setup(() => {
        closed = false;
        const notebook = TypeMoq.Mock.ofType<vscode.NotebookDocument>();
        notebook.setup((d) => d.uri).returns(() => vscode.Uri.parse('untitled:repl-test.ipynb'));
        notebook.setup((d) => d.isClosed).returns(() => closed);
        notebook.setup((d) => d.cellCount).returns(() => 0);
        const notebookEditor = TypeMoq.Mock.ofType<vscode.NotebookEditor>();
        notebookEditor.setup((e) => e.notebook).returns(() => notebook.object);
        editor = notebookEditor.object;

        applyEdit = sinon.stub(workspaceApis, 'applyEdit');
        executeCommand = sinon.stub(commandApis, 'executeCommand').resolves();
    });

    teardown(() => sinon.restore());

    test('executes the inserted cell in the live notebook', async () => {
        applyEdit.resolves(true);
        await replCommandHandler.executeNotebookCell(editor, 'print(1)');

        sinon.assert.calledOnce(applyEdit);
        sinon.assert.calledOnceWithExactly(executeCommand, 'notebook.cell.execute', {
            document: editor.notebook.uri,
            ranges: [{ start: 0, end: 1 }],
        });
    });

    test('does not execute a cell when the workspace edit was rejected', async () => {
        applyEdit.resolves(false);
        await replCommandHandler.executeNotebookCell(editor, 'print(1)');

        sinon.assert.calledOnce(applyEdit);
        sinon.assert.notCalled(executeCommand);
    });

    test('does not dispatch to a notebook that closed during the workspace edit', async () => {
        const applied = createDeferred<boolean>();
        applyEdit.returns(applied.promise);
        const sending = replCommandHandler.executeNotebookCell(editor, 'print(1)');
        sinon.assert.calledOnce(applyEdit);
        closed = true;
        applied.resolve(true);
        await sending;

        sinon.assert.notCalled(executeCommand);
    });

    test('does not execute an old edit when the REPL owner changed and the notebook stayed open', async () => {
        const applied = createDeferred<boolean>();
        applyEdit.returns(applied.promise);
        let originalOwner = true;
        const sending = replCommandHandler.executeNotebookCell(editor, 'print(1)', () => originalOwner);
        sinon.assert.calledOnce(applyEdit);
        originalOwner = false;
        applied.resolve(true);
        await sending;
        sinon.assert.notCalled(executeCommand);

        await replCommandHandler.executeNotebookCell(editor, 'print(2)', () => true);
        sinon.assert.calledOnce(executeCommand);
    });
});
