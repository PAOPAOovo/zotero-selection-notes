/* global Zotero, Services, ChromeUtils */

var ZSN = {
	id: null,
	version: null,
	rootURI: null,
	katex: null,
	PDFLib: null,
	FilePicker: null,
	OS: null,
	styles: ''
};
var PDFLib;

var ZSN_SCRIPTS = ['content/renderer.js', 'content/plugin.js'];

function install() {}

async function startup({ id, version, rootURI }) {
	await Zotero.initializationPromise;
	ZSN.id = id;
	ZSN.version = version;
	ZSN.rootURI = rootURI;
	// Export support is optional. Never let a platform/file-picker problem stop
	// the reader note editor and renderer from starting.
	try {
		ZSN.FilePicker = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs').FilePicker;
		ZSN.OS = ChromeUtils.importESModule('chrome://zotero/content/osfile.mjs').OS;
	}
	catch (e) {
		Zotero.logError(e);
		Zotero.debug('[Selection Notes] Export platform helpers are unavailable');
	}

	// Reader documents do not reliably load a stylesheet linked from a packed
	// bootstrapped XPI. Read the bundled CSS with system privileges and inject it
	// as a <style> element instead. Without this, the editor exists and receives
	// focus, but sits underneath Zotero's absolutely positioned PDF view.
	try {
		let [uiCSS, katexCSS] = await Promise.all([
			Zotero.File.getResourceAsync(rootURI + 'content/styles.css'),
			Zotero.File.getResourceAsync(rootURI + 'content/vendor/katex/katex.min.css')
		]);
		uiCSS = uiCSS.replace(/^\s*@import[^;]+;\s*/, '');
		let fontsURI = rootURI + 'content/vendor/katex/fonts/';
		katexCSS = katexCSS.replace(/url\(fonts\/([^)]*)\)/g, (_match, file) => `url("${fontsURI}${file}")`);
		ZSN.styles = katexCSS + '\n' + uiCSS;
	}
	catch (e) {
		Zotero.logError(e);
		Zotero.debug('[Selection Notes] Could not preload styles; using critical fallback styles');
	}

	// Math rendering is optional at startup. A KaTeX loading problem must not
	// prevent the reader button and editor from loading.
	try {
		// Load the UMD bundle directly into our own scope. Loading it into the
		// bootstrap global is unreliable: depending on the add-on loader, `katex`
		// may be created on a different wrapper and remain invisible here.
		Services.scriptloader.loadSubScript(rootURI + 'content/vendor/katex/katex.min.js', ZSN);
		if (!ZSN.katex || typeof ZSN.katex.render !== 'function') {
			throw new Error('KaTeX did not expose its render API');
		}
	}
	catch (e) {
		Zotero.logError(e);
		Zotero.debug('[Selection Notes] KaTeX failed to load; math will use source fallback');
	}
	try {
		// Load into the same add-on global as plugin.js. pdf-lib performs realm-
		// sensitive Array/Uint8Array checks, so a separate sandbox would reject
		// otherwise valid page dimensions and image bytes.
		Services.scriptloader.loadSubScript(rootURI + 'content/vendor/pdf-lib/pdf-lib.min.js', this);
		ZSN.PDFLib = PDFLib || this.PDFLib;
		if (!ZSN.PDFLib || typeof ZSN.PDFLib.PDFDocument !== 'function') {
			throw new Error('pdf-lib did not expose its API');
		}
	}
	catch (e) {
		Zotero.logError(e);
		Zotero.debug('[Selection Notes] pdf-lib failed to load; rendered PDF appendix export is unavailable');
	}
	for (let script of ZSN_SCRIPTS) Services.scriptloader.loadSubScript(rootURI + script, this);
	await ZSN.plugin.startup();
}

function onMainWindowLoad() {}
function onMainWindowUnload() {}

function shutdown() {
	if (ZSN.plugin) {
		ZSN.plugin.shutdown();
	}
	ZSN = undefined;
}

function uninstall() {}
