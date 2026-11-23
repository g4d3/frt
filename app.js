/* UI: map, stops, report. Depends on engine.js (window.FRT); Leaflet + topojson are optional. */
(function () {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const todayISO = () => new Date().toISOString().slice(0, 10);

  // DATA_DIR lets index.html point at a different folder ('' = files at the top level of the site).
  const D = typeof window.DATA_DIR === 'string' ? window.DATA_DIR : 'data/';
  const FILES = { countries: D + 'countries.csv', exposures: D + 'exposures.csv', pathogens: D + 'pathogens.csv',
    rules: D + 'exposure_map.csv', alerts: D + 'alerts.csv', hcid: D + 'hcid_risk.csv' };
  const BOUNDARIES = [D + 'countries-50m.json', 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json'];
  // French overseas departments sit inside France's polygon in Natural Earth: split them out.
  const OVERSEAS = [['GUF', 2, 6, -55, -51.5], ['MTQ', 14.3, 15, -61.3, -60.7], ['GLP', 15.8, 16.6, -61.9, -60.9],
    ['REU', -21.5, -20.8, 55.1, 55.9], ['MYT', -13.1, -12.6, 44.9, 45.4]];

  let db, map, boundaryLayer, areaLayer, features = [], areaFeatures = [];
  const state = { stops: [], onset: '', returned: '', notes: '' };
  let nextId = 1;
  const markers = {};

  // ---------- boot ----------
  init().catch(err => {
    console.error(err);
    $('#stops').innerHTML = `<p class="error">Could not load the data files (${esc(err.message)}). If you opened index.html directly from your computer, run a local web server instead (see README).</p>`;
  });

  // Single-file build: data embedded as window.EMBEDDED[path]; normal build: fetched from /data.
  function getText(path) {
    if (window.EMBEDDED && path in window.EMBEDDED) return Promise.resolve(window.EMBEDDED[path]);
    return fetch(path, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(path + ' ' + r.status); return r.text(); });
  }
  async function init() {
    const txt = await Promise.all(Object.values(FILES).map(getText));
    const raw = {}; Object.keys(FILES).forEach((k, i) => { raw[k] = FRT.parseCSV(txt[i]); });
    raw.version = await getText(D + 'version.txt').catch(() => '');
    try {
      const geo = JSON.parse(await getText(D + 'areas.geojson'));
      areaFeatures = geo.features.filter(f => f.geometry && f.properties && f.properties.id);
      areaFeatures.forEach(f => { f.bbox = bbox(f.geometry); f.tagList = String(f.properties.tags || '').split(';').map(t => t.trim()).filter(Boolean); });
      raw.areas = areaFeatures.map(f => f.properties);
    } catch (e) { console.warn('areas.geojson not loaded', e); raw.areas = []; }
    db = FRT.buildDB(raw);
    buildCountryOptions();
    bindGlobal();
    initMap();
    renderAll();
    renderData();
  }

  function buildCountryOptions() {
    const opts = '<option value="">– choose country –</option>' +
      db.countries.map(c => `<option value="${c.iso3}">${esc(c.name)}</option>`).join('');
    $('#tpl-stop').content.querySelector('[data-f="iso3"]').innerHTML = opts;
    $('#data-country').innerHTML = opts;
  }

  // ---------- map ----------
  function initMap() {
    if (!window.L) {
      $('#map').innerHTML = '<div class="nomap">Map could not load (offline or blocked). Use “+ Add without map”; everything else works.</div>';
      return;
    }
    map = L.map('map', { worldCopyJump: true, minZoom: 2 }).setView([12, 20], 2);
    // Free, keyless base maps. The first one is the default; the others are in the layer picker (top right).
    const osm = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    const esri = 'Tiles &copy; Esri';
    const bases = {
      'Street map (OpenStreetMap)': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: osm }),
      'Light grey, English labels (Esri)': L.layerGroup([
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, attribution: esri + ' &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors' }),
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16 })]),
      'Terrain (OpenTopoMap)': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, subdomains: 'abc',
        attribution: 'Map data: ' + osm + ', SRTM &mdash; style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)' }),
      'Satellite (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18,
        attribution: esri + ' &mdash; Esri, Maxar, Earthstar Geographics, GIS User Community' })
    };
    bases['Street map (OpenStreetMap)'].addTo(map);
    L.control.layers(bases, null, { position: 'topright', collapsed: true }).addTo(map);
    map.on('click', e => addStop(e.latlng.wrap()));
    addLegend();
    if (areaFeatures.length) {
      areaLayer = L.geoJSON({ type: 'FeatureCollection', features: areaFeatures }, {
        style: f => {
          const t = String(f.properties.tags || '');
          if (t.includes('malaria_cdc_chemo')) return { color: '#a3201a', weight: 1, fillColor: '#c8352c', fillOpacity: 0.28 };
          if (t.includes('malaria_cdc_rural')) return { color: '#7b3f86', weight: 1, fillColor: '#a466ae', fillOpacity: 0.28 };
          if (t.includes('malaria_cdc_avoid')) return { color: '#c56a12', weight: 1, fillColor: '#f0a04b', fillOpacity: 0.28 };
          return { color: '#5a3d99', weight: 1.5, dashArray: '5 4', fillColor: '#5a3d99', fillOpacity: 0.07 };
        },
        onEachFeature: (f, layer) => layer.bindTooltip(esc(f.properties.name), { sticky: true, className: 'ctip' })
      });
      if ($('#show-areas').checked) areaLayer.addTo(map);
    }
    loadBoundaries();
  }

  async function loadBoundaries() {
    if (!window.topojson) return;
    for (const url of BOUNDARIES) {
      try {
        const r = await fetch(url); if (!r.ok) continue;
        const topo = await r.json();
        features = topojson.feature(topo, topo.objects.countries).features;
        features.forEach(f => { f.country = featureCountry(f); f.bbox = bbox(f.geometry); });
        boundaryLayer = L.geoJSON({ type: 'FeatureCollection', features }, {
          style: styleFeature,
          onEachFeature: (f, layer) => layer.bindTooltip(f.country ? f.country.name : (f.properties.name || ''), { sticky: true, className: 'ctip' })
        }).addTo(map);
        state.stops.forEach(s => { if (!s.manualCountry && !s.iso3 && s.lat != null) s.iso3 = detect(s.lat, s.lng); });
        renderAll();
        return;
      } catch (e) { /* try next source */ }
    }
  }
  function featureCountry(f) {
    if (f.id != null && db.byNum[String(parseInt(f.id, 10))]) return db.byNum[String(parseInt(f.id, 10))];
    const n = (f.properties && f.properties.name || '').toLowerCase();
    return db.byName[n] || null;
  }
  function styleFeature(f) {
    const shade = $('#shade').checked, c = f.country, t = c ? c.tags : [];
    const alert = c && FRT.alertsFor(db, c.iso3, todayISO()).length;
    let fill = 'transparent', op = 0;
    if (shade && t.includes('malaria_high')) { fill = '#b8322a'; op = 0.32; }
    else if (shade && (t.includes('malaria_risk') || t.some(x => x.startsWith('malaria_cdc_')))) { fill = '#e08a2c'; op = 0.25; }
    return { color: alert ? '#8a0f12' : '#7a8a8c', weight: alert ? 2 : 0.5, fillColor: fill, fillOpacity: op, dashArray: alert ? '4 3' : null };
  }
  function addLegend() {
    const lg = L.control({ position: 'bottomleft' });
    lg.onAdd = () => {
      const d = L.DomUtil.create('div', 'legend');
      d.innerHTML = '<div><i style="background:#b8322a;opacity:.55"></i>Malaria – high-risk country</div>' +
        '<div><i style="background:#e08a2c;opacity:.5"></i>Malaria – present in parts</div>' +
        '<div><i style="background:#c8352c;opacity:.6"></i>CDC zone: chemoprophylaxis</div>' +
        '<div><i style="background:#a466ae;opacity:.6"></i>CDC zone: chemo, rural areas</div>' +
        '<div><i style="background:#f0a04b;opacity:.6"></i>CDC zone: mosquito avoidance only</div>' +
        '<div><i class="dash"></i>Current outbreak alert</div>' +
        '<div><i class="area"></i>Mapped risk area</div>' +
        '<small>Country shading is country level. CDC zones traced from CDC maps (34 countries); purple outlines are rough. Verify on NaTHNaC/CDC.</small>';
      return d;
    };
    lg.addTo(map);
  }
  function bbox(g) {
    let a = [180, 90, -180, -90];
    const walk = c => { if (typeof c[0] === 'number') { a = [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[2], c[0]), Math.max(a[3], c[1])]; } else c.forEach(walk); };
    walk(g.coordinates); return a;
  }
  function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function inPoly(x, y, poly) { return inRing(x, y, poly[0]) && !poly.slice(1).some(h => inRing(x, y, h)); }
  function polysOf(g) { return g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []; }
  function areasAt(lat, lng) {
    if (lat == null) return [];
    return areaFeatures.filter(f => { const b = f.bbox;
      return !(lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) && polysOf(f.geometry).some(p => inPoly(lng, lat, p)); })
      .map(f => ({ id: f.properties.id, name: f.properties.name, tags: f.tagList }));
  }
  function detect(lat, lng) {
    let found = null;
    for (const f of features) {
      const b = f.bbox; if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
      const g = f.geometry, polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      if (polys.some(p => inPoly(lng, lat, p))) { found = f.country; break; }
    }
    if (!found || found.iso3 === 'FRA') {
      const o = OVERSEAS.find(([, a, b, c, d]) => lat >= a && lat <= b && lng >= c && lng <= d);
      if (o && db.byIso[o[0]]) return o[0];
    }
    return found ? found.iso3 : '';
  }

  // ---------- stops ----------
  function addStop(latlng) {
    const s = { id: nextId++, lat: latlng ? latlng.lat : null, lng: latlng ? latlng.lng : null,
      iso3: latlng ? detect(latlng.lat, latlng.lng) : '', areas: latlng ? areasAt(latlng.lat, latlng.lng) : [], place: '', arrive: '', depart: '', exposures: [], other: '', manualCountry: false };
    const prev = FRT.sortStops(state.stops).slice(-1)[0];
    if (prev && prev.depart) s.arrive = prev.depart; // sensible default: next leg starts where the last ended
    state.stops.push(s);
    renderAll();
    const card = $(`.stop[data-id="${s.id}"]`);
    if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); card.classList.add('flash'); }
    showTab('trip');
  }
  function stopById(id) { return state.stops.find(s => s.id === +id); }

  function renderAll() {
    const sorted = FRT.sortStops(state.stops);
    const box = $('#stops');
    const focusedId = document.activeElement && document.activeElement.closest('.stop') ? document.activeElement.closest('.stop').dataset.id : null;
    const focusedField = document.activeElement && (document.activeElement.dataset.f || document.activeElement.dataset.exp);
    box.innerHTML = '';
    sorted.forEach((s, i) => box.appendChild(renderStop(s, i + 1)));
    $('#empty').hidden = sorted.length > 0;
    $('#stop-count').textContent = sorted.length ? `(${sorted.length})` : '';
    if (focusedId && focusedField) {
      const el = $(`.stop[data-id="${focusedId}"] [data-f="${focusedField}"], .stop[data-id="${focusedId}"] [data-exp="${focusedField}"]`);
      if (el) el.focus({ preventScroll: true });
    }
    syncMarkers(sorted);
    updateReport();
  }

  function renderStop(s, n) {
    const el = $('#tpl-stop').content.firstElementChild.cloneNode(true);
    el.dataset.id = s.id;
    $('.num', el).textContent = n;
    $('[data-f="iso3"]', el).value = s.iso3 || '';
    $('[data-f="place"]', el).value = s.place;
    $('[data-f="arrive"]', el).value = s.arrive;
    $('[data-f="depart"]', el).value = s.depart;
    $('[data-f="other"]', el).value = s.other;
    if (s.lat == null) $('[data-act="locate"]', el).hidden = true;
    renderStopDetails(el, s);
    return el;
  }

  function renderStopDetails(el, s) {
    const c = db.byIso[s.iso3];
    const rel = c ? FRT.relevantExposures(db, s) : {};
    // exposures grouped
    const groups = {};
    db.exposures.filter(e => e.id !== 'any').forEach(e => (groups[e.group] = groups[e.group] || []).push(e));
    $('.exp-groups', el).innerHTML = Object.entries(groups).map(([g, list]) => `
      <fieldset><legend>${esc(g)}</legend>${list.map(e => {
        const k = rel[e.id] || 0, on = s.exposures.includes(e.id);
        return `<label class="chk${k ? ' rel' : ''}${on ? ' on' : ''}" title="${esc(e.ask)}">
          <input type="checkbox" data-exp="${e.id}"${on ? ' checked' : ''}> <span>${esc(e.label)}</span>${k ? `<b>${k}</b>` : ''}</label>`;
      }).join('')}</fieldset>`).join('');
    $('.exp-hint', el).textContent = c ? `· numbers = possible infections ${s.lat != null ? 'at this pin' : 'in ' + c.name} · hover for questions to ask` : '· choose a country first';
    // alerts
    const alerts = c ? FRT.alertsFor(db, s.iso3, todayISO()) : [];
    $('.alerts', el).innerHTML = alerts.map(a => `<div class="alert${a.stale ? ' stale' : a.pathogen ? '' : ' info'}"><strong>${a.stale ? 'STALE – re-check: ' : a.pathogen ? 'Alert: ' : 'Note: '}${esc(a.title)}</strong><br>${esc(a.detail)} <a href="${esc(a.source_url)}" target="_blank" rel="noopener">source</a> <small>(checked ${esc(a.date_checked)})</small></div>`).join('');
    renderPreview(el, s);
  }

  function renderPreview(el, s) {
    const c = db.byIso[s.iso3];
    if (c) {
      const res = FRT.analyse(db, { stops: [s], onset: state.onset }, todayISO()).stops[0];
      const seen = new Map();
      res.groups.forEach(g => g.items.forEach(x => { if (!seen.has(x.p.id) || x.t.status === 'fits') seen.set(x.p.id, x); }));
      const chips = Array.from(seen.values()).map(x =>
        `<span class="chip ${x.p.hcid ? 'hcid' : ''} t-${x.t.status}${x.dep ? ' dep' : ''}" title="Incubation ${esc(x.p.incubation_text)}${x.t.status !== 'unknown' ? ' · ' + FRT.TIMING_LABEL[x.t.status] : ''}${x.dep ? ' · only in parts of ' + esc(c.name) + ' – drop a pin to check' : ''}">${esc(x.p.name)}</span>`).join('');
      let where = '';
      if (s.lat != null && (res.areas.length || c.areaTags.length)) where = `<div class="area-line">${res.areas.length ? 'Pin is inside: <b>' + res.areas.map(esc).join('</b>; <b>') + '</b>' : 'Pin is outside all mapped risk areas.'}</div>`;
      else if (c.areaTags.length) where = `<div class="area-line">No pin: dashed items occur only in parts of ${esc(c.name)}.</div>`;
      const exNames = Array.from(new Set(res.excluded.map(x => db.pathogens[x.pathogen].name)));
      const ex = exNames.length ? `<div class="excl"><b>Not at this pin</b> (other parts of ${esc(c.name)}): ${exNames.map(esc).join(', ')}</div>` : '';
      const shortLab = id => { const e = db.expById[id] || {}; return e.short || e.label || id; };
      const hc = res.hcid.length ? `<div class="hcidbox"><div class="pv-head">HCIDs reported by UKHSA in ${esc(c.name)} <small>(listed, not a risk estimate)</small></div><ul>${res.hcid.map(h => {
        const cat = h.country ? `${esc(h.country.category_text)}, ${esc(h.country.last_reported)}` : '';
        const inArea = h.areas.filter(a => a.inside === true).map(a => `<div class="hc-area">Pin is inside: ${esc(a.name)}</div>`).join('');
        const outArea = h.areas.length && !h.areas.some(a => a.inside === true) ? `<div class="hc-area muted">${h.areas[0].inside === null ? 'No pin – areas' : 'Pin outside areas'}: ${h.areas.map(a => esc(a.name)).join('; ')}</div>` : '';
        return `<li class="hc-${h.win.state}"><b>${esc(h.p.name)}</b>${h.p.hcid_group ? ` <small>[${esc(h.p.hcid_group)}]</small>` : ''}<div>${cat}</div>${inArea}${outArea}
          <div class="hc-win">${esc(h.win.text)}</div>
          <div class="muted">${h.ticked.length ? '<b>Recorded:</b> ' + h.ticked.map(x => esc(shortLab(x))).join(', ') + ' · ' : ''}Ask about: ${h.ask.map(x => esc(shortLab(x))).join(', ')}</div>
          ${h.p.reservoir_vector ? `<div class="muted">Spread: ${esc(h.p.reservoir_vector)}</div>` : ''}</li>`;
      }).join('')}</ul></div>` : '';
      $('.preview', el).innerHTML = `${where}${hc}<div class="pv-head">Possible infections for this stop <small>(${seen.size})</small></div>${chips}${ex}`;
      $('.links', el).innerHTML = FRT.links(c).map(([t, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`).join(' · ');
    } else {
      $('.preview', el).innerHTML = '<div class="pv-head muted">Choose the country to see possible infections.</div>';
      $('.links', el).innerHTML = '';
    }
  }

  function syncMarkers(sorted) {
    if (!map) return;
    const ids = new Set(sorted.map(s => s.id));
    Object.keys(markers).forEach(id => { if (!ids.has(+id)) { map.removeLayer(markers[id]); delete markers[id]; } });
    sorted.forEach((s, i) => {
      if (s.lat == null) return;
      const icon = L.divIcon({ className: 'pin', html: `<span><b>${i + 1}</b></span>`, iconSize: [28, 28], iconAnchor: [14, 28] });
      if (!markers[s.id]) {
        const m = L.marker([s.lat, s.lng], { draggable: true, icon, keyboard: true }).addTo(map);
        m.on('dragend', () => {
          const ll = m.getLatLng().wrap(); s.lat = ll.lat; s.lng = ll.lng; s.areas = areasAt(s.lat, s.lng);
          if (!s.manualCountry) s.iso3 = detect(s.lat, s.lng);
          renderAll();
        });
        m.on('click', () => { const c = $(`.stop[data-id="${s.id}"]`); if (c) { showTab('trip'); c.scrollIntoView({ behavior: 'smooth' }); c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 1200); } });
        markers[s.id] = m;
      } else { markers[s.id].setIcon(icon); markers[s.id].setLatLng([s.lat, s.lng]); }
      const c = db.byIso[s.iso3];
      markers[s.id].bindTooltip(`${i + 1}. ${c ? c.name : 'Country?'}${s.place ? ' – ' + s.place : ''}`);
    });
  }

  // ---------- events ----------
  function bindGlobal() {
    const stops = $('#stops');
    stops.addEventListener('input', e => {
      const card = e.target.closest('.stop'); if (!card) return;
      const s = stopById(card.dataset.id), f = e.target.dataset.f;
      if (f === 'place' || f === 'other') { s[f] = e.target.value; updateReport(); if (f === 'place') syncMarkers(FRT.sortStops(state.stops)); }
    });
    stops.addEventListener('change', e => {
      const card = e.target.closest('.stop'); if (!card) return;
      const s = stopById(card.dataset.id), f = e.target.dataset.f;
      if (e.target.dataset.exp) {
        const id = e.target.dataset.exp;
        s.exposures = e.target.checked ? s.exposures.concat(id) : s.exposures.filter(x => x !== id);
        e.target.closest('.chk').classList.toggle('on', e.target.checked);
        refreshPreview(card, s); updateReport(); return;
      }
      if (f === 'iso3') { s.iso3 = e.target.value; s.manualCountry = true; renderAll(); }
      else if (f === 'arrive' || f === 'depart') {
        s[f] = e.target.value;
        if (f === 'arrive' && s.depart && s.depart < s.arrive) s.depart = '';
        renderAll();
      }
    });
    stops.addEventListener('click', e => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const card = b.closest('.stop'), s = stopById(card.dataset.id);
      if (b.dataset.act === 'del') { state.stops = state.stops.filter(x => x !== s); renderAll(); }
      if (b.dataset.act === 'locate' && map && s.lat != null) map.setView([s.lat, s.lng], Math.max(map.getZoom(), 6));
    });
    $('#onset').addEventListener('change', e => { state.onset = e.target.value; renderAll(); });
    $('#returned').addEventListener('change', e => { state.returned = e.target.value; updateReport(); });
    $('#notes').addEventListener('input', e => { state.notes = e.target.value; updateReport(); });
    $('#add-stop').addEventListener('click', () => addStop(null));
    $('#clear').addEventListener('click', () => {
      if (!state.stops.length && !state.onset) return;
      const b = $('#clear');
      if (b.dataset.confirm) { state.stops = []; state.onset = state.returned = state.notes = '';
        ['#onset', '#returned', '#notes'].forEach(s => { $(s).value = ''; }); delete b.dataset.confirm; b.textContent = 'Clear all'; renderAll(); }
      else { b.dataset.confirm = '1'; b.textContent = 'Click again to clear'; setTimeout(() => { delete b.dataset.confirm; b.textContent = 'Clear all'; }, 3000); }
    });
    $('#shade').addEventListener('change', () => { if (boundaryLayer) boundaryLayer.setStyle(styleFeature); });
    $('#show-areas').addEventListener('change', e => { if (map && areaLayer) { if (e.target.checked) areaLayer.addTo(map); else map.removeLayer(areaLayer); } });
    $$('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
    $('#go-report').addEventListener('click', () => showTab('report'));
    $('#download').addEventListener('click', download);
    $('#copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('#report').textContent); $('#copied').textContent = 'Copied'; }
      catch (_) { const r = document.createRange(); r.selectNodeContents($('#report')); getSelection().removeAllRanges(); getSelection().addRange(r); $('#copied').textContent = 'Selected – press Ctrl/Cmd+C'; }
      setTimeout(() => { $('#copied').textContent = ''; }, 2500);
    });
    $('#data-country').addEventListener('change', renderDataTable);
    $('#export-expanded').addEventListener('click', exportExpanded);
  }
  function refreshPreview(card, s) { renderPreview(card, s); }
  function showTab(name) {
    $$('.tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    $$('.tab').forEach(t => { t.hidden = t.id !== 'tab-' + name; });
    if (name === 'report') updateReport();
  }

  // ---------- report ----------
  function currentText() {
    const res = FRT.analyse(db, state, todayISO());
    const now = new Date();
    const stamp = now.toISOString().slice(0, 10) + ' ' + now.toTimeString().slice(0, 5);
    return { res, text: FRT.renderText(db, state, res, { now: stamp }) };
  }
  function updateReport() {
    if (!db) return;
    const { res, text } = currentText();
    $('#report').textContent = state.stops.length ? text : 'Add at least one place stayed to build the report.';
    $('#report-count').textContent = res.summary.length ? res.summary.length : '';
    $('#report-count').className = 'badge' + (res.hcid.length ? ' warn' : '');
  }
  function download() {
    const { text } = currentText();
    const blob = new Blob([text.replace(/\n/g, '\r\n')], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `travel-exposure-history-${todayISO()}.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- data tab ----------
  function renderData() {
    $('#db-version').textContent = db.version || 'not set';
    $('#db-problems').innerHTML = db.problems.length
      ? `<div class="alert"><strong>${db.problems.length} problem(s) in the data files:</strong><ul>${db.problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>` : '';
  }
  function renderDataTable() {
    const iso = $('#data-country').value, c = db.byIso[iso];
    if (!c) { $('#data-table').innerHTML = ''; return; }
    const rows = [];
    db.exposures.forEach(e => FRT.rulesFor(db, iso, e.id).forEach(r => rows.push([e.label, db.pathogens[r.pathogen].name + (r.dep ? ' (parts of country only)' : ''), db.pathogens[r.pathogen].incubation_text, r.note, r.where, r.source])));
    (db.hcidBy[iso] || []).forEach(h => rows.unshift(['HCID (UKHSA)' + (h.show ? '' : ' – hidden'), db.pathogens[h.hcid].name, db.pathogens[h.hcid].incubation_text,
      `${h.category_text}, ${h.last_reported}${h.notes ? ' – ' + h.notes : ''}`, h.area ? 'area: ' + h.area : 'country', h.source]));
    FRT.alertsFor(db, iso, todayISO()).forEach(a => rows.unshift(['ALERT', a.pathogen ? db.pathogens[a.pathogen].name : '', '', a.title, a.where, a.source_url]));
    $('#data-table').innerHTML = `<p class="muted">${esc(c.name)} · region <code>${esc(c.region)}</code> · subregion <code>${esc(c.subregion)}</code> · tags <code>${esc(c.tags.join('; ') || 'none')}</code>${c.areaTags.length ? ` · limited to mapped areas: <code>${esc(c.areaTags.join('; '))}</code>` : ''}</p>
      ${c.areaTags.length ? `<p class="muted">Mapped areas: ${db.areas.filter(a => (!a.countries.length || a.countries.includes(c.iso3)) && a.tags.some(t => c.areaTags.includes(t))).map(a => esc(a.name)).join(' · ')}</p>` : ''}
      <div class="scroll"><table><thead><tr><th>Exposure</th><th>Pathogen</th><th>Incubation</th><th>Note</th><th>Matched by (where)</th><th>Source</th></tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map(x => `<td>${esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  function exportExpanded() {
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['country', 'iso3', 'exposure', 'pathogen', 'incubation', 'parts_of_country_only', 'note', 'source'].join(',')];
    db.countries.forEach(c => db.exposures.forEach(e => FRT.rulesFor(db, c.iso3, e.id).forEach(r => {
      const p = db.pathogens[r.pathogen];
      lines.push([c.name, c.iso3, e.label, p.name, p.incubation_text, r.dep ? 'yes' : '', r.note, r.source].map(q).join(','));
    })));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' }));
    a.download = `country-exposure-pathogen-${db.version || todayISO()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  }
})();
