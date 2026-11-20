// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import '../../common/extensions';

import { ICommandManager } from '../../common/application/types';
import { IDisposable, IExtensions, Resource } from '../../common/types';
import { debounceSync } from '../../common/utils/decorators';
import { IServiceContainer } from '../../ioc/types';
import { PythonEnvironment } from '../../pythonEnvironments/info';
import { captureTelemetry, sendTelemetryEvent } from '../../telemetry';
import { EventName } from '../../telemetry/constants';
import { Commands } from '../commands';
import { NodeLanguageClientMiddleware } from './languageClientMiddleware';
import { ILanguageServerAnalysisOptions, ILanguageServerManager } from '../types';
import { traceDecoratorError, traceDecoratorVerbose } from '../../logging';
import { PYLANCE_EXTENSION_ID } from '../../common/constants';
import { NodeLanguageServerProxy } from './languageServerProxy';

export class NodeLanguageServerManager implements ILanguageServerManager {
    private resource!: Resource;

    private interpreter: PythonEnvironment | undefined;

    private middleware: NodeLanguageClientMiddleware | undefined;

    private disposables: IDisposable[] = [];

    private connected = false;

    private closed = false;

    private initialStartup?: Promise<void>;

    private restarting?: Promise<void>;

    private lsVersion: string | undefined;

    private started = false;

    private static commandDispose: IDisposable;

    constructor(
        private readonly serviceContainer: IServiceContainer,
        private readonly analysisOptions: ILanguageServerAnalysisOptions,
        private readonly languageServerProxy: NodeLanguageServerProxy,
        commandManager: ICommandManager,
        private readonly extensions: IExtensions,
        private readonly replaceStartingServer?: () => Promise<void>,
    ) {
        if (NodeLanguageServerManager.commandDispose) {
            NodeLanguageServerManager.commandDispose.dispose();
        }
        NodeLanguageServerManager.commandDispose = commandManager.registerCommand(Commands.RestartLS, () => {
            sendTelemetryEvent(EventName.LANGUAGE_SERVER_RESTART, undefined, { reason: 'command' });
            // The companion queues subsequent operations behind its current startup.
            if (
                !this.closed &&
                this.replaceStartingServer &&
                (this.initialStartup || this.restarting) &&
                !this.languageServerProxy.usesPylanceClientApi
            ) {
                this.replaceStartingServer().ignoreErrors();
            } else {
                this.restartLanguageServer().ignoreErrors();
            }
        });
    }

    private static versionTelemetryProps(instance: NodeLanguageServerManager) {
        return {
            lsVersion: instance.lsVersion,
        };
    }

    public dispose(): void {
        this.stop().ignoreErrors();
        NodeLanguageServerManager.commandDispose?.dispose();
        this.disposables.forEach((d) => d.dispose());
    }

    @traceDecoratorError('Failed to start language server')
    public async start(resource: Resource, interpreter: PythonEnvironment | undefined): Promise<void> {
        this.initialStartup = this.startInitialClient(resource, interpreter);
        try {
            await this.initialStartup;
        } finally {
            this.initialStartup = undefined;
        }
    }

    private async startInitialClient(resource: Resource, interpreter: PythonEnvironment | undefined): Promise<void> {
        if (this.started) {
            throw new Error('Language server already started');
        }
        this.resource = resource;
        this.interpreter = interpreter;
        this.analysisOptions.onDidChange(this.restartLanguageServerDebounced, this, this.disposables);

        const extension = this.extensions.getExtension(PYLANCE_EXTENSION_ID);
        this.lsVersion = extension?.packageJSON.version || '0';

        await this.analysisOptions.initialize(resource, interpreter);
        await this.startLanguageServer();

        this.started = !this.closed;
    }

    public async stop(): Promise<void> {
        this.closed = true;
        const wasConnected = this.connected;
        this.disconnect();
        try {
            await this.languageServerProxy.close();
        } catch (error) {
            this.closed = false;
            if (wasConnected) {
                this.connect();
            }
            throw error;
        }
    }

    public connect(): void {
        if (!this.closed && !this.connected) {
            this.connected = true;
            this.middleware?.connect();
        }
    }

    public disconnect(): void {
        if (this.connected) {
            this.connected = false;
            this.middleware?.disconnect();
        }
    }

    @debounceSync(1000)
    protected restartLanguageServerDebounced(): void {
        sendTelemetryEvent(EventName.LANGUAGE_SERVER_RESTART, undefined, { reason: 'settings' });
        this.restartLanguageServer().ignoreErrors();
    }

    @traceDecoratorError('Failed to restart language server')
    @traceDecoratorVerbose('Restarting language server')
    protected async restartLanguageServer(): Promise<void> {
        if (this.closed) {
            return;
        }
        if (!this.restarting) {
            this.restarting = this.restartClient().finally(() => {
                this.restarting = undefined;
            });
        }
        await this.restarting;
    }

    private async restartClient(): Promise<void> {
        await this.initialStartup?.catch(() => undefined);
        if (this.closed) {
            return;
        }
        await this.languageServerProxy.stop();
        if (!this.closed) {
            await this.startLanguageServer();
        }
    }

    @captureTelemetry(
        EventName.LANGUAGE_SERVER_STARTUP,
        undefined,
        true,
        undefined,
        NodeLanguageServerManager.versionTelemetryProps,
    )
    @traceDecoratorVerbose('Starting language server')
    protected async startLanguageServer(): Promise<void> {
        if (this.closed) {
            return;
        }
        const options = await this.analysisOptions.getAnalysisOptions();
        if (this.closed) {
            return;
        }
        this.middleware = new NodeLanguageClientMiddleware(this.serviceContainer, this.lsVersion);
        options.middleware = this.middleware;

        // Make sure the middleware is connected if we restart and we we're already connected.
        if (this.connected) {
            this.middleware.connect();
        }

        // Then use this middleware to start a new language client.
        await this.languageServerProxy.start(this.resource, this.interpreter, options);
    }
}
