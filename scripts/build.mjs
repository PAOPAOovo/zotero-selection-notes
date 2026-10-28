import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const addon = path.join(root, 'addon');
const katexDist = path.join(root, 'node_modules', 'katex', 'dist');
const katexTarget = path.join(addon, 'content', 'vendor', 'katex');
const pdfLibDist = path.join(root, 'node_modules', 'pdf-lib', 'dist');
const pdfLibTarget = path.join(addon, 'content', 'vendor', 'pdf-lib');
const buildRoot = path.join(root, 'build');
const distRoot = path.join(root, 'dist');
const stage = path.join(buildRoot, 'zotero-selection-notes');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const xpi = path.join(distRoot, `zotero-selection-notes-${version}.xpi`);

if (!fs.existsSync(path.join(katexDist, 'katex.min.js'))) {
	throw new Error('KaTeX is missing. Run npm install first.');
}
if (!fs.existsSync(path.join(pdfLibDist, 'pdf-lib.min.js'))) {
	throw new Error('pdf-lib is missing. Run npm install first.');
}

fs.rmSync(buildRoot, { recursive: true, force: true });
fs.rmSync(distRoot, { recursive: true, force: true });
fs.mkdirSync(katexTarget, { recursive: true });
fs.copyFileSync(path.join(katexDist, 'katex.min.js'), path.join(katexTarget, 'katex.min.js'));
fs.copyFileSync(path.join(katexDist, 'katex.min.css'), path.join(katexTarget, 'katex.min.css'));
fs.cpSync(path.join(katexDist, 'fonts'), path.join(katexTarget, 'fonts'), { recursive: true });
fs.copyFileSync(path.join(root, 'node_modules', 'katex', 'LICENSE'), path.join(katexTarget, 'LICENSE'));
fs.mkdirSync(pdfLibTarget, { recursive: true });
fs.copyFileSync(path.join(pdfLibDist, 'pdf-lib.min.js'), path.join(pdfLibTarget, 'pdf-lib.min.js'));
fs.copyFileSync(path.join(root, 'node_modules', 'pdf-lib', 'LICENSE.md'), path.join(pdfLibTarget, 'LICENSE.md'));

fs.mkdirSync(stage, { recursive: true });
fs.cpSync(addon, stage, { recursive: true });
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
fs.copyFileSync(path.join(root, 'README.md'), path.join(stage, 'README.md'));

fs.mkdirSync(distRoot, { recursive: true });
execFileSync('/usr/bin/zip', ['-X', '-q', '-r', xpi, '.'], { cwd: stage });
console.log(xpi);
