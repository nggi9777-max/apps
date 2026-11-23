/* Иконки: единая сетка 24×24, линия 1.6, симметричная геометрия.
   Статусные индикаторы — сдержанная анимация (кольцо/дуга), без «мультяшных» эффектов. */
const ICO = (function () {
  const s = (d) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  // фирменный знак: устьевая арматура, строго симметричная относительно x=12
  const mark = '<path d="M12 4.5v15"/><path d="M9.5 4.5h5"/><path d="M5 10h14"/><circle cx="5" cy="10" r="1.6"/><circle cx="19" cy="10" r="1.6"/><path d="M9 15h6"/><path d="M8 19.5h8"/>';
  function status(color, glyph, extra) {
    return '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="27" fill="' + color + '" fill-opacity=".08" stroke="' + color + '" stroke-opacity=".28" stroke-width="1.5"/>' + (extra || '') +
      '<g fill="none" stroke="' + color + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' + glyph + '</g></svg>';
  }
  const arc = (color, dur) => '<circle cx="32" cy="32" r="27" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round" stroke-dasharray="34 136" class="ai-spin" style="animation-duration:' + dur + 's"/>';
  const halo = (color) => '<circle cx="32" cy="32" r="27" fill="none" stroke="' + color + '" stroke-width="1.5" class="ai-halo"/>';
  return {
    logo: '<svg viewBox="0 0 40 40" aria-hidden="true"><rect x=".75" y=".75" width="38.5" height="38.5" rx="10" fill="#1E3246" stroke="#35506B" stroke-width="1.5"/><g transform="translate(8 8)" fill="none" stroke="#F2B33D" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + mark + '</g></svg>',
    field: s('<path d="M12 3 3 7.5l9 4.5 9-4.5L12 3z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>'),
    well: s(mark),
    data: s('<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 9h17M3.5 14h17M9.5 9v11"/>'),
    chart: s('<path d="M4 4v16h16"/><path d="m7.5 14.5 3.5-4 3 2.5 4.5-6"/>'),
    cycles: s('<path d="M20 12a8 8 0 0 1-13.9 5.4"/><path d="M4 12a8 8 0 0 1 13.9-5.4"/><path d="M18 3v4h-4"/><path d="M6 21v-4h4"/>'),
    forecast: s('<path d="M4 18 9 12l3.5 3L16 10"/><path d="M16 10l4-4" stroke-dasharray="1.5 2.5"/><path d="M4 4v16h16"/>'),
    opt: s('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
    eff: s('<path d="M4 20h16"/><path d="M7 20v-6M12 20V9M17 20V4"/>'),
    rate: s('<path d="M4.3 18a9 9 0 1 1 15.4 0"/><path d="m12 13.5 4-4"/><circle cx="12" cy="13.5" r="1.2"/>'),
    compare: s('<rect x="4" y="11" width="4" height="9" rx="1"/><rect x="10" y="4" width="4" height="16" rx="1"/><rect x="16" y="8" width="4" height="12" rx="1"/>'),
    journal: s('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M8.5 10h7M8.5 14h7M8.5 18h4"/>'),
    plus: s('<path d="M12 6v12M6 12h12"/>'),
    edit: s('<path d="M15.5 4.5 19.5 8.5 9 19H5v-4L15.5 4.5z"/>'),
    trash: s('<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 13h9l1-13"/><path d="M10 11v5M14 11v5"/>'),
    search: s('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>'),
    upload: s('<path d="M12 15V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>'),
    doc: s('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/>'),
    ppt: s('<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v4M8 20h8"/><path d="M8 12.5 11 9.5l2 2 3-3"/>'),
    gear: s('<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/><path d="M4 12h4M12 12h8"/><circle cx="10" cy="12" r="2"/>'),
    db: s('<ellipse cx="12" cy="5.5" rx="7.5" ry="2.5"/><path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13"/><path d="M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5"/>'),
    warn: s('<path d="M12 4 21 19.5H3L12 4z"/><path d="M12 10v4.5"/><path d="M12 17.2v.1"/>'),
    info: s('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.8v.1"/>'),
    x: s('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 6 6 6-6 6"/></svg>',
    down: s('<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>'),
    live: s('<circle cx="12" cy="12" r="2.5"/><path d="M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10"/>'),
    play: s('<circle cx="12" cy="12" r="8.5"/><path d="M10 8.5v7l5.5-3.5z"/>'),
    file: s('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>'),
    /* статусные индикаторы (64×64): кольцо + глиф, анимация только у активных состояний */
    status: {
      normal: status('#46D69A', '<path d="m22.5 32.5 6.5 6.5 12.5-13.5"/>', halo('#46D69A')),
      watch: status('#6FB8FF', '<path d="M18 33h6.5l3.5-9 7 17 3.5-8H46"/>', arc('#6FB8FF', 3.2)),
      soon: status('#F2B33D', '<circle cx="32" cy="32" r="13" stroke-width="2.4"/><path d="M32 24v8h6"/>', arc('#F2B33D', 2.2)),
      critical: status('#FF5A6E', '<path d="M32 21v13"/><path d="M32 42v.5"/>', halo('#FF5A6E')),
      stopped: status('#7F93A8', '<rect x="24" y="24" width="16" height="16" rx="2.5" fill="#7F93A8" fill-opacity=".2"/>'),
      after: status('#4FB3E8', '<path d="M32 42V22"/><path d="m24.5 29.5 7.5-7.5 7.5 7.5"/>', arc('#4FB3E8', 1.6)),
      none: '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="27" fill="none" stroke="#617A93" stroke-width="1.5" stroke-dasharray="3 5"/><path d="M24 32h16" stroke="#8FA6BD" stroke-width="3" stroke-linecap="round"/></svg>'
    },
    /* стартовый экран: схема цикла «продувка → работа → накопление» с прорисовкой линии */
    hero: (function () {
      // реалистичная форма цикла: скачок, затухание ΔP, остановка
      const cyc = (x0) => 'L' + x0 + ' 150 L' + (x0 + 6) + ' 150 L' + (x0 + 10) + ' 38 C' + (x0 + 22) + ' 70,' + (x0 + 40) + ' 104,' + (x0 + 70) + ' 112 L' + (x0 + 76) + ' 113 L' + (x0 + 79) + ' 150 L' + (x0 + 96) + ' 150';
      let d = 'M20 150'; [20, 116, 212, 308].forEach(x => d += ' ' + cyc(x));
      let grid = ''; for (let x = 20; x <= 420; x += 40) grid += '<path d="M' + x + ' 24V160"/>'; for (let y = 24; y <= 160; y += 34) grid += '<path d="M20 ' + y + 'H420"/>';
      return '<svg class="hero-art" viewBox="0 0 440 190" aria-hidden="true"><g stroke="#2D4660" stroke-width="1">' + grid + '</g>' +
        '<path d="M20 116H420" stroke="#4FB3E8" stroke-width="1.6" stroke-dasharray="4 4" opacity=".8"/>' +
        '<path d="M20 108H420" stroke="#FF5A6E" stroke-width="1.2" stroke-dasharray="1 4" stroke-linecap="round"/>' +
        '<path class="ai-draw" d="' + d + '" fill="none" stroke="#F2B33D" stroke-width="2.2" stroke-linejoin="round"/>' +
        '<g font-family="Bahnschrift, Segoe UI, sans-serif" font-size="11" fill="#8FA6BD"><text x="24" y="178">Pwh</text><text x="56" y="178" fill="#4FB3E8">Pline</text><text x="96" y="178" fill="#FF5A6E">ΔP крит.</text></g></svg>';
    })()
  };
})();
