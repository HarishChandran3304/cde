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
	readonly walkthrough: readonly CodeQaWalkthroughStep[];
}

export interface CodeQaWalkthroughStep {
	readonly title: string;
	readonly narration: string;
	readonly path: string;
	readonly start_line: number;
	readonly end_line: number;
	readonly symbol?: string;
}

const MAX_SELECTION_CHARS = 6_000;
const MAX_SPOKEN_CHARS = 600;
const MAX_DISPLAY_CHARS = 4_000;
const MAX_WALKTHROUGH_STEPS = 5;
const MAX_WALKTHROUGH_TITLE_CHARS = 100;
const MAX_WALKTHROUGH_NARRATION_CHARS = 600;
const MAX_WALKTHROUGH_SYMBOL_CHARS = 200;

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
		walkthrough: {
			type: 'array',
			description: 'An ordered code walkthrough synchronized with the voice answer. Use an empty array only when no repository location supports the answer.',
			maxItems: MAX_WALKTHROUGH_STEPS,
			items: {
				type: 'object',
				properties: {
					title: {
						type: 'string',
						description: 'A short label for this location, such as Request boundary or Price calculation.',
					},
					narration: {
						type: 'string',
						description: 'One or two short sentences to speak while this location is visible. Do not read the file path aloud.',
					},
					path: {
						type: 'string',
						description: 'The exact repository-relative file path.',
					},
					start_line: {
						type: 'integer',
						minimum: 1,
						description: 'The first one-based line to highlight.',
					},
					end_line: {
						type: 'integer',
						minimum: 1,
						description: 'The last one-based line to highlight.',
					},
					symbol: {
						type: 'string',
						description: 'The source identifier visible at this location when one exists.',
					},
				},
				required: ['title', 'narration', 'path', 'start_line', 'end_line'],
				additionalProperties: false,
			},
		},
	},
	required: ['spoken_response', 'display_response', 'walkthrough'],
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

Ground the answer in the repository, not assumptions. Prefer the live selection when the question says "this", "it", or "here". In display_response, cite every important claim as repository-relative path:line. Keep spoken_response natural and at most 45 words.

Build walkthrough as an intentional explanation path through the most important evidence. Use up to five steps. Each step must identify an exact existing file and tight line range, then narrate only what that location establishes. Follow call flow, data flow, and abstraction boundaries across files when the implementation is nested—for example request handler, service, helper, persistence, and regression test. Do not list loosely related search results or repeat the same location without a reason. Keep each narration to one or two short sentences. If the repository does not establish the answer, say what you could not verify and return only the locations that are genuinely useful.`;
}

export function parseCodeQaAnswer(structuredOutput: unknown, fallback: string): CodeQaAnswer | undefined {
	if (isRecord(structuredOutput)
		&& typeof structuredOutput.spoken_response === 'string'
		&& typeof structuredOutput.display_response === 'string') {
		return normalizeAnswer(structuredOutput.spoken_response, structuredOutput.display_response, structuredOutput.walkthrough);
	}

	try {
		const parsed = JSON.parse(fallback) as unknown;
		if (isRecord(parsed)
			&& typeof parsed.spoken_response === 'string'
			&& typeof parsed.display_response === 'string') {
			return normalizeAnswer(parsed.spoken_response, parsed.display_response, parsed.walkthrough);
		}
	} catch {
		// The SDK normally returns structured_output. Treat plain text as a usable fallback.
	}

	const plainText = fallback.trim();
	if (!plainText) {
		return undefined;
	}
	return normalizeAnswer(plainText, plainText, []);
}

function normalizeAnswer(spokenResponse: string, displayResponse: string, walkthroughValue: unknown): CodeQaAnswer | undefined {
	const spoken = truncate(spokenResponse.trim(), MAX_SPOKEN_CHARS);
	const display = truncate(displayResponse.trim(), MAX_DISPLAY_CHARS);
	if (!spoken || !display) {
		return undefined;
	}
	return {
		spoken_response: spoken,
		display_response: display,
		walkthrough: normalizeWalkthrough(walkthroughValue),
	};
}

function normalizeWalkthrough(value: unknown): CodeQaWalkthroughStep[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const steps: CodeQaWalkthroughStep[] = [];
	for (const candidate of value.slice(0, MAX_WALKTHROUGH_STEPS)) {
		if (!isRecord(candidate)
			|| typeof candidate.title !== 'string'
			|| typeof candidate.narration !== 'string'
			|| typeof candidate.path !== 'string'
			|| !Number.isInteger(candidate.start_line)
			|| !Number.isInteger(candidate.end_line)) {
			continue;
		}

		const title = truncate(candidate.title.trim(), MAX_WALKTHROUGH_TITLE_CHARS);
		const narration = truncate(candidate.narration.trim(), MAX_WALKTHROUGH_NARRATION_CHARS);
		const path = normalizeRepositoryPath(candidate.path);
		const startLine = candidate.start_line as number;
		const endLine = candidate.end_line as number;
		if (!title || !narration || !path || startLine < 1 || endLine < startLine) {
			continue;
		}

		const symbol = typeof candidate.symbol === 'string'
			? truncate(candidate.symbol.trim(), MAX_WALKTHROUGH_SYMBOL_CHARS) || undefined
			: undefined;
		steps.push({
			title,
			narration,
			path,
			start_line: startLine,
			end_line: endLine,
			...(symbol ? { symbol } : {}),
		});
	}
	return steps;
}

function normalizeRepositoryPath(value: string): string | undefined {
	const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
	if (!normalized || normalized.startsWith('/') || normalized.split('/').some(segment => segment === '..')) {
		return undefined;
	}
	return normalized;
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
