/**
 * Largen frontend. Plain ES modules, no build step.
 * All server-provided text is inserted with textContent or via the escaping Markdown renderer.
 */
import { renderMarkdown } from './markdown.js';
import { readEventStream } from './sse.js';

const PREFS = { mode: 'largen.mode', webSearch: 'largen.webSearch' };
const MODE_LABEL = { quick: 'Quick', research: 'Research', deep: 'Deep' };
const CONF_LABEL = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };
const TYPE_LABEL = {
  government: 'Government', academic: 'Academic', primary_research: 'Research', official: 'Official',
  standards: 'Standard', vendor: 'Manufacturer', review: 'Review', news: 'News', reference: 'Reference',
  community: 'Community', blog: 'Blog', unknown: 'Website',
};

const state = {
  conversationId: null,
  conversations: [],
  mode: 'research',
  webSearch: true,
  busy: false,
  seq: 0,
};

const $ = (sel) => document.querySelector(sel);
const els = {
  app: $('#app'),
  convList: $('#conv-list'),
  convEmpty: $('#conv-empty'),
  newChat: $('#new-chat'),
  hero: $('#hero'),
  examples: $('#examples'),
  messages: $('#messages'),
  stage: $('#stage'),
  progress: $('#progress'),
  progressText: $('#progress-text'),
  form: $('#composer'),
  input: $('#question'),
  send: $('#send'),
  webSearch: $('#web-search'),
  charCount: $('#char-count'),
  banner: $('#banner'),
  health: $('#health'),
  topbarTitle: $('#topbar-title'),
  openSidebar: $('#open-sidebar'),
  closeSidebar: $('#close-sidebar'),
  main: document.querySelector('.main'),
  modeButtons: [...document.querySelectorAll('.mode')],
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function safeHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function formatDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON response
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Request failed (${res.status}).`);
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

function friendlyError(err) {
  if (err instanceof TypeError) return 'Can’t reach the Largen server. Check that it is still running, then try again.';
  return err?.message || 'Something went wrong. Please try again.';
}

/* ── Startup ─────────────────────────────────────────────────────────────── */

function restorePrefs() {
  const mode = localStorage.getItem(PREFS.mode);
  if (['quick', 'research', 'deep'].includes(mode)) state.mode = mode;
  state.webSearch = localStorage.getItem(PREFS.webSearch) !== 'off';
  els.webSearch.checked = state.webSearch;
  setMode(state.mode);
}

function setMode(mode) {
  state.mode = mode;
  localStorage.setItem(PREFS.mode, mode);
  for (const b of els.modeButtons) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
}

async function loadHealth() {
  try {
    const h = await api('/api/health');
    const notes = [];
    if (!h.ai.configured) notes.push('No AI provider is configured, so answers show source excerpts instead of written responses. Set AI_API_KEY and restart Largen.');
    if (!h.search.configured) notes.push('No search provider is configured, so Largen cannot cite web sources yet. Set SEARCH_API_KEY (or SEARCH_PROVIDER=searxng).');
    els.banner.replaceChildren();
    if (notes.length) {
      els.banner.hidden = false;
      const ul = el('ul');
      for (const n of notes) ul.append(el('li', '', n));
      els.banner.append(ul);
    } else {
      els.banner.hidden = true;
    }
    els.health.hidden = false;
    els.health.textContent = `${h.ai.configured ? h.ai.model : 'AI off'} · search ${h.search.configured ? h.search.provider : 'off'}`;
  } catch {
    els.banner.hidden = false;
    els.banner.textContent = 'Largen’s server did not respond. Start it with “npm start”, then reload this page.';
  }
}

async function loadConversations() {
  try {
    const data = await api('/api/conversations');
    state.conversations = data.conversations ?? [];
  } catch {
    state.conversations = [];
  }
  renderConversationList();
}

function renderConversationList() {
  els.convList.replaceChildren();
  els.convEmpty.hidden = state.conversations.length > 0;
  for (const c of state.conversations) {
    const li = el('li', `conv-item${c.id === state.conversationId ? ' active' : ''}`);
    const open = el('button', 'conv-open', c.title);
    open.type = 'button';
    open.title = c.title;
    open.addEventListener('click', () => openConversation(c.id));
    const del = el('button', 'conv-del', '✕');
    del.type = 'button';
    del.setAttribute('aria-label', `Delete “${c.title}”`);
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteConversation(c.id);
    });
    li.append(open, del);
    els.convList.append(li);
  }
}

function setTopbarTitle() {
  const c = state.conversations.find((x) => x.id === state.conversationId);
  els.topbarTitle.textContent = c ? c.title : '';
}

async function openConversation(id) {
  try {
    const data = await api(`/api/conversations/${id}`);
    state.conversationId = id;
    renderMessages(data.conversation.messages ?? []);
    setTopbarTitle();
    renderConversationList();
    closeSidebarMobile();
  } catch (err) {
    appendError(friendlyError(err));
  }
}

function newConversation() {
  state.conversationId = null;
  els.messages.replaceChildren();
  els.hero.hidden = false;
  els.topbarTitle.textContent = '';
  renderConversationList();
  closeSidebarMobile();
  els.input.focus();
}

async function deleteConversation(id) {
  const c = state.conversations.find((x) => x.id === id);
  if (!window.confirm(`Delete “${c?.title ?? 'this conversation'}”? This cannot be undone.`)) return;
  try {
    await api(`/api/conversations/${id}`, { method: 'DELETE' });
    if (state.conversationId === id) newConversation();
    await loadConversations();
  } catch (err) {
    appendError(friendlyError(err));
  }
}

/* ── Rendering messages ──────────────────────────────────────────────────── */

function renderMessages(messages) {
  els.messages.replaceChildren();
  els.hero.hidden = messages.length > 0;
  for (const m of messages) {
    if (m.role === 'user') appendUser(m.content);
    else if (m.error) appendError(m.content);
    else appendAssistant(m);
  }
  scrollToBottom();
}

function appendUser(text) {
  els.hero.hidden = true;
  const article = el('article', 'msg user');
  article.append(el('div', 'user-bubble', text));
  els.messages.append(article);
}

function appendError(text) {
  const article = el('article', 'msg error');
  const avatar = el('div', 'avatar', '!');
  avatar.setAttribute('aria-hidden', 'true');
  article.append(avatar, el('div', 'msg-body', text));
  els.messages.append(article);
  scrollToBottom();
}

function modeSummary(m) {
  const label = MODE_LABEL[m.mode] ?? 'Answer';
  if (m.mode === 'direct' || !m.references) return `${label} · from general knowledge`;
  const n = m.stats?.pagesRead ?? 0;
  return `${label} · ${n} ${n === 1 ? 'source' : 'sources'} read`;
}

function appendAssistant(m) {
  const key = `m${++state.seq}`;
  const article = el('article', 'msg assistant');
  const avatar = el('div', 'avatar', 'L');
  avatar.setAttribute('aria-hidden', 'true');
  const body = el('div', 'msg-body');

  const meta = el('div', 'meta-row');
  if (m.confidence) meta.append(el('span', `badge ${m.confidence}`, CONF_LABEL[m.confidence] ?? m.confidence));
  meta.append(el('span', '', modeSummary(m)));
  body.append(meta);

  if (m.summary) body.append(el('p', 'plan-summary', m.summary));

  const prose = el('div', 'prose');
  prose.innerHTML = renderMarkdown(m.answer ?? '', { refPrefix: key });
  body.append(prose);

  if (m.limitations?.length) body.append(detailsBlock('notes', `Limitations (${m.limitations.length})`, m.limitations));
  if (m.warnings?.length) body.append(detailsBlock('notes warn', `Notes (${m.warnings.length})`, m.warnings));
  if (m.conflicts?.length) body.append(conflictsBlock(m.conflicts, key));
  if (m.references?.length) body.append(sourcesSection(m.references, key));
  if (m.otherSources?.length) body.append(othersBlock(m.otherSources, key));
  if (m.confidenceReasons?.length) body.append(detailsBlock('why', 'How confident is this?', m.confidenceReasons));

  const actions = el('div', 'msg-actions');
  const copy = el('button', 'ghost-btn', 'Copy answer');
  copy.type = 'button';
  copy.addEventListener('click', () => copyAnswer(m, copy));
  actions.append(copy);
  body.append(actions);

  article.append(avatar, body);
  els.messages.append(article);
  return article;
}

function detailsBlock(className, summaryText, items) {
  const d = el('details', className);
  d.append(el('summary', '', summaryText));
  const ul = el('ul');
  for (const item of items) ul.append(el('li', '', item));
  d.append(ul);
  return d;
}

function conflictsBlock(conflicts, key) {
  const d = el('details', 'conflicts');
  d.open = true;
  d.append(el('summary', '', `${conflicts.length} disagreement${conflicts.length === 1 ? '' : 's'} between sources`));
  for (const c of conflicts) {
    const card = el('div', 'conflict-card');
    card.append(el('strong', '', c.metric ? `On ${c.metric}:` : 'Figures differ:'));
    // Internal IDs like "(S1)" are removed from the explanation; citations are shown below instead.
    card.append(el('p', '', c.explanation.replace(/\s*\(S\d+\)/g, '')));
    const ul = el('ul');
    for (const v of c.values) {
      const li = el('li');
      li.append(el('span', '', `${v.value} `));
      if (v.citation) {
        const a = el('a', 'cite', String(v.citation));
        a.href = `#ref-${key}-${v.citation}`;
        a.dataset.ref = String(v.citation);
        a.dataset.prefix = key;
        li.append(a);
      }
      if (v.quote) li.append(el('span', '', ` — “${v.quote}”`));
      ul.append(li);
    }
    card.append(ul);
    d.append(card);
  }
  return d;
}

function sourcesSection(refs, key) {
  const section = el('section', 'sources');
  section.append(el('h3', '', `Sources (${refs.length})`));
  const ol = el('ol', 'source-list');
  for (const r of refs) ol.append(sourceCard(r, key));
  section.append(ol);
  return section;
}

function sourceCard(r, key) {
  const li = el('li');
  const d = el('details', 'source');
  d.id = `ref-${key}-${r.number}`;
  const summary = el('summary');
  summary.append(
    el('span', 'src-num', String(r.number)),
    el('span', 'src-title', r.title),
    el('span', 'src-domain', r.domain),
    el('span', 'src-type', TYPE_LABEL[r.type] ?? 'Website')
  );
  const body = el('div', 'source-body');
  const facts = [];
  const published = formatDate(r.publishedAt);
  if (published) facts.push(`Published ${published}`);
  const updated = formatDate(r.updatedAt);
  if (updated && updated !== published) facts.push(`Updated ${updated}`);
  facts.push(r.evidenceLevel === 'snippet' ? 'Search snippet only (page not read)' : 'Full page read');
  if (r.syndicatedFrom) facts.push('Repeats another source’s text');
  body.append(el('p', 'muted', facts.join(' · ')));
  if (r.excerpt) body.append(el('p', 'excerpt', r.excerpt));
  const href = safeHttpUrl(r.url);
  if (href) {
    const a = el('a', '', href);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const linkPara = el('p');
    linkPara.append(a);
    body.append(linkPara);
  }
  d.append(summary, body);
  li.append(d);
  return li;
}

function othersBlock(others, key) {
  const d = el('details', 'others');
  d.append(el('summary', '', `Also reviewed (${others.length})`));
  const ul = el('ul');
  for (const o of others) {
    const li = el('li');
    const href = safeHttpUrl(o.url);
    const label = el('span', '', `${o.title} (${o.domain})`);
    if (href) {
      const a = el('a', '', `${o.title}`);
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      li.append(a, el('span', '', ` · ${o.domain}`));
    } else {
      li.append(label);
    }
    ul.append(li);
  }
  d.append(ul);
  return d;
}

async function copyAnswer(m, button) {
  const refs = (m.references ?? []).map((r) => `[${r.number}] ${r.title} — ${r.url}`).join('\n');
  const text = refs ? `${m.answer}\n\nSources:\n${refs}` : m.answer;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = 'Copy answer'), 1500);
  } catch {
    button.textContent = 'Copy failed';
  }
}

/* ── Sending ─────────────────────────────────────────────────────────────── */

function showProgress(message) {
  els.progressText.textContent = message;
  els.progress.hidden = false;
}

function hideProgress() {
  els.progress.hidden = true;
}

function setBusy(busy) {
  state.busy = busy;
  updateSendState();
}

function updateSendState() {
  els.send.disabled = state.busy || !els.input.value.trim();
}

async function send(raw) {
  const message = raw.trim();
  if (state.busy || !message) return;
  setBusy(true);
  appendUser(message);
  els.input.value = '';
  autosize();
  scrollToBottom();
  showProgress('Understanding your question…');

  let finished = false;
  try {
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        conversationId: state.conversationId,
        message,
        mode: state.mode,
        webSearch: state.webSearch,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error?.message || `Request failed (${res.status}).`);
    }
    await readEventStream(res.body, ({ event, data }) => {
      if (event === 'status') {
        showProgress(data.message);
      } else if (event === 'result') {
        finished = true;
        state.conversationId = data.conversationId;
        appendAssistant(data.message);
      } else if (event === 'error') {
        finished = true;
        if (data.conversationId) state.conversationId = data.conversationId;
        appendError(data.message);
      }
      scrollToBottom();
    });
    if (!finished) appendError('The connection closed before Largen finished. Please try again.');
  } catch (err) {
    appendError(friendlyError(err));
  } finally {
    hideProgress();
    setBusy(false);
    await loadConversations();
    setTopbarTitle();
    renderConversationList();
    scrollToBottom();
  }
}

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 220)}px`;
  const n = els.input.value.length;
  els.charCount.textContent = n > 1500 ? `${n}/2000` : '';
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    els.stage.scrollTop = els.stage.scrollHeight;
  });
}

function closeSidebarMobile() {
  els.app.classList.remove('sidebar-open');
}

/* ── Events ──────────────────────────────────────────────────────────────── */

function bindEvents() {
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    send(els.input.value);
  });
  els.input.addEventListener('input', () => {
    autosize();
    updateSendState();
  });
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(els.input.value);
    }
  });
  for (const b of els.modeButtons) b.addEventListener('click', () => setMode(b.dataset.mode));
  els.webSearch.addEventListener('change', () => {
    state.webSearch = els.webSearch.checked;
    localStorage.setItem(PREFS.webSearch, state.webSearch ? 'on' : 'off');
  });
  els.newChat.addEventListener('click', newConversation);
  els.openSidebar.addEventListener('click', () => els.app.classList.add('sidebar-open'));
  els.closeSidebar.addEventListener('click', closeSidebarMobile);
  els.main.addEventListener('click', () => {
    if (els.app.classList.contains('sidebar-open')) closeSidebarMobile();
  });
  for (const b of els.examples.querySelectorAll('.example')) {
    b.addEventListener('click', () => {
      els.input.value = b.textContent;
      autosize();
      send(b.textContent);
    });
  }
  // Citation markers open and scroll to the matching source card.
  els.messages.addEventListener('click', (e) => {
    const link = e.target.closest('a.cite');
    if (!link) return;
    e.preventDefault();
    const target = document.getElementById(`ref-${link.dataset.prefix}-${link.dataset.ref}`);
    if (!target) return;
    if (target.tagName === 'DETAILS') target.open = true;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

function init() {
  restorePrefs();
  bindEvents();
  updateSendState();
  loadHealth();
  loadConversations();
}

init();
