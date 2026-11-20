// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from 'path';
import { inject, injectable } from 'inversify';
import { CancellationError, ConfigurationChangeEvent, l10n, Uri, WorkspaceFoldersChangeEvent } from 'vscode';
import { LanguageServerChangeHandler } from '../activation/common/languageServerChangeHandler';
import { IExtensionActivationService, ILanguageServerOutputChannel, LanguageServerType } from '../activation/types';
import { IApplicationShell, ICommandManager, IWorkspaceService } from '../common/application/types';
import { IFileSystem } from '../common/platform/types';
import {
    IConfigurationService,
    IDisposableRegistry,
    IExperimentService,
    IExtensions,
    IInterpreterPathService,
    InterpreterConfigurationScope,
    Resource,
} from '../common/types';
import { LanguageService } from '../common/utils/localize';
import { IEnvironmentVariablesProvider } from '../common/variables/types';
import { IInterpreterHelper, IInterpreterService } from '../interpreter/contracts';
import { IServiceContainer } from '../ioc/types';
import { traceError, traceLog } from '../logging';
import { PythonEnvironment } from '../pythonEnvironments/info';
import { JediLSExtensionManager } from './jediLSExtensionManager';
import { NoneLSExtensionManager } from './noneLSExtensionManager';
import { PylanceLSExtensionManager } from './pylanceLSExtensionManager';
import { ILanguageServerExtensionManager, ILanguageServerWatcher } from './types';
import { sendTelemetryEvent } from '../telemetry';
import { EventName } from '../telemetry/constants';
import { StopWatch } from '../common/utils/stopWatch';

interface LanguageServerLifetime {
    readonly key: string;
    shutdown?: Promise<void>;
}

@injectable()
/**
 * The Language Server Watcher class implements the ILanguageServerWatcher interface, which is the one-stop shop for language server activation.
 */
export class LanguageServerWatcher implements IExtensionActivationService, ILanguageServerWatcher {
    public readonly supportedWorkspaceTypes = { untrustedWorkspace: true, virtualWorkspace: true };

    languageServerExtensionManager: ILanguageServerExtensionManager | undefined;

    languageServerType: LanguageServerType;

    private workspaceInterpreters: Map<string, PythonEnvironment | undefined>;

    // In a multiroot workspace scenario we may have multiple language servers running:
    // When using Jedi, there will be one language server per workspace folder.
    // When using Pylance, there will only be one language server for the project.
    private workspaceLanguageServers: Map<string, ILanguageServerExtensionManager | undefined>;

    private readonly activeLanguageServers = new Map<ILanguageServerExtensionManager, LanguageServerLifetime>();

    private readonly pendingRefreshes = new Map<string, { languageServerType: LanguageServerType }>();

    private shutdown?: Promise<void>;

    private registered = false;

    constructor(
        @inject(IServiceContainer) private readonly serviceContainer: IServiceContainer,
        @inject(ILanguageServerOutputChannel) private readonly lsOutputChannel: ILanguageServerOutputChannel,
        @inject(IConfigurationService) private readonly configurationService: IConfigurationService,
        @inject(IExperimentService) private readonly experimentService: IExperimentService,
        @inject(IInterpreterHelper) private readonly interpreterHelper: IInterpreterHelper,
        @inject(IInterpreterPathService) private readonly interpreterPathService: IInterpreterPathService,
        @inject(IInterpreterService) private readonly interpreterService: IInterpreterService,
        @inject(IEnvironmentVariablesProvider) private readonly environmentService: IEnvironmentVariablesProvider,
        @inject(IWorkspaceService) private readonly workspaceService: IWorkspaceService,
        @inject(ICommandManager) private readonly commandManager: ICommandManager,
        @inject(IFileSystem) private readonly fileSystem: IFileSystem,
        @inject(IExtensions) private readonly extensions: IExtensions,
        @inject(IApplicationShell) readonly applicationShell: IApplicationShell,
        @inject(IDisposableRegistry) readonly disposables: IDisposableRegistry,
    ) {
        this.workspaceInterpreters = new Map();
        this.workspaceLanguageServers = new Map();
        this.languageServerType = this.configurationService.getSettings().languageServer;
        this.disposables.push({
            dispose: () => {
                if (!this.shutdown) {
                    this.shutdown = this.disposeLanguageServers();
                }
                return this.shutdown;
            },
        });
    }

    // IExtensionActivationService

    public async activate(resource?: Resource, startupStopWatch?: StopWatch): Promise<void> {
        this.register();
        await this.startLanguageServer(this.languageServerType, resource, startupStopWatch);
    }

    // ILanguageServerWatcher
    public async startLanguageServer(
        languageServerType: LanguageServerType,
        resource?: Resource,
        startupStopWatch?: StopWatch,
    ): Promise<void> {
        await this.startAndGetLanguageServer(languageServerType, resource, startupStopWatch);
    }

    public register(): void {
        if (!this.registered && !this.shutdown) {
            this.registered = true;
            this.disposables.push(
                this.workspaceService.onDidChangeConfiguration(this.onDidChangeConfiguration.bind(this)),
            );

            this.disposables.push(
                this.workspaceService.onDidChangeWorkspaceFolders(this.onDidChangeWorkspaceFolders.bind(this)),
            );

            this.disposables.push(
                this.interpreterService.onDidChangeInterpreterInformation(this.onDidChangeInterpreterInformation, this),
            );

            if (this.workspaceService.isTrusted) {
                this.disposables.push(this.interpreterPathService.onDidChange(this.onDidChangeInterpreter.bind(this)));
            }

            this.disposables.push(
                this.extensions.onDidChange(async () => {
                    await this.extensionsChangeHandler();
                }),
            );

            this.disposables.push(
                new LanguageServerChangeHandler(
                    this.languageServerType,
                    this.extensions,
                    this.applicationShell,
                    this.commandManager,
                    this.workspaceService,
                    this.configurationService,
                ),
            );
        }
    }

    private async startAndGetLanguageServer(
        languageServerType: LanguageServerType,
        resource?: Resource,
        startupStopWatch?: StopWatch,
        isCurrent = () => true,
    ): Promise<ILanguageServerExtensionManager | undefined> {
        if (this.shutdown || !isCurrent()) {
            return undefined;
        }

        const lsResource = this.getWorkspaceUri(resource);
        const currentInterpreter = this.workspaceInterpreters.get(lsResource.fsPath);
        const interpreter = await this.interpreterService?.getActiveInterpreter(resource);
        if (this.shutdown || !isCurrent()) {
            return undefined;
        }

        // Destroy the old language server if it's different.
        if (currentInterpreter && interpreter !== currentInterpreter) {
            await this.stopLanguageServer(lsResource);
            if (this.shutdown || !isCurrent()) {
                return undefined;
            }
        }

        // If the interpreter is Python 2 and the LS setting is explicitly set to Jedi, turn it off.
        // If set to Default, use Pylance.
        let serverType = languageServerType;
        if (interpreter && (interpreter.version?.major ?? 0) < 3) {
            if (serverType === LanguageServerType.Jedi) {
                serverType = LanguageServerType.None;
            } else if (this.getCurrentLanguageServerTypeIsDefault()) {
                serverType = LanguageServerType.Node;
            }
        }

        if (
            !this.workspaceService.isTrusted &&
            serverType !== LanguageServerType.Node &&
            serverType !== LanguageServerType.None
        ) {
            traceLog(LanguageService.untrustedWorkspaceMessage);
            serverType = LanguageServerType.None;
        }

        // If the language server type is Pylance or None,
        // We only need to instantiate the language server once, even in multiroot workspace scenarios,
        // so we only need one language server extension manager.
        const key = this.getWorkspaceKey(resource, serverType);
        let languageServer = this.workspaceLanguageServers.get(key);
        while (languageServer) {
            const stopping = this.activeLanguageServers.get(languageServer)?.shutdown;
            if (!stopping) {
                break;
            }
            await stopping;
            if (this.shutdown || !isCurrent()) {
                return undefined;
            }
            languageServer = this.workspaceLanguageServers.get(key);
        }

        if ((serverType === LanguageServerType.Node || serverType === LanguageServerType.None) && languageServer) {
            logStartup(serverType, lsResource);
            return languageServer;
        }

        // Instantiate the language server extension manager.
        const languageServerExtensionManager = this.createLanguageServer(serverType, lsResource);
        const lifetime: LanguageServerLifetime = { key };
        this.activeLanguageServers.set(languageServerExtensionManager, lifetime);
        this.workspaceLanguageServers.set(key, languageServerExtensionManager);

        if (languageServerExtensionManager.canStartLanguageServer(interpreter)) {
            // Start the language server.
            if (startupStopWatch) {
                // It means that startup is triggering this code, track time it takes since startup to activate this code.
                sendTelemetryEvent(EventName.LANGUAGE_SERVER_TRIGGER_TIME, startupStopWatch.elapsedTime, {
                    triggerTime: startupStopWatch.elapsedTime,
                });
            }
            await languageServerExtensionManager.startLanguageServer(lsResource, interpreter);

            if (!this.shutdown && !lifetime.shutdown && isCurrent()) {
                logStartup(languageServerType, lsResource);
                this.languageServerType = languageServerType;
                this.workspaceInterpreters.set(lsResource.fsPath, interpreter);
            }
        } else {
            await languageServerExtensionManager.languageServerNotAvailable();
        }

        return this.shutdown || lifetime.shutdown || !isCurrent() ? undefined : languageServerExtensionManager;
    }

    public async restartLanguageServers(): Promise<void> {
        this.workspaceLanguageServers.forEach(async (_, resourceString) => {
            sendTelemetryEvent(EventName.LANGUAGE_SERVER_RESTART, undefined, { reason: 'notebooksExperiment' });
            const resource = Uri.parse(resourceString);
            await this.stopLanguageServer(resource);
            await this.startLanguageServer(this.languageServerType, resource);
        });
    }

    public async get(resource?: Resource): Promise<ILanguageServerExtensionManager> {
        if (this.shutdown) {
            throw new CancellationError();
        }
        const key = this.getWorkspaceKey(resource, this.languageServerType);
        let languageServerExtensionManager = this.workspaceLanguageServers.get(key);

        if (!languageServerExtensionManager) {
            languageServerExtensionManager = await this.startAndGetLanguageServer(this.languageServerType, resource);
        }

        if (!languageServerExtensionManager || this.shutdown) {
            throw new CancellationError();
        }
        return languageServerExtensionManager;
    }

    // Private methods

    private async stopLanguageServer(resource?: Resource, languageServerType = this.languageServerType): Promise<void> {
        const key = this.getWorkspaceKey(resource, languageServerType);
        const languageServerExtensionManager = this.workspaceLanguageServers.get(key);

        if (languageServerExtensionManager) {
            await this.retireLanguageServer(languageServerExtensionManager);
        }
    }

    private async retireLanguageServer(languageServer: ILanguageServerExtensionManager): Promise<void> {
        const lifetime = this.activeLanguageServers.get(languageServer);
        if (!lifetime) {
            return;
        }
        if (!lifetime.shutdown) {
            lifetime.shutdown = this.stopAndDisposeLanguageServer(languageServer, lifetime);
        }
        await lifetime.shutdown;
    }

    private async stopAndDisposeLanguageServer(
        languageServer: ILanguageServerExtensionManager,
        lifetime: LanguageServerLifetime,
    ): Promise<void> {
        // Prevent reentrant acquisition or retirement before the shutdown promise is assigned.
        await Promise.resolve();
        try {
            await languageServer.stopLanguageServer();
        } finally {
            this.activeLanguageServers.delete(languageServer);
            if (this.workspaceLanguageServers.get(lifetime.key) === languageServer) {
                this.workspaceLanguageServers.delete(lifetime.key);
            }
            languageServer.dispose();
        }
    }

    private async disposeLanguageServers(): Promise<void> {
        this.workspaceLanguageServers.clear();
        this.workspaceInterpreters.clear();
        this.pendingRefreshes.clear();
        await Promise.all(
            [...this.activeLanguageServers.keys()].map(async (languageServer) => {
                try {
                    await this.retireLanguageServer(languageServer);
                } catch (error) {
                    traceError('Failed to stop language server during extension shutdown', error);
                }
            }),
        );
    }

    private createLanguageServer(
        languageServerType: LanguageServerType,
        resource: Uri,
    ): ILanguageServerExtensionManager {
        const replaceStartingServer = () => this.refreshLanguageServer(resource, true);
        let lsManager: ILanguageServerExtensionManager;
        switch (languageServerType) {
            case LanguageServerType.Jedi:
                lsManager = new JediLSExtensionManager(
                    this.serviceContainer,
                    this.lsOutputChannel,
                    this.experimentService,
                    this.workspaceService,
                    this.configurationService,
                    this.interpreterPathService,
                    this.interpreterService,
                    this.environmentService,
                    this.commandManager,
                    replaceStartingServer,
                );
                break;
            case LanguageServerType.Node:
                lsManager = new PylanceLSExtensionManager(
                    this.serviceContainer,
                    this.lsOutputChannel,
                    this.experimentService,
                    this.workspaceService,
                    this.configurationService,
                    this.interpreterPathService,
                    this.interpreterService,
                    this.environmentService,
                    this.commandManager,
                    this.fileSystem,
                    this.extensions,
                    this.applicationShell,
                    replaceStartingServer,
                );
                break;
            case LanguageServerType.None:
            default:
                lsManager = new NoneLSExtensionManager();
                break;
        }

        return lsManager;
    }

    private async refreshLanguageServer(resource?: Resource, forced?: boolean): Promise<void> {
        if (this.shutdown) {
            return;
        }

        const lsResource = this.getWorkspaceUri(resource);
        const languageServerType = this.configurationService.getSettings(lsResource).languageServer;
        const currentRefresh = this.pendingRefreshes.get(lsResource.fsPath);
        if (!forced && languageServerType === (currentRefresh?.languageServerType ?? this.languageServerType)) {
            return;
        }

        const refresh = { languageServerType };
        this.pendingRefreshes.set(lsResource.fsPath, refresh);
        const isCurrent = () => this.pendingRefreshes.get(lsResource.fsPath) === refresh;
        try {
            await Promise.all([
                this.stopLanguageServer(resource),
                currentRefresh && currentRefresh.languageServerType !== this.languageServerType
                    ? this.stopLanguageServer(resource, currentRefresh.languageServerType)
                    : undefined,
            ]);
            await this.startAndGetLanguageServer(languageServerType, lsResource, undefined, isCurrent);
        } finally {
            if (isCurrent()) {
                this.pendingRefreshes.delete(lsResource.fsPath);
            }
        }
    }

    private getCurrentLanguageServerTypeIsDefault(): boolean {
        return this.configurationService.getSettings().languageServerIsDefault;
    }

    // Watch for settings changes.
    private async onDidChangeConfiguration(event: ConfigurationChangeEvent): Promise<void> {
        const workspacesUris = this.workspaceService.workspaceFolders?.map((workspace) => workspace.uri) ?? [];

        await Promise.all(
            workspacesUris.map(async (resource) => {
                if (event.affectsConfiguration(`python.languageServer`, resource)) {
                    await this.refreshLanguageServer(resource);
                } else if (event.affectsConfiguration(`python.analysis.pylanceLspClientEnabled`, resource)) {
                    await this.refreshLanguageServer(resource, /* forced */ true);
                }
            }),
        );
    }

    // Watch for interpreter changes.
    private async onDidChangeInterpreter(event: InterpreterConfigurationScope): Promise<void> {
        if (this.languageServerType === LanguageServerType.Node) {
            // Pylance client already handles interpreter changes, so restarting LS can be skipped.
            return Promise.resolve();
        }
        // Reactivate the language server (if in a multiroot workspace scenario, pick the correct one).
        return this.activate(event.uri);
    }

    // Watch for interpreter information changes.
    private async onDidChangeInterpreterInformation(info: PythonEnvironment): Promise<void> {
        if (!info.envPath || info.envPath === '') {
            return;
        }

        // Find the interpreter and workspace that got updated (if any).
        const iterator = this.workspaceInterpreters.entries();

        let result = iterator.next();
        let done = result.done || false;

        while (!done) {
            const [resourcePath, interpreter] = result.value as [string, PythonEnvironment | undefined];
            const resource = Uri.parse(resourcePath);

            // Restart the language server if the interpreter path changed (#18995).
            if (info.envPath === interpreter?.envPath && info.path !== interpreter?.path) {
                await this.activate(resource);
                done = true;
            } else {
                result = iterator.next();
                done = result.done || false;
            }
        }
    }

    // Watch for extension changes.
    private async extensionsChangeHandler(): Promise<void> {
        const languageServerType = this.configurationService.getSettings().languageServer;

        if (languageServerType !== this.languageServerType) {
            await this.refreshLanguageServer();
        }
    }

    // Watch for workspace folder changes.
    private async onDidChangeWorkspaceFolders(event: WorkspaceFoldersChangeEvent): Promise<void> {
        // Since Jedi is the only language server type where we instantiate multiple language servers,
        // Make sure to dispose of them only in that scenario.
        if (event.removed.length && this.languageServerType === LanguageServerType.Jedi) {
            for (const workspace of event.removed) {
                await this.stopLanguageServer(workspace.uri);
            }
        }
    }

    // Get the workspace Uri for the given resource, in order to query this.workspaceInterpreters and this.workspaceLanguageServers.
    private getWorkspaceUri(resource?: Resource): Uri {
        let uri;

        if (resource) {
            uri = this.workspaceService.getWorkspaceFolder(resource)?.uri;
        } else {
            uri = this.interpreterHelper.getActiveWorkspaceUri(resource)?.folderUri;
        }

        return uri ?? Uri.parse('default');
    }

    // Get the key used to identify which language server extension manager is associated to which workspace.
    // When using Pylance or having no LS enabled, we return a static key since there should only be one LS extension manager for these LS types.
    private getWorkspaceKey(resource: Resource | undefined, languageServerType: LanguageServerType): string {
        switch (languageServerType) {
            case LanguageServerType.Node:
                return 'Pylance';
            case LanguageServerType.None:
                return 'None';
            default:
                return this.getWorkspaceUri(resource).fsPath;
        }
    }
}

function logStartup(languageServerType: LanguageServerType, resource: Uri): void {
    let outputLine;
    const basename = path.basename(resource.fsPath);

    switch (languageServerType) {
        case LanguageServerType.Jedi:
            outputLine = l10n.t('Starting Jedi language server for {0}.', basename);
            break;
        case LanguageServerType.Node:
            outputLine = LanguageService.startingPylance;
            break;
        case LanguageServerType.None:
            outputLine = LanguageService.startingNone;
            break;
        default:
            throw new Error(`Unknown language server type: ${languageServerType}`);
    }
    traceLog(outputLine);
}
