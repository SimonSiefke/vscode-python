// Create test suite and test cases for the `replUtils` module
import * as TypeMoq from 'typemoq';
import { commands, Disposable, TextDocument, TextEditor, Uri } from 'vscode';
import * as sinon from 'sinon';
import { expect } from 'chai';
import { IInterpreterService } from '../../client/interpreter/contracts';
import { ICommandManager } from '../../client/common/application/types';
import { ICodeExecutionHelper } from '../../client/terminals/types';
import * as replCommands from '../../client/repl/replCommands';
import * as replUtils from '../../client/repl/replUtils';
import * as nativeRepl from '../../client/repl/nativeRepl';
import * as windowApis from '../../client/common/vscodeApis/windowApis';
import { Commands } from '../../client/common/constants';
import { PythonEnvironment } from '../../client/pythonEnvironments/info';

suite('REPL - register native repl command', () => {
    let interpreterService: TypeMoq.IMock<IInterpreterService>;
    let commandManager: TypeMoq.IMock<ICommandManager>;
    let executionHelper: TypeMoq.IMock<ICodeExecutionHelper>;
    let getSendToNativeREPLSettingStub: sinon.SinonStub;
    // @ts-ignore: TS6133
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    let registerCommandSpy: sinon.SinonSpy;
    let executeInTerminalStub: sinon.SinonStub;
    let disposable: TypeMoq.IMock<Disposable>;
    let disposableArray: Disposable[] = [];
    let session: nativeRepl.NativeReplSession;

    setup(() => {
        interpreterService = TypeMoq.Mock.ofType<IInterpreterService>();
        commandManager = TypeMoq.Mock.ofType<ICommandManager>();
        executionHelper = TypeMoq.Mock.ofType<ICodeExecutionHelper>();
        commandManager
            .setup((cm) => cm.registerCommand(TypeMoq.It.isAny(), TypeMoq.It.isAny(), TypeMoq.It.isAny()))
            .returns(() => TypeMoq.Mock.ofType<Disposable>().object);

        getSendToNativeREPLSettingStub = sinon.stub(replUtils, 'getSendToNativeREPLSetting');
        getSendToNativeREPLSettingStub.returns(false);
        executeInTerminalStub = sinon.stub(replUtils, 'executeInTerminal');
        executeInTerminalStub.returns(Promise.resolve());
        registerCommandSpy = sinon.spy(commandManager.object, 'registerCommand');
        disposable = TypeMoq.Mock.ofType<Disposable>();
        disposableArray = [disposable.object];
        session = nativeRepl.registerNativeRepl(disposableArray);
    });

    teardown(() => {
        sinon.restore();
        disposableArray.forEach((d) => {
            if (d) {
                d.dispose();
            }
        });

        disposableArray = [];
    });

    test('Ensure repl command is registered', async () => {
        interpreterService
            .setup((i) => i.getActiveInterpreter(TypeMoq.It.isAny()))
            .returns(() => Promise.resolve(({ path: 'ps' } as unknown) as PythonEnvironment));

        await replCommands.registerReplCommands(
            disposableArray,
            session,
            interpreterService.object,
            executionHelper.object,
            commandManager.object,
        );

        commandManager.verify(
            (c) => c.registerCommand(TypeMoq.It.isAny(), TypeMoq.It.isAny()),
            TypeMoq.Times.atLeastOnce(),
        );
    });

    test('Ensure getSendToNativeREPLSetting is called', async () => {
        interpreterService
            .setup((i) => i.getActiveInterpreter(TypeMoq.It.isAny()))
            .returns(() => Promise.resolve(({ path: 'ps' } as unknown) as PythonEnvironment));

        let commandHandler: undefined | (() => Promise<void>);
        commandManager
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .setup((c) => c.registerCommand as any)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .returns(() => (command: string, callback: (...args: any[]) => any, _thisArg?: any) => {
                if (command === Commands.Exec_In_REPL) {
                    commandHandler = callback;
                }
                // eslint-disable-next-line no-void
                return { dispose: () => void 0 };
            });
        replCommands.registerReplCommands(
            disposableArray,
            session,
            interpreterService.object,
            executionHelper.object,
            commandManager.object,
        );

        expect(commandHandler).not.to.be.an('undefined', 'Command handler not initialized');

        await commandHandler!();

        sinon.assert.calledOnce(getSendToNativeREPLSettingStub);
    });

    test('Ensure executeInTerminal is called when getSendToNativeREPLSetting returns false', async () => {
        interpreterService
            .setup((i) => i.getActiveInterpreter(TypeMoq.It.isAny()))
            .returns(() => Promise.resolve(({ path: 'ps' } as unknown) as PythonEnvironment));
        getSendToNativeREPLSettingStub.returns(false);

        let commandHandler: undefined | (() => Promise<void>);
        commandManager
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .setup((c) => c.registerCommand as any)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .returns(() => (command: string, callback: (...args: any[]) => any, _thisArg?: any) => {
                if (command === Commands.Exec_In_REPL) {
                    commandHandler = callback;
                }
                // eslint-disable-next-line no-void
                return { dispose: () => void 0 };
            });
        replCommands.registerReplCommands(
            disposableArray,
            session,
            interpreterService.object,
            executionHelper.object,
            commandManager.object,
        );

        expect(commandHandler).not.to.be.an('undefined', 'Command handler not initialized');

        await commandHandler!();

        sinon.assert.calledOnce(executeInTerminalStub);
    });

    async function registerShiftEnter() {
        let commandHandler: ((uri: Uri) => Promise<void>) | undefined;
        commandManager
            .setup((c) => c.registerCommand)
            .returns(() => (command, callback) => {
                if (command === Commands.Exec_In_REPL) {
                    commandHandler = callback as (uri: Uri) => Promise<void>;
                }
                return { dispose: () => undefined };
            });
        getSendToNativeREPLSettingStub.returns(true);
        const useRepl = sinon.stub(nativeRepl, 'withNativeRepl').resolves();
        await replCommands.registerReplCommands(
            disposableArray,
            session,
            interpreterService.object,
            executionHelper.object,
            commandManager.object,
        );
        expect(commandHandler).not.to.be.undefined;
        return { commandHandler: commandHandler!, useRepl };
    }

    function mockSelection(code: string, normalizedCode?: string) {
        const editor = TypeMoq.Mock.ofType<TextEditor>();
        const document = TypeMoq.Mock.ofType<TextDocument>();
        document.setup((d) => d.isClosed).returns(() => false);
        document.setup((d) => d.getText()).returns(() => code);
        editor.setup((e) => e.document).returns(() => document.object);
        sinon.stub(windowApis, 'getActiveTextEditor').returns(editor.object);
        sinon.stub(replUtils, 'getSelectedTextToExecute').resolves(code);
        executionHelper
            .setup((helper) => helper.normalizeLines(code, TypeMoq.It.isAny(), code))
            .returns(() => Promise.resolve(normalizedCode ?? code));
    }

    test('does not acquire a Native REPL without an editor', async () => {
        sinon.stub(windowApis, 'getActiveTextEditor').returns(undefined);
        const { commandHandler, useRepl } = await registerShiftEnter();

        await commandHandler(Uri.file('/workspace/source.py'));

        sinon.assert.notCalled(useRepl);
    });

    test('does not acquire a Native REPL for a blank selection', async () => {
        mockSelection(' ');
        const { commandHandler, useRepl } = await registerShiftEnter();

        await commandHandler(Uri.file('/workspace/source.py'));

        sinon.assert.notCalled(useRepl);
    });

    test('sends normalized code to a Native REPL when an interpreter is available', async () => {
        const interpreter = { path: '/python' } as PythonEnvironment;
        interpreterService
            .setup((i) => i.getActiveInterpreter(TypeMoq.It.isAny()))
            .returns(() => Promise.resolve(interpreter));
        mockSelection('    print(1)', 'print(1)');
        const { commandHandler, useRepl } = await registerShiftEnter();
        const send = sinon.stub().resolves();
        useRepl.callsFake((_interpreter, _session, run) =>
            run(({ sendToNativeRepl: send } as unknown) as nativeRepl.NativeRepl),
        );

        await commandHandler(Uri.file('/workspace/source.py'));

        sinon.assert.calledOnceWithExactly(useRepl, interpreter, session, sinon.match.func);
        sinon.assert.calledOnceWithExactly(send, 'print(1)');
    });

    test('does not acquire a Native REPL without an interpreter', async () => {
        interpreterService
            .setup((i) => i.getActiveInterpreter(TypeMoq.It.isAny()))
            .returns(() => Promise.resolve(undefined));
        mockSelection('print(1)');
        const { commandHandler, useRepl } = await registerShiftEnter();
        const executeCommand = sinon.stub(commands, 'executeCommand').resolves();
        const uri = Uri.file('/workspace/source.py');

        await commandHandler(uri);

        sinon.assert.calledOnceWithExactly(executeCommand, Commands.TriggerEnvironmentSelection, uri);
        executionHelper.verify(
            (helper) => helper.normalizeLines(TypeMoq.It.isAny(), TypeMoq.It.isAny(), TypeMoq.It.isAny()),
            TypeMoq.Times.never(),
        );
        sinon.assert.notCalled(useRepl);
    });
});

suite('Native REPL getActiveInterpreter', () => {
    let interpreterService: TypeMoq.IMock<IInterpreterService>;
    let executeCommandStub: sinon.SinonStub;
    let getActiveResourceStub: sinon.SinonStub;

    setup(() => {
        interpreterService = TypeMoq.Mock.ofType<IInterpreterService>();
        executeCommandStub = sinon.stub(commands, 'executeCommand').resolves(undefined);
        getActiveResourceStub = sinon.stub(windowApis, 'getActiveResource');
    });

    teardown(() => {
        sinon.restore();
    });

    test('Uses active resource when uri is undefined', async () => {
        const resource = Uri.file('/workspace/app.py');
        const expected = ({ path: 'ps' } as unknown) as PythonEnvironment;
        getActiveResourceStub.returns(resource);
        interpreterService
            .setup((i) => i.getActiveInterpreter(TypeMoq.It.isValue(resource)))
            .returns(() => Promise.resolve(expected));

        const result = await replUtils.getActiveInterpreter(undefined, interpreterService.object);

        expect(result).to.equal(expected);
        interpreterService.verify((i) => i.getActiveInterpreter(TypeMoq.It.isValue(resource)), TypeMoq.Times.once());
        sinon.assert.notCalled(executeCommandStub);
    });

    test('Triggers environment selection using active resource when interpreter is missing', async () => {
        const resource = Uri.file('/workspace/app.py');
        getActiveResourceStub.returns(resource);
        interpreterService
            .setup((i) => i.getActiveInterpreter(TypeMoq.It.isValue(resource)))
            .returns(() => Promise.resolve(undefined));

        const result = await replUtils.getActiveInterpreter(undefined, interpreterService.object);

        expect(result).to.equal(undefined);
        sinon.assert.calledWith(executeCommandStub, Commands.TriggerEnvironmentSelection, resource);
    });
});
