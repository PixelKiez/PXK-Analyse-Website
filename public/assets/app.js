/* Pixelkiez Analyse – kleine Verbesserungen für die Startseite.
   Das Formular wird normal per POST an anfrage.php gesendet; der Server prüft die Adresse verbindlich.
   Hier nur eine Vorabprüfung, damit offensichtliche Tippfehler ohne Seitenwechsel auffallen. */
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

  /* Videos (unter dem Hero und bei „Ihr Bericht“): starten, sobald sie ins Bild scrollen, und laufen dann in Schleife.
     Außerhalb des Bildes angehalten (spart Akku und Daten); bei „Bewegung reduzieren“ bleibt das Standbild. */
  const videos = document.querySelectorAll('.showcase-video');
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

  /* Vorabprüfung: Host mit Punkt, optional mit http(s):// und Pfad */
  const error = $('#url-error');
  const host = v => v.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  const valid = v => v.trim().length <= 2048 && !/[\s<>"`\\]/.test(v.trim()) && /^[a-z0-9äöüß-]+(\.[a-z0-9äöüß-]+)+$/.test(host(v));

  form.addEventListener('submit', e => {
    const ok = valid(input.value);
    error.hidden = ok;
    if (ok) {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
      return;
    }
    e.preventDefault();
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', 'url-error');
    input.focus();
  });

  /* Abschluss-Button: zurück zum Feld */
  const toTop = $('#to-top');
  if (toTop) toTop.addEventListener('click', () => {
    scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    setTimeout(() => input.focus({ preventScroll: true }), reduce ? 0 : 600);
  });
})();
