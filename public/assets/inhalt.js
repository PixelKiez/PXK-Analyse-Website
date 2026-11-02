/* 360°Pixelkiez – Analyse-Übersicht: Das Kreisdiagramm zur Zusammensetzung des Pixelkiez Score setzt sich beim Öffnen und
   jedes Mal beim Hineinscrollen zusammen; Bereiche lassen sich per Zeiger oder Tastatur hervorheben. Ohne JavaScript und bei
   „Bewegung reduzieren“ ist das Diagramm sofort vollständig sichtbar. Keine Daten werden gesendet. */
(() => {
  const fig = document.querySelector('.donut');
  if (!fig) return;
  const segs = [...fig.querySelectorAll('.donut-bild svg a')];
  const rows = [...fig.querySelectorAll('.donut-legende a')];
  const big = fig.querySelector('.donut-mitte b');
  const small = fig.querySelector('.donut-mitte span');
  if (!big || !small || segs.length !== rows.length) return;
  const start = [big.textContent, small.textContent];
  let frame = 0;

  const zeigen = i => {
    cancelAnimationFrame(frame);
    fig.dataset.aktiv = String(i);
    segs.forEach((s, j) => s.classList.toggle('ist-aktiv', i === j));
    rows.forEach((r, j) => r.classList.toggle('ist-aktiv', i === j));
    big.textContent = `${rows[i].dataset.gewicht} %`;
    small.textContent = `${rows[i].dataset.name} · ${rows[i].dataset.kriterien} Prüfkriterien`;
  };
  const zurueck = () => {
    delete fig.dataset.aktiv;
    [...segs, ...rows].forEach(n => n.classList.remove('ist-aktiv'));
    [big.textContent, small.textContent] = start;
  };
  [segs, rows].forEach(list => list.forEach((el, i) => {
    el.addEventListener('pointerenter', () => zeigen(i));
    el.addEventListener('pointerleave', zurueck);
  }));
  /* Segmente: Klick führt zum Bereich, ohne dass sie den Fokus übernehmen (sonst zeichnet der Browser einen Rahmen um das Segment) */
  segs.forEach(el => el.addEventListener('mousedown', e => e.preventDefault()));
  /* Richtung, in die ein Stück herausrückt (aus data-dx/data-dy, per CSSOM gesetzt – kein style-Attribut im HTML) */
  segs.forEach(el => { el.style.setProperty('--dx', `${el.dataset.dx}px`); el.style.setProperty('--dy', `${el.dataset.dy}px`); });
  /* Legende: Tastatur und Screenreader */
  rows.forEach((el, i) => {
    el.addEventListener('focus', () => zeigen(i));
    el.addEventListener('blur', zurueck);
  });

  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
  const ziel = parseInt(start[0], 10) || 0;
  const zaehlen = () => {
    cancelAnimationFrame(frame);
    const t0 = performance.now();
    const schritt = t => {
      const p = Math.min(1, (t - t0) / 900);
      if (!fig.dataset.aktiv) big.textContent = `${Math.round(ziel * (1 - (1 - p) ** 3))} %`;
      if (p < 1) frame = requestAnimationFrame(schritt);
    };
    frame = requestAnimationFrame(schritt);
  };
  fig.classList.add('dn-anim');
  new IntersectionObserver(eintraege => eintraege.forEach(e => {
    if (e.intersectionRatio >= 0.35 && !fig.classList.contains('dn-sichtbar')) {
      fig.classList.add('dn-sichtbar');
      zaehlen();
    } else if (e.intersectionRatio === 0) {
      fig.classList.remove('dn-sichtbar');
    }
  }), { threshold: [0, 0.35] }).observe(fig);
})();
