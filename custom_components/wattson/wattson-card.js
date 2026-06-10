/* Wattson card - native Lovelace card, no build step.
 * Statement "spec-sheet" identity (self-themed, light by default).
 * Talks to the wattson integration over the websocket API. */

const CARD_VERSION = "0.18.0";

function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .split("&").join("&amp;").split("<").join("&lt;")
    .split(">").join("&gt;").split('"').join("&quot;")
    .split("'").join("&#39;");
}
function pad2(n) { n = String(n); return n.length < 2 ? "0" + n : n; }

const TYPE_LABEL = { single: "1-POLE", double: "2-POLE", tandem: "TANDEM" };
const STATUS_ORDER = ["unknown", "guess", "confirmed"];
const STATUS_LABEL = { unknown: "Unknown", guess: "Tentative", confirmed: "Confirmed" };
const TYPE_ORDER = ["single", "double", "tandem"];
const MAX_RESULTS = 40;

const MEASUREMENT_DOMAINS = [
  "sensor", "number", "input_number", "input_text", "input_datetime",
  "datetime", "weather", "update", "button", "input_button", "image"
];
const INACTIVE_STATES = [
  "off", "unavailable", "unknown", "idle", "standby",
  "closed", "not_home", "disarmed", "docked", "paused"
];

/* 5x7 dot-matrix font for the live readout */
const FONT = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"]
};
function matrixSVG(text, onColor, offColor) {
  const cols = 5, rows = 7, gap = 5, r = 1.8, cw = cols * gap, ch = rows * gap, sp = 7;
  const chars = String(text).split("");
  const width = chars.length * cw + (chars.length - 1) * sp;
  let svg = '<svg width="' + width + '" height="' + ch + '" viewBox="0 0 ' + width + ' ' + ch + '" xmlns="http://www.w3.org/2000/svg">';
  let x0 = 0;
  for (let c = 0; c < chars.length; c++) {
    const pat = FONT[chars[c]] || FONT["0"];
    for (let ry = 0; ry < rows; ry++) {
      for (let cx = 0; cx < cols; cx++) {
        const on = pat[ry].charAt(cx) === "1";
        svg += '<circle cx="' + (x0 + cx * gap + gap / 2) + '" cy="' + (ry * gap + gap / 2) + '" r="' + r + '" fill="' + (on ? onColor : offColor) + '"/>';
      }
    }
    x0 += cw + sp;
  }
  return svg + "</svg>";
}

class WattsonCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = {};
    this._bleed = false;
    this._data = null;
    this._loading = false;
    this._editSlot = null;
    this._editPanel = false;
    this._edit = { entities: [], devices: [], areas: [] };
    this._error = null;
    this._selected = null;
    this._drawerOpen = false;
    this._sidebar = true;
    this._lib = { query: "", scope: "all", expanded: { areas: true, devices: false, entities: false } };
    this._pending = null;
    this._drag = null;
    this._dragCell = null;
    /* mapping mode */
    this._mapping = false;
    this._map = { slot: null, phase: "idle", proposals: [], selected: {} };
  }

  static getStubConfig() { return {}; }

  setConfig(config) {
    this._config = config || {};
    this._pulse = this._config.pulse !== false;
    this._bleed = this._config.bleed === true;
    if (this._data) this._render();
  }

  static getConfigElement() { return document.createElement("wattson-card-editor"); }
  static getStubConfig() { return { pulse: true }; }

  // Sections-view layout: default to full width, content-driven height,
  // and allow the user to shrink it from the Layout tab down to half width.
  getGridOptions() { return { columns: "full", rows: "auto", min_columns: 4 }; }

  set hass(hass) {
    const first = this._hass === null;
    this._hass = hass;
    if (first && !this._data && !this._loading) { this._load(); return; }
    if (this._data) this._applyLiveStates();
  }

  getCardSize() {
    const slots = this._data && this._data.panel ? this._data.panel.slots : 24;
    return Math.ceil(slots / 2) + 4;
  }

  async _load() {
    this._loading = true;
    try { this._data = await this._hass.callWS({ type: "wattson/get" }); this._error = null; }
    catch (err) { this._error = err && err.message ? err.message : String(err); }
    this._loading = false;
    this._render();
  }

  _breaker(slot) {
    if (!this._data || !this._data.breakers) return null;
    return this._data.breakers[String(slot)] || null;
  }
  _status(b) {
    if (!b) return "unknown";
    if (b.status) return b.status;
    return b.label ? "guess" : "unknown";
  }
  _entityName(id) {
    if (this._hass && this._hass.states && this._hass.states[id]) {
      const a = this._hass.states[id].attributes;
      if (a && a.friendly_name) return a.friendly_name;
    }
    return id;
  }
  _deviceName(id) {
    if (id && String(id).indexOf("manual:") === 0) return String(id).slice(7);
    if (this._hass && this._hass.devices && this._hass.devices[id]) {
      const d = this._hass.devices[id];
      return d.name_by_user || d.name || id;
    }
    return id;
  }
  _isManualDevice(id) { return !!id && String(id).indexOf("manual:") === 0; }
  _areaList() {
    const out = [];
    if (this._hass && this._hass.areas) {
      const keys = Object.keys(this._hass.areas);
      for (let i = 0; i < keys.length; i++) {
        const a = this._hass.areas[keys[i]];
        if (a && a.name) out.push(a.name);
      }
    }
    return out;
  }

  /* ---- live state ---- */
  _isEntityActive(id) {
    const s = this._hass && this._hass.states ? this._hass.states[id] : null;
    if (!s) return false;
    const domain = String(id).split(".")[0];
    if (MEASUREMENT_DOMAINS.indexOf(domain) >= 0) return false;
    if (INACTIVE_STATES.indexOf(s.state) >= 0) return false;
    return true;
  }
  _isDeviceActive(deviceId) {
    if (this._isManualDevice(deviceId)) return false;
    if (!this._hass || !this._hass.entities) return false;
    const ents = this._hass.entities;
    const keys = Object.keys(ents);
    for (let i = 0; i < keys.length; i++) {
      const rec = ents[keys[i]];
      if (rec && rec.device_id === deviceId && this._isEntityActive(keys[i])) return true;
    }
    return false;
  }
  _areaName(id) {
    if (this._hass && this._hass.areas && this._hass.areas[id] && this._hass.areas[id].name) return this._hass.areas[id].name;
    return id;
  }
  _isAreaActive(id) {
    const m = this._areaMembers(id);
    for (let i = 0; i < m.devices.length; i++) if (this._isDeviceActive(m.devices[i])) return true;
    for (let j = 0; j < m.entities.length; j++) if (this._isEntityActive(m.entities[j])) return true;
    return false;
  }
  _breakerActive(b) {
    if (!b) return false;
    const ents = b.entities || [];
    for (let i = 0; i < ents.length; i++) if (this._isEntityActive(ents[i])) return true;
    const devs = b.devices || [];
    for (let i = 0; i < devs.length; i++) if (this._isDeviceActive(devs[i])) return true;
    const areas = b.areas || [];
    for (let k = 0; k < areas.length; k++) if (this._isAreaActive(areas[k])) return true;
    return false;
  }
  _applyLiveStates() {
    const root = this.shadowRoot;
    if (!root || !this._data) return;
    const breakers = this._data.breakers || {};
    const keys = Object.keys(breakers);
    for (let i = 0; i < keys.length; i++) {
      const cell = root.querySelector('.block[data-slot="' + keys[i] + '"]');
      if (!cell) continue;
      if (this._breakerActive(breakers[keys[i]])) cell.classList.add("hot");
      else cell.classList.remove("hot");
    }
  }

  /* ---- search (manual picker) ---- */
  _searchEntities(query) {
    const q = String(query).toLowerCase().trim();
    const out = [];
    if (!q || !this._hass || !this._hass.states) return out;
    const ids = Object.keys(this._hass.states);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (this._edit.entities.indexOf(id) >= 0) continue;
      const name = this._entityName(id);
      if (id.toLowerCase().indexOf(q) >= 0 || String(name).toLowerCase().indexOf(q) >= 0) out.push({ id: id, name: name });
      if (out.length >= MAX_RESULTS) break;
    }
    out.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    return out;
  }
  _searchDevices(query) {
    const raw = String(query).trim();
    const q = raw.toLowerCase();
    const out = [];
    if (!q) return out;
    if (this._hass && this._hass.devices) {
      const ids = Object.keys(this._hass.devices);
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (this._edit.devices.indexOf(id) >= 0) continue;
        const name = this._deviceName(id);
        if (!name || name === id) continue;
        if (String(name).toLowerCase().indexOf(q) >= 0) out.push({ id: id, name: name });
        if (out.length >= MAX_RESULTS) break;
      }
      out.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    }
    const manualId = "manual:" + raw;
    if ((this._edit.devices || []).indexOf(manualId) < 0) out.push({ id: manualId, name: 'Add "' + raw + '"', sub: "manual device (not in HA)", custom: true });
    return out;
  }
  _areaIdByName(name) {
    const q = String(name).toLowerCase().trim();
    if (!q || !this._hass || !this._hass.areas) return null;
    const ids = Object.keys(this._hass.areas);
    for (let i = 0; i < ids.length; i++) {
      const a = this._hass.areas[ids[i]];
      if (a && a.name && a.name.toLowerCase() === q) return ids[i];
    }
    return null;
  }
  _searchAreas(query) {
    const q = String(query).toLowerCase().trim();
    const have = this._edit.areas || [];
    const out = [];
    if (this._hass && this._hass.areas) {
      const ids = Object.keys(this._hass.areas);
      for (let i = 0; i < ids.length; i++) {
        const a = this._hass.areas[ids[i]];
        if (!a || !a.name) continue;
        if (have.indexOf(ids[i]) >= 0) continue;
        if (q && a.name.toLowerCase().indexOf(q) < 0) continue;
        out.push({ id: ids[i], name: a.name, sub: "HA area" });
        if (out.length >= MAX_RESULTS) break;
      }
    }
    out.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    if (q) {
      const exact = this._areaIdByName(q);
      const dupe = have.indexOf(query.trim()) >= 0 || (exact && have.indexOf(exact) >= 0);
      if (!exact && !dupe) out.unshift({ id: query.trim(), name: 'Add "' + query.trim() + '"', sub: "new custom area", custom: true });
    }
    return out;
  }
  _addAreaFromText(text) {
    const t = String(text).trim();
    if (!t) return;
    const exact = this._areaIdByName(t);
    this._addLink("area", exact || t);
  }
  _addManualDevice(text) {
    const t = String(text).trim();
    if (!t) return;
    this._addLink("dev", "manual:" + t);
  }
  _openBreaker(slot) {
    const b = this._breaker(slot) || {};
    this._edit = { entities: (b.entities || []).slice(), devices: (b.devices || []).slice(), areas: (b.areas || []).slice() };
    this._editSlot = slot;
    this._editPanel = false;
    this._render();
    const label = this.shadowRoot.getElementById("f-label");
    if (label) label.focus();
  }
  async _saveBreaker() {
    const root = this.shadowRoot;
    const slot = this._editSlot;
    const val = function (id) { const el = root.getElementById(id); return el ? el.value : ""; };
    const ampsRaw = String(val("f-amps")).trim();
    let amps = ampsRaw === "" ? null : parseInt(ampsRaw, 10);
    if (amps !== null && isNaN(amps)) amps = null;
    let num = String(val("f-num")).trim();
    if (num === pad2(slot)) num = "";
    const payload = {
      type: "wattson/save_breaker", slot: slot,
      label: String(val("f-label")).trim(), number: num, breaker_type: val("f-type"),
      status: val("f-status"),
      notes: val("f-notes"), amps: amps,
      entities: this._edit.entities.slice(), devices: this._edit.devices.slice(), areas: this._edit.areas.slice()
    };
    try { const u = await this._hass.callWS(payload); this._data.breakers[String(slot)] = u; this._error = null; }
    catch (err) { this._error = err && err.message ? err.message : String(err); }
    this._editSlot = null;
    this._render();
  }
  async _clearBreaker() {
    const slot = this._editSlot;
    try { await this._hass.callWS({ type: "wattson/clear_breaker", slot: slot }); delete this._data.breakers[String(slot)]; this._error = null; }
    catch (err) { this._error = err && err.message ? err.message : String(err); }
    this._editSlot = null;
    this._render();
  }
  async _savePanel() {
    const root = this.shadowRoot;
    const name = String(root.getElementById("p-name").value).trim();
    const slots = parseInt(root.getElementById("p-slots").value, 10);
    const columns = parseInt(root.getElementById("p-columns").value, 10);
    const payload = { type: "wattson/set_panel", name: name };
    if (!isNaN(slots)) payload.slots = slots;
    if (!isNaN(columns)) payload.columns = columns;
    try { this._data = await this._hass.callWS(payload); this._error = null; }
    catch (err) { this._error = err && err.message ? err.message : String(err); }
    this._editPanel = false;
    this._render();
  }

  /* ---- picker rendering ---- */
  _editKey(kind) { return kind === "ent" ? "entities" : (kind === "dev" ? "devices" : "areas"); }
  _kindName(kind, id) {
    if (kind === "ent") return this._entityName(id);
    if (kind === "dev") return this._deviceName(id);
    return this._areaName(id);
  }
  _renderChips(kind) {
    const box = this.shadowRoot.getElementById(kind + "-chips");
    if (!box) return;
    const list = this._edit[this._editKey(kind)] || [];
    if (!list.length) { box.innerHTML = '<span class="empty">None linked.</span>'; return; }
    let html = "";
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      let tag = "";
      if (kind === "area" && !(this._hass && this._hass.areas && this._hass.areas[id])) tag = "CUSTOM";
      else if (kind === "dev" && this._isManualDevice(id)) tag = "MANUAL";
      html += '<span class="chip"><span class="chiptext" title="' + esc(id) + '">' + esc(this._kindName(kind, id)) +
        (tag ? ' <span class="ptag">' + tag + '</span>' : "") +
        '</span><button class="chipx" data-remove-' + kind + '="' + esc(id) + '" title="Remove">&times;</button></span>';
    }
    box.innerHTML = html;
  }
  _renderResults(kind, query) {
    const box = this.shadowRoot.getElementById(kind + "-results");
    if (!box) return;
    if (!String(query).trim()) { box.innerHTML = ""; box.style.display = "none"; return; }
    const matches = kind === "ent" ? this._searchEntities(query) : (kind === "dev" ? this._searchDevices(query) : this._searchAreas(query));
    if (!matches.length) { box.innerHTML = '<div class="res empty">No matches</div>'; box.style.display = "block"; return; }
    let html = "";
    for (let i = 0; i < matches.length; i++) {
      html += '<div class="res' + (matches[i].custom ? " mk" : "") + '" data-add-' + kind + '="' + esc(matches[i].id) + '"><span class="rname">' +
        esc(matches[i].name) + '</span><span class="rid">' + esc(matches[i].sub || matches[i].id) + "</span></div>";
    }
    box.innerHTML = html; box.style.display = "block";
  }
  _addLink(kind, id) {
    const key = this._editKey(kind);
    if (this._edit[key].indexOf(id) < 0) this._edit[key].push(id);
    const input = this.shadowRoot.getElementById(kind + "-search");
    if (input) { input.value = ""; input.focus(); }
    this._renderResults(kind, ""); this._renderChips(kind);
  }
  _removeLink(kind, id) {
    const key = this._editKey(kind);
    const idx = this._edit[key].indexOf(id);
    if (idx >= 0) this._edit[key].splice(idx, 1);
    this._renderChips(kind);
  }

  /* ---- mapping mode ---- */
  _enterMapping() {
    this._mapping = true;
    this._map = { slot: this._firstUnmapped(), phase: "idle", proposals: [], selected: {} };
    this._render();
  }
  async _exitMapping() {
    this._mapping = false;
    try { await this._hass.callWS({ type: "wattson/discover/cancel" }); } catch (e) { /* ignore */ }
    this._map = { slot: null, phase: "idle", proposals: [], selected: {} };
    this._render();
  }
  _firstUnmapped() {
    const slots = this._data && this._data.panel ? this._data.panel.slots : 24;
    for (let s = 1; s <= slots; s++) {
      const b = this._breaker(s);
      const linked = b && ((b.entities && b.entities.length) || (b.devices && b.devices.length) || (b.areas && b.areas.length));
      if (!linked) return s;
    }
    return 1;
  }
  _setTarget(slot) { this._map.slot = slot; this._map.phase = "idle"; this._map.proposals = []; this._render(); }
  _stepTarget(delta) {
    const slots = this._data && this._data.panel ? this._data.panel.slots : 24;
    let s = (this._map.slot || 1) + delta;
    if (s < 1) s = 1; if (s > slots) s = slots;
    this._setTarget(s);
  }
  async _arm() {
    try { await this._hass.callWS({ type: "wattson/discover/start", slot: this._map.slot }); this._map.phase = "armed"; this._error = null; }
    catch (err) { this._error = err && err.message ? err.message : String(err); }
    this._render();
  }
  _buildProposals(raw) {
    const ents = (this._hass && this._hass.entities) ? this._hass.entities : {};
    const order = [], byDev = {}, loose = [];
    for (let i = 0; i < raw.length; i++) {
      const eid = raw[i].entity_id;
      const ename = raw[i].name || eid;
      const rec = ents[eid];
      const did = (rec && rec.device_id) ? rec.device_id : null;
      if (did) {
        if (!byDev[did]) { byDev[did] = { kind: "device", id: did, key: "device:" + did, name: this._deviceName(did), entids: [] }; order.push(did); }
        byDev[did].entids.push(ename);
      } else {
        loose.push({ kind: "entity", id: eid, key: "entity:" + eid, name: ename, sub: eid });
      }
    }
    const out = [];
    for (let i = 0; i < order.length; i++) {
      const d = byDev[order[i]];
      const n = d.entids.length;
      d.sub = n + (n === 1 ? " signal: " : " signals: ") + d.entids.slice(0, 3).join(", ") + (n > 3 ? "..." : "");
      out.push(d);
    }
    return out.concat(loose);
  }
  async _capture() {
    try {
      const res = await this._hass.callWS({ type: "wattson/discover/capture", slot: this._map.slot });
      const raw = (res && res.proposals) ? res.proposals : [];
      this._map.proposals = this._buildProposals(raw);
      this._map.selected = {};
      for (let i = 0; i < this._map.proposals.length; i++) this._map.selected[this._map.proposals[i].key] = true;
      this._map.phase = "captured";
      this._error = null;
    } catch (err) { this._error = err && err.message ? err.message : String(err); }
    this._render();
  }
  async _acceptProposals() {
    const slot = this._map.slot;
    const b = this._breaker(slot) || {};
    const devs = (b.devices || []).slice(), ents = (b.entities || []).slice();
    const has = function (arr, v) { for (let i = 0; i < arr.length; i++) if (arr[i] === v) return true; return false; };
    const p = this._map.proposals;
    for (let i = 0; i < p.length; i++) {
      if (!this._map.selected[p[i].key]) continue;
      if (p[i].kind === "device") { if (!has(devs, p[i].id)) devs.push(p[i].id); }
      else { if (!has(ents, p[i].id)) ents.push(p[i].id); }
    }
    try {
      const payload = { type: "wattson/save_breaker", slot: slot, devices: devs, entities: ents };
      const anyLink = devs.length || ents.length || (b.areas && b.areas.length);
      if (anyLink && (!b.status || b.status === "unknown")) payload.status = "confirmed";
      const u = await this._hass.callWS(payload);
      this._data.breakers[String(slot)] = u;
      this._error = null;
    } catch (err) { this._error = err && err.message ? err.message : String(err); }
    this._advance();
  }
  _advance() {
    const slots = this._data && this._data.panel ? this._data.panel.slots : 24;
    let s = (this._map.slot || 0) + 1;
    if (s > slots) s = slots;
    this._map.slot = s; this._map.phase = "idle"; this._map.proposals = []; this._map.selected = {};
    this._render();
  }

  /* ---- selection + linked-circuit inspector (drawer) ---- */
  _selectBreaker(slot) {
    this._selected = (this._selected === slot) ? null : slot;
    this._render();
  }
  _reduceMotion() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) { return false; }
  }
  _areaTreeHtml(members) {
    const rowH = 26, w = 40, trunkX = 14, endX = 34, n = members.length;
    const svgH = Math.max(rowH, n * rowH);
    const lastY = (n - 1) * rowH + rowH / 2;
    const pulse = this._pulse && !this._reduceMotion();
    let svg = "<svg class='atreesvg' width='" + w + "' height='" + svgH + "' viewBox='0 0 " + w + " " + svgH + "' xmlns='http://www.w3.org/2000/svg'>";
    svg += "<line x1='" + trunkX + "' y1='0' x2='" + trunkX + "' y2='" + lastY + "' stroke='#9aa4ee' stroke-width='1.4'/>";
    svg += "<circle cx='" + trunkX + "' cy='0' r='3' fill='#4a5bd8'/>";
    let rows = "";
    for (let i = 0; i < n; i++) {
      const by = i * rowH + rowH / 2, it = members[i];
      svg += "<line x1='" + trunkX + "' y1='" + by + "' x2='" + endX + "' y2='" + by + "' stroke='" + (it.active ? "#4a5bd8" : "#9aa4ee") + "' stroke-width='1.3' stroke-dasharray='3 3'/>";
      if (it.active && pulse) {
        svg += "<circle r='3' fill='#ffb01f'><animateMotion dur='2.6s' begin='" + (i * 0.18).toFixed(2) + "s' repeatCount='indefinite' path='M" + trunkX + " 0 L" + trunkX + " " + by + " L" + endX + " " + by + "'/></circle>";
      }
      rows += "<div class='mrow'><span class='pdot " + (it.active ? "on" : "off") + "'></span>" +
        "<span class='pname2'>" + esc(it.name) + (it.device ? " <span class='tagd' title='Home Assistant device'>DEV</span>" : "") + "</span>" +
        "<span class='pstate " + (it.active ? "on" : "") + "'>" + (it.active ? "ON" : "off") + "</span></div>";
    }
    svg += "</svg>";
    return "<div class='atree'>" + svg + "<div class='amembers'>" + rows + "</div></div>";
  }
  _linkRow(name, active, tag, unlinkKind, id) {
    const manual = tag === "MANUAL";
    const wireCls = "wire " + (manual ? "manual" : (active ? "active" : "idle"));
    const dotCls = "pdot " + (manual ? "man" : (active ? "on" : "off"));
    const stateTxt = manual ? "" : (active ? "ON" : "off");
    return "<div class='prow'><span class='" + wireCls + "'><span class='wdash'></span><span class='wpulse'></span></span>" +
      "<span class='" + dotCls + "'></span>" +
      "<span class='pname2'>" + esc(name) + (tag ? " <span class='tagd' title='" + (tag === "DEV" ? "Home Assistant device" : "Manual device - not connected to Home Assistant") + "'>" + tag + "</span>" : "") + "</span>" +
      "<span class='pstate " + (active && !manual ? "on" : "") + "'>" + stateTxt + "</span>" +
      (unlinkKind ? "<button class='unlink' data-unlink-kind='" + unlinkKind + "' data-unlink-id='" + esc(id) + "' title='Unlink'>&times;</button>" : "") +
      "</div>";
  }
  _inspectorHtml() {
    if (this._mapping || this._selected === null || this._editSlot !== null) return "";
    const slot = this._selected;
    const b = this._breaker(slot) || {};
    const areas = b.areas || [], devs = b.devices || [], ents = b.entities || [];
    const haDevs = [], manDevs = [];
    for (let i = 0; i < devs.length; i++) { if (this._isManualDevice(devs[i])) manDevs.push(devs[i]); else haDevs.push(devs[i]); }
    const total = areas.length + devs.length + ents.length;
    const meta = [];
    if (b.amps) meta.push(b.amps + "A");
    if (b.breaker_type === "double") meta.push("2-POLE");
    meta.push((STATUS_LABEL[this._status(b)] || "Unknown").toUpperCase());
    let body = "";
    if (!total) {
      body = "<div class='mempty'>No links yet. Drag an item from the library, <b>Edit</b> to add by hand, or <b>Map this</b> to discover by flipping the breaker.</div>";
    } else {
      for (let a = 0; a < areas.length; a++) {
        const aid = areas[a], m = this._areaMembers(aid);
        const isHa = !!(this._hass && this._hass.areas && this._hass.areas[aid]);
        const members = [];
        for (let i = 0; i < m.devices.length; i++) members.push({ name: this._deviceName(m.devices[i]), active: this._isDeviceActive(m.devices[i]), device: true });
        for (let j = 0; j < m.entities.length; j++) members.push({ name: this._entityName(m.entities[j]), active: this._isEntityActive(m.entities[j]), device: false });
        const note = isHa ? "No HA devices/entities in this area yet." : "Custom area label - add devices to this breaker directly.";
        const tree = members.length ? this._areaTreeHtml(members) : "<div class='libnote'>" + note + "</div>";
        body += "<div class='agroup'><div class='ahead'><span class='atag'>" + (isHa ? "AREA" : "CUSTOM") + "</span><span class='aname'>" + esc(this._areaName(aid)) + "</span>" +
          "<span class='acount'>" + members.length + "</span>" +
          "<button class='unlink' data-unlink-kind='area' data-unlink-id='" + esc(aid) + "' title='Unlink area'>&times;</button></div>" + tree + "</div>";
      }
      if (haDevs.length || ents.length) {
        body += "<div class='lblgroup'>HA Connected</div>";
        for (let i = 0; i < haDevs.length; i++) body += this._linkRow(this._deviceName(haDevs[i]), this._isDeviceActive(haDevs[i]), "DEV", "device", haDevs[i]);
        for (let i = 0; i < ents.length; i++) body += this._linkRow(this._entityName(ents[i]), this._isEntityActive(ents[i]), "", "entity", ents[i]);
      }
      if (manDevs.length) {
        body += "<div class='lblgroup'>Manually Added</div>";
        for (let i = 0; i < manDevs.length; i++) body += this._linkRow(this._deviceName(manDevs[i]), false, "MANUAL", "device", manDevs[i]);
      }
    }
    const numVal = (b.number != null && b.number !== "") ? esc(String(b.number)) : pad2(slot);
    const labelVal = b.label ? esc(b.label) : "";
    return "<div class='scrim' id='insp-scrim'></div>" +
      "<div class='drawer" + (this._drawerOpen ? " open" : "") + "'>" +
      "<div class='insptop'><input class='numedit' id='insp-num' value='" + numVal + "' title='Breaker number' aria-label='Breaker number'>" +
      "<input class='titledit' id='insp-label' value='" + labelVal + "' placeholder='Unlabeled' aria-label='Label'>" +
      "<button class='ibtn' id='insp-close' title='Close'>&times;</button></div>" +
      "<div class='inspmeta'>" + esc(meta.join("  /  ")) + "</div>" +
      "<div class='inspacts'><button class='btn' id='insp-edit'>Edit</button><button class='btn' id='insp-map'>Map this</button></div>" +
      "<div class='prows'>" + body + "</div>" +
      "</div>";
  }
  _openDrawer() {
    const root = this.shadowRoot;
    const dr = root.querySelector(".drawer");
    const sc = root.querySelector("#insp-scrim");
    if (!dr) { this._drawerOpen = false; return; }
    if (this._drawerOpen) { dr.classList.add("open"); if (sc) sc.classList.add("open"); return; }
    const self = this;
    window.requestAnimationFrame(function () { dr.classList.add("open"); if (sc) sc.classList.add("open"); self._drawerOpen = true; });
  }
  async _saveInline() {
    const root = this.shadowRoot;
    const slot = this._selected;
    if (slot === null) return;
    const numEl = root.getElementById("insp-num");
    const lblEl = root.getElementById("insp-label");
    if (!numEl && !lblEl) return;
    const b = this._breaker(slot) || {};
    const numRaw = numEl ? String(numEl.value).trim() : "";
    const lblRaw = lblEl ? String(lblEl.value).trim() : "";
    const numStore = (numRaw === "" || numRaw === pad2(slot)) ? "" : numRaw;
    const payload = { type: "wattson/save_breaker", slot: slot, label: lblRaw, number: numStore };
    if (lblRaw && (!b.status || b.status === "unknown")) payload.status = "guess";
    try { const u = await this._hass.callWS(payload); this._data.breakers[String(slot)] = u; this._error = null; }
    catch (err) { this._error = err && err.message ? err.message : String(err); }
    this._render();
  }
  async _unlink(slot, kind, id) {
    const b = this._breaker(slot) || {};
    let ents = (b.entities || []).slice(), devs = (b.devices || []).slice(), ar = (b.areas || []).slice();
    function drop(arr, v) { return arr.filter(function (x) { return x !== v; }); }
    if (kind === "entity") ents = drop(ents, id);
    else if (kind === "device") devs = drop(devs, id);
    else if (kind === "area") ar = drop(ar, id);
    const payload = { type: "wattson/save_breaker", slot: slot, entities: ents, devices: devs, areas: ar };
    try { const u = await this._hass.callWS(payload); this._data.breakers[String(slot)] = u; this._error = null; }
    catch (err) { this._error = err && err.message ? err.message : String(err); }
    this._render();
  }
  _mappedSets() {
    const ms = { areas: {}, devices: {}, entities: {} };
    const br = (this._data && this._data.breakers) || {};
    const ents = (this._hass && this._hass.entities) || {};
    const bk = Object.keys(br);
    for (let i = 0; i < bk.length; i++) {
      const b = br[bk[i]];
      const ba = b.areas || []; for (let j = 0; j < ba.length; j++) ms.areas[ba[j]] = 1;
      const bd = b.devices || []; for (let j = 0; j < bd.length; j++) ms.devices[bd[j]] = 1;
      const be = b.entities || []; for (let j = 0; j < be.length; j++) ms.entities[be[j]] = 1;
    }
    const ak = Object.keys(ms.areas);
    for (let i = 0; i < ak.length; i++) { const m = this._areaMembers(ak[i]); for (let j = 0; j < m.devices.length; j++) ms.devices[m.devices[j]] = 1; for (let k = 0; k < m.entities.length; k++) ms.entities[m.entities[k]] = 1; }
    const ek = Object.keys(ents);
    for (let i = 0; i < ek.length; i++) { const r = ents[ek[i]]; if (r && r.device_id && ms.devices[r.device_id]) ms.entities[ek[i]] = 1; }
    return ms;
  }

  /* ---- library (sidebar) ---- */
  _areaMembers(areaId) {
    const ents = (this._hass && this._hass.entities) ? this._hass.entities : {};
    const devs = (this._hass && this._hass.devices) ? this._hass.devices : {};
    const devSet = {}, entList = [];
    const keys = Object.keys(ents);
    for (let i = 0; i < keys.length; i++) {
      const eid = keys[i], rec = ents[eid];
      let aid = rec.area_id;
      if (!aid && rec.device_id && devs[rec.device_id]) aid = devs[rec.device_id].area_id;
      if (aid === areaId) { if (rec.device_id) devSet[rec.device_id] = true; else entList.push(eid); }
    }
    return { devices: Object.keys(devSet), entities: entList };
  }
  _areaCountLabel(areaId) {
    const m = this._areaMembers(areaId);
    const c = m.devices.length + m.entities.length;
    return c + (c === 1 ? " item" : " items");
  }
  _libraryHtml() {
    const pend = this._pending
      ? "<div class='libhint'><span>Tap a breaker to map <b>" + esc(this._pendingName()) + "</b></span><span class='spacer2'></span><button class='ibtn' id='lib-cancelpend' title='Cancel'>&times;</button></div>"
      : "<div class='libhint dim'>Tap or drag an item onto a breaker.</div>";
    return "<div class='sidebar'>" +
      "<div class='libtop'><span class='libttl'>LIBRARY</span><span class='spacer2'></span><button class='ibtn' id='lib-collapse' title='Collapse library'>&#9664;</button></div>" +
      "<div class='libsearch'><input id='lib-search' type='text' autocomplete='off' placeholder='Search library...' value='" + esc(this._lib.query) + "'></div>" +
      "<div class='libscope'>" +
        "<button class='scbtn" + (this._lib.scope === "unmapped" ? "" : " on") + "' data-scope='all'>All</button>" +
        "<button class='scbtn" + (this._lib.scope === "unmapped" ? " on" : "") + "' data-scope='unmapped'>Unmapped</button>" +
      "</div>" +
      this._libSection("areas", "Areas") + this._libSection("devices", "Devices") +
      pend + "</div>";
  }
  _libSection(key, label) {
    const open = this._lib.expanded[key];
    return "<div class='libsec " + (open ? "open" : "") + "' data-sec='" + key + "'>" +
      "<button class='libhead' data-sectoggle='" + key + "'><span class='caret'>" + (open ? "&#9662;" : "&#9656;") + "</span>" + label + "<span class='seccount' id='count-" + key + "'></span></button>" +
      "<div class='liblist' id='list-" + key + "'></div></div>";
  }
  _pendingIs(kind, id) { return this._pending && this._pending.kind === kind && this._pending.id === id; }
  _pendingName() {
    if (!this._pending) return "";
    if (this._pending.kind === "entity") return this._entityName(this._pending.id);
    if (this._pending.kind === "device") return this._deviceName(this._pending.id);
    if (this._pending.kind === "area" && this._hass.areas && this._hass.areas[this._pending.id]) return this._hass.areas[this._pending.id].name;
    return this._pending.id;
  }
  _fillList(key, items, note) {
    const box = this.shadowRoot.getElementById("list-" + key);
    if (!box) return;
    if (!items.length) { box.innerHTML = "<div class='libnote'>" + (this._lib.query ? "No matches" : "None") + "</div>"; return; }
    let html = "";
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      html += "<div class='libitem" + (this._pendingIs(it.kind, it.id) ? " armed" : "") + "' draggable='true' data-kind='" + esc(it.kind) + "' data-id='" + esc(it.id) + "'>" +
        "<span class='liname'>" + esc(it.name) + "</span><span class='lisub'>" + esc(it.sub) + "</span></div>";
    }
    if (note) html += "<div class='libnote'>" + esc(note) + "</div>";
    box.innerHTML = html;
  }
  _setText(id, txt) { const el = this.shadowRoot.getElementById(id); if (el) el.textContent = txt; }
  _renderLibraryLists() {
    const q = String(this._lib.query || "").toLowerCase().trim();
    const unmapped = this._lib.scope === "unmapped";
    const ms = unmapped ? this._mappedSets() : null;
    const areas = [];
    if (this._hass && this._hass.areas) { const k = Object.keys(this._hass.areas); for (let i = 0; i < k.length; i++) { const a = this._hass.areas[k[i]]; if (!a || !a.name) continue; if (q && a.name.toLowerCase().indexOf(q) < 0) continue; if (unmapped && ms.areas[k[i]]) continue; areas.push({ kind: "area", id: k[i], name: a.name, sub: this._areaCountLabel(k[i]) }); } }
    areas.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    const devices = [];
    if (this._hass && this._hass.devices) { const k = Object.keys(this._hass.devices); for (let i = 0; i < k.length; i++) { const n = this._deviceName(k[i]); if (!n || n === k[i]) continue; if (q && n.toLowerCase().indexOf(q) < 0) continue; if (unmapped && ms.devices[k[i]]) continue; devices.push({ kind: "device", id: k[i], name: n, sub: "device" }); } }
    devices.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    this._fillList("areas", areas);
    this._fillList("devices", devices);
    this._setText("count-areas", areas.length);
    this._setText("count-devices", devices.length);
  }
  _armItem(kind, id) {
    if (this._pendingIs(kind, id)) this._pending = null;
    else this._pending = { kind: kind, id: id };
    this._render();
  }
  async _assign(slot, kind, id) {
    if (this._mapping) return;
    const b = this._breaker(slot) || {};
    let ents = (b.entities || []).slice(), devs = (b.devices || []).slice(), ar = (b.areas || []).slice();
    if (kind === "entity") { if (ents.indexOf(id) < 0) ents.push(id); }
    else if (kind === "device") { if (devs.indexOf(id) < 0) devs.push(id); }
    else if (kind === "area") { if (ar.indexOf(id) < 0) ar.push(id); }
    const payload = { type: "wattson/save_breaker", slot: slot, entities: ents, devices: devs, areas: ar };
    if (!b.status || b.status === "unknown") payload.status = "guess";
    try { const u = await this._hass.callWS(payload); this._data.breakers[String(slot)] = u; this._error = null; }
    catch (err) { this._error = err && err.message ? err.message : String(err); }
    this._pending = null;
    this._render();
  }

  /* ---- cells ---- */
  _cellHtml(slot) {
    const b = this._breaker(slot);
    const st = this._status(b);
    const isLeft = (slot % 2) === 1;
    const sw = '<span class="sw ' + (isLeft ? "r" : "l") + '"></span>';
    const meta = [];
    if (b && b.amps) meta.push(esc(b.amps) + "A");
    if (b && b.breaker_type && b.breaker_type === "double") meta.push("2-POLE");
    if (b && b.areas && b.areas.length) { const nms = []; for (let i = 0; i < b.areas.length; i++) nms.push(this._areaName(b.areas[i])); meta.push(esc(nms.join(", ").toUpperCase())); }
    else if (b && b.area) meta.push(esc(String(b.area).toUpperCase()));
    const ents = b && b.entities ? b.entities : [];
    const devs = b && b.devices ? b.devices : [];
    const areas = b && b.areas ? b.areas : [];
    const linkCount = ents.length + devs.length + areas.length;
    let lk = "";
    if (linkCount > 0) {
      const names = [];
      for (let i = 0; i < areas.length; i++) names.push(this._areaName(areas[i]));
      for (let i = 0; i < ents.length; i++) names.push(this._entityName(ents[i]));
      for (let i = 0; i < devs.length; i++) names.push(this._deviceName(devs[i]));
      lk = '<span class="lk" title="' + esc(names.join(", ")) + '">' + linkCount + " LINK" + (linkCount > 1 ? "S" : "") + "</span>";
    }
    const lbl = b && b.label ? esc(b.label) : '<span class="empty">OPEN</span>';
    const target = (this._mapping && this._map.slot === slot) ? " target" : "";
    const selected = (!this._mapping && this._selected === slot) ? " selected" : "";
    const numTxt = (b && b.number) ? esc(String(b.number)) : pad2(slot);
    const inner =
      '<span class="tab">' + numTxt + '</span>' +
      '<div class="bd"><div class="lbl">' + lbl + '</div><div class="mt">' + meta.join("   /   ") + '</div></div>' + lk;
    const body = isLeft ? (inner + sw) : (sw + inner);
    return '<div class="block ' + st + target + selected + '" data-slot="' + slot + '">' + body + "</div>";
  }

  /* ---- overlays ---- */
  _pickerSectionHtml(kind, title, placeholder) {
    return '<div class="picker"><div class="pickhead">' + title + '</div>' +
      '<div class="combo"><input id="' + kind + '-search" type="text" autocomplete="off" placeholder="' + placeholder + '">' +
      '<div class="results" id="' + kind + '-results" style="display:none"></div></div>' +
      '<div class="chips" id="' + kind + '-chips"></div></div>';
  }
  _overlayHtml(panel) {
    if (this._editSlot !== null) {
      const slot = this._editSlot;
      const b = this._breaker(slot) || {};
      const st = b.status || (b.label ? "guess" : "unknown");
      let typeOpts = "";
      for (let i = 0; i < TYPE_ORDER.length; i++) {
        const t = TYPE_ORDER[i];
        typeOpts += '<option value="' + t + '"' + ((b.breaker_type || "single") === t ? " selected" : "") + ">" + TYPE_LABEL[t] + "</option>";
      }
      let statusOpts = "";
      for (let i = 0; i < STATUS_ORDER.length; i++) {
        const s = STATUS_ORDER[i];
        statusOpts += '<option value="' + s + '"' + (st === s ? " selected" : "") + ">" + STATUS_LABEL[s] + "</option>";
      }
      return '<div class="ovl" id="ovl"><div class="dialog">' +
        '<div class="dlgHead">BREAKER ' + pad2(slot) + "</div>" +
        '<div class="row2 nl"><label>NO.<input id="f-num" type="text" value="' + esc(b.number || "") + '" placeholder="' + pad2(slot) + '"></label>' +
        '<label>LABEL<input id="f-label" type="text" value="' + esc(b.label || "") + '" placeholder="e.g. Kitchen counter outlets"></label></div>' +
        '<div class="row2"><label>AMPS<input id="f-amps" type="number" inputmode="numeric" value="' + (b.amps != null ? esc(b.amps) : "") + '" placeholder="15"></label>' +
        '<label>TYPE<select id="f-type">' + typeOpts + "</select></label></div>" +
        '<label>STATUS<select id="f-status">' + statusOpts + "</select></label>" +
        '<label>NOTES<textarea id="f-notes" rows="2" placeholder="What does it actually control? How did you confirm it?">' + esc(b.notes || "") + "</textarea></label>" +
        this._pickerSectionHtml("area", "AREAS", "Search HA areas, or type a custom name + Enter...") +
        this._pickerSectionHtml("dev", "DEVICES", "Search HA devices, or type a name + Enter for a dumb device...") +
        '<div class="actions"><button class="btn ghost" id="btn-clear">Clear</button><span class="spacer2"></span>' +
        '<button class="btn" id="btn-cancel">Cancel</button><button class="btn primary" id="btn-save">Save</button></div>' +
        "</div></div>";
    }
    if (this._editPanel) {
      return '<div class="ovl" id="ovl"><div class="dialog"><div class="dlgHead">PANEL SETTINGS</div>' +
        '<label>NAME<input id="p-name" type="text" value="' + esc(panel.name || "") + '"></label>' +
        '<div class="row2"><label>SLOTS (BREAKERS)<div class="stepper"><button class="btn sq" id="p-minus" title="Remove a row">&minus;</button>' +
        '<input id="p-slots" type="number" min="2" max="120" value="' + esc(panel.slots || 20) + '"><button class="btn sq" id="p-plus" title="Add a row">+</button></div></label>' +
        '<label>COLUMNS<input id="p-columns" type="number" min="1" max="4" value="' + esc(panel.columns || 2) + '"></label></div>' +
        '<div class="dlgnote">Add or remove breakers in pairs (one row). Reducing the count hides the higher-numbered breakers; their labels are kept and reappear if you add the slots back.</div>' +
        '<div class="actions"><span class="spacer2"></span><button class="btn" id="p-cancel">Cancel</button><button class="btn primary" id="p-save">Save</button></div>' +
        "</div></div>";
    }
    return "";
  }

  _mappingBarHtml() {
    const slot = this._map.slot;
    const b = this._breaker(slot) || {};
    const lbl = b.label ? esc(b.label) : "Unmapped";
    let phaseHtml = "";
    if (this._map.phase === "idle") {
      phaseHtml =
        '<div class="mrow"><button class="btn sq" id="m-prev">&#8249;</button>' +
        '<div class="mtarget"><span class="mtab">' + pad2(slot) + '</span><span class="mlabel">' + lbl + '</span></div>' +
        '<button class="btn sq" id="m-next">&#8250;</button>' +
        '<span class="spacer2"></span><button class="btn primary" id="m-arm">Arm &amp; listen</button></div>' +
        '<div class="mhint">Pick the breaker you are about to switch, then arm. Or tap any breaker in the panel.</div>';
    } else if (this._map.phase === "armed") {
      phaseHtml =
        '<div class="mrow listening"><span class="dotpulse"></span>' +
        '<div class="mtarget"><span class="mtab hot">' + pad2(slot) + '</span><span class="mlabel">Listening for circuit ' + pad2(slot) + '</span></div>' +
        '<span class="spacer2"></span><button class="btn" id="m-cancel2">Cancel</button><button class="btn primary" id="m-capture">Capture</button></div>' +
        '<div class="mhint">Now flip breaker ' + pad2(slot) + ' <b>OFF</b> at the panel. Wait a few seconds (Wi-Fi gear can lag), then Capture.</div>';
    } else if (this._map.phase === "captured") {
      const p = this._map.proposals;
      let list = "";
      if (!p.length) {
        list = '<div class="mempty">Nothing dropped. Either nothing on this circuit is a smart device, or it has not gone offline yet. Wait longer and re-capture, or skip.</div>';
      } else {
        for (let i = 0; i < p.length; i++) {
          const it = p[i];
          const chk = this._map.selected[it.key] ? " checked" : "";
          const tag = it.kind === "device" ? "DEVICE" : "ENTITY";
          list += '<label class="prop"><input type="checkbox" data-prop="' + esc(it.key) + '"' + chk + '>' +
            '<span class="pn">' + esc(it.name) + ' <span class="ptag">' + tag + '</span></span><span class="pid">' + esc(it.sub || it.id) + "</span></label>";
        }
      }
      phaseHtml =
        '<div class="mrow"><div class="mtarget"><span class="mtab">' + pad2(slot) + '</span><span class="mlabel">Dropped when ' + pad2(slot) + ' went off</span></div>' +
        '<span class="spacer2"></span><button class="btn" id="m-recap">Re-capture</button></div>' +
        '<div class="proplist">' + list + "</div>" +
        '<div class="mrow"><button class="btn ghost" id="m-skip">Skip</button><span class="spacer2"></span>' +
        '<button class="btn primary" id="m-accept">Map to ' + pad2(slot) + ' &amp; next &#8250;</button></div>' +
        '<div class="mhint">Wattson groups the dropped signals by device. Flip the breaker back <b>ON</b> before moving on, and confirm only what truly lost power - a hub on this circuit can drag its devices offline too.</div>';
    }
    return '<div class="mapbar"><div class="maphead"><span class="mk">MAPPING MODE</span>' +
      '<span class="spacer2"></span><button class="btn ghost" id="m-exit">Exit</button></div>' + phaseHtml + "</div>";
  }

  /* ---- wiring ---- */
  _findAttr(start, container, attr) {
    let node = start;
    while (node && node !== container) {
      if (node.getAttribute) { const v = node.getAttribute(attr); if (v) return v; }
      node = node.parentNode;
    }
    return null;
  }
  _wirePicker(kind) {
    const root = this.shadowRoot, self = this;
    const input = root.getElementById(kind + "-search");
    const results = root.getElementById(kind + "-results");
    const chips = root.getElementById(kind + "-chips");
    if (input) {
      input.addEventListener("input", function () { self._renderResults(kind, input.value); });
      input.addEventListener("focus", function () { self._renderResults(kind, input.value); });
      input.addEventListener("blur", function () { setTimeout(function () { const r = root.getElementById(kind + "-results"); if (r) r.style.display = "none"; }, 150); });
      if (kind === "area") input.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); self._addAreaFromText(input.value); } });
      if (kind === "dev") input.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); self._addManualDevice(input.value); } });
    }
    if (results) results.addEventListener("click", function (ev) { const id = self._findAttr(ev.target, results, "data-add-" + kind); if (id) self._addLink(kind, id); });
    if (chips) chips.addEventListener("click", function (ev) { const id = self._findAttr(ev.target, chips, "data-remove-" + kind); if (id) self._removeLink(kind, id); });
    this._renderChips(kind);
  }
  _wireOverlay() {
    const root = this.shadowRoot, self = this;
    const ovl = root.getElementById("ovl");
    if (!ovl) return;
    ovl.addEventListener("click", function (ev) { if (ev.target === ovl) { self._editSlot = null; self._editPanel = false; self._render(); } });
    const bind = function (id, fn) { const el = root.getElementById(id); if (el) el.addEventListener("click", fn); };
    bind("btn-save", function () { self._saveBreaker(); });
    bind("btn-clear", function () { self._clearBreaker(); });
    bind("btn-cancel", function () { self._editSlot = null; self._render(); });
    bind("p-save", function () { self._savePanel(); });
    bind("p-cancel", function () { self._editPanel = false; self._render(); });
    const stepSlots = function (delta) {
      const inp = root.getElementById("p-slots"); if (!inp) return;
      let v = parseInt(inp.value, 10); if (isNaN(v)) v = 20;
      v += delta; if (v < 2) v = 2; if (v > 120) v = 120;
      inp.value = v;
    };
    bind("p-minus", function () { stepSlots(-2); });
    bind("p-plus", function () { stepSlots(2); });
    if (this._editSlot !== null) { this._wirePicker("area"); this._wirePicker("dev"); }
  }
  _wireMapping() {
    const root = this.shadowRoot, self = this;
    const bind = function (id, fn) { const el = root.getElementById(id); if (el) el.addEventListener("click", fn); };
    bind("m-exit", function () { self._exitMapping(); });
    bind("m-prev", function () { self._stepTarget(-1); });
    bind("m-next", function () { self._stepTarget(1); });
    bind("m-arm", function () { self._arm(); });
    bind("m-cancel2", function () { self._map.phase = "idle"; self._hass.callWS({ type: "wattson/discover/cancel" }).catch(function () {}); self._render(); });
    bind("m-capture", function () { self._capture(); });
    bind("m-recap", function () { self._arm().then(function () { self._capture(); }); });
    bind("m-skip", function () { self._advance(); });
    bind("m-accept", function () { self._acceptProposals(); });
    const list = root.querySelector(".proplist");
    if (list) list.addEventListener("change", function (ev) {
      const id = ev.target && ev.target.getAttribute ? ev.target.getAttribute("data-prop") : null;
      if (id) self._map.selected[id] = ev.target.checked;
    });
  }

  _render() {
    const root = this.shadowRoot;
    if (!this._data && this._loading) { root.innerHTML = "<style>" + this._css() + "</style><ha-card><div class='frame'><div class='loading'>LOADING PANEL...</div></div></ha-card>"; return; }
    if (!this._data) { root.innerHTML = "<style>" + this._css() + "</style><ha-card><div class='frame'><div class='loading'>WATTSON: " + esc(this._error || "no data") + "</div></div></ha-card>"; return; }
    const panel = this._data.panel || { name: "Panel", slots: 24, columns: 2 };
    if (this._selected === null || this._mapping) this._drawerOpen = false;
    const slots = panel.slots || 24;
    const rows = Math.ceil(slots / 2);

    let confirmed = 0, tentative = 0, energized = 0;
    const keys = Object.keys(this._data.breakers || {});
    for (let i = 0; i < keys.length; i++) {
      const b = this._data.breakers[keys[i]];
      const stt = this._status(b);
      if (stt === "confirmed") confirmed++; else if (stt === "guess") tentative++;
      if (this._breakerActive(b)) energized++;
    }

    let cells = "";
    for (let r = 0; r < rows; r++) {
      const left = r * 2 + 1, right = r * 2 + 2;
      if (left <= slots) cells += this._cellHtml(left); else cells += '<div class="block spacer"></div>';
      if (right <= slots) cells += this._cellHtml(right); else cells += '<div class="block spacer"></div>';
    }

    const errbar = this._error ? '<div class="errbar">' + esc(this._error) + "</div>" : "";
    const spec = (this._config.spec) ? esc(this._config.spec) : "PANEL DIRECTORY  /  " + slots + " SLOTS";

    root.innerHTML =
      "<style>" + this._css() + "</style>" +
      "<ha-card><div class='frame" + (this._bleed ? " bleed" : "") + "'>" +
      "<i class='cb tl'></i><i class='cb tr'></i><i class='cb bl'></i><i class='cb br'></i>" +
      "<div class='tblock'>" +
        "<div class='tleft'><div class='kicker'>WATTSON</div>" +
          "<div class='pname'>" + esc(panel.name) + "</div>" +
          "<div class='spec'>" + spec + "</div></div>" +
        "<span class='spacer2'></span>" +
        "<div class='hleg'>" +
          "<span class='k'><span class='sw-solid'></span> CONFIRMED</span>" +
          "<span class='k'><span class='sw-dash'></span> TENTATIVE</span>" +
          "<span class='k'><span class='sw-hot'></span> ENERGIZED</span>" +
        "</div>" +
        "<div class='inst'>" +
          "<div class='readouts'>" +
            "<div class='ro'><span class='l'>MAPPED</span><span class='v'>" + (confirmed + tentative) + " / " + slots + "</span></div>" +
            "<div class='ro'><span class='l'>TENTATIVE</span><span class='v'>" + pad2(tentative) + "</span></div>" +
          "</div>" +
          "<div class='matrixbox'><span class='matrix'>" + matrixSVG(pad2(energized), "#f5a200", "#d4d8e0") + "</span><span class='cap'>ENERGIZED</span></div>" +
        "</div>" +
        ((this._mapping || this._sidebar) ? "" : "<button class='btn sm' id='open-lib'>Library &#9654;</button>") +
        "<button class='btn sq' id='open-panel' title='Panel settings'>&#9881;</button>" +
      "</div>" +
      errbar +
      "<div class='cardbody'>" +
        ((this._sidebar && !this._mapping) ? this._libraryHtml() : "") +
        "<div class='main'>" +
          "<div class='panel'><div class='bus'></div><div class='gridwrap'><div class='banks" + (this._pulse ? "" : " nopulse") + "'>" + cells + "</div></div></div>" +
          this._inspectorHtml() +
        "</div>" +
      "</div>" +
      (this._mapping ? this._mappingBarHtml() : "") +
      "</div></ha-card>" +
      this._overlayHtml(panel);

    const self = this;
    const banks = root.querySelector(".banks");
    banks.addEventListener("click", function (ev) {
      let node = ev.target;
      while (node && node !== banks && !(node.classList && node.classList.contains("block"))) node = node.parentNode;
      if (node && node.classList && node.classList.contains("block") && node.dataset.slot) {
        const slot = parseInt(node.dataset.slot, 10);
        if (self._mapping) self._setTarget(slot);
        else if (self._pending) self._assign(slot, self._pending.kind, self._pending.id);
        else self._selectBreaker(slot);
      }
    });
    const gear = root.getElementById("open-panel");
    if (gear) gear.addEventListener("click", function () { self._editPanel = true; self._editSlot = null; self._render(); });

    const ie = root.getElementById("insp-edit");
    if (ie) ie.addEventListener("click", function () { self._editSlot = self._selected; self._editPanel = false; self._render(); });
    const im = root.getElementById("insp-map");
    if (im) im.addEventListener("click", function () { const s = self._selected; self._selected = null; self._mapping = true; self._map = { slot: s || self._firstUnmapped(), phase: "idle", proposals: [], selected: {} }; self._render(); });
    const ic = root.getElementById("insp-close");
    if (ic) ic.addEventListener("click", function () { self._selected = null; self._render(); });
    const inum = root.getElementById("insp-num");
    const ilab = root.getElementById("insp-label");
    const commitInline = function () { self._saveInline(); };
    if (inum) { inum.addEventListener("change", commitInline); inum.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); inum.blur(); } }); }
    if (ilab) { ilab.addEventListener("change", commitInline); ilab.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); ilab.blur(); } }); }
    const scrim = root.getElementById("insp-scrim");
    if (scrim) scrim.addEventListener("click", function () { self._selected = null; self._render(); });
    const drawer = root.querySelector(".drawer");
    if (drawer) drawer.addEventListener("click", function (ev) {
      let n = ev.target;
      while (n && n !== drawer && !(n.classList && n.classList.contains("unlink"))) n = n.parentNode;
      if (n && n.classList && n.classList.contains("unlink")) { ev.stopPropagation(); self._unlink(self._selected, n.getAttribute("data-unlink-kind"), n.getAttribute("data-unlink-id")); }
    });

    const olib = root.getElementById("open-lib");
    if (olib) olib.addEventListener("click", function () { self._sidebar = !self._sidebar; self._render(); });
    const lcol = root.getElementById("lib-collapse");
    if (lcol) lcol.addEventListener("click", function () { self._sidebar = false; self._render(); });

    const sb = root.querySelector(".sidebar");
    if (sb) {
      const search = root.getElementById("lib-search");
      if (search) search.addEventListener("input", function () { self._lib.query = search.value; self._renderLibraryLists(); });
      sb.addEventListener("click", function (ev) {
        const sec = self._findAttr(ev.target, sb, "data-sectoggle");
        if (sec) {
          self._lib.expanded[sec] = !self._lib.expanded[sec];
          const el = sb.querySelector(".libsec[data-sec='" + sec + "']");
          if (el) { el.classList.toggle("open", self._lib.expanded[sec]); const c = el.querySelector(".caret"); if (c) c.innerHTML = self._lib.expanded[sec] ? "&#9662;" : "&#9656;"; }
          return;
        }
        if (ev.target && ev.target.id === "lib-cancelpend") { self._pending = null; self._render(); return; }
        const scope = self._findAttr(ev.target, sb, "data-scope");
        if (scope) { self._lib.scope = scope; self._render(); return; }
        let node = ev.target;
        while (node && node !== sb && !(node.classList && node.classList.contains("libitem"))) node = node.parentNode;
        if (node && node.classList && node.classList.contains("libitem")) self._armItem(node.getAttribute("data-kind"), node.getAttribute("data-id"));
      });
      sb.addEventListener("dragstart", function (ev) {
        let node = ev.target;
        while (node && node !== sb && !(node.classList && node.classList.contains("libitem"))) node = node.parentNode;
        if (node && node.classList && node.classList.contains("libitem")) {
          self._drag = { kind: node.getAttribute("data-kind"), id: node.getAttribute("data-id") };
          if (ev.dataTransfer) { ev.dataTransfer.setData("text/plain", self._drag.kind + ":" + self._drag.id); ev.dataTransfer.effectAllowed = "copy"; }
        }
      });
      this._renderLibraryLists();
    }

    banks.addEventListener("dragover", function (ev) {
      if (self._mapping) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
      let node = ev.target;
      while (node && node !== banks && !(node.classList && node.classList.contains("block"))) node = node.parentNode;
      if (self._dragCell && self._dragCell !== node) self._dragCell.classList.remove("dragover");
      if (node && node.classList && node.classList.contains("block") && !node.classList.contains("spacer")) { node.classList.add("dragover"); self._dragCell = node; }
    });
    banks.addEventListener("drop", function (ev) {
      if (self._mapping) return;
      ev.preventDefault();
      let node = ev.target;
      while (node && node !== banks && !(node.classList && node.classList.contains("block"))) node = node.parentNode;
      if (self._dragCell) { self._dragCell.classList.remove("dragover"); self._dragCell = null; }
      if (node && node.dataset && node.dataset.slot && self._drag) { self._assign(parseInt(node.dataset.slot, 10), self._drag.kind, self._drag.id); self._drag = null; }
    });

    const panelEl = root.querySelector(".panel");
    if (panelEl) panelEl.addEventListener("click", function (ev) {
      let n = ev.target, onBlock = false;
      while (n && n !== panelEl) { if (n.classList && n.classList.contains("block")) { onBlock = true; break; } n = n.parentNode; }
      if (!onBlock && self._selected !== null && !self._pending && !self._mapping) { self._selected = null; self._render(); }
    });

    this._wireOverlay();
    if (this._mapping) this._wireMapping();
    this._applyLiveStates();
    this._openDrawer();
  }

  _css() {
    return (
      ":host{--pm-paper:#eceef2;--pm-card:#fbfcfe;--pm-ink:#1b2030;--pm-ink-soft:#5b6478;" +
        "--pm-line:#c4cad6;--pm-line-soft:#d7dce4;--pm-indigo:#4a5bd8;--pm-indigo-soft:#9aa4ee;--pm-amber:#f5a200;--pm-green:#2f9e54;" +
        "--pm-mono:ui-monospace,'SF Mono','JetBrains Mono','IBM Plex Mono',Menlo,Consolas,monospace}" +
      "ha-card{--ha-card-background:transparent;--card-background-color:transparent;--ha-card-box-shadow:none;background:transparent;border:none;box-shadow:none}" +
      ".frame{position:relative;border:1.5px solid var(--pm-ink);border-radius:7px;overflow:hidden;color:var(--pm-ink);container-type:inline-size;background-color:#eaeef9;background-image:" +
        "repeating-linear-gradient(0deg,rgba(74,91,216,.05) 0 1px,transparent 1px 13px)," +
        "repeating-linear-gradient(90deg,rgba(74,91,216,.05) 0 1px,transparent 1px 13px)," +
        "repeating-linear-gradient(0deg,rgba(74,91,216,.11) 0 1px,transparent 1px 65px)," +
        "repeating-linear-gradient(90deg,rgba(74,91,216,.11) 0 1px,transparent 1px 65px)}" +
      ".frame.bleed{background:none;border:none;border-radius:0}" +
      ".loading{padding:24px;font-family:var(--pm-mono);font-size:.74rem;letter-spacing:.16em;color:var(--pm-ink-soft)}" +
      ".cb{position:absolute;width:12px;height:12px;border:2px solid var(--pm-ink);z-index:2}" +
      ".cb.tl{top:6px;left:6px;border-right:none;border-bottom:none}.cb.tr{top:6px;right:6px;border-left:none;border-bottom:none}" +
      ".cb.bl{bottom:6px;left:6px;border-right:none;border-top:none}.cb.br{bottom:6px;right:6px;border-left:none;border-top:none}" +
      ".tblock{display:flex;align-items:center;gap:24px;padding:10px 18px;border-bottom:1.5px solid var(--pm-ink);flex-wrap:wrap}" +
      ".tleft{min-width:0}" +
      ".hleg{display:flex;align-items:center;gap:18px;font-family:var(--pm-mono);font-size:.72rem;letter-spacing:.08em;color:var(--pm-ink-soft);flex-wrap:wrap}" +
      ".hleg .k{display:inline-flex;align-items:center;gap:8px;white-space:nowrap}" +
      ".kicker{font-family:var(--pm-mono);font-size:.7rem;letter-spacing:.26em;color:var(--pm-indigo);font-weight:700}" +
      ".pname{font-size:1.5rem;font-weight:800;letter-spacing:-.01em;margin:2px 0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".spec{font-family:var(--pm-mono);font-size:.74rem;letter-spacing:.05em;color:var(--pm-ink-soft);white-space:nowrap}" +
      ".inst{display:flex;align-items:center;gap:20px;flex-shrink:0}" +
      ".readouts{text-align:right;font-family:var(--pm-mono)}.ro{margin-bottom:4px}.ro:last-child{margin-bottom:0}" +
      ".ro .l{font-size:.6rem;letter-spacing:.18em;color:var(--pm-ink-soft);display:block}.ro .v{font-size:1.05rem;font-weight:700;letter-spacing:.04em}" +
      ".matrixbox{display:flex;flex-direction:column;align-items:flex-end;gap:4px}.matrix svg{display:block}" +
      ".matrixbox .cap{font-family:var(--pm-mono);font-size:.58rem;letter-spacing:.2em;color:var(--pm-ink-soft)}" +
      ".errbar{margin:10px 18px 0;padding:7px 11px;border:1px solid var(--pm-amber);border-radius:4px;background:rgba(245,162,0,.1);font-family:var(--pm-mono);font-size:.66rem;color:var(--pm-ink)}" +
      ".panel{position:relative;padding:16px 18px}" +
      ".bus{position:absolute;top:15px;bottom:15px;left:50%;width:6px;transform:translateX(-50%);border-left:1px solid var(--pm-line);border-right:1px solid var(--pm-line)}" +
      ".gridwrap{container-type:inline-size}" +
      ".banks{display:grid;grid-template-columns:1fr 1fr;column-gap:34px;row-gap:6px}" +
      ".block{position:relative;display:flex;align-items:center;gap:10px;min-height:40px;padding:6px 10px;background:var(--pm-card);border:1px solid var(--pm-line);border-radius:3px;cursor:pointer}" +
      ".block.confirmed{border:1px solid var(--pm-ink)}" +
      ".block.guess{border:1px dashed var(--pm-ink-soft)}" +
      ".block.unknown{border:1px dashed var(--pm-line)}" +
      ".block.spacer{border:none;background:none;cursor:default}" +
      ".block.target{outline:2px solid var(--pm-indigo);outline-offset:1px}" +
      ".block.selected{outline:2px solid var(--pm-indigo);outline-offset:1px}" +
      ".block.hot{box-shadow:0 0 0 1px var(--pm-amber),0 0 16px rgba(245,162,0,.34)}" +
      "@keyframes pmpulse{0%{box-shadow:0 0 5px 0 rgba(245,162,0,.30)}50%{box-shadow:0 0 14px 2px rgba(245,162,0,.62)}100%{box-shadow:0 0 5px 0 rgba(245,162,0,.30)}}" +
      ".banks:not(.nopulse) .block.hot{animation:pmpulse 3s ease-in-out infinite}" +
      ".tab{font-family:var(--pm-mono);font-size:.74rem;letter-spacing:.03em;color:var(--pm-ink-soft);border:1px solid var(--pm-line);border-radius:2px;padding:2px 5px;background:var(--pm-paper);flex:0 0 auto}" +
      ".bd{flex:1;min-width:0}" +
      ".lbl{font-size:.92rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.005em}" +
      ".lbl .empty{font-family:var(--pm-mono);font-size:.6rem;letter-spacing:.22em;color:var(--pm-line);font-weight:700}" +
      ".mt{font-family:var(--pm-mono);font-size:.58rem;letter-spacing:.06em;color:var(--pm-ink-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}" +
      ".lk{font-family:var(--pm-mono);font-size:.52rem;letter-spacing:.1em;color:var(--pm-indigo);border:1px solid var(--pm-indigo-soft);border-radius:999px;padding:2px 7px;background:rgba(74,91,216,.07);white-space:nowrap;flex:0 0 auto}" +
      ".sw{position:relative;width:26px;height:14px;border:1.5px solid var(--pm-ink);border-radius:4px;flex:0 0 auto;background:transparent}" +
      ".sw::after{content:\"\";position:absolute;top:50%;transform:translateY(-50%);width:42%;height:58%;border-radius:2px;background:var(--pm-ink);transition:.25s}" +
      ".sw.r::after{right:2px;left:auto}.sw.l::after{left:2px;right:auto}" +
      ".block.hot .sw{border-color:var(--pm-amber)}.block.hot .sw::after{background:var(--pm-amber);box-shadow:0 0 7px rgba(245,162,0,.85)}" +
      "@container (min-width:520px){.block{min-height:44px;padding:7px 11px}.lbl{font-size:1.02rem}.mt{font-size:.62rem}.sw{width:32px;height:16px}}" +
      "@container (min-width:680px){.banks{row-gap:7px}.block{min-height:48px}.lbl{font-size:1.06rem}.sw{width:36px;height:18px}}" +
      ".sw-solid{width:18px;height:12px;border:1px solid var(--pm-ink);border-radius:2px}" +
      ".sw-dash{width:18px;height:12px;border:1px dashed var(--pm-ink-soft);border-radius:2px}" +
      ".sw-hot{width:18px;height:12px;border:1px solid var(--pm-amber);border-radius:2px;box-shadow:0 0 8px rgba(245,162,0,.55)}" +
      ".spacer2{flex:1}" +
      ".btn{font-family:var(--pm-mono);font-size:.8rem;letter-spacing:.05em;padding:7px 13px;border-radius:5px;border:1px solid var(--pm-line);background:var(--pm-card);color:var(--pm-ink);cursor:pointer}" +
      ".btn:hover{border-color:var(--pm-ink-soft)}" +
      ".btn.sq{padding:7px 10px;font-size:.98rem;line-height:1}" +
      ".btn.sm{font-size:.76rem;padding:6px 11px}" +
      ".btn.sm.ON{background:var(--pm-ink);border-color:var(--pm-ink);color:#fff}" +
      ".stepper{display:flex;align-items:center;gap:7px;margin-top:4px}" +
      ".stepper input{width:70px;text-align:center}" +
      ".dlgnote{font-family:var(--pm-mono);font-size:.72rem;line-height:1.5;color:var(--pm-ink-soft);margin:4px 0 2px}" +
      ".btn.primary{background:var(--pm-indigo);border-color:var(--pm-indigo);color:#fff}" +
      ".btn.ghost{background:none;border-color:transparent;color:var(--pm-ink-soft)}" +
      ".btn.map.ON{background:var(--pm-amber);border-color:var(--pm-amber);color:#3a2a00}" +
      /* mapping bar */
      ".mapbar{border-top:1.5px solid var(--pm-ink);background:var(--pm-paper);padding:13px 18px 15px}" +
      ".maphead{display:flex;align-items:center;margin-bottom:10px}" +
      ".mk{font-family:var(--pm-mono);font-size:.62rem;letter-spacing:.22em;color:var(--pm-amber);font-weight:700}" +
      ".mrow{display:flex;align-items:center;gap:10px;margin-bottom:8px}" +
      ".mtarget{display:flex;align-items:center;gap:8px;min-width:0}" +
      ".mtab{font-family:var(--pm-mono);font-size:.7rem;border:1px solid var(--pm-ink);border-radius:3px;padding:3px 6px;background:var(--pm-card);flex:0 0 auto}" +
      ".mtab.hot{border-color:var(--pm-amber);color:var(--pm-amber)}" +
      ".mlabel{font-size:.92rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".mhint{font-family:var(--pm-mono);font-size:.62rem;line-height:1.5;color:var(--pm-ink-soft);letter-spacing:.02em}" +
      ".mhint b{color:var(--pm-ink)}" +
      ".dotpulse{width:10px;height:10px;border-radius:50%;background:var(--pm-amber);flex:0 0 auto;animation:pmpulse2 1.2s ease-in-out infinite}" +
      "@keyframes pmpulse2{0%{box-shadow:0 0 0 0 rgba(245,162,0,.6);opacity:1}70%{box-shadow:0 0 0 7px rgba(245,162,0,0);opacity:.7}100%{opacity:1}}" +
      ".proplist{display:flex;flex-direction:column;gap:5px;margin:4px 0 10px;max-height:220px;overflow:auto}" +
      ".prop{display:flex;align-items:center;gap:10px;padding:9px 10px;border:1px solid var(--pm-line);border-radius:4px;background:var(--pm-card);cursor:pointer}" +
      ".prop input{flex:0 0 auto;width:17px;height:17px}" +
      ".prop .pn{font-size:.98rem;font-weight:600;display:flex;align-items:center;gap:6px;min-width:0}" +
      ".prop .pid{font-family:var(--pm-mono);font-size:.72rem;color:var(--pm-ink-soft);margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:48%}" +
      ".ptag{font-family:var(--pm-mono);font-size:.58rem;letter-spacing:.1em;color:var(--pm-indigo);border:1px solid var(--pm-indigo-soft);border-radius:3px;padding:1px 4px;flex:0 0 auto}" +
      ".mempty{font-family:var(--pm-mono);font-size:.82rem;line-height:1.5;color:var(--pm-ink-soft);padding:6px 2px 4px}" +
      ".mempty b{color:var(--pm-ink)}" +
      ".cardbody{display:flex;align-items:stretch}" +
      ".main{position:relative;flex:1 1 auto;min-width:0}" +
      ".sidebar{flex:0 0 262px;width:262px;border-right:1.5px solid var(--pm-ink);display:flex;flex-direction:column;min-width:0;background:var(--pm-card)}" +
      ".libtop{display:flex;align-items:center;gap:7px;padding:11px 12px 9px;border-bottom:1px solid var(--pm-line-soft)}" +
      ".libttl{font-family:var(--pm-mono);font-size:.78rem;letter-spacing:.2em;color:var(--pm-ink);font-weight:700}" +
      ".libtop .ibtn{font-size:1.05rem}" +
      ".libsearch{padding:9px 9px 8px;border-bottom:1px solid var(--pm-line-soft)}" +
      ".libsearch input{width:100%;box-sizing:border-box;padding:9px 11px;font-size:1rem;border:1px solid var(--pm-line);border-radius:6px;background:#fff;color:var(--pm-ink);font-family:inherit}" +
      ".libsec{border-bottom:1px solid var(--pm-line-soft)}" +
      ".libhead{width:100%;display:flex;align-items:center;gap:8px;background:none;border:none;cursor:pointer;padding:11px 12px;font-family:var(--pm-mono);font-size:.84rem;letter-spacing:.14em;color:var(--pm-ink);text-transform:uppercase}" +
      ".libhead .caret{color:var(--pm-ink-soft);font-size:.84rem;width:.8em}" +
      ".seccount{margin-left:auto;font-size:.76rem;color:var(--pm-ink-soft);letter-spacing:.04em}" +
      ".liblist{display:none;max-height:280px;overflow:auto;padding:2px 8px 8px}" +
      ".libsec.open .liblist{display:block}" +
      ".libitem{display:flex;flex-direction:column;gap:2px;padding:8px 9px;border:1px solid transparent;border-radius:5px;cursor:grab}" +
      ".libitem:hover{background:var(--pm-paper)}" +
      ".libitem.armed{border-color:var(--pm-indigo);background:rgba(74,91,216,.08)}" +
      ".liname{font-size:1.05rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".lisub{font-family:var(--pm-mono);font-size:.78rem;color:var(--pm-ink-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".libnote{font-family:var(--pm-mono);font-size:.78rem;color:var(--pm-ink-soft);padding:6px 8px}" +
      ".libhint{display:flex;align-items:center;gap:8px;padding:11px 12px;border-top:1px solid var(--pm-line-soft);font-family:var(--pm-mono);font-size:.8rem;line-height:1.45;color:var(--pm-ink);background:rgba(74,91,216,.06)}" +
      ".libhint.dim{color:var(--pm-ink-soft);background:none}.libhint b{color:var(--pm-indigo)}" +
      ".block.dragover{outline:2px dashed var(--pm-indigo);outline-offset:1px;background:rgba(74,91,216,.07)}" +
      ".btn.lib.ON{background:var(--pm-ink);border-color:var(--pm-ink);color:#fff}" +
      ".libscope{display:flex;gap:5px;padding:8px 9px;border-bottom:1px solid var(--pm-line-soft)}" +
      ".scbtn{flex:1;padding:7px 8px;font-family:var(--pm-mono);font-size:.78rem;letter-spacing:.08em;text-transform:uppercase;border:1px solid var(--pm-line);border-radius:5px;background:#fff;color:var(--pm-ink-soft);cursor:pointer}" +
      ".scbtn.on{background:var(--pm-ink);border-color:var(--pm-ink);color:#fff}" +
      ".scrim{position:absolute;inset:0;background:rgba(20,24,36,.18);z-index:15;opacity:0;transition:opacity .2s ease}" +
      ".scrim.open{opacity:1}" +
      ".drawer{position:absolute;top:0;right:0;height:100%;width:368px;max-width:88%;z-index:16;background:var(--pm-card);border-left:1.5px solid var(--pm-ink);box-shadow:-14px 0 36px rgba(20,24,36,.22);padding:15px 16px;display:flex;flex-direction:column;box-sizing:border-box;transform:translateX(100%);transition:transform .22s ease}" +
      ".drawer.open{transform:none}" +
      ".insptop{display:flex;align-items:center;gap:8px;margin-bottom:5px}" +
      ".numedit{width:48px;text-align:center;font-family:var(--pm-mono);font-size:.92rem;padding:5px 4px;border:1px solid var(--pm-line);border-radius:4px;background:var(--pm-paper);color:var(--pm-ink);flex:0 0 auto;box-sizing:border-box}" +
      ".numedit:focus{border-color:var(--pm-indigo);outline:none;background:#fff}" +
      ".titledit{flex:1;min-width:0;font-size:1.2rem;font-weight:700;border:1px solid transparent;border-radius:5px;padding:5px 7px;background:transparent;color:var(--pm-ink);font-family:inherit;box-sizing:border-box}" +
      ".titledit:hover{border-color:var(--pm-line-soft)}.titledit:focus{border-color:var(--pm-indigo);background:#fff;outline:none}" +
      ".insptitle{font-size:1.25rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}" +
      ".ibtn{border:none;background:none;color:var(--pm-ink-soft);cursor:pointer;font-size:1.2rem;line-height:1;padding:2px 5px;flex:0 0 auto}" +
      ".inspmeta{font-family:var(--pm-mono);font-size:.8rem;letter-spacing:.08em;color:var(--pm-ink-soft);margin-bottom:10px}" +
      ".prows{flex:1;display:flex;flex-direction:column;gap:5px;overflow:auto;padding-right:2px}" +
      ".prow{display:flex;align-items:center;gap:8px;padding:5px 7px;border:1px solid var(--pm-line);border-radius:5px}" +
      ".agroup{border:1px solid var(--pm-line);border-radius:6px;padding:6px 7px;background:var(--pm-paper);display:flex;flex-direction:column;gap:4px}" +
      ".ahead{display:flex;align-items:center;gap:6px}" +
      ".atag{font-family:var(--pm-mono);font-size:.66rem;letter-spacing:.1em;color:var(--pm-indigo);border:1px solid var(--pm-indigo-soft);border-radius:3px;padding:2px 5px;flex:0 0 auto}" +
      ".aname{font-weight:700;font-size:1.08rem;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".acount{font-family:var(--pm-mono);font-size:.74rem;color:var(--pm-ink-soft);flex:0 0 auto}" +
      ".agroup .prow{border:none;padding:2px 3px}" +
      ".atree{position:relative}" +
      ".atreesvg{position:absolute;left:0;top:0}" +
      ".amembers{display:flex;flex-direction:column}" +
      ".mrow{display:flex;align-items:center;gap:8px;height:30px;padding-left:42px;box-sizing:border-box}" +
      ".unlink{border:none;background:none;color:var(--pm-ink-soft);cursor:pointer;font-size:.95rem;line-height:1;padding:2px 5px;flex:0 0 auto}" +
      ".unlink:hover{color:#c0392b}" +
      ".wire{position:relative;width:30px;height:16px;flex:0 0 auto;overflow:hidden}" +
      ".wdash{position:absolute;top:50%;left:0;right:0;height:0;border-top:1.4px dashed var(--pm-indigo-soft);transform:translateY(-50%)}" +
      ".wire.active .wdash{border-color:var(--pm-indigo)}" +
      ".wpulse{position:absolute;top:50%;left:0;width:6px;height:6px;border-radius:50%;background:#ffb01f;box-shadow:0 0 6px rgba(245,162,0,.9);margin-top:-3px;opacity:0}" +
      ".wire.active .wpulse{animation:pmflow 2.6s linear infinite}" +
      ".wire.manual .wdash{border-color:var(--pm-indigo-soft)}" +
      ".wire.manual .wpulse{background:var(--pm-indigo);box-shadow:0 0 6px rgba(74,91,216,.85);animation:pmflow 2.6s linear infinite}" +
      "@keyframes pmflow{0%{left:-6px;opacity:0}12%{opacity:1}82%{opacity:1}100%{left:100%;opacity:0}}" +
      ".pdot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;box-sizing:border-box}" +
      ".pdot.on{background:var(--pm-amber);box-shadow:0 0 6px rgba(245,162,0,.7)}" +
      ".pdot.off{background:none;border:1.4px solid var(--pm-indigo-soft)}" +
      ".pdot.man{background:var(--pm-indigo);box-shadow:0 0 6px rgba(74,91,216,.6)}" +
      ".pname2{flex:1;min-width:0;font-size:1.02rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".tagd{font-family:var(--pm-mono);font-size:.62rem;color:var(--pm-indigo);border:1px solid var(--pm-indigo-soft);border-radius:3px;padding:0 3px;margin-left:3px}" +
      ".pstate{font-family:var(--pm-mono);font-size:.78rem;letter-spacing:.1em;color:var(--pm-ink-soft);flex:0 0 auto}" +
      ".pstate.on{color:var(--pm-amber)}" +
      ".inspacts{display:flex;gap:7px;margin:2px 0 11px}" +
      ".lblgroup{font-family:var(--pm-mono);font-size:.68rem;letter-spacing:.16em;text-transform:uppercase;color:var(--pm-ink-soft);margin:8px 2px 3px;padding-top:6px;border-top:1px solid var(--pm-line-soft)}" +
      ".prows > .lblgroup:first-child{border-top:none;padding-top:0;margin-top:2px}" +
      "@container (max-width:560px){.cardbody{flex-direction:column}.sidebar{flex:0 0 auto;width:auto;border-right:none;border-bottom:1.5px solid var(--pm-ink)}.liblist{max-height:160px}}" +
      "@media (prefers-reduced-motion: reduce){.wire .wpulse{display:none}.banks .block.hot{animation:none}}" +
      /* overlay */
      ".ovl{position:fixed;inset:0;background:rgba(231,235,246,.55);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;z-index:20;padding:16px}" +
      ".dialog{width:100%;max-width:440px;max-height:92vh;overflow:auto;background:var(--pm-card);color:var(--pm-ink);border:1.5px solid var(--pm-ink);border-radius:8px;padding:16px;box-shadow:0 20px 54px rgba(20,24,36,.30)}" +
      ".dlgHead{font-family:var(--pm-mono);font-size:.74rem;letter-spacing:.18em;font-weight:700;margin-bottom:13px;color:var(--pm-ink)}" +
      ".dialog label{display:block;font-family:var(--pm-mono);font-size:.58rem;letter-spacing:.12em;color:var(--pm-ink-soft);margin-bottom:11px}" +
      ".dialog input,.dialog select,.dialog textarea{width:100%;box-sizing:border-box;margin-top:4px;padding:8px 10px;font-size:.92rem;border-radius:5px;border:1px solid var(--pm-line);background:#fff;color:var(--pm-ink);font-family:inherit}" +
      ".row2{display:flex;gap:10px}.row2 label{flex:1}.row2.nl label:first-child{flex:0 0 84px}" +
      ".picker{margin-bottom:11px}.pickhead{font-family:var(--pm-mono);font-size:.58rem;letter-spacing:.12em;color:var(--pm-ink-soft);margin-bottom:3px}" +
      ".combo{position:relative}" +
      ".results{position:absolute;left:0;right:0;top:100%;z-index:3;max-height:210px;overflow:auto;margin-top:2px;background:var(--pm-card);border:1px solid var(--pm-line);border-radius:6px;box-shadow:0 8px 24px rgba(20,24,36,.22)}" +
      ".res{display:flex;flex-direction:column;padding:8px 11px;cursor:pointer;border-bottom:1px solid var(--pm-line-soft)}.res:last-child{border-bottom:none}.res:hover{background:var(--pm-paper)}" +
      ".res.empty{color:var(--pm-ink-soft);cursor:default}.rname{font-size:.95rem}.rid{font-family:var(--pm-mono);font-size:.72rem;color:var(--pm-ink-soft)}" +
      ".res.mk{background:rgba(74,91,216,.06)}.res.mk .rname{color:var(--pm-indigo);font-weight:600}" +
      ".chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}.chips .empty{font-family:var(--pm-mono);font-size:.6rem;color:var(--pm-ink-soft)}" +
      ".chip{display:inline-flex;align-items:center;gap:5px;background:rgba(74,91,216,.08);border:1px solid var(--pm-indigo-soft);border-radius:999px;padding:4px 5px 4px 11px;font-size:.92rem;max-width:100%}" +
      ".chiptext{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:230px}" +
      ".chipx{border:none;background:var(--pm-indigo-soft);color:#fff;border-radius:50%;width:17px;height:17px;line-height:15px;cursor:pointer;font-size:.85rem;padding:0}" +
      ".actions{display:flex;align-items:center;gap:8px;margin-top:2px}"
    );
  }
}

class WattsonCardEditor extends HTMLElement {
  setConfig(config) { this._config = config || {}; this._render(); }
  set hass(hass) { this._hass = hass; }
  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const c = this._config || {};
    const pulseOn = c.pulse !== false;
    const bleedOn = c.bleed === true;
    this.shadowRoot.innerHTML =
      "<style>" +
      ".wed{display:flex;flex-direction:column;gap:14px;padding:4px 2px;color:var(--primary-text-color)}" +
      ".row{display:flex;align-items:flex-start;gap:10px;cursor:pointer}" +
      ".row input{margin-top:3px;flex:0 0 auto}" +
      ".t{font-size:14px;font-weight:500;display:block}" +
      ".d{font-size:12px;color:var(--secondary-text-color);margin-top:2px;display:block}" +
      ".hint{font-size:12px;color:var(--secondary-text-color);line-height:1.5;border-top:1px solid var(--divider-color,#e0e0e0);padding-top:12px}" +
      "</style>" +
      "<div class='wed'>" +
        "<label class='row'><input type='checkbox' id='w-pulse'" + (pulseOn ? " checked" : "") + ">" +
          "<span><span class='t'>Pulse animation</span><span class='d'>Animate current flowing to live circuits. Turn off for a steady glow on always-on displays.</span></span></label>" +
        "<label class='row'><input type='checkbox' id='w-bleed'" + (bleedOn ? " checked" : "") + ">" +
          "<span><span class='t'>Full-bleed</span><span class='d'>Drop the card border and background so it blends into a full-screen Panel view. Leave off for a normal framed card.</span></span></label>" +
        "<div class='hint'>Panel name, slot count, and breaker labels are edited on the card itself (the gear icon). Use the <b>Layout</b> tab to set width and the <b>Visibility</b> tab for display conditions.</div>" +
      "</div>";
    const self = this;
    const p = this.shadowRoot.getElementById("w-pulse");
    const b = this.shadowRoot.getElementById("w-bleed");
    if (p) p.addEventListener("change", function (e) { self._set("pulse", e.target.checked); });
    if (b) b.addEventListener("change", function (e) { self._set("bleed", e.target.checked); });
  }
  _set(key, val) {
    const next = Object.assign({}, this._config);
    if (!next.type) next.type = "custom:wattson-card";
    next[key] = val;
    this._config = next;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: next }, bubbles: true, composed: true }));
  }
}

if (!customElements.get("wattson-card-editor")) {
  customElements.define("wattson-card-editor", WattsonCardEditor);
}
if (!customElements.get("wattson-card")) {
  customElements.define("wattson-card", WattsonCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: "wattson-card", name: "Wattson", description: "Map and progressively label your breaker panel.", preview: false, documentationURL: "https://github.com/jasonschulke/wattson" });
  /* eslint-disable no-console */
  console.info("%c WATTSON-CARD %c " + CARD_VERSION + " ", "background:#1b2030;color:#fff;border-radius:3px 0 0 3px;padding:2px 4px", "background:#4a5bd8;color:#fff;border-radius:0 3px 3px 0;padding:2px 4px");
}
