/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankFileCandidates, rankSymbolCandidates, symbolSearchQueries } from '../navigationRanking';

const files = [
	{ path: 'README.md' },
	{ path: 'src/cart/cart-summary.ts' },
	{ path: 'src/checkout.ts' },
	{ path: 'src/orders/order-draft.ts' },
	{ path: 'src/promotions/discount-preview.ts' },
];

test('ranks exact paths, filenames, and spoken file names', () => {
	assert.equal(rankFileCandidates(files, 'src/checkout.ts')?.path, 'src/checkout.ts');
	assert.equal(rankFileCandidates(files, 'checkout.ts')?.path, 'src/checkout.ts');
	assert.equal(rankFileCandidates(files, 'open the checkout service')?.path, 'src/checkout.ts');
	assert.equal(rankFileCandidates(files, 'the cart summary')?.path, 'src/cart/cart-summary.ts');
	assert.equal(rankFileCandidates(files, 'order draft')?.path, 'src/orders/order-draft.ts');
});

test('uses stable lexical ordering for equally ranked files', () => {
	const candidates = [{ path: 'src/zeta/index.ts' }, { path: 'src/alpha/index.ts' }];
	assert.equal(rankFileCandidates(candidates, 'index')?.path, 'src/alpha/index.ts');
});

test('rejects unrelated file queries', () => {
	assert.equal(rankFileCandidates(files, 'payments ledger'), undefined);
});

test('ranks symbols after normalizing provider labels and spoken camel case', () => {
	const symbols = [
		{ name: 'checkout()', path: 'src/checkout.ts' },
		{ name: 'calculateFinalPrice()', path: 'src/checkout.ts' },
		{ name: 'createOrderDraft()', path: 'src/orders/order-draft.ts' },
	];
	assert.equal(rankSymbolCandidates(symbols, 'calculate final price')?.name, 'calculateFinalPrice()');
	assert.equal(rankSymbolCandidates(symbols, 'where is create order draft defined')?.name, 'createOrderDraft()');
});

test('uses an optional file hint to disambiguate symbols', () => {
	const symbols = [
		{ name: 'build()', path: 'src/cart/cart-summary.ts' },
		{ name: 'build()', path: 'src/orders/order-draft.ts' },
	];
	assert.equal(rankSymbolCandidates(symbols, 'build', 'order draft')?.path, 'src/orders/order-draft.ts');
});

test('builds compact provider queries from natural speech', () => {
	assert.deepEqual(symbolSearchQueries('Where is calculate final price defined?'), [
		'Where is calculate final price defined?',
		'calculateFinalPrice',
		'CalculateFinalPrice',
		'calculatefinalprice',
	]);
});
