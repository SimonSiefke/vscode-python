// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
    CancellationToken,
    NotebookDocument,
    Variable,
    NotebookVariablesRequestKind,
    VariablesResult,
    EventEmitter,
    Event,
    NotebookVariableProvider,
    Uri,
} from 'vscode';
import { VariableResultCache } from './variableResultCache';
import { IVariableDescription } from './types';
import { VariableRequester } from './variableRequester';
import { getConfiguration } from '../../common/vscodeApis/workspaceApis';

export class VariablesProvider implements NotebookVariableProvider {
    private readonly providedVariables = new WeakSet<Variable>();

    private readonly variableResultCache = new VariableResultCache();

    private _onDidChangeVariables = new EventEmitter<NotebookDocument>();

    onDidChangeVariables = this._onDidChangeVariables.event;

    private executionCount = 0;

    constructor(
        private readonly variableRequester: VariableRequester,
        private readonly getNotebookDocument: () => NotebookDocument | undefined,
        codeExecutedEvent: Event<void>,
    ) {
        codeExecutedEvent(() => this.onDidExecuteCode());
    }

    onDidExecuteCode(): void {
        const notebook = this.getNotebookDocument();
        if (notebook) {
            this.executionCount += 1;
            if (isEnabled(notebook.uri)) {
                this._onDidChangeVariables.fire(notebook);
            }
        }
    }

    async *provideVariables(
        notebook: NotebookDocument,
        parent: Variable | undefined,
        kind: NotebookVariablesRequestKind,
        start: number,
        token: CancellationToken,
    ): AsyncIterable<VariablesResult> {
        const notebookDocument = this.getNotebookDocument();
        if (
            !isEnabled(notebook.uri) ||
            token.isCancellationRequested ||
            !notebookDocument ||
            notebookDocument !== notebook ||
            (parent && !this.providedVariables.has(parent))
        ) {
            return;
        }

        const { executionCount } = this;
        const cacheKey = getVariableResultCacheKey(notebook.uri.toString(), parent, start);
        let results = this.variableResultCache.getResults(executionCount, cacheKey);

        const parentDescription = parent as IVariableDescription | undefined;
        if (!results) {
            const variables = await this.variableRequester.getAllVariableDescriptions(parentDescription, start, token);
            if (token.isCancellationRequested) {
                return;
            }
            results = variables.map((variable) => this.createVariableResult(variable));
            this.variableResultCache.setResults(executionCount, cacheKey, results);
        }

        for (const result of results) {
            yield result;
        }

        if (
            kind === 2 &&
            parentDescription?.count &&
            results.length > 0 &&
            parentDescription.count > start + results.length
        ) {
            yield* this.provideVariables(notebook, parent, kind, start + results.length, token);
        }
    }

    private createVariableResult(result: IVariableDescription): VariablesResult {
        const indexedChildrenCount = result.count ?? 0;
        const hasNamedChildren = !!result.hasNamedChildren;
        // VS Code caches the result across controller disposal, so it must carry data only.
        const variable = { ...result, expression: createExpression(result.root, result.propertyChain) };
        this.providedVariables.add(variable);
        return { variable, hasNamedChildren, indexedChildrenCount };
    }
}

function createExpression(root: string, propertyChain: (string | number)[]): string {
    let expression = root;
    for (const property of propertyChain) {
        if (typeof property === 'string') {
            expression += `.${property}`;
        } else {
            expression += `[${property}]`;
        }
    }
    return expression;
}

function getVariableResultCacheKey(uri: string, parent: Variable | undefined, start: number) {
    let parentKey = '';
    const parentDescription = parent as IVariableDescription;
    if (parentDescription) {
        parentKey = `${parentDescription.name}.${parentDescription.propertyChain.join('.')}[[${start}`;
    }
    return `${uri}:${parentKey}`;
}

function isEnabled(resource?: Uri) {
    return getConfiguration('python', resource).get('REPL.provideVariables');
}
