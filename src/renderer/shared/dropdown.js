'use strict';

/**
 * The app's own dropdown.
 *
 * A native <select> renders with the OS widget, which on Windows is a white
 * box with a grey chevron and system-blue highlight. On a near-black surface
 * that is the single most obviously foreign thing in the interface: the
 * onboarding language picker was a white rectangle in the middle of a dark
 * card. It also cannot be themed, so it ignores the palette entirely and does
 * not follow the per-game accent.
 *
 * This replaces it with a button plus a list, both built from the same tokens
 * as everything else.
 *
 * IT IS NOT A DIV PRETENDING TO BE A SELECT. The native control brings
 * keyboard support, focus handling and screen reader semantics for free, and
 * dropping those to gain a colour is a bad trade. So the button carries
 * role="combobox" with aria-expanded, the list is a role="listbox" of
 * role="option", arrow keys and Home/End move the highlight, Enter and Space
 * commit, Escape closes and returns focus, and typing a letter jumps to the
 * next option starting with it.
 *
 * Usage:
 *   const dd = Dropdown.create(mountEl, {
 *     options: [{ value: 'en', label: 'English' }],
 *     value: 'en',
 *     onChange: (v) => {},
 *   });
 *   dd.setOptions(list); dd.setValue(v); dd.value;
 */
(function (root) {

  const OPEN_CLASS = 'dd-open';
  let openInstance = null;   // only one list open at a time, app-wide

  function create(mount, opts) {
    const o = opts || {};
    let options = [];
    let value = null;
    let highlighted = -1;
    let typeahead = '';
    let typeaheadTimer = null;

    mount.classList.add('dd');
    mount.replaceChildren();

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dd-btn';
    btn.setAttribute('role', 'combobox');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-haspopup', 'listbox');
    if (o.label) btn.setAttribute('aria-label', o.label);

    const text = document.createElement('span');
    text.className = 'dd-text';

    const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chev.setAttribute('class', 'dd-chev');
    chev.setAttribute('viewBox', '0 0 24 24');
    chev.setAttribute('fill', 'none');
    chev.setAttribute('stroke', 'currentColor');
    chev.setAttribute('stroke-width', '2.2');
    chev.setAttribute('stroke-linecap', 'round');
    chev.setAttribute('stroke-linejoin', 'round');
    const chevPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    chevPath.setAttribute('d', 'M6 9l6 6 6-6');
    chev.appendChild(chevPath);

    btn.append(text, chev);

    const list = document.createElement('div');
    list.className = 'dd-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;

    mount.append(btn, list);

    const current = () => options.find((x) => x.value === value) || null;

    function paintButton() {
      const c = current();
      // `short` lets a cramped trigger say "Rivals" while the list still says
      // "Marvel Rivals". The panel header has about 90px for this control.
      text.textContent = c ? (c.short || c.label) : (o.placeholder || '');
      mount.classList.toggle('dd-empty', !c);
    }

    function buildList() {
      list.replaceChildren();
      options.forEach((opt, i) => {
        const row = document.createElement('div');
        row.className = 'dd-opt';
        row.setAttribute('role', 'option');
        row.setAttribute('data-value', opt.value);
        row.setAttribute('aria-selected', String(opt.value === value));
        if (opt.note) row.title = opt.note;

        const lab = document.createElement('span');
        lab.className = 'dd-opt-label';
        lab.textContent = opt.label;
        row.appendChild(lab);

        if (opt.tag) {
          const tag = document.createElement('span');
          tag.className = 'dd-opt-tag';
          tag.textContent = opt.tag;
          row.appendChild(tag);
        }

        // Pointer down rather than click: click fires AFTER the document
        // listener that closes the list, so the selection would be lost.
        row.addEventListener('mousedown', (e) => { e.preventDefault(); commit(i); });
        row.addEventListener('mouseenter', () => highlight(i));
        list.appendChild(row);
      });
    }

    function highlight(i) {
      highlighted = i;
      const rows = list.children;
      for (let n = 0; n < rows.length; n++) rows[n].classList.toggle('dd-hi', n === i);
      if (rows[i]) rows[i].scrollIntoView({ block: 'nearest' });
    }

    /**
     * Position the list against the VIEWPORT, not the trigger's parent.
     *
     * Absolute positioning cannot escape an ancestor that scrolls, and the
     * Settings body is `overflow-y: auto`: the language list was simply clipped
     * where the panel ended. Fixed coordinates computed from the button's rect
     * are the only thing that works in both a scrolling page and the short
     * panel window.
     */
    function place() {
      const r = btn.getBoundingClientRect();
      list.style.position = 'fixed';
      list.style.minWidth = Math.round(r.width) + 'px';
      list.style.left = '0px';
      list.style.top = '0px';
      list.style.right = 'auto';
      list.style.bottom = 'auto';

      const h = list.offsetHeight;
      const w = list.offsetWidth;
      const GAP = 4, EDGE = 8;
      // Flip up only when there is genuinely more room above: dropping upward
      // into an equally tight space just moves the clipping.
      const below = window.innerHeight - r.bottom - GAP;
      const above = r.top - GAP;
      const up = below < h && above > below;
      mount.classList.toggle('dd-up', up);

      let left = r.left;
      // Right-align when the trigger sits near the right edge, which is where
      // the panel header picker lives.
      if (left + w > window.innerWidth - EDGE) left = r.right - w;
      left = Math.max(EDGE, Math.min(left, window.innerWidth - w - EDGE));

      list.style.left = Math.round(left) + 'px';
      list.style.top = up ? Math.round(Math.max(EDGE, r.top - GAP - h)) + 'px'
                          : Math.round(r.bottom + GAP) + 'px';
    }

    function open() {
      if (!options.length || list.hidden === false) return;
      if (openInstance && openInstance !== api) openInstance.close();
      openInstance = api;
      buildList();
      list.hidden = false;
      mount.classList.add(OPEN_CLASS);
      btn.setAttribute('aria-expanded', 'true');
      place();
      // Any ancestor scrolling moves the trigger out from under the list, so
      // follow it. Capture phase catches scroll on every ancestor, not just
      // the document.
      window.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);
      highlight(Math.max(0, options.findIndex((x) => x.value === value)));
    }

    function close(refocus) {
      if (list.hidden) return;
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      list.hidden = true;
      mount.classList.remove(OPEN_CLASS, 'dd-up');
      btn.setAttribute('aria-expanded', 'false');
      if (openInstance === api) openInstance = null;
      if (refocus) btn.focus();
    }

    function commit(i) {
      const opt = options[i];
      close(true);
      if (!opt || opt.value === value) return;
      value = opt.value;
      paintButton();
      if (typeof o.onChange === 'function') o.onChange(value, opt);
    }

    btn.addEventListener('click', () => { list.hidden ? open() : close(false); });

    btn.addEventListener('keydown', (e) => {
      const isOpen = !list.hidden;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isOpen) { open(); return; }
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        highlight((highlighted + dir + options.length) % options.length);
      } else if (e.key === 'Home' && isOpen) { e.preventDefault(); highlight(0); }
      else if (e.key === 'End' && isOpen) { e.preventDefault(); highlight(options.length - 1); }
      else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (isOpen) commit(highlighted); else open();
      } else if (e.key === 'Escape' && isOpen) { e.preventDefault(); close(true); }
      else if (e.key === 'Tab' && isOpen) { close(false); }
      else if (isOpen && e.key.length === 1 && /\S/.test(e.key)) {
        typeahead += e.key.toLowerCase();
        clearTimeout(typeaheadTimer);
        typeaheadTimer = setTimeout(() => { typeahead = ''; }, 600);
        const hit = options.findIndex((x) => x.label.toLowerCase().startsWith(typeahead));
        if (hit >= 0) highlight(hit);
      }
    });

    // Close on any click elsewhere, and when the window loses focus: the panel
    // sits over a game, so an open list must never be left behind on alt-tab.
    document.addEventListener('mousedown', (e) => {
      if (!mount.contains(e.target)) close(false);
    });
    window.addEventListener('blur', () => close(false));

    const api = {
      get value() { return value; },
      setOptions(next, keepValue) {
        options = Array.isArray(next) ? next.slice() : [];
        if (!keepValue && !options.some((x) => x.value === value)) value = options.length ? options[0].value : null;
        paintButton();
        if (!list.hidden) buildList();
        return api;
      },
      setValue(v) {
        value = v;
        paintButton();
        if (!list.hidden) buildList();
        return api;
      },
      close: () => close(false),
      el: mount,
    };

    api.setOptions(o.options || [], true);
    if (o.value !== undefined) api.setValue(o.value);
    paintButton();
    return api;
  }

  root.Dropdown = { create };
}(window));
