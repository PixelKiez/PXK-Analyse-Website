/* Pixelkiez Analyse – Vision-Entwurf v2. Die Analyse ist eine Demo mit Beispieldaten. */
(() => {
  const $ = s => document.querySelector(s);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fmt = (n, d = 0) => n.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });

  /* Navigation schrumpft beim Scrollen */
  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('is-scrolled', scrollY > 24);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* Tippender Platzhalter im URL-Feld */
  const input = $('#url');
  const words = ['ihre-website.de', 'mein-shop.de', 'kanzlei-mueller.de', 'praxis-am-kiez.berlin'];
  if (!reduce) {
    let w = 0, c = words[0].length, dir = -1;
    const step = () => {
      const word = words[w];
      c += dir;
      input.placeholder = word.slice(0, c);
      let delay = dir > 0 ? 75 : 35;
      if (c >= word.length) { dir = -1; delay = 2000; }
      else if (c <= 0) { dir = 1; w = (w + 1) % words.length; delay = 350; }
      setTimeout(step, delay);
    };
    setTimeout(step, 2500);
  }

  /* Demo-Daten: festes Beispiel oder aus der Domain abgeleitete Werte */
  const BASE = { domain: 'kiez-kaffee.de', score: 70, lcp: 4.1, meta: 14 };
  const hash = s => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);
  const dataFor = domain => {
    if (domain === BASE.domain) return BASE;
    const h = hash(domain);
    return { domain, score: 38 + (h % 55), lcp: 2.7 + (h % 30) / 10, meta: 3 + (h % 21) };
  };
  const verdict = s => (s >= 90 ? 'Stark aufgestellt' : s >= 50 ? 'Solide Basis mit Baustellen' : 'Dringender Handlungsbedarf');

  const countUp = (el, to, dur = 1200) => {
    if (reduce) { el.textContent = fmt(to); return; }
    const t0 = performance.now();
    const tick = t => {
      const p = Math.min(1, (t - t0) / dur);
      el.textContent = fmt(Math.round(to * (1 - Math.pow(1 - p, 4))));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  /* Formular: Adresse prüfen, Demo-Ergebnis unter dem Feld zeigen */
  const result = $('#result'), loading = $('#result-loading'), body = $('#result-body');
  const progress = $('#progress'), phase = $('#result-phase'), ring = $('#result-ring');
  const phases = ['Seiten werden gecrawlt …', 'Ladezeit wird gemessen …', 'Barrierefreiheit wird geprüft …', 'Datenschutz wird geprüft …'];
  const normalize = v => v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  const valid = v => /^[a-z0-9äöüß-]+(\.[a-z0-9äöüß-]+)+$/.test(v);
  let runId = 0;

  $('#analyze').addEventListener('submit', e => {
    e.preventDefault();
    const domain = normalize(input.value) || BASE.domain;
    const error = $('#url-error');
    error.hidden = valid(domain);
    if (!error.hidden) { input.focus(); return; }

    const id = ++runId;
    const d = dataFor(domain);
    const wait = reduce ? 0 : 2300;
    result.hidden = false; loading.hidden = false; body.hidden = true;
    $('#result-domain-loading').textContent = d.domain;
    progress.classList.remove('is-running'); progress.offsetWidth; progress.classList.add('is-running');
    phases.forEach((p, i) => setTimeout(() => { if (id === runId) phase.textContent = p; }, (wait / phases.length) * i));

    setTimeout(() => {
      if (id !== runId) return;
      $('#result-domain').textContent = d.domain;
      $('#result-verdict').textContent = verdict(d.score);
      $('#result-lcp').textContent = `LCP ${fmt(d.lcp, 1)} s`;
      $('#result-meta').textContent = `${d.meta} Seiten ohne Meta-Beschreibung`;
      loading.hidden = true; body.hidden = false;
      ring.style.transition = 'none'; ring.style.strokeDashoffset = 175.93; ring.getBoundingClientRect(); ring.style.transition = '';
      requestAnimationFrame(() => { ring.style.strokeDashoffset = 175.93 * (1 - d.score / 100); });
      countUp($('#result-score'), d.score);
    }, wait);
  });

  /* Abschluss-Button: zurück zum Feld */
  $('#to-top').addEventListener('click', () => {
    scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    setTimeout(() => input.focus({ preventScroll: true }), reduce ? 0 : 600);
  });
})();
