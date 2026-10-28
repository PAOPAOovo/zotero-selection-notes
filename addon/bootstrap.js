/* global Zotero, Services */

var ZSN = {
	id: null,
	version: null,
	rootURI: null,
	katex: null,
	styles: ''
};

var ZSN_SCRIPTS = ['content/renderer.js', 'content/plugin.js'];

function install() {}

async function startup({ id, version, rootURI }) {
	await Zotero.initializationPromise;
	ZSN.id = id;
	ZSN.version = version;
	ZSN.rootURI = rootURI;

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
