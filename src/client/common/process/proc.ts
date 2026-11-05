// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { EventEmitter } from 'events';
import { traceError } from '../../logging';

import { IDisposable, IDisposableRegistry } from '../types';
import { EnvironmentVariables } from '../variables/types';
import { execObservable, killPid, plainExec, shellExec } from './rawProcessApis';
import { ExecutionResult, IProcessService, ObservableExecutionResult, ShellOptions, SpawnOptions } from './types';
import { workerPlainExec, workerShellExec } from './worker/rawProcessApiWrapper';

interface ProcessServiceRegistry {
    readonly active: Set<ProcessService>;
    disposed: boolean;
}

export class ProcessService extends EventEmitter implements IProcessService {
    private static readonly registries = new WeakMap<IDisposableRegistry, ProcessServiceRegistry>();
    private readonly shutdown?: ProcessServiceRegistry;
    private readonly processesToKill = new Set<IDisposable>();
    private activeExecutions = 0;
    private disposed = false;

    constructor(private readonly env?: EnvironmentVariables, registry?: IDisposableRegistry) {
        super();
        if (registry) {
            let shutdown = ProcessService.registries.get(registry);
            if (!shutdown) {
                const owner: ProcessServiceRegistry = { active: new Set(), disposed: false };
                registry.push({
                    dispose: () => {
                        owner.disposed = true;
                        owner.active.forEach((service) => service.dispose());
                        owner.active.clear();
                    },
                });
                ProcessService.registries.set(registry, owner);
                shutdown = owner;
            }
            this.shutdown = shutdown;
        }
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
        this.shutdown?.active.delete(this);
    }

    private beginExecution(): () => void {
        if (this.disposed || this.shutdown?.disposed) {
            throw new Error('Process service has been disposed');
        }
        this.activeExecutions += 1;
        this.shutdown?.active.add(this);
        let completed = false;
        return () => {
            if (!completed) {
                completed = true;
                this.activeExecutions -= 1;
                if (this.activeExecutions === 0) {
                    this.shutdown?.active.delete(this);
                }
            }
        };
    }

    private async trackExecution<T>(execute: () => Promise<T>): Promise<T> {
        const complete = this.beginExecution();
        try {
            return await execute();
        } finally {
            complete();
        }
    }

    public execObservable(file: string, args: string[], options: SpawnOptions = {}): ObservableExecutionResult<string> {
        const complete = this.beginExecution();
        try {
            this.emit('exec', file, args, options);
            const execOptions = { ...options, doNotLog: true };
            const result = execObservable(file, args, execOptions, this.env, this.processesToKill);
            if (result.proc) {
                result.proc.once('close', complete);
                result.proc.once('error', complete);
            } else {
                complete();
            }
            return result;
        } catch (error) {
            complete();
            throw error;
        }
    }

    public exec(file: string, args: string[], options: SpawnOptions = {}): Promise<ExecutionResult<string>> {
        return this.trackExecution(() => {
            this.emit('exec', file, args, options);
            if (options.useWorker) {
                return workerPlainExec(file, args, options);
            }
            const execOptions = { ...options, doNotLog: true };
            return plainExec(file, args, execOptions, this.env, this.processesToKill);
        });
    }

    public shellExec(command: string, options: ShellOptions = {}): Promise<ExecutionResult<string>> {
        return this.trackExecution(() => {
            this.emit('exec', command, undefined, options);
            if (options.useWorker) {
                return workerShellExec(command, options);
            }
            const disposables = new Set<IDisposable>();
            const shellOptions = { ...options, doNotLog: true };
            return shellExec(command, shellOptions, this.env, disposables).finally(() => {
                // Ensure the process we started is cleaned up.
                disposables.forEach((p) => {
                    try {
                        p.dispose();
                    } catch {
                        traceError(`Unable to kill process for ${command}`);
                    }
                });
            });
        });
    }
}
