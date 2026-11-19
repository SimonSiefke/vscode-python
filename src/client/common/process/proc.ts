// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { inject, injectable } from 'inversify';

import { IDisposable, IDisposableRegistry } from '../types';
import { EnvironmentVariables } from '../variables/types';
import { execObservable, killPid, plainExec, shellExec } from './rawProcessApis';
import { ExecutionResult, IProcessService, ObservableExecutionResult, ShellOptions, SpawnOptions } from './types';
import { workerPlainExec, workerShellExec } from './worker/rawProcessApiWrapper';

@injectable()
export class ProcessServiceShutdown implements IDisposable {
    private readonly active = new Set<ProcessService>();
    private disposed = false;

    constructor(@inject(IDisposableRegistry) registry: IDisposableRegistry) {
        registry.push(this);
    }

    public get isDisposed(): boolean {
        return this.disposed;
    }

    public add(service: ProcessService): void {
        this.active.add(service);
    }

    public delete(service: ProcessService): void {
        this.active.delete(service);
    }

    public dispose(): void {
        this.disposed = true;
        this.active.forEach((service) => service.dispose());
        this.active.clear();
    }
}

export class ProcessService extends EventEmitter implements IProcessService {
    private readonly processesToKill = new Set<IDisposable>();
    private activeWorkerExecutions = 0;
    private disposed = false;

    constructor(private readonly env?: EnvironmentVariables, private readonly shutdown?: ProcessServiceShutdown) {
        super();
    }

    public static isAlive(pid: number): boolean {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    }

    public static kill(pid: number): void {
        killPid(pid);
    }

    public dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.removeAllListeners();
        this.processesToKill.forEach((p) => {
            try {
                p.dispose();
            } catch {
                // ignore.
            }
        });
        this.processesToKill.clear();
        this.shutdown?.delete(this);
    }

    private assertActive(): void {
        if (this.disposed || this.shutdown?.isDisposed) {
            throw new Error('Process service has been disposed');
        }
    }

    private notifyExecution(file: string, args: string[] | undefined, options: SpawnOptions | ShellOptions): void {
        this.assertActive();
        this.emit('exec', file, args, options);
        this.assertActive();
    }

    private releaseIfIdle(): void {
        if (this.processesToKill.size === 0 && this.activeWorkerExecutions === 0) {
            this.shutdown?.delete(this);
        }
    }

    private readonly trackProcess = (proc: ChildProcess, disposable: IDisposable): void => {
        if (!proc.pid) {
            return;
        }
        if (this.disposed || this.shutdown?.isDisposed) {
            disposable.dispose();
            return;
        }
        this.processesToKill.add(disposable);
        this.shutdown?.add(this);
        proc.once('exit', () => {
            this.processesToKill.delete(disposable);
            this.releaseIfIdle();
        });
    };

    private async trackWorkerExecution(
        execute: () => Promise<ExecutionResult<string>>,
    ): Promise<ExecutionResult<string>> {
        this.activeWorkerExecutions += 1;
        this.shutdown?.add(this);
        try {
            return await execute();
        } finally {
            this.activeWorkerExecutions -= 1;
            this.releaseIfIdle();
        }
    }

    public execObservable(file: string, args: string[], options: SpawnOptions = {}): ObservableExecutionResult<string> {
        this.notifyExecution(file, args, options);
        const execOptions = { ...options, doNotLog: true };
        return execObservable(file, args, execOptions, this.env, this.trackProcess);
    }

    public async exec(file: string, args: string[], options: SpawnOptions = {}): Promise<ExecutionResult<string>> {
        this.notifyExecution(file, args, options);
        if (options.useWorker) {
            return this.trackWorkerExecution(() => workerPlainExec(file, args, options));
        }
        const execOptions = { ...options, doNotLog: true };
        return plainExec(file, args, execOptions, this.env, this.trackProcess);
    }

    public async shellExec(command: string, options: ShellOptions = {}): Promise<ExecutionResult<string>> {
        this.notifyExecution(command, undefined, options);
        if (options.useWorker) {
            return this.trackWorkerExecution(() => workerShellExec(command, options));
        }
        const shellOptions = { ...options, doNotLog: true };
        return shellExec(command, shellOptions, this.env, this.trackProcess);
    }
}
