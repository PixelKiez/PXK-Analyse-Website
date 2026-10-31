/* Pixelkiez Analyse – kleine Verbesserungen für die Startseite.
   Das Formular wird normal per POST an /api/anfrage (API-Worker) gesendet; der Worker prüft Adresse und AGB-Zustimmung verbindlich.
   Hier nur eine Vorabprüfung, damit Tippfehler und ein fehlendes AGB-Häkchen ohne Seitenwechsel auffallen; dann wird nichts gesendet. */
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

  /* Sanftes Einblenden beim Scrollen: nur Elemente, die beim Laden unterhalb des Bildschirms liegen (oben flackert nichts),
     Karten einer Reihe leicht versetzt. Ohne JavaScript oder bei „Bewegung reduzieren“ bleibt alles sofort sichtbar. */
  if (!reduce && 'IntersectionObserver' in window) {
    const targets = ['.section-head', '.split > *', '.showcase-media', '.steps > *', '.spec--cards > *', '.uses > *', '.why > *', '.plans > *', '.faq details', '.tools > *', '.crosssell', '.closing > *'];
    const reveal = new IntersectionObserver(entries => entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('is-visible'); reveal.unobserve(e.target); }
    }), { rootMargin: '0px 0px -8% 0px' });
    document.querySelectorAll(targets.join(',')).forEach(el => {
      if (el.getBoundingClientRect().top <= innerHeight) return;
      el.style.setProperty('--reveal-delay', `${Math.min([...el.parentElement.children].indexOf(el), 4) * 70}ms`);
      el.classList.add('reveal');
      reveal.observe(el);
    });
  }

  /* Videos (unter dem Hero und bei „Ihr Bericht“): starten, sobald sie ins Bild scrollen, und laufen dann in Schleife.
     Außerhalb des Bildes angehalten (spart Akku und Daten); bei „Bewegung reduzieren“ bleibt das Standbild. */
  const videos = document.querySelectorAll('.showcase-video');
  /* Kann der Browser ein Video nicht laden (z. B. Safari/iOS, wenn der Server Range-Anfragen nicht mit 206 beantwortet),
     steht statt einer schwarzen Fläche das Standbild (Poster) da: gleiche Klasse, gleiche Größe, gleicher Alternativtext. */
  videos.forEach(v => {
    const toStill = () => {
      if (!v.isConnected || !v.poster) return;
      const still = new Image(v.width, v.height);
      still.src = v.poster;
      still.alt = v.getAttribute('aria-label') || '';
      still.className = v.className;
      v.pause();
      v.replaceWith(still);
    };
    const source = v.querySelector('source');
    if (source) source.addEventListener('error', toStill);
    /* Ist das Laden schon gescheitert, bevor dieses Skript lief, kam das error-Ereignis zu früh */
    if (v.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) toStill();
  });
  if (videos.length && !reduce && 'IntersectionObserver' in window) {
    /* intersectionRatio > 0: Ein Video, das nur an den Bildschirmrand stößt, gilt noch nicht als sichtbar */
    const io = new IntersectionObserver(entries => entries.forEach(e => {
      if (e.intersectionRatio > 0) e.target.play().catch(() => {}); else e.target.pause();
    }), { threshold: [0, 0.01] });
    videos.forEach(v => io.observe(v));
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

  /* Vorabprüfung: Host mit Punkt, optional mit http(s):// und Pfad; AGB-Häkchen gesetzt */
  const agb = $('#agb'), submit = form.querySelector('button[type=submit]');
  const host = v => v.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  const valid = v => v.trim().length <= 2048 && !/[\s<>"`\\]/.test(v.trim()) && /^[a-z0-9äöüß-]+(\.[a-z0-9äöüß-]+)+$/.test(host(v));
  /* Fehlertext ein-/ausblenden und am Feld verknüpfen */
  const mark = (field, ok) => {
    const id = `${field.id}-error`;
    $('#' + id).hidden = ok;
    if (ok) { field.removeAttribute('aria-invalid'); field.removeAttribute('aria-describedby'); }
    else { field.setAttribute('aria-invalid', 'true'); field.setAttribute('aria-describedby', id); }
    return ok;
  };
  let sending = false;

  form.addEventListener('submit', e => {
    const urlOk = mark(input, valid(input.value));
    const agbOk = !agb || mark(agb, agb.checked);
    /* Doppelklick: nur die erste gültige Absendung geht zu Google */
    if (urlOk && agbOk && !sending) {
      sending = true;
      if (submit) submit.disabled = true;
      return;
    }
    e.preventDefault();
    if (!urlOk) input.focus();
    /* Der Fokus holt nur das Häkchen ins Bild; auf kleinen Bildschirmen (320×568) läge der Fehlertext darunter noch außerhalb */
    else if (!agbOk) { agb.focus(); $('#agb-error').scrollIntoView({ block: 'nearest' }); }
  });
  if (agb) agb.addEventListener('change', () => { if (agb.checked) mark(agb, true); });
  /* Zurück aus der Google-Anmeldung (Seite aus dem Verlauf): Formular wieder benutzbar */
  addEventListener('pageshow', () => { sending = false; if (submit) submit.disabled = false; });

  /* Abschluss-Button: zurück zum Feld */
  const toTop = $('#to-top');
  if (toTop) toTop.addEventListener('click', () => {
    scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    setTimeout(() => input.focus({ preventScroll: true }), reduce ? 0 : 600);
  });
})();
