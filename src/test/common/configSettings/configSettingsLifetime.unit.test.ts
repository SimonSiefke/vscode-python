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
    let changed: TrackedEvent<WorkspaceFoldersChangeEvent>;
    let configuration: TrackedEvent<never>;
    let interpreter: TrackedEvent<never>;
    let workspace: TypeMoq.IMock<IWorkspaceService>;
    let pathService: TypeMoq.IMock<IInterpreterPathService>;
    const folder = (name: string): WorkspaceFolder => ({ uri: Uri.file(`/work/${name}`), name, index: 0 });
    const create = (resource: Uri) =>
        PythonSettings.getInstance(
            resource,
            new MockAutoSelectionService(),
            workspace.object,
            pathService.object,
            undefined,
            new MockExtensions(),
        );
    const remove = (removed: WorkspaceFolder) => {
        folders = folders.filter((item) => item !== removed);
        changed.fire({ added: [], removed: [removed] });
    };

    setup(() => {
        PythonSettings.dispose();
        folders = [folder('removed'), folder('retained')];
        changed = trackedEvent<WorkspaceFoldersChangeEvent>();
        configuration = trackedEvent<never>();
        interpreter = trackedEvent<never>();
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
        const removed = folders[0];
        const settings = create(removed.uri);
        const disposed = sinon.spy(settings, 'dispose');
        assert.strictEqual(changed.listeners.size, 1);
        assert.strictEqual(configuration.listeners.size, 1);
        assert.strictEqual(interpreter.listeners.size, 1);
        remove(removed);
        assert.strictEqual(disposed.callCount, 1);
        assert.strictEqual(changed.listeners.size, 0);
        assert.strictEqual(configuration.listeners.size, 0);
        assert.strictEqual(interpreter.listeners.size, 0);
        changed.fire({ added: [], removed: [removed] });
        assert.strictEqual(disposed.callCount, 1);
    });

    test('remaining workspace settings stay cached and subscribed', () => {
        const removed = folders[0];
        create(removed.uri);
        const retained = create(folders[1].uri);
        const disposed = sinon.spy(retained, 'dispose');
        remove(removed);
        assert.strictEqual(create(folders[0].uri), retained);
        assert.strictEqual(disposed.callCount, 0);
        assert.strictEqual(configuration.listeners.size, 1);
    });

    test('readding a removed folder creates one fresh listener set', () => {
        const removed = folders[0];
        const old = create(removed.uri);
        remove(removed);
        folders.push(removed);
        const fresh = create(removed.uri);
        assert.notStrictEqual(fresh, old);
        assert.strictEqual(create(removed.uri), fresh);
        assert.strictEqual(changed.listeners.size, 1);
        assert.strictEqual(configuration.listeners.size, 1);
    });
});
