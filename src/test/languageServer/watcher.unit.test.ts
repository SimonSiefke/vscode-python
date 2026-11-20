// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as TypeMoq from 'typemoq';
import {
    CancellationError,
    ConfigurationChangeEvent,
    Extension,
    Uri,
    WorkspaceFolder,
    WorkspaceFoldersChangeEvent,
} from 'vscode';
import { Commands } from '../../client/activation/commands';
import { JediLanguageServerManager } from '../../client/activation/jedi/manager';
import { NodeLanguageServerManager } from '../../client/activation/node/manager';
import { PylanceApi } from '../../client/activation/node/pylanceApi';
import { ILanguageServerOutputChannel, LanguageServerType } from '../../client/activation/types';
import { IApplicationShell, ICommandManager, IWorkspaceService } from '../../client/common/application/types';
import { PYLANCE_EXTENSION_ID } from '../../client/common/constants';
import { IFileSystem } from '../../client/common/platform/types';
import {
    IConfigurationService,
    IPythonSettings,
    IDisposable,
    IExperimentService,
    IExtensions,
    IInterpreterPathService,
} from '../../client/common/types';
import { createDeferred } from '../../client/common/utils/async';
import { LanguageService } from '../../client/common/utils/localize';
import { Architecture } from '../../client/common/utils/platform';
import { IEnvironmentVariablesProvider } from '../../client/common/variables/types';
import { IInterpreterHelper, IInterpreterService } from '../../client/interpreter/contracts';
import { IServiceContainer } from '../../client/ioc/types';
import { JediLSExtensionManager } from '../../client/languageServer/jediLSExtensionManager';
import { NoneLSExtensionManager } from '../../client/languageServer/noneLSExtensionManager';
import { PylanceLSExtensionManager } from '../../client/languageServer/pylanceLSExtensionManager';
import { ILanguageServerExtensionManager } from '../../client/languageServer/types';
import { LanguageServerWatcher } from '../../client/languageServer/watcher';
import * as Logging from '../../client/logging';
import { EnvironmentType, PythonEnvironment } from '../../client/pythonEnvironments/info';

suite('Language server watcher lifetime', () => {
    const sandbox = sinon.createSandbox();

    teardown(() => sandbox.restore());

    function createWatcher(languageServer = LanguageServerType.None, pylance?: Partial<Extension<PylanceApi>>) {
        const disposables: IDisposable[] = [];
        const resource = Uri.file('/project');
        const firstInterpreter: PythonEnvironment = {
            path: '/python/one',
            architecture: Architecture.x64,
            sysPrefix: '/python',
            envType: EnvironmentType.Venv,
        };
        let interpreter = firstInterpreter;
        let interpreterNumber = 1;
        let lookupInterpreter = async () => interpreter;
        const interpreterService = TypeMoq.Mock.ofType<IInterpreterService>();
        interpreterService.setup((s) => s.getActiveInterpreter(TypeMoq.It.isAny())).returns(() => lookupInterpreter());
        const workspace = TypeMoq.Mock.ofType<IWorkspaceService>();
        const workspaceFolder = { uri: resource, name: 'project', index: 0 };
        workspace.setup((w) => w.workspaceFolders).returns(() => [workspaceFolder]);
        workspace.setup((w) => w.isTrusted).returns(() => true);
        workspace.setup((w) => w.getWorkspaceFolder(TypeMoq.It.isAny())).returns(() => workspaceFolder);
        const settings = TypeMoq.Mock.ofType<IPythonSettings>();
        settings.setup((s) => s.languageServer).returns(() => languageServer);
        settings.setup((s) => s.languageServerIsDefault).returns(() => false);
        const configuration = TypeMoq.Mock.ofType<IConfigurationService>();
        configuration.setup((c) => c.getSettings(TypeMoq.It.isAny())).returns(() => settings.object);
        const commands = TypeMoq.Mock.ofType<ICommandManager>();
        let restart: (() => void) | undefined;
        commands
            .setup((c) => c.registerCommand(Commands.RestartLS, TypeMoq.It.isAny()))
            .returns((_command, run) => {
                restart = run;
                return {
                    dispose: () => {
                        restart = undefined;
                    },
                };
            });
        const extensions = TypeMoq.Mock.ofType<IExtensions>();
        extensions.setup((x) => x.getExtension(PYLANCE_EXTENSION_ID)).returns(() => pylance as Extension<PylanceApi>);
        const watcher = new LanguageServerWatcher(
            TypeMoq.Mock.ofType<IServiceContainer>().object,
            TypeMoq.Mock.ofType<ILanguageServerOutputChannel>().object,
            configuration.object,
            TypeMoq.Mock.ofType<IExperimentService>().object,
            TypeMoq.Mock.ofType<IInterpreterHelper>().object,
            TypeMoq.Mock.ofType<IInterpreterPathService>().object,
            interpreterService.object,
            TypeMoq.Mock.ofType<IEnvironmentVariablesProvider>().object,
            workspace.object,
            commands.object,
            TypeMoq.Mock.ofType<IFileSystem>().object,
            extensions.object,
            TypeMoq.Mock.ofType<IApplicationShell>().object,
            disposables,
        );
        return {
            watcher,
            disposables,
            resource,
            changeInterpreter: () => {
                interpreter = { ...firstInterpreter, path: `/python/${++interpreterNumber}` };
            },
            setInterpreterLookup: (lookup: () => Promise<PythonEnvironment>) => {
                lookupInterpreter = lookup;
            },
            setLanguageServer: (type: LanguageServerType) => {
                languageServer = type;
            },
            changeLanguageServer: (type: LanguageServerType) => {
                languageServer = type;
                return watcher['onDidChangeConfiguration']({
                    affectsConfiguration: (section) => section === 'python.languageServer',
                });
            },
            restart: () => {
                assert.ok(restart);
                restart();
            },
        };
    }

    test('Replacing a language server does not grow the session disposal registry', async () => {
        const { watcher, disposables, resource, changeInterpreter } = createWatcher();
        try {
            await watcher.startLanguageServer(LanguageServerType.None, resource);
            let activeServer = await watcher.get(resource);
            const registeredDisposables = disposables.length;
            for (let replacement = 0; replacement < 3; replacement += 1) {
                changeInterpreter();
                await watcher.startLanguageServer(LanguageServerType.None, resource);
                const nextServer = await watcher.get(resource);
                assert.notStrictEqual(nextServer, activeServer);
                assert.deepStrictEqual([...watcher['activeLanguageServers'].keys()], [nextServer]);
                activeServer = nextServer;
            }
            assert.strictEqual(disposables.length, registeredDisposables);
        } finally {
            await Promise.all(disposables.map((disposable) => disposable.dispose()));
        }
        assert.strictEqual(watcher['activeLanguageServers'].size, 0);
    });

    test('Session disposal cleans up the active server without stopping an old server again', async () => {
        const { watcher, disposables, resource, changeInterpreter } = createWatcher();
        const stop = sandbox.spy(NoneLSExtensionManager.prototype, 'stopLanguageServer');
        const dispose = sandbox.spy(NoneLSExtensionManager.prototype, 'dispose');
        try {
            await watcher.startLanguageServer(LanguageServerType.None, resource);
            const oldServer = await watcher.get(resource);

            changeInterpreter();
            await watcher.startLanguageServer(LanguageServerType.None, resource);
            const activeServer = await watcher.get(resource);
            assert.notStrictEqual(oldServer, activeServer);
            assert.strictEqual(stop.callCount, 1);
            assert.strictEqual(stop.firstCall.thisValue, oldServer);
            assert.strictEqual(dispose.callCount, 1);
            assert.strictEqual(dispose.firstCall.thisValue, oldServer);

            await Promise.all(disposables.map((disposable) => disposable.dispose()));
            assert.strictEqual(stop.callCount, 2);
            assert.strictEqual(stop.secondCall.thisValue, activeServer);
            assert.strictEqual(dispose.callCount, 2);
            assert.strictEqual(dispose.secondCall.thisValue, activeServer);
        } finally {
            await Promise.all(disposables.map((disposable) => disposable.dispose()));
        }
    });

    test('Shutdown prevents a pending interpreter lookup and later activation from starting a server', async () => {
        const { watcher, disposables, resource, setInterpreterLookup } = createWatcher();
        const interpreter = createDeferred<PythonEnvironment>();
        const lookup = sandbox.stub().returns(interpreter.promise);
        const start = sandbox.spy(NoneLSExtensionManager.prototype, 'startLanguageServer');
        setInterpreterLookup(lookup);

        const starting = watcher.startLanguageServer(LanguageServerType.None, resource);
        assert.ok(lookup.calledOnce);
        await Promise.all(disposables.map((disposable) => disposable.dispose()));
        disposables.length = 0;
        interpreter.resolve({
            path: '/python/one',
            architecture: Architecture.x64,
            sysPrefix: '/python',
            envType: EnvironmentType.Venv,
        });
        await starting;
        await watcher.activate(resource);

        assert.ok(start.notCalled);
        assert.ok(lookup.calledOnce);
        assert.strictEqual(disposables.length, 0);
    });

    test('Shutdown joins an in-flight replacement without starting another server', async () => {
        const { watcher, disposables, resource, setLanguageServer } = createWatcher();
        const enteredStop = createDeferred();
        const finishStop = createDeferred();
        const start = sandbox.spy(NoneLSExtensionManager.prototype, 'startLanguageServer');
        const stop = sandbox.stub(NoneLSExtensionManager.prototype, 'stopLanguageServer').callsFake(async () => {
            enteredStop.resolve();
            await finishStop.promise;
        });
        const dispose = sandbox.spy(NoneLSExtensionManager.prototype, 'dispose');
        await watcher.startLanguageServer(LanguageServerType.None, resource);
        setLanguageServer(LanguageServerType.Node);
        const refreshing = watcher['refreshLanguageServer'](resource);
        try {
            await Promise.race([enteredStop.promise, refreshing]);
            assert.ok(enteredStop.completed);
            const firstShutdown = disposables[0].dispose();
            const secondShutdown = disposables[0].dispose();
            assert.strictEqual(firstShutdown, secondShutdown);
            assert.ok(stop.calledOnce);
            assert.ok(dispose.notCalled);
            await assert.rejects(watcher.get(resource), CancellationError);
            finishStop.resolve();

            await Promise.all([refreshing, firstShutdown, secondShutdown]);
            assert.ok(start.calledOnce);
            assert.ok(stop.calledOnce);
            assert.ok(dispose.calledOnce);
            assert.strictEqual(watcher.languageServerType, LanguageServerType.None);
        } finally {
            finishStop.resolve();
            await refreshing;
            await Promise.all(disposables.map((disposable) => disposable.dispose()));
        }
    });

    test('Replacing Pylance completes while startup is waiting to acquire the client', async () => {
        const acquiring = createDeferred();
        const release = createDeferred();
        const start = sandbox.stub().resolves();
        const client = { isEnabled: () => true, start, stop: sandbox.stub().resolves() };
        const extension = {
            packageJSON: { version: '1' },
            exports: { client },
            isActive: false,
            activate: async () => {
                acquiring.resolve();
                await release.promise;
                extension.isActive = true;
                return extension.exports;
            },
        };
        const { watcher, disposables, resource, changeLanguageServer } = createWatcher(
            LanguageServerType.Node,
            extension,
        );
        const starting = watcher.startLanguageServer(LanguageServerType.Node, resource);
        try {
            await Promise.race([acquiring.promise, starting]);
            assert.ok(acquiring.completed);
            const oldServer = await watcher.get(resource);
            await changeLanguageServer(LanguageServerType.None);
            assert.ok((await watcher.get(resource)) instanceof NoneLSExtensionManager);
            assert.strictEqual(watcher['activeLanguageServers'].has(oldServer), false);
            assert.strictEqual(release.completed, false);

            release.resolve();
            await starting;
            assert.ok(start.notCalled);
            assert.strictEqual(watcher.languageServerType, LanguageServerType.None);
            await changeLanguageServer(LanguageServerType.Node);
            assert.ok(start.calledOnce);
        } finally {
            release.resolve();
            await Promise.all([starting, ...disposables.map((disposable) => disposable.dispose())]);
        }
    });

    test('Retiring a manager prevents a pending Restart Language Server command from reviving it', async () => {
        const stopping = createDeferred();
        const release = createDeferred();
        const stop = sandbox.stub().resolves();
        stop.onFirstCall().callsFake(async () => {
            stopping.resolve();
            await release.promise;
        });
        const start = sandbox.stub().resolves();
        const { watcher, disposables, resource, changeLanguageServer, restart } = createWatcher(
            LanguageServerType.Node,
            {
                packageJSON: { version: '1' },
                exports: { client: { isEnabled: () => true, start, stop } },
                isActive: true,
            },
        );
        try {
            await watcher.startLanguageServer(LanguageServerType.Node, resource);
            const oldServer = (await watcher.get(resource)) as PylanceLSExtensionManager;
            restart();
            const restarting = oldServer.serverManager['restarting'];
            await Promise.race([stopping.promise, restarting]);
            assert.ok(stopping.completed);
            const switchToNone = changeLanguageServer(LanguageServerType.None);
            release.resolve();
            await Promise.all([switchToNone, restarting]);

            assert.ok(start.calledOnce);
            assert.ok(stop.calledOnce);
            assert.ok((await watcher.get(resource)) instanceof NoneLSExtensionManager);
            assert.strictEqual(watcher['activeLanguageServers'].has(oldServer), false);
            await changeLanguageServer(LanguageServerType.Node);
            assert.notStrictEqual(await watcher.get(resource), oldServer);
            assert.ok(start.calledTwice);
        } finally {
            release.resolve();
            await Promise.all(disposables.map((disposable) => disposable.dispose()));
        }
    });

    test('Restart Language Server replaces a manager whose startup is stalled', async () => {
        const startingFirstClient = createDeferred();
        const finishFirstStartup = createDeferred();
        const startedReplacement = createDeferred();
        const start = sandbox.stub();
        start.onFirstCall().callsFake(async () => {
            startingFirstClient.resolve();
            await finishFirstStartup.promise;
        });
        start.onSecondCall().callsFake(async () => {
            startedReplacement.resolve();
        });
        const stop = sandbox.stub().resolves();
        const { watcher, disposables, resource, restart } = createWatcher(LanguageServerType.Node, {
            packageJSON: { version: '1' },
            exports: { client: { isEnabled: () => true, start, stop } },
            isActive: true,
        });
        const firstStartup = watcher.startLanguageServer(LanguageServerType.Node, resource);
        try {
            await Promise.race([startingFirstClient.promise, firstStartup]);
            assert.ok(startingFirstClient.completed);
            const firstManager = await watcher.get(resource);
            restart();

            await startedReplacement.promise;
            assert.strictEqual(finishFirstStartup.completed, false);
            const replacement = await watcher.get(resource);
            assert.notStrictEqual(replacement, firstManager);
            assert.deepStrictEqual([...watcher['activeLanguageServers'].keys()], [replacement]);
            assert.ok(stop.calledOnce);
        } finally {
            finishFirstStartup.resolve();
            await Promise.all([firstStartup, ...disposables.map((disposable) => disposable.dispose())]);
        }
    });

    test('A second Restart Language Server command replaces a stalled restart', async () => {
        const restartingClient = createDeferred();
        const finishRestart = createDeferred();
        const startedReplacement = createDeferred();
        const start = sandbox.stub().resolves();
        start.onSecondCall().callsFake(async () => {
            restartingClient.resolve();
            await finishRestart.promise;
        });
        start.onThirdCall().callsFake(async () => {
            startedReplacement.resolve();
        });
        const stop = sandbox.stub().resolves();
        const { watcher, disposables, resource, restart } = createWatcher(LanguageServerType.Node, {
            packageJSON: { version: '1' },
            exports: { client: { isEnabled: () => true, start, stop } },
            isActive: true,
        });
        try {
            await watcher.startLanguageServer(LanguageServerType.Node, resource);
            const firstManager = (await watcher.get(resource)) as PylanceLSExtensionManager;
            restart();
            const restarting = firstManager.serverManager['restarting'];
            await Promise.race([restartingClient.promise, restarting]);
            assert.ok(restartingClient.completed);
            restart();

            await startedReplacement.promise;
            assert.strictEqual(finishRestart.completed, false);
            const replacement = await watcher.get(resource);
            assert.notStrictEqual(replacement, firstManager);
            assert.deepStrictEqual([...watcher['activeLanguageServers'].keys()], [replacement]);
            assert.ok(stop.calledTwice);

            finishRestart.resolve();
            await restarting;
            assert.strictEqual(await watcher.get(resource), replacement);
        } finally {
            finishRestart.resolve();
            await Promise.all(disposables.map((disposable) => disposable.dispose()));
        }
    });

    test('A setting change back to Pylance takes precedence over a pending switch to None', async () => {
        const stopping = createDeferred();
        const release = createDeferred();
        const stop = sandbox.stub().resolves();
        stop.onFirstCall().callsFake(async () => {
            stopping.resolve();
            await release.promise;
        });
        const start = sandbox.stub().resolves();
        const startNone = sandbox.spy(NoneLSExtensionManager.prototype, 'startLanguageServer');
        const { watcher, disposables, resource, changeLanguageServer } = createWatcher(LanguageServerType.Node, {
            packageJSON: { version: '1' },
            exports: { client: { isEnabled: () => true, start, stop } },
            isActive: true,
        });
        try {
            await watcher.startLanguageServer(LanguageServerType.Node, resource);
            const oldServer = await watcher.get(resource);
            const switchToNone = changeLanguageServer(LanguageServerType.None);
            await Promise.race([stopping.promise, switchToNone]);
            assert.ok(stopping.completed);
            const switchBack = changeLanguageServer(LanguageServerType.Node);
            release.resolve();
            await Promise.all([switchToNone, switchBack]);

            const activeServer = await watcher.get(resource);
            assert.ok(activeServer instanceof PylanceLSExtensionManager);
            assert.notStrictEqual(activeServer, oldServer);
            assert.deepStrictEqual([...watcher['activeLanguageServers'].keys()], [activeServer]);
            assert.strictEqual(watcher.languageServerType, LanguageServerType.Node);
            assert.ok(stop.calledOnce);
            assert.ok(start.calledTwice);
            assert.ok(startNone.notCalled);
        } finally {
            release.resolve();
            await Promise.all(disposables.map((disposable) => disposable.dispose()));
        }
    });
});

suite('Language server watcher', () => {
    let watcher: LanguageServerWatcher;
    let disposables: IDisposable[];
    const sandbox = sinon.createSandbox();

    setup(() => {
        disposables = [];
        watcher = new LanguageServerWatcher(
            {} as IServiceContainer,
            {} as ILanguageServerOutputChannel,
            {
                getSettings: () => ({ languageServer: LanguageServerType.None }),
            } as IConfigurationService,
            {} as IExperimentService,
            ({
                getActiveWorkspaceUri: () => undefined,
            } as unknown) as IInterpreterHelper,
            ({
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterPathService,
            ({
                getActiveInterpreter: () => 'python',
                onDidChangeInterpreterInformation: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterService,
            {} as IEnvironmentVariablesProvider,
            ({
                getWorkspaceFolder: (uri: Uri) => ({ uri }),
                onDidChangeConfiguration: () => {
                    /* do nothing */
                },
                onDidChangeWorkspaceFolders: () => {
                    /* do nothing */
                },
            } as unknown) as IWorkspaceService,
            ({
                registerCommand: () => {
                    /* do nothing */
                },
            } as unknown) as ICommandManager,
            {} as IFileSystem,
            ({
                getExtension: () => undefined,
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IExtensions,
            {} as IApplicationShell,
            disposables,
        );

        watcher.register();
    });

    teardown(() => {
        sandbox.restore();
    });

    test('The constructor should add a listener to onDidChange to the list of disposables if it is a trusted workspace', () => {
        watcher = new LanguageServerWatcher(
            {} as IServiceContainer,
            {} as ILanguageServerOutputChannel,
            {
                getSettings: () => ({ languageServer: LanguageServerType.None }),
            } as IConfigurationService,
            {} as IExperimentService,
            {} as IInterpreterHelper,
            ({
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterPathService,
            ({
                onDidChangeInterpreterInformation: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterService,
            {} as IEnvironmentVariablesProvider,
            ({
                isTrusted: true,
                getWorkspaceFolder: (uri: Uri) => ({ uri }),
                onDidChangeConfiguration: () => {
                    /* do nothing */
                },
                onDidChangeWorkspaceFolders: () => {
                    /* do nothing */
                },
            } as unknown) as IWorkspaceService,
            {} as ICommandManager,
            {} as IFileSystem,
            ({
                getExtension: () => undefined,
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IExtensions,
            {} as IApplicationShell,
            disposables,
        );
        watcher.register();
        assert.strictEqual(disposables.length, 13);
    });

    test('The constructor should not add a listener to onDidChange to the list of disposables if it is not a trusted workspace', () => {
        watcher = new LanguageServerWatcher(
            {} as IServiceContainer,
            {} as ILanguageServerOutputChannel,
            {
                getSettings: () => ({ languageServer: LanguageServerType.None }),
            } as IConfigurationService,
            {} as IExperimentService,
            {} as IInterpreterHelper,
            ({
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterPathService,
            ({
                onDidChangeInterpreterInformation: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterService,
            {} as IEnvironmentVariablesProvider,
            ({
                isTrusted: false,
                getWorkspaceFolder: (uri: Uri) => ({ uri }),
                onDidChangeConfiguration: () => {
                    /* do nothing */
                },
                onDidChangeWorkspaceFolders: () => {
                    /* do nothing */
                },
            } as unknown) as IWorkspaceService,
            {} as ICommandManager,
            {} as IFileSystem,
            ({
                getExtension: () => undefined,
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IExtensions,
            {} as IApplicationShell,
            disposables,
        );
        watcher.register();
        assert.strictEqual(disposables.length, 12);
    });

    test(`When starting the language server, the language server extension manager should not be undefined`, async () => {
        // First start
        await watcher.startLanguageServer(LanguageServerType.None);
        // get should return the None LS (the noop LS).
        // This LS is returned by the None LS manager in get().
        const languageServer = await watcher.get();

        assert.notStrictEqual(languageServer, undefined);
    });

    test(`If the interpreter changed, the existing language server should be stopped if there is one`, async () => {
        const getActiveInterpreterStub = sandbox.stub();
        getActiveInterpreterStub.onFirstCall().returns('python');
        getActiveInterpreterStub.onSecondCall().returns('other/python');

        const interpreterService = ({
            getActiveInterpreter: getActiveInterpreterStub,
            onDidChangeInterpreterInformation: () => {
                /* do nothing */
            },
        } as unknown) as IInterpreterService;

        watcher = new LanguageServerWatcher(
            ({
                get: () => {
                    /* do nothing */
                },
            } as unknown) as IServiceContainer,
            {} as ILanguageServerOutputChannel,
            {
                getSettings: () => ({ languageServer: LanguageServerType.None }),
            } as IConfigurationService,
            {} as IExperimentService,
            ({
                getActiveWorkspaceUri: () => undefined,
            } as unknown) as IInterpreterHelper,
            ({
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterPathService,
            interpreterService,
            ({
                onDidEnvironmentVariablesChange: () => {
                    /* do nothing */
                },
            } as unknown) as IEnvironmentVariablesProvider,
            ({
                isTrusted: true,
                getWorkspaceFolder: (uri: Uri) => ({ uri }),
                onDidChangeConfiguration: () => {
                    /* do nothing */
                },
                onDidChangeWorkspaceFolders: () => {
                    /* do nothing */
                },
            } as unknown) as IWorkspaceService,
            ({
                registerCommand: () => {
                    /* do nothing */
                },
            } as unknown) as ICommandManager,
            {} as IFileSystem,
            ({
                getExtension: () => undefined,
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IExtensions,
            {} as IApplicationShell,
            disposables,
        );
        watcher.register();

        // First start, get the reference to the extension manager.
        await watcher.startLanguageServer(LanguageServerType.None);

        // For None case the object implements both ILanguageServer and ILanguageServerManager.
        const extensionManager = (await watcher.get()) as ILanguageServerExtensionManager;
        const stopLanguageServerSpy = sandbox.spy(extensionManager, 'stopLanguageServer');

        // Second start, check if the first server manager was stopped and disposed of.
        await watcher.startLanguageServer(LanguageServerType.None);

        assert.ok(stopLanguageServerSpy.calledOnce);
    });

    test(`When starting the language server, if the language server can be started, it should call startLanguageServer on the language server extension manager`, async () => {
        const startLanguageServerStub = sandbox.stub(NoneLSExtensionManager.prototype, 'startLanguageServer');
        startLanguageServerStub.returns(Promise.resolve());

        await watcher.startLanguageServer(LanguageServerType.None);

        assert.ok(startLanguageServerStub.calledOnce);
    });

    test(`When starting the language server, if the language server can be started, there should be logs written in the output channel`, async () => {
        let output = '';
        sandbox.stub(Logging, 'traceLog').callsFake((...args: unknown[]) => {
            output = output.concat(...(args as string[]));
        });

        watcher = new LanguageServerWatcher(
            {} as IServiceContainer,
            {} as ILanguageServerOutputChannel,
            {
                getSettings: () => ({ languageServer: LanguageServerType.None }),
            } as IConfigurationService,
            {} as IExperimentService,
            ({
                getActiveWorkspaceUri: () => ({ folderUri: Uri.parse('workspace') }),
            } as unknown) as IInterpreterHelper,
            ({
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterPathService,
            ({
                getActiveInterpreter: () => 'python',
                onDidChangeInterpreterInformation: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterService,
            {} as IEnvironmentVariablesProvider,
            ({
                getWorkspaceFolder: (uri: Uri) => ({ uri }),
                onDidChangeConfiguration: () => {
                    /* do nothing */
                },
                onDidChangeWorkspaceFolders: () => {
                    /* do nothing */
                },
            } as unknown) as IWorkspaceService,
            ({
                registerCommand: () => {
                    /* do nothing */
                },
            } as unknown) as ICommandManager,
            {} as IFileSystem,
            ({
                getExtension: () => undefined,
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IExtensions,
            {} as IApplicationShell,
            disposables,
        );
        watcher.register();

        await watcher.startLanguageServer(LanguageServerType.None);

        assert.strictEqual(output, LanguageService.startingNone);
    });

    test(`When starting the language server, if the language server can be started, this.languageServerType should reflect the new language server type`, async () => {
        await watcher.startLanguageServer(LanguageServerType.None);

        assert.deepStrictEqual(watcher.languageServerType, LanguageServerType.None);
    });

    test(`When starting the language server, if the language server cannot be started, it should call languageServerNotAvailable`, async () => {
        const canStartLanguageServerStub = sandbox.stub(NoneLSExtensionManager.prototype, 'canStartLanguageServer');
        canStartLanguageServerStub.returns(false);
        const languageServerNotAvailableStub = sandbox.stub(
            NoneLSExtensionManager.prototype,
            'languageServerNotAvailable',
        );
        languageServerNotAvailableStub.returns(Promise.resolve());

        await watcher.startLanguageServer(LanguageServerType.None);

        assert.ok(canStartLanguageServerStub.calledOnce);
        assert.ok(languageServerNotAvailableStub.calledOnce);
    });

    test('When the config settings change, but the python.languageServer setting is not affected, the watcher should not restart the language server', async () => {
        let onDidChangeConfigListener: (event: ConfigurationChangeEvent) => Promise<void> = () => Promise.resolve();

        const workspaceService = ({
            getWorkspaceFolder: (uri: Uri) => ({ uri }),
            onDidChangeConfiguration: (listener: (event: ConfigurationChangeEvent) => Promise<void>) => {
                onDidChangeConfigListener = listener;
            },
            onDidChangeWorkspaceFolders: () => {
                /* do nothing */
            },
        } as unknown) as IWorkspaceService;

        watcher = new LanguageServerWatcher(
            {} as IServiceContainer,
            {} as ILanguageServerOutputChannel,
            {
                getSettings: () => ({ languageServer: LanguageServerType.None }),
            } as IConfigurationService,
            {} as IExperimentService,
            ({
                getActiveWorkspaceUri: () => undefined,
            } as unknown) as IInterpreterHelper,
            ({
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterPathService,
            ({
                getActiveInterpreter: () => 'python',
                onDidChangeInterpreterInformation: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterService,
            {} as IEnvironmentVariablesProvider,
            workspaceService,
            ({
                registerCommand: () => {
                    /* do nothing */
                },
            } as unknown) as ICommandManager,
            {} as IFileSystem,
            ({
                getExtension: () => undefined,
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IExtensions,
            {} as IApplicationShell,
            disposables,
        );
        watcher.register();
        const startLanguageServerSpy = sandbox.spy(watcher, 'startLanguageServer');

        await watcher.startLanguageServer(LanguageServerType.None);

        await onDidChangeConfigListener({ affectsConfiguration: () => false });

        // Check that startLanguageServer was only called once: When we called it above.
        assert.ok(startLanguageServerSpy.calledOnce);
    });

    test('When the config settings change, and the python.languageServer setting is affected, the watcher should restart the language server', async () => {
        let onDidChangeConfigListener: (event: ConfigurationChangeEvent) => Promise<void> = () => Promise.resolve();

        const workspaceService = ({
            getWorkspaceFolder: (uri: Uri) => ({ uri }),
            onDidChangeConfiguration: (listener: (event: ConfigurationChangeEvent) => Promise<void>) => {
                onDidChangeConfigListener = listener;
            },
            onDidChangeWorkspaceFolders: () => {
                /* do nothing */
            },
            workspaceFolders: [{ uri: Uri.parse('workspace') }],
        } as unknown) as IWorkspaceService;

        const settings = { languageServer: LanguageServerType.None };

        const configService = ({
            getSettings: () => settings,
        } as unknown) as IConfigurationService;

        watcher = new LanguageServerWatcher(
            {} as IServiceContainer,
            {} as ILanguageServerOutputChannel,
            configService,
            {} as IExperimentService,
            ({
                getActiveWorkspaceUri: () => undefined,
            } as unknown) as IInterpreterHelper,
            ({
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterPathService,
            ({
                getActiveInterpreter: () => undefined,
                onDidChangeInterpreterInformation: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterService,
            {} as IEnvironmentVariablesProvider,
            workspaceService,
            ({
                registerCommand: () => {
                    /* do nothing */
                },
            } as unknown) as ICommandManager,
            {} as IFileSystem,
            ({
                getExtension: () => undefined,
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IExtensions,
            {} as IApplicationShell,
            disposables,
        );
        watcher.register();

        sandbox.stub(PylanceLSExtensionManager.prototype, 'canStartLanguageServer').returns(true);
        const start = sandbox.stub(PylanceLSExtensionManager.prototype, 'startLanguageServer').resolves();
        const stop = sandbox.spy(NoneLSExtensionManager.prototype, 'stopLanguageServer');
        await watcher.startLanguageServer(LanguageServerType.None);
        settings.languageServer = LanguageServerType.Node;

        await onDidChangeConfigListener({ affectsConfiguration: () => true });

        assert.ok(stop.calledOnce);
        assert.ok(start.calledOnce);
        assert.strictEqual(watcher.languageServerType, LanguageServerType.Node);
    });

    test('When starting a language server with a Python 2.7 interpreter and the python.languageServer setting is Jedi, do not instantiate a language server', async () => {
        const startLanguageServerStub = sandbox.stub(NoneLSExtensionManager.prototype, 'startLanguageServer');
        startLanguageServerStub.returns(Promise.resolve());

        watcher = new LanguageServerWatcher(
            {} as IServiceContainer,
            {} as ILanguageServerOutputChannel,
            {
                getSettings: () => ({ languageServer: LanguageServerType.Jedi }),
            } as IConfigurationService,
            {} as IExperimentService,
            ({
                getActiveWorkspaceUri: () => undefined,
            } as unknown) as IInterpreterHelper,
            ({
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterPathService,
            ({
                getActiveInterpreter: () => ({ version: { major: 2, minor: 7 } }),
                onDidChangeInterpreterInformation: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterService,
            {} as IEnvironmentVariablesProvider,
            ({
                getWorkspaceFolder: (uri: Uri) => ({ uri }),
                onDidChangeConfiguration: () => {
                    /* do nothing */
                },
                onDidChangeWorkspaceFolders: () => {
                    /* do nothing */
                },
            } as unknown) as IWorkspaceService,
            ({
                registerCommand: () => {
                    /* do nothing */
                },
            } as unknown) as ICommandManager,
            {} as IFileSystem,
            ({
                getExtension: () => undefined,
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IExtensions,
            {} as IApplicationShell,
            disposables,
        );
        watcher.register();
        await watcher.startLanguageServer(LanguageServerType.Jedi);

        assert.ok(startLanguageServerStub.calledOnce);
    });

    test('When starting a language server with a Python 2.7 interpreter and the python.languageServer setting is default, use Pylance', async () => {
        const startLanguageServerStub = sandbox.stub(PylanceLSExtensionManager.prototype, 'startLanguageServer');
        startLanguageServerStub.returns(Promise.resolve());

        sandbox.stub(PylanceLSExtensionManager.prototype, 'canStartLanguageServer').returns(true);

        watcher = new LanguageServerWatcher(
            {} as IServiceContainer,
            {} as ILanguageServerOutputChannel,
            {
                getSettings: () => ({
                    languageServer: LanguageServerType.Jedi,
                    languageServerIsDefault: true,
                }),
            } as IConfigurationService,
            {} as IExperimentService,
            ({
                getActiveWorkspaceUri: () => undefined,
            } as unknown) as IInterpreterHelper,
            ({
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterPathService,
            ({
                getActiveInterpreter: () => ({ version: { major: 2, minor: 7 } }),
                onDidChangeInterpreterInformation: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterService,
            {} as IEnvironmentVariablesProvider,
            ({
                getWorkspaceFolder: (uri: Uri) => ({ uri }),
                onDidChangeConfiguration: () => {
                    /* do nothing */
                },
                onDidChangeWorkspaceFolders: () => {
                    /* do nothing */
                },
            } as unknown) as IWorkspaceService,
            ({
                registerCommand: () => {
                    /* do nothing */
                },
            } as unknown) as ICommandManager,
            {} as IFileSystem,
            ({
                getExtension: () => undefined,
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IExtensions,
            ({
                showWarningMessage: () => Promise.resolve(undefined),
            } as unknown) as IApplicationShell,
            disposables,
        );
        watcher.register();

        await watcher.startLanguageServer(LanguageServerType.Node);

        assert.ok(startLanguageServerStub.calledOnce);
    });

    test('When starting a language server in an untrusted workspace with Jedi, do not instantiate a language server', async () => {
        const startLanguageServerStub = sandbox.stub(NoneLSExtensionManager.prototype, 'startLanguageServer');
        startLanguageServerStub.returns(Promise.resolve());

        watcher = new LanguageServerWatcher(
            {} as IServiceContainer,
            {} as ILanguageServerOutputChannel,
            {
                getSettings: () => ({ languageServer: LanguageServerType.Jedi }),
            } as IConfigurationService,
            {} as IExperimentService,
            ({
                getActiveWorkspaceUri: () => undefined,
            } as unknown) as IInterpreterHelper,
            ({
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterPathService,
            ({
                getActiveInterpreter: () => ({ version: { major: 2, minor: 7 } }),
                onDidChangeInterpreterInformation: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterService,
            {} as IEnvironmentVariablesProvider,
            ({
                isTrusted: false,
                getWorkspaceFolder: (uri: Uri) => ({ uri }),
                onDidChangeConfiguration: () => {
                    /* do nothing */
                },
                onDidChangeWorkspaceFolders: () => {
                    /* do nothing */
                },
            } as unknown) as IWorkspaceService,
            ({
                registerCommand: () => {
                    /* do nothing */
                },
            } as unknown) as ICommandManager,
            {} as IFileSystem,
            ({
                getExtension: () => undefined,
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IExtensions,
            {} as IApplicationShell,
            disposables,
        );
        watcher.register();

        await watcher.startLanguageServer(LanguageServerType.Jedi);

        assert.ok(startLanguageServerStub.calledOnce);
    });

    [
        {
            languageServer: LanguageServerType.Jedi,
            multiLS: true,
            extensionLSCls: JediLSExtensionManager,
            lsManagerCls: JediLanguageServerManager,
        },
        {
            languageServer: LanguageServerType.Node,
            multiLS: false,
            extensionLSCls: PylanceLSExtensionManager,
            lsManagerCls: NodeLanguageServerManager,
        },
        {
            languageServer: LanguageServerType.None,
            multiLS: false,
            extensionLSCls: NoneLSExtensionManager,
            lsManagerCls: undefined,
        },
    ].forEach(({ languageServer, multiLS, extensionLSCls, lsManagerCls }) => {
        test(`When starting language servers with different resources, ${
            multiLS ? 'multiple' : 'a single'
        } language server${multiLS ? 's' : ''} should be instantiated when using ${languageServer}`, async () => {
            const getActiveInterpreterStub = sandbox.stub();
            getActiveInterpreterStub.onFirstCall().returns({ path: 'folder1/python', version: { major: 3, minor: 9 } });
            getActiveInterpreterStub
                .onSecondCall()
                .returns({ path: 'folder2/python', version: { major: 3, minor: 10 } });
            const startLanguageServerStub = sandbox.stub(extensionLSCls.prototype, 'startLanguageServer');
            startLanguageServerStub.returns(Promise.resolve());
            const stopLanguageServerStub = sandbox.stub(extensionLSCls.prototype, 'stopLanguageServer');
            sandbox.stub(extensionLSCls.prototype, 'canStartLanguageServer').returns(true);

            watcher = new LanguageServerWatcher(
                {} as IServiceContainer,
                {} as ILanguageServerOutputChannel,
                {
                    getSettings: () => ({ languageServer }),
                } as IConfigurationService,
                {} as IExperimentService,
                ({
                    getActiveWorkspaceUri: () => undefined,
                } as unknown) as IInterpreterHelper,
                ({
                    onDidChange: () => {
                        /* do nothing */
                    },
                } as unknown) as IInterpreterPathService,
                ({
                    getActiveInterpreter: getActiveInterpreterStub,
                    onDidChangeInterpreterInformation: () => {
                        /* do nothing */
                    },
                } as unknown) as IInterpreterService,
                {} as IEnvironmentVariablesProvider,
                ({
                    isTrusted: true,
                    getWorkspaceFolder: (uri: Uri) => ({ uri }),
                    onDidChangeConfiguration: () => {
                        /* do nothing */
                    },
                    onDidChangeWorkspaceFolders: () => {
                        /* do nothing */
                    },
                } as unknown) as IWorkspaceService,
                ({
                    registerCommand: () => {
                        /* do nothing */
                    },
                } as unknown) as ICommandManager,
                {} as IFileSystem,
                ({
                    getExtension: () => undefined,
                    onDidChange: () => {
                        /* do nothing */
                    },
                } as unknown) as IExtensions,
                ({
                    showWarningMessage: () => Promise.resolve(undefined),
                } as unknown) as IApplicationShell,
                disposables,
            );
            watcher.register();

            await watcher.startLanguageServer(languageServer, Uri.parse('folder1'));
            await watcher.startLanguageServer(languageServer, Uri.parse('folder2'));

            // If multiLS set to true, then we expect to have called startLanguageServer twice.
            // If multiLS set to false, then we expect to have called startLanguageServer once.
            assert.ok(startLanguageServerStub.calledTwice === multiLS);
            assert.ok(startLanguageServerStub.calledOnce === !multiLS);
            assert.ok(getActiveInterpreterStub.calledTwice);
            assert.ok(stopLanguageServerStub.notCalled);
        });

        test(`${languageServer} language server(s) should ${
            multiLS ? '' : 'not'
        } be stopped if a workspace gets removed from the current project`, async () => {
            sandbox.stub(extensionLSCls.prototype, 'startLanguageServer').returns(Promise.resolve());
            if (lsManagerCls) {
                sandbox.stub(lsManagerCls.prototype, 'dispose').returns();
            }

            const stopLanguageServerStub = sandbox.stub(extensionLSCls.prototype, 'stopLanguageServer');
            stopLanguageServerStub.returns(Promise.resolve());

            let onDidChangeWorkspaceFoldersListener: (event: WorkspaceFoldersChangeEvent) => Promise<void> = () =>
                Promise.resolve();

            const workspaceService = ({
                getWorkspaceFolder: (uri: Uri) => ({ uri }),
                onDidChangeConfiguration: () => {
                    /* do nothing */
                },
                onDidChangeWorkspaceFolders: (listener: (event: WorkspaceFoldersChangeEvent) => Promise<void>) => {
                    onDidChangeWorkspaceFoldersListener = listener;
                },
                workspaceFolders: [{ uri: Uri.parse('workspace1') }, { uri: Uri.parse('workspace2') }],
                isTrusted: true,
            } as unknown) as IWorkspaceService;

            watcher = new LanguageServerWatcher(
                {} as IServiceContainer,
                {} as ILanguageServerOutputChannel,
                {
                    getSettings: () => ({ languageServer }),
                } as IConfigurationService,
                {} as IExperimentService,
                ({
                    getActiveWorkspaceUri: () => undefined,
                } as unknown) as IInterpreterHelper,
                ({
                    onDidChange: () => {
                        /* do nothing */
                    },
                } as unknown) as IInterpreterPathService,
                ({
                    getActiveInterpreter: () => ({ version: { major: 3, minor: 7 } }),
                    onDidChangeInterpreterInformation: () => {
                        /* do nothing */
                    },
                } as unknown) as IInterpreterService,
                {} as IEnvironmentVariablesProvider,
                workspaceService,
                ({
                    registerCommand: () => {
                        /* do nothing */
                    },
                } as unknown) as ICommandManager,
                {} as IFileSystem,
                ({
                    getExtension: () => undefined,
                    onDidChange: () => {
                        /* do nothing */
                    },
                } as unknown) as IExtensions,
                ({
                    showWarningMessage: () => Promise.resolve(undefined),
                } as unknown) as IApplicationShell,
                disposables,
            );
            watcher.register();

            await watcher.startLanguageServer(languageServer, Uri.parse('workspace1'));
            await watcher.startLanguageServer(languageServer, Uri.parse('workspace2'));

            await onDidChangeWorkspaceFoldersListener({
                added: [],
                removed: [{ uri: Uri.parse('workspace2') } as WorkspaceFolder],
            });

            // If multiLS set to true, then we expect to have stopped a language server.
            // If multiLS set to false, then we expect to not have stopped a language server.
            assert.ok(stopLanguageServerStub.calledOnce === multiLS);
            assert.ok(stopLanguageServerStub.notCalled === !multiLS);
        });
    });

    test('The language server should be restarted if the interpreter info changed', async () => {
        const info = ({
            envPath: 'foo',
            path: 'path/to/foo/bin/python',
        } as unknown) as PythonEnvironment;

        let onDidChangeInfoListener: (event: PythonEnvironment) => Promise<void> = () => Promise.resolve();

        const interpreterService = ({
            onDidChangeInterpreterInformation: (
                listener: (event: PythonEnvironment) => Promise<void>,
                thisArg: unknown,
            ): void => {
                onDidChangeInfoListener = listener.bind(thisArg);
            },
            getActiveInterpreter: () => ({
                envPath: 'foo',
                path: 'path/to/foo',
            }),
        } as unknown) as IInterpreterService;

        watcher = new LanguageServerWatcher(
            ({
                get: () => {
                    /* do nothing */
                },
            } as unknown) as IServiceContainer,
            {} as ILanguageServerOutputChannel,
            {
                getSettings: () => ({ languageServer: LanguageServerType.None }),
            } as IConfigurationService,
            {} as IExperimentService,
            ({
                getActiveWorkspaceUri: () => undefined,
            } as unknown) as IInterpreterHelper,
            ({
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterPathService,
            interpreterService,
            ({
                onDidEnvironmentVariablesChange: () => {
                    /* do nothing */
                },
            } as unknown) as IEnvironmentVariablesProvider,
            ({
                isTrusted: true,
                getWorkspaceFolder: (uri: Uri) => ({ uri }),
                onDidChangeConfiguration: () => {
                    /* do nothing */
                },
                onDidChangeWorkspaceFolders: () => {
                    /* do nothing */
                },
            } as unknown) as IWorkspaceService,
            ({
                registerCommand: () => {
                    /* do nothing */
                },
            } as unknown) as ICommandManager,
            {} as IFileSystem,
            ({
                getExtension: () => undefined,
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IExtensions,
            {} as IApplicationShell,
            disposables,
        );
        watcher.register();

        const startLanguageServerSpy = sandbox.spy(watcher, 'startLanguageServer');

        await watcher.startLanguageServer(LanguageServerType.None);

        await onDidChangeInfoListener(info);

        // Check that startLanguageServer was called twice: Once above, and once after the interpreter info changed.
        assert.ok(startLanguageServerSpy.calledTwice);
    });

    test('The language server should not be restarted if the interpreter info did not change', async () => {
        const info = ({
            envPath: 'foo',
            path: 'path/to/foo',
        } as unknown) as PythonEnvironment;

        let onDidChangeInfoListener: (event: PythonEnvironment) => Promise<void> = () => Promise.resolve();

        const interpreterService = ({
            onDidChangeInterpreterInformation: (
                listener: (event: PythonEnvironment) => Promise<void>,
                thisArg: unknown,
            ): void => {
                onDidChangeInfoListener = listener.bind(thisArg);
            },
            getActiveInterpreter: () => info,
        } as unknown) as IInterpreterService;

        watcher = new LanguageServerWatcher(
            ({
                get: () => {
                    /* do nothing */
                },
            } as unknown) as IServiceContainer,
            {} as ILanguageServerOutputChannel,
            {
                getSettings: () => ({ languageServer: LanguageServerType.None }),
            } as IConfigurationService,
            {} as IExperimentService,
            ({
                getActiveWorkspaceUri: () => undefined,
            } as unknown) as IInterpreterHelper,
            ({
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterPathService,
            interpreterService,
            ({
                onDidEnvironmentVariablesChange: () => {
                    /* do nothing */
                },
            } as unknown) as IEnvironmentVariablesProvider,
            ({
                isTrusted: true,
                getWorkspaceFolder: (uri: Uri) => ({ uri }),
                onDidChangeConfiguration: () => {
                    /* do nothing */
                },
                onDidChangeWorkspaceFolders: () => {
                    /* do nothing */
                },
            } as unknown) as IWorkspaceService,
            ({
                registerCommand: () => {
                    /* do nothing */
                },
            } as unknown) as ICommandManager,
            {} as IFileSystem,
            ({
                getExtension: () => undefined,
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IExtensions,
            {} as IApplicationShell,
            disposables,
        );
        watcher.register();

        const startLanguageServerSpy = sandbox.spy(watcher, 'startLanguageServer');

        await watcher.startLanguageServer(LanguageServerType.None);

        await onDidChangeInfoListener(info);

        // Check that startLanguageServer was called once: Only when startLanguageServer() was called above.
        assert.ok(startLanguageServerSpy.calledOnce);
    });

    test('The language server should not be restarted if the interpreter info changed but the env path is an empty string', async () => {
        const info = ({
            envPath: '',
            path: 'path/to/foo',
        } as unknown) as PythonEnvironment;

        let onDidChangeInfoListener: (event: PythonEnvironment) => Promise<void> = () => Promise.resolve();

        const interpreterService = ({
            onDidChangeInterpreterInformation: (
                listener: (event: PythonEnvironment) => Promise<void>,
                thisArg: unknown,
            ): void => {
                onDidChangeInfoListener = listener.bind(thisArg);
            },
            getActiveInterpreter: () => ({
                envPath: 'foo',
                path: 'path/to/foo',
            }),
        } as unknown) as IInterpreterService;

        watcher = new LanguageServerWatcher(
            ({
                get: () => {
                    /* do nothing */
                },
            } as unknown) as IServiceContainer,
            {} as ILanguageServerOutputChannel,
            {
                getSettings: () => ({ languageServer: LanguageServerType.None }),
            } as IConfigurationService,
            {} as IExperimentService,
            ({
                getActiveWorkspaceUri: () => undefined,
            } as unknown) as IInterpreterHelper,
            ({
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterPathService,
            interpreterService,
            ({
                onDidEnvironmentVariablesChange: () => {
                    /* do nothing */
                },
            } as unknown) as IEnvironmentVariablesProvider,
            ({
                isTrusted: true,
                getWorkspaceFolder: (uri: Uri) => ({ uri }),
                onDidChangeConfiguration: () => {
                    /* do nothing */
                },
                onDidChangeWorkspaceFolders: () => {
                    /* do nothing */
                },
            } as unknown) as IWorkspaceService,
            ({
                registerCommand: () => {
                    /* do nothing */
                },
            } as unknown) as ICommandManager,
            {} as IFileSystem,
            ({
                getExtension: () => undefined,
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IExtensions,
            {} as IApplicationShell,
            disposables,
        );
        watcher.register();

        const startLanguageServerSpy = sandbox.spy(watcher, 'startLanguageServer');

        await watcher.startLanguageServer(LanguageServerType.None);

        await onDidChangeInfoListener(info);

        // Check that startLanguageServer was called once: Only when startLanguageServer() was called above.
        assert.ok(startLanguageServerSpy.calledOnce);
    });

    test('The language server should not be restarted if the interpreter info changed but the env path is undefined', async () => {
        const info = ({
            envPath: undefined,
            path: 'path/to/foo',
        } as unknown) as PythonEnvironment;

        let onDidChangeInfoListener: (event: PythonEnvironment) => Promise<void> = () => Promise.resolve();

        const interpreterService = ({
            onDidChangeInterpreterInformation: (
                listener: (event: PythonEnvironment) => Promise<void>,
                thisArg: unknown,
            ): void => {
                onDidChangeInfoListener = listener.bind(thisArg);
            },
            getActiveInterpreter: () => ({
                envPath: 'foo',
                path: 'path/to/foo',
            }),
        } as unknown) as IInterpreterService;

        watcher = new LanguageServerWatcher(
            ({
                get: () => {
                    /* do nothing */
                },
            } as unknown) as IServiceContainer,
            {} as ILanguageServerOutputChannel,
            {
                getSettings: () => ({ languageServer: LanguageServerType.None }),
            } as IConfigurationService,
            {} as IExperimentService,
            ({
                getActiveWorkspaceUri: () => undefined,
            } as unknown) as IInterpreterHelper,
            ({
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IInterpreterPathService,
            interpreterService,
            ({
                onDidEnvironmentVariablesChange: () => {
                    /* do nothing */
                },
            } as unknown) as IEnvironmentVariablesProvider,
            ({
                isTrusted: true,
                getWorkspaceFolder: (uri: Uri) => ({ uri }),
                onDidChangeConfiguration: () => {
                    /* do nothing */
                },
                onDidChangeWorkspaceFolders: () => {
                    /* do nothing */
                },
            } as unknown) as IWorkspaceService,
            ({
                registerCommand: () => {
                    /* do nothing */
                },
            } as unknown) as ICommandManager,
            {} as IFileSystem,
            ({
                getExtension: () => undefined,
                onDidChange: () => {
                    /* do nothing */
                },
            } as unknown) as IExtensions,
            {} as IApplicationShell,
            disposables,
        );
        watcher.register();

        const startLanguageServerSpy = sandbox.spy(watcher, 'startLanguageServer');

        await watcher.startLanguageServer(LanguageServerType.None);

        await onDidChangeInfoListener(info);

        // Check that startLanguageServer was called once: Only when startLanguageServer() was called above.
        assert.ok(startLanguageServerSpy.calledOnce);
    });
});
