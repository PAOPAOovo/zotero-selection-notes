/* Run in Zotero's Run JavaScript window with “Run as async function” enabled:
 * let root = '/absolute/path/to/zotero-selection-notes';
 * Services.scriptloader.loadSubScript('file://' + root + '/scripts/gecko-export-smoke.js');
 * return await Zotero.SelectionNotesExportSmoke(root);
 * This test only reads the current PDF/annotations and writes test outputs in
 * this project's tmp/gecko-export directory. It does not start a second plugin.
 */
Zotero.SelectionNotesExportSmoke = async function (root) {
	const outputDir = root + '/tmp/gecko-export';
	Zotero.SelectionNotesExportSmokeStage = 'loading';
	const scope = new Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), {
		sandboxName: 'Selection Notes export verification', wantGlobalProperties: ['Blob', 'URL']
	});
	Object.assign(scope, { Zotero, Services, XMLSerializer,
		setTimeout: (...args) => setTimeout(...args), clearTimeout: id => clearTimeout(id),
		setInterval: (...args) => setInterval(...args), clearInterval: id => clearInterval(id) });
	Services.scriptloader.loadSubScript('file://' + root + '/addon/content/vendor/pdf-lib/pdf-lib.min.js', scope);
	scope.ZSN = { PDFLib: scope.PDFLib, katex: null };
	Services.scriptloader.loadSubScript('file://' + root + '/addon/content/renderer.js', scope);
	let source = await Zotero.File.getContentsAsync(root + '/addon/content/plugin.js');
	source = source.replace('return { startup, shutdown, buildAnnotationJSON };',
		'return { renderPDFNotePage, appendRenderedNotesToPDF, exportedNotesFor, exportMetadata };');
	Services.scriptloader.loadSubScript('data:application/javascript;charset=utf-8,' + encodeURIComponent(source), scope);
	const api = scope.ZSN.plugin;
	const reader = Zotero.Reader._readers[0];
	if (!reader) throw new Error('Open a PDF reader before running this test');
	const doc = reader._iframeWindow.document;
	const attachment = Zotero.Items.get(reader.itemID);
	const notes = api.exportedNotesFor(attachment);
	const metadata = api.exportMetadata(attachment);
	await Zotero.File.createDirectoryIfMissingAsync(root + '/tmp');
	await Zotero.File.createDirectoryIfMissingAsync(outputDir);
	Zotero.SelectionNotesExportSmokeStage = 'native PDF';
	const inputPath = outputDir + '/annotated.pdf';
	const outputPath = outputDir + '/rendered-notes.pdf';
	await Zotero.PDFWorker.export(attachment.id, inputPath, true);
	Zotero.SelectionNotesExportSmokeStage = 'rendered PDF';
	await api.appendRenderedNotesToPDF({ doc }, inputPath, outputPath, metadata, notes, 'Export verification');
	Zotero.SelectionNotesExportSmokeStage = 'fixtures';
	const fixtures = [
		{ key: 'XML-VOID', page: '1', text: '中文 & < > 引文', source: '# Markdown 检查\n\n中文、**粗体**、A & B。\n\n---\n\n- [x] 已完成\n- [ ] 未完成\n\n```python\nif x < 3 and y > 1:\n    print("中文 & code")\n```' },
		{ key: 'MATHML', page: '2', text: 'Formulas are rendered as page content.', source: '# 数学公式\n\n行内 $E=mc^2$ 与 $\\alpha+\\beta$。\n\n$$\n\\frac{d\\mathrm{DM}}{dt} = \\langle n_e \\rangle v_r\n$$\n\n$$\n\\int_0^\\infty e^{-x^2} \\, dx = \\frac{\\sqrt{\\pi}}{2}\n$$' }
	];
	for (let i = 0; i < fixtures.length; i++) {
		const png = await api.renderPDFNotePage(doc, { title: 'Selection Notes 导出验证', filename: 'test.pdf', authors: '' }, fixtures[i], i, fixtures.length, 'Export verification');
		const binary = doc.defaultView.atob(png.split(',')[1]);
		const bytes = new Uint8Array(binary.length);
		for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
		await Zotero.File.putContentsAsync(outputDir + '/fixture-' + (i + 1) + '.png', new Blob([bytes], { type: 'image/png' }));
	}
	return JSON.stringify({ zotero: Zotero.version, installed: Zotero.SelectionNotes?.version, notes: notes.length, outputPath, fixtures: fixtures.length });
};
