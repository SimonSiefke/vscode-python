// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

// Native Repl class that holds instance of pythonServer and replController

import {
    CancellationTokenSource,
    Disposable,
    NotebookController,
    NotebookDocument,
    QuickPickItem,
    TextEditor,
    Uri,
    WorkspaceFolder,
} from 'vscode';
import * as path from 'path';
import { PVSC_EXTENSION_ID } from '../common/constants';
import { showQuickPick } from '../common/vscodeApis/windowApis';
import { getWorkspaceFolders, onDidCloseNotebookDocument } from '../common/vscodeApis/workspaceApis';
import { PythonEnvironment } from '../pythonEnvironments/info';
import { createPythonServer, PythonServer } from './pythonServer';
import { executeNotebookCell, openInteractiveREPL, selectNotebookKernel } from './replCommandHandler';
import { createReplController } from './replController';
import { EventName } from '../telemetry/constants';
import { sendTelemetryEvent } from '../telemetry';
import { VariablesProvider } from './variables/variablesProvider';
import { VariableRequester } from './variables/variableRequester';
import { getTabNameForUri } from './replUtils';
import { getWorkspaceStateValue, updateWorkspaceStateValue } from '../common/persistentState';
import { onDidChangeEnvironmentEnvExt, useEnvExtension } from '../envExt/api.internal';
import { getActiveInterpreterLegacy } from '../envExt/api.legacy';
import { DisposableStore } from '../common/utils/resourceLifecycle';

export const NATIVE_REPL_URI_MEMENTO = 'nativeReplUri';
const SESSION_DISPOSED = 'Native REPL session is disposed';

export interface NativeReplSession {
    current?: NativeRepl;
    pending?: Promise<NativeRepl>;
    disposed: boolean;
    activeCommands: number;
    cancellation: CancellationTokenSource;
}

let pendingMementoUpdate = Promise.resolve();

function updateNotebookMemento(uri: string | undefined): Promise<void> {
    // The workspace-state helper can retry a write if another update overtakes it.
    const update = pendingMementoUpdate.then(() => updateWorkspaceStateValue(NATIVE_REPL_URI_MEMENTO, uri));
    pendingMementoUpdate = update.catch(() => undefined);
    return update;
}

export class NativeRepl implements Disposable {
    // Adding ! since it will get initialized in create method, not the constructor.
    private pythonServer!: PythonServer;

    private cwd: string | undefined;

    private interpreter!: PythonEnvironment;

    private readonly disposables = new DisposableStore();

    private readonly kernelDisposables = this.disposables.add(new DisposableStore());

    private replController!: NotebookController;

    private notebookDocument: NotebookDocument | undefined;

    public newReplSession: boolean | undefined = true;

    private pendingInterpreterChange?: { resource?: Uri };

    private disposed = false;

    private pendingSend = Promise.resolve();

    private pendingSends = 0;

    private releaseWhenUnused = false;

    // TODO: In the future, could also have attribute of URI for file specific REPL.
    private constructor(private readonly owner?: NativeReplSession) {}

    // Static async factory method to handle asynchronous initialization
    public static async create(interpreter: PythonEnvironment, owner?: NativeReplSession): Promise<NativeRepl> {
        const repl = new NativeRepl(owner);
        try {
            await repl.setReplDirectory();
            if (owner?.disposed) {
                throw new Error(SESSION_DISPOSED);
            }
            repl.watchNotebookClosed();
            repl.startKernel(interpreter);
            repl.registerInterpreterChangeHandler();
            return repl;
        } catch (error) {
            repl.dispose();
            throw error;
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.notebookDocument = undefined;
        this.newReplSession = true;
        this.pendingInterpreterChange = undefined;
        try {
            this.disposables.dispose();
        } finally {
            if (this.owner?.current === this) {
                this.owner.current = undefined;
            }
        }
    }

    /**
     * Function that watches for Notebook Closed event.
     * This is for the purposes of correctly updating the notebookEditor and notebookDocument on close.
     */
    private watchNotebookClosed(): void {
        this.disposables.add(
            onDidCloseNotebookDocument(async (nb) => {
                if (this.notebookDocument && nb.uri.toString() === this.notebookDocument.uri.toString()) {
                    this.dispose();
                    await updateNotebookMemento(undefined);
                }
            }),
        );
    }

    public useNotebook(notebook: NotebookDocument): boolean {
        if (this.disposed || (this.notebookDocument && this.notebookDocument !== notebook)) {
            return false;
        }
        if (notebook.isClosed) {
            this.releaseWhenUnused = true;
            this.disposeIfUnused();
            return false;
        }
        this.notebookDocument = notebook;
        return true;
    }

    public disposeIfUnused(): void {
        if (
            this.releaseWhenUnused &&
            !this.notebookDocument &&
            this.pendingSends === 0 &&
            !this.owner?.activeCommands
        ) {
            this.dispose();
        }
    }

    /**
     * Function that set up desired directory for REPL.
     * If there is multiple workspaces, prompt the user to choose
     * which directory we should set in context of native REPL.
     */
    private async setReplDirectory(): Promise<void> {
        // Figure out uri via workspaceFolder as uri parameter always
        // seem to be undefined from parameter when trying to access from replCommands.ts
        const workspaces: readonly WorkspaceFolder[] | undefined = getWorkspaceFolders();

        if (workspaces) {
            // eslint-disable-next-line no-shadow
            const workspacesQuickPickItems: QuickPickItem[] = workspaces.map((workspace) => ({
                label: workspace.name,
                description: workspace.uri.fsPath,
            }));

            if (workspacesQuickPickItems.length === 0) {
                this.cwd = process.cwd(); // Yields '/' on no workspace scenario.
            } else if (workspacesQuickPickItems.length === 1) {
                this.cwd = workspacesQuickPickItems[0].description;
            } else {
                // Show choices of workspaces for user to choose from.
                const selection = await showQuickPick(
                    workspacesQuickPickItems,
                    {
                        placeHolder: 'Select current working directory for new REPL',
                        matchOnDescription: true,
                        ignoreFocusOut: true,
                    },
                    this.owner?.cancellation.token,
                );
                this.cwd = selection?.description;
            }
        }
    }

    private startKernel(interpreter: PythonEnvironment): NotebookController {
        this.interpreter = interpreter;
        this.pythonServer = this.kernelDisposables.add(createPythonServer([interpreter.path], this.cwd));
        const controller = this.kernelDisposables.add(createReplController(this.pythonServer));
        this.replController = controller;
        controller.variableProvider = new VariablesProvider(
            new VariableRequester(this.pythonServer),
            () => this.notebookDocument,
            this.pythonServer.onCodeExecuted,
        );
        this.kernelDisposables.add(this.pythonServer.onDidBecomeIdle(() => this.applyPendingInterpreterChange()));
        return controller;
    }

    private registerInterpreterChangeHandler(): void {
        if (!useEnvExtension()) {
            return;
        }
        this.disposables.add(
            onDidChangeEnvironmentEnvExt((event) => {
                if (this.shouldApplyInterpreterChange(event.uri)) {
                    this.pendingInterpreterChange = { resource: event.uri };
                    this.applyPendingInterpreterChange();
                }
            }),
        );
    }

    private applyPendingInterpreterChange(): void {
        const change = this.pendingInterpreterChange;
        if (change && !this.disposed && !this.pythonServer.isExecuting) {
            this.updateInterpreter(change).catch(() => undefined);
        }
    }

    private async updateInterpreter(change: { resource?: Uri }): Promise<void> {
        const scope = change.resource ?? (this.cwd ? Uri.file(this.cwd) : undefined);
        const interpreter = await getActiveInterpreterLegacy(scope);
        if (this.disposed || this.pendingInterpreterChange !== change || this.pythonServer.isExecuting) {
            return;
        }
        this.pendingInterpreterChange = undefined;
        if (!interpreter || interpreter.path === this.interpreter.path) {
            return;
        }

        this.kernelDisposables.clear();
        let controller: NotebookController;
        try {
            controller = this.startKernel(interpreter);
        } catch (error) {
            this.dispose();
            throw error;
        }

        if (this.notebookDocument) {
            const result = await openInteractiveREPL(
                this.notebookDocument,
                true,
                () => !this.disposed && this.replController === controller,
            );
            if (result && !this.disposed && this.replController === controller) {
                await selectNotebookKernel(result.notebookEditor, controller.id, PVSC_EXTENSION_ID);
            }
        }
    }

    private shouldApplyInterpreterChange(resource?: Uri): boolean {
        if (!resource || !this.cwd) {
            return true;
        }
        const relative = path.relative(this.cwd, resource.fsPath);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    }

    /**
     * Function that checks if native REPL's text input box contains complete code.
     * @returns Promise<boolean> - True if complete/Valid code is present, False otherwise.
     */
    public async checkUserInputCompleteCode(activeEditor: TextEditor | undefined): Promise<boolean> {
        if (this.disposed) {
            return false;
        }
        const input = activeEditor?.document.getText();
        if (!input) {
            return false;
        }

        try {
            return await this.pythonServer.checkValidCommand(input);
        } catch (error) {
            if (this.disposed) {
                return false;
            }
            throw error;
        }
    }

    /**
     * Function that opens interactive repl, selects kernel, and send/execute code to the native repl.
     */
    public sendToNativeRepl(code?: string, preserveFocus: boolean = true): Promise<void> {
        this.pendingSends += 1;
        const send = this.pendingSend
            .then(() => this.sendToNotebook(code, preserveFocus))
            .finally(() => {
                this.pendingSends -= 1;
                this.releaseWhenUnused = true;
                this.disposeIfUnused();
            });
        this.pendingSend = send.catch(() => undefined);
        return send;
    }

    private async sendToNotebook(code: string | undefined, preserveFocus: boolean): Promise<void> {
        if (this.disposed) {
            return;
        }
        let wsMementoUri: Uri | undefined;

        if (!this.notebookDocument) {
            await pendingMementoUpdate;
            if (this.disposed) {
                return;
            }
            const wsMemento = getWorkspaceStateValue<string>(NATIVE_REPL_URI_MEMENTO);
            wsMementoUri = wsMemento ? Uri.parse(wsMemento) : undefined;

            if (!wsMementoUri || getTabNameForUri(wsMementoUri) !== 'Python REPL') {
                await updateNotebookMemento(undefined);
                wsMementoUri = undefined;
            }
        }
        if (this.disposed) {
            return;
        }

        let result: Awaited<ReturnType<typeof openInteractiveREPL>>;
        try {
            result = await openInteractiveREPL(
                this.notebookDocument ?? wsMementoUri,
                preserveFocus,
                () => !this.disposed,
            );
        } finally {
            if (!result && wsMementoUri && !this.disposed) {
                await updateNotebookMemento(undefined);
            }
        }
        if (!result || this.disposed) {
            return;
        }

        const { notebookEditor, documentCreated } = result;
        if (!this.useNotebook(notebookEditor.notebook)) {
            if (notebookEditor.notebook.isClosed) {
                await updateNotebookMemento(undefined);
            }
            return;
        }
        await updateNotebookMemento(notebookEditor.notebook.uri.toString());

        if (!this.disposed && documentCreated) {
            await selectNotebookKernel(notebookEditor, this.replController.id, PVSC_EXTENSION_ID);
        }
        if (code && !this.disposed) {
            await executeNotebookCell(notebookEditor, code, () => !this.disposed);
        }
    }
}

// Register before any command can suspend on interpreter discovery.
export function registerNativeRepl(disposables: Disposable[]): NativeReplSession {
    const session: NativeReplSession = {
        disposed: false,
        activeCommands: 0,
        cancellation: new CancellationTokenSource(),
    };
    disposables.push({
        dispose: () => {
            session.disposed = true;
            session.cancellation.cancel();
            session.cancellation.dispose();
            session.current?.dispose();
        },
    });
    return session;
}

export async function withNativeRepl(
    interpreter: PythonEnvironment,
    session: NativeReplSession,
    useRepl: (repl: NativeRepl) => Promise<void>,
): Promise<void> {
    if (session.disposed) {
        return;
    }
    session.activeCommands += 1;
    try {
        const repl = await getNativeRepl(interpreter, session);
        if (!session.disposed) {
            await useRepl(repl);
        }
    } catch (error) {
        if (!session.disposed) {
            throw error;
        }
    } finally {
        session.activeCommands -= 1;
        session.current?.disposeIfUnused();
    }
}

export async function getNativeRepl(interpreter: PythonEnvironment, session: NativeReplSession): Promise<NativeRepl> {
    if (session.disposed) {
        throw new Error(SESSION_DISPOSED);
    }
    let repl = session.current;
    if (!repl) {
        const owner = session;
        if (!owner.pending) {
            owner.pending = NativeRepl.create(interpreter, owner)
                .then((created) => {
                    if (owner.disposed) {
                        created.dispose();
                        throw new Error(SESSION_DISPOSED);
                    }
                    owner.current = created;
                    return created;
                })
                .finally(() => {
                    owner.pending = undefined;
                });
        }
        repl = await owner.pending;
    }
    if (repl.newReplSession) {
        sendTelemetryEvent(EventName.REPL, undefined, { replType: 'Native' });
        repl.newReplSession = false;
    }
    return repl;
}
