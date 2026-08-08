/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface FileCandidate {
	readonly path: string;
}

export interface SymbolCandidate extends FileCandidate {
	readonly name: string;
}

const SEARCH_FILLER_WORDS = new Set([
	'a',
	'an',
	'called',
	'class',
	'code',
	'defined',
	'definition',
	'file',
	'find',
	'function',
	'go',
	'implementation',
	'is',
	'jump',
	'logic',
	'me',
	'method',
	'named',
	'navigate',
	'of',
	'open',
	'please',
	'service',
	'show',
	'source',
	'symbol',
	'take',
	'the',
	'to',
	'where',
	'with',
]);

const MIN_FILE_SCORE = 350;
const MIN_SYMBOL_SCORE = 400;

function words(value: string): string[] {
	return value
		.replace(/([a-z\d])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.toLowerCase()
		.split(/[^a-z\d]+/)
		.filter(Boolean);
}

function queryWords(value: string): string[] {
	const allWords = words(value);
	const meaningfulWords = allWords.filter(word => !SEARCH_FILLER_WORDS.has(word));
	return meaningfulWords.length > 0 ? meaningfulWords : allWords;
}

function compact(value: string): string {
	return words(value).join('');
}

function compactQuery(value: string): string {
	return queryWords(value).join('');
}

function basename(path: string): string {
	return path.replace(/\\/g, '/').split('/').at(-1) ?? path;
}

function stem(path: string): string {
	const name = basename(path);
	const extensionStart = name.lastIndexOf('.');
	return extensionStart > 0 ? name.slice(0, extensionStart) : name;
}

function matchedWordCount(candidate: string, query: readonly string[]): number {
	const candidateWords = new Set(words(candidate));
	const candidateCompact = compact(candidate);
	return query.filter(word => candidateWords.has(word) || candidateCompact.includes(word)).length;
}

function scoreFilePath(path: string, query: string): number {
	const relevantQueryWords = queryWords(query);
	const queryCompact = compactQuery(query);
	if (relevantQueryWords.length === 0 || queryCompact.length === 0) {
		return 0;
	}

	const normalizedPath = path.replace(/\\/g, '/');
	const pathCompact = compact(normalizedPath);
	const name = basename(normalizedPath);
	const nameCompact = compact(name);
	const fileStem = stem(name);
	const stemCompact = compact(fileStem);
	let score = 0;

	if (pathCompact === queryCompact) {
		score += 1_400;
	}
	if (nameCompact === queryCompact) {
		score += 1_300;
	}
	if (stemCompact === queryCompact) {
		score += 1_250;
	}
	if (pathCompact.endsWith(queryCompact)) {
		score += 500;
	}
	if (stemCompact.includes(queryCompact) || queryCompact.includes(stemCompact)) {
		score += 400;
	}

	const pathMatches = matchedWordCount(normalizedPath, relevantQueryWords);
	const stemMatches = matchedWordCount(fileStem, relevantQueryWords);
	score += pathMatches * 45;
	score += stemMatches * 100;
	if (pathMatches === relevantQueryWords.length) {
		score += 300;
	}
	if (stemMatches === relevantQueryWords.length) {
		score += 350;
	}

	return score;
}

function scoreSymbol(candidate: SymbolCandidate, query: string, fileQuery?: string): number {
	const relevantQueryWords = queryWords(query);
	const queryCompact = compactQuery(query);
	if (relevantQueryWords.length === 0 || queryCompact.length === 0) {
		return 0;
	}

	const nameCompact = compact(candidate.name);
	let score = 0;
	if (candidate.name === query) {
		score += 1_600;
	}
	if (candidate.name.toLowerCase() === query.toLowerCase()) {
		score += 1_500;
	}
	if (nameCompact === queryCompact) {
		score += 1_400;
	}
	if (nameCompact.endsWith(queryCompact)) {
		score += 650;
	}
	if (nameCompact.includes(queryCompact) || queryCompact.includes(nameCompact)) {
		score += 500;
	}

	const nameMatches = matchedWordCount(candidate.name, relevantQueryWords);
	score += nameMatches * 120;
	if (nameMatches === relevantQueryWords.length) {
		score += 400;
	}

	if (fileQuery) {
		const fileScore = scoreFilePath(candidate.path, fileQuery);
		if (fileScore >= MIN_FILE_SCORE) {
			score += Math.min(700, Math.round(fileScore / 3));
		}
	}

	return score;
}

function highestRanked<T>(candidates: readonly T[], score: (candidate: T) => number, minimumScore: number, path: (candidate: T) => string): T | undefined {
	return candidates
		.map(candidate => ({ candidate, score: score(candidate) }))
		.filter(candidate => candidate.score >= minimumScore)
		.sort((left, right) => right.score - left.score || path(left.candidate).localeCompare(path(right.candidate)))[0]?.candidate;
}

export function rankFileCandidates<T extends FileCandidate>(candidates: readonly T[], query: string): T | undefined {
	return highestRanked(candidates, candidate => scoreFilePath(candidate.path, query), MIN_FILE_SCORE, candidate => candidate.path);
}

export function rankSymbolCandidates<T extends SymbolCandidate>(candidates: readonly T[], query: string, fileQuery?: string): T | undefined {
	return highestRanked(candidates, candidate => scoreSymbol(candidate, query, fileQuery), MIN_SYMBOL_SCORE, candidate => `${candidate.path}:${candidate.name}`);
}

export function symbolSearchQueries(query: string): string[] {
	const relevantWords = queryWords(query);
	if (relevantWords.length === 0) {
		return [];
	}

	const camelCase = relevantWords[0] + relevantWords.slice(1).map(word => word[0].toUpperCase() + word.slice(1)).join('');
	const pascalCase = relevantWords.map(word => word[0].toUpperCase() + word.slice(1)).join('');
	return [...new Set([
		query.trim().replace(/^[`'\"]|[`'\"]$/g, ''),
		camelCase,
		pascalCase,
		relevantWords.join(''),
	])].filter(Boolean);
}
