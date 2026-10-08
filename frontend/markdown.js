/**
 * Safe Markdown renderer for answers. Everything is HTML-escaped before any Markdown rule runs,
 * so model output and web-derived text can never inject markup or script.
 * Supports: headings, paragraphs, bold/italic, inline code, code blocks, links (http/https only),
 * bullet and numbered lists, blockquotes, tables, horizontal rules, and [n] citation markers.
 */

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Inline formatting for a single line or paragraph.
 * @param {string} raw
 * @param {{refPrefix?: string}} [opts] prefix for citation anchor ids, e.g. "m3"
 */
export function renderInline(raw, { refPrefix = '' } = {}) {
  const codes = [];
  let s = escapeHtml(String(raw ?? '').replace(/\u0000/g, '')).replace(/`([^`\n]+)`/g, (_m, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/\[(\d{1,2})\]/g, (_m, n) => {
    const id = refPrefix ? `ref-${refPrefix}-${n}` : `ref-${n}`;
    return `<a class="cite" href="#${id}" data-ref="${n}" data-prefix="${refPrefix}" aria-label="Source ${n}">${n}</a>`;
  });
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
  return s;
}

const isTableStart = (lines, i) =>
  i + 1 < lines.length &&
  lines[i].includes('|') &&
  /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1]);

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/**
 * Renders Markdown to an HTML string that is safe to assign to innerHTML.
 * @param {string} src
 * @param {{refPrefix?: string}} [opts]
 */
export function renderMarkdown(src, opts = {}) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').split('\n');
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) {
      out.push(`<p>${renderInline(para.join(' '), opts)}</p>`);
      para = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      flush();
      const lang = fence[1];
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // closing fence (or end of input)
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      flush();
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${renderInline(heading[2], opts)}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push('<hr>');
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flush();
      const quoted = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderInline(quoted.join(' '), opts)}</blockquote>`);
      continue;
    }

    if (isTableStart(lines, i)) {
      flush();
      const head = splitRow(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const th = head.map((c) => `<th>${renderInline(c, opts)}</th>`).join('');
      const tb = rows
        .map((r) => `<tr>${head.map((_h, j) => `<td>${renderInline(r[j] ?? '', opts)}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      flush();
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      out.push(`<ul>${items.map((t) => `<li>${renderInline(t, opts)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      flush();
      const start = Number(line.match(/^\s*(\d+)/)[1]);
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      const startAttr = start > 1 ? ` start="${start}"` : '';
      out.push(`<ol${startAttr}>${items.map((t) => `<li>${renderInline(t, opts)}</li>`).join('')}</ol>`);
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flush();
  return out.join('\n');
}
