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
expect(manifest.version === '1.0.8', 'manifest version must match package version');
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
	'content/vendor/katex/LICENSE'
]) expect(fs.existsSync(path.join(addon, file)), `missing packaged file: ${file}`);

const bootstrap = fs.readFileSync(path.join(addon, 'bootstrap.js'), 'utf8');
for (const file of ['content/renderer.js', 'content/plugin.js']) {
	expect(bootstrap.includes(`'${file}'`), `bootstrap does not load ${file}`);
}
expect(bootstrap.includes("Zotero.File.getResourceAsync(rootURI + 'content/styles.css')"), 'styles must be read from the packed XPI');
expect(bootstrap.includes("Zotero.File.getResourceAsync(rootURI + 'content/vendor/katex/katex.min.css')"), 'KaTeX styles must be read from the packed XPI');
expect(bootstrap.includes("loadSubScript(rootURI + 'content/vendor/katex/katex.min.js', ZSN)"), 'KaTeX must load into the plugin scope');

const plugin = fs.readFileSync(path.join(addon, 'content/plugin.js'), 'utf8');
const styles = fs.readFileSync(path.join(addon, 'content/styles.css'), 'utf8');
expect(!plugin.includes('maybeAutoOpen'), 'selecting text must not automatically open the editor');
expect(plugin.includes('if (focusEditor) setTimeout(() => ui.textarea.focus(), 0)'), 'explicit editor activation must focus the editor');
expect(plugin.includes("button.addEventListener('pointerdown'"), 'selection button must activate before Zotero removes the popup');
expect(plugin.includes("preview.className = 'zsn-annotation-preview zsn-preview'"), 'saved annotation popup must receive a rendered preview');
expect(plugin.includes('ZSN.renderer.render(source, preview)'), 'saved annotation comment must be rendered');
expect(plugin.includes("popup.style.setProperty('--zsn-popup-width'"), 'rendered annotation popup must receive a content-aware width');
expect(plugin.includes("style.textContent = ZSN.styles || CRITICAL_STYLES"), 'reader styles must be injected inline');
expect(!plugin.includes("link.rel = 'stylesheet'"), 'reader UI must not depend on an external XPI stylesheet link');
expect(plugin.includes("textarea.setAttribute('contenteditable', 'true')"), 'textarea must be marked as a Zotero text box');
expect(plugin.includes('e.stopPropagation();'), 'editor keystrokes must not bubble to reader shortcuts');
expect(plugin.includes('doc.defaultView.wrappedJSObject || doc.defaultView'), 'KaTeX must load in the reader compartment');
expect(plugin.includes("loadSubScript(ZSN.rootURI + 'content/vendor/katex/katex.min.js', scope)"), 'reader must receive its own KaTeX instance');
expect(/\.zsn-overlay\s*\{[^}]*pointer-events:\s*none/.test(styles), 'transparent overlay must not block PDF text selection');
expect(/\.annotation-popup\.zsn-rendered\s+\.preview\s*>\s*\.comment\s*\{[^}]*display:\s*none\s*!important/.test(styles), 'native source comment must be hidden when rendered preview is present');
expect(/\.annotation-popup\.zsn-rendered\s*\{[^}]*--zsn-popup-width/.test(styles), 'rendered popup width must adapt to content and viewport');

if (failures.length) {
	console.error(failures.join('\n'));
	process.exit(1);
}
console.log('Static checks passed.');
