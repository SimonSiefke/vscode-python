// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { Terminal } from 'vscode';
import { traceVerbose } from '../../../logging';
import { sleep } from '../../utils/async';
import { ITerminalActivator, ITerminalHelper, TerminalActivationOptions, TerminalShellType } from '../types';

export class BaseTerminalActivator implements ITerminalActivator {
    constructor(private readonly helper: ITerminalHelper) {}
    public async activateEnvironmentInTerminal(
        terminal: Terminal,
        options?: TerminalActivationOptions,
    ): Promise<boolean> {
        const terminalShellType = this.helper.identifyTerminalShell(terminal);

        const activationCommands = await this.helper.getEnvironmentActivationCommands(
            terminalShellType,
            options?.resource,
            options?.interpreter,
        );
        let activated = false;
        if (activationCommands) {
            for (const command of activationCommands) {
                terminal.show(options?.preserveFocus);
                traceVerbose(`Command sent to terminal: ${command}`);
                terminal.sendText(command);
                await this.waitForCommandToProcess(terminalShellType);
                activated = true;
            }
        }
        return activated;
    }
    protected async waitForCommandToProcess(_shell: TerminalShellType) {
        // Give the command some time to complete.
        // Its been observed that sending commands too early will strip some text off in VS Code Terminal.
        await sleep(500);
    }
}
