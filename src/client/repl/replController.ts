import * as vscode from 'vscode';
import { PythonServer } from './pythonServer';

export function createReplController(server: PythonServer): vscode.NotebookController {
    const controller = vscode.notebooks.createNotebookController('pythonREPL', 'jupyter-notebook', 'Python REPL');
    controller.supportedLanguages = ['python'];

    controller.description = 'Python REPL';

    controller.interruptHandler = async () => {
        server.interrupt();
    };

    controller.executeHandler = (cells) =>
        server.runWhileBusy(async () => {
            for (const cell of cells) {
                if (server.isDisposed) {
                    break;
                }
                const exec = controller.createNotebookCellExecution(cell);
                exec.start(Date.now());

                const code = cell.document.getText();
                const result = await server.execute(code);

                if (result?.output) {
                    const stdoutItem = vscode.NotebookCellOutputItem.stdout(result.output);
                    const output = new vscode.NotebookCellOutput([stdoutItem], {});
                    exec.replaceOutput([output]);
                    // TODO: Properly update via NotebookCellOutputItem.error later.
                }

                exec.end(result?.status);
            }
        });
    return controller;
}
