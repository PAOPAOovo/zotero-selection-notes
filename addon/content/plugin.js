/* global Zotero, Services, ZSN, Blob, XMLSerializer, Uint8Array, setTimeout, clearTimeout, setInterval, clearInterval */

ZSN.plugin = (function () {
	const events = [];
	const states = new Set();
	const stateByDoc = new WeakMap();
	let zh = true;
	let readerScanTimer = null;

	const t = (cn, en) => zh ? cn : en;
	const log = message => Zotero.debug('[Selection Notes] ' + message);
	const report = error => {
		Zotero.logError(error);
		log(String(error));
	};
	const CRITICAL_STYLES = `
		.zsn-toolbar-export-button { display: flex; align-items: center; height: 28px; padding: 0 9px; border-radius: 6px; font: 600 12px sans-serif; cursor: pointer; }
		.zsn-overlay { position: fixed; inset: 0; z-index: 2147483600; pointer-events: none; }
		.zsn-card { position: absolute; display: flex; flex-direction: column; overflow: hidden;
			max-height: calc(100vh - 28px); border: 1px solid rgba(0,0,0,.18); border-radius: 12px;
			background: #fff; color: #222; box-shadow: 0 14px 44px rgba(0,0,0,.32); pointer-events: auto; }
		.zsn-header, .zsn-footer { display: flex; align-items: center; gap: 8px; padding: 9px 11px; }
		.zsn-title, .zsn-hint { flex: 1; } .zsn-body { min-height: 290px; display: grid; grid-template-columns: 1fr 1fr; }
		.zsn-pane { min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
		.zsn-editor { box-sizing: border-box; flex: 1; min-height: 330px; width: 100%; padding: 12px; }
		.zsn-preview { box-sizing: border-box; flex: 1; overflow: auto; padding: 12px 15px; }
		.annotation-popup.zsn-rendered { width: min(var(--zsn-popup-width, 440px), calc(100vw - 40px)); min-width: min(320px, calc(100vw - 40px)); }
		.annotation-popup.zsn-rendered .preview > .comment { display: none !important; }
		.zsn-annotation-preview { box-sizing: border-box; width: 100%; max-width: none; max-height: 280px; overflow: auto; padding: 8px 10px; }
	`;

	function plain(value) {
		return JSON.parse(JSON.stringify(value));
	}

	function register(type, handler) {
		Zotero.Reader.registerEventListener(type, handler, ZSN.id);
		events.push([type, handler]);
		// Zotero 9 dispatches listeners in insertion order and does not isolate
		// exceptions from other plugins. Since this add-on may be installed after
		// several selection-popup plugins, move our defensive handlers to the
		// front so an unrelated failure cannot prevent them from running.
		try {
			let listeners = Zotero.Reader._registeredListeners;
			let index = listeners.findLastIndex(x => x.pluginID === ZSN.id && x.type === type && x.handler === handler);
			if (index > 0) listeners.unshift(listeners.splice(index, 1)[0]);
		}
		catch (e) {
			log('could not prioritize reader listener ' + type + ': ' + e);
		}
	}

	function ensureStyles(doc) {
		if (!doc || !doc.head || doc.getElementById('zsn-styles')) return;
		let style = doc.createElement('style');
		style.id = 'zsn-styles';
		style.textContent = ZSN.styles || CRITICAL_STYLES;
		doc.head.appendChild(style);
	}

	function ensureReaderKaTeX(doc) {
		try {
			// Zotero's reader document is in a different JS compartment. A KaTeX
			// function created in the bootstrap compartment cannot safely manipulate
			// its DOM nodes. Load the same bundled script into the reader's unwrapped
			// window so KaTeX and its target elements share one compartment.
			let scope = doc.defaultView && (doc.defaultView.wrappedJSObject || doc.defaultView);
			if (!scope) return null;
			if (!scope.katex || typeof scope.katex.render !== 'function') {
				Services.scriptloader.loadSubScript(ZSN.rootURI + 'content/vendor/katex/katex.min.js', scope);
			}
			return scope.katex && typeof scope.katex.render === 'function' ? scope.katex : null;
		}
		catch (e) {
			report(e);
			return null;
		}
	}

	function setupDocument(doc, reader) {
		if (!doc || !doc.body) return null;
		ensureStyles(doc);
		let readerKaTeX = ensureReaderKaTeX(doc);
		let state = stateByDoc.get(doc);
		if (state) {
			state.reader = reader || state.reader;
			state.katex = readerKaTeX || state.katex;
			// The reader scan also acts as a low-frequency fallback in case React
			// updates its selection state just after the popup DOM is inserted.
			decoratePopups(state);
			return state;
		}
		state = { doc, reader, katex: readerKaTeX, observer: null, card: null, renderTimer: null, exporting: false };
		state.observer = new doc.defaultView.MutationObserver(() => decoratePopups(state));
		state.observer.observe(doc.body, { childList: true, subtree: true });
		stateByDoc.set(doc, state);
		states.add(state);
		decoratePopups(state);
		return state;
	}

	function decoratePopups(state) {
		decorateSelectionPopups(state);
		decorateAnnotationPopups(state);
		decorateToolbarButtons(state);
	}

	function selectionPopupAnnotation(reader) {
		try {
			let internalState = reader && reader._internalReader && reader._internalReader._state;
			let popup = internalState && (internalState.primaryViewSelectionPopup || internalState.secondaryViewSelectionPopup);
			return popup && popup.annotation ? plain(popup.annotation) : null;
		}
		catch (e) {
			return null;
		}
	}

	function makeSelectionContext(annotation) {
		return {
			mode: 'new',
			selection: plain(annotation),
			text: String(annotation.text || ''),
			key: null
		};
	}

	function bindSelectionButton(state, button) {
		if (button._zsnBound) return;
		button._zsnBound = true;
		let activate = event => {
			try {
				event.preventDefault();
				event.stopPropagation();
				if (event.stopImmediatePropagation) event.stopImmediatePropagation();
				if (button._zsnContext) openCard(state, button._zsnContext, button, true);
			}
			catch (e) {
				report(e);
				toast(state.doc, t('打开编辑器失败：', 'Could not open editor: ') + String(e));
			}
		};
		// Zotero may remove/re-render the selection popup between pointerdown and
		// click. Activate on pointerdown while the final DOM node is still alive.
		button.addEventListener('pointerdown', event => {
			if (typeof event.button === 'number' && event.button !== 0) return;
			button._zsnLastPointerActivation = Date.now();
			activate(event);
		}, true);
		// Keep keyboard activation working without opening twice after a pointer.
		button.addEventListener('click', event => {
			if (Date.now() - (button._zsnLastPointerActivation || 0) < 700) {
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			activate(event);
		}, true);
	}

	function decorateSelectionPopups(state) {
		let annotation = selectionPopupAnnotation(state.reader);
		if (!annotation || !String(annotation.text || '').trim()) return;
		for (let popup of state.doc.querySelectorAll('.selection-popup')) {
			let button = popup.querySelector('.zsn-selection-button');
			if (!button) {
				button = state.doc.createElement('button');
				button.type = 'button';
				button.className = 'zsn-selection-button';
				button.textContent = t('📝 写笔记', '📝 Write note');
				button.title = t('打开 Markdown / LaTeX / 代码笔记编辑器', 'Open Markdown / LaTeX / code note editor');
				popup.appendChild(button);
			}
			button._zsnContext = makeSelectionContext(annotation);
			bindSelectionButton(state, button);
		}
	}

	function selectedAnnotationID(reader) {
		try {
			let ids = reader && reader._internalReader && reader._internalReader._state
				&& reader._internalReader._state.selectedAnnotationIDs;
			return ids && ids.length === 1 ? String(ids[0]) : null;
		}
		catch (e) {
			return null;
		}
	}

	function preferredAnnotationPopupWidth(source) {
		let text = String(source || '');
		let longestLine = text.split(/\r?\n/).reduce((longest, line) => {
			let units = [...line].reduce((total, character) =>
				total + (/[^\u0000-\u00ff]/.test(character) ? 2 : 1), 0);
			return Math.max(longest, units);
		}, 0);
		// A short note remains compact. Longer paragraphs and wide formulas/code
		// receive more room, with a ceiling so the popup never dominates the PDF.
		let byLength = 260 + Math.sqrt(text.length) * 18;
		let byLine = 120 + longestLine * 7;
		return Math.round(Math.max(320, Math.min(620, Math.max(byLength, byLine))));
	}

	function decorateAnnotationPopups(state) {
		let id = selectedAnnotationID(state.reader);
		for (let popup of state.doc.querySelectorAll('.annotation-popup')) {
			let source = '';
			if (id) {
				try {
					source = String(annotationFor(state.reader, id).annotationComment || '');
				}
				catch (e) {
					log('could not load annotation preview: ' + e);
				}
			}

			let preview = popup.querySelector('.zsn-annotation-preview');
			if (source.trim()) {
				popup.style.setProperty('--zsn-popup-width', preferredAnnotationPopupWidth(source) + 'px');
				if (!preview) {
					preview = state.doc.createElement('div');
					preview.className = 'zsn-annotation-preview zsn-preview';
					preview.setAttribute('aria-label', t('渲染后的笔记', 'Rendered note'));
					let nativeComment = popup.querySelector('.preview > .comment');
					let nativePreview = popup.querySelector('.preview');
					if (nativeComment) nativeComment.before(preview);
					else if (nativePreview) nativePreview.appendChild(preview);
					else popup.prepend(preview);
				}
				if (preview._zsnSource !== source) {
					preview._zsnSource = source;
					ZSN.renderer.render(source, preview);
				}
				popup.classList.add('zsn-rendered');
			}
			else {
				if (preview) preview.remove();
				popup.classList.remove('zsn-rendered');
				popup.style.removeProperty('--zsn-popup-width');
			}

			let button = popup.querySelector('.zsn-detail-button');
			if (!button) {
				button = state.doc.createElement('button');
				button.type = 'button';
				button.className = 'zsn-detail-button';
				button.textContent = t('📝 笔记详情 / 编辑', '📝 Note details / edit');
				button.addEventListener('click', event => {
					event.preventDefault();
					event.stopPropagation();
					let key = button.dataset.annotationId || selectedAnnotationID(state.reader);
					if (key) openExisting(state.doc, state.reader, key, button).catch(report);
				});
				popup.appendChild(button);
			}
			if (id) button.dataset.annotationId = id;
		}
	}

	function attachmentFor(reader) {
		let item = reader && reader.itemID ? Zotero.Items.get(reader.itemID) : null;
		if (!item) throw new Error(t('找不到当前 PDF 附件', 'Current PDF attachment not found'));
		return item;
	}

	function annotationFor(reader, key) {
		let attachment = attachmentFor(reader);
		let item = Zotero.Items.getByLibraryAndKey(attachment.libraryID, key);
		if (!item || !item.isAnnotation() || item.parentID !== attachment.id) {
			throw new Error(t('找不到该批注', 'Annotation not found'));
		}
		return item;
	}

	function onTextSelection(event) {
		try {
			let annotation = event.params && event.params.annotation;
			if (!annotation || !String(annotation.text || '').trim()) return;
			let state = setupDocument(event.doc, event.reader);
			let button = event.doc.createElement('button');
			button.type = 'button';
			button.className = 'zsn-selection-button';
			button.textContent = t('📝 写笔记', '📝 Write note');
			button.title = t('打开 Markdown / LaTeX / 代码笔记编辑器', 'Open Markdown / LaTeX / code note editor');
			let context = makeSelectionContext(annotation);
			button._zsnContext = context;
			bindSelectionButton(state, button);
			event.append(button);
		}
		catch (e) {
			report(e);
		}
	}

	function bindExportButton(state, button) {
		if (button._zsnBound) return;
		button._zsnBound = true;
		button.addEventListener('click', event => {
			event.preventDefault();
			event.stopPropagation();
			exportNoteBundle(state, button).catch(error => {
				report(error);
				toast(state.doc, t('导出失败：', 'Export failed: ') + String(error));
			});
		});
	}

	function makeExportButton(doc) {
		let button = doc.createElement('button');
		button.type = 'button';
		button.className = 'zsn-toolbar-export-button';
		button.textContent = t('⇩ 导出笔记', '⇩ Export notes');
		button.title = t('导出带批注 PDF、渲染附录 PDF、HTML 和 Markdown', 'Export an annotated PDF, rendered-appendix PDF, HTML, and Markdown');
		return button;
	}

	function decorateToolbarButtons(state) {
		let buttons = [...state.doc.querySelectorAll('.zsn-toolbar-export-button')];
		if (!buttons.length) {
			// renderToolbar only fires while React creates the toolbar. When the
			// plugin is enabled with an already-open PDF, insert the same control
			// into the existing custom section; the reader scan keeps it present.
			let host = state.doc.querySelector('.toolbar .end .custom-sections');
			if (host) {
				let section = state.doc.createElement('div');
				section.className = 'section zsn-export-section';
				let button = makeExportButton(state.doc);
				section.appendChild(button);
				host.prepend(section);
				buttons.push(button);
			}
		}
		for (let button of buttons) {
			bindExportButton(state, button);
		}
	}

	function onToolbar(event) {
		try {
			let state = setupDocument(event.doc, event.reader);
			let existing = event.doc.querySelector('.zsn-toolbar-export-button');
			if (existing) {
				bindExportButton(state, existing);
				return;
			}
			let button = makeExportButton(event.doc);
			bindExportButton(state, button);
			event.append(button);
		}
		catch (e) { report(e); }
	}

	function onAnnotationContextMenu(event) {
		let ids = event.params && event.params.ids;
		if (!ids || ids.length !== 1) return;
		event.append({
			label: t('用 Selection Notes 编辑', 'Edit with Selection Notes'),
			onCommand: () => {
				let doc = event.reader && event.reader._iframeWindow && event.reader._iframeWindow.document;
				if (doc) openExisting(doc, event.reader, String(ids[0]), null).catch(report);
			}
		});
	}

	function onViewContextMenu(event) {
		event.append({
			label: t('导出 PDF + 笔记…', 'Export PDF + notes…'),
			onCommand: () => {
				let doc = event.reader && event.reader._iframeWindow && event.reader._iframeWindow.document;
				if (!doc) return;
				let state = setupDocument(doc, event.reader);
				let button = doc.querySelector('.zsn-toolbar-export-button');
				exportNoteBundle(state, button).catch(error => {
					report(error);
					toast(doc, t('导出失败：', 'Export failed: ') + String(error));
				});
			}
		});
	}

	function scanReaders() {
		try {
			for (let reader of Zotero.Reader._readers || []) {
				let doc = reader && reader._iframeWindow && reader._iframeWindow.document;
				if (doc && doc.body) setupDocument(doc, reader);
			}
		}
		catch (e) {
			log('reader scan failed: ' + e);
		}
	}

	async function openExisting(doc, reader, key, anchor) {
		let item = annotationFor(reader, key);
		let state = setupDocument(doc, reader);
		openCard(state, {
			mode: 'existing',
			key,
			text: item.annotationText || '',
			source: item.annotationComment || ''
		}, anchor, true);
	}

	function createCard(state) {
		let { doc } = state;
		let overlay = doc.createElement('div');
		overlay.className = 'zsn-overlay';
		let card = doc.createElement('section');
		card.className = 'zsn-card';
		card.setAttribute('role', 'dialog');
		card.setAttribute('aria-label', t('Selection Notes 笔记编辑器', 'Selection Notes editor'));

		let header = doc.createElement('header'); header.className = 'zsn-header';
		let title = doc.createElement('span'); title.className = 'zsn-title'; title.textContent = t('Selection Notes', 'Selection Notes');
		let subtitle = doc.createElement('span'); subtitle.className = 'zsn-subtitle';
		let close = doc.createElement('button'); close.className = 'zsn-close'; close.type = 'button'; close.textContent = '×'; close.title = t('关闭', 'Close');
		header.append(title, subtitle, close);

		let body = doc.createElement('div'); body.className = 'zsn-body';
		let editorPane = doc.createElement('div'); editorPane.className = 'zsn-pane';
		let editorLabel = doc.createElement('div'); editorLabel.className = 'zsn-pane-label'; editorLabel.textContent = t('编辑（Markdown 源码）', 'Edit (Markdown source)');
		let textarea = doc.createElement('textarea'); textarea.className = 'zsn-editor'; textarea.spellcheck = true;
		// Zotero 9's keyboard manager recognizes INPUT and contenteditable as text
		// boxes, but accidentally omits TEXTAREA. This compatibility marker makes
		// Zotero leave arrows and editing shortcuts to the native textarea.
		textarea.setAttribute('contenteditable', 'true');
		textarea.placeholder = t('# 标题\n\n正文、$E=mc^2$，或：\n```python\nprint("hello")\n```', '# Heading\n\nText, $E=mc^2$, or:\n```python\nprint("hello")\n```');
		editorPane.append(editorLabel, textarea);
		let previewPane = doc.createElement('div'); previewPane.className = 'zsn-pane';
		let previewLabel = doc.createElement('div'); previewLabel.className = 'zsn-pane-label'; previewLabel.textContent = t('实时预览', 'Live preview');
		let preview = doc.createElement('div'); preview.className = 'zsn-preview';
		previewPane.append(previewLabel, preview); body.append(editorPane, previewPane);

		let footer = doc.createElement('footer'); footer.className = 'zsn-footer';
		let hint = doc.createElement('span'); hint.className = 'zsn-hint'; hint.textContent = t('支持 Markdown、$行内公式$、$$块公式$$ 和围栏代码块', 'Supports Markdown, $inline math$, $$display math$$, and fenced code blocks');
		let cancel = doc.createElement('button'); cancel.type = 'button'; cancel.className = 'zsn-action'; cancel.textContent = t('取消', 'Cancel');
		let save = doc.createElement('button'); save.type = 'button'; save.className = 'zsn-action primary'; save.textContent = t('保存', 'Save');
		footer.append(hint, cancel, save);
		card.append(header, body, footer); overlay.appendChild(card); doc.body.appendChild(overlay);

		let ui = { overlay, card, header, subtitle, close, textarea, preview, cancel, save, context: null };
		close.addEventListener('click', () => hideCard(state));
		cancel.addEventListener('click', () => hideCard(state));
		textarea.addEventListener('input', () => schedulePreview(state));
		textarea.addEventListener('keydown', e => {
			// Do not let reader- or third-party shortcuts handle editor keystrokes.
			e.stopPropagation();
			if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save.click(); }
			else if (e.key === 'Escape') { e.preventDefault(); hideCard(state); }
		});
		save.addEventListener('click', () => saveCard(state).catch(report));
		makeDraggable(ui, doc);
		return ui;
	}

	function makeDraggable(ui, doc) {
		let drag = null;
		ui.header.addEventListener('pointerdown', e => {
			if (e.button !== 0 || (e.target.closest && e.target.closest('button'))) return;
			let rect = ui.card.getBoundingClientRect();
			drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
			try { ui.header.setPointerCapture(e.pointerId); } catch (err) {}
			e.preventDefault();
		});
		ui.header.addEventListener('pointermove', e => {
			if (!drag) return;
			let x = Math.max(8, Math.min(doc.defaultView.innerWidth - ui.card.offsetWidth - 8, e.clientX - drag.dx));
			let y = Math.max(8, Math.min(doc.defaultView.innerHeight - ui.card.offsetHeight - 8, e.clientY - drag.dy));
			ui.card.style.left = x + 'px'; ui.card.style.top = y + 'px'; e.preventDefault();
		});
		ui.header.addEventListener('pointerup', () => { drag = null; });
	}

	function positionCard(ui, anchor, doc) {
		let width = Math.min(760, doc.defaultView.innerWidth - 28);
		ui.card.style.width = width + 'px';
		let x = Math.max(14, (doc.defaultView.innerWidth - width) / 2);
		let y = 18;
		if (anchor && anchor.getBoundingClientRect) {
			let rect = anchor.getBoundingClientRect();
			x = Math.max(14, Math.min(doc.defaultView.innerWidth - width - 14, rect.left + rect.width / 2 - width / 2));
			y = Math.max(14, Math.min(doc.defaultView.innerHeight - 430, rect.bottom + 10));
		}
		ui.card.style.left = x + 'px'; ui.card.style.top = y + 'px';
	}

	function openCard(state, context, anchor, focusEditor) {
		if (!state.card || !state.card.overlay.isConnected) state.card = createCard(state);
		let ui = state.card;
		ui.context = context;
		ui.subtitle.textContent = context.text || t('批注笔记', 'Annotation note');
		ui.textarea.value = context.source || '';
		ui.save.disabled = false;
		ui.save.textContent = context.mode === 'new' ? t('保存为高亮笔记', 'Save as highlight note') : t('保存修改', 'Save changes');
		ui.overlay.hidden = false;
		positionCard(ui, anchor, state.doc);
		ZSN.renderer.render(ui.textarea.value, ui.preview);
		// Only explicit button/menu activation opens the card, so focusing here no
		// longer interferes with the user's initial PDF text selection.
		if (focusEditor) setTimeout(() => ui.textarea.focus(), 0);
	}

	function schedulePreview(state) {
		if (state.renderTimer) clearTimeout(state.renderTimer);
		state.renderTimer = setTimeout(() => {
			state.renderTimer = null;
			if (state.card) ZSN.renderer.render(state.card.textarea.value, state.card.preview);
		}, 90);
	}

	function hideCard(state) {
		if (state.card) state.card.overlay.hidden = true;
	}

	function buildAnnotationJSON(selection, comment) {
		let source = plain(selection || {});
		let position = plain(source.position || {});
		let json = {
			key: Zotero.Utilities.generateObjectKey(),
			type: 'highlight',
			color: source.color || '#ffd400',
			text: String(source.text || ''),
			comment,
			position
		};
		if (source.pageLabel !== undefined && source.pageLabel !== null) json.pageLabel = String(source.pageLabel);
		if (source.sortIndex) json.sortIndex = String(source.sortIndex);
		else if (position.pageIndex !== undefined) json.sortIndex = String(position.pageIndex).padStart(5, '0') + '|000000|00000';
		return json;
	}

	async function saveCard(state) {
		let ui = state.card;
		let context = ui.context;
		let source = ui.textarea.value;
		ui.save.disabled = true;
		ui.save.textContent = t('正在保存…', 'Saving…');
		try {
			if (context.mode === 'new') {
				let attachment = attachmentFor(state.reader);
				let item = await Zotero.Annotations.saveFromJSON(attachment, buildAnnotationJSON(context.selection, source), { skipSelect: true });
				context.mode = 'existing'; context.key = item.key;
			}
			else {
				let item = annotationFor(state.reader, context.key);
				if (!item.isEditable()) throw new Error(t('该批注为只读，无法保存', 'This annotation is read-only'));
				item.annotationComment = source;
				await item.saveTx();
			}
			hideCard(state);
			toast(state.doc, t('已保存。点击高亮可看渲染结果，点“笔记详情 / 编辑”可修改。', 'Saved. Click the highlight to view the rendered note, or use “Note details / edit” to change it.'));
		}
		finally {
			ui.save.disabled = false;
			ui.save.textContent = t('保存修改', 'Save changes');
		}
	}

	function toast(doc, message) {
		let old = doc.querySelector('.zsn-toast'); if (old) old.remove();
		let node = doc.createElement('div'); node.className = 'zsn-toast'; node.textContent = message; doc.body.appendChild(node);
		setTimeout(() => node.remove(), 3200);
	}

	function escapeHTML(value) {
		return String(value || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	function exportTimestamp(date = new Date()) {
		let pad = value => String(value).padStart(2, '0');
		return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate())
			+ '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
	}

	function exportedNotesFor(attachment) {
		// getAnnotations() returns an Array from Zotero's privileged compartment.
		// Calling its iterator/map chain and later iterating the result can throw
		// "Permission denied to access property Symbol.iterator" in Zotero 9.
		// Copy each record by numeric index into an Array owned by this add-on.
		let items = attachment.getAnnotations();
		let notes = [];
		for (let index = 0; index < items.length; index++) {
			let item = items[index];
			let source = String(item.annotationComment || '');
			if (!source.trim()) continue;
			let position = {};
			try { position = JSON.parse(item.annotationPosition || '{}'); } catch (e) {}
			notes.push({
				key: String(item.key || ''),
				page: String(item.annotationPageLabel || (Number.isInteger(position.pageIndex) ? position.pageIndex + 1 : '')),
				text: String(item.annotationText || ''),
				source,
				dateModified: String(item.dateModified || ''),
				sortIndex: String(item.annotationSortIndex || '')
			});
		}
		notes.sort((a, b) => a.sortIndex.localeCompare(b.sortIndex));
		return notes;
	}

	function exportMetadata(attachment) {
		let parent = attachment.parentID ? Zotero.Items.get(attachment.parentID) : null;
		let filename = attachment.attachmentFilename || 'paper.pdf';
		let title = parent ? parent.getField('title') : filename.replace(/\.pdf$/i, '');
		let authorNames = [];
		if (parent) {
			let creators = parent.getCreators();
			for (let index = 0; index < creators.length; index++) {
				let creator = creators[index];
				let name = creator.name || [creator.firstName, creator.lastName].filter(Boolean).join(' ');
				if (name) authorNames.push(String(name));
			}
		}
		let authors = authorNames.join(', ');
		return { title: title || filename, authors, filename };
	}

	function buildMarkdownExport(metadata, notes, exportedAt) {
		let lines = [
			'# ' + metadata.title,
			'',
			'- PDF: `' + metadata.filename.replace(/`/g, '\\`') + '`',
			'- ' + t('导出时间', 'Exported') + ': ' + exportedAt,
			'- ' + t('笔记数量', 'Notes') + ': ' + notes.length
		];
		if (metadata.authors) lines.splice(2, 0, '- ' + t('作者', 'Authors') + ': ' + metadata.authors);
		for (let [index, note] of notes.entries()) {
			lines.push('', '---', '', '## ' + t('笔记', 'Note') + ' ' + (index + 1)
				+ (note.page ? ' · ' + t('第', 'Page ') + note.page + (zh ? ' 页' : '') : ''), '');
			if (note.text) {
				lines.push(note.text.split(/\r?\n/).map(line => '> ' + line).join('\n'), '');
			}
			lines.push(note.source, '', '<!-- Zotero annotation: ' + note.key + ' -->');
		}
		return lines.join('\n') + '\n';
	}

	function createRenderedExportNote(doc, source) {
		let container = doc.createElement('div');
		container.className = 'note-body';
		ZSN.renderer.render(source, container);
		// Native MathML is self-contained and needs no bundled fonts. Remove the
		// parallel KaTeX HTML presentation and unwrap MathML before serialization.
		for (let duplicate of container.querySelectorAll('.katex-html')) duplicate.remove();
		for (let wrapper of container.querySelectorAll('.katex-mathml')) {
			let math = wrapper.querySelector('math');
			if (math) wrapper.replaceWith(math);
		}
		// Native form controls are not painted inside SVG image documents.
		// Use static marks so exported task lists retain their checked state.
		for (let input of container.querySelectorAll('input[type="checkbox"]')) {
			let mark = doc.createElement('span');
			mark.textContent = input.checked ? '☑ ' : '☐ ';
			input.replaceWith(mark);
		}
		return container;
	}

	function renderExportNote(doc, source) {
		return createRenderedExportNote(doc, source).innerHTML;
	}

	const PDF_NOTE_PAGE_CSS = `
		.zsn-pdf-note-page{box-sizing:border-box;width:1240px;min-height:1754px;padding:76px 88px;background:#fff;color:#171717;font:24px/1.62 -apple-system,BlinkMacSystemFont,"Helvetica Neue","PingFang SC",sans-serif}
		.zsn-pdf-note-page *{box-sizing:border-box}.pdf-header{border-bottom:2px solid #d5d9df;padding-bottom:20px;margin-bottom:30px}.pdf-header h1{font-size:31px;line-height:1.28;margin:0 0 8px}.pdf-header .meta{color:#68707d;font-size:18px}.pdf-note-title{display:flex;justify-content:space-between;gap:24px;align-items:baseline;margin:0 0 22px}.pdf-note-title h2{font-size:27px;margin:0}.pdf-note-title span{color:#68707d;font-size:19px}.selection{white-space:pre-wrap;margin:0 0 28px;padding:16px 20px;border-left:7px solid #e2b600;background:#fff9d8;color:#505866}.note-body h1,.note-body h2,.note-body h3,.note-body h4{line-height:1.3;margin:1em 0 .45em}.note-body p{margin:.65em 0}.note-body blockquote{margin:.8em 0;padding:.2em 0 .2em 1em;border-left:5px solid #7c9bd3;color:#505866}.note-body ul,.note-body ol{padding-left:1.7em}.note-body table{border-collapse:collapse;width:100%;margin:.8em 0}.note-body th,.note-body td{border:2px solid #c8ccd2;padding:7px 10px;text-align:left}.zsn-inline-code{padding:.1em .32em;border-radius:5px;background:#eceef2;font:90% ui-monospace,SFMono-Regular,Menlo,monospace}.zsn-code-block{position:relative;overflow:hidden;margin:.8em 0;padding:40px 20px 20px;border-radius:10px;background:#151922;color:#e8edf3;font:19px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.zsn-code-language{position:absolute;top:8px;right:13px;color:#98a2b3;font-size:15px}.zsn-token-keyword{color:#c792ea}.zsn-token-string{color:#c3e88d}.zsn-token-number{color:#f78c6c}.zsn-token-comment{color:#86909c;font-style:italic}.zsn-math-display,math[display="block"]{display:block;overflow:hidden;text-align:center;margin:1em 0}.pdf-footer{margin-top:32px;padding-top:14px;border-top:2px solid #e2e5e9;color:#7b828d;font-size:16px}
	`;

	function createPDFNotePage(doc, metadata, note, index, total, exportedAt) {
		let page = doc.createElement('section');
		page.className = 'zsn-pdf-note-page';
		page.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
		let style = doc.createElement('style');
		style.textContent = PDF_NOTE_PAGE_CSS;
		let paperHeader = doc.createElement('header');
		paperHeader.className = 'pdf-header';
		let paperTitle = doc.createElement('h1');
		paperTitle.textContent = metadata.title;
		let paperMeta = doc.createElement('div');
		paperMeta.className = 'meta';
		paperMeta.textContent = [metadata.authors, metadata.filename].filter(Boolean).join(' · ');
		paperHeader.append(paperTitle, paperMeta);
		let noteHeader = doc.createElement('div');
		noteHeader.className = 'pdf-note-title';
		let heading = doc.createElement('h2');
		heading.textContent = t('笔记', 'Note') + ' ' + (index + 1) + ' / ' + total;
		let pageLabel = doc.createElement('span');
		pageLabel.textContent = note.page ? t('原文第 ', 'Source page ') + note.page + (zh ? ' 页' : '') : '';
		noteHeader.append(heading, pageLabel);
		page.append(style, paperHeader, noteHeader);
		if (note.text) {
			let selection = doc.createElement('blockquote');
			selection.className = 'selection';
			selection.textContent = note.text;
			page.appendChild(selection);
		}
		page.appendChild(createRenderedExportNote(doc, note.source));
		let footer = doc.createElement('footer');
		footer.className = 'pdf-footer';
		footer.textContent = 'Selection Notes · ' + exportedAt + ' · Zotero ' + note.key;
		page.appendChild(footer);
		return page;
	}

	async function renderPDFNotePage(doc, metadata, note, index, total, exportedAt) {
		let host = doc.createElement('div');
		host.style.cssText = 'position:fixed;left:-20000px;top:0;width:1240px;z-index:-1;';
		let page = createPDFNotePage(doc, metadata, note, index, total, exportedAt);
		host.appendChild(page);
		doc.body.appendChild(host);
		let height;
		let serialized;
		try {
			height = Math.max(1754, Math.ceil(page.scrollHeight) + 2);
			page.style.minHeight = height + 'px';
			// SVG is XML: HTML outerHTML leaves void elements unclosed and can
			// emit HTML-only entities. Serialize XHTML and MathML with namespaces.
			serialized = new XMLSerializer().serializeToString(page);
		}
		finally {
			host.remove();
		}
		let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="${height}" viewBox="0 0 1240 ${height}"><foreignObject width="1240" height="${height}">${serialized}</foreignObject></svg>`;
		// A system-principal blob: URL cannot be loaded by Zotero's reader
		// content principal. A self-contained data: URL works in that document
		// and passes only a string across the compartment boundary.
		let url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
		let image = doc.createElement('img');
		let loadTimer;
		try {
			await new Promise((resolve, reject) => {
				loadTimer = setTimeout(() => reject(new Error(t('笔记页图像加载超时', 'Note page image loading timed out'))), 15000);
				image.onload = resolve;
				image.onerror = () => reject(new Error(t('无法生成笔记页图像', 'Could not render the note page image')));
				image.src = url;
			});
			let canvas = doc.createElement('canvas');
			canvas.width = 1240;
			canvas.height = height;
			let context = canvas.getContext('2d');
			context.fillStyle = '#ffffff';
			context.fillRect(0, 0, canvas.width, canvas.height);
			context.drawImage(image, 0, 0);
			// pdf-lib accepts a PNG data URL and decodes it in its own realm.
			// A typed array returned by another compartment fails its instanceof
			// checks even when it contains valid PNG bytes.
			return canvas.toDataURL('image/png');
		}
		finally {
			clearTimeout(loadTimer);
			image.onload = null;
			image.onerror = null;
			image.removeAttribute('src');
		}
	}

	async function appendRenderedNotesToPDF(state, inputPath, outputPath, metadata, notes, exportedAt) {
		if (!ZSN.PDFLib) throw new Error(t('渲染 PDF 组件未加载', 'Rendered PDF components are unavailable'));
		let stage = t('读取带批注 PDF', 'reading the annotated PDF');
		try {
			// Strings cross the Zotero/add-on/pdf-lib compartments without exposing
			// foreign iterators or failing pdf-lib's realm-sensitive byte checks.
			let binary = await Zotero.File.getBinaryContentsAsync(inputPath);
			let input = state.doc.defaultView.btoa(binary);
			stage = t('打开 PDF 文档', 'opening the PDF document');
			let pdf = await ZSN.PDFLib.PDFDocument.load(input);
			for (let index = 0; index < notes.length; index++) {
				stage = t('渲染笔记附录 ', 'rendering note appendix ') + (index + 1) + '/' + notes.length;
				let note = notes[index];
				let png = await renderPDFNotePage(state.doc, metadata, note, index, notes.length, exportedAt);
				stage = t('合并笔记附录 ', 'embedding note appendix ') + (index + 1) + '/' + notes.length;
				let image = await pdf.embedPng(png);
				let width = 595.28;
				let height = Math.max(841.89, width * image.height / image.width);
				let page = pdf.addPage();
				page.setSize(width, height);
				page.drawImage(image, { x: 0, y: 0, width, height });
			}
			stage = t('保存渲染附录 PDF', 'saving the rendered-appendix PDF');
			let outputBinary = state.doc.defaultView.atob(await pdf.saveAsBase64());
			let output = new Uint8Array(outputBinary.length);
			for (let index = 0; index < outputBinary.length; index++) output[index] = outputBinary.charCodeAt(index);
			let outputBlob = new Blob([output], { type: 'application/pdf' });
			await Zotero.File.putContentsAsync(outputPath, outputBlob);
		}
		catch (error) {
			throw new Error(stage + ': ' + (error && error.message ? error.message : String(error)));
		}
	}

	function buildHTMLExport(doc, metadata, notes, exportedAt) {
		let entries = notes.map((note, index) => `
		<article class="note" id="note-${index + 1}">
			<header><h2>${escapeHTML(t('笔记', 'Note'))} ${index + 1}</h2><span>${note.page ? escapeHTML(t('第', 'Page ') + note.page + (zh ? ' 页' : '')) : ''}</span></header>
			${note.text ? `<blockquote class="selection">${escapeHTML(note.text)}</blockquote>` : ''}
			${renderExportNote(doc, note.source)}
			<details><summary>${escapeHTML(t('查看 Markdown 源码', 'View Markdown source'))}</summary><pre class="source">${escapeHTML(note.source)}</pre></details>
		</article>`).join('\n');
		return `<!doctype html>
<html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(metadata.title)} — Selection Notes</title>
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{max-width:900px;margin:0 auto;padding:32px 24px;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:CanvasText;background:Canvas}h1{line-height:1.25;margin-bottom:.25em}.meta{color:GrayText;margin-bottom:2rem}.note{margin:1.25rem 0;padding:1.1rem 1.25rem;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:12px;break-inside:avoid}.note>header{display:flex;align-items:baseline;justify-content:space-between;gap:1rem}.note h2{margin:0;font-size:1.15rem}.note>header span{color:GrayText}.selection{white-space:pre-wrap;margin:.8rem 0;padding:.55rem .8rem;border-left:4px solid #e2b600;background:color-mix(in srgb,#ffd400 12%,Canvas);color:GrayText}.note-body h1,.note-body h2,.note-body h3{line-height:1.3}.note-body table{border-collapse:collapse;width:100%}.note-body th,.note-body td{border:1px solid color-mix(in srgb,CanvasText 22%,transparent);padding:.35rem .5rem}.zsn-inline-code{padding:.1em .3em;border-radius:4px;background:color-mix(in srgb,CanvasText 10%,transparent);font-family:ui-monospace,monospace}.zsn-code-block,.source{overflow:auto;padding:1rem;border-radius:8px;background:#151922;color:#e8edf3;font:13px/1.55 ui-monospace,monospace;white-space:pre}.zsn-code-language{float:right;color:#98a2b3}.zsn-token-keyword{color:#c792ea}.zsn-token-string{color:#c3e88d}.zsn-token-number{color:#f78c6c}.zsn-token-comment{color:#86909c;font-style:italic}.zsn-math-display{overflow:auto;text-align:center;margin:1rem 0}.katex-html{display:none}details{margin-top:1rem;color:GrayText}details .source{color:#e8edf3}@media print{body{max-width:none;padding:0}.note{border-color:#bbb;page-break-inside:avoid}details{display:none}}
</style></head><body>
<h1>${escapeHTML(metadata.title)}</h1>
<div class="meta">${metadata.authors ? escapeHTML(metadata.authors) + '<br>' : ''}${escapeHTML(metadata.filename)} · ${escapeHTML(exportedAt)} · ${notes.length} ${escapeHTML(t('条笔记', 'notes'))}</div>
${entries}
</body></html>`;
	}

	async function chooseExportFolder(state) {
		if (!ZSN.FilePicker) throw new Error(t('导出文件选择器未加载', 'The export file picker is unavailable'));
		let picker = new ZSN.FilePicker();
		picker.init(state.doc.defaultView, t('选择论文和笔记的导出位置', 'Choose where to export the paper and notes'), picker.modeGetFolder);
		let result = await picker.show();
		return result === picker.returnOK ? picker.file : null;
	}

	async function exportNoteBundle(state, button) {
		if (state.exporting) return;
		let attachment = attachmentFor(state.reader);
		let notes = exportedNotesFor(attachment);
		if (!notes.length) {
			toast(state.doc, t('当前 PDF 还没有可导出的笔记。', 'This PDF has no notes to export yet.'));
			return;
		}
		state.exporting = true;
		if (button) {
			button.disabled = true;
			button.textContent = t('正在导出…', 'Exporting…');
		}
		try {
			let destination = await chooseExportFolder(state);
			if (!destination) return;
			let metadata = exportMetadata(attachment);
			let baseName = Zotero.File.getValidFileName(metadata.title).slice(0, 100) || 'paper';
			let packageName = baseName + '-Selection-Notes-' + exportTimestamp();
			if (!ZSN.OS) throw new Error(t('导出路径组件未加载', 'The export path component is unavailable'));
			let packagePath = ZSN.OS.Path.join(destination, packageName);
			await Zotero.File.createDirectoryIfMissingAsync(packagePath);
			let pdfName = Zotero.File.getValidFileName(metadata.filename || (baseName + '.pdf'));
			if (!/\.pdf$/i.test(pdfName)) pdfName += '.pdf';
			let pdfStem = pdfName.replace(/\.pdf$/i, '');
			let annotatedPDFPath = ZSN.OS.Path.join(packagePath, pdfName);
			let renderedPDFPath = ZSN.OS.Path.join(packagePath, pdfStem + '.rendered-notes.pdf');
			let exportedAt = new Date().toLocaleString();
			await Zotero.PDFWorker.export(attachment.id, annotatedPDFPath, true);
			await Zotero.File.putContentsAsync(
				ZSN.OS.Path.join(packagePath, baseName + '.notes.md'),
				buildMarkdownExport(metadata, notes, exportedAt)
			);
			await Zotero.File.putContentsAsync(
				ZSN.OS.Path.join(packagePath, baseName + '.notes.html'),
				buildHTMLExport(state.doc, metadata, notes, exportedAt)
			);
			await appendRenderedNotesToPDF(state, annotatedPDFPath, renderedPDFPath, metadata, notes, exportedAt);
			toast(state.doc, t('已导出 ', 'Exported ') + notes.length + t(' 条笔记、带批注 PDF 和渲染附录 PDF。', ' notes, the annotated PDF, and the rendered-appendix PDF.'));
		}
		finally {
			state.exporting = false;
			if (button) {
				button.disabled = false;
				button.textContent = t('⇩ 导出笔记', '⇩ Export notes');
			}
		}
	}

	async function startup() {
		zh = String(Zotero.locale || '').toLowerCase().startsWith('zh');
		Zotero.SelectionNotes = {
			version: ZSN.version,
			status: () => ({
				version: ZSN.version,
				documents: states.size,
				katexDocuments: [...states].filter(state => state.katex && typeof state.katex.render === 'function').length,
				zotero: Zotero.version
			}),
			render: (source, element) => ZSN.renderer.render(source, element)
		};
		register('renderTextSelectionPopup', onTextSelection);
		register('renderToolbar', onToolbar);
		register('createAnnotationContextMenu', onAnnotationContextMenu);
		register('createViewContextMenu', onViewContextMenu);
		// Independent fallback for Zotero 9: discover open readers and observe the
		// native selection popup directly, even if another plugin breaks the
		// public event dispatch chain before our listener is reached.
		scanReaders();
		readerScanTimer = setInterval(scanReaders, 500);
		log('started for Zotero ' + Zotero.version);
	}

	function shutdown() {
		if (readerScanTimer) {
			clearInterval(readerScanTimer);
			readerScanTimer = null;
		}
		for (let state of states) {
			try { state.observer.disconnect(); } catch (e) {}
			try { if (state.card && state.card.overlay) state.card.overlay.remove(); } catch (e) {}
			try { let style = state.doc.getElementById('zsn-styles'); if (style) style.remove(); } catch (e) {}
		}
		states.clear();
		try { delete Zotero.SelectionNotes; } catch (e) {}
		// Zotero removes registered listeners automatically by plugin ID on shutdown.
		log('stopped');
	}

	return { startup, shutdown, buildAnnotationJSON };
})();
