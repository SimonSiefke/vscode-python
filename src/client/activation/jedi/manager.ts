// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as fs from 'fs-extra';
import * as path from 'path';
import '../../common/extensions';

import { ICommandManager } from '../../common/application/types';
import { IDisposable, Resource } from '../../common/types';
import { debounceSync } from '../../common/utils/decorators';
import { EXTENSION_ROOT_DIR } from '../../constants';
import { IServiceContainer } from '../../ioc/types';
import { PythonEnvironment } from '../../pythonEnvironments/info';
import { captureTelemetry } from '../../telemetry';
import { EventName } from '../../telemetry/constants';
import { Commands } from '../commands';
import { JediLanguageClientMiddleware } from './languageClientMiddleware';
import { ILanguageServerAnalysisOptions, ILanguageServerManager, ILanguageServerProxy } from '../types';
import { traceDecoratorError, traceDecoratorVerbose, traceVerbose } from '../../logging';

export class JediLanguageServerManager implements ILanguageServerManager {
    private resource!: Resource;

    private interpreter: PythonEnvironment | undefined;

    private middleware: JediLanguageClientMiddleware | undefined;

    private disposables: IDisposable[] = [];

    private static commandDispose: IDisposable;

    private connected = false;

    private closed = false;

    private initialStartup?: Promise<void>;

    private restarting?: Promise<void>;

    private lsVersion: string | undefined;

    constructor(
        private readonly serviceContainer: IServiceContainer,
        private readonly analysisOptions: ILanguageServerAnalysisOptions,
        private readonly languageServerProxy: ILanguageServerProxy,
        commandManager: ICommandManager,
        private readonly replaceStartingServer?: () => Promise<void>,
    ) {
        if (JediLanguageServerManager.commandDispose) {
            JediLanguageServerManager.commandDispose.dispose();
        }
        JediLanguageServerManager.commandDispose = commandManager.registerCommand(Commands.RestartLS, () => {
            if (!this.closed && this.replaceStartingServer && (this.initialStartup || this.restarting)) {
                this.replaceStartingServer().ignoreErrors();
            } else {
                this.restartLanguageServer().ignoreErrors();
            }
        });
    }

    private static versionTelemetryProps(instance: JediLanguageServerManager) {
        return {
            lsVersion: instance.lsVersion,
        };
    }

    public dispose(): void {
        this.stop().ignoreErrors();
        JediLanguageServerManager.commandDispose?.dispose();
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
        this.resource = resource;
        this.interpreter = interpreter;
        this.analysisOptions.onDidChange(this.restartLanguageServerDebounced, this, this.disposables);

        try {
            // Version is actually hardcoded in our requirements.txt.
            const requirementsTxt = await fs.readFile(
                path.join(EXTENSION_ROOT_DIR, 'python_files', 'jedilsp_requirements', 'requirements.txt'),
                'utf-8',
            );

            // Search using a regex in the text
            const match = /jedi-language-server==([0-9\.]*)/.exec(requirementsTxt);
            if (match && match.length === 2) {
                [, this.lsVersion] = match;
            }
        } catch (ex) {
            // Getting version here is best effort and does not affect how LS works and
            // failing to get version should not stop LS from working.
            traceVerbose('Failed to get jedi-language-server version: ', ex);
        }

        if (this.closed) {
            return;
        }
        await this.analysisOptions.initialize(resource, interpreter);
        await this.startLanguageServer();
    }

    public stop(): Promise<void> {
        this.closed = true;
        this.disconnect();
        return this.languageServerProxy.close();
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
        EventName.JEDI_LANGUAGE_SERVER_STARTUP,
        undefined,
        true,
        undefined,
        JediLanguageServerManager.versionTelemetryProps,
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
        this.middleware = new JediLanguageClientMiddleware(this.serviceContainer, this.lsVersion);
        options.middleware = this.middleware;

        // Make sure the middleware is connected if we restart and we we're already connected.
        if (this.connected) {
            this.middleware.connect();
        }

        // Then use this middleware to start a new language client.
        await this.languageServerProxy.start(this.resource, this.interpreter, options);
    }
}
