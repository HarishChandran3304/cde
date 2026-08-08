/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const VIEW_ID = 'cde.conversation';
const CHECKOUT_FILE = 'src/checkout.ts';
const CHECKOUT_ANCHOR = 'calculateFinalPrice';

interface ToolResult {
	readonly ok: boolean;
	readonly file?: string;
	readonly line?: number;
	readonly spoken_response: string;
	readonly error?: string;
}

type WebviewMessage =
	| { readonly type: 'exchangeSdp'; readonly requestId: string; readonly sdp: string }
	| { readonly type: 'executeTool'; readonly requestId: string; readonly callId: string; readonly name: string; readonly arguments: string }
	| { readonly type: 'openCheckoutDirectly'; readonly requestId: string }
	| { readonly type: 'openSettings' };

const realtimeSession = {
	type: 'realtime',
	model: 'gpt-realtime-2.1',
	instructions: `You are CDE, a terse voice interface inside a code editor.

This is a single-purpose architecture experiment. You have exactly one useful tool.
- When the user asks to open, navigate to, find, or show the checkout logic, call open_demo_file immediately.
- Treat natural paraphrases such as "open the checkout service" and "where is checkout calculated" as the same request.
- Never claim the file opened before the tool succeeds.
- Do not speak before calling the tool.
- When the tool returns, say its spoken_response exactly and add nothing.
- For unrelated requests, briefly say this experiment only opens the checkout logic.`,
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
			name: 'open_demo_file',
			description: 'Open the prepared checkout logic file and reveal its final-price function in the editor.',
			parameters: {
				type: 'object',
				properties: {
					target: {
						type: 'string',
						enum: ['checkout_logic'],
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
			case 'openSettings':
				await vscode.commands.executeCommand('workbench.action.openSettings', 'cde.openaiApiKey');
				return;
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
			const response = await fetch('https://api.openai.com/v1/realtime/calls', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'OpenAI-Safety-Identifier': 'cde-local-spike',
				},
				body: form,
			});

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
		if (message.name === 'open_demo_file') {
			result = await openCheckoutLogic(this.highlight);
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
			<button id="settings" class="secondary">Set API key</button>
			<pre id="events"></pre>
		</details>
	</main>
	<audio id="remoteAudio" autoplay></audio>
	<script src="${scriptUri}"></script>
</body>
</html>`;
	}
}

async function openCheckoutLogic(highlight: vscode.TextEditorDecorationType): Promise<ToolResult> {
	try {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			throw new Error('Open the demo/voice-open-checkout folder first.');
		}

		const uri = vscode.Uri.joinPath(folder.uri, ...CHECKOUT_FILE.split('/'));
		const document = await vscode.workspace.openTextDocument(uri);
		const editor = await vscode.window.showTextDocument(document, { preview: false });
		const source = document.getText();
		const anchorOffset = source.indexOf(CHECKOUT_ANCHOR);
		if (anchorOffset < 0) {
			throw new Error(`Could not find ${CHECKOUT_ANCHOR} in ${CHECKOUT_FILE}.`);
		}

		const start = document.positionAt(anchorOffset);
		const end = document.positionAt(anchorOffset + CHECKOUT_ANCHOR.length);
		const selection = new vscode.Selection(start, end);
		const lineRange = document.lineAt(start.line).range;
		editor.selection = selection;
		editor.setDecorations(highlight, [lineRange]);
		editor.revealRange(lineRange, vscode.TextEditorRevealType.InCenter);

		return {
			ok: true,
			file: vscode.workspace.asRelativePath(uri),
			line: start.line + 1,
			spoken_response: 'Opened the checkout logic.',
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(vscode.l10n.t('CDE could not open checkout logic: {0}', message));
		return {
			ok: false,
			spoken_response: 'I could not open the checkout logic.',
			error: message,
		};
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
