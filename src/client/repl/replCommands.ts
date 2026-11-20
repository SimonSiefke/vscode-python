import { commands, Uri, window } from 'vscode';
import { Disposable } from 'vscode-jsonrpc';
import { ICommandManager } from '../common/application/types';
import { Commands } from '../common/constants';
import { IInterpreterService } from '../interpreter/contracts';
import { ICodeExecutionHelper } from '../terminals/types';
import { getNativeRepl, NativeReplSession } from './nativeRepl';
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
            const interpreter = await getActiveInterpreter(uri, interpreterService);
            if (interpreter && !session.disposed) {
                const nativeRepl = await getNativeRepl(interpreter, session);
                await nativeRepl.sendToNativeRepl(undefined, false);
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
            const interpreter = await getActiveInterpreter(uri, interpreterService);

            if (interpreter && !session.disposed) {
                const nativeRepl = await getNativeRepl(interpreter, session);
                const activeEditor = window.activeTextEditor;
                if (activeEditor) {
                    const code = await getSelectedTextToExecute(activeEditor);
                    if (code) {
                        // Smart Send
                        let wholeFileContent = '';
                        if (activeEditor && activeEditor.document) {
                            wholeFileContent = activeEditor.document.getText();
                        }
                        const normalizedCode = await executionHelper.normalizeLines(
                            code!,
                            ReplType.native,
                            wholeFileContent,
                        );
                        await nativeRepl.sendToNativeRepl(normalizedCode);
                    }
                }
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
    if (
        commandName === 'repl.execute' &&
        (!notebook || !notebookEditor?.replOptions || getTabNameForUri(notebook.uri) !== 'Python REPL')
    ) {
        return;
    }
    const isCurrentInput = () =>
        !session.disposed &&
        getActiveTextEditor() === editor &&
        !editor.document.isClosed &&
        !notebook?.isClosed &&
        (!notebookEditor || getActiveNotebookEditor() === notebookEditor);

    const interpreter = await getActiveInterpreter(uri, interpreterService);
    if (!interpreter || !isCurrentInput()) {
        return;
    }

    const nativeRepl = await getNativeRepl(interpreter, session);
    if ((notebook && !nativeRepl.useNotebook(notebook)) || !isCurrentInput()) {
        return;
    }
    const completeCode = await nativeRepl.checkUserInputCompleteCode(editor);
    if (!isCurrentInput()) {
        return;
    }

    if (completeCode && !isMultiLineText(editor)) {
        await commands.executeCommand(commandName);
    } else {
        insertNewLineToREPLInput(editor);
        if (editor.document.lineAt(editor.selection.active.line).text === '') {
            await commands.executeCommand(commandName);
        }
    }
}
