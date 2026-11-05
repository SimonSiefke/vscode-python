// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/* eslint-disable no-unused-expressions */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as TypeMoq from 'typemoq';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { Disposable } from 'vscode';
import { expect } from 'chai';

import { IInterpreterService } from '../../client/interpreter/contracts';
import { PythonEnvironment } from '../../client/pythonEnvironments/info';
import * as NativeReplModule from '../../client/repl/nativeRepl';
import * as persistentState from '../../client/common/persistentState';
import * as PythonServer from '../../client/repl/pythonServer';
import * as replController from '../../client/repl/replController';
import * as replCommandHandler from '../../client/repl/replCommandHandler';
import { executeCommand } from '../../client/common/vscodeApis/commandApis';

suite('REPL - Native REPL', () => {
    let interpreterService: TypeMoq.IMock<IInterpreterService>;

    let disposable: TypeMoq.IMock<Disposable>;
    let disposableArray: Disposable[] = [];
    let setReplDirectoryStub: sinon.SinonStub;
    let setReplControllerSpy: sinon.SinonSpy;
    let getWorkspaceStateValueStub: sinon.SinonStub;
    let updateWorkspaceStateValueStub: sinon.SinonStub;
    let createReplControllerStub: sinon.SinonStub;
    let mockNotebookController: any;

    setup(() => {
        (NativeReplModule as any).nativeRepl = undefined;

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

        createReplControllerStub = sinon.stub(replController, 'createReplController').returns(mockNotebookController);
        sinon.stub(replCommandHandler, 'openInteractiveREPL').resolves(undefined);
        setReplDirectoryStub = sinon.stub(NativeReplModule.NativeRepl.prototype as any, 'setReplDirectory').resolves();
        setReplControllerSpy = sinon.spy(NativeReplModule.NativeRepl.prototype, 'setReplController');
        updateWorkspaceStateValueStub = sinon.stub(persistentState, 'updateWorkspaceStateValue').resolves();
    });

    teardown(async () => {
        disposableArray.forEach((d) => {
            if (d) {
                d.dispose();
            }
        });
        disposableArray = [];
        sinon.restore();
        await executeCommand('workbench.action.closeActiveEditor');
    });

    test('getNativeRepl should call create constructor', async () => {
        const interpreter = await interpreterService.object.getActiveInterpreter();
        const instance = await NativeReplModule.NativeRepl.create(interpreter as PythonEnvironment);
        disposableArray.push(instance);
        const createMethodStub = sinon.stub(NativeReplModule.NativeRepl, 'create').resolves(instance);
        await NativeReplModule.getNativeRepl(interpreter as PythonEnvironment, disposableArray);

        expect(createMethodStub.calledOnce).to.be.true;
    });

    test('sendToNativeRepl should look for memento URI if notebook document is undefined', async () => {
        getWorkspaceStateValueStub = sinon.stub(persistentState, 'getWorkspaceStateValue').returns(undefined);
        interpreterService
            .setup((i) => i.getActiveInterpreter(TypeMoq.It.isAny()))
            .returns(() => Promise.resolve(({ path: 'ps' } as unknown) as PythonEnvironment));
        const interpreter = await interpreterService.object.getActiveInterpreter();
        const nativeRepl = await NativeReplModule.getNativeRepl(interpreter as PythonEnvironment, disposableArray);

        await nativeRepl.sendToNativeRepl(undefined, false);

        expect(getWorkspaceStateValueStub.calledOnce).to.be.true;
    });

    test('sendToNativeRepl should call updateWorkspaceStateValue', async () => {
        getWorkspaceStateValueStub = sinon.stub(persistentState, 'getWorkspaceStateValue').returns('myNameIsMemento');
        interpreterService
            .setup((i) => i.getActiveInterpreter(TypeMoq.It.isAny()))
            .returns(() => Promise.resolve(({ path: 'ps' } as unknown) as PythonEnvironment));
        const interpreter = await interpreterService.object.getActiveInterpreter();
        const nativeRepl = await NativeReplModule.getNativeRepl(interpreter as PythonEnvironment, disposableArray);

        await nativeRepl.sendToNativeRepl(undefined, false);

        expect(updateWorkspaceStateValueStub.calledOnce).to.be.true;
    });

    test('create should call setReplDirectory, setReplController', async () => {
        const interpreter = await interpreterService.object.getActiveInterpreter();
        interpreterService
            .setup((i) => i.getActiveInterpreter(TypeMoq.It.isAny()))
            .returns(() => Promise.resolve(({ path: 'ps' } as unknown) as PythonEnvironment));

        disposableArray.push(await NativeReplModule.NativeRepl.create(interpreter as PythonEnvironment));

        expect(setReplDirectoryStub.calledOnce).to.be.true;
        expect(setReplControllerSpy.calledOnce).to.be.true;
        expect(createReplControllerStub.calledOnce).to.be.true;
    });

    test('createReplController should publish stdout notebook output for REPL execution', async () => {
        const mockServer = {
            interrupt: sinon.stub(),
            execute: sinon.stub().resolves({ status: true, output: 'hello\nworld' }),
            dispose: sinon.stub(),
        } as any;
        const createPythonServerStub = sinon.stub(PythonServer, 'createPythonServer').returns(mockServer as any);

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

        const disposables: Disposable[] = [];
        try {
            const controller = replController.createReplController('python', disposables, '/cwd');

            const mockTextDocument = { getText: sinon.stub().returns('print("hi")') } as any;
            const mockCell = { document: mockTextDocument } as any;
            await (controller.executeHandler as any)([mockCell]);

            expect(createPythonServerStub.calledOnce).to.be.true;
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
            disposables.forEach((disposable) => disposable.dispose());
        }
    });
});
