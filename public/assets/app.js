/* Pixelkiez Analyse – kleine Verbesserungen für die Startseite.
   Das Hero-Formular („Analysieren“) wird normal per POST an /api/anfrage (API-Worker) gesendet; der Worker prüft die Adresse
   verbindlich und zeigt danach die Bestätigungsseite (ein Kästchen, dann Google). Hier nur eine Vorabprüfung, damit Tippfehler
   ohne Seitenwechsel auffallen; dann wird nichts gesendet. */
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

  /* Videos (historische Demo unter dem Hero, „Ein PDF. Sieben Seiten.“, „Jeder Befund verständlich erklärt.“): stumm, inline, in
     Endlosschleife, ohne Bedienelemente – niemals Play-/Pause-Schaltflächen (Entscheidungen des Auftraggebers 04.11.2026). Im HTML
     steht muted loop playsinline, bewusst ohne autoplay: Für autoplay-Videos, die nicht laufen dürfen (iOS-/macOS-Stromsparmodus),
     blendet WebKit eigene Play-/Pause-Bedienelemente ein. Gestartet wird nur hier: sobald ein Video zu mindestens 20 % im Bild ist (WebKit
     mobil lehnt play() für ein Video ab, das nur an den Bildschirmrand stößt), Halt erst ganz außerhalb (Akku, Daten), neuer Versuch
     nach Tabwechsel (visibilitychange), Zurück-Navigation (pageshow) und wiederkehrendem Netz (online). Browser-Regeln werden nicht
     umgangen: Lehnt der Browser ab (iOS-Stromsparmodus, Autoplay-Sperre) oder scheitert das Laden, bleibt das Standbild (Poster)
     ohne Schaltfläche. Der Zustand steht zur Diagnose in data-wiedergabe (läuft, angehalten, abgelehnt: <Grund>, Ladefehler,
     Bewegung reduziert). Bei „Bewegung reduzieren“ kein automatischer Start (Systemeinstellung des Nutzers). Im iOS-Stromsparmodus
     startet WebKit ein Video nur nach einer Nutzergeste: Tippen (oder Klicken) auf das Video startet es, ohne Schaltfläche; danach
     darf WebKit dasselbe Video wieder per Skript starten, es hält also beim Hinausscrollen an und läuft beim Hineinscrollen weiter
     (Rückmeldung des Auftraggebers 04.11.2026: „Die Videos in der mobilen Ansicht laufen nicht.“). */
  const videos = [...document.querySelectorAll('.showcase-video')];
  const sichtbar = new Set(), bekannt = new Set();
  const zustand = (v, z) => { v.dataset.wiedergabe = z; };
  const start = v => {
    if (reduce || !sichtbar.has(v) || document.visibilityState !== 'visible' || !v.paused) return;
    abspielen(v);
  };
  const abspielen = v => {
    /* Nach einem Ladefehler die Quelle neu wählen (z. B. wieder online) */
    if (v.error || v.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) v.load();
    const run = v.play();
    /* Abgelehnt (NotAllowedError: Stromsparmodus, Autoplay-Sperre) festhalten; abgebrochen (pause() kam dazwischen) ist kein Fehler,
       ein Ladefehler bleibt als solcher stehen */
    if (run) run.catch(err => {
      const grund = err ? err.name : 'unbekannt';
      if (v.paused && grund !== 'AbortError' && v.dataset.wiedergabe !== 'Ladefehler') zustand(v, `abgelehnt: ${grund}`);
    });
  };
  videos.forEach(v => {
    v.muted = v.defaultMuted = true;
    v.playsInline = true;
    v.loop = true;
    v.controls = false;
    v.autoplay = false;
    v.addEventListener('playing', () => zustand(v, 'läuft'));
    /* Ein Video, das außerhalb des Bildes startet, wieder anhalten; es startet beim Hineinscrollen */
    v.addEventListener('play', () => { if (bekannt.has(v) && !sichtbar.has(v)) v.pause(); });
    v.addEventListener('pause', () => { if (!v.error && v.dataset.wiedergabe === 'läuft') zustand(v, 'angehalten'); });
    const fehler = () => zustand(v, 'Ladefehler');
    v.addEventListener('error', fehler);
    const source = v.querySelector('source');
    if (source) source.addEventListener('error', fehler);
    /* Tippen auf ein stehendes Video startet es (Nutzergeste, auch bei „Bewegung reduzieren“ als ausdrückliche Wahl). Wer tippt,
       sieht das Video: als sichtbar führen, damit der play-Listener oben es nicht gleich wieder anhält. */
    v.addEventListener('click', () => { if (v.paused) { sichtbar.add(v); abspielen(v); } });
    if (reduce) { v.pause(); zustand(v, 'Bewegung reduziert'); return; }
    /* Ist das Laden schon gescheitert, bevor dieses Skript lief, kam das error-Ereignis zu früh. NETWORK_NO_SOURCE allein beweist
       das nicht: Während der Quellenauswahl steht der Wert kurz ebenfalls dort (WebKit unter Last). load() startet die Auswahl neu;
       scheitert sie wirklich, kommt das error-Ereignis jetzt beim Listener an. */
    if (v.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) v.load();
  });
  if (videos.length && !reduce && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(entries => entries.forEach(e => {
      const v = e.target;
      bekannt.add(v);
      if (e.intersectionRatio >= 0.2) { sichtbar.add(v); start(v); }
      else if (e.intersectionRatio === 0) { sichtbar.delete(v); if (!v.paused) v.pause(); }
    }), { threshold: [0, 0.2, 0.6] });
    videos.forEach(v => io.observe(v));
    const alle = () => videos.forEach(start);
    document.addEventListener('visibilitychange', alle);
    addEventListener('pageshow', alle);
    addEventListener('online', alle);
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
  const submit = form.querySelector('button[type=submit]');
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
    /* Doppelklick: nur die erste gültige Absendung geht an den Worker */
    if (urlOk && !sending) {
      sending = true;
      if (submit) submit.disabled = true;
      return;
    }
    e.preventDefault();
    /* Der Fokus holt nur das Feld ins Bild; auf kleinen Bildschirmen (320×568) läge der Fehlertext darunter sonst knapp außerhalb */
    if (!urlOk) { input.focus(); $('#url-error').scrollIntoView({ block: 'nearest' }); }
  });
  /* Korrigierte Adresse: Fehlertext und Markierung verschwinden beim Tippen */
  input.addEventListener('input', () => { if (input.hasAttribute('aria-invalid') && valid(input.value)) mark(input, true); });
  /* Zurück von der Bestätigungsseite oder aus der Google-Anmeldung (Seite aus dem Verlauf): Formular wieder benutzbar */
  addEventListener('pageshow', () => { sending = false; if (submit) submit.disabled = false; });

  /* Abschluss-Button: zurück zum Feld */
  const toTop = $('#to-top');
  if (toTop) toTop.addEventListener('click', () => {
    scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    setTimeout(() => input.focus({ preventScroll: true }), reduce ? 0 : 600);
  });
})();
