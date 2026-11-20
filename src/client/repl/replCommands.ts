import { commands, Uri } from 'vscode';
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
import { getActiveNotebookEditor, getActiveTextEditor } from '../common/vscodeApis/windowApis';
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
            const isCurrentSource = () =>
                !session.disposed && !editor.document.isClosed && getActiveTextEditor() === editor;
            const code = await getSelectedTextToExecute(editor);
            if (!code?.trim() || !isCurrentSource()) {
                return;
            }
            const normalizedCode = await executionHelper.normalizeLines(
                code,
                ReplType.native,
                editor.document.getText(),
            );
            if (!normalizedCode.trim() || !isCurrentSource()) {
                return;
            }

            const interpreter = await getActiveInterpreter(uri, interpreterService, isCurrentSource);
            if (interpreter && isCurrentSource()) {
                await withNativeRepl(interpreter, session, (repl) => repl.sendToNativeRepl(normalizedCode));
            }
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
        const input = editor.document.getText();
        if (!input) {
            await finishInput(false);
            return;
        }
        // The Interactive Window needs syntax validation without owning a Native REPL.
        const validator = createPythonServer([interpreter.path]);
        try {
            await finishInput(await validator.checkValidCommand(input));
        } finally {
            validator.dispose();
        }
    }
}
