// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import { queryObjects } from 'node:v8';
import * as sinon from 'sinon';
import * as TypeMoq from 'typemoq';
import {
    CancellationToken,
    CancellationTokenSource,
    Disposable,
    EventEmitter,
    FileCoverage,
    FileSystemWatcher,
    StatementCoverage,
    TestItem,
    TestController,
    TestRunProfile,
    TestRunProfileKind,
    TestRunRequest,
    TextDocument,
    Uri,
    Range,
    WorkspaceFolder,
    WorkspaceFoldersChangeEvent,
    tests,
} from 'vscode';
import { ICommandManager, IWorkspaceService } from '../../../client/common/application/types';
import { IPythonExecutionFactory } from '../../../client/common/process/types';
import { IConfigurationService, IPythonSettings } from '../../../client/common/types';
import { createDeferred } from '../../../client/common/utils/async';
import { Architecture } from '../../../client/common/utils/platform';
import { IEnvironmentVariablesProvider } from '../../../client/common/variables/types';
import * as workspaceApis from '../../../client/common/vscodeApis/workspaceApis';
import * as envExtApi from '../../../client/envExt/api.internal';
import {
    DidChangeEnvironmentEventArgs,
    DidChangePythonProjectsEventArgs,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonProject,
} from '../../../client/envExt/types';
import { IInterpreterService } from '../../../client/interpreter/contracts';
import { EnvironmentType, PythonEnvironment as Interpreter } from '../../../client/pythonEnvironments/info';
import { ITestDebugLauncher } from '../../../client/testing/common/types';
import { ITestingSettings } from '../../../client/testing/configuration/types';
import { setupCoverageForProjects } from '../../../client/testing/testController/common/projectTestExecution';
import { ProjectAdapter } from '../../../client/testing/testController/common/projectAdapter';
import { TestCoverageHandler } from '../../../client/testing/testController/common/testCoverageHandler';
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
    let watchers: Array<{ dispose: sinon.SinonSpy; created: EventEmitter<Uri>; deleted: EventEmitter<Uri> }>;
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
    let onExecution: ITestExecutionAdapter['runTests'] | undefined;

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
        onExecution = undefined;
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
                watchers.push({ dispose, created, deleted });
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
                executionAdapter: {
                    async runTests(...args) {
                        await onExecution?.(...args);
                    },
                },
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
        testController.items.get = (id) => roots.get(id);
        testController.items.add = (item) => {
            roots.set(item.id, item);
        };
        testController.items.delete = (id) => {
            roots.delete(id);
        };
        testController.items.forEach = (callback, thisArg) => {
            roots.forEach((item) => callback.call(thisArg, item, testController.items));
        };
        testController.createTestItem = (id, label, uri) => {
            const children = new Map<string, TestItem>();
            const item = {
                id,
                label,
                uri,
                children: {
                    get: (key: string) => children.get(key),
                    add: (child: TestItem) => {
                        children.set(child.id, child);
                        Object.defineProperty(child, 'parent', { value: item, configurable: true });
                    },
                    forEach: (callback: (child: TestItem) => void) => children.forEach(callback),
                },
            } as TestItem;
            return item;
        };
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
            tests: {
                path: uri.fsPath,
                id_: uri.fsPath,
                type_: 'folder',
                name,
                children: [
                    {
                        path: Uri.joinPath(uri, 'test_current.py').fsPath,
                        name,
                        type_: 'test',
                        id_: 'case',
                        runID: 'case',
                        lineno: 1,
                    },
                ],
            },
        });
    }

    function prepareRun() {
        const source = new CancellationTokenSource();
        const disposed = new EventEmitter<void>();
        events.push(source, disposed);
        const run = {
            name: 'test run',
            isPersisted: false,
            token: source.token,
            started: sinon.spy(),
            enqueued: sinon.spy(),
            skipped: sinon.spy(),
            failed: sinon.spy(),
            errored: sinon.spy(),
            passed: sinon.spy(),
            appendOutput: sinon.spy(),
            addCoverage: sinon.spy(),
            end: sinon.spy(),
            onDidDispose: disposed.event,
        };
        testController.createTestRun = () => run;
        return run;
    }

    function runRequest(include?: TestItem[], profile?: TestRunProfile): TestRunRequest {
        return { include, exclude: undefined, profile, preserveFocus: false };
    }

    function stubInterpreter(result: () => Promise<Interpreter | undefined>): void {
        interpreters.reset();
        interpreters.setup((value) => value.getActiveInterpreter(TypeMoq.It.isAny())).returns(result);
    }

    const activeInterpreter: Interpreter = {
        path: '/usr/bin/python3',
        sysPrefix: '/usr',
        architecture: Architecture.x64,
        envType: EnvironmentType.Unknown,
    };

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

    for (const removeLatestPublisher of [false, true]) {
        test(`removing the ${
            removeLatestPublisher ? 'latest' : 'first'
        } publisher leaves shared tests runnable`, async () => {
            await controller.activate();
            const retained = add('parent');
            const removed = add('parent/child');
            onDiscovery = (uri, resolver) =>
                publishRoot(resolver, removed.uri, uri === retained.uri ? 'parent' : 'child');
            const publishers = removeLatestPublisher ? [retained, removed] : [removed, retained];
            for (const publisher of publishers) {
                // eslint-disable-next-line no-await-in-loop
                await controller.refreshTestData(publisher.uri, { forceRefresh: true });
            }
            const restored = createDeferred<void>();
            events.push(controller.onRefreshingCompleted(() => restored.resolve()));
            remove(removed);
            if (removeLatestPublisher) {
                await restored.promise;
            }
            const root = testController.items.get(removed.uri.fsPath);
            assert.ok(root);
            assert.strictEqual(root.label, 'parent');
            const leaf = root.children.get('case');
            assert.ok(leaf);
            const run = prepareRun();
            stubInterpreter(async () => activeInterpreter);
            const execute = sinon.spy();
            onExecution = async (...args) => execute(...args);
            await controller['runTests'](runRequest([leaf]), run.token);
            assert.deepStrictEqual(
                execute.getCalls().map(({ args }) => [args[0], args[1]]),
                [[retained.uri, ['case']]],
            );
        });
    }

    test('shared root is recovered when the surviving discovery published before it finished', async () => {
        await controller.activate();
        const survivor = add('parent');
        const removed = add('parent/child');
        const published = createDeferred<void>();
        const finish = createDeferred<void>();
        const joined = createDeferred<void>();
        const restored = createDeferred<void>();
        let first = true;
        onDiscovery = async (uri, resolver) => {
            publishRoot(resolver, removed.uri, uri === survivor.uri ? 'survivor' : 'removed');
            if (uri === survivor.uri) {
                if (first) {
                    first = false;
                    published.resolve();
                    await finish.promise;
                } else {
                    restored.resolve();
                }
            }
        };
        const existing = controller.refreshTestData(survivor.uri, { forceRefresh: true });
        await published.promise;
        await controller.refreshTestData(removed.uri, { forceRefresh: true });
        const originalDiscovery = WorkspaceTestAdapter.prototype.discoverTests;
        sinon
            .stub(WorkspaceTestAdapter.prototype, 'discoverTests')
            .callsFake(function (this: WorkspaceTestAdapter, ...args) {
                const result = originalDiscovery.apply(this, args);
                joined.resolve();
                return result;
            });
        remove(removed);
        await joined.promise;
        finish.resolve();
        await existing;
        await restored.promise;
        assert.strictEqual(testController.items.get(removed.uri.fsPath)?.label, 'survivor');
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

    test('automatic discovery does not transfer a queued save to the parent or a replacement', async () => {
        await controller.activate();
        discoveryDisabled.add('parent');
        add('parent');
        const child = add('parent/child');
        clock = sinon.useFakeTimers();
        save(child);
        remove(child);
        await clock.tickAsync(250);
        assert.deepStrictEqual(discovered, []);

        const old = add('parent/child');
        save(old);
        remove(old);
        const replacement = add('parent/child');
        await clock.tickAsync(250);
        assert.deepStrictEqual(discovered, []);
        save(replacement);
        await clock.tickAsync(250);
        assert.deepStrictEqual(discovered, [replacement.uri.toString()]);
    });

    test('configuration file watchers refresh their live owner through removal and replacement', async () => {
        await controller.activate();
        const retired = add('retired');
        const survivor = add('survivor');
        const retiredConfig = Uri.joinPath(retired.uri, 'pytest.ini');
        const survivorConfig = Uri.joinPath(survivor.uri, 'pytest.ini');
        clock = sinon.useFakeTimers();
        watchers[1].created.fire(survivorConfig);
        await clock.tickAsync(250);
        watchers[1].deleted.fire(survivorConfig);
        await clock.tickAsync(250);
        watchers[0].created.fire(retiredConfig);
        remove(retired);
        const replacement = add('retired');
        await clock.tickAsync(250);
        watchers[0].deleted.fire(retiredConfig);
        await clock.tickAsync(250);
        assert.deepStrictEqual(discovered, [survivor.uri.toString(), survivor.uri.toString()]);
        watchers[2].deleted.fire(retiredConfig);
        await clock.tickAsync(250);
        assert.deepStrictEqual(discovered, [
            survivor.uri.toString(),
            survivor.uri.toString(),
            replacement.uri.toString(),
        ]);
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

    for (const trigger of ['Refresh All', 'initial Test Explorer resolution']) {
        test(`${trigger} cannot transfer discovery to a replacement workspace`, async () => {
            await controller.activate();
            const retired = add('old');
            const started = createDeferred<void>();
            const interpreter = createDeferred<Interpreter>();
            stubInterpreter(() => {
                started.resolve();
                return interpreter.promise;
            });
            const pending =
                trigger === 'Refresh All'
                    ? controller.refreshTestData(undefined, { forceRefresh: true })
                    : testController.resolveHandler?.(undefined);
            await started.promise;
            remove(retired);
            const replacement = add('old');
            interpreter.resolve(activeInterpreter);
            await pending;
            assert.deepStrictEqual(discovered, []);
            await controller.refreshTestData(replacement.uri, { forceRefresh: true });
            assert.deepStrictEqual(discovered, [replacement.uri.toString()]);
        });
    }

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

    test('a run waiting for its interpreter cannot execute on a replacement workspace', async () => {
        await controller.activate();
        const folder = add('reused');
        onDiscovery = (uri, resolver) => publishRoot(resolver, uri, 'old root');
        await controller.refreshTestData(folder.uri, { forceRefresh: true });
        const leaf = testController.items.get(folder.uri.fsPath)?.children.get('case');
        assert.ok(leaf);
        const lookupStarted = createDeferred<void>();
        const lookup = createDeferred<Interpreter>();
        stubInterpreter(() => {
            lookupStarted.resolve();
            return lookup.promise;
        });
        const run = prepareRun();
        const execute = sinon.spy();
        onExecution = async (...args) => execute(...args);
        const pending = controller['runTests'](runRequest([leaf]), run.token);
        await lookupStarted.promise;
        remove(folder);
        const replacement = add('reused');
        stubInterpreter(async () => activeInterpreter);
        await controller.refreshTestData(replacement.uri, { forceRefresh: true });
        lookup.resolve(activeInterpreter);
        await pending;
        sinon.assert.notCalled(execute);
        sinon.assert.notCalled(run.started);
        sinon.assert.calledOnce(run.end);
    });

    test('removal cancels only the retired provider while a surviving execution finishes', async () => {
        await controller.activate();
        const retired = add('retired');
        const retained = add('retained');
        onDiscovery = (uri, resolver) => publishRoot(resolver, uri, uri.fsPath);
        await controller.refreshTestData(retired.uri, { forceRefresh: true });
        await controller.refreshTestData(retained.uri, { forceRefresh: true });
        stubInterpreter(async () => activeInterpreter);
        const run = prepareRun();
        const retiredStarted = createDeferred<CancellationToken>();
        const retainedStarted = createDeferred<CancellationToken>();
        const retiredCancelled = createDeferred<void>();
        const retainedFinished = createDeferred<void>();
        onExecution = async (uri, ids, _profile, _run, _factory, _debug, _interpreter, _project, token) => {
            assert.deepStrictEqual(ids, ['case']);
            assert.ok(token);
            if (uri === retired.uri) {
                const subscription = token.onCancellationRequested(() => retiredCancelled.resolve());
                retiredStarted.resolve(token);
                await retiredCancelled.promise;
                subscription.dispose();
            } else {
                retainedStarted.resolve(token);
                await retainedFinished.promise;
            }
        };
        const pending = controller['runTests'](runRequest(), run.token);
        const [retiredToken, retainedToken] = await Promise.all([retiredStarted.promise, retainedStarted.promise]);
        remove(retired);
        assert.strictEqual(retiredToken.isCancellationRequested, true);
        assert.ok(!retainedToken.isCancellationRequested);
        assert.ok(!run.token.isCancellationRequested);
        sinon.assert.notCalled(run.end);
        retainedFinished.resolve();
        await pending;
        sinon.assert.calledTwice(run.started);
        sinon.assert.calledOnce(run.end);
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

    test('project events during startup register added workspaces before later saves', async () => {
        const projects = new EventEmitter<DidChangePythonProjectsEventArgs>();
        const environments = new EventEmitter<DidChangeEnvironmentEventArgs>();
        events.push(projects, environments);
        const project: PythonProject = { uri: Uri.file('/workspace/later'), name: 'later' };
        const initiallyReadyProject: PythonProject = { uri: Uri.file('/workspace/ready'), name: 'ready' };
        const environmentRoot = Uri.joinPath(project.uri, '.venv');
        const executable = Uri.joinPath(environmentRoot, 'bin', 'python');
        const environment: PythonEnvironment = {
            name: '.venv',
            displayName: 'Python 3.12 (.venv)',
            displayPath: executable.fsPath,
            version: '3.12',
            environmentPath: environmentRoot,
            sysPrefix: environmentRoot.fsPath,
            execInfo: { run: { executable: executable.fsPath } },
            envId: { id: 'later-venv', managerId: 'test' },
        };
        const api: Partial<PythonEnvironmentApi> = {
            getPythonProjects: () => [project, initiallyReadyProject],
            getEnvironment: async () => environment,
            onDidChangePythonProjects: projects.event,
            onDidChangeEnvironment: environments.event,
        };
        (envExtApi.useEnvExtension as sinon.SinonStub).returns(true);
        sinon.stub(envExtApi, 'getEnvExtApi').resolves(api as PythonEnvironmentApi);
        const startup = add('startup');
        const ready = add('ready');
        const activationLookup = createDeferred<Interpreter>();
        const activationLookupStarted = createDeferred<void>();
        stubInterpreter(() => {
            activationLookupStarted.resolve();
            return activationLookup.promise;
        });
        const activation = controller.activate();
        await activationLookupStarted.promise;
        clock = sinon.useFakeTimers();
        await clock.tickAsync(0);
        assert.ok(controller['projectRegistry'].hasProjects(ready.uri));
        save(startup);
        save(ready);
        await clock.tickAsync(250);
        assert.deepStrictEqual(discovered, []);
        const later = add('later');
        projects.fire({ added: [project], removed: [] });
        activationLookup.resolve(activeInterpreter);
        await activation;
        assert.deepStrictEqual(discovered, []);
        assert.ok(controller['projectRegistry'].hasProjects(later.uri));
        save(later);
        await clock.tickAsync(250);
        assert.deepStrictEqual(discovered, [later.uri.toString()]);
    });

    test('legacy and project reports for the same file retain their own details after retirement', async () => {
        await controller.activate();
        const before = queryObjects(WorkspaceTestAdapter);
        const folder = add('coverage');
        const run = prepareRun();
        const file = Uri.joinPath(folder.uri, 'test_current.py');
        const coverage = (covered: number, missed: number) => ({
            coverage: true,
            cwd: folder.uri.fsPath,
            error: '',
            result: {
                [file.fsPath]: {
                    lines_covered: [covered],
                    lines_missed: [missed],
                    executed_branches: 0,
                    total_branches: -1,
                },
            },
        });
        onDiscovery = (uri, resolver) => {
            publishRoot(resolver, uri, 'coverage');
            onExecution = async () => resolver.resolveExecution(coverage(2, 3), run);
        };
        const profile = { kind: TestRunProfileKind.Coverage } as TestRunProfile;
        const request = runRequest(undefined, profile);
        stubInterpreter(async () => activeInterpreter);
        await controller.refreshTestData(folder.uri, { forceRefresh: true });
        await controller['runTests'](request, run.token);
        sinon.assert.calledOnce(run.addCoverage);
        const reports = run.addCoverage.getCalls().map(({ args }) => args[0] as FileCoverage);
        // Sinon keeps call-site receivers alive for assertions. Keep only the actual report.
        run.started.resetHistory();
        run.addCoverage.resetHistory();
        assert.ok(profile.loadDetailedCoverage);
        const legacyLoader = profile.loadDetailedCoverage;
        onExecution = undefined;
        remove(folder);
        await new Promise<void>(setImmediate);
        assert.strictEqual(queryObjects(WorkspaceTestAdapter), before);

        const detailedCoverageMap = new TestCoverageHandler().processCoverage(coverage(9, 2), run);
        const project = { resultResolver: { detailedCoverageMap } } as ProjectAdapter;
        setupCoverageForProjects(request, [project]);
        assert.ok(profile.loadDetailedCoverage);
        const detailsFor = async (loader: typeof legacyLoader, report: FileCoverage) => {
            const details = await loader(run, report, run.token);
            return details.map((detail) => [
                ((detail as StatementCoverage).location as Range).start.line,
                detail.executed,
            ]);
        };
        reports.push(...run.addCoverage.getCalls().map(({ args }) => args[0] as FileCoverage));
        assert.strictEqual(reports.length, 2);
        assert.deepStrictEqual(await detailsFor(legacyLoader, reports[0]), [
            [1, true],
            [2, false],
        ]);
        assert.deepStrictEqual(await detailsFor(profile.loadDetailedCoverage, reports[0]), [
            [1, true],
            [2, false],
        ]);
        assert.deepStrictEqual(await detailsFor(profile.loadDetailedCoverage, reports[1]), [
            [8, true],
            [1, false],
        ]);
    });
});
