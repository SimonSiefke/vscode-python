// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { inject } from 'inversify';
import { CancellationToken, CancellationTokenSource, Disposable, Event, TerminalShellExecution } from 'vscode';
import { IInterpreterService } from '../../interpreter/contracts';
import { traceError, traceVerbose } from '../../logging';
import { PythonEnvironment } from '../../pythonEnvironments/info';
import { Cancellation, CancellationError } from '../cancellation';
import { IFileSystem, TemporaryFile } from '../platform/types';
import * as internalScripts from '../process/internal/scripts';
import { createDeferred, Deferred, sleep } from '../utils/async';
import { noop } from '../utils/misc';
import { TerminalService } from './service';
import { ITerminalService } from './types';

class ExecutionState implements Disposable {
    private state = '';
    private _completed: Deferred<void> = createDeferred();
    private disposable?: Disposable;
    constructor(
        public readonly lockFile: string,
        private readonly fs: IFileSystem,
        private readonly command: string[],
    ) {
        this.registerStateUpdate();
        this._completed.promise.finally(() => this.dispose()).ignoreErrors();
    }
    public get completed(): Promise<void> {
        return this._completed.promise;
    }
    public async completeFromShell(exitCode: number): Promise<void> {
        if (!this._completed.completed) {
            await this.updateState();
        }
        if (this._completed.completed) {
            return this.completed;
        }
        throw new Error(
            `Terminal command exited with code ${exitCode} before reporting completion: ${this.command.join(' ')}`,
        );
    }
    public dispose() {
        if (this.disposable) {
            this.disposable.dispose();
            this.disposable = undefined;
        }
    }
    private registerStateUpdate() {
        const timeout = setInterval(() => {
            this.updateState().catch((error) => {
                if (this.disposable) {
                    this._completed.reject(error);
                }
            });
        }, 100);

        this.disposable = {
            dispose: () => clearInterval(timeout as any),
        };
    }
    private async updateState(): Promise<void> {
        const contents = await this.fs.readFile(this.lockFile);
        if (!this.disposable) {
            return;
        }
        const endOfState = contents.indexOf('\n');
        const state = (endOfState === -1 ? contents : contents.slice(0, endOfState)).trim();
        if (state !== this.state) {
            traceVerbose(`Command state changed to ${state}. ${this.command.join(' ')}`);
        }
        this.state = state;
        if (state === 'FAIL') {
            const errorContents = endOfState === -1 ? '' : contents.slice(endOfState + 1);
            this._completed.reject(
                new Error(
                    `Command failed with errors, check the terminal for details. Command: ${this.command.join(
                        ' ',
                    )}\n${errorContents}`,
                ),
            );
        } else if (state === 'CANCELED') {
            this._completed.reject(new CancellationError());
        } else if (state === 'END') {
            this._completed.resolve();
        }
    }
}

/**
 * This is a decorator class that ensures commands send to a terminal are completed and then execution is returned back to calling code.
 * The tecnique used is simple:
 * - Instead of sending actual text to a terminal,
 * - Send text to a terminal that executes our python file, passing in the original text as args
 * - The pthon file will execute the commands as a subprocess
 * - At the end of the execution a file is created to singal completion.
 */
export class SynchronousTerminalService implements ITerminalService, Disposable {
    private readonly disposables: Disposable[] = [];
    public get onDidCloseTerminal(): Event<void> {
        return this.terminalService.onDidCloseTerminal;
    }
    constructor(
        @inject(IFileSystem) private readonly fs: IFileSystem,
        @inject(IInterpreterService) private readonly interpreter: IInterpreterService,
        public readonly terminalService: TerminalService,
        private readonly pythonInterpreter?: PythonEnvironment,
    ) {}
    public dispose() {
        this.terminalService.dispose();
        while (this.disposables.length) {
            const disposable = this.disposables.shift();
            if (disposable) {
                try {
                    disposable.dispose();
                } catch {
                    noop();
                }
            } else {
                break;
            }
        }
    }
    public async sendCommand(
        command: string,
        args: string[],
        cancel?: CancellationToken,
        swallowExceptions: boolean = true,
    ): Promise<void> {
        if (!cancel) {
            return this.terminalService.sendCommand(command, args);
        }
        Cancellation.throwIfCanceled(cancel);
        const completionCancellation = new CancellationTokenSource();
        const executionToken = completionCancellation.token;
        let lockFile: TemporaryFile | undefined;
        let state: ExecutionState | undefined;
        let closeListener: Disposable | undefined;
        let cancelListener: Disposable | undefined;
        let shellEndListener: Disposable | undefined;
        try {
            cancelListener = cancel.onCancellationRequested(() => completionCancellation.cancel());
            if (cancel.isCancellationRequested) {
                completionCancellation.cancel();
            }
            const pythonExec =
                this.pythonInterpreter ||
                (await Cancellation.race(() => this.interpreter.getActiveInterpreter(undefined), executionToken));
            const file = await Cancellation.race(async () => {
                const allocated = await this.createLockFile();
                if (executionToken.isCancellationRequested) {
                    await this.disposeLockFile(allocated);
                } else {
                    lockFile = allocated;
                }
                return allocated;
            }, executionToken);
            const executionState = new ExecutionState(file.filePath, this.fs, [command, ...args]);
            state = executionState;
            const sendArgs = internalScripts.shell_exec(command, file.filePath, args);
            closeListener = this.terminalService.onDidCloseTerminal(() => completionCancellation.cancel());
            const shellEnd = createDeferred<number>();
            await Cancellation.race(
                () =>
                    this.terminalService.sendCommandWithExecution(
                        pythonExec?.path || 'python',
                        sendArgs,
                        executionToken,
                        (execution) => {
                            shellEndListener = this.terminalService.onDidEndTerminalShellExecution((event) => {
                                // An event without an exit code can be an intermediate shell transition.
                                if (event.execution === execution && event.exitCode !== undefined) {
                                    shellEnd.resolve(event.exitCode);
                                }
                            });
                        },
                    ),
                executionToken,
            );
            await Cancellation.race(() => {
                const completion = Promise.race([
                    executionState.completed,
                    shellEnd.promise.then((exitCode) => executionState.completeFromShell(exitCode)),
                ]);
                return swallowExceptions ? completion : completion.catch(noop);
            }, executionToken);
        } finally {
            shellEndListener?.dispose();
            closeListener?.dispose();
            cancelListener?.dispose();
            completionCancellation.dispose();
            state?.dispose();
            if (lockFile) {
                await this.disposeLockFile(lockFile);
            }
        }
    }
    /** @deprecated */
    public sendText(text: string): Promise<void> {
        return this.terminalService.sendText(text);
    }
    public executeCommand(commandLine: string, isPythonShell: boolean): Promise<TerminalShellExecution | undefined> {
        return this.terminalService.executeCommand(commandLine, isPythonShell);
    }
    public show(preserveFocus?: boolean | undefined): Promise<void> {
        return this.terminalService.show(preserveFocus);
    }

    private createLockFile(): Promise<TemporaryFile> {
        return this.fs.createTemporaryFile('.log').then((l) => {
            this.disposables.push(l);
            return l;
        });
    }

    private async disposeLockFile(file: TemporaryFile): Promise<void> {
        try {
            file.dispose();
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException | undefined)?.code;
            if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') {
                throw error;
            }
        }

        // The terminal helper can be opening or updating the marker when cancellation removes it.
        let deletionError: unknown;
        for (const delay of [25, 50, 100]) {
            await sleep(delay);
            try {
                await this.fs.deleteFile(file.filePath);
                return;
            } catch (error) {
                const code = (error as NodeJS.ErrnoException | undefined)?.code;
                if (code === 'ENOENT' || code === 'FileNotFound') {
                    return;
                }
                deletionError = error;
            }
        }
        traceError('Failed to remove the terminal command marker', deletionError);
    }
}
