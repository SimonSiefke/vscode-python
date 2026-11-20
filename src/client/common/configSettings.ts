/// <reference lib="es2021.weakref" />

'use strict';

// eslint-disable-next-line camelcase
import * as path from 'path';
import * as fs from 'fs';
import {
    ConfigurationChangeEvent,
    ConfigurationTarget,
    Disposable,
    Event,
    EventEmitter,
    Uri,
    WorkspaceConfiguration,
    WorkspaceFolder,
    WorkspaceFoldersChangeEvent,
} from 'vscode';
import { LanguageServerType } from '../activation/types';
import './extensions';
import { IInterpreterAutoSelectionProxyService } from '../interpreter/autoSelection/types';
import { traceError } from '../logging';
import { sendTelemetryEvent } from '../telemetry';
import { EventName } from '../telemetry/constants';
import { sendSettingTelemetry } from '../telemetry/envFileTelemetry';
import { ITestingSettings } from '../testing/configuration/types';
import { IWorkspaceService } from './application/types';
import { WorkspaceService } from './application/workspace';
import { DEFAULT_INTERPRETER_SETTING, isTestExecution, PYREFLY_EXTENSION_ID } from './constants';
import {
    IAutoCompleteSettings,
    IDefaultLanguageServer,
    IExperiments,
    IExtensions,
    IInterpreterPathService,
    IInterpreterSettings,
    IPythonSettings,
    IREPLSettings,
    ITerminalSettings,
    Resource,
} from './types';
import { debounceSync } from './utils/decorators';
import { SystemVariables } from './variables/systemVariables';
import { getOSType, OSType, isWindows } from './utils/platform';
import { untildify } from './helpers';

interface FolderSettingsOwner {
    readonly settings: WeakRef<PythonSettings>;
    folder: WeakRef<WorkspaceFolder>;
}

export class PythonSettings implements IPythonSettings {
    // eslint-disable-next-line class-methods-use-this
    public static onConfigChange(): Event<ConfigurationChangeEvent | undefined> {
        return PythonSettings.configChanged.event;
    }

    public get pythonPath(): string {
        return this._pythonPath;
    }

    public set pythonPath(value: string) {
        if (this._pythonPath === value) {
            return;
        }
        // Add support for specifying just the directory where the python executable will be located.
        // E.g. virtual directory name.
        try {
            this._pythonPath = this.getPythonExecutable(value);
        } catch (ex) {
            this._pythonPath = value;
        }
    }

    public get defaultInterpreterPath(): string {
        return this._defaultInterpreterPath;
    }

    public set defaultInterpreterPath(value: string) {
        if (this._defaultInterpreterPath === value) {
            return;
        }
        // Add support for specifying just the directory where the python executable will be located.
        // E.g. virtual directory name.
        try {
            this._defaultInterpreterPath = this.getPythonExecutable(value);
        } catch (ex) {
            this._defaultInterpreterPath = value;
        }
    }

    // VS Code can expose an optimistic folder even at startup and roll back without an event.
    // Neither a synchronous lookup nor the lifetime of a WorkspaceFolder proves it was confirmed.
    private static readonly ownersByUri = new Map<string, FolderSettingsOwner>();

    private static readonly collectedOwners = new FinalizationRegistry<{ key: string; owner: FolderSettingsOwner }>(
        ({ key, owner }) => {
            if (PythonSettings.ownersByUri.get(key) === owner) {
                PythonSettings.ownersByUri.delete(key);
            }
        },
    );

    private static globalSettings: PythonSettings | undefined;

    private static subscriptions: Disposable[] | undefined;

    public envFile = '';

    public venvPath = '';

    public interpreter!: IInterpreterSettings;

    public venvFolders: string[] = [];

    public activeStateToolPath = '';

    public condaPath = '';

    public pipenvPath = '';

    public poetryPath = '';

    public pixiToolPath = '';

    public devOptions: string[] = [];

    public autoComplete!: IAutoCompleteSettings;

    public testing!: ITestingSettings;

    public terminal!: ITerminalSettings;

    public globalModuleInstallation = false;

    public REPL!: IREPLSettings;

    public experiments!: IExperiments;

    public languageServer: LanguageServerType = LanguageServerType.Node;

    public languageServerIsDefault = true;

    private static readonly configChanged = new EventEmitter<ConfigurationChangeEvent | undefined>();

    private readonly workspaceRoot: Resource;

    private disposed = false;

    private _pythonPath = 'python';

    private _defaultInterpreterPath = '';

    private readonly workspace: IWorkspaceService;

    constructor(
        workspaceFolder: Resource,
        private readonly interpreterAutoSelectionService: IInterpreterAutoSelectionProxyService,
        workspace: IWorkspaceService,
        private readonly interpreterPathService: IInterpreterPathService,
        private readonly defaultLS: IDefaultLanguageServer | undefined,
        private readonly extensions: IExtensions,
    ) {
        this.workspace = workspace || new WorkspaceService();
        this.workspaceRoot = workspaceFolder;
        this.initialize();
    }

    public static getInstance(
        resource: Uri | undefined,
        interpreterAutoSelectionService: IInterpreterAutoSelectionProxyService,
        workspace: IWorkspaceService,
        interpreterPathService: IInterpreterPathService,
        defaultLS: IDefaultLanguageServer | undefined,
        extensions: IExtensions,
    ): PythonSettings {
        workspace = workspace || new WorkspaceService();
        const folder = PythonSettings.getWorkspaceFolder(resource, workspace);
        const owner = folder && PythonSettings.ownersByUri.get(folder.uri.toString());
        const cached = folder
            ? owner?.folder.deref() === folder && owner.settings.deref()
            : PythonSettings.globalSettings;
        if (cached) {
            return cached;
        }

        const settings = new PythonSettings(
            folder?.uri,
            interpreterAutoSelectionService,
            workspace,
            interpreterPathService,
            defaultLS,
            extensions,
        );
        PythonSettings.subscribe(workspace, interpreterAutoSelectionService, interpreterPathService);
        if (folder) {
            const key = folder.uri.toString();
            PythonSettings.disposeFolderSettings(key);
            const owner = { settings: new WeakRef(settings), folder: new WeakRef(folder) };
            PythonSettings.ownersByUri.set(key, owner);
            PythonSettings.collectedOwners.register(settings, { key, owner }, owner);
        } else {
            PythonSettings.globalSettings = settings;
        }
        // Pass null to avoid VSC from complaining about not passing in a value.

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const config = workspace.getConfiguration('editor', resource || (null as any));
        const formatOnType = config ? config.get('formatOnType', false) : false;
        sendTelemetryEvent(EventName.FORMAT_ON_TYPE, undefined, { enabled: formatOnType });
        return settings;
    }

    @debounceSync(1)
    // eslint-disable-next-line class-methods-use-this
    protected static debounceConfigChangeNotification(event?: ConfigurationChangeEvent): void {
        PythonSettings.configChanged.fire(event);
    }

    public static getSettingsUriAndTarget(
        resource: Uri | undefined,
        workspace?: IWorkspaceService,
    ): { uri: Uri | undefined; target: ConfigurationTarget } {
        workspace = workspace || new WorkspaceService();
        const uri = PythonSettings.getWorkspaceFolder(resource, workspace)?.uri;
        const target = uri ? ConfigurationTarget.WorkspaceFolder : ConfigurationTarget.Global;
        return { uri, target };
    }

    public static dispose(): void {
        if (!isTestExecution()) {
            throw new Error('Dispose can only be called from unit tests');
        }

        PythonSettings.reset();
    }

    private static getWorkspaceFolder(resource: Resource, workspace: IWorkspaceService): WorkspaceFolder | undefined {
        const folder = resource ? workspace.getWorkspaceFolder(resource) : undefined;
        if (folder) {
            return folder;
        }
        const folders = workspace.workspaceFolders;
        return Array.isArray(folders) ? folders[0] : undefined;
    }

    private static subscribe(
        workspace: IWorkspaceService,
        interpreterAutoSelectionService: IInterpreterAutoSelectionProxyService,
        interpreterPathService: IInterpreterPathService,
    ): void {
        if (PythonSettings.subscriptions) {
            return;
        }
        const refresh = () => PythonSettings.refreshSettings();
        PythonSettings.subscriptions = [
            workspace.onDidChangeWorkspaceFolders((event) =>
                PythonSettings.onWorkspaceFoldersChanged(workspace, event),
            ),
            workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration('python')) {
                    PythonSettings.refreshSettings(event);
                }
            }),
            interpreterAutoSelectionService.onDidChangeAutoSelectedInterpreter(refresh),
        ];
        if (interpreterPathService) {
            PythonSettings.subscriptions.push(interpreterPathService.onDidChange(refresh));
        }
    }

    private static refreshSettings(event?: ConfigurationChangeEvent): void {
        const owners = Array.from(PythonSettings.ownersByUri.values(), ({ settings }) => settings.deref());
        owners.push(PythonSettings.globalSettings);
        for (const settings of owners) {
            try {
                if (settings && !settings.disposed) {
                    settings.initialize();
                }
            } catch (error) {
                // Each settings owner must still refresh when another owner's configuration fails to load.
                traceError('Failed to refresh Python settings', error);
            }
        }
        PythonSettings.debounceConfigChangeNotification(event);
    }

    private static rebindFolderSettings(folder: WorkspaceFolder): void {
        const owner = PythonSettings.ownersByUri.get(folder.uri.toString());
        if (owner && owner.folder.deref() !== folder) {
            // An overlapping edit can replace the host's folder object even when its URI remains in the workspace.
            owner.folder = new WeakRef(folder);
        }
    }

    private static onWorkspaceFoldersChanged(workspace: IWorkspaceService, event: WorkspaceFoldersChangeEvent): void {
        for (const { uri } of event.removed) {
            PythonSettings.disposeFolderSettings(uri.toString());
        }
        for (const folder of event.added) {
            const key = folder.uri.toString();
            const prior = PythonSettings.ownersByUri.get(key)?.folder.deref();
            if (prior !== folder) {
                PythonSettings.disposeFolderSettings(key);
            }
        }
        if (event.added.length > 0) {
            PythonSettings.globalSettings?.dispose();
            PythonSettings.globalSettings = undefined;
        }

        const folders = workspace.workspaceFolders;
        if (Array.isArray(folders)) {
            folders.forEach((folder) => PythonSettings.rebindFolderSettings(folder));
        }
    }

    private static disposeFolderSettings(key: string): void {
        const owner = PythonSettings.ownersByUri.get(key);
        if (owner) {
            PythonSettings.ownersByUri.delete(key);
            PythonSettings.collectedOwners.unregister(owner);
            owner.settings.deref()?.dispose();
        }
    }

    public static reset(): void {
        PythonSettings.subscriptions?.forEach((subscription) => subscription?.dispose());
        PythonSettings.subscriptions = undefined;
        PythonSettings.ownersByUri.forEach((_owner, key) => PythonSettings.disposeFolderSettings(key));
        PythonSettings.globalSettings?.dispose();
        PythonSettings.globalSettings = undefined;
    }

    public static toSerializable(settings: IPythonSettings): IPythonSettings {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const clone: any = {};
        const keys = Object.entries(settings);
        keys.forEach((e) => {
            const [k, v] = e;
            if (!k.includes('Manager') && !k.includes('Service') && !k.includes('onDid')) {
                clone[k] = v;
            }
        });

        return clone as IPythonSettings;
    }

    public dispose(): void {
        this.disposed = true;
    }

    protected update(pythonSettings: WorkspaceConfiguration): void {
        const workspaceRoot = this.workspaceRoot?.fsPath;
        const systemVariables: SystemVariables = new SystemVariables(undefined, workspaceRoot, this.workspace);

        this.pythonPath = this.getPythonPath(systemVariables, workspaceRoot);

        const defaultInterpreterPath = systemVariables.resolveAny(pythonSettings.get<string>('defaultInterpreterPath'));
        this.defaultInterpreterPath = defaultInterpreterPath || DEFAULT_INTERPRETER_SETTING;
        if (this.defaultInterpreterPath === DEFAULT_INTERPRETER_SETTING) {
            const autoSelectedPythonInterpreter = this.interpreterAutoSelectionService.getAutoSelectedInterpreter(
                this.workspaceRoot,
            );
            this.defaultInterpreterPath = autoSelectedPythonInterpreter?.path ?? this.defaultInterpreterPath;
        }
        this.defaultInterpreterPath = getAbsolutePath(this.defaultInterpreterPath, workspaceRoot);

        this.venvPath = systemVariables.resolveAny(pythonSettings.get<string>('venvPath'))!;
        this.venvFolders = systemVariables.resolveAny(pythonSettings.get<string[]>('venvFolders'))!;
        const activeStateToolPath = systemVariables.resolveAny(pythonSettings.get<string>('activeStateToolPath'))!;
        this.activeStateToolPath =
            activeStateToolPath && activeStateToolPath.length > 0
                ? getAbsolutePath(activeStateToolPath, workspaceRoot)
                : activeStateToolPath;
        const condaPath = systemVariables.resolveAny(pythonSettings.get<string>('condaPath'))!;
        this.condaPath = condaPath && condaPath.length > 0 ? getAbsolutePath(condaPath, workspaceRoot) : condaPath;
        const pipenvPath = systemVariables.resolveAny(pythonSettings.get<string>('pipenvPath'))!;
        this.pipenvPath = pipenvPath && pipenvPath.length > 0 ? getAbsolutePath(pipenvPath, workspaceRoot) : pipenvPath;
        const poetryPath = systemVariables.resolveAny(pythonSettings.get<string>('poetryPath'))!;
        this.poetryPath = poetryPath && poetryPath.length > 0 ? getAbsolutePath(poetryPath, workspaceRoot) : poetryPath;
        const pixiToolPath = systemVariables.resolveAny(pythonSettings.get<string>('pixiToolPath'))!;
        this.pixiToolPath =
            pixiToolPath && pixiToolPath.length > 0 ? getAbsolutePath(pixiToolPath, workspaceRoot) : pixiToolPath;

        this.interpreter = pythonSettings.get<IInterpreterSettings>('interpreter') ?? {
            infoVisibility: 'onPythonRelated',
        };
        // Get as a string and verify; don't just accept.
        let userLS = pythonSettings.get<string>('languageServer');
        userLS = systemVariables.resolveAny(userLS);

        // Validate the user's input; if invalid, set it to the default.
        if (
            !userLS ||
            userLS === 'Default' ||
            userLS === 'Microsoft' ||
            !Object.values(LanguageServerType).includes(userLS as LanguageServerType)
        ) {
            if (
                this.extensions.getExtension(PYREFLY_EXTENSION_ID) &&
                pythonSettings.get<boolean>('pyrefly.disableLanguageServices') !== true
            ) {
                this.languageServer = LanguageServerType.None;
            } else {
                this.languageServer = this.defaultLS?.defaultLSType ?? LanguageServerType.None;
            }
            this.languageServerIsDefault = true;
        } else if (userLS === 'JediLSP') {
            // Switch JediLSP option to Jedi.
            this.languageServer = LanguageServerType.Jedi;
            this.languageServerIsDefault = false;
        } else {
            this.languageServer = userLS as LanguageServerType;
            this.languageServerIsDefault = false;
        }

        const autoCompleteSettings = systemVariables.resolveAny(
            pythonSettings.get<IAutoCompleteSettings>('autoComplete'),
        )!;
        if (this.autoComplete) {
            Object.assign<IAutoCompleteSettings, IAutoCompleteSettings>(this.autoComplete, autoCompleteSettings);
        } else {
            this.autoComplete = autoCompleteSettings;
        }

        const envFileSetting = pythonSettings.get<string>('envFile');
        this.envFile = systemVariables.resolveAny(envFileSetting)!;
        sendSettingTelemetry(this.workspace, envFileSetting);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.devOptions = systemVariables.resolveAny(pythonSettings.get<any[]>('devOptions'))!;
        this.devOptions = Array.isArray(this.devOptions) ? this.devOptions : [];

        this.globalModuleInstallation = pythonSettings.get<boolean>('globalModuleInstallation') === true;

        const testSettings = systemVariables.resolveAny(pythonSettings.get<ITestingSettings>('testing'))!;
        if (this.testing) {
            Object.assign<ITestingSettings, ITestingSettings>(this.testing, testSettings);
        } else {
            this.testing = testSettings;
            if (isTestExecution() && !this.testing) {
                this.testing = {
                    pytestArgs: [],
                    unittestArgs: [],
                    promptToConfigure: true,
                    debugPort: 3000,
                    pytestEnabled: false,
                    unittestEnabled: false,
                    pytestPath: 'pytest',
                    autoTestDiscoverOnSaveEnabled: true,
                    autoTestDiscoverOnSavePattern: '**/*.py',
                } as ITestingSettings;
            }
        }

        // Support for travis.
        this.testing = this.testing
            ? this.testing
            : {
                  promptToConfigure: true,
                  debugPort: 3000,
                  pytestArgs: [],
                  pytestEnabled: false,
                  pytestPath: 'pytest',
                  unittestArgs: [],
                  unittestEnabled: false,
                  autoTestDiscoverOnSaveEnabled: true,
                  autoTestDiscoverOnSavePattern: '**/*.py',
              };
        this.testing.pytestPath = getAbsolutePath(systemVariables.resolveAny(this.testing.pytestPath), workspaceRoot);
        if (this.testing.cwd) {
            this.testing.cwd = getAbsolutePath(systemVariables.resolveAny(this.testing.cwd), workspaceRoot);
        }

        // Resolve any variables found in the test arguments.
        this.testing.pytestArgs = this.testing.pytestArgs.map((arg) => systemVariables.resolveAny(arg));
        this.testing.unittestArgs = this.testing.unittestArgs.map((arg) => systemVariables.resolveAny(arg));

        const terminalSettings = systemVariables.resolveAny(pythonSettings.get<ITerminalSettings>('terminal'))!;
        if (this.terminal) {
            Object.assign<ITerminalSettings, ITerminalSettings>(this.terminal, terminalSettings);
        } else {
            this.terminal = terminalSettings;
            if (isTestExecution() && !this.terminal) {
                this.terminal = {} as ITerminalSettings;
            }
        }
        // Support for travis.
        this.terminal = this.terminal
            ? this.terminal
            : {
                  executeInFileDir: true,
                  focusAfterLaunch: false,
                  launchArgs: [],
                  activateEnvironment: true,
                  activateEnvInCurrentTerminal: false,
                  shellIntegration: {
                      enabled: false,
                  },
              };

        this.REPL = pythonSettings.get<IREPLSettings>('REPL')!;
        const experiments = pythonSettings.get<IExperiments>('experiments')!;
        if (this.experiments) {
            Object.assign<IExperiments, IExperiments>(this.experiments, experiments);
        } else {
            this.experiments = experiments;
        }
        // Note we directly access experiment settings using workspace service in ExperimentService class.
        // Any changes here specific to these settings should propogate their as well.
        this.experiments = this.experiments
            ? this.experiments
            : {
                  enabled: true,
                  optInto: [],
                  optOutFrom: [],
              };
    }

    // eslint-disable-next-line class-methods-use-this
    protected getPythonExecutable(pythonPath: string): string {
        return getPythonExecutable(pythonPath);
    }

    public register(): void {
        PythonSettings.reset();
    }

    public initialize(): void {
        const initialConfig = this.workspace.getConfiguration('python', this.workspaceRoot);
        if (initialConfig) {
            this.update(initialConfig);
        }
    }

    private getPythonPath(systemVariables: SystemVariables, workspaceRoot: string | undefined) {
        this.pythonPath = systemVariables.resolveAny(this.interpreterPathService.get(this.workspaceRoot))!;
        if (
            !process.env.CI_DISABLE_AUTO_SELECTION &&
            (this.pythonPath.length === 0 || this.pythonPath === 'python') &&
            this.interpreterAutoSelectionService
        ) {
            const autoSelectedPythonInterpreter = this.interpreterAutoSelectionService.getAutoSelectedInterpreter(
                this.workspaceRoot,
            );
            if (autoSelectedPythonInterpreter) {
                this.pythonPath = autoSelectedPythonInterpreter.path;
                if (this.workspaceRoot) {
                    this.interpreterAutoSelectionService
                        .setWorkspaceInterpreter(this.workspaceRoot, autoSelectedPythonInterpreter)
                        .ignoreErrors();
                }
            }
        }
        return getAbsolutePath(this.pythonPath, workspaceRoot);
    }
}

function getAbsolutePath(pathToCheck: string, rootDir: string | undefined): string {
    if (!rootDir) {
        rootDir = __dirname;
    }

    pathToCheck = untildify(pathToCheck) as string;
    if (isTestExecution() && !pathToCheck) {
        return rootDir;
    }
    if (pathToCheck.indexOf(path.sep) === -1) {
        return pathToCheck;
    }
    return path.isAbsolute(pathToCheck) ? pathToCheck : path.resolve(rootDir, pathToCheck);
}

function getPythonExecutable(pythonPath: string): string {
    pythonPath = untildify(pythonPath) as string;

    // If only 'python'.
    if (
        pythonPath === 'python' ||
        pythonPath.indexOf(path.sep) === -1 ||
        path.basename(pythonPath) === path.dirname(pythonPath)
    ) {
        return pythonPath;
    }

    if (isValidPythonPath(pythonPath)) {
        return pythonPath;
    }
    // Keep python right on top, for backwards compatibility.

    const KnownPythonExecutables = [
        'python',
        'python4',
        'python3.6',
        'python3.5',
        'python3',
        'python2.7',
        'python2',
        'python3.7',
        'python3.8',
        'python3.9',
    ];

    for (let executableName of KnownPythonExecutables) {
        // Suffix with 'python' for linux and 'osx', and 'python.exe' for 'windows'.
        if (isWindows()) {
            executableName = `${executableName}.exe`;
            if (isValidPythonPath(path.join(pythonPath, executableName))) {
                return path.join(pythonPath, executableName);
            }
            if (isValidPythonPath(path.join(pythonPath, 'Scripts', executableName))) {
                return path.join(pythonPath, 'Scripts', executableName);
            }
        } else {
            if (isValidPythonPath(path.join(pythonPath, executableName))) {
                return path.join(pythonPath, executableName);
            }
            if (isValidPythonPath(path.join(pythonPath, 'bin', executableName))) {
                return path.join(pythonPath, 'bin', executableName);
            }
        }
    }

    return pythonPath;
}

function isValidPythonPath(pythonPath: string): boolean {
    return (
        fs.existsSync(pythonPath) &&
        path.basename(getOSType() === OSType.Windows ? pythonPath.toLowerCase() : pythonPath).startsWith('python')
    );
}
