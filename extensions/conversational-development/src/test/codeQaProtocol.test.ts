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
	assert.match(prompt, /across files/);
});

test('parseCodeQaAnswer prefers structured output', () => {
	const answer = parseCodeQaAnswer({
		spoken_response: 'The discount is not bounded.',
		display_response: 'The discount is not bounded in `src/checkout.ts:7`.',
		walkthrough: [{
			title: 'Price calculation',
			narration: 'The percentage is subtracted here without a boundary check.',
			path: './src\\checkout.ts',
			start_line: 6,
			end_line: 7,
			symbol: 'calculateFinalPrice',
		}],
	}, 'ignored');

	assert.deepStrictEqual(answer, {
		spoken_response: 'The discount is not bounded.',
		display_response: 'The discount is not bounded in `src/checkout.ts:7`.',
		walkthrough: [{
			title: 'Price calculation',
			narration: 'The percentage is subtracted here without a boundary check.',
			path: 'src/checkout.ts',
			start_line: 6,
			end_line: 7,
			symbol: 'calculateFinalPrice',
		}],
	});
});

test('parseCodeQaAnswer accepts JSON and plain-text fallbacks', () => {
	assert.deepStrictEqual(parseCodeQaAnswer(undefined, JSON.stringify({
		spoken_response: 'Short answer.',
		display_response: 'Grounded answer at src/example.ts:4.',
		walkthrough: [],
	})), {
		spoken_response: 'Short answer.',
		display_response: 'Grounded answer at src/example.ts:4.',
		walkthrough: [],
	});

	assert.deepStrictEqual(parseCodeQaAnswer(undefined, 'Plain answer.'), {
		spoken_response: 'Plain answer.',
		display_response: 'Plain answer.',
		walkthrough: [],
	});
});

test('parseCodeQaAnswer rejects unsafe and malformed walkthrough locations', () => {
	const answer = parseCodeQaAnswer({
		spoken_response: 'Walk through the implementation.',
		display_response: 'Full answer.',
		walkthrough: [
			{
				title: 'Valid nested implementation',
				narration: 'The request reaches the service here.',
				path: 'src/services/checkout.ts',
				start_line: 10,
				end_line: 14,
			},
			{
				title: 'Outside repository',
				narration: 'This path must not be opened.',
				path: '../secret.ts',
				start_line: 1,
				end_line: 1,
			},
			{
				title: 'Backwards range',
				narration: 'This range is invalid.',
				path: 'src/example.ts',
				start_line: 8,
				end_line: 3,
			},
		],
	}, 'ignored');

	assert.deepStrictEqual(answer?.walkthrough, [{
		title: 'Valid nested implementation',
		narration: 'The request reaches the service here.',
		path: 'src/services/checkout.ts',
		start_line: 10,
		end_line: 14,
	}]);
});
