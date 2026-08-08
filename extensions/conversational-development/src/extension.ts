/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CodeQaController, CodeQaToolResult } from './codeQa';
import { CodeQaWalkthroughStep } from './codeQaProtocol';
import {
	CALL_HIERARCHY_DIRECTIONS,
	CallHierarchyDirection,
	EDITOR_CONTROL_ACTIONS,
	EDITOR_PLACEMENTS,
	EditorControlAction,
	EditorPlacement,
	NavigationController,
	NavigationToolResult,
	REFERENCE_CONTROL_ACTIONS,
	ReferenceControlAction,
} from './navigation';
import { WalkthroughController } from './walkthrough';

const VIEW_ID = 'cde.conversation';
const SDP_EXCHANGE_TIMEOUT_MS = 15_000;

type CdeToolName = 'open_file' | 'open_symbol' | 'show_references' | 'control_references' | 'show_call_hierarchy' | 'go_to_definition' | 'control_editor' | 'ask_codebase';

interface CdeToolArguments {
	readonly query?: string;
	readonly question?: string;
	readonly symbol?: string;
	readonly file?: string;
	readonly placement?: EditorPlacement;
	readonly action?: EditorControlAction;
	readonly referenceAction?: ReferenceControlAction;
	readonly direction?: CallHierarchyDirection;
}

type WebviewMessage =
	| { readonly type: 'exchangeSdp'; readonly requestId: string; readonly sdp: string }
	| { readonly type: 'executeTool'; readonly requestId: string; readonly sessionEpoch: number; readonly callId: string; readonly name: string; readonly arguments: string }
	| { readonly type: 'revealWalkthroughStep'; readonly requestId: string; readonly sessionEpoch: number; readonly walkthroughId: string; readonly stepIndex: number; readonly step: CodeQaWalkthroughStep }
	| { readonly type: 'resetWalkthrough' }
	| { readonly type: 'openCheckoutDirectly'; readonly requestId: string };

const realtimeSession = {
	type: 'realtime',
	model: 'gpt-realtime-2.1',
	instructions: `You are CDE, a terse voice interface inside a code editor.

This is a focused conversational-development experiment. You have exactly nine useful tools.
- Use open_file when the user names or describes a file or module they want opened. Pass only the meaningful filename or module phrase as query, such as "checkout", "cart summary", or "src/orders/order-draft.ts". Use placement when the user says beside, left, right, or below.
- Use open_symbol when the user asks where a function, class, method, or other named symbol is defined. Convert spoken names to their likely source identifier, such as "calculate final price" to "calculateFinalPrice". Include file only when the user supplies a file hint, and placement when they request another pane.
- Use show_references for generic references or usages. Omit symbol when the user says "it", "that", "this", or otherwise refers to the current or last-opened symbol.
- Use control_references after show_references when the user says next reference, previous reference, open this reference, close references, or asks for a reference in a particular file. For requests like "show me the one in checkout.js", use select_file and pass the user's filename or module phrase as file.
- Use show_call_hierarchy with incoming for actual callers and outgoing for functions called by the target. Do not use generic references when the user specifically says callers, callees, incoming calls, or outgoing calls.
- Use go_to_definition when the user asks to go back or jump to a definition. Omit symbol for contextual follow-ups and use placement for requests like "open its definition on the right".
- Use control_editor for splits, focus changes, moving tabs or groups, closing or pinning tabs, and navigation history. Distinguish moving this tab from moving the whole editor group.
- Use ask_codebase for explanations, "why" questions, behavior, data flow, architecture, risks, debugging questions, and questions about selected code. Pass the user's complete question. It receives live editor context and must inspect the repository before answering. Never answer a repository question from your own knowledge.
- Use control_walkthrough when the user wants to move through, pause, resume, repeat, stop, or toggle following for an active narrated code walkthrough. "Go back" means previous when the user is clearly discussing the walkthrough; otherwise use editor navigation history.
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
					placement: {
						type: 'string',
						enum: EDITOR_PLACEMENTS,
						description: 'Where to open the file. Omit for the current editor.',
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
					placement: {
						type: 'string',
						enum: EDITOR_PLACEMENTS,
						description: 'Where to open the symbol. Omit for the current editor.',
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
			name: 'control_editor',
			description: 'Control editor layout, focus, tabs, groups, and navigation history.',
			parameters: {
				type: 'object',
				properties: {
					action: {
						type: 'string',
						enum: EDITOR_CONTROL_ACTIONS,
						description: 'The deterministic editor action to execute.',
					},
				},
				required: ['action'],
				additionalProperties: false,
			},
		},
		{
			type: 'function',
			name: 'control_references',
			description: 'Navigate within the currently open native References Peek view, including semantic file selection.',
			parameters: {
				type: 'object',
				properties: {
					action: {
						type: 'string',
						enum: REFERENCE_CONTROL_ACTIONS,
						description: 'Next or previous moves through results; select_file finds a result by filename; open keeps the selected result and closes Peek; close dismisses Peek.',
					},
					file: {
						type: 'string',
						description: 'A filename, path, or module phrase. Required only for select_file.',
					},
				},
				required: ['action'],
				additionalProperties: false,
			},
		},
		{
			type: 'function',
			name: 'show_call_hierarchy',
			description: 'Show true incoming callers or outgoing calls for an explicit, selected, or recently opened symbol.',
			parameters: {
				type: 'object',
				properties: {
					direction: {
						type: 'string',
						enum: CALL_HIERARCHY_DIRECTIONS,
						description: 'Incoming means callers; outgoing means symbols called by the target.',
					},
					symbol: {
						type: 'string',
						description: 'Optional explicit source symbol name. Omit for contextual follow-ups.',
					},
					file: {
						type: 'string',
						description: 'Optional filename or path hint for the explicit symbol.',
					},
				},
				required: ['direction'],
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
					placement: {
						type: 'string',
						enum: EDITOR_PLACEMENTS,
						description: 'Where to open the definition. Omit for the current editor.',
					},
				},
				additionalProperties: false,
			},
		},
		{
			type: 'function',
			name: 'ask_codebase',
			description: 'Inspect the current repository with Claude and answer a grounded code question using live editor context.',
			parameters: {
				type: 'object',
				properties: {
					question: {
						type: 'string',
						description: 'The complete repository question in the user\'s own words.',
					},
				},
				required: ['question'],
				additionalProperties: false,
			},
		},
		{
			type: 'function',
			name: 'control_walkthrough',
			description: 'Control the active narrated code walkthrough without changing repository files.',
			parameters: {
				type: 'object',
				properties: {
					action: {
						type: 'string',
						enum: ['next', 'previous', 'repeat', 'pause', 'resume', 'stop', 'follow_on', 'follow_off'],
						description: 'The walkthrough playback or following action.',
					},
				},
				required: ['action'],
				additionalProperties: false,
			},
		},
	],
	tool_choice: 'auto',
	max_output_tokens: 1024,
} as const;

class ConversationViewProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly output: vscode.OutputChannel,
		private readonly navigation: NavigationController,
		private readonly codeQa: CodeQaController,
		private readonly walkthrough: WalkthroughController,
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
			case 'revealWalkthroughStep': {
				const result = await this.walkthrough.reveal(message.step);
				this.trace(`walkthrough.reveal index=${message.stepIndex} ${JSON.stringify(result)}`);
				await this.post({
					type: 'walkthroughStepReady',
					requestId: message.requestId,
					sessionEpoch: message.sessionEpoch,
					walkthroughId: message.walkthroughId,
					stepIndex: message.stepIndex,
					result,
				});
				return;
			}
			case 'resetWalkthrough':
				this.walkthrough.reset();
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
		let result: NavigationToolResult | CodeQaToolResult;
		const argumentsValue = isCdeToolName(message.name) ? parseCdeToolArguments(message.name, message.arguments) : undefined;
		if (!isCdeToolName(message.name)) {
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
					result = await this.navigation.openFile(argumentsValue.query!, argumentsValue.placement);
					break;
				case 'open_symbol':
					result = await this.navigation.openSymbol(argumentsValue.query!, argumentsValue.file, argumentsValue.placement);
					break;
				case 'show_references':
					result = await this.navigation.showReferences(argumentsValue.symbol, argumentsValue.file);
					break;
				case 'control_references':
					result = await this.navigation.controlReferences(argumentsValue.referenceAction!, argumentsValue.file);
					break;
				case 'show_call_hierarchy':
					result = await this.navigation.showCallHierarchy(argumentsValue.direction!, argumentsValue.symbol, argumentsValue.file);
					break;
				case 'go_to_definition':
					result = await this.navigation.goToDefinition(argumentsValue.symbol, argumentsValue.file, argumentsValue.placement);
					break;
				case 'control_editor':
					result = await this.navigation.controlEditor(argumentsValue.action!);
					break;
				case 'ask_codebase':
					result = await this.codeQa.ask(argumentsValue.question!);
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
		<div class="connection-controls">
			<button id="connect" class="primary">Connect</button>
			<button id="mute" class="mute" type="button" aria-pressed="false" title="Mute microphone" disabled>Mute</button>
		</div>
		<section class="transcript" aria-live="polite">
			<span class="label">You</span>
			<p id="userText">Say “why can the discount make this negative?”</p>
			<span class="label">CDE</span>
			<p id="assistantText">Waiting to connect.</p>
		</section>
		<section id="walkthrough" class="walkthrough" hidden>
			<div class="walkthrough-header">
				<div>
					<span class="label">Walkthrough</span>
					<p id="walkthroughProgress" class="walkthrough-progress"></p>
				</div>
				<button id="walkthroughFollow" class="compact" type="button" aria-pressed="true" title="Toggle automatic editor following">Follow On</button>
			</div>
			<ol id="walkthroughSteps" class="walkthrough-steps"></ol>
			<div class="walkthrough-controls">
				<button id="walkthroughPrevious" class="compact" type="button" title="Previous walkthrough step">Previous</button>
				<button id="walkthroughPause" class="compact" type="button" title="Pause walkthrough">Pause</button>
				<button id="walkthroughRepeat" class="compact" type="button" title="Repeat walkthrough step">Repeat</button>
				<button id="walkthroughNext" class="compact" type="button" title="Next walkthrough step">Next</button>
				<button id="walkthroughStop" class="compact" type="button" title="Stop walkthrough">Stop</button>
			</div>
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

function isCdeToolName(name: string): name is CdeToolName {
	return name === 'open_file'
		|| name === 'open_symbol'
			|| name === 'show_references'
			|| name === 'control_references'
		|| name === 'show_call_hierarchy'
		|| name === 'go_to_definition'
		|| name === 'control_editor'
		|| name === 'ask_codebase';
}

function parseCdeToolArguments(toolName: CdeToolName, serializedArguments: string): CdeToolArguments | undefined {
	try {
		const value = JSON.parse(serializedArguments) as Record<string, unknown> | null;
		if (value === null || typeof value !== 'object' || Array.isArray(value)) {
			return undefined;
		}

		const allowedKeys = toolName === 'open_file'
			? ['query', 'placement']
			: toolName === 'open_symbol'
				? ['query', 'file', 'placement']
				: toolName === 'show_references'
					? ['symbol', 'file']
					: toolName === 'control_references'
						? ['action', 'file']
						: toolName === 'show_call_hierarchy'
						? ['direction', 'symbol', 'file']
						: toolName === 'go_to_definition'
							? ['symbol', 'file', 'placement']
							: toolName === 'control_editor'
								? ['action']
								: ['question'];
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
		if (toolName === 'ask_codebase' && typeof value.question !== 'string') {
			return undefined;
		}
		if (typeof value.placement === 'string' && !EDITOR_PLACEMENTS.includes(value.placement as EditorPlacement)) {
			return undefined;
		}
		if (toolName === 'control_editor'
			&& (typeof value.action !== 'string' || !EDITOR_CONTROL_ACTIONS.includes(value.action as EditorControlAction))) {
			return undefined;
		}
		if (toolName === 'control_references'
			&& (typeof value.action !== 'string' || !REFERENCE_CONTROL_ACTIONS.includes(value.action as ReferenceControlAction))) {
			return undefined;
		}
		if (toolName === 'control_references'
			&& value.action === 'select_file'
			&& typeof value.file !== 'string') {
			return undefined;
		}
		if (toolName === 'show_call_hierarchy'
			&& (typeof value.direction !== 'string' || !CALL_HIERARCHY_DIRECTIONS.includes(value.direction as CallHierarchyDirection))) {
			return undefined;
		}

		return {
			query: typeof value.query === 'string' ? value.query.trim() : undefined,
			question: typeof value.question === 'string' ? value.question.trim() : undefined,
			symbol: typeof value.symbol === 'string' ? value.symbol.trim() : undefined,
			file: typeof value.file === 'string' ? value.file.trim() : undefined,
			placement: typeof value.placement === 'string' ? value.placement as EditorPlacement : undefined,
			action: typeof value.action === 'string' ? value.action as EditorControlAction : undefined,
			referenceAction: typeof value.action === 'string' && toolName === 'control_references'
				? value.action as ReferenceControlAction
				: undefined,
			direction: typeof value.direction === 'string' ? value.direction as CallHierarchyDirection : undefined,
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
	const codeQa = new CodeQaController(message => output.appendLine(`${new Date().toISOString()} ${message}`));
	const walkthrough = new WalkthroughController(highlight);
	const provider = new ConversationViewProvider(context.extensionUri, output, navigation, codeQa, walkthrough);
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
