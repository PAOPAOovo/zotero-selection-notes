/* global Zotero, Services, ZSN, setTimeout, clearTimeout, setInterval, clearInterval */

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
		state = { doc, reader, katex: readerKaTeX, observer: null, card: null, renderTimer: null };
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

	function onToolbar(event) {
		try {
			setupDocument(event.doc, event.reader);
			let marker = event.doc.createElement('span');
			marker.hidden = true;
			marker.className = 'zsn-toolbar-marker';
			event.append(marker);
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
