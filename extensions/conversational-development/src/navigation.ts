/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { rankFileCandidates, rankSymbolCandidates, symbolSearchQueries } from './navigationRanking';

const DOCUMENT_SYMBOL_RETRY_DELAY_MS = 250;
const FILE_SEARCH_EXCLUDE = '**/{.git,node_modules,out,dist,build,.build,.vscode-test}/**';
const MAX_WORKSPACE_FILES = 20_000;

interface SymbolNode {
	readonly name: string;
	readonly range?: vscode.Range;
	readonly selectionRange?: vscode.Range;
	readonly location?: vscode.Location;
	readonly children?: readonly SymbolNode[];
}

interface ResolvedNavigationTarget {
	readonly uri: vscode.Uri;
	readonly document: vscode.TextDocument;
	readonly selectionRange: vscode.Range;
	readonly highlightRange: vscode.Range;
	readonly symbolName?: string;
}

interface WorkspaceFileCandidate {
	readonly path: string;
	readonly uri: vscode.Uri;
}

interface WorkspaceSymbolCandidate {
	readonly name: string;
	readonly path: string;
	readonly symbol: vscode.SymbolInformation;
}

export interface NavigationToolResult {
	readonly ok: boolean;
	readonly file?: string;
	readonly line?: number;
	readonly symbol?: string;
	readonly reference_count?: number;
	readonly spoken_response: string;
	readonly error?: string;
}

export class NavigationController {
	private lastFile: vscode.Uri | undefined;
	private lastSymbol: ResolvedNavigationTarget | undefined;

	constructor(private readonly highlight: vscode.TextEditorDecorationType) { }

	async openFile(query: string): Promise<NavigationToolResult> {
		try {
			const candidate = await this.resolveFile(query);
			const document = await vscode.workspace.openTextDocument(candidate.uri);
			await this.revealFile(document);
			this.lastFile = candidate.uri;
			return {
				ok: true,
				file: candidate.path,
				line: 1,
				spoken_response: `Opened ${candidate.path}.`,
			};
		} catch (error) {
			return this.failure(`I could not find a file matching ${query}.`, error);
		}
	}

	async openSymbol(query: string, fileQuery?: string): Promise<NavigationToolResult> {
		try {
			const target = await this.resolveSymbol(query, fileQuery);
			await this.revealTarget(target);
			this.rememberSymbol(target);
			return {
				ok: true,
				file: vscode.workspace.asRelativePath(target.uri),
				line: target.selectionRange.start.line + 1,
				symbol: target.symbolName,
				spoken_response: `Opened ${target.symbolName ?? query}.`,
			};
		} catch (error) {
			return this.failure(`I could not find the symbol ${query}.`, error);
		}
	}

	async showReferences(symbolQuery?: string, fileQuery?: string): Promise<NavigationToolResult> {
		try {
			const origin = await this.resolveOrigin(symbolQuery, fileQuery);
			const references = await vscode.commands.executeCommand<vscode.Location[] | undefined>(
				'vscode.executeReferenceProvider',
				origin.uri,
				origin.selectionRange.start,
			) ?? [];

			if (references.length === 0) {
				throw new Error(`No references found for ${origin.symbolName ?? 'the selected symbol'}.`);
			}

			await this.revealTarget(origin);
			await vscode.commands.executeCommand(
				'editor.action.peekLocations',
				origin.uri,
				origin.selectionRange.start,
				references,
				'peek',
			);
			if (origin.symbolName) {
				this.rememberSymbol(origin);
			}

			return {
				ok: true,
				file: vscode.workspace.asRelativePath(origin.uri),
				line: origin.selectionRange.start.line + 1,
				symbol: origin.symbolName,
				reference_count: references.length,
				spoken_response: `Showing references for ${origin.symbolName ?? 'the selected symbol'}.`,
			};
		} catch (error) {
			return this.failure('I could not show references for that symbol.', error);
		}
	}

	async goToDefinition(symbolQuery?: string, fileQuery?: string): Promise<NavigationToolResult> {
		try {
			const origin = await this.resolveOrigin(symbolQuery, fileQuery);
			const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[] | undefined>(
				'vscode.executeDefinitionProvider',
				origin.uri,
				origin.selectionRange.start,
			) ?? [];
			const destination = this.preferredDefinition(definitions);
			const target = destination ? await this.targetFromDefinition(destination, origin.symbolName) : origin;

			await this.revealTarget(target);
			this.rememberSymbol(target);
			return {
				ok: true,
				file: vscode.workspace.asRelativePath(target.uri),
				line: target.selectionRange.start.line + 1,
				symbol: target.symbolName,
				spoken_response: `Opened the definition of ${target.symbolName ?? 'that symbol'}.`,
			};
		} catch (error) {
			return this.failure('I could not find that definition.', error);
		}
	}

	openPreparedCheckout(): Promise<NavigationToolResult> {
		return this.openSymbol('calculateFinalPrice', 'src/checkout.ts');
	}

	private async resolveFile(query: string): Promise<WorkspaceFileCandidate> {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			throw new Error('Open a workspace folder first.');
		}

		const directPath = query.trim().replace(/^[`'\"]|[`'\"]$/g, '').replace(/^\.\//, '');
		if (directPath && !/\s/.test(directPath)) {
			for (const folder of folders) {
				const uri = vscode.Uri.joinPath(folder.uri, ...directPath.split('/'));
				try {
					const stat = await vscode.workspace.fs.stat(uri);
					if ((stat.type & vscode.FileType.File) !== 0) {
						return { path: vscode.workspace.asRelativePath(uri), uri };
					}
				} catch {
					// Fall through to fuzzy workspace matching.
				}
			}
		}

		const files = await vscode.workspace.findFiles('**/*', FILE_SEARCH_EXCLUDE, MAX_WORKSPACE_FILES);
		const candidates = files.map(uri => ({ path: vscode.workspace.asRelativePath(uri), uri }));
		const match = rankFileCandidates(candidates, query);
		if (!match) {
			throw new Error(`No confident workspace file match for ${query}.`);
		}
		return match;
	}

	private async resolveSymbol(query: string, fileQuery?: string): Promise<ResolvedNavigationTarget> {
		if (!query.trim()) {
			throw new Error('A symbol name is required.');
		}

		if (fileQuery) {
			const file = await this.resolveFile(fileQuery);
			const document = await vscode.workspace.openTextDocument(file.uri);
			const target = await this.findDocumentSymbol(document, query);
			if (target) {
				return target;
			}
			const textTarget = this.findTextSymbol(document, query);
			if (textTarget) {
				return textTarget;
			}
			throw new Error(`Could not find ${query} in ${file.path}.`);
		}

		const candidates = new Map<string, WorkspaceSymbolCandidate>();
		for (const providerQuery of symbolSearchQueries(query)) {
			let symbols: readonly vscode.SymbolInformation[] = [];
			try {
				symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>(
					'vscode.executeWorkspaceSymbolProvider',
					providerQuery,
				) ?? [];
			} catch {
				// Try the remaining normalized query variants while providers warm up.
			}
			for (const symbol of symbols) {
				const key = `${symbol.location.uri.toString()}:${symbol.location.range.start.line}:${symbol.location.range.start.character}:${symbol.name}`;
				candidates.set(key, {
					name: symbol.name,
					path: vscode.workspace.asRelativePath(symbol.location.uri),
					symbol,
				});
			}
		}

		const contextualFile = vscode.window.activeTextEditor?.document.uri ?? this.lastFile;
		const contextualFileQuery = contextualFile ? vscode.workspace.asRelativePath(contextualFile) : undefined;
		const match = rankSymbolCandidates([...candidates.values()], query, contextualFileQuery);
		if (!match) {
			throw new Error(`No confident workspace symbol match for ${query}.`);
		}

		const document = await vscode.workspace.openTextDocument(match.symbol.location.uri);
		const documentTarget = await this.findDocumentSymbol(document, query);
		if (documentTarget) {
			return documentTarget;
		}
		return this.targetFromLocation(document, match.symbol.location.range, match.symbol.name);
	}

	private async resolveOrigin(symbolQuery?: string, fileQuery?: string): Promise<ResolvedNavigationTarget> {
		if (symbolQuery?.trim()) {
			return this.resolveSymbol(symbolQuery, fileQuery);
		}

		const editor = vscode.window.activeTextEditor;
		if (editor && !editor.selection.isEmpty) {
			const selectedText = editor.document.getText(editor.selection).trim();
			return this.targetFromLocation(editor.document, editor.selection, selectedText || undefined);
		}
		if (this.lastSymbol) {
			return this.lastSymbol;
		}
		if (editor) {
			const position = editor.selection.active;
			const range = editor.document.getWordRangeAtPosition(position) ?? new vscode.Range(position, position);
			const selectedText = editor.document.getText(range).trim();
			return this.targetFromLocation(editor.document, range, selectedText || undefined);
		}
		throw new Error('Open or select a symbol first.');
	}

	private async findDocumentSymbol(document: vscode.TextDocument, query: string): Promise<ResolvedNavigationTarget | undefined> {
		const symbols = await this.documentSymbolsWithRetry(document.uri);
		const candidates = this.flattenSymbols(symbols).map(symbol => ({
			name: symbol.name,
			path: vscode.workspace.asRelativePath(document.uri),
			symbol,
		}));
		const match = rankSymbolCandidates(candidates, query);
		if (!match) {
			return undefined;
		}

		const range = match.symbol.range ?? match.symbol.location?.range;
		const selectionRange = match.symbol.selectionRange ?? match.symbol.location?.range;
		if (!range || !selectionRange) {
			return undefined;
		}
		return {
			uri: document.uri,
			document,
			selectionRange,
			highlightRange: range,
			symbolName: match.symbol.name.replace(/\(\)$/, ''),
		};
	}

	private async documentSymbolsWithRetry(uri: vscode.Uri): Promise<readonly SymbolNode[]> {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const symbols = await vscode.commands.executeCommand<SymbolNode[] | undefined>(
					'vscode.executeDocumentSymbolProvider',
					uri,
				) ?? [];
				if (symbols.length > 0 || attempt > 0) {
					return symbols;
				}
			} catch {
				if (attempt > 0) {
					return [];
				}
			}
			await delay(DOCUMENT_SYMBOL_RETRY_DELAY_MS);
		}
		return [];
	}

	private flattenSymbols(symbols: readonly SymbolNode[]): SymbolNode[] {
		const flattened: SymbolNode[] = [];
		for (const symbol of symbols) {
			flattened.push(symbol, ...this.flattenSymbols(symbol.children ?? []));
		}
		return flattened;
	}

	private findTextSymbol(document: vscode.TextDocument, query: string): ResolvedNavigationTarget | undefined {
		const documentText = document.getText();
		for (const candidate of symbolSearchQueries(query)) {
			const offset = documentText.indexOf(candidate);
			if (offset < 0) {
				continue;
			}
			const start = document.positionAt(offset);
			const end = document.positionAt(offset + candidate.length);
			return {
				uri: document.uri,
				document,
				selectionRange: new vscode.Range(start, end),
				highlightRange: document.lineAt(start.line).range,
				symbolName: candidate,
			};
		}
		return undefined;
	}

	private targetFromLocation(document: vscode.TextDocument, range: vscode.Range, symbolName?: string): ResolvedNavigationTarget {
		return {
			uri: document.uri,
			document,
			selectionRange: range,
			highlightRange: document.lineAt(range.start.line).range,
			symbolName,
		};
	}

	private preferredDefinition(definitions: readonly (vscode.Location | vscode.LocationLink)[]): vscode.Location | vscode.LocationLink | undefined {
		return definitions.find(definition => vscode.workspace.getWorkspaceFolder(definitionUri(definition))) ?? definitions[0];
	}

	private async targetFromDefinition(definition: vscode.Location | vscode.LocationLink, symbolName?: string): Promise<ResolvedNavigationTarget> {
		if (isLocationLink(definition)) {
			const document = await vscode.workspace.openTextDocument(definition.targetUri);
			return {
				uri: definition.targetUri,
				document,
				selectionRange: definition.targetSelectionRange ?? definition.targetRange,
				highlightRange: definition.targetRange,
				symbolName,
			};
		}
		const document = await vscode.workspace.openTextDocument(definition.uri);
		return this.targetFromLocation(document, definition.range, symbolName);
	}

	private async revealFile(document: vscode.TextDocument): Promise<void> {
		this.clearHighlights();
		await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
	}

	private async revealTarget(target: ResolvedNavigationTarget): Promise<void> {
		this.clearHighlights();
		const editor = await vscode.window.showTextDocument(target.document, {
			preview: false,
			preserveFocus: false,
			selection: target.selectionRange,
		});
		editor.selection = new vscode.Selection(target.selectionRange.start, target.selectionRange.end);
		editor.setDecorations(this.highlight, [target.highlightRange]);
		editor.revealRange(target.highlightRange, vscode.TextEditorRevealType.InCenter);
	}

	private clearHighlights(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			editor.setDecorations(this.highlight, []);
		}
	}

	private rememberSymbol(target: ResolvedNavigationTarget): void {
		this.lastFile = target.uri;
		this.lastSymbol = target;
	}

	private failure(spokenResponse: string, error: unknown): NavigationToolResult {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(vscode.l10n.t('CDE navigation failed: {0}', message));
		return { ok: false, spoken_response: spokenResponse, error: message };
	}
}

function isLocationLink(definition: vscode.Location | vscode.LocationLink): definition is vscode.LocationLink {
	return 'targetUri' in definition;
}

function definitionUri(definition: vscode.Location | vscode.LocationLink): vscode.Uri {
	return isLocationLink(definition) ? definition.targetUri : definition.uri;
}

function delay(durationMs: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, durationMs));
}
