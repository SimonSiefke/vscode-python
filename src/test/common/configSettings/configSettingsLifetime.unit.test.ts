// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as TypeMoq from 'typemoq';
import {
    ConfigurationChangeEvent,
    Disposable,
    Event,
    Uri,
    WorkspaceConfiguration,
    WorkspaceFolder,
    WorkspaceFoldersChangeEvent,
} from 'vscode';
import { IWorkspaceService } from '../../../client/common/application/types';
import { PythonSettings } from '../../../client/common/configSettings';
import { IInterpreterPathService } from '../../../client/common/types';
import * as EnvFileTelemetry from '../../../client/telemetry/envFileTelemetry';
import { MockAutoSelectionService } from '../../mocks/autoSelector';
import { MockExtensions } from '../../mocks/extensions';

interface TrackedEvent<T> {
    readonly event: Event<T>;
    readonly listeners: Set<(value: T) => unknown>;
    fire(value: T): void;
}

function trackedEvent<T>(): TrackedEvent<T> {
    const listeners = new Set<(value: T) => unknown>();
    const event: Event<T> = (listener, thisArgs) => {
        const callback = (value: T) => listener.call(thisArgs, value);
        listeners.add(callback);
        return new Disposable(() => {
            listeners.delete(callback);
        });
    };
    return { event, listeners, fire: (value: T) => Array.from(listeners).forEach((listener) => listener(value)) };
}

suite('Python settings workspace lifetime', () => {
    let folders: WorkspaceFolder[];
    let retainedFolder: WorkspaceFolder;
    let removedFolder: WorkspaceFolder;
    let changed: TrackedEvent<WorkspaceFoldersChangeEvent>;
    let configuration: TrackedEvent<ConfigurationChangeEvent>;
    let folderConfigurations: Map<string, WorkspaceConfiguration>;
    let interpreter: TrackedEvent<never>;
    let autoSelection: TrackedEvent<void>;
    let autoSelectionService: MockAutoSelectionService;
    let workspace: TypeMoq.IMock<IWorkspaceService>;
    let pathService: TypeMoq.IMock<IInterpreterPathService>;
    const folder = (name: string, index: number): WorkspaceFolder => ({ uri: Uri.file(`/work/${name}`), name, index });
    const create = (resource?: Uri) =>
        PythonSettings.getInstance(
            resource,
            autoSelectionService,
            workspace.object,
            pathService.object,
            undefined,
            new MockExtensions(),
        );
    const remove = (...removed: WorkspaceFolder[]) => {
        folders = folders.filter((item) => !removed.includes(item));
        changed.fire({ added: [], removed });
    };
    const assertListenerCount = (count: number) => {
        assert.strictEqual(changed.listeners.size, count);
        assert.strictEqual(configuration.listeners.size, count);
        assert.strictEqual(interpreter.listeners.size, count);
        assert.strictEqual(autoSelection.listeners.size, count);
    };

    setup(() => {
        PythonSettings.dispose();
        retainedFolder = folder('retained', 0);
        removedFolder = folder('removed', 1);
        folders = [retainedFolder, removedFolder];
        changed = trackedEvent<WorkspaceFoldersChangeEvent>();
        configuration = trackedEvent<ConfigurationChangeEvent>();
        folderConfigurations = new Map();
        interpreter = trackedEvent<never>();
        autoSelection = trackedEvent<void>();
        autoSelectionService = new MockAutoSelectionService();
        sinon.stub(autoSelectionService, 'onDidChangeAutoSelectedInterpreter').get(() => autoSelection.event);
        workspace = TypeMoq.Mock.ofType<IWorkspaceService>();
        workspace.setup((value) => value.workspaceFolders).returns(() => folders);
        workspace
            .setup((value) => value.getWorkspaceFolder(TypeMoq.It.isAny()))
            .returns((resource: Uri) => folders.find((item) => item.uri.toString() === resource.toString()));
        workspace.setup((value) => value.onDidChangeWorkspaceFolders).returns(() => changed.event);
        workspace.setup((value) => value.onDidChangeConfiguration).returns(() => configuration.event);
        workspace
            .setup((value) => value.getConfiguration(TypeMoq.It.isAny(), TypeMoq.It.isAny()))
            .returns((section: string, resource?: Uri) =>
                section === 'python' && resource ? folderConfigurations.get(resource.toString())! : undefined!,
            );
        pathService = TypeMoq.Mock.ofType<IInterpreterPathService>();
        pathService.setup((value) => value.get(TypeMoq.It.isAny())).returns(() => 'python');
        pathService.setup((value) => value.onDidChange).returns(() => interpreter.event);
    });
    teardown(() => {
        PythonSettings.dispose();
        sinon.restore();
        assert.strictEqual(changed.listeners.size, 0);
        assert.strictEqual(configuration.listeners.size, 0);
        assert.strictEqual(interpreter.listeners.size, 0);
        assert.strictEqual(autoSelection.listeners.size, 0);
    });

    test('removing a folder disposes its settings once without changing the shared listeners', () => {
        const settings = create(removedFolder.uri);
        const disposed = sinon.spy(settings, 'dispose');
        assertListenerCount(1);
        remove(removedFolder);
        assert.strictEqual(disposed.callCount, 1);
        assertListenerCount(1);
        changed.fire({ added: [], removed: [removedFolder] });
        assert.strictEqual(disposed.callCount, 1);
    });

    test('remaining workspace settings stay cached after another folder is removed', () => {
        const retained = create(retainedFolder.uri);
        const removed = create(removedFolder.uri);
        const retainedDisposed = sinon.spy(retained, 'dispose');
        const removedDisposed = sinon.spy(removed, 'dispose');
        remove(removedFolder);
        assert.strictEqual(retainedDisposed.callCount, 0);
        assert.strictEqual(removedDisposed.callCount, 1);
        assert.strictEqual(create(retainedFolder.uri), retained);
        assertListenerCount(1);
    });

    test('one workspace event disposes every removed settings owner', () => {
        const secondRetainedFolder = folder('second-retained', 1);
        const firstRemovedFolder = folder('first-removed', 2);
        const secondRemovedFolder = folder('second-removed', 3);
        folders = [retainedFolder, secondRetainedFolder, firstRemovedFolder, secondRemovedFolder];
        const retained = create(retainedFolder.uri);
        const secondRetained = create(secondRetainedFolder.uri);
        const retainedDisposed = sinon.spy(retained, 'dispose');
        const secondRetainedDisposed = sinon.spy(secondRetained, 'dispose');
        const firstRemovedDisposed = sinon.spy(create(firstRemovedFolder.uri), 'dispose');
        const secondRemovedDisposed = sinon.spy(create(secondRemovedFolder.uri), 'dispose');
        assertListenerCount(1);

        remove(firstRemovedFolder, secondRemovedFolder);

        assert.strictEqual(retainedDisposed.callCount, 0);
        assert.strictEqual(secondRetainedDisposed.callCount, 0);
        assert.strictEqual(firstRemovedDisposed.callCount, 1);
        assert.strictEqual(secondRemovedDisposed.callCount, 1);
        assert.strictEqual(create(retainedFolder.uri), retained);
        assert.strictEqual(create(secondRetainedFolder.uri), secondRetained);
        assertListenerCount(1);

        changed.fire({ added: [], removed: [firstRemovedFolder, secondRemovedFolder] });
        assert.strictEqual(firstRemovedDisposed.callCount, 1);
        assert.strictEqual(secondRemovedDisposed.callCount, 1);
        assertListenerCount(1);
    });

    test('a provisional re-add cannot keep the removed folder settings alive', () => {
        const provisionalFolder = { ...removedFolder };
        const restore = changed.event(({ removed }) => {
            if (removed.includes(removedFolder)) {
                folders.push(provisionalFolder);
            }
        });
        const retained = create(retainedFolder.uri);
        const old = create(removedFolder.uri);
        const disposed = sinon.spy(old, 'dispose');

        remove(removedFolder);
        restore.dispose();
        assert.deepStrictEqual(folders, [retainedFolder, provisionalFolder]);
        assert.strictEqual(disposed.callCount, 1);

        const provisional = create(removedFolder.uri);
        assert.notStrictEqual(provisional, old);
        assert.strictEqual(provisional, create(removedFolder.uri));
        assertListenerCount(1);

        // VS Code rolls back a rejected provisional update without another workspace event.
        folders = [retainedFolder];
        const other = folder('other', 1);
        folders.push(other);
        changed.fire({ added: [other], removed: [] });
        assert.strictEqual(create(retainedFolder.uri), retained);
        assertListenerCount(1);
        remove(other);

        const confirmedFolder = { ...removedFolder };
        folders.push(confirmedFolder);
        changed.fire({ added: [confirmedFolder], removed: [] });
        const confirmed = create(removedFolder.uri);
        assert.notStrictEqual(confirmed, old);
        assert.notStrictEqual(confirmed, provisional);
        assert.strictEqual(create(removedFolder.uri), confirmed);
        assertListenerCount(1);
    });

    test('reading an optimistic folder before URI normalization leaves no subscriptions behind', () => {
        const retained = create(retainedFolder.uri);
        sinon.stub(EnvFileTelemetry, 'sendSettingTelemetry');
        const optimisticFolder = folder('normalized/', 2);
        const confirmedFolder = folder('normalized', 2);
        assert.notStrictEqual(confirmedFolder.uri.toString(), optimisticFolder.uri.toString());
        const configuration = TypeMoq.Mock.ofType<WorkspaceConfiguration>();
        configuration.setup((value) => value.get('envFile')).returns(() => 'provisional.env');
        folderConfigurations.set(optimisticFolder.uri.toString(), configuration.object);

        folders.push(optimisticFolder);
        const optimistic = create(optimisticFolder.uri);
        assert.strictEqual(optimistic.envFile, 'provisional.env');
        assertListenerCount(1);

        folders[2] = confirmedFolder;
        changed.fire({ added: [confirmedFolder], removed: [] });
        const confirmed = create(confirmedFolder.uri);
        assert.notStrictEqual(confirmed, optimistic);
        assert.strictEqual(create(confirmedFolder.uri), confirmed);
        assertListenerCount(1);

        remove(confirmedFolder);
        assert.strictEqual(create(retainedFolder.uri), retained);
        assertListenerCount(1);
    });

    test('resetting settings registration releases owners and subscriptions before the next lookup', () => {
        const retained = create(retainedFolder.uri);
        const removed = create(removedFolder.uri);
        const retainedDisposed = sinon.spy(retained, 'dispose');
        const removedDisposed = sinon.spy(removed, 'dispose');
        assertListenerCount(1);

        retained.register();

        assert.strictEqual(retainedDisposed.callCount, 1);
        assert.strictEqual(removedDisposed.callCount, 1);
        assertListenerCount(0);
        const freshRetained = create(retainedFolder.uri);
        const freshRemoved = create(removedFolder.uri);
        assert.notStrictEqual(freshRetained, retained);
        assert.notStrictEqual(freshRemoved, removed);
        const freshRemovedDisposed = sinon.spy(freshRemoved, 'dispose');
        assertListenerCount(1);

        remove(removedFolder);
        assert.strictEqual(freshRemovedDisposed.callCount, 1);
        assert.strictEqual(create(retainedFolder.uri), freshRetained);
        assertListenerCount(1);
    });

    test('a folder restored after a silent startup rollback can be cached', () => {
        // A pre-existing root is temporarily absent when Python first reads settings.
        folders = [retainedFolder];
        const retained = create(retainedFolder.uri);

        folders = [retainedFolder, removedFolder];
        const restored = create(removedFolder.uri);

        assert.strictEqual(create(removedFolder.uri), restored);
        assert.strictEqual(create(retainedFolder.uri), retained);
        assertListenerCount(1);
    });

    test('a retained root keeps its owner when the host replaces the folder object without a delta', () => {
        const retained = create(retainedFolder.uri);
        const replacement = { ...retainedFolder };
        folders = [replacement, removedFolder];
        changed.fire({ added: [], removed: [] });

        assert.strictEqual(create(replacement.uri), retained);
        const disposed = sinon.spy(retained, 'dispose');
        remove(replacement);
        assert.strictEqual(disposed.callCount, 1);
        assertListenerCount(1);
    });

    test('folders with the same filesystem path have independent settings ownership', () => {
        const otherScheme = { ...retainedFolder, uri: retainedFolder.uri.with({ scheme: 'memfs' }) };
        assert.strictEqual(otherScheme.uri.fsPath, retainedFolder.uri.fsPath);
        assert.notStrictEqual(otherScheme.uri.toString(), retainedFolder.uri.toString());
        folders = [retainedFolder, otherScheme];
        const retained = create(retainedFolder.uri);
        const remote = create(otherScheme.uri);
        assert.notStrictEqual(retained, remote);
        const remoteDisposed = sinon.spy(remote, 'dispose');
        const retainedDisposed = sinon.spy(retained, 'dispose');

        remove(otherScheme);

        assert.strictEqual(remoteDisposed.callCount, 1);
        assert.strictEqual(retainedDisposed.callCount, 0);
        assert.strictEqual(create(retainedFolder.uri), retained);
        assertListenerCount(1);
    });

    test('a provisional settings reference receives configuration changes before confirmation', () => {
        sinon.stub(EnvFileTelemetry, 'sendSettingTelemetry');
        create(retainedFolder.uri);
        const provisionalFolder = folder('launch', 2);
        const config = TypeMoq.Mock.ofType<WorkspaceConfiguration>();
        let launchArgs: string[] = [];
        config.setup((value) => value.get('terminal')).returns(() => ({ launchArgs }));
        folderConfigurations.set(provisionalFolder.uri.toString(), config.object);
        folders.push(provisionalFolder);

        const executionSettings = create(provisionalFolder.uri);
        assert.deepStrictEqual(executionSettings.terminal.launchArgs, []);

        launchArgs = ['-u'];
        configuration.fire({ affectsConfiguration: (section) => section === 'python' });
        changed.fire({ added: [provisionalFolder], removed: [] });

        assert.deepStrictEqual(executionSettings.terminal.launchArgs, ['-u']);
        assert.strictEqual(create(provisionalFolder.uri), executionSettings);
        assertListenerCount(1);
    });

    test('a settings load that throws does not add an owner or start watching', () => {
        sinon.stub(EnvFileTelemetry, 'sendSettingTelemetry');
        const config = TypeMoq.Mock.ofType<WorkspaceConfiguration>();
        config.setup((value) => value.get('testing')).returns(() => ({ pytestArgs: '-q', unittestArgs: [] }));
        folderConfigurations.set(removedFolder.uri.toString(), config.object);

        assert.throws(() => create(removedFolder.uri), TypeError);
        assert.throws(() => create(removedFolder.uri), TypeError);
        assertListenerCount(0);
        const retained = create(retainedFolder.uri);
        remove(removedFolder);
        assert.strictEqual(create(retainedFolder.uri), retained);
        assertListenerCount(1);
    });

    test('confirming the first workspace folder disposes the no-folder settings', () => {
        folders = [];
        const globalSettings = create();
        const disposed = sinon.spy(globalSettings, 'dispose');
        assertListenerCount(1);

        folders = [retainedFolder];
        changed.fire({ added: [retainedFolder], removed: [] });

        assert.strictEqual(disposed.callCount, 1);
        assertListenerCount(1);
        const retained = create(retainedFolder.uri);
        assert.notStrictEqual(retained, globalSettings);
        assert.strictEqual(create(), retained);
        assertListenerCount(1);
    });

    test('readding a removed folder creates a fresh settings owner', () => {
        const old = create(removedFolder.uri);
        remove(removedFolder);
        folders.push(removedFolder);
        changed.fire({ added: [removedFolder], removed: [] });
        const fresh = create(removedFolder.uri);
        assert.notStrictEqual(fresh, old);
        assert.strictEqual(create(removedFolder.uri), fresh);
        assertListenerCount(1);
    });
});
