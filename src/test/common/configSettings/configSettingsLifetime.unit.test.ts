// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as TypeMoq from 'typemoq';
import { Disposable, Event, Uri, WorkspaceFolder, WorkspaceFoldersChangeEvent } from 'vscode';
import { IWorkspaceService } from '../../../client/common/application/types';
import { PythonSettings } from '../../../client/common/configSettings';
import { IInterpreterPathService } from '../../../client/common/types';
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
    let configuration: TrackedEvent<never>;
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
        configuration = trackedEvent<never>();
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
        pathService = TypeMoq.Mock.ofType<IInterpreterPathService>();
        pathService.setup((value) => value.onDidChange).returns(() => interpreter.event);
    });
    teardown(() => {
        PythonSettings.dispose();
        sinon.restore();
    });

    test('removing a folder disposes its settings once and removes its listeners', () => {
        const settings = create(removedFolder.uri);
        const disposed = sinon.spy(settings, 'dispose');
        assertListenerCount(1);
        remove(removedFolder);
        assert.strictEqual(disposed.callCount, 1);
        assertListenerCount(0);
        changed.fire({ added: [], removed: [removedFolder] });
        assert.strictEqual(disposed.callCount, 1);
    });

    test('remaining workspace settings stay cached and subscribed', () => {
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
        assertListenerCount(4);

        remove(firstRemovedFolder, secondRemovedFolder);

        assert.strictEqual(retainedDisposed.callCount, 0);
        assert.strictEqual(secondRetainedDisposed.callCount, 0);
        assert.strictEqual(firstRemovedDisposed.callCount, 1);
        assert.strictEqual(secondRemovedDisposed.callCount, 1);
        assert.strictEqual(create(retainedFolder.uri), retained);
        assert.strictEqual(create(secondRetainedFolder.uri), secondRetained);
        assertListenerCount(2);

        changed.fire({ added: [], removed: [firstRemovedFolder, secondRemovedFolder] });
        assert.strictEqual(firstRemovedDisposed.callCount, 1);
        assert.strictEqual(secondRemovedDisposed.callCount, 1);
        assertListenerCount(2);
    });

    test('a provisional re-add cannot keep the removed folder settings subscribed', () => {
        const restore = changed.event(({ removed }) => {
            if (removed.includes(removedFolder)) {
                folders.push(removedFolder);
            }
        });
        const retained = create(retainedFolder.uri);
        const old = create(removedFolder.uri);
        const disposed = sinon.spy(old, 'dispose');

        remove(removedFolder);
        restore.dispose();
        assert.deepStrictEqual(folders, [retainedFolder, removedFolder]);
        // VS Code rolls back a rejected provisional update without another workspace event.
        folders = [retainedFolder];

        assert.strictEqual(disposed.callCount, 1);
        assert.strictEqual(create(retainedFolder.uri), retained);
        assertListenerCount(1);
        folders.push(removedFolder);
        changed.fire({ added: [removedFolder], removed: [] });
        assert.notStrictEqual(create(removedFolder.uri), old);
        assertListenerCount(2);
    });

    test('confirming the first workspace folder disposes the no-folder settings', () => {
        folders = [];
        const globalSettings = create();
        const disposed = sinon.spy(globalSettings, 'dispose');
        assertListenerCount(1);

        folders = [retainedFolder];
        changed.fire({ added: [retainedFolder], removed: [] });

        assert.strictEqual(disposed.callCount, 1);
        assertListenerCount(0);
        const retained = create(retainedFolder.uri);
        assert.notStrictEqual(retained, globalSettings);
        assert.strictEqual(create(), retained);
        assertListenerCount(1);
    });

    test('readding a removed folder creates one fresh listener set', () => {
        const old = create(removedFolder.uri);
        remove(removedFolder);
        folders.push(removedFolder);
        const fresh = create(removedFolder.uri);
        assert.notStrictEqual(fresh, old);
        assert.strictEqual(create(removedFolder.uri), fresh);
        assertListenerCount(1);
    });
});
