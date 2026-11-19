// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { assert, expect } from 'chai';
import * as path from 'path';
import * as sinon from 'sinon';
import { anything, instance, mock, when } from 'ts-mockito';
import { ApiActivation, buildApi } from '../client/api';
import { PythonExtension } from '../client/api/types';
import { convertCompleteEnvInfo } from '../client/environmentApi';
import { buildEnvInfo } from '../client/pythonEnvironments/base/info/env';
import { IWorkspaceService } from '../client/common/application/types';
import { ConfigurationService } from '../client/common/configuration/service';
import { EXTENSION_ROOT_DIR, JUPYTER_EXTENSION_ID, TENSORBOARD_EXTENSION_ID } from '../client/common/constants';
import { IConfigurationService, IDisposableRegistry, IExtensions } from '../client/common/types';
import { createDeferred } from '../client/common/utils/async';
import { IEnvironmentVariablesProvider } from '../client/common/variables/types';
import { Architecture } from '../client/common/utils/platform';
import { DeprecatedProposedAPI } from '../client/deprecatedProposedApiTypes';
import { buildProposedApi } from '../client/proposedApi';
import { EnvironmentType } from '../client/pythonEnvironments/info';
import { IInterpreterService } from '../client/interpreter/contracts';
import { IEnvironmentActivationService } from '../client/interpreter/activation/types';
import { InterpreterService } from '../client/interpreter/interpreterService';
import { ServiceContainer } from '../client/ioc/container';
import { ServiceManager } from '../client/ioc/serviceManager';
import { IServiceContainer, IServiceManager } from '../client/ioc/types';
import { IDiscoveryAPI } from '../client/pythonEnvironments/base/locator';
import * as pythonDebugger from '../client/debugger/pythonDebugger';
import {
    JupyterExtensionIntegration,
    JupyterExtensionPythonEnvironments,
    JupyterPythonEnvironmentApi,
} from '../client/jupyter/jupyterIntegration';
import { EventEmitter, Extension, Uri } from 'vscode';
import { TensorboardExtensionIntegration } from '../client/tensorBoard/tensorboardIntegration';
import { TensorboardDependencyChecker } from '../client/tensorBoard/tensorboardDependencyChecker';

suite('Extension API', () => {
    const debuggerPath = path.join(EXTENSION_ROOT_DIR, 'python_files', 'lib', 'python', 'debugpy');
    const debuggerHost = 'somehost';
    const debuggerPort = 12345;

    let serviceContainer: IServiceContainer;
    let serviceManager: IServiceManager;
    let configurationService: IConfigurationService;
    let interpreterService: IInterpreterService;
    let discoverAPI: IDiscoveryAPI;
    let environmentVariablesProvider: IEnvironmentVariablesProvider;
    let getDebugpyPathStub: sinon.SinonStub;

    setup(() => {
        serviceContainer = mock(ServiceContainer);
        serviceManager = mock(ServiceManager);
        configurationService = mock(ConfigurationService);
        interpreterService = mock(InterpreterService);
        environmentVariablesProvider = mock<IEnvironmentVariablesProvider>();
        discoverAPI = mock<IDiscoveryAPI>();
        when(discoverAPI.getEnvs()).thenReturn([]);

        when(serviceContainer.get<IConfigurationService>(IConfigurationService)).thenReturn(
            instance(configurationService),
        );
        when(serviceContainer.get<IEnvironmentVariablesProvider>(IEnvironmentVariablesProvider)).thenReturn(
            instance(environmentVariablesProvider),
        );
        when(serviceContainer.get<JupyterExtensionIntegration>(JupyterExtensionIntegration)).thenReturn(
            instance(mock<JupyterExtensionIntegration>()),
        );
        when(serviceContainer.get<IInterpreterService>(IInterpreterService)).thenReturn(instance(interpreterService));
        const onDidChangePythonEnvironment = new EventEmitter<Uri>();
        const jupyterApi: JupyterPythonEnvironmentApi = {
            onDidChangePythonEnvironment: onDidChangePythonEnvironment.event,
            getPythonEnvironment: (_uri: Uri) => undefined,
        };
        when(serviceContainer.get<JupyterPythonEnvironmentApi>(JupyterExtensionPythonEnvironments)).thenReturn(
            jupyterApi,
        );
        when(serviceContainer.get<IDisposableRegistry>(IDisposableRegistry)).thenReturn([]);
        getDebugpyPathStub = sinon.stub(pythonDebugger, 'getDebugpyPath');
        getDebugpyPathStub.resolves(debuggerPath);
    });

    teardown(() => {
        sinon.restore();
    });

    test('a caller notified before Python uses the new API when the trust transition finishes', async () => {
        const activation = new ApiActivation();
        const previous = {
            environments: instance(mock<PythonExtension['environments']>()),
            serviceContainer: instance(mock(ServiceContainer)),
        };
        const current = {
            environments: instance(mock<PythonExtension['environments']>()),
            serviceContainer: instance(mock(ServiceContainer)),
        };
        activation.current = previous;
        const observed = activation.getCurrent();
        const finishDeactivation = createDeferred();
        const startDeactivation = createDeferred();
        const transition = activation.restart(async () => {
            activation.current = undefined;
            startDeactivation.resolve();
            await finishDeactivation.promise;
            activation.current = current;
        }, Promise.resolve());

        let settled = false;
        void observed.then(() => {
            settled = true;
        });
        try {
            await startDeactivation.promise;
            assert.isFalse(settled);
        } finally {
            finishDeactivation.resolve();
        }
        await transition;
        assert.strictEqual(await observed, current);
        assert.strictEqual(await activation.getCurrent(), current);
    });

    test('trust cannot retire the process owner while initial setup is pending', async () => {
        const activation = new ApiActivation();
        const startup = createDeferred();
        let retired = false;
        const replacement = activation.restart(async () => {
            retired = true;
        }, startup.promise);
        await Promise.resolve();
        assert.isFalse(retired);
        startup.resolve();
        await replacement;
        assert.isTrue(retired);
    });

    test('captured legacy interpreter getters use the current activation', async () => {
        const activation = new ApiActivation();
        const extensions = mock<IExtensions>();
        when(extensions.determineExtensionFromCallStack()).thenResolve({
            extensionId: 'test.legacy-interpreter',
            displayName: 'Legacy Interpreter',
        });
        when(serviceContainer.get(IExtensions)).thenReturn(instance(extensions));
        const { environment } = buildProposedApi(
            instance(discoverAPI),
            instance(serviceContainer),
            activation,
        ) as DeprecatedProposedAPI;

        const currentService = mock(InterpreterService);
        const interpreter = path.resolve('current', 'python');
        when(currentService.getActiveInterpreter(undefined)).thenResolve({
            path: interpreter,
            architecture: Architecture.Unknown,
            sysPrefix: path.dirname(interpreter),
            envType: EnvironmentType.System,
        });
        const currentContainer = mock(ServiceContainer);
        when(currentContainer.get(IInterpreterService)).thenReturn(instance(currentService));
        activation.current = {
            environments: instance(mock<PythonExtension['environments']>()),
            serviceContainer: instance(currentContainer),
        };

        assert.deepEqual(await environment.getExecutionDetails(), { execCommand: [interpreter] });
        assert.strictEqual((await environment.getActiveEnvironmentPath())?.path, interpreter);
    });

    test('the first Jupyter and TensorBoard callbacks use services from the latest activation', async () => {
        type JupyterApi = Parameters<JupyterExtensionIntegration['registerApi']>[0];
        type TensorboardApi = Parameters<TensorboardExtensionIntegration['registerApi']>[0];
        let jupyter: Parameters<JupyterApi['registerPythonApi']>[0] | undefined;
        let tensorboard: Parameters<TensorboardApi['registerPythonApi']>[0] | undefined;
        const jupyterExtension = mock<Extension<JupyterApi>>();
        const tensorboardExtension = mock<Extension<TensorboardApi>>();
        const jupyterApi: JupyterApi = {
            registerPythonApi: (api) => {
                jupyter = jupyter ?? api;
            },
        };
        const tensorboardApi: TensorboardApi = {
            registerPythonApi: (api) => {
                tensorboard = tensorboard ?? api;
            },
        };
        when(jupyterExtension.isActive).thenReturn(true);
        when(jupyterExtension.exports).thenReturn(jupyterApi);
        when(jupyterExtension.activate()).thenReturn(Promise.resolve(jupyterApi));
        when(tensorboardExtension.isActive).thenReturn(true);
        when(tensorboardExtension.exports).thenReturn(tensorboardApi);
        when(tensorboardExtension.activate()).thenReturn(Promise.resolve(tensorboardApi));
        const extensions = mock<IExtensions>();
        when(extensions.getExtension(JUPYTER_EXTENSION_ID)).thenReturn(instance(jupyterExtension));
        when(extensions.getExtension(TENSORBOARD_EXTENSION_ID)).thenReturn(instance(tensorboardExtension));
        const workspace = mock<IWorkspaceService>();
        const grantedTrust = new EventEmitter<void>();
        when(workspace.isTrusted).thenReturn(false);
        when(workspace.onDidGrantWorkspaceTrust).thenReturn(grantedTrust.event);
        const createDependency = <T extends object>() => instance(mock<T>());

        function services(marker: string) {
            const envActivation = mock<IEnvironmentActivationService>();
            when(envActivation.getActivatedEnvironmentVariables(undefined, anything(), true)).thenResolve({ marker });
            const checker = mock(TensorboardDependencyChecker);
            when(checker.ensureDependenciesAreInstalled(undefined)).thenResolve(marker === 'current');
            const jupyterIntegration = new JupyterExtensionIntegration(
                instance(extensions),
                createDependency(),
                instance(envActivation),
                createDependency(),
                createDependency(),
                instance(workspace),
                createDependency(),
                createDependency(),
                instance(interpreterService),
                createDependency(),
            );
            const tensorboardIntegration = new TensorboardExtensionIntegration(
                instance(extensions),
                instance(envActivation),
                instance(workspace),
                instance(checker),
                createDependency(),
            );
            return { jupyterIntegration, tensorboardIntegration };
        }

        const activation = new ApiActivation();
        const previous = services('previous');
        when(serviceContainer.get(JupyterExtensionIntegration)).thenReturn(previous.jupyterIntegration);
        when(serviceContainer.get(TensorboardExtensionIntegration)).thenReturn(previous.tensorboardIntegration);
        const initial = buildApi(
            Promise.resolve(),
            instance(serviceManager),
            instance(serviceContainer),
            instance(discoverAPI),
            activation,
        ) as PythonExtension & {
            jupyter: { registerHooks(): Promise<void> };
            tensorboard: { registerHooks(): Promise<void> };
        };
        activation.current = { environments: initial.environments, serviceContainer: instance(serviceContainer) };
        try {
            await Promise.all([initial.jupyter.registerHooks(), initial.tensorboard.registerHooks()]);
            assert.isUndefined(jupyter);
            assert.isUndefined(tensorboard);
            when(workspace.isTrusted).thenReturn(true);
            grantedTrust.fire();
            assert.isDefined(jupyter);
            assert.isDefined(tensorboard);
        } finally {
            grantedTrust.dispose();
        }

        const current = services('current');
        const newContainer = mock(ServiceContainer);
        when(newContainer.get(JupyterExtensionIntegration)).thenReturn(current.jupyterIntegration);
        when(newContainer.get(TensorboardExtensionIntegration)).thenReturn(current.tensorboardIntegration);
        const environment = convertCompleteEnvInfo(buildEnvInfo({ executable: '/current/python' }));
        const environments: PythonExtension['environments'] = Object.create(initial.environments);
        environments.resolveEnvironment = sinon.stub().withArgs('python3').resolves(environment);
        const prepare = createDeferred();
        const replacement = activation.restart(async () => {
            activation.current = undefined;
            await prepare.promise;
            activation.current = { environments, serviceContainer: instance(newContainer) };
        }, Promise.resolve());

        const resolving = initial.environments.resolveEnvironment('python3');
        const jupyterEnvironment = jupyter!.getActivatedEnvironmentVariables(undefined, environment, true);
        const tensorboardEnvironment = tensorboard!.getActivatedEnvironmentVariables(undefined);
        const dependencies = tensorboard!.ensureDependenciesAreInstalled();
        prepare.resolve();
        await replacement;
        assert.strictEqual(await resolving, environment);
        assert.deepEqual(await jupyterEnvironment, { marker: 'current' });
        assert.deepEqual(await tensorboardEnvironment, { marker: 'current' });
        assert.isTrue(await dependencies);
    });

    test('Test debug launcher args (no-wait)', async () => {
        const waitForAttach = false;

        const args = await buildApi(
            Promise.resolve(),
            instance(serviceManager),
            instance(serviceContainer),
            instance(discoverAPI),
            new ApiActivation(),
        ).debug.getRemoteLauncherCommand(debuggerHost, debuggerPort, waitForAttach);
        const expectedArgs = [
            debuggerPath.fileToCommandArgumentForPythonExt(),
            '--listen',
            `${debuggerHost}:${debuggerPort}`,
        ];

        expect(args).to.be.deep.equal(expectedArgs);
    });

    test('Test debug launcher args (wait)', async () => {
        const waitForAttach = true;

        const args = await buildApi(
            Promise.resolve(),
            instance(serviceManager),
            instance(serviceContainer),
            instance(discoverAPI),
            new ApiActivation(),
        ).debug.getRemoteLauncherCommand(debuggerHost, debuggerPort, waitForAttach);
        const expectedArgs = [
            debuggerPath.fileToCommandArgumentForPythonExt(),
            '--listen',
            `${debuggerHost}:${debuggerPort}`,
            '--wait-for-client',
        ];

        expect(args).to.be.deep.equal(expectedArgs);
    });

    test('Test debugger package path', async () => {
        const pkgPath = await buildApi(
            Promise.resolve(),
            instance(serviceManager),
            instance(serviceContainer),
            instance(discoverAPI),
            new ApiActivation(),
        ).debug.getDebuggerPackagePath();

        assert.strictEqual(pkgPath, debuggerPath);
    });
});
