/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface CodeQaContext {
	readonly question: string;
	readonly activeFile?: string;
	readonly activeLine?: number;
	readonly selection?: string;
	readonly visibleFiles: readonly string[];
}

export interface CodeQaAnswer {
	readonly spoken_response: string;
	readonly display_response: string;
}

const MAX_SELECTION_CHARS = 6_000;
const MAX_SPOKEN_CHARS = 600;
const MAX_DISPLAY_CHARS = 4_000;

export const CODE_QA_OUTPUT_SCHEMA = {
	type: 'object',
	properties: {
		spoken_response: {
			type: 'string',
			description: 'A natural voice answer of at most 45 words. Do not read every citation aloud.',
		},
		display_response: {
			type: 'string',
			description: 'A concise grounded answer with repository-relative file:line citations.',
		},
	},
	required: ['spoken_response', 'display_response'],
	additionalProperties: false,
} as const;

export function buildCodeQaPrompt(context: CodeQaContext): string {
	const activeLocation = context.activeFile
		? `${context.activeFile}${context.activeLine ? `:${context.activeLine}` : ''}`
		: 'none';
	const visibleFiles = context.visibleFiles.length > 0 ? context.visibleFiles.join(', ') : 'none';
	const selection = context.selection
		? truncate(context.selection, MAX_SELECTION_CHARS)
		: 'none';

	return `Answer this repository question using the read-only code tools before drawing a conclusion.

Question: ${context.question}

Live editor context:
- Active location: ${activeLocation}
- Visible files: ${visibleFiles}
- Selected code:\n${selection}

Ground the answer in the repository, not assumptions. Prefer the live selection when the question says "this", "it", or "here". In display_response, cite every important claim as repository-relative path:line. Keep spoken_response natural and at most 45 words. If the repository does not establish the answer, say what you could not verify.`;
}

export function parseCodeQaAnswer(structuredOutput: unknown, fallback: string): CodeQaAnswer | undefined {
	if (isRecord(structuredOutput)
		&& typeof structuredOutput.spoken_response === 'string'
		&& typeof structuredOutput.display_response === 'string') {
		return normalizeAnswer(structuredOutput.spoken_response, structuredOutput.display_response);
	}

	try {
		const parsed = JSON.parse(fallback) as unknown;
		if (isRecord(parsed)
			&& typeof parsed.spoken_response === 'string'
			&& typeof parsed.display_response === 'string') {
			return normalizeAnswer(parsed.spoken_response, parsed.display_response);
		}
	} catch {
		// The SDK normally returns structured_output. Treat plain text as a usable fallback.
	}

	const plainText = fallback.trim();
	if (!plainText) {
		return undefined;
	}
	return normalizeAnswer(plainText, plainText);
}

function normalizeAnswer(spokenResponse: string, displayResponse: string): CodeQaAnswer | undefined {
	const spoken = truncate(spokenResponse.trim(), MAX_SPOKEN_CHARS);
	const display = truncate(displayResponse.trim(), MAX_DISPLAY_CHARS);
	if (!spoken || !display) {
		return undefined;
	}
	return { spoken_response: spoken, display_response: display };
}

function truncate(value: string, maximumLength: number): string {
	if (value.length <= maximumLength) {
		return value;
	}
	return `${value.slice(0, maximumLength - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
