/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { test } from 'node:test';
import { buildCodeQaPrompt, parseCodeQaAnswer } from '../codeQaProtocol';

test('buildCodeQaPrompt includes live editor context and the repository question', () => {
	const prompt = buildCodeQaPrompt({
		question: 'Why can this become negative?',
		activeFile: 'src/checkout.ts',
		activeLine: 7,
		selection: 'return subtotal - discount;',
		visibleFiles: ['src/checkout.ts', 'src/cart.ts'],
	});

	assert.match(prompt, /Why can this become negative\?/);
	assert.match(prompt, /src\/checkout\.ts:7/);
	assert.match(prompt, /return subtotal - discount/);
	assert.match(prompt, /repository-relative path:line/);
});

test('parseCodeQaAnswer prefers structured output', () => {
	const answer = parseCodeQaAnswer({
		spoken_response: 'The discount is not bounded.',
		display_response: 'The discount is not bounded in `src/checkout.ts:7`.',
	}, 'ignored');

	assert.deepStrictEqual(answer, {
		spoken_response: 'The discount is not bounded.',
		display_response: 'The discount is not bounded in `src/checkout.ts:7`.',
	});
});

test('parseCodeQaAnswer accepts JSON and plain-text fallbacks', () => {
	assert.deepStrictEqual(parseCodeQaAnswer(undefined, JSON.stringify({
		spoken_response: 'Short answer.',
		display_response: 'Grounded answer at src/example.ts:4.',
	})), {
		spoken_response: 'Short answer.',
		display_response: 'Grounded answer at src/example.ts:4.',
	});

	assert.deepStrictEqual(parseCodeQaAnswer(undefined, 'Plain answer.'), {
		spoken_response: 'Plain answer.',
		display_response: 'Plain answer.',
	});
});
