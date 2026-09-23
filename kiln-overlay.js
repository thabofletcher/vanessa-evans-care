/**
 * Kiln overlay — the control surface for a Kiln-managed site.
 *
 * Drop one script tag into any static site and the owner gets a private
 * panel for filing change requests, which land in that site's ticket queue.
 *
 *   <script src="kiln-overlay.js"
 *           data-kiln-site="<site guid>"
 *           data-kiln-api="/api/kiln"
 *           data-kiln-mode="owner"   // or "public"
 *           defer></script>
 *
 * Everything renders inside a shadow root so the host page's CSS and the
 * overlay's CSS can never collide. In "owner" mode the launcher stays hidden
 * until someone arrives with #kiln in the URL or already holds a key, so
 * ordinary visitors never see it.
 */
(function () {
  'use strict';

  var script = document.currentScript ||
    document.querySelector('script[data-kiln-site]');
  if (!script) return;

  var SITE = script.getAttribute('data-kiln-site') || '';
  var API = (script.getAttribute('data-kiln-api') || '/api/kiln').replace(/\/$/, '');
  var MODE = script.getAttribute('data-kiln-mode') || 'owner';
  var NAME = script.getAttribute('data-kiln-name') || 'this site';
  if (!SITE) return;

  var STORAGE_KEY = 'kiln.key.' + SITE;

  function getKey() {
    try { return localStorage.getItem(STORAGE_KEY) || ''; } catch (e) { return ''; }
  }
  function setKey(value) {
    try { value ? localStorage.setItem(STORAGE_KEY, value) : localStorage.removeItem(STORAGE_KEY); }
    catch (e) { /* private browsing — key just won't persist */ }
  }

  var isPublic = MODE === 'public';
  var revealed = isPublic || !!getKey() || location.hash === '#kiln';
  if (!revealed) {
    // Allow reveal later in the session without a reload.
    window.addEventListener('hashchange', function () {
      if (location.hash === '#kiln') { revealed = true; mount(); }
    });
    return;
  }

  var host, root, panel, listEl, statusEl, textarea, launcher;

  var CSS = `
    :host { all: initial; }
    .launcher {
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
      width: 48px; height: 48px; border-radius: 50%; border: none; cursor: pointer;
      background: #1f2430; color: #fff; font-size: 20px; line-height: 1;
      box-shadow: 0 4px 18px rgba(0,0,0,.28);
      font-family: system-ui, sans-serif;
    }
    .launcher:hover { background: #2b3242; }
    .panel {
      position: fixed; right: 18px; bottom: 78px; z-index: 2147483000;
      width: min(390px, calc(100vw - 36px)); max-height: min(70vh, 640px);
      display: none; flex-direction: column; overflow: hidden;
      background: #fff; color: #1f2430; border-radius: 14px;
      box-shadow: 0 12px 44px rgba(0,0,0,.28);
      font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 14px;
    }
    .panel.open { display: flex; }
    header {
      background: #1f2430; color: #fff; padding: 12px 14px;
      display: flex; justify-content: space-between; align-items: center; gap: 8px;
    }
    header h2 { font-size: 14px; margin: 0; font-weight: 600; }
    header .sub { font-size: 11px; opacity: .7; margin-top: 1px; }
    header button {
      background: transparent; border: 1px solid rgba(255,255,255,.35); color: #fff;
      border-radius: 6px; padding: 3px 8px; font-size: 11px; cursor: pointer;
    }
    .body { padding: 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
    label { font-weight: 600; font-size: 12px; display: block; margin-bottom: 4px; }
    input, textarea {
      width: 100%; padding: 9px 10px; border: 1.5px solid #d6d9e0; border-radius: 8px;
      font: inherit; color: #1f2430; background: #fff; resize: vertical;
    }
    input:focus, textarea:focus { outline: 2px solid #4f6bed; border-color: #4f6bed; }
    .btn {
      background: #4f6bed; color: #fff; border: none; border-radius: 8px;
      padding: 9px 14px; font: inherit; font-weight: 600; cursor: pointer;
    }
    .btn:hover { background: #3f57cc; }
    .btn:disabled { opacity: .55; cursor: default; }
    .status { font-size: 12px; min-height: 16px; }
    .status.err { color: #c02626; }
    .status.ok { color: #1a7f45; }
    .hint { font-size: 11.5px; color: #676d7a; line-height: 1.5; }
    ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
    li { border: 1px solid #e6e8ee; border-radius: 8px; padding: 8px 10px; }
    li .meta { font-size: 11px; color: #757a86; margin-top: 3px; }
    .tag { display: inline-block; border-radius: 999px; padding: 1px 7px; font-size: 10.5px; font-weight: 700; }
    .tag.open { background: #eef1fb; color: #3f57cc; }
    .tag.doing { background: #fdf1da; color: #8a5a12; }
    .tag.done { background: #e8f5ec; color: #1a7f45; }
    .done-text { text-decoration: line-through; opacity: .65; }
    h3 { font-size: 12px; margin: 4px 0 0; text-transform: uppercase; letter-spacing: .07em; color: #757a86; }
  `;

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (child) { node.appendChild(child); });
    return node;
  }

  function setStatus(message, kind) {
    statusEl.textContent = message || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function api(path, options) {
    var opts = options || {};
    var headers = { 'Content-Type': 'application/json' };
    var key = getKey();
    if (key) headers['X-Kiln-Key'] = key;
    return fetch(API + '/sites/' + encodeURIComponent(SITE) + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
        return data;
      });
    });
  }

  function renderList(tickets) {
    listEl.innerHTML = '';
    if (!tickets.length) {
      listEl.appendChild(el('li', { text: 'No requests yet. Describe your first change above.' }));
      return;
    }
    tickets.slice().reverse().forEach(function (ticket) {
      var tag = el('span', { class: 'tag ' + ticket.status, text: ticket.status });
      var text = el('div', { text: ticket.text });
      if (ticket.status === 'done') text.className = 'done-text';
      var meta = el('div', { class: 'meta', text: '#' + ticket.id + ' · ' + (ticket.submitted || '').slice(0, 16).replace('T', ' ') });
      listEl.appendChild(el('li', {}, [tag, text, meta]));
    });
  }

  function refresh() {
    return api('/requests')
      .then(function (data) { renderList(data.tickets || []); })
      .catch(function (error) { setStatus(error.message, 'err'); });
  }

  function submit() {
    var text = textarea.value.trim();
    if (!text) { setStatus('Describe the change you want.', 'err'); return; }
    setStatus('Sending…');
    api('/requests', { method: 'POST', body: { text: text } })
      .then(function () {
        textarea.value = '';
        setStatus('Request filed. It’s in the queue.', 'ok');
        return refresh();
      })
      .catch(function (error) { setStatus(error.message, 'err'); });
  }

  function buildUnlock(body) {
    var input = el('input', { type: 'password', placeholder: 'Paste your owner key', autocomplete: 'off' });
    var button = el('button', { class: 'btn', text: 'Unlock' });
    function attempt() {
      var value = input.value.trim();
      if (!value) return;
      setKey(value);
      setStatus('Checking…');
      api('/requests')
        .then(function (data) { setStatus(''); buildPanel(); renderList(data.tickets || []); })
        .catch(function (error) { setKey(''); setStatus(error.message, 'err'); });
    }
    button.addEventListener('click', attempt);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') attempt(); });
    body.appendChild(el('div', {}, [el('label', { text: 'Owner key' }), input]));
    body.appendChild(button);
    body.appendChild(statusEl);
    body.appendChild(el('p', {
      class: 'hint',
      text: 'Your owner key was given to you when this site was created. It stays in this browser only — anyone without it just sees the site.',
    }));
  }

  function buildPanel() {
    var body = panel.querySelector('.body');
    body.innerHTML = '';
    textarea = el('textarea', { rows: '3', placeholder: 'e.g. Make the header photo bigger, and add a services page' });
    var send = el('button', { class: 'btn', text: 'File request' });
    send.addEventListener('click', submit);
    body.appendChild(el('div', {}, [el('label', { text: 'What would you like changed?' }), textarea]));
    body.appendChild(send);
    body.appendChild(statusEl);
    body.appendChild(el('h3', { text: 'Queue' }));
    listEl = el('ul', {});
    body.appendChild(listEl);
    body.appendChild(el('p', {
      class: 'hint',
      text: 'Requests are picked up and built by hand — you’ll see them move from open to done here.',
    }));
    refresh();
  }

  function buildLocked() {
    var body = panel.querySelector('.body');
    body.innerHTML = '';
    buildUnlock(body);
  }

  function toggle(open) {
    var isOpen = open === undefined ? !panel.classList.contains('open') : open;
    panel.classList.toggle('open', isOpen);
    launcher.setAttribute('aria-expanded', String(isOpen));
    if (isOpen && !isPublic && !getKey()) buildLocked();
    else if (isOpen) buildPanel();
  }

  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.setAttribute('data-kiln-overlay', '');
    document.body.appendChild(host);
    root = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    statusEl = el('div', { class: 'status' });

    launcher = el('button', {
      class: 'launcher',
      title: 'Site controls',
      'aria-label': 'Open site controls',
      'aria-expanded': 'false',
      text: '✦',
    });
    launcher.addEventListener('click', function () { toggle(); });

    var lockBtn = el('button', { text: 'Lock', title: 'Forget the owner key on this device' });
    lockBtn.addEventListener('click', function () {
      setKey('');
      setStatus('Key cleared.', 'ok');
      buildLocked();
    });

    panel = el('div', { class: 'panel', role: 'dialog', 'aria-label': 'Site controls' }, [
      el('header', {}, [
        el('div', {}, [
          el('h2', { text: 'Site controls' }),
          el('div', { class: 'sub', text: NAME }),
        ]),
        lockBtn,
      ]),
      el('div', { class: 'body' }),
    ]);

    root.appendChild(launcher);
    root.appendChild(panel);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') toggle(false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
