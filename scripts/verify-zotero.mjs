import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = '/Applications/Zotero.app';
const ini = path.join(app, 'Contents/Resources/app/application.ini');
const omni = path.join(app, 'Contents/Resources/app/omni.ja');
if (!fs.existsSync(ini) || !fs.existsSync(omni)) throw new Error('Zotero.app was not found in /Applications.');

const applicationIni = fs.readFileSync(ini, 'utf8');
const version = /^Version=(.+)$/m.exec(applicationIni)?.[1];
if (!version?.startsWith('9.0.')) throw new Error(`Expected Zotero 9.0.x, found ${version || 'unknown'}.`);

const xpcomReader = execFileSync('/usr/bin/unzip', ['-p', omni, 'chrome/content/zotero/xpcom/reader.js'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const annotations = execFileSync('/usr/bin/unzip', ['-p', omni, 'chrome/content/zotero/xpcom/annotations.js'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const fileAPI = execFileSync('/usr/bin/unzip', ['-p', omni, 'chrome/content/zotero/xpcom/file.js'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const readerUI = execFileSync('/usr/bin/unzip', ['-p', omni, 'resource/reader/reader.js'], { encoding: 'utf8', maxBuffer: 12 * 1024 * 1024 });

const checks = [
	['Zotero.Reader.registerEventListener', xpcomReader.includes('registerEventListener(type, handler')],
	['renderTextSelectionPopup', xpcomReader.includes('renderTextSelectionPopup')],
	['renderToolbar', xpcomReader.includes('renderToolbar')],
	['createAnnotationContextMenu', xpcomReader.includes('createAnnotationContextMenu')],
	['Zotero.Annotations.saveFromJSON', annotations.includes('this.saveFromJSON = async function')],
	['Zotero.File.getResourceAsync', fileAPI.includes('this.getResourceAsync = function')],
	['annotationComment', annotations.includes('item.annotationComment = json.comment')],
	['Reader annotation popup', readerUI.includes('className: "annotation-popup"')],
	['Reader selection popup state', readerUI.includes('primaryViewSelectionPopup') && readerUI.includes('secondaryViewSelectionPopup')],
	['selectedAnnotationIDs state', readerUI.includes('selectedAnnotationIDs')]
];
const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'OK' : 'MISSING'} ${name}`);
if (failed.length) process.exit(1);

const xpi = path.join(root, 'dist', 'zotero-selection-notes-1.0.8.xpi');
if (!fs.existsSync(xpi)) throw new Error('Build the XPI first.');
const entries = execFileSync('/usr/bin/unzip', ['-Z1', xpi], { encoding: 'utf8' }).trim().split('\n');
for (const required of ['manifest.json', 'bootstrap.js', 'content/plugin.js', 'content/renderer.js', 'content/vendor/katex/katex.min.js']) {
	if (!entries.includes(required)) throw new Error(`XPI is missing ${required}`);
}
console.log(`Verified against local Zotero ${version}; XPI has ${entries.length} entries.`);
