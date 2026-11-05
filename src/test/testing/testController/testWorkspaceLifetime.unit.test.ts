// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import { queryObjects } from 'node:v8';
import * as sinon from 'sinon';
import * as TypeMoq from 'typemoq';
import {
    Disposable,
    EventEmitter,
    FileSystemWatcher,
    TestController,
    TextDocument,
    Uri,
    WorkspaceFolder,
    WorkspaceFoldersChangeEvent,
    tests,
} from 'vscode';
import { ICommandManager, IWorkspaceService } from '../../../client/common/application/types';
import { IPythonExecutionFactory } from '../../../client/common/process/types';
import { IConfigurationService, IPythonSettings } from '../../../client/common/types';
import { IEnvironmentVariablesProvider } from '../../../client/common/variables/types';
import * as workspaceApis from '../../../client/common/vscodeApis/workspaceApis';
import * as envExtApi from '../../../client/envExt/api.internal';
import { IInterpreterService } from '../../../client/interpreter/contracts';
import { ITestDebugLauncher } from '../../../client/testing/common/types';
import { ITestingSettings } from '../../../client/testing/configuration/types';
import * as projectUtils from '../../../client/testing/testController/common/projectUtils';
import {
    ITestDiscoveryAdapter,
    ITestExecutionAdapter,
    ITestFrameworkController,
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

    setup(async () => {
        registry = [];
        folders = [];
        watchers = [];
        saveSubscriptions = [];
        discovered = [];
        events = [];
        clock = undefined;
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
        const settings = TypeMoq.Mock.ofType<IPythonSettings>();
        settings.setup((value) => value.testing).returns(() => testing);
        configuration = TypeMoq.Mock.ofType<IConfigurationService>();
        configuration.setup((value) => value.getSettings(TypeMoq.It.isAny())).returns(() => settings.object);
        const workspace = TypeMoq.Mock.ofType<IWorkspaceService>();
        workspace.setup((value) => value.workspaceFolders).returns(() => folders);
        workspace.setup((value) => value.onDidChangeWorkspaceFolders).returns(() => changed.event);
        workspace
            .setup((value) => value.getWorkspaceFolder(TypeMoq.It.isAny()))
            .returns((uri: Uri | undefined) =>
                folders.find(
                    (folder) =>
                        uri?.toString().startsWith(folder.uri.toString() + '/') ||
                        uri?.toString() === folder.uri.toString(),
                ),
            );
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
        const discovery = TypeMoq.Mock.ofType<ITestDiscoveryAdapter>();
        discovery
            .setup((value) =>
                value.discoverTests(TypeMoq.It.isAny(), TypeMoq.It.isAny(), TypeMoq.It.isAny(), TypeMoq.It.isAny()),
            )
            .returns(async (uri: Uri) => {
                discovered.push(uri.toString());
            });
        sinon.stub(projectUtils, 'createTestAdapters').returns({
            discoveryAdapter: discovery.object,
            executionAdapter: TypeMoq.Mock.ofType<ITestExecutionAdapter>().object,
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
        await controller.activate();
    });

    teardown(() => {
        registry.forEach((item) => item.dispose());
        events.forEach((event) => event.dispose());
        clock?.restore();
        sinon.restore();
    });

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

    test('removing a workspace disposes its settings watcher', () => {
        remove(add('removed'));
        assert.strictEqual(watchers[0].dispose.callCount, 1);
    });

    test('removing a workspace releases its document-save subscriptions', () => {
        remove(add('removed'));
        assert.strictEqual(saveSubscriptions.length, 2);
        assert.ok(saveSubscriptions.every((dispose) => dispose.callCount === 1));
    });

    test('removed workspace adapters are collectible', () => {
        const before = queryObjects(WorkspaceTestAdapter);
        remove(add('removed'));
        assert.strictEqual(queryObjects(WorkspaceTestAdapter), before);
    });

    test('folder churn does not grow the extension shutdown registry', () => {
        remove(add('first'));
        const registrations = registry.length;
        remove(add('second'));
        assert.strictEqual(registry.length, registrations);
    });

    test('removing a workspace removes its test roots and preserves other workspaces', () => {
        const removed = add('removed');
        const retained = add('removed-sibling');
        const oldRoot = testController.createTestItem('old', 'old', removed.uri);
        const currentRoot = testController.createTestItem('current', 'current', retained.uri);
        testController.items.add(oldRoot);
        testController.items.add(currentRoot);
        remove(removed);
        assert.strictEqual(testController.items.get(oldRoot.id), undefined);
        assert.strictEqual(testController.items.get(currentRoot.id), currentRoot);
    });

    test('a readded workspace still discovers tests', async () => {
        remove(add('reused'));
        const current = add('reused');
        await controller.refreshTestData(current.uri, { forceRefresh: true });
        assert.deepStrictEqual(discovered, [current.uri.toString()]);
        assert.strictEqual(watchers[1].dispose.callCount, 0);
    });

    test('saving a test in a remaining workspace still triggers discovery', async () => {
        const removed = add('removed');
        const retained = add('retained');
        remove(removed);
        const uri = Uri.file(`${retained.uri.fsPath}/test_current.py`);
        const document = TypeMoq.Mock.ofType<TextDocument>();
        document.setup((value) => value.uri).returns(() => uri);
        document.setup((value) => value.fileName).returns(() => uri.fsPath);
        clock = sinon.useFakeTimers();
        saved.fire(document.object);
        assert.deepStrictEqual(discovered, []);
        await clock.tickAsync(250);
        assert.deepStrictEqual(discovered, [retained.uri.toString()]);
        assert.strictEqual(watchers[1].dispose.callCount, 0);
    });
});
