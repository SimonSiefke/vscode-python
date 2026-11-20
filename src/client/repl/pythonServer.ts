import * as path from 'path';
import * as ch from 'child_process';
import * as rpc from 'vscode-jsonrpc/node';
import { CancellationTokenSource, Disposable, Event, EventEmitter } from 'vscode';
import { EXTENSION_ROOT_DIR } from '../constants';
import { traceError, traceLog } from '../logging';
import { captureTelemetry } from '../telemetry';
import { EventName } from '../telemetry/constants';
import { dispose } from '../common/utils/resourceLifecycle';
import { showInputBox } from '../common/vscodeApis/windowApis';

const SERVER_PATH = path.join(EXTENSION_ROOT_DIR, 'python_files', 'python_server.py');
const SERVER_EXIT_TIMEOUT_MS = 1000;
export interface ExecutionResult {
    status: boolean;
    output: string;
}

export interface PythonServer extends Disposable {
    onCodeExecuted: Event<void>;
    onDidBecomeIdle: Event<void>;
    readonly isExecuting: boolean;
    readonly isDisposed: boolean;
    runWhileBusy<T>(request: () => Promise<T>): Promise<T>;
    execute(code: string): Promise<ExecutionResult | undefined>;
    executeSilently(code: string): Promise<ExecutionResult | undefined>;
    interrupt(): void;
    input(): void;
    checkValidCommand(code: string): Promise<boolean>;
}

class PythonServerImpl implements PythonServer, Disposable {
    private readonly disposables: Disposable[] = [];

    private readonly _onCodeExecuted = new EventEmitter<void>();

    onCodeExecuted = this._onCodeExecuted.event;

    private readonly _onDidBecomeIdle = new EventEmitter<void>();

    onDidBecomeIdle = this._onDidBecomeIdle.event;

    private readonly inputCancellation = new CancellationTokenSource();

    private inFlightRequests = 0;

    private disposed = false;

    public get isExecuting(): boolean {
        return this.inFlightRequests > 0;
    }

    public get isDisposed(): boolean {
        return this.disposed;
    }

    constructor(private connection: rpc.MessageConnection, private pythonServer: ch.ChildProcess) {
        this.initialize();
        this.input();
    }

    private initialize(): void {
        this.disposables.push(
            this.connection.onNotification('log', (message: string) => {
                traceLog('Log:', message);
            }),
        );
        this.pythonServer.once('exit', (code) => {
            if (!this.disposed) {
                traceError(`Python server exited with code ${code}`);
                this.markDisposed();
            }
        });
        this.pythonServer.on('error', (err) => {
            traceError(err);
            this.markDisposed();
        });
        this.connection.listen();
    }

    public input(): void {
        // Register input request handler
        this.disposables.push(
            this.connection.onRequest('input', async (request) => {
                const input = await showInputBox(
                    {
                        title: 'Input Request',
                        prompt: request?.prompt || 'Enter your input here: ',
                        ignoreFocusOut: true,
                    },
                    this.inputCancellation.token,
                );
                return { userInput: input };
            }),
        );
    }

    @captureTelemetry(EventName.EXECUTION_CODE, { scope: 'selection' }, false)
    public async execute(code: string): Promise<ExecutionResult | undefined> {
        return this.runWhileBusy(async () => {
            const result = await this.executeCode(code);
            if (result?.status) {
                this._onCodeExecuted.fire();
            }
            return result;
        });
    }

    public executeSilently(code: string): Promise<ExecutionResult | undefined> {
        return this.runWhileBusy(() => this.executeCode(code));
    }

    private async executeCode(code: string): Promise<ExecutionResult | undefined> {
        try {
            const result = await this.connection.sendRequest('execute', code);
            return result as ExecutionResult;
        } catch (err) {
            const error = err as Error;
            traceError(`Error getting response from REPL server:`, error);
        }
        return undefined;
    }

    public interrupt(): void {
        // Passing SIGINT to interrupt only would work for Mac and Linux
        if (this.pythonServer.kill('SIGINT')) {
            traceLog('Python REPL server interrupted');
        }
    }

    public async checkValidCommand(code: string): Promise<boolean> {
        return this.runWhileBusy(async () => {
            const result: ExecutionResult = await this.connection.sendRequest('check_valid_command', code);
            return result.output === 'True';
        });
    }

    public async runWhileBusy<T>(request: () => Promise<T>): Promise<T> {
        this.inFlightRequests += 1;
        try {
            return await request();
        } finally {
            this.inFlightRequests -= 1;
            if (!this.disposed && this.inFlightRequests === 0) {
                this._onDidBecomeIdle.fire();
            }
        }
    }

    public dispose(): void {
        if (this.disposed) {
            return;
        }
        // Python can only handle the exit request after running user code returns.
        const child = this.pythonServer;
        const killTimer = setTimeout(() => child.kill('SIGKILL'), SERVER_EXIT_TIMEOUT_MS);
        killTimer.unref();
        child.once('exit', () => clearTimeout(killTimer));

        try {
            this.connection.sendNotification('exit').catch((error) => traceLog('Python REPL shutdown:', error));
        } catch (error) {
            traceLog('Python REPL shutdown:', error);
        } finally {
            this.markDisposed();
        }
    }

    private markDisposed(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.inputCancellation.cancel();
        dispose([
            ...this.disposables.splice(0),
            this.inputCancellation,
            this.connection,
            this._onCodeExecuted,
            this._onDidBecomeIdle,
        ]);
    }
}

export function createPythonServer(interpreter: string[], cwd?: string): PythonServer {
    const pythonServer = ch.spawn(interpreter[0], [...interpreter.slice(1), SERVER_PATH], {
        cwd, // Launch with correct workspace directory
    });
    pythonServer.stderr.on('data', (data) => {
        traceError(data.toString());
    });
    const reader = new rpc.StreamMessageReader(pythonServer.stdout);
    // There is no partial-message listener, and the reader can retain an incomplete frame after disposal.
    reader.partialMessageTimeout = 0;
    const connection = rpc.createMessageConnection(reader, new rpc.StreamMessageWriter(pythonServer.stdin));
    return new PythonServerImpl(connection, pythonServer);
}
