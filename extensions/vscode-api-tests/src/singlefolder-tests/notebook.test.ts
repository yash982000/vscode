/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { createRandomFile, asPromise, disposeAll, closeAllEditors, revertAllDirty, saveAllEditors, assertNoRpc } from '../utils';
import { TextDecoder } from 'util';

async function createRandomNotebookFile() {
	return createRandomFile('', undefined, '.vsctestnb');
}

async function openRandomNotebookDocument() {
	const uri = await createRandomNotebookFile();
	return vscode.notebook.openNotebookDocument(uri);
}

async function saveAllFilesAndCloseAll() {
	await saveAllEditors();
	await closeAllEditors();
}

async function withEvent<T>(event: vscode.Event<T>, callback: (e: Promise<T>) => Promise<void>) {
	const e = asPromise<T>(event);
	await callback(e);
}


class Kernel {

	readonly controller: vscode.NotebookController;

	readonly associatedNotebooks = new Set<string>();

	constructor(id: string, label: string) {
		this.controller = vscode.notebook.createNotebookController(id, 'notebookCoreTest', label);
		this.controller.executeHandler = this._execute.bind(this);
		this.controller.hasExecutionOrder = true;
		this.controller.supportedLanguages = ['typescript', 'javascript'];
		this.controller.onDidChangeNotebookAssociation(e => {
			if (e.selected) {
				this.associatedNotebooks.add(e.notebook.uri.toString());
			} else {
				this.associatedNotebooks.delete(e.notebook.uri.toString());
			}
		});
	}

	protected async _execute(cells: vscode.NotebookCell[]): Promise<void> {
		for (let cell of cells) {
			await this._runCell(cell);
		}
	}

	protected async _runCell(cell: vscode.NotebookCell) {
		const task = this.controller.createNotebookCellExecution(cell);
		task.start();
		task.executionOrder = 1;
		if (cell.notebook.uri.path.endsWith('customRenderer.vsctestnb')) {
			await task.replaceOutput([new vscode.NotebookCellOutput([
				vscode.NotebookCellOutputItem.text('test', 'text/custom', undefined)
			])]);
			return;
		}

		await task.replaceOutput([new vscode.NotebookCellOutput([
			vscode.NotebookCellOutputItem.text('my output', 'text/plain', undefined)
		])]);
		task.end({ success: true });
	}
}


function getFocusedCell(editor?: vscode.NotebookEditor) {
	return editor ? editor.document.cellAt(editor.selections[0].start) : undefined;
}

async function assertKernel(kernel: Kernel, notebook: vscode.NotebookDocument): Promise<void> {
	const success = await vscode.commands.executeCommand('notebook.selectKernel', {
		extension: 'vscode.vscode-api-tests',
		id: kernel.controller.id
	});
	assert.ok(success, `expected selected kernel to be ${kernel.controller.id}`);
	assert.ok(kernel.associatedNotebooks.has(notebook.uri.toString()));
}

suite('Notebook API tests', function () {

	const testDisposables: vscode.Disposable[] = [];
	const suiteDisposables: vscode.Disposable[] = [];

	suiteTeardown(async function () {

		assertNoRpc();

		await revertAllDirty();
		await closeAllEditors();

		disposeAll(suiteDisposables);
		suiteDisposables.length = 0;
	});

	suiteSetup(function () {
		suiteDisposables.push(vscode.notebook.registerNotebookContentProvider('notebookCoreTest', {
			openNotebook: async (resource: vscode.Uri): Promise<vscode.NotebookData> => {
				if (/.*empty\-.*\.vsctestnb$/.test(resource.path)) {
					return {
						metadata: new vscode.NotebookDocumentMetadata(),
						cells: []
					};
				}

				const dto: vscode.NotebookData = {
					metadata: new vscode.NotebookDocumentMetadata().with({ custom: { testMetadata: false } }),
					cells: [
						{
							value: 'test',
							languageId: 'typescript',
							kind: vscode.NotebookCellKind.Code,
							outputs: [],
							metadata: new vscode.NotebookCellMetadata().with({ custom: { testCellMetadata: 123 } }),
							executionSummary: { startTime: 10, endTime: 20 }
						},
						{
							value: 'test2',
							languageId: 'typescript',
							kind: vscode.NotebookCellKind.Code,
							outputs: [
								new vscode.NotebookCellOutput([
									vscode.NotebookCellOutputItem.text('Hello World', 'text/plain', { testOutputItemMetadata: true })
								],
									{ testOutputMetadata: true })
							],
							executionSummary: { executionOrder: 5, success: true },
							metadata: new vscode.NotebookCellMetadata().with({ custom: { testCellMetadata: 456 } })
						}
					]
				};
				return dto;
			},
			saveNotebook: async (_document: vscode.NotebookDocument, _cancellation: vscode.CancellationToken) => {
				return;
			},
			saveNotebookAs: async (_targetResource: vscode.Uri, _document: vscode.NotebookDocument, _cancellation: vscode.CancellationToken) => {
				return;
			},
			backupNotebook: async (_document: vscode.NotebookDocument, _context: vscode.NotebookDocumentBackupContext, _cancellation: vscode.CancellationToken) => {
				return {
					id: '1',
					delete: () => { }
				};
			}
		}));
	});

	let kernel1: Kernel;
	let kernel2: Kernel;

	setup(async function () {

		kernel1 = new Kernel('mainKernel', 'Notebook Primary Test Kernel');

		const listener = vscode.notebook.onDidOpenNotebookDocument(async notebook => {
			if (notebook.viewType === kernel1.controller.viewType) {
				await vscode.commands.executeCommand('notebook.selectKernel', {
					extension: 'vscode.vscode-api-tests',
					id: kernel1.controller.id
				});
			}
		});


		kernel2 = new class extends Kernel {
			constructor() {
				super('secondaryKernel', 'Notebook Secondary Test Kernel');
				this.controller.hasExecutionOrder = false;
			}

			override async _runCell(cell: vscode.NotebookCell) {
				const task = this.controller.createNotebookCellExecution(cell);
				task.start();
				await task.replaceOutput([new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.text('my second output', 'text/plain', undefined)
				])]);
				task.end({ success: true });
			}
		};

		testDisposables.push(kernel1.controller, listener, kernel2.controller);
		await saveAllFilesAndCloseAll();
	});

	teardown(async function () {
		disposeAll(testDisposables);
		testDisposables.length = 0;
		await saveAllFilesAndCloseAll();
	});

	test('shared document in notebook editors', async function () {
		let counter = 0;
		testDisposables.push(vscode.notebook.onDidOpenNotebookDocument(() => {
			counter++;
		}));

		const notebook = await openRandomNotebookDocument();
		assert.strictEqual(counter, 1);

		await vscode.window.showNotebookDocument(notebook, { viewColumn: vscode.ViewColumn.Active });
		assert.strictEqual(counter, 1);
		assert.strictEqual(vscode.window.visibleNotebookEditors.length, 1);

		await vscode.window.showNotebookDocument(notebook, { viewColumn: vscode.ViewColumn.Beside });
		assert.strictEqual(counter, 1);
		assert.strictEqual(vscode.window.visibleNotebookEditors.length, 2);
	});

	test('editor onDidChangeVisibleNotebookEditors-event', async function () {
		const resource = await createRandomNotebookFile();
		const firstEditorOpen = asPromise(vscode.window.onDidChangeVisibleNotebookEditors);
		await vscode.window.showNotebookDocument(resource);
		await firstEditorOpen;

		const firstEditorClose = asPromise(vscode.window.onDidChangeVisibleNotebookEditors);
		await closeAllEditors();
		await firstEditorClose;
	});

	test('editor onDidChangeVisibleNotebookEditors-event 2', async function () {
		const resource = await createRandomNotebookFile();
		let count = 0;
		const disposables: vscode.Disposable[] = [];
		disposables.push(vscode.window.onDidChangeVisibleNotebookEditors(() => {
			count = vscode.window.visibleNotebookEditors.length;
		}));

		await vscode.window.showNotebookDocument(resource, { viewColumn: vscode.ViewColumn.Active });
		assert.strictEqual(count, 1);

		await vscode.window.showNotebookDocument(resource, { viewColumn: vscode.ViewColumn.Beside });
		assert.strictEqual(count, 2);

		await closeAllEditors();
		assert.strictEqual(count, 0);
	});

	test('correct cell selection on undo/redo of cell creation', async function () {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		await vscode.commands.executeCommand('notebook.cell.insertCodeCellBelow');
		await vscode.commands.executeCommand('undo');
		const selectionUndo = [...vscode.window.activeNotebookEditor!.selections];
		await vscode.commands.executeCommand('redo');
		const selectionRedo = vscode.window.activeNotebookEditor!.selections;

		// On undo, the selected cell must be the upper cell, ie the first one
		assert.strictEqual(selectionUndo.length, 1);
		assert.strictEqual(selectionUndo[0].start, 0);
		assert.strictEqual(selectionUndo[0].end, 1);
		// On redo, the selected cell must be the new cell, ie the second one
		assert.strictEqual(selectionRedo.length, 1);
		assert.strictEqual(selectionRedo[0].start, 1);
		assert.strictEqual(selectionRedo[0].end, 2);
	});

	test('editor editing event 2', async function () {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');

		const cellsChangeEvent = asPromise<vscode.NotebookCellsChangeEvent>(vscode.notebook.onDidChangeNotebookCells);
		await vscode.commands.executeCommand('notebook.cell.insertCodeCellBelow');
		const cellChangeEventRet = await cellsChangeEvent;
		assert.strictEqual(cellChangeEventRet.document, vscode.window.activeNotebookEditor?.document);
		assert.strictEqual(cellChangeEventRet.changes.length, 1);
		assert.deepStrictEqual(cellChangeEventRet.changes[0], {
			start: 1,
			deletedCount: 0,
			deletedItems: [],
			items: [
				vscode.window.activeNotebookEditor!.document.cellAt(1)
			]
		});

		const moveCellEvent = asPromise<vscode.NotebookCellsChangeEvent>(vscode.notebook.onDidChangeNotebookCells);
		await vscode.commands.executeCommand('notebook.cell.moveUp');
		await moveCellEvent;

		const cellOutputChange = asPromise<vscode.NotebookCellOutputsChangeEvent>(vscode.notebook.onDidChangeCellOutputs);
		await vscode.commands.executeCommand('notebook.cell.execute');
		const cellOutputsAddedRet = await cellOutputChange;
		assert.deepStrictEqual(cellOutputsAddedRet, {
			document: vscode.window.activeNotebookEditor!.document,
			cells: [vscode.window.activeNotebookEditor!.document.cellAt(0)]
		});
		assert.strictEqual(cellOutputsAddedRet.cells[0].outputs.length, 1);

		const cellOutputClear = asPromise<vscode.NotebookCellOutputsChangeEvent>(vscode.notebook.onDidChangeCellOutputs);
		await vscode.commands.executeCommand('notebook.cell.clearOutputs');
		const cellOutputsCleardRet = await cellOutputClear;
		assert.deepStrictEqual(cellOutputsCleardRet, {
			document: vscode.window.activeNotebookEditor!.document,
			cells: [vscode.window.activeNotebookEditor!.document.cellAt(0)]
		});
		assert.strictEqual(cellOutputsAddedRet.cells[0].outputs.length, 0);

		// const cellChangeLanguage = getEventOncePromise<vscode.NotebookCellLanguageChangeEvent>(vscode.notebook.onDidChangeCellLanguage);
		// await vscode.commands.executeCommand('notebook.cell.changeToMarkdown');
		// const cellChangeLanguageRet = await cellChangeLanguage;
		// assert.deepStrictEqual(cellChangeLanguageRet, {
		// 	document: vscode.window.activeNotebookEditor!.document,
		// 	cells: vscode.window.activeNotebookEditor!.document.cellAt(0),
		// 	language: 'markdown'
		// });
	});

	test('editor move cell event', async function () {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		await vscode.commands.executeCommand('notebook.cell.insertCodeCellBelow');
		await vscode.commands.executeCommand('notebook.cell.insertCodeCellAbove');
		await vscode.commands.executeCommand('notebook.focusTop');

		const activeCell = getFocusedCell(vscode.window.activeNotebookEditor);
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.getCells().indexOf(activeCell!), 0);
		const moveChange = asPromise(vscode.notebook.onDidChangeNotebookCells);
		await vscode.commands.executeCommand('notebook.cell.moveDown');
		await moveChange;
		await saveAllEditors();
		await closeAllEditors();

		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		const firstEditor = vscode.window.activeNotebookEditor;
		assert.strictEqual(firstEditor?.document.cellCount, 2);
	});

	test('notebook editor active/visible', async function () {
		const resource = await createRandomNotebookFile();
		const firstEditor = await vscode.window.showNotebookDocument(resource, { viewColumn: vscode.ViewColumn.Active });
		assert.strictEqual(firstEditor === vscode.window.activeNotebookEditor, true);
		assert.strictEqual(vscode.window.visibleNotebookEditors.includes(firstEditor), true);

		const secondEditor = await vscode.window.showNotebookDocument(resource, { viewColumn: vscode.ViewColumn.Beside });
		assert.strictEqual(secondEditor === vscode.window.activeNotebookEditor, true);

		assert.notStrictEqual(firstEditor, secondEditor);
		assert.strictEqual(vscode.window.visibleNotebookEditors.includes(secondEditor), true);
		assert.strictEqual(vscode.window.visibleNotebookEditors.includes(firstEditor), true);
		assert.strictEqual(vscode.window.visibleNotebookEditors.length, 2);

		const untitledEditorChange = asPromise(vscode.window.onDidChangeActiveNotebookEditor);
		await vscode.commands.executeCommand('workbench.action.files.newUntitledFile');
		await untitledEditorChange;
		assert.strictEqual(firstEditor && vscode.window.visibleNotebookEditors.indexOf(firstEditor) >= 0, true);
		assert.notStrictEqual(firstEditor, vscode.window.activeNotebookEditor);
		assert.strictEqual(secondEditor && vscode.window.visibleNotebookEditors.indexOf(secondEditor) < 0, true);
		assert.notStrictEqual(secondEditor, vscode.window.activeNotebookEditor);
		assert.strictEqual(vscode.window.visibleNotebookEditors.length, 1);

		const activeEditorClose = asPromise(vscode.window.onDidChangeActiveNotebookEditor);
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		await activeEditorClose;
		assert.strictEqual(secondEditor, vscode.window.activeNotebookEditor);
		assert.strictEqual(vscode.window.visibleNotebookEditors.length, 2);
		assert.strictEqual(secondEditor && vscode.window.visibleNotebookEditors.indexOf(secondEditor) >= 0, true);
	});

	test('notebook active editor change', async function () {
		const resource = await createRandomNotebookFile();
		const firstEditorOpen = asPromise(vscode.window.onDidChangeActiveNotebookEditor);
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		await firstEditorOpen;

		const firstEditorDeactivate = asPromise(vscode.window.onDidChangeActiveNotebookEditor);
		await vscode.commands.executeCommand('workbench.action.splitEditor');
		await firstEditorDeactivate;
	});

	test('edit API (replaceMetadata)', async function () {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');

		await vscode.window.activeNotebookEditor!.edit(editBuilder => {
			editBuilder.replaceCellMetadata(0, new vscode.NotebookCellMetadata().with({ inputCollapsed: true }));
		});

		const document = vscode.window.activeNotebookEditor?.document!;
		assert.strictEqual(document.cellCount, 2);
		assert.strictEqual(document.cellAt(0).metadata.inputCollapsed, true);

		assert.strictEqual(document.isDirty, true);
	});

	test('edit API (replaceMetadata, event)', async function () {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');

		const event = asPromise<vscode.NotebookCellMetadataChangeEvent>(vscode.notebook.onDidChangeCellMetadata);

		await vscode.window.activeNotebookEditor!.edit(editBuilder => {
			editBuilder.replaceCellMetadata(0, new vscode.NotebookCellMetadata().with({ inputCollapsed: true }));
		});

		const data = await event;
		assert.strictEqual(data.document, vscode.window.activeNotebookEditor?.document);
		assert.strictEqual(data.cell.metadata.inputCollapsed, true);

		assert.strictEqual(data.document.isDirty, true);
	});

	test('edit API batch edits', async function () {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');

		const cellsChangeEvent = asPromise<vscode.NotebookCellsChangeEvent>(vscode.notebook.onDidChangeNotebookCells);
		const cellMetadataChangeEvent = asPromise<vscode.NotebookCellMetadataChangeEvent>(vscode.notebook.onDidChangeCellMetadata);
		const version = vscode.window.activeNotebookEditor!.document.version;
		await vscode.window.activeNotebookEditor!.edit(editBuilder => {
			editBuilder.replaceCells(1, 0, [{ kind: vscode.NotebookCellKind.Code, languageId: 'javascript', value: 'test 2', outputs: [], metadata: undefined }]);
			editBuilder.replaceCellMetadata(0, new vscode.NotebookCellMetadata().with({ inputCollapsed: false }));
		});

		await cellsChangeEvent;
		await cellMetadataChangeEvent;
		assert.strictEqual(version + 1, vscode.window.activeNotebookEditor!.document.version);
	});

	test('edit API batch edits undo/redo', async function () {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');

		const cellsChangeEvent = asPromise<vscode.NotebookCellsChangeEvent>(vscode.notebook.onDidChangeNotebookCells);
		const cellMetadataChangeEvent = asPromise<vscode.NotebookCellMetadataChangeEvent>(vscode.notebook.onDidChangeCellMetadata);
		const version = vscode.window.activeNotebookEditor!.document.version;
		await vscode.window.activeNotebookEditor!.edit(editBuilder => {
			editBuilder.replaceCells(1, 0, [{ kind: vscode.NotebookCellKind.Code, languageId: 'javascript', value: 'test 2', outputs: [], metadata: undefined }]);
			editBuilder.replaceCellMetadata(0, new vscode.NotebookCellMetadata().with({ inputCollapsed: false }));
		});

		await cellsChangeEvent;
		await cellMetadataChangeEvent;
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.cellCount, 3);
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.cellAt(0)?.metadata.inputCollapsed, false);
		assert.strictEqual(version + 1, vscode.window.activeNotebookEditor!.document.version);

		await vscode.commands.executeCommand('undo');
		assert.strictEqual(version + 2, vscode.window.activeNotebookEditor!.document.version);
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.cellAt(0)?.metadata.inputCollapsed, undefined);
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.cellCount, 2);
	});

	test('initialzation should not emit cell change events.', async function () {
		const resource = await createRandomNotebookFile();
		let count = 0;

		testDisposables.push(vscode.notebook.onDidChangeNotebookCells(() => {
			count++;
		}));

		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		assert.strictEqual(count, 0);
	});
	// });

	// suite('notebook workflow', () => {

	test('notebook open', async function () {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		assert.strictEqual(vscode.window.activeNotebookEditor !== undefined, true, 'notebook first');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.getText(), 'test');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.languageId, 'typescript');

		const secondCell = vscode.window.activeNotebookEditor!.document.cellAt(1);
		assert.strictEqual(secondCell!.outputs.length, 1);
		assert.deepStrictEqual(secondCell!.outputs[0].metadata, { testOutputMetadata: true });
		assert.strictEqual((<any>secondCell!.outputs[0]).outputs.length, 1); //todo@jrieken will FAIL once the backwards compatibility is gone
		assert.strictEqual(secondCell!.outputs[0].items.length, 1);
		assert.strictEqual(secondCell!.outputs[0].items[0].mime, 'text/plain');
		assert.strictEqual(new TextDecoder().decode(secondCell!.outputs[0].items[0].data), 'Hello World');
		assert.deepStrictEqual(secondCell!.outputs[0].items[0].metadata, { testOutputItemMetadata: true });
		assert.strictEqual(secondCell!.executionSummary?.executionOrder, 5);
		assert.strictEqual(secondCell!.executionSummary?.success, true);

		await vscode.commands.executeCommand('notebook.cell.insertCodeCellBelow');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.getText(), '');

		await vscode.commands.executeCommand('notebook.cell.insertCodeCellAbove');
		const activeCell = getFocusedCell(vscode.window.activeNotebookEditor);
		assert.notStrictEqual(getFocusedCell(vscode.window.activeNotebookEditor), undefined);
		assert.strictEqual(activeCell!.document.getText(), '');
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.cellCount, 4);
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.getCells().indexOf(activeCell!), 1);

		await vscode.commands.executeCommand('workbench.action.files.save');
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	});

	test('notebook cell actions', async function () {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		assert.strictEqual(vscode.window.activeNotebookEditor !== undefined, true, 'notebook first');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.getText(), 'test');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.languageId, 'typescript');

		// ---- insert cell below and focus ---- //
		await vscode.commands.executeCommand('notebook.cell.insertCodeCellBelow');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.getText(), '');

		// ---- insert cell above and focus ---- //
		await vscode.commands.executeCommand('notebook.cell.insertCodeCellAbove');
		let activeCell = getFocusedCell(vscode.window.activeNotebookEditor);
		assert.notStrictEqual(getFocusedCell(vscode.window.activeNotebookEditor), undefined);
		assert.strictEqual(activeCell!.document.getText(), '');
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.cellCount, 4);
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.getCells().indexOf(activeCell!), 1);

		// ---- focus bottom ---- //
		await vscode.commands.executeCommand('notebook.focusBottom');
		activeCell = getFocusedCell(vscode.window.activeNotebookEditor);
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.getCells().indexOf(activeCell!), 3);

		// ---- focus top and then copy down ---- //
		await vscode.commands.executeCommand('notebook.focusTop');
		activeCell = getFocusedCell(vscode.window.activeNotebookEditor);
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.getCells().indexOf(activeCell!), 0);

		await vscode.commands.executeCommand('notebook.cell.copyDown');
		activeCell = getFocusedCell(vscode.window.activeNotebookEditor);
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.getCells().indexOf(activeCell!), 1);
		assert.strictEqual(activeCell?.document.getText(), 'test');

		await vscode.commands.executeCommand('notebook.cell.delete');
		activeCell = getFocusedCell(vscode.window.activeNotebookEditor);
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.getCells().indexOf(activeCell!), 1);
		assert.strictEqual(activeCell?.document.getText(), '');

		// ---- focus top and then copy up ---- //
		await vscode.commands.executeCommand('notebook.focusTop');
		await vscode.commands.executeCommand('notebook.cell.copyUp');
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.cellCount, 5);
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.cellAt(0).document.getText(), 'test');
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.cellAt(1).document.getText(), 'test');
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.cellAt(2).document.getText(), '');
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.cellAt(3).document.getText(), '');
		activeCell = getFocusedCell(vscode.window.activeNotebookEditor);
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.getCells().indexOf(activeCell!), 0);


		// ---- move up and down ---- //

		await vscode.commands.executeCommand('notebook.cell.moveDown');
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.getCells().indexOf(getFocusedCell(vscode.window.activeNotebookEditor)!), 1,
			`first move down, active cell ${getFocusedCell(vscode.window.activeNotebookEditor)!.document.uri.toString()}, ${getFocusedCell(vscode.window.activeNotebookEditor)!.document.getText()}`);

		// await vscode.commands.executeCommand('notebook.cell.moveDown');
		// activeCell = getFocusedCell(vscode.window.activeNotebookEditor);

		// assert.strictEqual(vscode.window.activeNotebookEditor!.document.getCells().indexOf(activeCell!), 2,
		// 	`second move down, active cell ${getFocusedCell(vscode.window.activeNotebookEditor)!.uri.toString()}, ${getFocusedCell(vscode.window.activeNotebookEditor)!.document.getText()}`);
		// assert.strictEqual(vscode.window.activeNotebookEditor!.document.cellAt(0).document.getText(), 'test');
		// assert.strictEqual(vscode.window.activeNotebookEditor!.document.cellAt(1).document.getText(), '');
		// assert.strictEqual(vscode.window.activeNotebookEditor!.document.cellAt(2).document.getText(), 'test');
		// assert.strictEqual(vscode.window.activeNotebookEditor!.document.cellAt(3).document.getText(), '');

		// ---- ---- //

		await vscode.commands.executeCommand('workbench.action.files.save');
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	});

	test('notebook join cells', async function () {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		assert.strictEqual(vscode.window.activeNotebookEditor !== undefined, true, 'notebook first');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.getText(), 'test');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.languageId, 'typescript');

		await vscode.commands.executeCommand('notebook.cell.insertCodeCellBelow');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.getText(), '');
		const edit = new vscode.WorkspaceEdit();
		edit.insert(getFocusedCell(vscode.window.activeNotebookEditor)!.document.uri, new vscode.Position(0, 0), 'var abc = 0;');
		await vscode.workspace.applyEdit(edit);

		const cellsChangeEvent = asPromise<vscode.NotebookCellsChangeEvent>(vscode.notebook.onDidChangeNotebookCells);
		await vscode.commands.executeCommand('notebook.cell.joinAbove');
		await cellsChangeEvent;

		assert.deepStrictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.getText().split(/\r\n|\r|\n/), ['test', 'var abc = 0;']);

		await vscode.commands.executeCommand('workbench.action.files.save');
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	});

	test('move cells will not recreate cells in ExtHost', async function () {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		await vscode.commands.executeCommand('notebook.cell.insertCodeCellBelow');
		await vscode.commands.executeCommand('notebook.cell.insertCodeCellAbove');
		await vscode.commands.executeCommand('notebook.focusTop');

		const activeCell = getFocusedCell(vscode.window.activeNotebookEditor);
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.getCells().indexOf(activeCell!), 0);
		await vscode.commands.executeCommand('notebook.cell.moveDown');
		await vscode.commands.executeCommand('notebook.cell.moveDown');

		const newActiveCell = getFocusedCell(vscode.window.activeNotebookEditor);
		assert.deepStrictEqual(activeCell, newActiveCell);
	});

	// test('document runnable based on kernel count', async () => {
	// 	const resource = await createRandomNotebookFile();
	// 	await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
	// 	assert.strictEqual(vscode.window.activeNotebookEditor !== undefined, true, 'notebook first');
	// 	const editor = vscode.window.activeNotebookEditor!;

	// 	const cell = editor.document.cellAt(0);
	// 	assert.strictEqual(cell.outputs.length, 0);

	// 	currentKernelProvider.setHasKernels(false);
	// 	await vscode.commands.executeCommand('notebook.execute');
	// 	assert.strictEqual(cell.outputs.length, 0, 'should not execute'); // not runnable, didn't work

	// 	currentKernelProvider.setHasKernels(true);

	// 	await withEvent<vscode.NotebookCellOutputsChangeEvent>(vscode.notebook.onDidChangeCellOutputs, async (event) => {
	// 		await vscode.commands.executeCommand('notebook.execute');
	// 		await event;
	// 		assert.strictEqual(cell.outputs.length, 1, 'should execute'); // runnable, it worked
	// 	});

	// 	await saveAllFilesAndCloseAll(undefined);
	// });


	// TODO@rebornix this is wrong, `await vscode.commands.executeCommand('notebook.execute');` doesn't wait until the workspace edit is applied
	test.skip('cell execute command takes arguments', async () => {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		assert.strictEqual(vscode.window.activeNotebookEditor !== undefined, true, 'notebook first');
		const editor = vscode.window.activeNotebookEditor!;
		const cell = editor.document.cellAt(0);

		await vscode.commands.executeCommand('notebook.execute');
		assert.strictEqual(cell.outputs.length, 0, 'should not execute'); // not runnable, didn't work
	});

	test('cell execute command takes arguments 2', async () => {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		assert.strictEqual(vscode.window.activeNotebookEditor !== undefined, true, 'notebook first');
		const editor = vscode.window.activeNotebookEditor!;
		const cell = editor.document.cellAt(0);

		await withEvent(vscode.notebook.onDidChangeCellOutputs, async (event) => {
			await vscode.commands.executeCommand('notebook.execute');
			await event;
			assert.strictEqual(cell.outputs.length, 1, 'should execute'); // runnable, it worked
		});

		await withEvent(vscode.notebook.onDidChangeCellOutputs, async event => {
			await vscode.commands.executeCommand('notebook.cell.clearOutputs');
			await event;
			assert.strictEqual(cell.outputs.length, 0, 'should clear');
		});

		const secondResource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', secondResource, 'notebookCoreTest');

		await withEvent<vscode.NotebookCellOutputsChangeEvent>(vscode.notebook.onDidChangeCellOutputs, async (event) => {
			await vscode.commands.executeCommand('notebook.cell.execute', { start: 0, end: 1 }, resource);
			await event;
			assert.strictEqual(cell.outputs.length, 1, 'should execute'); // runnable, it worked
			assert.strictEqual(vscode.window.activeNotebookEditor?.document.uri.fsPath, secondResource.fsPath);
		});
	});

	test('cell execute command takes arguments ICellRange[]', async () => {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');

		vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: 0, end: 1 }, { start: 1, end: 2 }] });
		let firstCellExecuted = false;
		let secondCellExecuted = false;
		let resolve: () => void;
		const p = new Promise<void>(r => resolve = r);
		const listener = vscode.notebook.onDidChangeCellOutputs(e => {
			e.cells.forEach(cell => {
				if (cell.index === 0) {
					firstCellExecuted = true;
				}

				if (cell.index === 1) {
					secondCellExecuted = true;
				}
			});

			if (firstCellExecuted && secondCellExecuted) {
				resolve();
			}
		});

		await p;
		listener.dispose();
		await saveAllFilesAndCloseAll();
	});

	test('document execute command takes arguments', async () => {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		assert.strictEqual(vscode.window.activeNotebookEditor !== undefined, true, 'notebook first');
		const editor = vscode.window.activeNotebookEditor!;
		const cell = editor.document.cellAt(0);

		await withEvent<vscode.NotebookCellOutputsChangeEvent>(vscode.notebook.onDidChangeCellOutputs, async (event) => {
			await vscode.commands.executeCommand('notebook.execute');
			await event;
			assert.strictEqual(cell.outputs.length, 1, 'should execute'); // runnable, it worked
		});

		const clearChangeEvent = asPromise<vscode.NotebookCellOutputsChangeEvent>(vscode.notebook.onDidChangeCellOutputs);
		await vscode.commands.executeCommand('notebook.cell.clearOutputs');
		await clearChangeEvent;
		assert.strictEqual(cell.outputs.length, 0, 'should clear');

		const secondResource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', secondResource, 'notebookCoreTest');

		await withEvent<vscode.NotebookCellOutputsChangeEvent>(vscode.notebook.onDidChangeCellOutputs, async (event) => {
			await vscode.commands.executeCommand('notebook.execute', resource);
			await event;
			assert.strictEqual(cell.outputs.length, 1, 'should execute'); // runnable, it worked
			assert.strictEqual(vscode.window.activeNotebookEditor?.document.uri.fsPath, secondResource.fsPath);
		});
	});

	test('cell execute and select kernel', async function () {
		const notebook = await openRandomNotebookDocument();
		const editor = await vscode.window.showNotebookDocument(notebook);
		assert.strictEqual(vscode.window.activeNotebookEditor === editor, true, 'notebook first');

		const cell = editor.document.cellAt(0);

		await withEvent<vscode.NotebookCellOutputsChangeEvent>(vscode.notebook.onDidChangeCellOutputs, async (event) => {
			await assertKernel(kernel1, notebook);
			await vscode.commands.executeCommand('notebook.cell.execute');
			await event;
			assert.strictEqual(cell.outputs.length, 1, 'should execute'); // runnable, it worked
			assert.strictEqual(cell.outputs[0].items.length, 1);
			assert.strictEqual(cell.outputs[0].items[0].mime, 'text/plain');
			assert.deepStrictEqual(new TextDecoder().decode(cell.outputs[0].items[0].data), 'my output');
		});

		await withEvent<vscode.NotebookCellOutputsChangeEvent>(vscode.notebook.onDidChangeCellOutputs, async (event) => {
			await assertKernel(kernel2, notebook);
			await vscode.commands.executeCommand('notebook.cell.execute');
			await event;
			assert.strictEqual(cell.outputs.length, 1, 'should execute'); // runnable, it worked
			assert.strictEqual(cell.outputs[0].items.length, 1);
			assert.strictEqual(cell.outputs[0].items[0].mime, 'text/plain');
			assert.deepStrictEqual(new TextDecoder().decode(cell.outputs[0].items[0].data), 'my second output');
		});
	});

	test('set outputs on cancel', async () => {

		const cancelableKernel = new class extends Kernel {

			constructor() {
				super('cancelableKernel', 'Notebook Cancelable Test Kernel');
			}

			override async _execute(cells: vscode.NotebookCell[]) {
				for (const cell of cells) {
					const task = this.controller.createNotebookCellExecution(cell);
					task.start();
					task.token.onCancellationRequested(async () => {
						await task.replaceOutput([new vscode.NotebookCellOutput([
							vscode.NotebookCellOutputItem.text('Canceled', 'text/plain', undefined)
						])]);
						task.end({});
					});

				}
			}
		};

		const notebook = await openRandomNotebookDocument();
		const editor = await vscode.window.showNotebookDocument(notebook);
		const cell = editor.document.cellAt(0);

		await withEvent<vscode.NotebookCellOutputsChangeEvent>(vscode.notebook.onDidChangeCellOutputs, async (event) => {
			await assertKernel(cancelableKernel, notebook);
			assert.ok(editor === vscode.window.activeNotebookEditor);
			await vscode.commands.executeCommand('notebook.cell.execute');
			await vscode.commands.executeCommand('notebook.cell.cancelExecution');
			await event;
			assert.strictEqual(cell.outputs.length, 1, 'should execute'); // runnable, it worked
			assert.strictEqual(cell.outputs[0].items.length, 1);
			assert.strictEqual(cell.outputs[0].items[0].mime, 'text/plain');
			assert.deepStrictEqual(new TextDecoder().decode(cell.outputs[0].items[0].data), 'Canceled');
		});

		cancelableKernel.controller.dispose();
	});

	test('set outputs on interrupt', async () => {
		const interruptableKernel = new class extends Kernel {

			constructor() {
				super('interruptableKernel', 'Notebook Interruptable Test Kernel');
				this.controller.interruptHandler = this.interrupt.bind(this);
			}

			private _task: vscode.NotebookCellExecution | undefined;

			override async _execute(cells: vscode.NotebookCell[]) {
				this._task = this.controller.createNotebookCellExecution(cells[0]);
				this._task.start();
			}

			async interrupt() {
				await this._task!.replaceOutput([new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.text('Interrupted', 'text/plain', undefined)
				])]);
				this._task!.end({});
			}
		};

		const notebook = await openRandomNotebookDocument();
		const editor = await vscode.window.showNotebookDocument(notebook);
		const cell = editor.document.cellAt(0);

		await withEvent<vscode.NotebookCellOutputsChangeEvent>(vscode.notebook.onDidChangeCellOutputs, async (event) => {
			await assertKernel(interruptableKernel, notebook);
			assert.ok(editor === vscode.window.activeNotebookEditor);
			await vscode.commands.executeCommand('notebook.cell.execute');
			await vscode.commands.executeCommand('notebook.cell.cancelExecution');
			await event;
			assert.strictEqual(cell.outputs.length, 1, 'should execute'); // runnable, it worked
			assert.strictEqual(cell.outputs[0].items.length, 1);
			assert.strictEqual(cell.outputs[0].items[0].mime, 'text/plain');
			assert.deepStrictEqual(new TextDecoder().decode(cell.outputs[0].items[0].data), 'Interrupted');
		});

		interruptableKernel.controller.dispose();
	});

	test('onDidChangeCellExecutionState is fired', async () => {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		const editor = vscode.window.activeNotebookEditor!;
		const cell = editor.document.cellAt(0);

		vscode.commands.executeCommand('notebook.cell.execute');
		let eventCount = 0;
		let resolve: () => void;
		const p = new Promise<void>(r => resolve = r);
		const listener = vscode.notebook.onDidChangeNotebookCellExecutionState(e => {
			if (eventCount === 0) {
				assert.strictEqual(e.executionState, vscode.NotebookCellExecutionState.Pending, 'should be set to Pending');
			} else if (eventCount === 1) {
				assert.strictEqual(e.executionState, vscode.NotebookCellExecutionState.Executing, 'should be set to Executing');
				assert.strictEqual(cell.outputs.length, 0, 'no outputs yet: ' + JSON.stringify(cell.outputs[0]));
			} else if (eventCount === 2) {
				assert.strictEqual(e.executionState, vscode.NotebookCellExecutionState.Idle, 'should be set to Idle');
				assert.strictEqual(cell.outputs.length, 1, 'should have an output');
				resolve();
			}

			eventCount++;
		});

		await p;
		listener.dispose();
	});

	// suite('notebook dirty state', () => {
	test('notebook open', async function () {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		assert.strictEqual(vscode.window.activeNotebookEditor !== undefined, true, 'notebook first');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.getText(), 'test');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.languageId, 'typescript');

		await vscode.commands.executeCommand('notebook.cell.insertCodeCellBelow');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.getText(), '');

		await vscode.commands.executeCommand('notebook.cell.insertCodeCellAbove');
		const activeCell = getFocusedCell(vscode.window.activeNotebookEditor);
		assert.notStrictEqual(getFocusedCell(vscode.window.activeNotebookEditor), undefined);
		assert.strictEqual(activeCell!.document.getText(), '');
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.cellCount, 4);
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.getCells().indexOf(activeCell!), 1);

		await withEvent(vscode.workspace.onDidChangeTextDocument, async event => {
			const edit = new vscode.WorkspaceEdit();
			edit.insert(activeCell!.document.uri, new vscode.Position(0, 0), 'var abc = 0;');
			await vscode.workspace.applyEdit(edit);
			await event;
			assert.strictEqual(vscode.window.activeNotebookEditor !== undefined, true);
			assert.deepStrictEqual(vscode.window.activeNotebookEditor?.document.cellAt(1), getFocusedCell(vscode.window.activeNotebookEditor));
			assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.getText(), 'var abc = 0;');
		});
	});
	// });

	// suite('notebook undo redo', () => {
	test('notebook open', async function () {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		assert.strictEqual(vscode.window.activeNotebookEditor !== undefined, true, 'notebook first');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.getText(), 'test');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.languageId, 'typescript');

		await vscode.commands.executeCommand('notebook.cell.insertCodeCellBelow');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.getText(), '');

		await vscode.commands.executeCommand('notebook.cell.insertCodeCellAbove');
		const activeCell = getFocusedCell(vscode.window.activeNotebookEditor);
		assert.notStrictEqual(getFocusedCell(vscode.window.activeNotebookEditor), undefined);
		assert.strictEqual(activeCell!.document.getText(), '');
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.cellCount, 4);
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.getCells().indexOf(activeCell!), 1);


		// modify the second cell, delete it
		const edit = new vscode.WorkspaceEdit();
		edit.insert(getFocusedCell(vscode.window.activeNotebookEditor)!.document.uri, new vscode.Position(0, 0), 'var abc = 0;');
		await vscode.workspace.applyEdit(edit);
		await vscode.commands.executeCommand('notebook.cell.delete');
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.cellCount, 3);
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.getCells().indexOf(getFocusedCell(vscode.window.activeNotebookEditor)!), 1);


		// undo should bring back the deleted cell, and revert to previous content and selection
		await vscode.commands.executeCommand('undo');
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.cellCount, 4);
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.getCells().indexOf(getFocusedCell(vscode.window.activeNotebookEditor)!), 1);
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.getText(), 'var abc = 0;');

		// redo
		// await vscode.commands.executeCommand('notebook.redo');
		// assert.strictEqual(vscode.window.activeNotebookEditor!.document.cellCount, 2);
		// assert.strictEqual(vscode.window.activeNotebookEditor!.document.getCells().indexOf(getFocusedCell(vscode.window.activeNotebookEditor)!), 1);
		// assert.strictEqual(vscode.window.activeNotebookEditor?.selection?.document.getText(), 'test');
	});

	test('multiple tabs: dirty + clean', async function () {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		await vscode.commands.executeCommand('notebook.cell.insertCodeCellBelow');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.getText(), '');

		await vscode.commands.executeCommand('notebook.cell.insertCodeCellAbove');
		const edit = new vscode.WorkspaceEdit();
		edit.insert(getFocusedCell(vscode.window.activeNotebookEditor)!.document.uri, new vscode.Position(0, 0), 'var abc = 0;');
		await vscode.workspace.applyEdit(edit);

		const secondResource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', secondResource, 'notebookCoreTest');
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

		// make sure that the previous dirty editor is still restored in the extension host and no data loss
		assert.strictEqual(vscode.window.activeNotebookEditor !== undefined, true);
		assert.deepStrictEqual(vscode.window.activeNotebookEditor?.document.cellAt(1), getFocusedCell(vscode.window.activeNotebookEditor));
		assert.deepStrictEqual(vscode.window.activeNotebookEditor?.document.cellCount, 4);
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.getText(), 'var abc = 0;');

	});

	test('multiple tabs: two dirty tabs and switching', async function () {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		await vscode.commands.executeCommand('notebook.cell.insertCodeCellBelow');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.getText(), '');

		await vscode.commands.executeCommand('notebook.cell.insertCodeCellAbove');
		const edit = new vscode.WorkspaceEdit();
		edit.insert(getFocusedCell(vscode.window.activeNotebookEditor)!.document.uri, new vscode.Position(0, 0), 'var abc = 0;');
		await vscode.workspace.applyEdit(edit);

		const secondResource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', secondResource, 'notebookCoreTest');
		await vscode.commands.executeCommand('notebook.cell.insertCodeCellBelow');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.getText(), '');

		// switch to the first editor
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		assert.strictEqual(vscode.window.activeNotebookEditor !== undefined, true);
		assert.deepStrictEqual(vscode.window.activeNotebookEditor?.document.cellAt(1), getFocusedCell(vscode.window.activeNotebookEditor));
		assert.deepStrictEqual(vscode.window.activeNotebookEditor?.document.cellCount, 4);
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.getText(), 'var abc = 0;');

		// switch to the second editor
		await vscode.commands.executeCommand('vscode.openWith', secondResource, 'notebookCoreTest');
		assert.strictEqual(vscode.window.activeNotebookEditor !== undefined, true);
		assert.deepStrictEqual(vscode.window.activeNotebookEditor?.document.cellAt(1), getFocusedCell(vscode.window.activeNotebookEditor));
		assert.deepStrictEqual(vscode.window.activeNotebookEditor?.document.cellCount, 3);
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.getText(), '');

	});

	test('multiple tabs: different editors with same document', async function () {

		const notebook = await openRandomNotebookDocument();
		const firstNotebookEditor = await vscode.window.showNotebookDocument(notebook, { viewColumn: vscode.ViewColumn.One });
		assert.ok(firstNotebookEditor === vscode.window.activeNotebookEditor);

		assert.strictEqual(firstNotebookEditor !== undefined, true, 'notebook first');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor!)?.document.getText(), 'test');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor!)?.document.languageId, 'typescript');

		const secondNotebookEditor = await vscode.window.showNotebookDocument(notebook, { viewColumn: vscode.ViewColumn.Beside });
		assert.strictEqual(secondNotebookEditor !== undefined, true, 'notebook first');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor!)?.document.getText(), 'test');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor!)?.document.languageId, 'typescript');

		assert.notStrictEqual(firstNotebookEditor, secondNotebookEditor);
		assert.strictEqual(firstNotebookEditor?.document, secondNotebookEditor?.document, 'split notebook editors share the same document');

	});

	test('custom metadata should be supported', async function () {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		assert.strictEqual(vscode.window.activeNotebookEditor !== undefined, true, 'notebook first');
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.metadata.custom!['testMetadata'] as boolean, false);
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.metadata.custom!['testCellMetadata'] as number, 123);
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.languageId, 'typescript');

	});


	// TODO@rebornix skip as it crashes the process all the time
	test.skip('custom metadata should be supported 2', async function () {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		assert.strictEqual(vscode.window.activeNotebookEditor !== undefined, true, 'notebook first');
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.metadata.custom!['testMetadata'] as boolean, false);
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.metadata.custom!['testCellMetadata'] as number, 123);
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.languageId, 'typescript');

		// TODO see #101462
		// await vscode.commands.executeCommand('notebook.cell.copyDown');
		// const activeCell = getFocusedCell(vscode.window.activeNotebookEditor);
		// assert.strictEqual(vscode.window.activeNotebookEditor!.document.getCells().indexOf(activeCell!), 1);
		// assert.strictEqual(activeCell?.metadata.custom!['testCellMetadata'] as number, 123);

	});


	test.skip('#106657. Opening a notebook from markers view is broken ', async function () {

		const document = await openRandomNotebookDocument();
		const [cell] = document.getCells();

		assert.strictEqual(vscode.window.activeNotebookEditor, undefined);

		// opening a cell-uri opens a notebook editor
		await vscode.window.showTextDocument(cell.document, { viewColumn: vscode.ViewColumn.Active });
		// await vscode.commands.executeCommand('vscode.open', cell.document.uri, vscode.ViewColumn.Active);

		assert.strictEqual(!!vscode.window.activeNotebookEditor, true);
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.uri.toString(), document.uri.toString());
	});

	test('Cannot open notebook from cell-uri with vscode.open-command', async function () {

		const document = await openRandomNotebookDocument();
		const [cell] = document.getCells();

		await saveAllFilesAndCloseAll();
		assert.strictEqual(vscode.window.activeNotebookEditor, undefined);

		// BUG is that the editor opener (https://github.com/microsoft/vscode/blob/8e7877bdc442f1e83a7fec51920d82b696139129/src/vs/editor/browser/services/openerService.ts#L69)
		// removes the fragment if it matches something numeric. For notebooks that's not wanted...
		await vscode.commands.executeCommand('vscode.open', cell.document.uri);

		assert.strictEqual(vscode.window.activeNotebookEditor!.document.uri.toString(), document.uri.toString());
	});

	test('#97830, #97764. Support switch to other editor types', async function () {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		await vscode.commands.executeCommand('notebook.cell.insertCodeCellBelow');
		const edit = new vscode.WorkspaceEdit();
		edit.insert(getFocusedCell(vscode.window.activeNotebookEditor)!.document.uri, new vscode.Position(0, 0), 'var abc = 0;');
		await vscode.workspace.applyEdit(edit);

		assert.strictEqual(vscode.window.activeNotebookEditor !== undefined, true, 'notebook first');
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.getText(), 'var abc = 0;');

		// no kernel -> no default language
		// assert.strictEqual(vscode.window.activeNotebookEditor!.kernel, undefined);
		assert.strictEqual(getFocusedCell(vscode.window.activeNotebookEditor)?.document.languageId, 'typescript');

		await vscode.commands.executeCommand('vscode.openWith', resource, 'default');
		assert.strictEqual(vscode.window.activeTextEditor?.document.uri.path, resource.path);
	});

	// open text editor, pin, and then open a notebook
	test('#96105 - dirty editors', async function () {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'default');
		const edit = new vscode.WorkspaceEdit();
		edit.insert(resource, new vscode.Position(0, 0), 'var abc = 0;');
		await vscode.workspace.applyEdit(edit);

		// now it's dirty, open the resource with notebook editor should open a new one
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		assert.notStrictEqual(vscode.window.activeNotebookEditor, undefined, 'notebook first');
		// assert.notStrictEqual(vscode.window.activeTextEditor, undefined);

	});

	test('#102411 - untitled notebook creation failed', async function () {
		await vscode.commands.executeCommand('workbench.action.files.newUntitledFile', { viewType: 'notebookCoreTest' });
		assert.notStrictEqual(vscode.window.activeNotebookEditor, undefined, 'untitled notebook editor is not undefined');

		await closeAllEditors();
	});

	test('#102423 - copy/paste shares the same text buffer', async function () {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');

		let activeCell = getFocusedCell(vscode.window.activeNotebookEditor);
		assert.strictEqual(activeCell?.document.getText(), 'test');

		await vscode.commands.executeCommand('notebook.cell.copyDown');
		await vscode.commands.executeCommand('notebook.cell.edit');
		activeCell = getFocusedCell(vscode.window.activeNotebookEditor);
		assert.strictEqual(vscode.window.activeNotebookEditor!.document.getCells().indexOf(activeCell!), 1);
		assert.strictEqual(activeCell?.document.getText(), 'test');

		const edit = new vscode.WorkspaceEdit();
		edit.insert(getFocusedCell(vscode.window.activeNotebookEditor)!.document.uri, new vscode.Position(0, 0), 'var abc = 0;');
		await vscode.workspace.applyEdit(edit);

		assert.strictEqual(vscode.window.activeNotebookEditor!.document.getCells().length, 3);
		assert.notStrictEqual(vscode.window.activeNotebookEditor!.document.cellAt(0).document.getText(), vscode.window.activeNotebookEditor!.document.cellAt(1).document.getText());

		await closeAllEditors();
	});

	test('#115855 onDidSaveNotebookDocument', async function () {
		const resource = await createRandomNotebookFile();
		const notebook = await vscode.notebook.openNotebookDocument(resource);
		const editor = await vscode.window.showNotebookDocument(notebook);

		const cellsChangeEvent = asPromise<vscode.NotebookCellsChangeEvent>(vscode.notebook.onDidChangeNotebookCells);
		await editor.edit(editBuilder => {
			editBuilder.replaceCells(1, 0, [{ kind: vscode.NotebookCellKind.Code, languageId: 'javascript', value: 'test 2', outputs: [], metadata: undefined }]);
		});

		const cellChangeEventRet = await cellsChangeEvent;
		assert.strictEqual(cellChangeEventRet.document === notebook, true);
		assert.strictEqual(cellChangeEventRet.document.isDirty, true);

		const saveEvent = asPromise(vscode.notebook.onDidSaveNotebookDocument);

		await notebook.save();

		await saveEvent;
		assert.strictEqual(notebook.isDirty, false);
	});

	test('Output changes are applied once the promise resolves', async function () {

		let called = false;

		const verifyOutputSyncKernel = new class extends Kernel {

			constructor() {
				super('verifyOutputSyncKernel', '');
			}

			override async _execute(cells: vscode.NotebookCell[]) {
				const [cell] = cells;
				const task = this.controller.createNotebookCellExecution(cell);
				task.start();
				await task.replaceOutput([new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.text('Some output', 'text/plain', undefined)
				])]);
				assert.strictEqual(cell.notebook.cellAt(0).outputs.length, 1);
				assert.deepStrictEqual(new TextDecoder().decode(cell.notebook.cellAt(0).outputs[0].items[0].data), 'Some output');
				task.end({});
				called = true;
			}
		};

		const notebook = await openRandomNotebookDocument();
		await vscode.window.showNotebookDocument(notebook);
		await assertKernel(verifyOutputSyncKernel, notebook);
		await vscode.commands.executeCommand('notebook.cell.execute');
		assert.strictEqual(called, true);
		verifyOutputSyncKernel.controller.dispose();
	});

	test('executionSummary', async () => {
		const resource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
		const editor = vscode.window.activeNotebookEditor!;
		const cell = editor.document.cellAt(0);

		assert.strictEqual(cell.executionSummary?.success, undefined);
		assert.strictEqual(cell.executionSummary?.executionOrder, undefined);
		await vscode.commands.executeCommand('notebook.cell.execute');
		assert.strictEqual(cell.outputs.length, 1, 'should execute');
		assert.ok(cell.executionSummary);
		assert.strictEqual(cell.executionSummary!.success, true);
		assert.strictEqual(typeof cell.executionSummary!.executionOrder, 'number');

	});

	test('initialize executionSummary', async () => {

		const document = await openRandomNotebookDocument();
		const cell = document.cellAt(0);

		assert.strictEqual(cell.executionSummary?.success, undefined);
		assert.strictEqual(cell.executionSummary?.startTime, 10);
		assert.strictEqual(cell.executionSummary?.endTime, 20);

	});


	suite('statusbar', () => {
		const emitter = new vscode.EventEmitter<vscode.NotebookCell>();
		const onDidCallProvide = emitter.event;
		suiteSetup(() => {
			vscode.notebook.registerNotebookCellStatusBarItemProvider('notebookCoreTest', {
				async provideCellStatusBarItems(cell: vscode.NotebookCell, _token: vscode.CancellationToken): Promise<vscode.NotebookCellStatusBarItem[]> {
					emitter.fire(cell);
					return [];
				}
			});
		});

		test('provideCellStatusBarItems called on metadata change', async function () {
			const provideCalled = asPromise(onDidCallProvide);
			const resource = await createRandomNotebookFile();
			await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
			await provideCalled;

			const edit = new vscode.WorkspaceEdit();
			edit.replaceNotebookCellMetadata(resource, 0, new vscode.NotebookCellMetadata().with({ inputCollapsed: true }));
			vscode.workspace.applyEdit(edit);
			await provideCalled;
		});
	});

	// });

	// suite('webview', () => {
	// for web, `asWebUri` gets `https`?
	// test('asWebviewUri', async function () {
	// 	if (vscode.env.uiKind === vscode.UIKind.Web) {
	// 		return;
	// 	}

	// 	const resource = await createRandomNotebookFile();
	// 	await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');
	// 	assert.strictEqual(vscode.window.activeNotebookEditor !== undefined, true, 'notebook first');
	// 	const uri = vscode.window.activeNotebookEditor!.asWebviewUri(vscode.Uri.file('./hello.png'));
	// 	assert.strictEqual(uri.scheme, 'vscode-webview-resource');
	// 	await closeAllEditors();
	// });


	// 404 on web
	// test('custom renderer message', async function () {
	// 	if (vscode.env.uiKind === vscode.UIKind.Web) {
	// 		return;
	// 	}

	// 	const resource = vscode.Uri.file(join(vscode.workspace.rootPath || '', './customRenderer.vsctestnb'));
	// 	await vscode.commands.executeCommand('vscode.openWith', resource, 'notebookCoreTest');

	// 	const editor = vscode.window.activeNotebookEditor;
	// 	const promise = new Promise(resolve => {
	// 		const messageEmitter = editor?.onDidReceiveMessage(e => {
	// 			if (e.type === 'custom_renderer_initialize') {
	// 				resolve();
	// 				messageEmitter?.dispose();
	// 			}
	// 		});
	// 	});

	// 	await vscode.commands.executeCommand('notebook.cell.execute');
	// 	await promise;
	// 	await closeAllEditors();
	// });
});
