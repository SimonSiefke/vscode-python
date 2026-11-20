// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import type { ChildProcess } from 'child_process';
import { CloseAction, LanguageClient, MessageTransports, State } from 'vscode-languageclient/node';

export class LanguageServerClient extends LanguageClient {
    private startupCancelled = false;

    private transportCreated = false;

    public cancelStartup(): void {
        if (this.startupCancelled) {
            return;
        }
        this.startupCancelled = true;

        // Join the client's existing start promise before closing the connection.
        // The language client can otherwise clear that promise before its first caller observes the rejection.
        if (this.state === State.Starting || this.state === State.Running) {
            super.start().catch(() => undefined);
        }

        this.clientOptions.initializationFailedHandler = () => false;
        this.clientOptions.errorHandler!.closed = () => ({ action: CloseAction.DoNotRestart, handled: true });
        if (this.transportCreated) {
            this.scheduleStartupTermination();
        }
    }

    public stop(timeout?: number): Promise<void> {
        if (this.startupCancelled && this.state === State.Starting) {
            return Promise.resolve();
        }
        return super.stop(timeout);
    }

    protected async createMessageTransports(encoding: string): Promise<MessageTransports> {
        this.transportCreated = false;
        const transports = await super.createMessageTransports(encoding);
        this.transportCreated = true;
        if (this.startupCancelled) {
            this.scheduleStartupTermination();
        }
        return transports;
    }

    public error(message: string, data?: unknown, showNotification?: boolean | 'force'): void {
        if (!this.startupCancelled) {
            super.error(message, data, showNotification);
        }
    }

    private scheduleStartupTermination(): void {
        // Let the language client attach its close handler before terminating the transport.
        // That handler releases the diagnostics allocated before opening the connection.
        const server = ((this as unknown) as { _serverProcess?: ChildProcess })._serverProcess;
        setImmediate(() => server?.kill('SIGKILL'));
    }
}
