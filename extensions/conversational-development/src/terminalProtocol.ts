/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const TERMINAL_CONTROL_ACTIONS = [
	'list',
	'focus',
	'inspect',
	'interrupt',
	'restart',
	'send_input',
	'open_location',
	'next_location',
	'previous_location',
	'close',
] as const;

export type TerminalControlAction = typeof TERMINAL_CONTROL_ACTIONS[number];

export type TerminalSessionStatus = 'starting' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'closed';

export interface TerminalOutputLocation {
	readonly path: string;
	readonly line: number;
	readonly column: number;
}

const MAX_TERMINAL_OUTPUT_CHARS = 64_000;
const MAX_SPOKEN_OUTPUT_CHARS = 260;

export function normalizeTerminalSessionName(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
}

export function appendTerminalOutput(current: string, chunk: string): string {
	const combined = `${current}${cleanTerminalOutput(chunk)}`;
	return combined.length <= MAX_TERMINAL_OUTPUT_CHARS
		? combined
		: combined.slice(combined.length - MAX_TERMINAL_OUTPUT_CHARS);
}

export function terminalOutputTail(output: string, maximumLines = 30): string {
	return output
		.split('\n')
		.slice(-maximumLines)
		.join('\n')
		.trim();
}

export function terminalOutputExcerpt(output: string): string | undefined {
	const excerpt = output
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean)
		.slice(-3)
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!excerpt) {
		return undefined;
	}
	return excerpt.length <= MAX_SPOKEN_OUTPUT_CHARS
		? excerpt
		: `${excerpt.slice(0, MAX_SPOKEN_OUTPUT_CHARS - 1)}…`;
}

export function findTerminalOutputLocations(output: string): TerminalOutputLocation[] {
	const locations: TerminalOutputLocation[] = [];
	const seen = new Set<string>();
	const patterns = [
		/(?:^|[\s("'`])((?:\/|\.{1,2}\/)?(?:[\w@.+-]+[\\/])*[\w@.+-]+\.[A-Za-z][\w-]*):(\d+)(?::(\d+))?/gm,
		/(?:^|[\s("'`])((?:\/|\.{1,2}\/)?(?:[\w@.+-]+[\\/])*[\w@.+-]+\.[A-Za-z][\w-]*)\((\d+),(\d+)\)/gm,
	];

	for (const pattern of patterns) {
		for (const match of output.matchAll(pattern)) {
			const path = match[1].replace(/\\/g, '/');
			if (path.includes('://')) {
				continue;
			}
			const line = Number.parseInt(match[2], 10);
			const column = match[3] ? Number.parseInt(match[3], 10) : 1;
			if (line < 1 || column < 1) {
				continue;
			}
			const key = `${path}:${line}:${column}`;
			if (!seen.has(key)) {
				seen.add(key);
				locations.push({ path, line, column });
			}
		}
	}
	return locations;
}

function cleanTerminalOutput(value: string): string {
	return value
		.replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
		.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '')
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g, '');
}
