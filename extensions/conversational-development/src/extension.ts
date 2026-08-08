/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const VIEW_ID = 'cde.conversation';
const SDP_EXCHANGE_TIMEOUT_MS = 15_000;
const DOCUMENT_SYMBOL_RETRY_DELAY_MS = 250;

interface CodeTarget {
	readonly file: string;
	readonly symbol: string;
	readonly fallbackAnchor: string;
	readonly spokenName: string;
}

const CODE_TARGETS = {
	checkout_final_price: {
		file: 'src/checkout.ts',
		symbol: 'calculateFinalPrice',
		fallbackAnchor: 'export function calculateFinalPrice',
		spokenName: 'calculateFinalPrice',
	},
} as const satisfies Record<string, CodeTarget>;

type CodeTargetId = keyof typeof CODE_TARGETS;
const CODE_TARGET_IDS = Object.keys(CODE_TARGETS) as CodeTargetId[];
type CodeToolName = 'open_code_target' | 'show_code_references';

interface SymbolNode {
	readonly name: string;
	readonly range?: vscode.Range;
	readonly selectionRange?: vscode.Range;
	readonly location?: vscode.Location;
	readonly children?: readonly SymbolNode[];
}

interface ResolvedCodeTarget {
	readonly uri: vscode.Uri;
	readonly document: vscode.TextDocument;
	readonly selectionRange: vscode.Range;
	readonly highlightRange: vscode.Range;
}

interface ToolResult {
	readonly ok: boolean;
	readonly target?: CodeTargetId;
	readonly file?: string;
	readonly line?: number;
	readonly reference_count?: number;
	readonly spoken_response: string;
	readonly error?: string;
}

type WebviewMessage =
	| { readonly type: 'exchangeSdp'; readonly requestId: string; readonly sdp: string }
	| { readonly type: 'executeTool'; readonly requestId: string; readonly sessionEpoch: number; readonly callId: string; readonly name: string; readonly arguments: string }
	| { readonly type: 'openCheckoutDirectly'; readonly requestId: string };

const realtimeSession = {
	type: 'realtime',
	model: 'gpt-realtime-2.1',
	instructions: `You are CDE, a terse voice interface inside a code editor.

This is a focused code-navigation experiment. You have exactly two useful tools.
- When the user asks to open, navigate to, find, or show the checkout price calculation, call open_code_target with checkout_final_price immediately.
- When the user asks for references, usages, or callers of calculateFinalPrice, call show_code_references with checkout_final_price immediately.
- Treat natural paraphrases such as "open the checkout service", "where is checkout calculated", and "show every caller" as the matching tool request.
- Never claim an editor action happened before its tool succeeds.
- Do not speak before calling the tool.
- When the tool returns, say its spoken_response exactly and add nothing.
- For unrelated requests, briefly say this experiment only navigates the prepared checkout code.`,
	audio: {
		input: {
			transcription: { model: 'gpt-4o-mini-transcribe' },
			turn_detection: {
				type: 'semantic_vad',
				eagerness: 'high',
				create_response: true,
				interrupt_response: true,
			},
		},
		output: {
			voice: 'marin',
			speed: 1.1,
		},
	},
	tools: [
		{
			type: 'function',
			name: 'open_code_target',
			description: 'Open and highlight calculateFinalPrice in the prepared checkout file.',
			parameters: {
				type: 'object',
				properties: {
					target: {
						type: 'string',
						enum: CODE_TARGET_IDS,
					},
				},
				required: ['target'],
				additionalProperties: false,
			},
		},
		{
			type: 'function',
			name: 'show_code_references',
			description: 'Find and show the native References peek for calculateFinalPrice, including its callers.',
			parameters: {
				type: 'object',
				properties: {
					target: {
						type: 'string',
						enum: CODE_TARGET_IDS,
					},
				},
				required: ['target'],
				additionalProperties: false,
			},
		},
	],
	tool_choice: 'auto',
	max_output_tokens: 120,
} as const;

class ConversationViewProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly output: vscode.OutputChannel,
		private readonly highlight: vscode.TextEditorDecorationType,
	) { }

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
		};
		view.webview.html = this.getHtml(view.webview);
		view.webview.onDidReceiveMessage(message => this.handleMessage(message as WebviewMessage));
		this.trace('view.ready');
	}

	private async handleMessage(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case 'exchangeSdp':
				await this.exchangeSdp(message.requestId, message.sdp);
				return;
			case 'executeTool':
				await this.executeTool(message);
				return;
			case 'openCheckoutDirectly': {
				const result = await openCheckoutLogic(this.highlight);
				this.trace(`direct.result ${JSON.stringify(result)}`);
				await this.post({ type: 'directResult', requestId: message.requestId, result });
				return;
			}
		}
	}

	private async exchangeSdp(requestId: string, sdp: string): Promise<void> {
		try {
			this.trace('realtime.sdp.request');
			const apiKey = getOpenAiApiKey();
			if (!apiKey) {
				throw new Error(vscode.l10n.t('Set cde.openaiApiKey or OPENAI_API_KEY before connecting.'));
			}

			const form = new FormData();
			form.set('sdp', sdp);
			form.set('session', JSON.stringify(realtimeSession));
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), SDP_EXCHANGE_TIMEOUT_MS);
			let response: Response;
			try {
				response = await fetch('https://api.openai.com/v1/realtime/calls', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${apiKey}`,
						'OpenAI-Safety-Identifier': 'cde-local-spike',
					},
					body: form,
					signal: controller.signal,
				});
			} catch (error) {
				if (controller.signal.aborted) {
					throw new Error('OpenAI Realtime session setup timed out.');
				}
				throw error;
			} finally {
				clearTimeout(timeout);
			}

			const answer = await response.text();
			if (!response.ok) {
				throw new Error(`OpenAI Realtime returned ${response.status}: ${answer}`);
			}

			this.trace('realtime.sdp.answer');
			await this.post({ type: 'sdpAnswer', requestId, sdp: answer });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.trace(`realtime.error ${message}`);
			await this.post({ type: 'requestError', requestId, message });
		}
	}

	private async executeTool(message: Extract<WebviewMessage, { type: 'executeTool' }>): Promise<void> {
		this.trace(`tool.call ${message.name} ${message.arguments}`);
		let result: ToolResult;
		const targetId = isCodeToolName(message.name) ? parseCodeTargetArguments(message.arguments) : undefined;
		if (message.name === 'open_code_target' && targetId) {
			result = await openCodeTarget(targetId, this.highlight);
		} else if (message.name === 'show_code_references' && targetId) {
			result = await showCodeReferences(targetId, this.highlight);
		} else if (isCodeToolName(message.name)) {
			result = {
				ok: false,
				spoken_response: 'I could not find that code target.',
				error: `Invalid arguments for ${message.name}.`,
			};
		} else {
			result = {
				ok: false,
				spoken_response: 'That tool is not available in this experiment.',
				error: `Unknown tool: ${message.name}`,
			};
		}

		this.trace(`tool.result ${JSON.stringify(result)}`);
		await this.post({
			type: 'toolResult',
			requestId: message.requestId,
			sessionEpoch: message.sessionEpoch,
			callId: message.callId,
			result,
		});
	}

	private async post(message: object): Promise<void> {
		await this.view?.webview.postMessage(message);
	}

	private trace(message: string): void {
		this.output.appendLine(`${new Date().toISOString()} ${message}`);
	}

	private getHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'styles.css'));
		return `<!doctype html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}; media-src blob:;">
	<link rel="stylesheet" href="${styleUri}">
	<title>CDE Conversation</title>
</head>
<body>
	<main>
		<header>
			<div id="orb" class="orb idle" aria-hidden="true"></div>
			<div>
				<h1>CDE</h1>
				<p id="state">Disconnected</p>
			</div>
		</header>
		<button id="connect" class="primary">Connect</button>
		<section class="transcript" aria-live="polite">
			<span class="label">You</span>
			<p id="userText">Say “open the checkout logic.”</p>
			<span class="label">CDE</span>
			<p id="assistantText">Waiting to connect.</p>
		</section>
		<form id="textForm">
			<input id="textInput" type="text" placeholder="Text fallback" autocomplete="off">
			<button type="submit" title="Send text">Send</button>
		</form>
		<details>
			<summary>Architecture checks</summary>
			<button id="direct" class="secondary">Test IDE bridge</button>
			<pre id="events"></pre>
		</details>
	</main>
	<audio id="remoteAudio" autoplay></audio>
	<script src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function isCodeToolName(name: string): name is CodeToolName {
	return name === 'open_code_target' || name === 'show_code_references';
}

function isCodeTargetId(value: string): value is CodeTargetId {
	return Object.prototype.hasOwnProperty.call(CODE_TARGETS, value);
}

function parseCodeTargetArguments(serializedArguments: string): CodeTargetId | undefined {
	try {
		const value = JSON.parse(serializedArguments) as Record<string, string> | null;
		if (value !== null
			&& typeof value === 'object'
			&& !Array.isArray(value)
			&& Object.keys(value).length === 1
			&& typeof value.target === 'string'
			&& isCodeTargetId(value.target)) {
			return value.target;
		}
	} catch {
		// Invalid JSON is rejected at the host boundary.
	}
	return undefined;
}

async function openCodeTarget(targetId: CodeTargetId, highlight: vscode.TextEditorDecorationType): Promise<ToolResult> {
	const target = CODE_TARGETS[targetId];
	try {
		const resolved = await resolveCodeTarget(target);
		await revealCodeTarget(resolved, highlight);

		return {
			ok: true,
			target: targetId,
			file: vscode.workspace.asRelativePath(resolved.uri),
			line: resolved.selectionRange.start.line + 1,
			spoken_response: `Opened ${target.spokenName}.`,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(vscode.l10n.t('CDE could not open {0}: {1}', target.spokenName, message));
		return {
			ok: false,
			target: targetId,
			spoken_response: `I could not open ${target.spokenName}.`,
			error: message,
		};
	}
}

async function showCodeReferences(targetId: CodeTargetId, highlight: vscode.TextEditorDecorationType): Promise<ToolResult> {
	const target = CODE_TARGETS[targetId];
	try {
		const resolved = await resolveCodeTarget(target);
		await revealCodeTarget(resolved, highlight);
		const references = await vscode.commands.executeCommand<vscode.Location[] | undefined>(
			'vscode.executeReferenceProvider',
			resolved.uri,
			resolved.selectionRange.start,
		) ?? [];

		if (references.length === 0) {
			throw new Error(`No references found for ${target.symbol}.`);
		}

		await vscode.commands.executeCommand(
			'editor.action.peekLocations',
			resolved.uri,
			resolved.selectionRange.start,
			references,
			'peek',
		);

		return {
			ok: true,
			target: targetId,
			file: vscode.workspace.asRelativePath(resolved.uri),
			line: resolved.selectionRange.start.line + 1,
			reference_count: references.length,
			spoken_response: `Showing ${target.spokenName} references.`,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(vscode.l10n.t('CDE could not show references for {0}: {1}', target.spokenName, message));
		return {
			ok: false,
			target: targetId,
			spoken_response: `I could not show ${target.spokenName} references.`,
			error: message,
		};
	}
}

async function resolveCodeTarget(target: CodeTarget): Promise<ResolvedCodeTarget> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		throw new Error('Open the demo/voice-open-checkout folder first.');
	}

	const uri = vscode.Uri.joinPath(folder.uri, ...target.file.split('/'));
	const document = await vscode.workspace.openTextDocument(uri);
	const providerSymbol = await findSymbolWithRetry(uri, target.symbol);
	if (providerSymbol) {
		const range = providerSymbol.range ?? providerSymbol.location?.range;
		const selectionRange = providerSymbol.selectionRange ?? providerSymbol.location?.range;
		if (range && selectionRange) {
			return { uri, document, selectionRange, highlightRange: range };
		}
	}

	return resolveCodeTargetFromText(target, uri, document);
}

async function findSymbolWithRetry(uri: vscode.Uri, symbolName: string): Promise<SymbolNode | undefined> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const symbols = await vscode.commands.executeCommand<SymbolNode[] | undefined>(
				'vscode.executeDocumentSymbolProvider',
				uri,
			) ?? [];
			const symbol = findSymbol(symbols, symbolName);
			if (symbol) {
				return symbol;
			}
		} catch {
			// Retry once while the language provider warms up, then use the text anchor.
		}

		if (attempt === 0) {
			await delay(DOCUMENT_SYMBOL_RETRY_DELAY_MS);
		}
	}
	return undefined;
}

function findSymbol(symbols: readonly SymbolNode[], symbolName: string): SymbolNode | undefined {
	for (const symbol of symbols) {
		if (symbol.name === symbolName) {
			return symbol;
		}
		const child = findSymbol(symbol.children ?? [], symbolName);
		if (child) {
			return child;
		}
	}
	return undefined;
}

function resolveCodeTargetFromText(target: CodeTarget, uri: vscode.Uri, document: vscode.TextDocument): ResolvedCodeTarget {
	const symbolOffsetWithinAnchor = target.fallbackAnchor.indexOf(target.symbol);
	const anchorOffset = document.getText().indexOf(target.fallbackAnchor);
	if (anchorOffset < 0 || symbolOffsetWithinAnchor < 0) {
		throw new Error(`Could not find ${target.symbol} in ${target.file}.`);
	}

	const symbolOffset = anchorOffset + symbolOffsetWithinAnchor;
	const start = document.positionAt(symbolOffset);
	const end = document.positionAt(symbolOffset + target.symbol.length);
	return {
		uri,
		document,
		selectionRange: new vscode.Range(start, end),
		highlightRange: document.lineAt(start.line).range,
	};
}

async function revealCodeTarget(resolved: ResolvedCodeTarget, highlight: vscode.TextEditorDecorationType): Promise<void> {
	const editor = await vscode.window.showTextDocument(resolved.document, {
		preview: false,
		preserveFocus: false,
		selection: resolved.selectionRange,
	});
	editor.selection = new vscode.Selection(resolved.selectionRange.start, resolved.selectionRange.end);
	editor.setDecorations(highlight, [resolved.highlightRange]);
	editor.revealRange(resolved.highlightRange, vscode.TextEditorRevealType.InCenter);
}

function delay(durationMs: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, durationMs));
}

function openCheckoutLogic(highlight: vscode.TextEditorDecorationType): Promise<ToolResult> {
	return openCodeTarget('checkout_final_price', highlight);
}

function getOpenAiApiKey(): string | undefined {
	const configured = vscode.workspace.getConfiguration('cde').get<string>('openaiApiKey')?.trim();
	return configured || process.env.OPENAI_API_KEY?.trim() || undefined;
}

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel(vscode.l10n.t('CDE Spike'));
	const highlight = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'),
		overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.wordHighlightStrongForeground'),
		overviewRulerLane: vscode.OverviewRulerLane.Full,
	});
	const provider = new ConversationViewProvider(context.extensionUri, output, highlight);
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	status.name = vscode.l10n.t('CDE Spike');
	status.text = '$(mic) CDE Spike';
	status.tooltip = vscode.l10n.t('Open the CDE voice-to-IDE experiment');
	status.command = 'cde.openConversation';
	status.show();

	context.subscriptions.push(
		output,
		highlight,
		status,
		vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand('cde.openConversation', () => vscode.commands.executeCommand('workbench.view.extension.cde')),
		vscode.commands.registerCommand('cde.openCheckoutDirectly', () => openCheckoutLogic(highlight)),
	);
}
