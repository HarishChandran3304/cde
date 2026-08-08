/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { NavigationController, NavigationToolResult } from './navigation';

const VIEW_ID = 'cde.conversation';
const SDP_EXCHANGE_TIMEOUT_MS = 15_000;

type NavigationToolName = 'open_file' | 'open_symbol' | 'show_references' | 'go_to_definition';

interface NavigationToolArguments {
	readonly query?: string;
	readonly symbol?: string;
	readonly file?: string;
}

type WebviewMessage =
	| { readonly type: 'exchangeSdp'; readonly requestId: string; readonly sdp: string }
	| { readonly type: 'executeTool'; readonly requestId: string; readonly sessionEpoch: number; readonly callId: string; readonly name: string; readonly arguments: string }
	| { readonly type: 'openCheckoutDirectly'; readonly requestId: string };

const realtimeSession = {
	type: 'realtime',
	model: 'gpt-realtime-2.1',
	instructions: `You are CDE, a terse voice interface inside a code editor.

This is a focused code-navigation experiment. You have exactly four useful tools.
- Use open_file when the user names or describes a file or module they want opened. Pass only the meaningful filename or module phrase as query, such as "checkout", "cart summary", or "src/orders/order-draft.ts".
- Use open_symbol when the user asks where a function, class, method, or other named symbol is defined. Convert spoken names to their likely source identifier, such as "calculate final price" to "calculateFinalPrice". Include file only when the user supplies a file hint.
- Use show_references for references, usages, or callers. Omit symbol when the user says "it", "that", "this", or otherwise refers to the current or last-opened symbol.
- Use go_to_definition when the user asks to go back or jump to a definition. Omit symbol for contextual follow-ups.
- Treat "open the checkout service" as open_file with query "checkout" and "where is the final price calculated" as open_symbol with query "calculateFinalPrice".
- Never claim an editor action happened before its tool succeeds.
- Do not speak before calling the tool.
- When the tool returns, say its spoken_response exactly and add nothing.
- For unrelated requests, briefly say this experiment currently handles code navigation only.`,
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
			name: 'open_file',
			description: 'Fuzzy-find and open a file anywhere in the current workspace.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'A concise filename, path, or module phrase.',
					},
				},
				required: ['query'],
				additionalProperties: false,
			},
		},
		{
			type: 'function',
			name: 'open_symbol',
			description: 'Find, open, select, and highlight a named workspace symbol.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'The source symbol name to find.',
					},
					file: {
						type: 'string',
						description: 'Optional filename or path hint.',
					},
				},
				required: ['query'],
				additionalProperties: false,
			},
		},
		{
			type: 'function',
			name: 'show_references',
			description: 'Show native VS Code references for an explicit, selected, or recently opened symbol.',
			parameters: {
				type: 'object',
				properties: {
					symbol: {
						type: 'string',
						description: 'Optional explicit source symbol name. Omit for contextual follow-ups.',
					},
					file: {
						type: 'string',
						description: 'Optional filename or path hint for the explicit symbol.',
					},
				},
				additionalProperties: false,
			},
		},
		{
			type: 'function',
			name: 'go_to_definition',
			description: 'Go to the definition of an explicit, selected, or recently opened symbol.',
			parameters: {
				type: 'object',
				properties: {
					symbol: {
						type: 'string',
						description: 'Optional explicit source symbol name. Omit for contextual follow-ups.',
					},
					file: {
						type: 'string',
						description: 'Optional filename or path hint for the explicit symbol.',
					},
				},
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
		private readonly navigation: NavigationController,
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
				const result = await this.navigation.openPreparedCheckout();
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
		let result: NavigationToolResult;
		const argumentsValue = isNavigationToolName(message.name) ? parseNavigationToolArguments(message.name, message.arguments) : undefined;
		if (!isNavigationToolName(message.name)) {
			result = {
				ok: false,
				spoken_response: 'That tool is not available in this experiment.',
				error: `Unknown tool: ${message.name}`,
			};
		} else if (!argumentsValue) {
			result = {
				ok: false,
				spoken_response: 'I could not understand that navigation request.',
				error: `Invalid arguments for ${message.name}.`,
			};
		} else {
			switch (message.name) {
				case 'open_file':
					result = await this.navigation.openFile(argumentsValue.query!);
					break;
				case 'open_symbol':
					result = await this.navigation.openSymbol(argumentsValue.query!, argumentsValue.file);
					break;
				case 'show_references':
					result = await this.navigation.showReferences(argumentsValue.symbol, argumentsValue.file);
					break;
				case 'go_to_definition':
					result = await this.navigation.goToDefinition(argumentsValue.symbol, argumentsValue.file);
					break;
			}
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

function isNavigationToolName(name: string): name is NavigationToolName {
	return name === 'open_file' || name === 'open_symbol' || name === 'show_references' || name === 'go_to_definition';
}

function parseNavigationToolArguments(toolName: NavigationToolName, serializedArguments: string): NavigationToolArguments | undefined {
	try {
		const value = JSON.parse(serializedArguments) as Record<string, unknown> | null;
		if (value === null || typeof value !== 'object' || Array.isArray(value)) {
			return undefined;
		}

		const allowedKeys = toolName === 'open_file'
			? ['query']
			: toolName === 'open_symbol'
				? ['query', 'file']
				: ['symbol', 'file'];
		if (Object.keys(value).some(key => !allowedKeys.includes(key))) {
			return undefined;
		}

		for (const candidate of Object.values(value)) {
			if (typeof candidate !== 'string' || !candidate.trim()) {
				return undefined;
			}
		}
		if ((toolName === 'open_file' || toolName === 'open_symbol') && typeof value.query !== 'string') {
			return undefined;
		}

		return {
			query: typeof value.query === 'string' ? value.query.trim() : undefined,
			symbol: typeof value.symbol === 'string' ? value.symbol.trim() : undefined,
			file: typeof value.file === 'string' ? value.file.trim() : undefined,
		};
	} catch {
		return undefined;
	}
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
	const navigation = new NavigationController(highlight);
	const provider = new ConversationViewProvider(context.extensionUri, output, navigation);
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
		vscode.commands.registerCommand('cde.openCheckoutDirectly', () => navigation.openPreparedCheckout()),
	);
}
