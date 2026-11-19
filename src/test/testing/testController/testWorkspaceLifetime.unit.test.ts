// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import { queryObjects } from 'node:v8';
import * as sinon from 'sinon';
import * as TypeMoq from 'typemoq';
import {
    CancellationToken,
    Disposable,
    EventEmitter,
    FileCoverage,
    FileSystemWatcher,
    TestController,
    TestRun,
    TestRunProfile,
    TestRunProfileKind,
    TestRunRequest,
    TextDocument,
    Uri,
    WorkspaceFolder,
    WorkspaceFoldersChangeEvent,
    tests,
} from 'vscode';
import { ICommandManager, IWorkspaceService } from '../../../client/common/application/types';
import { IPythonExecutionFactory } from '../../../client/common/process/types';
import { IConfigurationService, IPythonSettings } from '../../../client/common/types';
import { createDeferred } from '../../../client/common/utils/async';
import { IEnvironmentVariablesProvider } from '../../../client/common/variables/types';
import * as workspaceApis from '../../../client/common/vscodeApis/workspaceApis';
import * as envExtApi from '../../../client/envExt/api.internal';
import {
    DidChangeEnvironmentEventArgs,
    DidChangePythonProjectsEventArgs,
    PythonProject,
} from '../../../client/envExt/types';
import { IInterpreterService } from '../../../client/interpreter/contracts';
import { ITestDebugLauncher } from '../../../client/testing/common/types';
import { ITestingSettings } from '../../../client/testing/configuration/types';
import * as projectUtils from '../../../client/testing/testController/common/projectUtils';
import {
    ITestDiscoveryAdapter,
    ITestExecutionAdapter,
    ITestFrameworkController,
    ITestResultResolver,
} from '../../../client/testing/testController/common/types';
import { PythonTestController } from '../../../client/testing/testController/controller';
import { WorkspaceTestAdapter } from '../../../client/testing/testController/workspaceTestAdapter';

suite('Test workspace lifetime', () => {
    let controller: PythonTestController;
    let testController: TestController;
    let registry: Disposable[];
    let folders: WorkspaceFolder[];
    let changed: EventEmitter<WorkspaceFoldersChangeEvent>;
    let saved: EventEmitter<TextDocument>;
    let watchers: Array<{ dispose: sinon.SinonSpy }>;
    let saveSubscriptions: Array<sinon.SinonSpy>;
    let discovered: string[];
    let events: Array<Disposable>;
    let clock: sinon.SinonFakeTimers | undefined;
    let configuration: TypeMoq.IMock<IConfigurationService>;
    let interpreters: TypeMoq.IMock<IInterpreterService>;
    let onDiscovery:
        | ((uri: Uri, resolver: ITestResultResolver, token?: CancellationToken) => Promise<void> | void)
        | undefined;
    let discoveryDisabled: Set<string>;

    setup(() => {
        registry = [];
        folders = [];
        watchers = [];
        saveSubscriptions = [];
        discovered = [];
        events = [];
        clock = undefined;
        onDiscovery = undefined;
        discoveryDisabled = new Set();
        changed = new EventEmitter<WorkspaceFoldersChangeEvent>();
        saved = new EventEmitter<TextDocument>();
        events.push(changed, saved);
        sinon.stub(envExtApi, 'useEnvExtension').returns(false);
        sinon.stub(workspaceApis, 'onDidSaveTextDocument').callsFake((handler) => {
            const subscription = saved.event(handler);
            const dispose = sinon.spy(() => subscription.dispose());
            saveSubscriptions.push(dispose);
            return { dispose };
        });
        const testing: ITestingSettings = {
            promptToConfigure: false,
            debugPort: 3000,
            pytestEnabled: false,
            pytestPath: 'pytest',
            pytestArgs: [],
            unittestEnabled: true,
            unittestArgs: [],
            autoTestDiscoverOnSaveEnabled: true,
            autoTestDiscoverOnSavePattern: '**/*.py',
        };
        configuration = TypeMoq.Mock.ofType<IConfigurationService>();
        configuration
            .setup((value) => value.getSettings(TypeMoq.It.isAny()))
            .returns(
                (uri: Uri | undefined) =>
                    ({
                        testing: {
                            ...testing,
                            autoTestDiscoverOnSaveEnabled: !discoveryDisabled.has(findWorkspace(uri)?.name ?? ''),
                        },
                    } as IPythonSettings),
            );
        const workspace = TypeMoq.Mock.ofType<IWorkspaceService>();
        workspace.setup((value) => value.workspaceFolders).returns(() => folders);
        workspace.setup((value) => value.onDidChangeWorkspaceFolders).returns(() => changed.event);
        workspace.setup((value) => value.getWorkspaceFolder(TypeMoq.It.isAny())).returns(findWorkspace);
        workspace
            .setup((value) => value.createFileSystemWatcher(TypeMoq.It.isAny()))
            .returns(() => {
                const created = new EventEmitter<Uri>();
                const modified = new EventEmitter<Uri>();
                const deleted = new EventEmitter<Uri>();
                events.push(created, modified, deleted);
                const dispose = sinon.spy();
                watchers.push({ dispose });
                const watcher: FileSystemWatcher = {
                    ignoreCreateEvents: false,
                    ignoreChangeEvents: false,
                    ignoreDeleteEvents: false,
                    onDidCreate: created.event,
                    onDidChange: modified.event,
                    onDidDelete: deleted.event,
                    dispose,
                };
                return watcher;
            });
        sinon.stub(projectUtils, 'createTestAdapters').callsFake((_provider, resolver) => {
            const discovery: ITestDiscoveryAdapter = {
                async discoverTests(uri, _factory, token) {
                    discovered.push(uri.toString());
                    await onDiscovery?.(uri, resolver, token);
                },
            };
            return {
                discoveryAdapter: discovery,
                executionAdapter: TypeMoq.Mock.ofType<ITestExecutionAdapter>().object,
            };
        });
        interpreters = TypeMoq.Mock.ofType<IInterpreterService>();
        interpreters.setup((value) => value.getActiveInterpreter(TypeMoq.It.isAny())).returns(async () => undefined);
        const factory = sinon.spy(tests, 'createTestController');
        controller = new PythonTestController(
            workspace.object,
            configuration.object,
            TypeMoq.Mock.ofType<ITestFrameworkController>().object,
            TypeMoq.Mock.ofType<ITestFrameworkController>().object,
            registry,
            interpreters.object,
            TypeMoq.Mock.ofType<ICommandManager>().object,
            TypeMoq.Mock.ofType<IPythonExecutionFactory>().object,
            TypeMoq.Mock.ofType<ITestDebugLauncher>().object,
            TypeMoq.Mock.ofType<IEnvironmentVariablesProvider>().object,
        );
        testController = factory.returnValues[0];
        const roots = new Map<string, import('vscode').TestItem>();
        sinon.stub(testController.items, 'get').callsFake((id) => roots.get(id));
        sinon.stub(testController.items, 'add').callsFake((item) => {
            roots.set(item.id, item);
        });
        sinon.stub(testController.items, 'delete').callsFake((id) => {
            roots.delete(id);
        });
        sinon.stub(testController.items, 'forEach').callsFake((callback, thisArg) => {
            roots.forEach((item) => callback.call(thisArg, item, testController.items));
        });
        sinon.stub(testController, 'createTestItem').callsFake((id, label, uri) => {
            const item = TypeMoq.Mock.ofType<import('vscode').TestItem>();
            item.setup((value) => value.id).returns(() => id);
            item.setup((value) => value.label).returns(() => label);
            item.setup((value) => value.uri).returns(() => uri);
            return item.object;
        });
    });

    teardown(() => {
        registry.splice(0).forEach((item) => item.dispose());
        events.forEach((event) => event.dispose());
        clock?.restore();
        sinon.restore();
    });

    function findWorkspace(uri?: Uri): WorkspaceFolder | undefined {
        const path = uri?.toString();
        return folders
            .filter((folder) => path === folder.uri.toString() || path?.startsWith(folder.uri.toString() + '/'))
            .sort((a, b) => b.uri.path.length - a.uri.path.length)[0];
    }

    function add(name: string): WorkspaceFolder {
        const folder = { uri: Uri.file(`/workspace/${name}`), name, index: folders.length };
        folders.push(folder);
        changed.fire({ added: [folder], removed: [] });
        return folder;
    }

    function remove(folder: WorkspaceFolder) {
        folders = folders.filter((value) => value.uri.toString() !== folder.uri.toString());
        // Workspace events need not reuse the same URI object instance.
        changed.fire({ added: [], removed: [{ ...folder, uri: Uri.parse(folder.uri.toString()) }] });
    }

    function save(workspace: WorkspaceFolder, name = 'test_current.py'): void {
        const uri = Uri.joinPath(workspace.uri, name);
        const document = TypeMoq.Mock.ofType<TextDocument>();
        document.setup((value) => value.uri).returns(() => uri);
        document.setup((value) => value.fileName).returns(() => uri.fsPath);
        saved.fire(document.object);
    }

    function publishRoot(resolver: ITestResultResolver, uri: Uri, name: string): void {
        resolver.resolveDiscovery({
            cwd: uri.fsPath,
            status: 'success',
            tests: { path: uri.fsPath, id_: uri.fsPath, type_: 'folder', name, children: [] },
        });
    }

    test('removing a workspace disposes its settings watcher', async () => {
        await controller.activate();
        remove(add('removed'));
        assert.strictEqual(watchers[0].dispose.callCount, 1);
    });

    test('folder churn uses one save listener and shutdown disposes the remaining subscriptions', async () => {
        await controller.activate();
        const removed = add('removed');
        add('retained');
        remove(removed);
        assert.strictEqual(saveSubscriptions.length, 1);
        assert.strictEqual(saveSubscriptions[0].callCount, 0);
        registry.splice(0).forEach((item) => item.dispose());
        assert.strictEqual(saveSubscriptions[0].callCount, 1);
        assert.deepStrictEqual(
            watchers.map((item) => item.dispose.callCount),
            [1, 1],
        );
    });

    test('removed workspace adapters are collectible', async () => {
        await controller.activate();
        const before = queryObjects(WorkspaceTestAdapter);
        remove(add('removed'));
        assert.strictEqual(queryObjects(WorkspaceTestAdapter), before);
    });

    test('folder churn does not grow the extension shutdown registry', async () => {
        await controller.activate();
        remove(add('first'));
        const registrations = registry.length;
        remove(add('second'));
        assert.strictEqual(registry.length, registrations);
    });

    test('removing a nested workspace clears its discovery roots and errors and preserves the parent', async () => {
        await controller.activate();
        const retained = add('parent');
        const removed = add('parent/child');
        const externalRoot = Uri.file('/discovery-outside-workspace');
        const errorId = `DiscoveryError:${removed.uri.fsPath}`;
        onDiscovery = (uri, resolver) => {
            publishRoot(resolver, uri, 'workspace');
            if (uri === removed.uri) {
                publishRoot(resolver, externalRoot, 'configured discovery directory');
                resolver.resolveDiscovery({ cwd: uri.fsPath, status: 'error', error: ['fixture error'] });
            }
        };
        await controller.refreshTestData(retained.uri, { forceRefresh: true });
        await controller.refreshTestData(removed.uri, { forceRefresh: true });
        assert.ok(testController.items.get(removed.uri.fsPath));
        assert.ok(testController.items.get(externalRoot.fsPath));
        assert.ok(testController.items.get(errorId));
        const currentRoot = testController.items.get(retained.uri.fsPath);
        assert.ok(currentRoot);
        remove(removed);
        assert.strictEqual(testController.items.get(removed.uri.fsPath), undefined);
        assert.strictEqual(testController.items.get(externalRoot.fsPath), undefined);
        assert.strictEqual(testController.items.get(errorId), undefined);
        assert.strictEqual(testController.items.get(currentRoot.id), currentRoot);
    });

    test('a readded workspace still discovers tests', async () => {
        await controller.activate();
        remove(add('reused'));
        const current = add('reused');
        await controller.refreshTestData(current.uri, { forceRefresh: true });
        assert.deepStrictEqual(discovered, [current.uri.toString()]);
        assert.strictEqual(watchers[1].dispose.callCount, 0);
    });

    test('saving a test in a remaining workspace still triggers discovery', async () => {
        await controller.activate();
        const removed = add('removed');
        const retained = add('retained');
        remove(removed);
        clock = sinon.useFakeTimers();
        save(removed);
        await clock.tickAsync(250);
        assert.deepStrictEqual(discovered, []);
        save(retained);
        assert.deepStrictEqual(discovered, []);
        await clock.tickAsync(250);
        assert.deepStrictEqual(discovered, [retained.uri.toString()]);
        assert.strictEqual(watchers[1].dispose.callCount, 0);
    });

    test('removing and readding a folder while interpreter lookup is pending skips old discovery', async () => {
        await controller.activate();
        const folder = add('reused');
        const started = createDeferred<void>();
        const interpreter = createDeferred<undefined>();
        interpreters.reset();
        interpreters
            .setup((value) => value.getActiveInterpreter(TypeMoq.It.isAny()))
            .returns(() => {
                started.resolve();
                return interpreter.promise;
            });
        const discovery = controller.refreshTestData(folder.uri, { forceRefresh: true });
        await started.promise;
        remove(folder);
        const replacement = add('reused');
        interpreter.resolve(undefined);
        await discovery;
        assert.deepStrictEqual(discovered, []);
        await controller.refreshTestData(replacement.uri, { forceRefresh: true });
        assert.deepStrictEqual(discovered, [replacement.uri.toString()]);
    });

    test('removal cancels in-flight discovery and ignores results and errors from the retired adapter', async () => {
        await controller.activate();
        const old = add('reused');
        const survivor = add('survivor');
        const started = createDeferred<CancellationToken>();
        const finish = createDeferred<void>();
        onDiscovery = async (uri, resolver, token) => {
            if (uri === old.uri) {
                assert.ok(token);
                started.resolve(token);
                await finish.promise;
                publishRoot(resolver, uri, 'old result');
                resolver.resolveDiscovery({ cwd: uri.fsPath, status: 'error', error: ['late error'] });
                throw new Error('late provider failure');
            }
            publishRoot(resolver, uri, 'current result');
        };
        const pending = controller.refreshTestData(old.uri, { forceRefresh: true });
        const token = await started.promise;
        remove(old);
        assert.strictEqual(token.isCancellationRequested, true);
        const replacement = add('reused');
        await controller.refreshTestData(replacement.uri, { forceRefresh: true });
        await controller.refreshTestData(survivor.uri, { forceRefresh: true });
        const replacementRoot = testController.items.get(replacement.uri.fsPath);
        const survivorRoot = testController.items.get(survivor.uri.fsPath);
        assert.ok(replacementRoot);
        assert.ok(survivorRoot);
        finish.resolve();
        await pending;
        assert.strictEqual(testController.items.get(replacement.uri.fsPath), replacementRoot);
        assert.strictEqual(testController.items.get(survivor.uri.fsPath), survivorRoot);
        assert.strictEqual(testController.items.get(`DiscoveryError:${old.uri.fsPath}`), undefined);
    });

    test('enabling automatic discovery routes each test or configuration save once', async () => {
        await controller.activate();
        add('enabled');
        discoveryDisabled.add('later-enabled');
        const later = add('later-enabled');
        const trigger = sinon.spy(controller['refreshData'], 'trigger');
        clock = sinon.useFakeTimers();
        save(later);
        assert.strictEqual(trigger.callCount, 0);
        discoveryDisabled.delete(later.name);
        save(later);
        save(later, 'pytest.ini');
        assert.strictEqual(trigger.callCount, 2);
        await clock.tickAsync(250);
        assert.deepStrictEqual(discovered, [later.uri.toString()]);
    });

    test('saving in a project workspace added after activation refreshes that workspace', async () => {
        const projects = new EventEmitter<DidChangePythonProjectsEventArgs>();
        const environments = new EventEmitter<DidChangeEnvironmentEventArgs>();
        events.push(projects, environments);
        const project = { uri: Uri.file('/workspace/later'), name: 'later' } as PythonProject;
        (envExtApi.useEnvExtension as sinon.SinonStub).returns(true);
        sinon.stub(envExtApi, 'getEnvExtApi').resolves({
            getPythonProjects: () => [project],
            getEnvironment: async () => ({ version: '3.12' }),
            onDidChangePythonProjects: projects.event,
            onDidChangeEnvironment: environments.event,
        } as Awaited<ReturnType<typeof envExtApi.getEnvExtApi>>);
        add('startup');
        await controller.activate();
        const later = add('later');
        await controller['handleProjectChanges']({ added: [project], removed: [] });
        assert.deepStrictEqual(discovered, [later.uri.toString()]);
        clock = sinon.useFakeTimers();
        save(later);
        await clock.tickAsync(250);
        assert.deepStrictEqual(discovered, [later.uri.toString(), later.uri.toString()]);
    });

    test('older coverage details remain available after collecting the retired adapter', async () => {
        await controller.activate();
        const before = queryObjects(WorkspaceTestAdapter);
        const folder = add('coverage');
        let report: FileCoverage | undefined;
        const run = {
            addCoverage: (file: FileCoverage) => {
                report = file;
            },
        } as TestRun;
        const file = Uri.joinPath(folder.uri, 'test_coverage.py');
        onDiscovery = (_uri, resolver) => {
            resolver.resolveExecution(
                {
                    coverage: true,
                    cwd: folder.uri.fsPath,
                    error: '',
                    result: {
                        [file.fsPath]: {
                            lines_covered: [2],
                            lines_missed: [3],
                            executed_branches: 0,
                            total_branches: -1,
                        },
                    },
                },
                run,
            );
        };
        const profile = { kind: TestRunProfileKind.Coverage } as TestRunProfile;
        controller['setupCoverageIfNeeded']({ profile } as TestRunRequest);
        await controller.refreshTestData(folder.uri, { forceRefresh: true });
        assert.ok(report);
        remove(folder);
        assert.strictEqual(queryObjects(WorkspaceTestAdapter), before);
        assert.ok(profile.loadDetailedCoverage);
        const details = await profile.loadDetailedCoverage(run, report, {
            isCancellationRequested: false,
        } as CancellationToken);
        assert.strictEqual(details.length, 2);
    });
});
