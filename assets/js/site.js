/* Fully Logistics: site behaviour. Vanilla JS, no dependencies.
   Progressive enhancement: every page reads and links correctly without this file. */
(() => {
  'use strict';

  const root = document.documentElement;
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------------------------------------------------------------- theme */
  const THEME_KEY = 'fl-theme';
  const themeBtn = $('[data-theme-toggle]');
  const readSaved = () => {
    try { return localStorage.getItem(THEME_KEY); } catch (err) { return null; }
  };
  const applyTheme = (theme, persist) => {
    root.dataset.theme = theme;
    if (persist) {
      try { localStorage.setItem(THEME_KEY, theme); } catch (err) { /* storage unavailable */ }
    }
    if (themeBtn) {
      themeBtn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    }
  };
  if (themeBtn) {
    applyTheme(root.dataset.theme === 'dark' ? 'dark' : 'light', false);
    themeBtn.addEventListener('click', () => applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark', true));
  }
  // Follow the OS setting until the visitor makes an explicit choice.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!readSaved()) applyTheme(e.matches ? 'dark' : 'light', false);
  });

  /* ------------------------------------------------- header scrolled state */
  const header = $('[data-header]');
  if (header && 'IntersectionObserver' in window) {
    const sentinel = document.createElement('div');
    sentinel.setAttribute('aria-hidden', 'true');
    sentinel.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:1px;pointer-events:none';
    document.body.prepend(sentinel);
    new IntersectionObserver(([entry]) => {
      header.dataset.scrolled = String(!entry.isIntersecting);
    }).observe(sentinel);
  }

  /* ----------------------------------------------------- desktop dropdown */
  const canHover = window.matchMedia('(hover: hover) and (pointer: fine)');
  $$('.has-menu').forEach((item) => {
    const btn = $('button', item);
    if (!btn) return;
    const setOpen = (open) => {
      item.dataset.open = String(open);
      btn.setAttribute('aria-expanded', String(open));
    };
    btn.addEventListener('click', () => setOpen(canHover.matches ? true : item.dataset.open !== 'true'));
    item.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && canHover.matches) setOpen(true); });
    item.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && canHover.matches) setOpen(false); });
    item.addEventListener('focusout', (e) => { if (!item.contains(e.relatedTarget)) setOpen(false); });
    document.addEventListener('click', (e) => { if (!item.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && item.dataset.open === 'true') {
        setOpen(false);
        btn.focus();
      }
    });
  });

  /* ---------------------------------------------------------- mobile nav */
  const navToggle = $('[data-nav-toggle]');
  const mobileNav = $('#mobile-nav');
  if (navToggle && mobileNav) {
    const setNav = (open) => {
      navToggle.setAttribute('aria-expanded', String(open));
      navToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      mobileNav.hidden = !open;
    };
    navToggle.addEventListener('click', () => setNav(mobileNav.hidden));
    mobileNav.addEventListener('click', (e) => { if (e.target.closest('a')) setNav(false); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !mobileNav.hidden) {
        setNav(false);
        navToggle.focus();
      }
    });
    window.matchMedia('(min-width: 900px)').addEventListener('change', (e) => { if (e.matches) setNav(false); });
  }

  /* --------------------------------------------------------- scroll reveal */
  const revealEls = $$('[data-reveal]');
  if (revealEls.length) {
    if (reduceMotion.matches || !('IntersectionObserver' in window)) {
      revealEls.forEach((el) => el.classList.add('is-in'));
    } else {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
      revealEls.forEach((el) => io.observe(el));
    }
  }

  /* ---------------------------------------------------------- count-up stats
     The final figure is always present in the HTML. It counts up once, when
     the number scrolls into view, and settles back on the exact original text. */
  const counters = $$('[data-count]');
  if (counters.length && !reduceMotion.matches && 'IntersectionObserver' in window) {
    const run = (el) => {
      const target = parseFloat(el.dataset.count);
      const decimals = parseInt(el.dataset.decimals || '0', 10);
      const prefix = el.dataset.prefix || '';
      const suffix = el.dataset.suffix || '';
      const finalText = el.textContent;
      const fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      const duration = 1300;
      const start = performance.now();
      const tick = (now) => {
        const p = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        if (p < 1) {
          el.textContent = prefix + fmt.format(target * eased) + suffix;
          requestAnimationFrame(tick);
        } else {
          el.textContent = finalText;
        }
      };
      requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        io.unobserve(entry.target);
        run(entry.target);
      });
    }, { threshold: 0.6 });
    counters.forEach((el) => io.observe(el));
  }

  /* ------------------------------------------------------------------ tabs */
  $$('[data-tabs]').forEach((tabs) => {
    const list = $('[role="tablist"]', tabs);
    if (!list) return;
    const tabEls = $$('[role="tab"]', list);
    const panels = tabEls.map((t) => document.getElementById(t.getAttribute('aria-controls')));
    if (!tabEls.length || panels.some((p) => !p)) return;

    list.hidden = false;
    tabs.classList.add('is-ready');
    panels.forEach((panel, i) => {
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tabEls[i].id);
      panel.tabIndex = 0;
    });

    const select = (index, { focus = false, animate = false } = {}) => {
      tabEls.forEach((tab, i) => {
        const on = i === index;
        tab.setAttribute('aria-selected', String(on));
        tab.tabIndex = on ? 0 : -1;
        panels[i].hidden = !on;
      });
      if (focus) tabEls[index].focus();
      if (animate && !reduceMotion.matches && panels[index].animate) {
        panels[index].animate(
          [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
          { duration: 380, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
        );
      }
    };

    tabEls.forEach((tab, i) => {
      tab.addEventListener('click', () => select(i, { animate: true }));
      tab.addEventListener('keydown', (e) => {
        const last = tabEls.length - 1;
        let next = null;
        if (e.key === 'ArrowRight') next = i === last ? 0 : i + 1;
        else if (e.key === 'ArrowLeft') next = i === 0 ? last : i - 1;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = last;
        if (next === null) return;
        e.preventDefault();
        select(next, { focus: true, animate: true });
      });
    });
    select(0);
  });

  /* ------------------------------------------------------------ contact form
     Validates inline. With data-endpoint set (Formspree, Netlify, your own API) it posts
     the form there. With no endpoint it hands the request to the visitor's email app,
     so nothing is ever reported as "sent" when it was not. */
  const form = $('[data-form]');
  if (form) {
    const status = $('[data-status]', form);
    const submit = $('[data-submit]', form);
    const success = $('[data-success]', form);
    const messages = {
      name: 'Please enter your name.',
      email: 'Please enter a valid email address.',
      message: 'Please tell us a little about what you ship.',
      consent: 'Please tick the box so we can contact you.',
    };

    const setStatus = (text, tone) => {
      if (!status) return;
      status.textContent = text;
      status.dataset.tone = tone || '';
    };
    const setBusy = (busy) => {
      if (!submit) return;
      if (busy) submit.setAttribute('aria-busy', 'true');
      else submit.removeAttribute('aria-busy');
    };
    const setError = (input, msg) => {
      const field = input.closest('[data-field]');
      if (!field) return;
      const err = $('.field__error', field);
      field.dataset.invalid = msg ? 'true' : 'false';
      if (msg) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
      if (err) {
        err.hidden = !msg;
        const text = $('span', err);
        if (text) text.textContent = msg || '';
      }
    };
    const check = (input) => {
      const msg = input.checkValidity() ? '' : messages[input.name] || 'Please check this field.';
      setError(input, msg);
      return !msg;
    };

    const required = $$('[required]', form);
    required.forEach((input) => {
      input.addEventListener('blur', () => {
        if (input.type === 'checkbox' || input.value.trim()) check(input);
      });
      const revalidate = () => {
        const field = input.closest('[data-field]');
        if (field && field.dataset.invalid === 'true') check(input);
      };
      input.addEventListener('input', revalidate);
      input.addEventListener('change', revalidate);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const invalid = required.filter((input) => !check(input));
      if (invalid.length) {
        invalid[0].focus();
        setStatus('Please fix the highlighted fields and try again.', 'error');
        return;
      }
      setStatus('', '');
      setBusy(true);

      const data = new FormData(form);
      const endpoint = form.dataset.endpoint;
      const inbox = form.dataset.email;

      if (endpoint) {
        try {
          const res = await fetch(endpoint, { method: 'POST', body: data, headers: { Accept: 'application/json' } });
          if (!res.ok) throw new Error(String(res.status));
          form.dataset.state = 'success';
          if (success) {
            success.hidden = false;
            success.focus();
          }
        } catch (err) {
          setStatus(`Something went wrong and your request was not sent. Please try again, or email us at ${inbox}.`, 'error');
        } finally {
          setBusy(false);
        }
        return;
      }

      const lines = [
        `Name: ${data.get('name')}`,
        `Email: ${data.get('email')}`,
        `Company: ${data.get('company') || '-'}`,
        `Phone: ${data.get('phone') || '-'}`,
        `I am a: ${data.get('role') || '-'}`,
        `Monthly volume: ${data.get('volume') || '-'}`,
        '',
        String(data.get('message') || ''),
      ];
      const subject = `Quote request from ${data.get('company') || data.get('name')}`;
      window.location.href = `mailto:${inbox}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
      setStatus(`Your email app should open with the request ready to send. If it does not, write to ${inbox}.`, 'ok');
      setBusy(false);
    });
  }
})();
