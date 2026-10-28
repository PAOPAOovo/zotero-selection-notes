import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const addon = path.join(root, 'addon');
const manifest = JSON.parse(fs.readFileSync(path.join(addon, 'manifest.json'), 'utf8'));
const failures = [];
const expect = (condition, message) => { if (!condition) failures.push(message); };

expect(manifest.manifest_version === 2, 'manifest_version must be 2');
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
expect(manifest.version === packageVersion, 'manifest version must match package version');
expect(manifest.applications?.zotero?.id === 'selection-notes@local.invalid', 'plugin ID mismatch');
expect(manifest.applications?.zotero?.strict_min_version === '9.0', 'minimum Zotero version must be 9.0');
expect(manifest.applications?.zotero?.strict_max_version === '9.0.*', 'maximum Zotero version must be 9.0.*');
expect(/^https:\/\//.test(manifest.applications?.zotero?.update_url || ''), 'update_url is required by Zotero 9');

for (const file of ['bootstrap.js', 'content/renderer.js', 'content/plugin.js']) {
	try { execFileSync(process.execPath, ['--check', path.join(addon, file)], { stdio: 'pipe' }); }
	catch (error) { failures.push(`${file}: JavaScript syntax check failed\n${error.stderr || error.message}`); }
}

for (const file of [
	'content/styles.css',
	'content/vendor/katex/katex.min.js',
	'content/vendor/katex/katex.min.css',
	'content/vendor/katex/LICENSE',
	'content/vendor/pdf-lib/pdf-lib.min.js',
	'content/vendor/pdf-lib/LICENSE.md'
]) expect(fs.existsSync(path.join(addon, file)), `missing packaged file: ${file}`);

const bootstrap = fs.readFileSync(path.join(addon, 'bootstrap.js'), 'utf8');
for (const file of ['content/renderer.js', 'content/plugin.js']) {
	expect(bootstrap.includes(`'${file}'`), `bootstrap does not load ${file}`);
}
expect(bootstrap.includes("Zotero.File.getResourceAsync(rootURI + 'content/styles.css')"), 'styles must be read from the packed XPI');
expect(bootstrap.includes("Zotero.File.getResourceAsync(rootURI + 'content/vendor/katex/katex.min.css')"), 'KaTeX styles must be read from the packed XPI');
expect(bootstrap.includes("loadSubScript(rootURI + 'content/vendor/katex/katex.min.js', ZSN)"), 'KaTeX must load into the plugin scope');
expect(bootstrap.includes("loadSubScript(rootURI + 'content/vendor/pdf-lib/pdf-lib.min.js', this)"), 'pdf-lib must load into the plugin realm');
expect(bootstrap.includes("chrome://zotero/content/modules/filePicker.mjs"), 'Zotero file picker must be loaded for exports');
expect(bootstrap.includes("chrome://zotero/content/osfile.mjs"), 'Zotero OS.File compatibility helpers must be loaded for exports');
expect(bootstrap.includes('Export support is optional'), 'export helper failures must not prevent core note features from starting');

const plugin = fs.readFileSync(path.join(addon, 'content/plugin.js'), 'utf8');
const styles = fs.readFileSync(path.join(addon, 'content/styles.css'), 'utf8');
expect(!plugin.includes('maybeAutoOpen'), 'selecting text must not automatically open the editor');
expect(plugin.includes('if (focusEditor) setTimeout(() => ui.textarea.focus(), 0)'), 'explicit editor activation must focus the editor');
expect(plugin.includes("button.addEventListener('pointerdown'"), 'selection button must activate before Zotero removes the popup');
expect(plugin.includes("preview.className = 'zsn-annotation-preview zsn-preview'"), 'saved annotation popup must receive a rendered preview');
expect(plugin.includes('ZSN.renderer.render(source, preview)'), 'saved annotation comment must be rendered');
expect(plugin.includes("popup.style.setProperty('--zsn-popup-width'"), 'rendered annotation popup must receive a content-aware width');
expect(plugin.includes("button.className = 'zsn-toolbar-export-button'"), 'reader toolbar must include the export button');
expect(plugin.includes("state.doc.querySelector('.toolbar .end .custom-sections')"), 'already-open readers must receive a fallback export button');
expect(plugin.includes("register('createViewContextMenu', onViewContextMenu)"), 'PDF context menu must expose the export action');
expect(plugin.includes('for (let index = 0; index < items.length; index++)'), 'Zotero annotation arrays must be copied without cross-compartment iterators');
expect(!plugin.includes('attachment.getAnnotations()\n\t\t\t.filter'), 'Zotero annotation arrays must not use chained foreign-realm iteration');
expect(!plugin.includes('new win.Blob'), 'reader-window Blob must not receive add-on arrays across compartments');
expect(plugin.includes("let stage = t('读取带批注 PDF'"), 'rendered PDF export errors must identify their stage');
expect(plugin.includes('Zotero.PDFWorker.export(attachment.id'), 'export must create a PDF with Zotero annotations');
expect(plugin.includes("baseName + '.notes.md'"), 'export must include Markdown notes');
expect(plugin.includes("baseName + '.notes.html'"), 'export must include rendered HTML notes');
expect(plugin.includes("for (let duplicate of container.querySelectorAll('.katex-html')) duplicate.remove()"), 'standalone HTML must preserve self-contained MathML');
expect(plugin.includes('appendRenderedNotesToPDF(state, annotatedPDFPath, renderedPDFPath'), 'export must append rendered note pages to a portable PDF');
expect(plugin.includes('page.setSize(width, height)'), 'rendered notes must become real PDF pages');
expect(plugin.includes("style.textContent = ZSN.styles || CRITICAL_STYLES"), 'reader styles must be injected inline');
expect(!plugin.includes("link.rel = 'stylesheet'"), 'reader UI must not depend on an external XPI stylesheet link');
expect(plugin.includes("textarea.setAttribute('contenteditable', 'true')"), 'textarea must be marked as a Zotero text box');
expect(plugin.includes('e.stopPropagation();'), 'editor keystrokes must not bubble to reader shortcuts');
expect(plugin.includes('doc.defaultView.wrappedJSObject || doc.defaultView'), 'KaTeX must load in the reader compartment');
expect(plugin.includes("loadSubScript(ZSN.rootURI + 'content/vendor/katex/katex.min.js', scope)"), 'reader must receive its own KaTeX instance');
expect(/\.zsn-overlay\s*\{[^}]*pointer-events:\s*none/.test(styles), 'transparent overlay must not block PDF text selection');
expect(/\.annotation-popup\.zsn-rendered\s+\.preview\s*>\s*\.comment\s*\{[^}]*display:\s*none\s*!important/.test(styles), 'native source comment must be hidden when rendered preview is present');
expect(/\.annotation-popup\.zsn-rendered\s*\{[^}]*--zsn-popup-width/.test(styles), 'rendered popup width must adapt to content and viewport');
expect(/\.zsn-toolbar-export-button\s*\{/.test(styles), 'export toolbar button must be styled');

if (failures.length) {
	console.error(failures.join('\n'));
	process.exit(1);
}
console.log('Static checks passed.');
