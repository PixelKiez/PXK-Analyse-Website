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

  /* Menüs in der Navigation (Wissen-Beiträge, mobiles Menü) sind <details> und öffnen auch ohne JavaScript.
     Hier schließen sie zusätzlich bei einem Klick daneben, nach der Wahl eines Links und mit Escape (Fokus zurück auf den Auslöser). */
  const menus = document.querySelectorAll('.nav details');
  document.addEventListener('click', e => menus.forEach(d => {
    if (d.open && (!d.contains(e.target) || e.target.closest('.mega-panel a, .nav-menu-panel a'))) d.open = false;
  }));
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    menus.forEach(d => {
      if (!d.open) return;
      d.open = false;
      if (d.contains(document.activeElement)) d.querySelector('summary').focus();
    });
  });

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

  /* Videos (historische Demo unter dem Hero, „Ein PDF. Sieben Seiten.“, „Jeder Befund verständlich erklärt.“): starten, sobald sie ins
     Bild scrollen, und laufen in Schleife; außerhalb des Bildes angehalten (spart Akku und Daten). Eigene Schaltfläche statt der
     Browser-Leiste (die bräuchte in WebKit Symbole aus blob:-Adressen, die die CSP sperrt): Abspielen/Anhalten jederzeit per Klick oder
     Tippen auf das Video.
     Lehnt der Browser den automatischen Start ab (iOS-Stromsparmodus, Datensparen, Autoplay-Sperre: play() wird abgelehnt) oder ist
     „Bewegung reduzieren“ eingestellt, steht mittig „Abspielen“ da; gestartet wird dann durch Tippen (echte Nutzergeste).
     Scheitert das Laden (Netz, Kontingent, R2), bleibt das Standbild (Poster) mit Hinweis und „Erneut versuchen“ – nie eine schwarze
     Fläche und nie ein Standbild ohne Bedienung. */
  const ICON = {
    play: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.5 2.5v11l9-5.5z"/></svg>',
    pause: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 2.5h3v11H4zm5 0h3v11H9z"/></svg>',
  };
  const players = [...document.querySelectorAll('.showcase-video')].map(v => {
    const frame = v.closest('.showcase-frame');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'video-toggle';
    const note = document.createElement('p');
    note.className = 'video-hinweis';
    note.textContent = 'Das Video konnte gerade nicht geladen werden.';
    frame.append(note, button);
    /* auto: automatischer Start erlaubt; started: einmal per Geste gestartet; stopped: per Schaltfläche angehalten; failed: Ladefehler;
       refused: der letzte automatische Start wurde abgelehnt (dann „Abspielen“; beim nächsten Hineinscrollen neuer Versuch) */
    const p = { v, auto: !reduce, started: false, stopped: false, failed: false, refused: false };
    const render = () => {
      const playing = !v.paused && !v.ended;
      const wait = !playing && (p.stopped || p.failed || p.refused || !(p.auto || p.started));
      frame.classList.toggle('is-playing', playing);
      frame.classList.toggle('braucht-start', wait);
      note.hidden = !p.failed;
      button.setAttribute('aria-label', playing ? 'Video anhalten' : p.failed ? 'Video erneut laden und abspielen' : 'Video abspielen');
      button.innerHTML = (playing ? ICON.pause : ICON.play) + (wait ? `<span>${p.failed ? 'Erneut versuchen' : 'Abspielen'}</span>` : '');
    };
    const fail = () => { p.failed = true; v.pause(); render(); };
    p.play = gesture => {
      const run = v.play();
      if (run) run.then(() => { p.failed = p.refused = false; render(); }, err => {
        /* Ohne Geste abgelehnt (Stromsparmodus, Autoplay-Sperre; WebKit mobil auch, solange das Video kaum sichtbar ist): „Abspielen“
           zeigen, beim nächsten Hineinscrollen erneut versuchen. Abgebrochen (pause() oder load() kam dazwischen): kein Fehler. */
        if (err && err.name === 'NotAllowedError') { if (!gesture) p.refused = true; }
        else if (!err || err.name !== 'AbortError') p.failed = true;
        render();
      });
    };
    /* Klick oder Tippen auf das Video oder die Schaltfläche (Tastatur: Schaltfläche) */
    frame.addEventListener('click', () => {
      if (!v.paused && !v.ended) { p.stopped = true; v.pause(); return; }
      p.stopped = false;
      p.started = true;
      if (p.failed) { p.failed = false; v.load(); }
      p.play(true);
    });
    ['play', 'playing', 'pause', 'ended', 'emptied'].forEach(t => v.addEventListener(t, render));
    v.addEventListener('error', fail);
    const source = v.querySelector('source');
    if (source) source.addEventListener('error', fail);
    /* Ist das Laden schon gescheitert, bevor dieses Skript lief, kam das error-Ereignis zu früh. NETWORK_NO_SOURCE allein beweist
       das nicht: Während der Quellenauswahl steht der Wert kurz ebenfalls dort (WebKit unter Last). load() startet die Auswahl neu;
       scheitert sie wirklich, kommt das error-Ereignis jetzt beim Listener an (bei preload="none" ohne Download). */
    if (v.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) v.load();
    render();
    return p;
  });
  if (players.length && 'IntersectionObserver' in window) {
    /* Automatisch starten erst ab 20 % im Bild: WebKit mobil lehnt play() für ein Video ab, das nur an den Bildschirmrand stößt
       (Hero-Video beim Laden genau an der Unterkante). Ganz aus dem Bild: anhalten. Dazwischen nichts ändern. */
    const io = new IntersectionObserver(entries => entries.forEach(e => {
      const p = players.find(x => x.v === e.target);
      if (e.intersectionRatio >= 0.2) { if ((p.auto || p.started) && !p.stopped && !p.failed && e.target.paused) p.play(false); }
      else if (e.intersectionRatio === 0 && !e.target.paused) e.target.pause();
    }), { threshold: [0, 0.2, 0.6] });
    players.forEach(p => io.observe(p.v));
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
