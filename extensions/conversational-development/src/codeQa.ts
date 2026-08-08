/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { pathToFileURL } from 'url';
import * as vscode from 'vscode';
import { buildCodeQaPrompt, CODE_QA_OUTPUT_SCHEMA, CodeQaAnswer, CodeQaContext, parseCodeQaAnswer } from './codeQaProtocol';

const CODE_QA_TIMEOUT_MS = 60_000;
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const;

export interface CodeQaToolResult extends CodeQaAnswer {
	readonly ok: boolean;
	readonly error?: string;
}

interface AgentResultSuccess {
	readonly type: 'result';
	readonly subtype: 'success';
	readonly is_error: boolean;
	readonly result: string;
	readonly structured_output?: unknown;
	readonly num_turns: number;
	readonly duration_ms: number;
}

interface AgentResultError {
	readonly type: 'result';
	readonly subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
	readonly is_error: boolean;
	readonly errors: readonly string[];
}

type AgentResult = AgentResultSuccess | AgentResultError;

interface AgentQuery extends AsyncIterable<unknown> {
	close(): void;
}

interface AgentSdk {
	query(parameters: { readonly prompt: string; readonly options: AgentQueryOptions }): AgentQuery;
}

interface AgentQueryOptions {
	readonly abortController: AbortController;
	readonly cwd: string;
	readonly model: string;
	readonly tools: readonly string[];
	readonly allowedTools: readonly string[];
	readonly permissionMode: 'dontAsk';
	readonly settingSources: readonly string[];
	readonly strictMcpConfig: boolean;
	readonly persistSession: boolean;
	readonly maxTurns: number;
	readonly maxBudgetUsd: number;
	readonly effort: 'low';
	readonly outputFormat: {
		readonly type: 'json_schema';
		readonly schema: typeof CODE_QA_OUTPUT_SCHEMA;
	};
	readonly systemPrompt: string;
}

type NativeImport = (specifier: string) => Promise<AgentSdk>;

const nativeImport = new Function('specifier', 'return import(specifier);') as NativeImport;

export class CodeQaController {
	constructor(private readonly trace: (message: string) => void) { }

	async ask(question: string): Promise<CodeQaToolResult> {
		const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
		if (!apiKey) {
			return failure('Claude is not configured in this CDE launch.', 'ANTHROPIC_API_KEY is missing.');
		}

		const workspaceRoot = getWorkspaceRoot();
		if (!workspaceRoot) {
			return failure('Open a workspace before asking a code question.', 'No workspace folder is open.');
		}

		const context = captureEditorContext(workspaceRoot, question);
		const abortController = new AbortController();
		const timeout = setTimeout(() => abortController.abort(), CODE_QA_TIMEOUT_MS);
		this.trace(`code-qa.start workspace=${workspaceRoot.fsPath} active=${context.activeFile ?? 'none'}`);

		try {
			const sdk = await loadAgentSdk();
			const queryHandle = sdk.query({
				prompt: buildCodeQaPrompt(context),
				options: createQueryOptions(workspaceRoot.fsPath, abortController),
			});
			let finalResult: AgentResult | undefined;
			try {
				for await (const message of queryHandle) {
					if (isAgentResult(message)) {
						finalResult = message;
					}
				}
			} finally {
				queryHandle.close();
			}

			if (!finalResult) {
				return failure('Claude did not return an answer.', 'The Agent SDK stream ended without a result.');
			}
			if (finalResult.subtype !== 'success') {
				const detail = finalResult.errors.join(' ') || finalResult.subtype;
				return failure('Claude could not finish that repository question.', detail);
			}
			if (finalResult.is_error) {
				return failure('Claude could not finish that repository question.', finalResult.result);
			}

			const answer = parseCodeQaAnswer(finalResult.structured_output, finalResult.result);
			if (!answer) {
				return failure('Claude returned an empty answer.', 'The result contained no usable response.');
			}
			this.trace(`code-qa.success turns=${finalResult.num_turns} duration_ms=${finalResult.duration_ms}`);
			return { ok: true, ...answer };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.trace(`code-qa.error ${message}`);
			if (abortController.signal.aborted) {
				return failure('That code search took too long, so I stopped it.', 'Claude code Q&A timed out.');
			}
			return failure('I could not inspect the codebase just now.', message);
		} finally {
			clearTimeout(timeout);
		}
	}
}

function createQueryOptions(workspaceRoot: string, abortController: AbortController): AgentQueryOptions {
	return {
		abortController,
		cwd: workspaceRoot,
		model: process.env.CDE_CLAUDE_MODEL?.trim() || 'sonnet',
		tools: [...READ_ONLY_TOOLS],
		allowedTools: [...READ_ONLY_TOOLS],
		permissionMode: 'dontAsk',
		settingSources: [],
		strictMcpConfig: true,
		persistSession: false,
		maxTurns: 6,
		maxBudgetUsd: 0.25,
		effort: 'low',
		outputFormat: {
			type: 'json_schema',
			schema: CODE_QA_OUTPUT_SCHEMA,
		},
		systemPrompt: `You are the read-only code analyst inside a conversational development environment. Inspect the repository before answering. You may read and search, but never edit files, run shell commands, browse the web, or claim facts the repository does not establish. Return concise, demo-ready answers with precise repository-relative file:line citations.`,
	};
}

function captureEditorContext(workspaceRoot: vscode.Uri, question: string): CodeQaContext {
	const activeEditor = vscode.window.activeTextEditor;
	const activeFile = activeEditor && activeEditor.document.uri.scheme === 'file'
		? relativePath(workspaceRoot.fsPath, activeEditor.document.uri.fsPath)
		: undefined;
	const selection = activeEditor && !activeEditor.selection.isEmpty
		? activeEditor.document.getText(activeEditor.selection)
		: undefined;
	const visibleFiles = vscode.window.visibleTextEditors
		.filter(editor => editor.document.uri.scheme === 'file')
		.map(editor => relativePath(workspaceRoot.fsPath, editor.document.uri.fsPath))
		.filter((file, index, files) => files.indexOf(file) === index);

	return {
		question,
		activeFile,
		activeLine: activeEditor ? activeEditor.selection.active.line + 1 : undefined,
		selection,
		visibleFiles,
	};
}

function getWorkspaceRoot(): vscode.Uri | undefined {
	const activeUri = vscode.window.activeTextEditor?.document.uri;
	return (activeUri ? vscode.workspace.getWorkspaceFolder(activeUri)?.uri : undefined)
		?? vscode.workspace.workspaceFolders?.[0]?.uri;
}

function relativePath(root: string, target: string): string {
	const relative = path.relative(root, target);
	return relative && !relative.startsWith('..') ? relative.split(path.sep).join('/') : target;
}

async function loadAgentSdk(): Promise<AgentSdk> {
	const entrypoint = require.resolve('@anthropic-ai/claude-agent-sdk');
	return nativeImport(pathToFileURL(entrypoint).href);
}

function failure(spokenResponse: string, error: string): CodeQaToolResult {
	return {
		ok: false,
		spoken_response: spokenResponse,
		display_response: spokenResponse,
		error,
	};
}

function isAgentResult(value: unknown): value is AgentResult {
	if (value === null || typeof value !== 'object') {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return candidate.type === 'result' && typeof candidate.subtype === 'string';
}
