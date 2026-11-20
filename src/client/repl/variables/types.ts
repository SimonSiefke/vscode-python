// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Variable } from 'vscode';

export interface IVariableDescription extends Variable {
    /** The name of the variable at the root scope */
    root: string;
    /** How to look up the specific property of the root variable */
    propertyChain: (string | number)[];
    /** The number of children for collection types */
    count?: number;
    /** Names of children */
    hasNamedChildren?: boolean;
}
