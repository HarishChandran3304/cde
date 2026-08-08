/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendTerminalOutput, findTerminalOutputLocations, normalizeTerminalSessionName, terminalOutputExcerpt, terminalOutputTail } from '../terminalProtocol';

test('normalizes conversational terminal names', () => {
	assert.deepEqual([
		normalizeTerminalSessionName(' API Server '),
		normalizeTerminalSessionName('tests/watch'),
		normalizeTerminalSessionName('Worker_2'),
	], ['api-server', 'tests-watch', 'worker_2']);
});

test('cleans terminal control sequences and keeps a bounded tail', () => {
	const output = appendTerminalOutput('', '\u001b[31mfailed\u001b[0m\r\nsrc/checkout.ts:6:2\rworking');
	assert.deepEqual({
		tail: terminalOutputTail(output, 2),
		excerpt: terminalOutputExcerpt(output),
	}, {
		tail: 'src/checkout.ts:6:2\nworking',
		excerpt: 'failed src/checkout.ts:6:2 working',
	});
});

test('extracts and deduplicates common compiler and stack locations', () => {
	assert.deepEqual(findTerminalOutputLocations(`
src/checkout.ts:6:2 - error TS2322
at calculate (/workspace/src/checkout.ts:6:2)
tests/checkout.test.ts(18,9): assertion failed
src/checkout.ts:6:2
`), [
		{ path: 'src/checkout.ts', line: 6, column: 2 },
		{ path: '/workspace/src/checkout.ts', line: 6, column: 2 },
		{ path: 'tests/checkout.test.ts', line: 18, column: 9 },
	]);
});
