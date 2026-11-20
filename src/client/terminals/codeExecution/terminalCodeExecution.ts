// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { inject, injectable } from 'inversify';
import * as path from 'path';
import { CancellationError, Disposable, TerminalOptions, Uri } from 'vscode';
import { IApplicationShell, ICommandManager, IWorkspaceService } from '../../common/application/types';
import '../../common/extensions';
import { IPlatformService } from '../../common/platform/types';
import { ITerminalService, ITerminalServiceFactory } from '../../common/terminal/types';
import { IConfigurationService, IDisposableRegistry, Resource } from '../../common/types';
import { createDeferred } from '../../common/utils/async';
import { Diagnostics, Repl } from '../../common/utils/localize';
import { showWarningMessage } from '../../common/vscodeApis/windowApis';
import { IInterpreterService } from '../../interpreter/contracts';
import { traceInfo } from '../../logging';
import { buildPythonExecInfo, PythonExecInfo } from '../../pythonEnvironments/exec';
import { ICodeExecutionService } from '../../terminals/types';
import { EventName } from '../../telemetry/constants';
import { sendTelemetryEvent } from '../../telemetry';

@injectable()
export class TerminalCodeExecutionProvider implements ICodeExecutionService {
    private hasRanOutsideCurrentDrive = false;
    protected terminalTitle!: string;
    protected terminalIcon?: TerminalOptions['iconPath'];
    private replActive?: { startup: Promise<void>; dispose(): void };

    constructor(
        @inject(ITerminalServiceFactory) protected readonly terminalServiceFactory: ITerminalServiceFactory,
        @inject(IConfigurationService) protected readonly configurationService: IConfigurationService,
        @inject(IWorkspaceService) protected readonly workspace: IWorkspaceService,
        @inject(IDisposableRegistry) protected readonly disposables: Disposable[],
        @inject(IPlatformService) protected readonly platformService: IPlatformService,
        @inject(IInterpreterService) protected readonly interpreterService: IInterpreterService,
        @inject(ICommandManager) protected readonly commandManager: ICommandManager,
        @inject(IApplicationShell) protected readonly applicationShell: IApplicationShell,
    ) {
        this.disposables.push(new Disposable(() => this.replActive?.dispose()));
    }

    public async executeFile(file: Uri, options?: { newTerminalPerFile: boolean }) {
        await this.setCwdForFileExecution(file, options);
        const { command, args } = await this.getExecuteFileArgs(file, [
            file.fsPath.fileToCommandArgumentForPythonExt(),
        ]);

        await this.getTerminalService(file, options).sendCommand(command, args);
    }

    public async execute(code: string, resource?: Uri): Promise<void> {
        if (!code || code.trim().length === 0) {
            return;
        }
        await this.initializeRepl(resource);
        if (code == 'deprecated') {
            // If user is trying to smart send deprecated code show warning
            const selection = await showWarningMessage(Diagnostics.invalidSmartSendMessage, Repl.disableSmartSend);
            traceInfo(`Selected file contains invalid Python or Deprecated Python 2 code`);
            if (selection === Repl.disableSmartSend) {
                this.configurationService.updateSetting('REPL.enableREPLSmartSend', false, resource);
            }
        } else {
            await this.getTerminalService(resource).executeCommand(code, true);
        }
    }

    public async initializeRepl(resource: Resource) {
        const terminalService = this.getTerminalService(resource);
        const current = this.replActive;
        if (current) {
            await current.startup;
            if (this.replActive !== current) {
                throw new CancellationError();
            }
            await terminalService.show();
            return;
        }
        sendTelemetryEvent(EventName.REPL, undefined, { replType: 'Terminal' });
        const canceled = createDeferred<never>();
        let terminalCloseListener: Disposable | undefined;
        const currentStartup = {
            startup: this.startRepl(terminalService, resource, canceled.promise),
            dispose: () => {
                if (this.replActive === currentStartup) {
                    this.replActive = undefined;
                    terminalCloseListener?.dispose();
                    canceled.reject(new CancellationError());
                }
            },
        };
        this.replActive = currentStartup;
        terminalCloseListener = terminalService.onDidCloseTerminal(currentStartup.dispose);
        try {
            await currentStartup.startup;
        } catch (error) {
            currentStartup.dispose();
            throw error;
        }
    }

    private async startRepl(
        terminalService: ITerminalService,
        resource: Resource,
        canceled: Promise<never>,
    ): Promise<void> {
        const { command, args } = await Promise.race([this.getExecutableInfo(resource), canceled]);
        const prompt = createDeferred<void>();
        let listener: Disposable | undefined;
        let timeout: NodeJS.Timeout | undefined;
        let count = 0;
        const stopWaitingForPrompt = () => {
            clearTimeout(timeout);
            listener?.dispose();
            listener = undefined;
            prompt.resolve();
        };
        try {
            listener = this.applicationShell.onDidWriteTerminalData((event) => {
                for (const character of event.data) {
                    if (character === '>') {
                        count++;
                        if (count === 3) {
                            stopWaitingForPrompt();
                        }
                    }
                }
            });
            timeout = setTimeout(stopWaitingForPrompt, 3000);
            await Promise.race([Promise.all([terminalService.sendCommand(command, args), prompt.promise]), canceled]);
        } finally {
            stopWaitingForPrompt();
        }
    }

    public async getExecutableInfo(resource?: Uri, args: string[] = []): Promise<PythonExecInfo> {
        const pythonSettings = this.configurationService.getSettings(resource);
        const interpreter = await this.interpreterService.getActiveInterpreter(resource);
        const interpreterPath = interpreter?.path ?? pythonSettings.pythonPath;
        const command = this.platformService.isWindows ? interpreterPath.replace(/\\/g, '/') : interpreterPath;
        const launchArgs = pythonSettings.terminal.launchArgs;
        return buildPythonExecInfo(command, [...launchArgs, ...args]);
    }

    // Overridden in subclasses, see djangoShellCodeExecution.ts
    public async getExecuteFileArgs(resource?: Uri, executeArgs: string[] = []): Promise<PythonExecInfo> {
        return this.getExecutableInfo(resource, executeArgs);
    }
    private getTerminalService(resource: Resource, options?: { newTerminalPerFile: boolean }): ITerminalService {
        return this.terminalServiceFactory.getTerminalService({
            resource,
            title: this.terminalTitle,
            iconPath: this.terminalIcon,
            newTerminalPerFile: options?.newTerminalPerFile,
        });
    }
    private async setCwdForFileExecution(file: Uri, options?: { newTerminalPerFile: boolean }) {
        const pythonSettings = this.configurationService.getSettings(file);
        if (!pythonSettings.terminal.executeInFileDir) {
            return;
        }
        const fileDirPath = path.dirname(file.fsPath);
        if (fileDirPath.length > 0) {
            if (this.platformService.isWindows && /[a-z]\:/i.test(fileDirPath)) {
                const currentDrive =
                    typeof this.workspace.rootPath === 'string'
                        ? this.workspace.rootPath.replace(/\:.*/g, '')
                        : undefined;
                const fileDrive = fileDirPath.replace(/\:.*/g, '');
                if (fileDrive !== currentDrive || this.hasRanOutsideCurrentDrive) {
                    this.hasRanOutsideCurrentDrive = true;
                    await this.getTerminalService(file).sendText(`${fileDrive}:`);
                }
            }
            await this.getTerminalService(file, options).sendText(
                `cd ${fileDirPath.fileToCommandArgumentForPythonExt()}`,
            );
        }
    }
}
