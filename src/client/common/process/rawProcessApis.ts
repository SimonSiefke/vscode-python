// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { ChildProcess, exec, execSync, spawn } from 'child_process';
import { errorMonitor, EventEmitter } from 'events';
import { Readable } from 'stream';
import { Observable } from 'rxjs/Observable';
import { IDisposable } from '../types';
import { createDeferred } from '../utils/async';
import { EnvironmentVariables } from '../variables/types';
import { DEFAULT_ENCODING } from './constants';
import { ExecutionResult, ObservableExecutionResult, Output, ShellOptions, SpawnOptions, StdErrError } from './types';
import { noop } from '../utils/misc';
import { decodeBuffer } from './decoder';
import { traceVerbose } from '../../logging';
import { WorkspaceService } from '../application/workspace';
import { ProcessLogger } from './logger';

const PS_ERROR_SCREEN_BOGUS = /your [0-9]+x[0-9]+ screen size is bogus\. expect trouble/;

function trackProcess(proc: ChildProcess, disposable: IDisposable, disposables?: Set<IDisposable>): void {
    if (!disposables) {
        return;
    }

    const processEvents: EventEmitter = proc;
    const releaseIfStopped = () => {
        if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
            return;
        }
        disposables.delete(disposable);
        proc.removeListener('exit', releaseIfStopped);
        proc.removeListener('close', releaseIfStopped);
        processEvents.removeListener(errorMonitor, releaseIfStopped);
    };

    disposables.add(disposable);
    proc.once('exit', releaseIfStopped);
    proc.once('close', releaseIfStopped);
    // Observe spawn failure without consuming errors from callers that use the raw process.
    processEvents.on(errorMonitor, releaseIfStopped);
}

function stopProcess(proc: ChildProcess, { retry = false } = {}): void {
    // proc.killed records a sent signal. Explicit disposal can retry while a child is still live.
    if (proc.pid && proc.exitCode === null && proc.signalCode === null && (retry || !proc.killed)) {
        killPid(proc.pid);
    }
}

function getDefaultOptions<T extends ShellOptions | SpawnOptions>(options: T, defaultEnv?: EnvironmentVariables): T {
    const defaultOptions = { ...options };
    const execOptions = defaultOptions as SpawnOptions;
    if (execOptions) {
        execOptions.encoding =
            typeof execOptions.encoding === 'string' && execOptions.encoding.length > 0
                ? execOptions.encoding
                : DEFAULT_ENCODING;
        const { encoding } = execOptions;
        delete execOptions.encoding;
        execOptions.encoding = encoding;
    }
    if (!defaultOptions.env || Object.keys(defaultOptions.env).length === 0) {
        const env = defaultEnv || process.env;
        defaultOptions.env = { ...env };
    } else {
        defaultOptions.env = { ...defaultOptions.env };
    }

    if (execOptions && execOptions.extraVariables) {
        defaultOptions.env = { ...defaultOptions.env, ...execOptions.extraVariables };
    }

    // Always ensure we have unbuffered output.
    defaultOptions.env.PYTHONUNBUFFERED = '1';
    if (!defaultOptions.env.PYTHONIOENCODING) {
        defaultOptions.env.PYTHONIOENCODING = 'utf-8';
    }

    return defaultOptions;
}

export function shellExec(
    command: string,
    options: ShellOptions & { doNotLog?: boolean } = {},
    defaultEnv?: EnvironmentVariables,
    disposables?: Set<IDisposable>,
): Promise<ExecutionResult<string>> {
    const shellOptions = getDefaultOptions(options, defaultEnv);
    if (!options.doNotLog) {
        const processLogger = new ProcessLogger(new WorkspaceService());
        const loggingOptions = { ...shellOptions, encoding: shellOptions.encoding ?? undefined };
        processLogger.logProcess(command, undefined, loggingOptions);
    }
    return new Promise((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const callback = (e: any, stdout: any, stderr: any) => {
            if (e && e !== null) {
                reject(e);
            } else if (shellOptions.throwOnStdErr && stderr && stderr.length) {
                reject(new Error(stderr));
            } else {
                stdout = filterOutputUsingCondaRunMarkers(stdout);
                // Make sure stderr is undefined if we actually had none. This is checked
                // elsewhere because that's how exec behaves.
                resolve({ stderr: stderr && stderr.length > 0 ? stderr : undefined, stdout });
            }
        };
        const proc = exec(command, shellOptions, callback); // NOSONAR
        trackProcess(proc, { dispose: () => stopProcess(proc) }, disposables);
    });
}

export function plainExec(
    file: string,
    args: string[],
    options: SpawnOptions & { doNotLog?: boolean } = {},
    defaultEnv?: EnvironmentVariables,
    disposables?: Set<IDisposable>,
): Promise<ExecutionResult<string>> {
    const spawnOptions = getDefaultOptions(options, defaultEnv);
    const encoding = spawnOptions.encoding ? spawnOptions.encoding : 'utf8';
    if (!options.doNotLog) {
        const processLogger = new ProcessLogger(new WorkspaceService());
        processLogger.logProcess(file, args, options);
    }
    const proc = spawn(file, args, spawnOptions);
    // Listen to these errors (unhandled errors in streams tears down the process).
    // Errors will be bubbled up to the `error` event in `proc`, hence no need to log.
    proc.stdout?.on('error', noop);
    proc.stderr?.on('error', noop);
    const deferred = createDeferred<ExecutionResult<string>>();
    trackProcess(proc, { dispose: () => stopProcess(proc, { retry: true }) }, disposables);
    const internalDisposables: IDisposable[] = [];

    // eslint-disable-next-line @typescript-eslint/ban-types
    const on = (ee: Readable | null, name: string, fn: Function) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ee?.on(name, fn as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        internalDisposables.push({ dispose: () => ee?.removeListener(name, fn as any) as any });
    };

    if (options.token) {
        internalDisposables.push(
            options.token.onCancellationRequested(() => {
                if (!deferred.completed) {
                    stopProcess(proc);
                }
            }),
        );
    }

    const stdoutBuffers: Buffer[] = [];
    on(proc.stdout, 'data', (data: Buffer) => {
        stdoutBuffers.push(data);
        options.outputChannel?.append(data.toString());
    });
    const stderrBuffers: Buffer[] = [];
    on(proc.stderr, 'data', (data: Buffer) => {
        if (options.mergeStdOutErr) {
            stdoutBuffers.push(data);
            stderrBuffers.push(data);
        } else {
            stderrBuffers.push(data);
        }
        options.outputChannel?.append(data.toString());
    });

    proc.once('close', () => {
        if (deferred.completed) {
            return;
        }
        const stderr: string | undefined =
            stderrBuffers.length === 0 ? undefined : decodeBuffer(stderrBuffers, encoding);
        if (
            stderr &&
            stderr.length > 0 &&
            options.throwOnStdErr &&
            // ignore this specific error silently; see this issue for context: https://github.com/microsoft/vscode/issues/75932
            !(PS_ERROR_SCREEN_BOGUS.test(stderr) && stderr.replace(PS_ERROR_SCREEN_BOGUS, '').trim().length === 0)
        ) {
            deferred.reject(new StdErrError(stderr));
        } else {
            let stdout = decodeBuffer(stdoutBuffers, encoding);
            stdout = filterOutputUsingCondaRunMarkers(stdout);
            deferred.resolve({ stdout, stderr });
        }
        internalDisposables.forEach((d) => d.dispose());
    });
    proc.once('error', (ex) => {
        deferred.reject(ex);
        internalDisposables.forEach((d) => d.dispose());
    });

    return deferred.promise;
}

function filterOutputUsingCondaRunMarkers(stdout: string) {
    // These markers are added if conda run is used or `interpreterInfo.py` is
    // run, see `get_output_via_markers.py`.
    const regex = />>>PYTHON-EXEC-OUTPUT([\s\S]*)<<<PYTHON-EXEC-OUTPUT/;
    const match = stdout.match(regex);
    const filteredOut = match !== null && match.length >= 2 ? match[1].trim() : undefined;
    return filteredOut !== undefined ? filteredOut : stdout;
}

function removeCondaRunMarkers(out: string) {
    out = out.replace('>>>PYTHON-EXEC-OUTPUT\r\n', '').replace('>>>PYTHON-EXEC-OUTPUT\n', '');
    return out.replace('<<<PYTHON-EXEC-OUTPUT\r\n', '').replace('<<<PYTHON-EXEC-OUTPUT\n', '');
}

export function execObservable(
    file: string,
    args: string[],
    options: SpawnOptions & { doNotLog?: boolean } = {},
    defaultEnv?: EnvironmentVariables,
    disposables?: Set<IDisposable>,
): ObservableExecutionResult<string> {
    const spawnOptions = getDefaultOptions(options, defaultEnv);
    const encoding = spawnOptions.encoding ? spawnOptions.encoding : 'utf8';
    if (!options.doNotLog) {
        const processLogger = new ProcessLogger(new WorkspaceService());
        processLogger.logProcess(file, args, options);
    }
    const proc = spawn(file, args, spawnOptions);
    const dispose = () => {
        stopProcess(proc, { retry: true });
        proc.unref();
    };
    trackProcess(proc, { dispose }, disposables);

    let cancellationRequested = false;
    const output = new Observable<Output<string>>((subscriber) => {
        const internalDisposables: IDisposable[] = [];

        // eslint-disable-next-line @typescript-eslint/ban-types
        const on = (ee: Readable | null, name: string, fn: Function) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ee?.on(name, fn as any);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            internalDisposables.push({ dispose: () => ee?.removeListener(name, fn as any) as any });
        };

        if (options.token) {
            internalDisposables.push(
                options.token.onCancellationRequested(() => {
                    // All subscriptions share one cancellation request for this child.
                    if (!cancellationRequested) {
                        cancellationRequested = true;
                        stopProcess(proc);
                    }
                }),
            );
        }

        const sendOutput = (source: 'stdout' | 'stderr', data: Buffer) => {
            let out = decodeBuffer([data], encoding);
            if (source === 'stderr' && options.throwOnStdErr) {
                subscriber.error(new StdErrError(out));
            } else {
                // Because all of output is not retrieved at once, filtering out the
                // actual output using markers is not possible. Hence simply remove
                // the markers and return original output.
                out = removeCondaRunMarkers(out);
                subscriber.next({ source, out });
            }
        };

        on(proc.stdout, 'data', (data: Buffer) => sendOutput('stdout', data));
        on(proc.stderr, 'data', (data: Buffer) => sendOutput('stderr', data));

        proc.once('close', () => {
            subscriber.complete();
            internalDisposables.forEach((d) => d.dispose());
        });
        proc.once('exit', () => {
            subscriber.complete();
            internalDisposables.forEach((d) => d.dispose());
        });
        proc.once('error', (ex) => {
            subscriber.error(ex);
            internalDisposables.forEach((d) => d.dispose());
        });
        if (options.stdinStr !== undefined) {
            proc.stdin?.write(options.stdinStr);
            proc.stdin?.end();
        }
    });

    return {
        proc,
        out: output,
        dispose,
    };
}

export function killPid(pid: number): void {
    try {
        if (process.platform === 'win32') {
            // Windows doesn't support SIGTERM, so execute taskkill to kill the process
            execSync(`taskkill /pid ${pid} /T /F`); // NOSONAR
        } else {
            process.kill(pid);
        }
    } catch {
        traceVerbose('Unable to kill process with pid', pid);
    }
}
