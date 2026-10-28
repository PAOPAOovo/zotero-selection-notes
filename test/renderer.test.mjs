import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'addon/content/renderer.js'), 'utf8');
const katexSource = fs.readFileSync(path.join(root, 'addon/content/vendor/katex/katex.min.js'), 'utf8');
const context = { ZSN: { katex: null }, URL };
vm.createContext(context);
vm.runInContext(source, context);

test('safeURL accepts web and Zotero links', () => {
	assert.equal(context.ZSN.renderer.safeURL('https://zotero.org/'), 'https://zotero.org/');
	assert.equal(context.ZSN.renderer.safeURL('zotero://open-pdf/library/items/ABC'), 'zotero://open-pdf/library/items/ABC');
});

test('safeURL rejects executable and data URLs', () => {
	assert.equal(context.ZSN.renderer.safeURL('javascript:alert(1)'), null);
	assert.equal(context.ZSN.renderer.safeURL('data:text/html,boom'), null);
});

test('renderer source avoids HTML injection sinks', () => {
	assert.equal(/innerHTML\s*=/.test(source), false);
	assert.equal(/insertAdjacentHTML/.test(source), false);
});

test('bundled KaTeX exposes its API and renders inline math', () => {
	const katexScope = {};
	vm.createContext(katexScope);
	vm.runInContext(katexSource, katexScope);
	assert.equal(typeof katexScope.katex?.render, 'function');
	assert.match(katexScope.katex.renderToString('E=mc^2'), /katex-mathml/);
});
