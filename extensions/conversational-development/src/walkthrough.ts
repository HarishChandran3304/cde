/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CodeQaWalkthroughStep } from './codeQaProtocol';

export interface WalkthroughRevealResult {
	readonly ok: boolean;
	readonly file?: string;
	readonly start_line?: number;
	readonly end_line?: number;
	readonly symbol?: string;
	readonly error?: string;
}

export class WalkthroughController {
	private walkthroughColumn: vscode.ViewColumn | undefined;

	constructor(private readonly highlight: vscode.TextEditorDecorationType) { }

	async reveal(step: CodeQaWalkthroughStep): Promise<WalkthroughRevealResult> {
		try {
			const uri = await this.resolveWorkspaceFile(step.path);
			const document = await vscode.workspace.openTextDocument(uri);
			const range = this.resolveRange(document, step);
			this.clearHighlights();

			const editor = await vscode.window.showTextDocument(document, {
				preview: true,
				preserveFocus: false,
				selection: range,
				viewColumn: this.walkthroughColumn ?? vscode.ViewColumn.Beside,
			});
			this.walkthroughColumn = editor.viewColumn;
			editor.selection = new vscode.Selection(range.start, range.end);
			editor.setDecorations(this.highlight, [range]);
			editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

			return {
				ok: true,
				file: vscode.workspace.asRelativePath(uri),
				start_line: range.start.line + 1,
				end_line: range.end.line + 1,
				...(step.symbol ? { symbol: step.symbol } : {}),
			};
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	reset(): void {
		this.walkthroughColumn = undefined;
		this.clearHighlights();
	}

	private async resolveWorkspaceFile(relativePath: string): Promise<vscode.Uri> {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			throw new Error('Open a workspace folder before starting a walkthrough.');
		}

		for (const folder of folders) {
			const paths = [relativePath];
			const folderPrefix = `${folder.name}/`;
			if (relativePath.startsWith(folderPrefix)) {
				paths.push(relativePath.slice(folderPrefix.length));
			}

			for (const candidatePath of paths) {
				const uri = vscode.Uri.joinPath(folder.uri, ...candidatePath.split('/'));
				try {
					const stat = await vscode.workspace.fs.stat(uri);
					if ((stat.type & vscode.FileType.File) !== 0) {
						return uri;
					}
				} catch {
					// Try the next workspace root or multi-root path representation.
				}
			}
		}

		throw new Error(`The walkthrough file ${relativePath} does not exist in this workspace.`);
	}

	private resolveRange(document: vscode.TextDocument, step: CodeQaWalkthroughStep): vscode.Range {
		let startLine = step.start_line - 1;
		const requestedLineSpan = Math.max(0, step.end_line - step.start_line);
		if (startLine >= document.lineCount) {
			startLine = this.findSymbolLine(document, step.symbol);
		}
		if (startLine < 0 || startLine >= document.lineCount) {
			throw new Error(`Line ${step.start_line} is outside ${step.path}.`);
		}

		const endLine = Math.min(document.lineCount - 1, startLine + requestedLineSpan);
		return new vscode.Range(
			startLine,
			0,
			endLine,
			document.lineAt(endLine).text.length,
		);
	}

	private findSymbolLine(document: vscode.TextDocument, symbol: string | undefined): number {
		if (!symbol) {
			return -1;
		}
		const offset = document.getText().indexOf(symbol);
		return offset >= 0 ? document.positionAt(offset).line : -1;
	}

	private clearHighlights(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			editor.setDecorations(this.highlight, []);
		}
	}
}
