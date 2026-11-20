import { commands, TextEditor, Uri } from 'vscode';
import { Disposable } from 'vscode-jsonrpc';
import { ICommandManager } from '../common/application/types';
import { Commands } from '../common/constants';
import { IInterpreterService } from '../interpreter/contracts';
import { ICodeExecutionHelper } from '../terminals/types';
import { NativeReplSession, withNativeRepl } from './nativeRepl';
import { createPythonServer } from './pythonServer';
import {
    executeInTerminal,
    getActiveInterpreter,
    getSelectedTextToExecute,
    getSendToNativeREPLSetting,
    getTabNameForUri,
    insertNewLineToREPLInput,
    isMultiLineText,
} from './replUtils';
import { registerCommand } from '../common/vscodeApis/commandApis';
import {
    getActiveNotebookEditor,
    getActiveTextEditor,
    onDidChangeActiveTextEditor,
} from '../common/vscodeApis/windowApis';
import { onDidCloseTextDocument } from '../common/vscodeApis/workspaceApis';
import { DisposableStore } from '../common/utils/resourceLifecycle';
import { PythonEnvironment } from '../pythonEnvironments/info';
import { sendTelemetryEvent } from '../telemetry';
import { EventName } from '../telemetry/constants';
import { ReplType } from './types';

/**
 * Register Start Native REPL command in the command palette
 */
export async function registerStartNativeReplCommand(
    disposables: Disposable[],
    session: NativeReplSession,
    interpreterService: IInterpreterService,
): Promise<void> {
    disposables.push(
        registerCommand(Commands.Start_Native_REPL, async (uri: Uri) => {
            sendTelemetryEvent(EventName.REPL, undefined, { replType: 'Native' });
            const interpreter = await getActiveInterpreter(uri, interpreterService, () => !session.disposed);
            if (interpreter) {
                await withNativeRepl(interpreter, session, (repl) => repl.sendToNativeRepl(undefined, false));
            }
        }),
    );
}

/**
 * Registers REPL command for shift+enter if sendToNativeREPL setting is enabled.
 */
export async function registerReplCommands(
    disposables: Disposable[],
    session: NativeReplSession,
    interpreterService: IInterpreterService,
    executionHelper: ICodeExecutionHelper,
    commandManager: ICommandManager,
): Promise<void> {
    disposables.push(
        commandManager.registerCommand(Commands.Exec_In_REPL, async (uri: Uri) => {
            const nativeREPLSetting = getSendToNativeREPLSetting();

            if (!nativeREPLSetting) {
                await executeInTerminal();
                return;
            }
            const editor = getActiveTextEditor();
            if (!editor || session.disposed) {
                return;
            }
            const { document, selection } = editor;
            const sourceVersion = document.version;
            const isCurrentDocument = () =>
                !session.disposed &&
                !document.isClosed &&
                document.version === sourceVersion &&
                getActiveTextEditor() === editor;
            const isCurrentSelection = () => isCurrentDocument() && editor.selection.isEqual(selection);
            const code = await getSelectedTextToExecute(editor);
            if (!code?.trim() || !isCurrentSelection()) {
                return;
            }
            const interpreter = await getActiveInterpreter(uri, interpreterService, isCurrentSelection);
            if (!interpreter || !isCurrentSelection()) {
                return;
            }
            const normalizedCode = await executionHelper.normalizeLines(code, ReplType.native, document.getText());
            if (!normalizedCode.trim() || !isCurrentDocument()) {
                return;
            }

            await withNativeRepl(interpreter, session, (repl) => repl.sendToNativeRepl(normalizedCode));
        }),
    );
}

/**
 * Command triggered for 'Enter': Conditionally call interactive.execute OR insert \n in text input box.
 */
export async function registerReplExecuteOnEnter(
    disposables: Disposable[],
    session: NativeReplSession,
    interpreterService: IInterpreterService,
    commandManager: ICommandManager,
): Promise<void> {
    disposables.push(
        commandManager.registerCommand(Commands.Exec_In_REPL_Enter, async (uri: Uri) => {
            await onInputEnter(uri, 'repl.execute', interpreterService, session);
        }),
    );
    disposables.push(
        commandManager.registerCommand(Commands.Exec_In_IW_Enter, async (uri: Uri) => {
            await onInputEnter(uri, 'interactive.execute', interpreterService, session);
        }),
    );
}

async function onInputEnter(
    uri: Uri | undefined,
    commandName: string,
    interpreterService: IInterpreterService,
    session: NativeReplSession,
): Promise<void> {
    const editor = getActiveTextEditor();
    if (!editor) {
        return;
    }
    const notebookEditor = commandName === 'repl.execute' ? getActiveNotebookEditor() : undefined;
    const notebook = notebookEditor?.notebook;
    if (commandName === 'repl.execute' && (!notebook || !notebookEditor?.replOptions)) {
        return;
    }
    const inputVersion = editor.document.version;
    const isCurrentInput = () =>
        !session.disposed &&
        getActiveTextEditor() === editor &&
        !editor.document.isClosed &&
        editor.document.version === inputVersion &&
        !notebook?.isClosed &&
        (!notebookEditor || getActiveNotebookEditor() === notebookEditor);
    if (!isCurrentInput()) {
        return;
    }
    if (notebook && getTabNameForUri(notebook.uri) !== 'Python REPL') {
        await commands.executeCommand(commandName, notebook.uri);
        return;
    }

    const interpreter = await getActiveInterpreter(uri, interpreterService, isCurrentInput);
    if (!interpreter || !isCurrentInput()) {
        return;
    }

    const finishInput = async (completeCode: boolean) => {
        if (!isCurrentInput()) {
            return;
        }
        const shouldExecute = completeCode && !isMultiLineText(editor);
        if (!shouldExecute) {
            insertNewLineToREPLInput(editor);
        }
        if (shouldExecute || editor.document.lineAt(editor.selection.active.line).text === '') {
            if (notebook) {
                await commands.executeCommand(commandName, notebook.uri);
            } else {
                await commands.executeCommand(commandName);
            }
        }
    };

    if (notebook) {
        await withNativeRepl(interpreter, session, async (repl) => {
            if (repl.useNotebook(notebook) && isCurrentInput()) {
                await finishInput(await repl.checkUserInputCompleteCode(editor));
            }
        });
    } else {
        const complete = await validateInteractiveInput(interpreter, session, editor);
        if (complete !== undefined) {
            await finishInput(complete);
        }
    }
}

async function validateInteractiveInput(
    interpreter: PythonEnvironment,
    session: NativeReplSession,
    editor: TextEditor,
): Promise<boolean | undefined> {
    session.interactiveValidation?.dispose();
    const { document } = editor;
    const input = document.getText();
    if (!input) {
        return false;
    }

    const validation = new DisposableStore();
    session.interactiveValidation = validation;
    try {
        const validator = validation.add(createPythonServer([interpreter.path]));
        validation.add(
            onDidCloseTextDocument((closed) => {
                if (closed === document) {
                    validation.dispose();
                }
            }),
        );
        validation.add(
            onDidChangeActiveTextEditor((active) => {
                if (active !== editor) {
                    validation.dispose();
                }
            }),
        );
        const complete = await validator.checkValidCommand(input);
        return validation.isDisposed ? undefined : complete;
    } catch (error) {
        if (!validation.isDisposed) {
            throw error;
        }
        return undefined;
    } finally {
        if (session.interactiveValidation === validation) {
            session.interactiveValidation = undefined;
        }
        validation.dispose();
    }
}
