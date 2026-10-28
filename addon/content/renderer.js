/* global Zotero, ZSN */

ZSN.renderer = (function () {
	const BLOCK_START = /^(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s|```|~~~|\$\$\s*$|(?:-{3,}|\*{3,}|_{3,})\s*$)/;
	const KEYWORDS = new Set((
		'abstract arguments async await boolean break byte case catch char class const continue debugger '
		+ 'def default delete do double else enum export extends false final finally float for from function '
		+ 'get if implements import in instanceof int interface lambda let long native new null of package '
		+ 'pass private protected public raise return set short static super switch synchronized this throw '
		+ 'throws transient true try typeof undefined var void volatile while with yield'
	).split(/\s+/));

	function appendText(parent, text) {
		parent.appendChild(parent.ownerDocument.createTextNode(text));
	}

	function safeURL(value) {
		try {
			let url = new URL(value, 'https://example.invalid/');
			return ['http:', 'https:', 'zotero:'].includes(url.protocol) ? value : null;
		}
		catch (e) {
			return null;
		}
	}

	function renderMath(parent, source, displayMode) {
		let doc = parent.ownerDocument;
		let node = doc.createElement(displayMode ? 'div' : 'span');
		node.className = displayMode ? 'zsn-math zsn-math-display' : 'zsn-math';
		try {
			let readerScope = doc.defaultView && (doc.defaultView.wrappedJSObject || doc.defaultView);
			let katex = readerScope && readerScope.katex || ZSN.katex;
			if (!katex || typeof katex.render !== 'function') {
				throw new Error('KaTeX unavailable');
			}
			katex.render(source, node, {
				displayMode,
				throwOnError: false,
				strict: 'ignore',
				trust: false,
				output: 'htmlAndMathml'
			});
		}
		catch (e) {
			try { Zotero.debug('[Selection Notes] KaTeX render failed: ' + e); } catch (err) {}
			node.classList.add('zsn-render-error');
			node.title = String(e);
			node.textContent = (displayMode ? '$$' : '$') + source + (displayMode ? '$$' : '$');
		}
		parent.appendChild(node);
	}

	function appendInline(parent, source) {
		let re = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?:\\.|[^$\n])+?\$|`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^)\s]+\))/g;
		let cursor = 0;
		let match;
		while ((match = re.exec(source))) {
			if (match.index > cursor) appendText(parent, source.slice(cursor, match.index));
			let token = match[0];
			if (token.startsWith('$$')) {
				renderMath(parent, token.slice(2, -2), true);
			}
			else if (token.startsWith('\\[')) {
				renderMath(parent, token.slice(2, -2), true);
			}
			else if (token.startsWith('\\(')) {
				renderMath(parent, token.slice(2, -2), false);
			}
			else if (token.startsWith('$')) {
				renderMath(parent, token.slice(1, -1), false);
			}
			else if (token.startsWith('`')) {
				let code = parent.ownerDocument.createElement('code');
				code.className = 'zsn-inline-code';
				code.textContent = token.slice(1, -1);
				parent.appendChild(code);
			}
			else if (token.startsWith('**') || token.startsWith('__')) {
				let strong = parent.ownerDocument.createElement('strong');
				appendInline(strong, token.slice(2, -2));
				parent.appendChild(strong);
			}
			else if (token.startsWith('~~')) {
				let del = parent.ownerDocument.createElement('del');
				appendInline(del, token.slice(2, -2));
				parent.appendChild(del);
			}
			else if (token.startsWith('*') || token.startsWith('_')) {
				let em = parent.ownerDocument.createElement('em');
				appendInline(em, token.slice(1, -1));
				parent.appendChild(em);
			}
			else if (token.startsWith('[')) {
				let parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
				let href = parts && safeURL(parts[2]);
				if (href) {
					let a = parent.ownerDocument.createElement('a');
					a.href = href;
					a.textContent = parts[1];
					a.setAttribute('rel', 'noopener noreferrer');
					a.setAttribute('target', '_blank');
					parent.appendChild(a);
				}
				else appendText(parent, token);
			}
			cursor = re.lastIndex;
		}
		if (cursor < source.length) appendText(parent, source.slice(cursor));
	}

	function appendHighlightedCode(code, source, language) {
		let doc = code.ownerDocument;
		let tokenRe = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|<!--[\s\S]*?-->|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;
		let cursor = 0;
		let match;
		while ((match = tokenRe.exec(source))) {
			if (match.index > cursor) appendText(code, source.slice(cursor, match.index));
			let value = match[0];
			let cls = '';
			if (/^(?:\/\*|\/\/|#|<!--)/.test(value)) cls = 'comment';
			else if (/^["'`]/.test(value)) cls = 'string';
			else if (/^\d/.test(value)) cls = 'number';
			else if (KEYWORDS.has(value)) cls = 'keyword';
			let span = doc.createElement(cls ? 'span' : 'span');
			if (cls) span.className = 'zsn-token-' + cls;
			span.textContent = value;
			code.appendChild(span);
			cursor = tokenRe.lastIndex;
		}
		if (cursor < source.length) appendText(code, source.slice(cursor));
		code.dataset.language = language || 'text';
	}

	function isTableDivider(line) {
		return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
	}

	function tableCells(line) {
		return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(x => x.trim());
	}

	function render(source, container) {
		let doc = container.ownerDocument;
		let fragment = doc.createDocumentFragment();
		let lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
		let i = 0;
		while (i < lines.length) {
			let line = lines[i];
			if (!line.trim()) { i++; continue; }

			let fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
			if (fence) {
				let end = i + 1;
				let body = [];
				while (end < lines.length && !new RegExp('^\\s*' + fence[1] + '\\s*$').test(lines[end])) body.push(lines[end++]);
				let pre = doc.createElement('pre');
				pre.className = 'zsn-code-block';
				let label = doc.createElement('span');
				label.className = 'zsn-code-language';
				label.textContent = fence[2] || 'code';
				let code = doc.createElement('code');
				appendHighlightedCode(code, body.join('\n'), fence[2].toLowerCase());
				pre.append(label, code);
				fragment.appendChild(pre);
				i = end < lines.length ? end + 1 : end;
				continue;
			}

			if (/^\s*\$\$\s*$/.test(line)) {
				let end = i + 1;
				let math = [];
				while (end < lines.length && !/^\s*\$\$\s*$/.test(lines[end])) math.push(lines[end++]);
				renderMath(fragment, math.join('\n'), true);
				i = end < lines.length ? end + 1 : end;
				continue;
			}

			if (i + 1 < lines.length && line.includes('|') && isTableDivider(lines[i + 1])) {
				let table = doc.createElement('table');
				let thead = doc.createElement('thead');
				let tr = doc.createElement('tr');
				for (let cell of tableCells(line)) {
					let th = doc.createElement('th'); appendInline(th, cell); tr.appendChild(th);
				}
				thead.appendChild(tr); table.appendChild(thead);
				let tbody = doc.createElement('tbody');
				i += 2;
				while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
					let row = doc.createElement('tr');
					for (let cell of tableCells(lines[i])) {
						let td = doc.createElement('td'); appendInline(td, cell); row.appendChild(td);
					}
					tbody.appendChild(row); i++;
				}
				table.appendChild(tbody); fragment.appendChild(table); continue;
			}

			let heading = /^(#{1,6})\s+(.+)$/.exec(line);
			if (heading) {
				let h = doc.createElement('h' + heading[1].length);
				appendInline(h, heading[2]); fragment.appendChild(h); i++; continue;
			}

			if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
				fragment.appendChild(doc.createElement('hr')); i++; continue;
			}

			if (/^\s*>/.test(line)) {
				let quote = [];
				while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
				let blockquote = doc.createElement('blockquote');
				appendInline(blockquote, quote.join(' ')); fragment.appendChild(blockquote); continue;
			}

			let list = /^\s*([-*+]|\d+[.)])\s+(.+)$/.exec(line);
			if (list) {
				let ordered = /^\d/.test(list[1]);
				let listNode = doc.createElement(ordered ? 'ol' : 'ul');
				while (i < lines.length) {
					let item = /^\s*([-*+]|\d+[.)])\s+(.+)$/.exec(lines[i]);
					if (!item || /^\d/.test(item[1]) !== ordered) break;
					let li = doc.createElement('li');
					let task = /^\[([ xX])\]\s+(.+)$/.exec(item[2]);
					if (task) {
						let input = doc.createElement('input'); input.type = 'checkbox'; input.disabled = true; input.checked = task[1].toLowerCase() === 'x';
						li.appendChild(input); appendInline(li, task[2]);
					}
					else appendInline(li, item[2]);
					listNode.appendChild(li); i++;
				}
				fragment.appendChild(listNode); continue;
			}

			let paragraph = [line.trim()];
			i++;
			while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i])
				&& !(i + 1 < lines.length && lines[i].includes('|') && isTableDivider(lines[i + 1]))) {
				paragraph.push(lines[i].trim()); i++;
			}
			let p = doc.createElement('p'); appendInline(p, paragraph.join(' ')); fragment.appendChild(p);
		}
		container.replaceChildren(fragment);
		return container;
	}

	return { render, safeURL };
})();
