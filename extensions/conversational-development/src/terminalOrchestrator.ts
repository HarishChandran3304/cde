/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import {
	appendTerminalOutput,
	findTerminalOutputLocations,
	normalizeTerminalSessionName,
	TerminalControlAction,
	TerminalOutputLocation,
	terminalOutputExcerpt,
	terminalOutputTail,
	TerminalSessionStatus,
} from './terminalProtocol';

const SHELL_INTEGRATION_TIMEOUT_MS = 4_000;

interface ManagedTerminalSession {
	readonly key: string;
	readonly name: string;
	readonly terminal: vscode.Terminal;
	readonly cwd: vscode.Uri;
	command: string;
	status: TerminalSessionStatus;
	generation: number;
	output: string;
	locations: readonly TerminalOutputLocation[];
	selectedLocation: number;
	exitCode?: number;
	interruptionRequested: boolean;
	startedAt: number;
	endedAt?: number;
}

interface ExecutionOwner {
	readonly sessionKey: string;
	readonly generation: number;
}

export interface TerminalSessionView {
	readonly name: string;
	readonly status: TerminalSessionStatus;
	readonly command: string;
}

export interface TerminalToolResult {
	readonly ok: boolean;
	readonly session?: string;
	readonly status?: TerminalSessionStatus;
	readonly command?: string;
	readonly cwd?: string;
	readonly exit_code?: number;
	readonly output_tail?: string;
	readonly location_count?: number;
	readonly file?: string;
	readonly line?: number;
	readonly sessions?: readonly TerminalSessionView[];
	readonly spoken_response: string;
	readonly error?: string;
}

export class TerminalOrchestrator implements vscode.Disposable {
	private readonly sessions = new Map<string, ManagedTerminalSession>();
	private readonly executionOwners = new Map<vscode.TerminalShellExecution, ExecutionOwner>();
	private readonly disposables: vscode.Disposable[] = [];
	private unnamedSessionCounter = 0;
	private mostRecentSessionKey: string | undefined;

	constructor(private readonly trace: (message: string) => void) {
		this.disposables.push(vscode.window.onDidEndTerminalShellExecution(event => this.onExecutionEnd(event)));
		this.disposables.push(vscode.window.onDidCloseTerminal(terminal => this.onTerminalClosed(terminal)));
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
		this.executionOwners.clear();
		for (const session of this.sessions.values()) {
			if (session.status !== 'closed') {
				session.terminal.dispose();
			}
		}
	}

	async runCommand(command: string, requestedName?: string, cwdQuery?: string): Promise<TerminalToolResult> {
		try {
			const cwd = await this.resolveWorkingDirectory(cwdQuery);
			const name = requestedName?.trim() || `terminal-${++this.unnamedSessionCounter}`;
			const key = normalizeTerminalSessionName(name);
			if (!key) {
				throw new Error('Give the terminal session a usable name.');
			}

			const existing = this.sessions.get(key);
			if (existing && (existing.status === 'starting' || existing.status === 'running')) {
				throw new Error(`${existing.name} is already running. Restart it or choose another session name.`);
			}

			let session: ManagedTerminalSession;
			if (existing && existing.status !== 'closed' && existing.cwd.toString() === cwd.toString()) {
				session = existing;
			} else {
				if (existing && existing.status !== 'closed') {
					existing.terminal.dispose();
				}
				session = this.createSession(key, name, cwd, command);
			}
			await this.startExecution(session, command);
			session.terminal.show(false);
			return this.sessionResult(session, `Started ${shortCommand(command)} in ${session.name}.`);
		} catch (error) {
			return this.failure('I could not start that terminal command.', error);
		}
	}

	async control(
		action: TerminalControlAction,
		requestedName?: string,
		input?: string,
		submit = true,
		occurrence?: number,
	): Promise<TerminalToolResult> {
		try {
			if (action === 'list') {
				return this.listSessions();
			}

			const session = this.resolveSession(requestedName);
			this.mostRecentSessionKey = session.key;
			switch (action) {
				case 'focus':
					this.requireOpenSession(session);
					session.terminal.show(false);
					return this.sessionResult(session, `Focused ${session.name}.`);
				case 'inspect':
					return this.inspectSession(session);
				case 'interrupt':
					return this.interruptSession(session);
				case 'restart':
					this.requireOpenSession(session);
					await this.startExecution(session, session.command);
					session.terminal.show(false);
					return this.sessionResult(session, `Restarted ${session.name}.`);
				case 'send_input':
					this.requireOpenSession(session);
					if (input === undefined) {
						throw new Error('Provide the input to send.');
					}
					session.terminal.sendText(input, submit);
					return this.sessionResult(session, `Sent input to ${session.name}.`);
				case 'open_location':
					return await this.openLocation(session, occurrence ? occurrence - 1 : session.selectedLocation);
				case 'next_location':
					return await this.openRelativeLocation(session, 1);
				case 'previous_location':
					return await this.openRelativeLocation(session, -1);
				case 'close':
					session.status = 'closed';
					session.endedAt = Date.now();
					session.terminal.dispose();
					return this.sessionResult(session, `Closed ${session.name}.`);
			}
		} catch (error) {
			return this.failure('I could not complete that terminal action.', error);
		}
	}

	private createSession(key: string, name: string, cwd: vscode.Uri, command: string): ManagedTerminalSession {
		const terminal = vscode.window.createTerminal({
			name: `CDE: ${name}`,
			cwd,
			isTransient: true,
		});
		const session: ManagedTerminalSession = {
			key,
			name,
			terminal,
			cwd,
			command,
			status: 'starting',
			generation: 0,
			output: '',
			locations: [],
			selectedLocation: -1,
			interruptionRequested: false,
			startedAt: Date.now(),
		};
		this.sessions.set(key, session);
		return session;
	}

	private async startExecution(session: ManagedTerminalSession, command: string): Promise<void> {
		this.requireOpenSession(session);
		session.terminal.show(true);
		session.status = 'starting';
		session.command = command;
		session.output = '';
		session.locations = [];
		session.selectedLocation = -1;
		session.exitCode = undefined;
		session.endedAt = undefined;
		session.interruptionRequested = false;
		session.startedAt = Date.now();
		session.generation += 1;

		let shellIntegration: vscode.TerminalShellIntegration;
		try {
			shellIntegration = await this.waitForShellIntegration(session.terminal);
		} catch (error) {
			session.status = 'failed';
			session.endedAt = Date.now();
			throw error;
		}
		const execution = shellIntegration.executeCommand(command);
		const owner = { sessionKey: session.key, generation: session.generation };
		this.executionOwners.set(execution, owner);
		session.status = 'running';
		this.mostRecentSessionKey = session.key;
		this.trace(`terminal.start name=${session.name} command=${JSON.stringify(command)}`);
		void this.captureOutput(session, execution, owner);
	}

	private async captureOutput(session: ManagedTerminalSession, execution: vscode.TerminalShellExecution, owner: ExecutionOwner): Promise<void> {
		try {
			for await (const chunk of execution.read()) {
				if (session.generation !== owner.generation) {
					return;
				}
				session.output = appendTerminalOutput(session.output, chunk);
				session.locations = findTerminalOutputLocations(session.output);
			}
		} catch (error) {
			this.trace(`terminal.output_error name=${session.name} error=${errorMessage(error)}`);
		}
	}

	private onExecutionEnd(event: vscode.TerminalShellExecutionEndEvent): void {
		const owner = this.executionOwners.get(event.execution);
		if (!owner) {
			return;
		}
		this.executionOwners.delete(event.execution);
		const session = this.sessions.get(owner.sessionKey);
		if (!session || session.generation !== owner.generation || session.status === 'closed') {
			return;
		}

		session.exitCode = event.exitCode;
		session.endedAt = Date.now();
		session.status = session.interruptionRequested
			? 'interrupted'
			: event.exitCode === 0
				? 'succeeded'
				: 'failed';
		this.trace(`terminal.end name=${session.name} status=${session.status} exit=${event.exitCode ?? 'unknown'}`);
	}

	private onTerminalClosed(terminal: vscode.Terminal): void {
		const session = [...this.sessions.values()].find(candidate => candidate.terminal === terminal);
		if (!session || session.status === 'closed') {
			return;
		}
		session.status = 'closed';
		session.endedAt = Date.now();
	}

	private interruptSession(session: ManagedTerminalSession): TerminalToolResult {
		this.requireOpenSession(session);
		if (session.status !== 'running' && session.status !== 'starting') {
			return this.sessionResult(session, `${session.name} is not currently running.`);
		}
		session.interruptionRequested = true;
		session.terminal.sendText('\x03', false);
		return this.sessionResult(session, `Sent an interrupt to ${session.name}.`);
	}

	private inspectSession(session: ManagedTerminalSession): TerminalToolResult {
		const excerpt = terminalOutputExcerpt(session.output);
		const status = session.status === 'succeeded' && session.exitCode === 0
			? 'finished successfully'
			: session.status === 'failed'
				? `failed${session.exitCode === undefined ? '' : ` with exit code ${session.exitCode}`}`
				: `is ${session.status}`;
		const spokenResponse = excerpt
			? `${session.name} ${status}. Latest output: ${excerpt}`
			: `${session.name} ${status}. No output has been captured yet.`;
		return this.sessionResult(session, spokenResponse);
	}

	private listSessions(): TerminalToolResult {
		const sessions = [...this.sessions.values()]
			.sort((left, right) => right.startedAt - left.startedAt)
			.map(session => ({ name: session.name, status: session.status, command: session.command }));
		const spokenResponse = sessions.length === 0
			? 'There are no managed terminal sessions yet.'
			: `Terminal sessions: ${sessions.map(session => `${session.name}, ${session.status}`).join('; ')}.`;
		return { ok: true, sessions, spoken_response: spokenResponse };
	}

	private async openRelativeLocation(session: ManagedTerminalSession, delta: -1 | 1): Promise<TerminalToolResult> {
		if (session.locations.length === 0) {
			throw new Error(`${session.name} has no captured file locations.`);
		}
		const index = session.selectedLocation < 0
			? delta > 0 ? 0 : session.locations.length - 1
			: (session.selectedLocation + delta + session.locations.length) % session.locations.length;
		return this.openLocation(session, index);
	}

	private async openLocation(session: ManagedTerminalSession, requestedIndex: number): Promise<TerminalToolResult> {
		if (session.locations.length === 0) {
			throw new Error(`${session.name} has no captured file locations.`);
		}
		const index = Math.max(0, requestedIndex);
		const location = session.locations[index];
		if (!location) {
			throw new Error(`${session.name} captured ${session.locations.length} location${session.locations.length === 1 ? '' : 's'}, not ${index + 1}.`);
		}
		const uri = await this.resolveOutputLocationUri(session, location.path);
		const document = await vscode.workspace.openTextDocument(uri);
		const position = new vscode.Position(location.line - 1, location.column - 1);
		const editor = await vscode.window.showTextDocument(document, {
			preview: false,
			preserveFocus: false,
			selection: new vscode.Range(position, position),
		});
		editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
		session.selectedLocation = index;
		return {
			...this.sessionResult(session, `Opened location ${index + 1} from ${session.name}.`),
			file: vscode.workspace.asRelativePath(uri),
			line: location.line,
		};
	}

	private async resolveOutputLocationUri(session: ManagedTerminalSession, outputPath: string): Promise<vscode.Uri> {
		const candidates = path.isAbsolute(outputPath)
			? [vscode.Uri.file(outputPath)]
			: [
				vscode.Uri.file(path.resolve(session.cwd.fsPath, outputPath)),
				...(vscode.workspace.workspaceFolders ?? []).map(folder => vscode.Uri.file(path.resolve(folder.uri.fsPath, outputPath))),
			];
		for (const candidate of candidates) {
			try {
				const stat = await vscode.workspace.fs.stat(candidate);
				if ((stat.type & vscode.FileType.File) !== 0) {
					return candidate;
				}
			} catch {
				// Try the next workspace-relative interpretation.
			}
		}
		throw new Error(`Could not resolve ${outputPath} to an existing file.`);
	}

	private async resolveWorkingDirectory(query?: string): Promise<vscode.Uri> {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!query) {
			if (!workspaceFolder) {
				throw new Error('Open a workspace folder or specify a working directory first.');
			}
			return workspaceFolder.uri;
		}

		const uri = path.isAbsolute(query)
			? vscode.Uri.file(query)
			: workspaceFolder
				? vscode.Uri.file(path.resolve(workspaceFolder.uri.fsPath, query))
				: vscode.Uri.file(path.resolve(query));
		const stat = await vscode.workspace.fs.stat(uri);
		if ((stat.type & vscode.FileType.Directory) === 0) {
			throw new Error(`${query} is not a directory.`);
		}
		return uri;
	}

	private waitForShellIntegration(terminal: vscode.Terminal): Promise<vscode.TerminalShellIntegration> {
		if (terminal.shellIntegration) {
			return Promise.resolve(terminal.shellIntegration);
		}
		return new Promise<vscode.TerminalShellIntegration>((resolve, reject) => {
			let settled = false;
			const listener = vscode.window.onDidChangeTerminalShellIntegration(event => {
				if (event.terminal !== terminal || settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				listener.dispose();
				resolve(event.shellIntegration);
			});
			const timer = setTimeout(() => {
				if (settled) {
					return;
				}
				settled = true;
				listener.dispose();
				reject(new Error('Terminal shell integration did not become available.'));
			}, SHELL_INTEGRATION_TIMEOUT_MS);
		});
	}

	private resolveSession(requestedName?: string): ManagedTerminalSession {
		if (!requestedName) {
			const recent = this.mostRecentSessionKey ? this.sessions.get(this.mostRecentSessionKey) : undefined;
			if (recent) {
				return recent;
			}
			throw new Error('Start a managed terminal session first.');
		}

		const query = normalizeTerminalSessionName(requestedName);
		const exact = this.sessions.get(query);
		if (exact) {
			return exact;
		}
		const matches = [...this.sessions.values()].filter(session => session.key.includes(query) || query.includes(session.key));
		if (matches.length === 1) {
			return matches[0];
		}
		throw new Error(`No terminal session matches ${requestedName}.`);
	}

	private requireOpenSession(session: ManagedTerminalSession): void {
		if (session.status === 'closed') {
			throw new Error(`${session.name} is closed.`);
		}
	}

	private sessionResult(session: ManagedTerminalSession, spokenResponse: string): TerminalToolResult {
		return {
			ok: true,
			session: session.name,
			status: session.status,
			command: session.command,
			cwd: session.cwd.fsPath,
			...(session.exitCode === undefined ? {} : { exit_code: session.exitCode }),
			output_tail: terminalOutputTail(session.output),
			location_count: session.locations.length,
			spoken_response: spokenResponse,
		};
	}

	private failure(spokenResponse: string, error: unknown): TerminalToolResult {
		return {
			ok: false,
			spoken_response: spokenResponse,
			error: errorMessage(error),
		};
	}
}

function shortCommand(command: string): string {
	const normalized = command.replace(/\s+/g, ' ').trim();
	return normalized.length <= 100 ? normalized : `${normalized.slice(0, 99)}…`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
