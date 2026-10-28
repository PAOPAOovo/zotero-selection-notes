import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const addon = path.join(root, 'addon');
const katexDist = path.join(root, 'node_modules', 'katex', 'dist');
const katexTarget = path.join(addon, 'content', 'vendor', 'katex');
const buildRoot = path.join(root, 'build');
const distRoot = path.join(root, 'dist');
const stage = path.join(buildRoot, 'zotero-selection-notes');
const xpi = path.join(distRoot, 'zotero-selection-notes-1.0.8.xpi');

if (!fs.existsSync(path.join(katexDist, 'katex.min.js'))) {
	throw new Error('KaTeX is missing. Run npm install first.');
}

fs.rmSync(buildRoot, { recursive: true, force: true });
fs.rmSync(distRoot, { recursive: true, force: true });
fs.mkdirSync(katexTarget, { recursive: true });
fs.copyFileSync(path.join(katexDist, 'katex.min.js'), path.join(katexTarget, 'katex.min.js'));
fs.copyFileSync(path.join(katexDist, 'katex.min.css'), path.join(katexTarget, 'katex.min.css'));
fs.cpSync(path.join(katexDist, 'fonts'), path.join(katexTarget, 'fonts'), { recursive: true });
fs.copyFileSync(path.join(root, 'node_modules', 'katex', 'LICENSE'), path.join(katexTarget, 'LICENSE'));

fs.mkdirSync(stage, { recursive: true });
fs.cpSync(addon, stage, { recursive: true });
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
fs.copyFileSync(path.join(root, 'README.md'), path.join(stage, 'README.md'));

fs.mkdirSync(distRoot, { recursive: true });
execFileSync('/usr/bin/zip', ['-X', '-q', '-r', xpi, '.'], { cwd: stage });
console.log(xpi);
