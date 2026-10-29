/* Pixelkiez Analyse – statische Vorschau (PXK-154).
   Keine Analyse, kein Score, keine Übertragung und keine Speicherung der Eingabe. */
(() => {
  const $ = s => document.querySelector(s);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Navigation schrumpft beim Scrollen */
  const nav = $('#nav');
  if (nav) {
    const onScroll = () => nav.classList.toggle('is-scrolled', scrollY > 24);
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  const form = $('#analyze'), input = $('#url');
  if (!form || !input) return;

  /* Tippender Platzhalter im URL-Feld */
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

  /* Formular: gültige Adresse zeigt nur den Vorschau-Hinweis. Es wird nichts gesendet, geprüft oder gespeichert. */
  const PREVIEW = 'Vorschau – es wurde keine Anfrage versendet und keine Website geprüft.';
  const error = $('#url-error'), result = $('#result'), loading = $('#result-loading'), body = $('#result-body');
  const phase = $('#result-phase'), domain = $('#result-domain-loading'), progress = $('#progress');
  const normalize = v => v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  const valid = v => /^[a-z0-9äöüß-]+(\.[a-z0-9äöüß-]+)+$/.test(v);

  form.addEventListener('submit', e => {
    e.preventDefault();
    const ok = valid(normalize(input.value));
    error.hidden = ok;
    if (!ok) {
      result.hidden = true;
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', 'url-error');
      input.focus();
      return;
    }
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
    /* Alte Ring-/Fortschrittselemente bleiben als Layoutreferenz im Markup, werden aber nie als Ergebnis gezeigt. */
    body.hidden = true;
    progress.hidden = true;
    domain.textContent = '';
    phase.textContent = '';
    loading.hidden = false;
    result.hidden = false;
    /* Text erst nach dem Einblenden setzen, damit die Live-Region den Hinweis ansagt */
    requestAnimationFrame(() => { phase.textContent = PREVIEW; });
  });

  /* Abschluss-Button: zurück zum Feld */
  const toTop = $('#to-top');
  if (toTop) toTop.addEventListener('click', () => {
    scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    setTimeout(() => input.focus({ preventScroll: true }), reduce ? 0 : 600);
  });
})();
