/* Exposure engine: pure functions, no DOM. Works in the browser (window.FRT) and in Node (require). */
(function (api) {
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.FRT = api;
})((function () {
  'use strict';

  // ---------- CSV ----------
  function parseCSV(text) {
    const rows = []; let row = [], field = '', q = false;
    text = String(text).replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    const live = rows.filter(r => r.some(x => x.trim() !== '') && !String(r[0]).trim().startsWith('#'));
    if (!live.length) return [];
    const head = live[0].map(h => h.trim());
    return live.slice(1).map(r => {
      const o = {}; head.forEach((h, i) => { o[h] = (r[i] || '').trim(); }); return o;
    });
  }
  const list = s => String(s || '').split(';').map(x => x.trim()).filter(Boolean);
  const lc = s => s.toLowerCase();

  // ---------- Database ----------
  function buildDB(raw) {
    const db = { countries: [], byIso: {}, byNum: {}, byName: {}, exposures: [], expById: {},
      pathogens: {}, rules: [], alerts: [], areas: [], version: (raw.version || '').trim(), problems: [] };
    raw.countries.forEach(c => {
      const areaTags = list(c.area_tags).map(lc);
      const tags = Array.from(new Set(list(c.tags).concat(list(c.area_tags))));
      const core = ['global', lc(c.iso3), lc(c.region), lc(c.subregion)];
      // tokens = everything that can apply somewhere in the country; baseTokens = applies country-wide
      const country = Object.assign({}, c, { tags, areaTags,
        tokens: new Set(core.concat(tags.map(lc))),
        baseTokens: new Set(core.concat(tags.map(lc).filter(t => !areaTags.includes(t)))) });
      db.countries.push(country);
      db.byIso[c.iso3] = country;
      if (c.iso_num) db.byNum[String(parseInt(c.iso_num, 10))] = country;
      [c.name].concat(list(c.aliases)).forEach(n => { db.byName[lc(n)] = country; });
    });
    db.countries.sort((a, b) => a.name.localeCompare(b.name));
    raw.exposures.forEach(e => { db.exposures.push(e); db.expById[e.id] = e; });
    raw.pathogens.forEach(p => {
      db.pathogens[p.id] = Object.assign({}, p, {
        min: num(p.inc_min_days), max: num(p.inc_max_days),
        hcid: lc(p.hcid || '') === 'yes', window: num(p.risk_window_days), prio: num(p.priority) ?? 5 });
    });
    raw.rules.forEach((r, i) => {
      if (!db.expById[r.exposure]) db.problems.push(`exposure_map row ${i + 1}: unknown exposure "${r.exposure}"`);
      if (!db.pathogens[r.pathogen]) db.problems.push(`exposure_map row ${i + 1}: unknown pathogen "${r.pathogen}"`);
      db.rules.push(Object.assign({}, r, { w: list(r.where).map(lc), x: list(r.except).map(lc) }));
    });
    (raw.alerts || []).forEach(a => db.alerts.push(Object.assign({}, a, { w: list(a.where).map(lc) })));
    // areas: metadata only ({id, name, tags, note}); geometry stays in the app
    (raw.areas || []).forEach(a => db.areas.push({ id: a.id, name: a.name, note: a.note || '', tags: list(a.tags).map(lc), countries: list(a.countries) }));
    return db;
  }
  function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }

  function applies(country, w, x) {
    if (!country) return false;
    return ok(country.tokens, w, x);
  }
  function ok(t, w, x) { return w.some(k => t.has(k)) && !(x || []).some(k => t.has(k)); }

  /** Matching context for a stop (or a bare ISO3 code = whole country, no pin). */
  function ctxFor(db, stopOrIso) {
    const stop = typeof stopOrIso === 'string' ? { iso3: stopOrIso } : stopOrIso;
    const c = db.byIso[stop.iso3]; if (!c) return null;
    const pin = stop.lat != null && stop.lng != null && stop.lat !== '';
    const areaTags = [].concat(...(stop.areas || []).map(a => a.tags || [])).map(lc);
    return { c, pin, base: c.baseTokens,
      tokens: pin ? new Set([...c.baseTokens, ...areaTags]) : c.tokens,
      full: new Set([...c.tokens, ...areaTags]) };
  }
  /** -> null if the rule does not apply; else {dep} where dep = area-limited and not assessed (no pin) */
  function matchRule(ctx, r) {
    if (!ok(ctx.tokens, r.w, r.x)) return null;
    return { dep: !ctx.pin && !ok(ctx.base, r.w, r.x), viaArea: ctx.pin && !ok(ctx.base, r.w, r.x) };
  }
  function rulesFor(db, stopOrIso, exposureId) {
    const ctx = ctxFor(db, stopOrIso); if (!ctx) return [];
    const out = [];
    db.rules.forEach(r => {
      if (r.exposure !== exposureId || !db.pathogens[r.pathogen]) return;
      const m = matchRule(ctx, r); if (m) out.push(Object.assign({}, r, m));
    });
    return out;
  }
  /** Rules that apply somewhere in the country but not at this pin (area-limited). */
  function excludedFor(db, stop) {
    const ctx = ctxFor(db, stop); if (!ctx || !ctx.pin) return [];
    const exps = ['any'].concat(stop.exposures || []);
    return db.rules.filter(r => exps.includes(r.exposure) && db.pathogens[r.pathogen] &&
      !ok(ctx.tokens, r.w, r.x) && ok(ctx.full, r.w, r.x)).map(r => Object.assign({}, r, {
        areaNames: db.areas.filter(a => (!a.countries.length || a.countries.includes(ctx.c.iso3)) &&
          a.tags.some(t => r.w.includes(t) && ctx.c.areaTags.includes(t))).map(a => a.name) }));
  }
  /** exposure id -> number of distinct pathogens it maps to for this stop (or whole country) */
  function relevantExposures(db, stopOrIso) {
    const ctx = ctxFor(db, stopOrIso), out = {};
    if (!ctx) return out;
    db.rules.forEach(r => {
      if (matchRule(ctx, r)) (out[r.exposure] = out[r.exposure] || new Set()).add(r.pathogen);
    });
    Object.keys(out).forEach(k => { out[k] = out[k].size; });
    return out;
  }
  function alertsFor(db, iso3, today) {
    const c = db.byIso[iso3];
    return db.alerts.filter(a => applies(c, a.w, [])).map(a => Object.assign({}, a, {
      stale: !!(a.review_by && today && a.review_by < today) }));
  }

  // ---------- Dates ----------
  function dayNum(s) {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5;
  }
  function timing(stop, onset, p) {
    const A = dayNum(stop.arrive), D = dayNum(stop.depart) ?? A, O = dayNum(onset);
    if (A == null || O == null || p.min == null || p.max == null) return { status: 'unknown' };
    const lo = O - D, hi = O - A; // days from exposure to onset: [lo, hi]
    if (hi < 0) return { status: 'before', lo, hi };
    if (hi < p.min) return { status: 'early', lo, hi };
    if (lo > p.max) return { status: 'late', lo, hi };
    return { status: 'fits', lo, hi };
  }
  const TIMING_LABEL = {
    fits: 'timing fits', early: 'onset sooner than usual incubation', late: 'beyond usual incubation',
    before: 'onset before arrival', unknown: 'timing not assessed' };
  const TIMING_RANK = { fits: 0, unknown: 1, late: 2, early: 3, before: 4 };

  // ---------- Analysis ----------
  function analyse(db, trip, today) {
    const stops = sortStops(trip.stops);
    const summary = {}; const hcid = [];
    const out = stops.map((s, i) => {
      const c = db.byIso[s.iso3];
      const res = { n: i + 1, stop: s, country: c, alerts: c ? alertsFor(db, s.iso3, today) : [], groups: [], excluded: [] };
      if (!c) return res;
      res.pin = s.lat != null && s.lng != null;
      res.areas = (s.areas || []).map(a => a.name);
      res.excluded = excludedFor(db, s);
      const add = (label, exp, items) => {
        const seen = {};
        items.forEach(it => {
          const p = db.pathogens[it.pathogen]; if (!p) return;
          if (seen[p.id]) {
            if (it.note && !seen[p.id].notes.includes(it.note)) seen[p.id].notes.push(it.note);
            if (!it.dep) seen[p.id].dep = false;
            return;
          }
          const t = timing(s, trip.onset, p);
          seen[p.id] = { p, notes: it.note ? [it.note] : [], src: it.source || '', t, dep: !!it.dep };
        });
        const list = Object.values(seen).sort((a, b) =>
          (TIMING_RANK[a.t.status] - TIMING_RANK[b.t.status]) || (a.p.prio - b.p.prio) || a.p.name.localeCompare(b.p.name));
        if (list.length) res.groups.push({ label, exp, items: list });
        list.forEach(x => {
          const k = x.p.id;
          const e = summary[k] || (summary[k] = { p: x.p, best: x.t.status, where: {}, dep: true });
          if (!x.dep) e.dep = false;
          if (TIMING_RANK[x.t.status] < TIMING_RANK[e.best]) e.best = x.t.status;
          const key = `${i + 1}. ${c.name}`, why = exp === 'any' ? 'any stay' : label;
          (e.where[key] = e.where[key] || []).includes(why) || e.where[key].push(why);
          if (x.p.hcid) hcidCheck(x.p, s, c, i + 1, x.dep);
        });
      };
      const base = rulesFor(db, s, 'any').concat(res.alerts.filter(a => a.pathogen)
        .map(a => ({ pathogen: a.pathogen, note: 'CURRENT OUTBREAK: ' + a.title, source: a.source_url })));
      add('Any stay in ' + c.name, 'any', base);
      (s.exposures || []).forEach(eid => {
        const e = db.expById[eid]; if (!e || eid === 'any') return;
        add(e.label, eid, rulesFor(db, s, eid));
      });
      return res;
    });

    function hcidCheck(p, s, c, n, dep) {
      const D = dayNum(s.depart) ?? dayNum(s.arrive), O = dayNum(trip.onset), T = dayNum(today);
      const w = p.window || 21; let state;
      if (D == null) state = 'dates needed';
      else if (O != null) state = (O - D) <= w ? `onset ${O - D} d after leaving (≤${w} d)` : null;
      else state = (T - D) <= w ? `left ${T - D} d ago (≤${w} d)` : 'add onset date to apply the ' + w + '-day window';
      if (state && dep) state += ' – area-limited, no pin: check where they stayed';
      if (state && !hcid.some(h => h.p.id === p.id && h.n === n)) hcid.push({ p, n, country: c.name, state });
    }

    const sumList = Object.values(summary).sort((a, b) =>
      (TIMING_RANK[a.best] - TIMING_RANK[b.best]) || (a.p.prio - b.p.prio) || a.p.name.localeCompare(b.p.name));
    return { stops: out, summary: sumList, hcid };
  }

  function sortStops(stops) {
    return stops.slice().sort((a, b) => {
      const x = dayNum(a.arrive), y = dayNum(b.arrive);
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return x - y;
    });
  }

  // ---------- Links ----------
  function slug(s) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[()']/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  function links(c) {
    return [
      ['NaTHNaC country page', 'https://travelhealthpro.org.uk/countries/' + (c.nathnac_slug || slug(c.name))],
      ['NaTHNaC outbreak surveillance', 'https://travelhealthpro.org.uk/outbreaks'],
      ['UKHSA HCID country-specific risk', 'https://www.gov.uk/guidance/high-consequence-infectious-disease-country-specific-risk'],
      ['CDC Yellow Book: malaria & yellow fever by country', 'https://www.cdc.gov/yellow-book/hcp/preparing-international-travelers/yellow-fever-vaccine-and-malaria-prevention-information-by-country.html']
    ];
  }

  // ---------- Text report ----------
  function fmtDays(lo, hi) { return lo === hi ? `${lo} d` : `${Math.max(lo, 0)}–${hi} d`; }
  function renderText(db, trip, result, meta) {
    const L = []; const hr = '='.repeat(72), sub = '-'.repeat(72);
    const push = s => L.push(s);
    const wrap = (s, ind) => wrapText(s, 72 - ind).map(x => ' '.repeat(ind) + x);
    push(hr);
    push('FEVER IN THE RETURNING TRAVELLER – TRAVEL & EXPOSURE HISTORY');
    push(hr);
    push(`Generated: ${meta.now}    Exposure database version: ${db.version || 'unknown'}`);
    push('Lists POSSIBLE exposures by geography only. It does not use symptoms and');
    push('does not rank likelihood. Use with BIA/UKHSA guidance, NaTHNaC and local');
    push('ID/microbiology. Exclude malaria in all travellers from endemic areas.');
    push('');
    push('TIMELINE');
    push(`  Fever onset:        ${trip.onset || 'not recorded'}`);
    push(`  Returned to UK:     ${trip.returned || 'not recorded'}`);
    push(`  Countries visited:  ${result.stops.length}`);
    result.stops.forEach(r => {
      const s = r.stop;
      const ago = (trip.onset && s.depart) ? `  (left ${dayNum(trip.onset) - dayNum(s.depart)} d before onset)` : '';
      push(`   ${r.n}. ${(r.country ? r.country.name : 'Country not set')}${s.place ? ' – ' + s.place : ''}: ${s.arrive || '?'} → ${s.depart || '?'}${ago}`);
    });
    if (trip.notes) { push(''); push('GENERAL NOTES'); wrap(trip.notes, 2).forEach(push); }
    push('');

    if (result.hcid.length) {
      push(sub);
      push('!! HIGH CONSEQUENCE INFECTIOUS DISEASE (HCID) CHECK');
      push(sub);
      wrap('Complete the relevant risk assessment (ACDP VHF algorithm / UKHSA MERS & avian influenza algorithms), isolate appropriately and discuss with local infection service ± Imported Fever Service (0844 778 8990). Exclude malaria.', 2).forEach(push);
      result.hcid.forEach(h => wrapText(`${h.p.name} – stop ${h.n} ${h.country}: ${h.state}`, 66).forEach((ln, i) => push((i ? '    ' : '  * ') + ln)));
      push('');
    }

    result.stops.forEach(r => {
      const s = r.stop;
      push(sub);
      push(`STOP ${r.n}: ${r.country ? r.country.name + ' (' + r.country.iso3 + ')' : 'COUNTRY NOT SET'}${s.place ? ' – ' + s.place : ''}`);
      push(sub);
      if (s.lat != null) push(`  Map pin:   ${(+s.lat).toFixed(3)}, ${(+s.lng).toFixed(3)}`);
      push(`  Dates:     ${s.arrive || '?'} to ${s.depart || '?'}${stayLen(s)}`);
      if (r.country && r.pin && (r.areas.length || r.country.areaTags.length)) {
        wrap('Mapped risk areas at pin: ' + (r.areas.length ? r.areas.join('; ') : 'none (outside all mapped areas)'), 2).forEach(push);
      } else if (r.country && r.country.areaTags.length) {
        wrap('No map pin: risks that are limited to parts of ' + r.country.name + ' are listed but marked AREA NOT ASSESSED.', 2).forEach(push);
      }
      const exps = (s.exposures || []).map(id => db.expById[id] ? db.expById[id].label : id);
      push('  Exposures recorded:');
      if (exps.length) exps.forEach(e => push('    - ' + e)); else push('    (none ticked)');
      if (s.other) wrap('Other / details: ' + s.other, 4).forEach(push);
      r.alerts.forEach(a => {
        push(`  ALERT${a.stale ? ' (STALE – re-check source)' : ''}: ${a.title}`);
        wrap(a.detail + ` [checked ${a.date_checked}]`, 4).forEach(push);
      });
      if (!r.country) { push('  Set the country to list exposures.'); push(''); return; }
      r.groups.forEach(g => {
        push('');
        push(`  [${g.label}]`);
        g.items.forEach(x => {
          let line = `    - ${x.p.name}${x.p.hcid ? ' [HCID]' : ''} | incubation ${x.p.incubation_text}`;
          if (x.t.status !== 'unknown') line += ` | ${TIMING_LABEL[x.t.status]} (exposure→onset ${fmtDays(x.t.lo, x.t.hi)})`;
          if (x.dep) line += ' | AREA NOT ASSESSED (only parts of country)';
          wrapText(line.replace(/^    - /, ''), 66).forEach((ln, i) => push((i ? '        ' : '    - ') + ln));
          x.notes.concat(x.p.notes ? [x.p.notes] : []).forEach(n => wrap(n, 8).forEach(push));
        });
      });
      if (r.excluded.length) {
        const ex = {};
        r.excluded.forEach(x => {
          const p = db.pathogens[x.pathogen], k = p.id;
          const e = ex[k] || (ex[k] = { p, exps: [], areas: [] });
          const lab = x.exposure === 'any' ? 'any stay' : (db.expById[x.exposure] || {}).label || x.exposure;
          if (!e.exps.includes(lab)) e.exps.push(lab);
          x.areaNames.forEach(a => { if (!e.areas.includes(a)) e.areas.push(a); });
        });
        push('');
        push('  [Not at this pin – limited to other parts of ' + r.country.name + ']');
        Object.values(ex).forEach(e => wrapText(`${e.p.name} (${e.exps.join('; ')})${e.areas.length ? ' – mapped area: ' + e.areas.join('; ') : ''}. Check the pin is accurate and ask about side trips.`, 66)
          .forEach((ln, i) => push((i ? '        ' : '    - ') + ln)));
      }
      push('');
      push('  Check current data:');
      links(r.country).forEach(([t, u]) => push(`    ${t}: ${u}`));
      push('');
    });

    push(sub);
    push('SUMMARY – ALL POSSIBLE PATHOGENS (deduplicated)');
    push(sub);
    if (!trip.onset) push('  (Add a fever-onset date to check incubation periods.)');
    result.summary.forEach(e => {
      const t = (e.best === 'unknown' ? '' : ` – ${TIMING_LABEL[e.best]}`) + (e.dep ? ' – AREA NOT ASSESSED' : '');
      wrapText(`* ${e.p.name}${e.p.hcid ? ' [HCID]' : ''}${t}`, 70).forEach((ln, i) => push((i ? '    ' : '  ') + ln));
      wrap('from: ' + Object.entries(e.where).map(([k, v]) => `${k} (${v.join('; ')})`).join(' | '), 6).forEach(push);
    });
    push('');
    push(sub);
    push('KEY CONTACTS & REFERENCES');
    push(sub);
    [
      'Imported Fever Service (UKHSA RIPL), 24/7: 0844 778 8990',
      'UKHSA Outbreaks under monitoring: https://www.gov.uk/government/publications/outbreaks-under-monitoring-in-2026',
      'NaTHNaC / TravelHealthPro: https://travelhealthpro.org.uk/countries',
      'BIA guidelines (fever, malaria, eosinophilia): https://www.britishinfection.org/guidance/published-guidelines',
      'Thwaites & Day. Approach to fever in the returning traveler. NEJM 2017;376:548-60',
      'Thakker et al. UK guidelines for eosinophilia in returning travellers and migrants. J Infect 2025;90:106328',
      'Fever in Returning Travellers – Infection Quick Reference Guide (v5, July 2025)'
    ].forEach(s => wrap(s, 2).forEach(push));
    push('');
    return L.join('\n');
  }
  function stayLen(s) {
    const a = dayNum(s.arrive), d = dayNum(s.depart);
    return (a != null && d != null && d >= a) ? ` (${d - a + 1} days)` : '';
  }
  function wrapText(s, width) {
    const words = String(s).split(/\s+/); const out = []; let line = '';
    words.forEach(w => {
      if ((line + ' ' + w).trim().length > width && line) { out.push(line); line = w; }
      else line = (line ? line + ' ' : '') + w;
    });
    if (line) out.push(line);
    return out.length ? out : [''];
  }

  return { parseCSV, buildDB, rulesFor, excludedFor, ctxFor, relevantExposures, alertsFor, analyse, renderText, timing,
    dayNum, sortStops, links, slug, TIMING_LABEL };
})());
