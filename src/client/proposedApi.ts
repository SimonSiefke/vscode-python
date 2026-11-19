/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import type { ApiActivation } from './api';
import { IServiceContainer } from './ioc/types';
import { ProposedExtensionAPI } from './proposedApiTypes';
import { IDiscoveryAPI } from './pythonEnvironments/base/locator';
import { buildDeprecatedProposedApi } from './deprecatedProposedApi';
import { DeprecatedProposedAPI } from './deprecatedProposedApiTypes';

export function buildProposedApi(
    discoveryApi: IDiscoveryAPI,
    serviceContainer: IServiceContainer,
    activation?: ApiActivation,
): ProposedExtensionAPI {
    /**
     * @deprecated Will be removed soon.
     */
    let deprecatedProposedApi;
    try {
        deprecatedProposedApi = { ...buildDeprecatedProposedApi(discoveryApi, serviceContainer, activation) };
    } catch (ex) {
        deprecatedProposedApi = {} as DeprecatedProposedAPI;
        // Errors out only in case of testing.
        // Also, these APIs no longer supported, no need to log error.
    }

    const proposed: ProposedExtensionAPI & DeprecatedProposedAPI = {
        ...deprecatedProposedApi,
    };
    return proposed;
}
