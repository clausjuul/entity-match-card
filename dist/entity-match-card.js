/*
 * Entity Match Card
 *
 * Finder entities ud fra filtre (domain, entity_id, navn, område, etage,
 * enhed, label) og renderer dem med et valgfrit card – enten ét card pr.
 * entity eller ét samlet card med hele listen.
 */

const CARD_VERSION = "0.3.0";
const CARD_TYPE = "entity-match-card";
const EDITOR_TYPE = "entity-match-card-editor";

/** Betingelser hvor værdien er en liste af mønstre. */
const RULE_KEYS = [
  "domain",
  "entity_id",
  "name",
  "area",
  "floor",
  "device",
  "label",
  "state",
  "supports",
];
/** Alle felter en regel kan have (også attribute/value). */
const ALL_RULE_KEYS = [...RULE_KEYS, "attribute", "value"];

/** Farvetilstande fra light.supported_color_modes. */
const COLOR_MODES = ["hs", "xy", "rgb", "rgbw", "rgbww"];

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

const toList = (value) =>
  value === undefined || value === null || value === "" ? [] : Array.isArray(value) ? value : [value];

const escapeRegex = (s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

const matcherCache = new Map();

/**
 * Laver en matcher-funktion ud fra et mønster:
 *   "/regex/flags"  -> regulært udtryk
 *   "sensor.*_temp" -> wildcard (* og ?)
 *   "light.kitchen" -> eksakt (case-insensitive)
 */
function compilePattern(pattern) {
  const key = String(pattern);
  if (matcherCache.has(key)) return matcherCache.get(key);
  let fn;
  const lastSlash = key.lastIndexOf("/");
  if (key.length > 2 && key.startsWith("/") && lastSlash > 0) {
    try {
      const re = new RegExp(key.slice(1, lastSlash), key.slice(lastSlash + 1));
      fn = (v) => v !== undefined && v !== null && re.test(String(v));
    } catch (err) {
      console.warn(`${CARD_TYPE}: ugyldigt regex ${key}`, err);
      fn = () => false;
    }
  } else if (/[*?]/.test(key)) {
    const re = new RegExp(
      "^" + escapeRegex(key).replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
      "i"
    );
    fn = (v) => v !== undefined && v !== null && re.test(String(v));
  } else {
    const lower = key.toLowerCase();
    fn = (v) => v !== undefined && v !== null && String(v).toLowerCase() === lower;
  }
  matcherCache.set(key, fn);
  return fn;
}

/** True hvis mindst ét mønster matcher mindst én af kandidatværdierne. */
function anyMatch(patterns, candidates) {
  return patterns.some((p) => {
    const m = compilePattern(p);
    return candidates.some((c) => m(c));
  });
}

/** Samler alle de oplysninger om en entity som filtrene kan matche på. */
function entityContext(hass, entityId, labelNames) {
  const stateObj = hass.states[entityId];
  const reg = (hass.entities && hass.entities[entityId]) || {};
  const device = reg.device_id && hass.devices ? hass.devices[reg.device_id] : undefined;
  const areaId = reg.area_id || (device && device.area_id) || undefined;
  const area = areaId && hass.areas ? hass.areas[areaId] : undefined;
  const floorId = area && area.floor_id ? area.floor_id : undefined;
  const floor = floorId && hass.floors ? hass.floors[floorId] : undefined;
  const labels = toList(reg.labels);
  const attributes = (stateObj && stateObj.attributes) || {};
  return {
    entity_id: entityId,
    domain: entityId.split(".")[0],
    name: (stateObj && stateObj.attributes && stateObj.attributes.friendly_name) || reg.name || entityId,
    hidden: Boolean(reg.hidden || reg.hidden_by),
    entity_category: reg.entity_category,
    area: areaId ? [areaId, area && area.name] : [],
    area_name: (area && area.name) || "",
    floor: floorId ? [floorId, floor && floor.name] : [],
    device: device ? [device.id, device.name_by_user, device.name] : [],
    label: labels.flatMap((id) => [id, labelNames && labelNames[id]]),
    state: stateObj ? stateObj.state : undefined,
    supports: computeSupports(attributes),
    attributes,
  };
}

/** Hvad en entity kan: "color", "color_temp", "brightness". */
function computeSupports(attributes) {
  const modes = toList(attributes.supported_color_modes);
  const out = [];
  if (modes.some((m) => COLOR_MODES.includes(m))) out.push("color");
  if (modes.includes("color_temp")) out.push("color_temp");
  if (modes.some((m) => m !== "onoff") || attributes.brightness !== undefined) {
    out.push("brightness");
  }
  return out;
}

/** Kandidatværdier for en attribut – lister og objekter foldes ud. */
function attributeCandidates(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(attributeCandidates);
  if (typeof value === "object") return [JSON.stringify(value)];
  return [value];
}

/** En regel matcher hvis ALLE angivne betingelser matcher (AND). */
function ruleMatches(rule, ctx) {
  if (!rule || typeof rule !== "object") return false;
  let hasCondition = false;
  for (const key of RULE_KEYS) {
    const patterns = toList(rule[key]);
    if (!patterns.length) continue;
    hasCondition = true;
    const candidates = Array.isArray(ctx[key]) ? ctx[key] : [ctx[key]];
    if (!anyMatch(patterns, candidates.filter((c) => c !== undefined && c !== null))) {
      return false;
    }
  }
  const attribute = typeof rule.attribute === "string" ? rule.attribute.trim() : "";
  if (attribute) {
    hasCondition = true;
    const raw = ctx.attributes ? ctx.attributes[attribute] : undefined;
    const values = toList(rule.value);
    if (values.length) {
      if (!anyMatch(values, attributeCandidates(raw))) return false;
    } else if (raw === undefined || raw === null) {
      return false; // uden værdi: attributten skal blot findes
    }
  }
  return hasCondition;
}

/**
 * Returnerer kontekst for de entities der matcher config.filter.
 * include-regler er OR'et sammen, exclude-regler fjerner.
 */
function findEntityContexts(hass, config, labelNames) {
  const filter = config.filter || {};
  const include = toList(filter.include);
  const exclude = toList(filter.exclude);
  if (!include.length || !hass || !hass.states) return [];

  const matches = [];
  for (const entityId of Object.keys(hass.states)) {
    const ctx = entityContext(hass, entityId, labelNames);
    if (ctx.hidden && !config.show_hidden) continue;
    if (!include.some((r) => ruleMatches(r, ctx))) continue;
    if (exclude.some((r) => ruleMatches(r, ctx))) continue;
    matches.push(ctx);
  }

  const sort = config.sort || "name";
  if (sort !== "none") {
    const keyFn =
      sort === "entity_id"
        ? (c) => c.entity_id
        : sort === "area"
        ? (c) => `${c.area_name}\u0000${c.name}`
        : (c) => c.name;
    matches.sort((a, b) =>
      keyFn(a).localeCompare(keyFn(b), undefined, { numeric: true, sensitivity: "base" })
    );
  }
  if (config.sort_reverse) matches.reverse();

  const limit = Number(config.limit);
  return limit > 0 ? matches.slice(0, limit) : matches;
}

/** Som findEntityContexts, men returnerer kun entity_ids. */
function findEntities(hass, config, labelNames) {
  return findEntityContexts(hass, config, labelNames).map((c) => c.entity_id);
}

/** Den første variant hvis betingelse matcher, ellers undefined. */
function pickVariant(config, ctx) {
  return toList(config.variants).find(
    (v) => v && v.card && v.card.type && ruleMatches(v.when, ctx)
  );
}

/* ------------------------------------------------------------------ */
/* Card config bygning                                                 */
/* ------------------------------------------------------------------ */

const PLACEHOLDER = "this.entity_id";

/** Erstatter "this.entity_id" i alle strenge i et card-template. */
function fillTemplate(value, entityId) {
  if (typeof value === "string") return value.split(PLACEHOLDER).join(entityId);
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, entityId));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = fillTemplate(v, entityId);
    return out;
  }
  return value;
}

/** Et card til én entity ud fra en skabelon. */
function cardForEntity(template, id) {
  const card = fillTemplate(template, id);
  // Hvert card får sin egen entity – også selvom skabelonen har en fra
  // card-vælgerens standardkonfiguration.
  if (!JSON.stringify(template).includes(PLACEHOLDER)) card.entity = id;
  return card;
}

function buildChildConfig(config, contexts) {
  const template = config.card || { type: config.mode === "list" ? "entities" : "tile" };

  if (config.mode === "list") {
    const param = config.card_param || "entities";
    return { ...template, [param]: contexts.map((c) => c.entity_id) };
  }

  // mode: each – ét card pr. entity (evt. fra en variant), samlet i et layout-card.
  const cards = contexts.map((ctx) => {
    const variant = pickVariant(config, ctx);
    return cardForEntity(variant ? variant.card : template, ctx.entity_id);
  });
  const layout = config.layout || "grid";
  const layoutConfig = { type: layout, cards };
  if (layout === "grid") {
    layoutConfig.square = Boolean(config.square);
    if (config.columns) layoutConfig.columns = Number(config.columns);
  }
  return layoutConfig;
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

let helpersPromise;
const getHelpers = () => {
  if (!helpersPromise) helpersPromise = window.loadCardHelpers();
  return helpersPromise;
};

let labelPromise;
let labelNames = {};
function loadLabels(hass) {
  if (!labelPromise && hass && hass.callWS) {
    labelPromise = hass
      .callWS({ type: "config/label_registry/list" })
      .then((labels) => {
        labelNames = Object.fromEntries(labels.map((l) => [l.label_id, l.name]));
        return labelNames;
      })
      .catch(() => labelNames);
  }
  return labelPromise || Promise.resolve(labelNames);
}

class EntityMatchCard extends HTMLElement {
  constructor() {
    super();
    this._root = this.attachShadow({ mode: "open" });
    this._childKey = undefined;
    this._child = undefined;
    this._entities = [];
  }

  static getConfigElement() {
    return document.createElement(EDITOR_TYPE);
  }

  static getStubConfig(hass) {
    return {
      filter: { include: [{ domain: "light" }], exclude: [] },
      mode: "each",
      card: { type: "tile" },
      layout: "grid",
      columns: 2,
    };
  }

  setConfig(config) {
    if (!config || typeof config !== "object") throw new Error("Ugyldig konfiguration");
    if (config.filter !== undefined && typeof config.filter !== "object") {
      throw new Error("'filter' skal være et objekt med 'include' og evt. 'exclude'");
    }
    if (config.card !== undefined && (typeof config.card !== "object" || !config.card.type)) {
      throw new Error("'card' skal være et card-objekt med en 'type'");
    }
    if (config.mode && !["each", "list"].includes(config.mode)) {
      throw new Error("'mode' skal være 'each' eller 'list'");
    }
    if (config.variants !== undefined && !Array.isArray(config.variants)) {
      throw new Error("'variants' skal være en liste af { when, card }");
    }
    for (const v of toList(config.variants)) {
      if (!v || typeof v !== "object" || (v.card !== undefined && typeof v.card !== "object")) {
        throw new Error("Hver variant skal have 'when' (betingelser) og 'card'");
      }
    }
    this._config = { mode: "each", ...config };
    this._childKey = undefined;
    this._update();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) loadLabels(hass).then(() => this._update());
    this._update();
  }

  get hass() {
    return this._hass;
  }

  getCardSize() {
    if (this._child && typeof this._child.getCardSize === "function") {
      return this._child.getCardSize();
    }
    return Math.max(1, Math.ceil(this._entities.length / 2));
  }

  getGridOptions() {
    return { columns: 12, min_columns: 3 };
  }

  _update() {
    if (!this._config || !this._hass) return;
    const contexts = findEntityContexts(this._hass, this._config, labelNames);
    this._entities = contexts.map((c) => c.entity_id);

    if (!contexts.length) {
      this._renderEmpty();
      return;
    }

    const childConfig = buildChildConfig(this._config, contexts);
    const key = JSON.stringify(childConfig);
    if (key !== this._childKey) {
      this._childKey = key;
      this._createChild(childConfig, key);
    } else if (this._child) {
      this._child.hass = this._hass;
    }
  }

  _renderEmpty() {
    const key = "__empty__";
    if (this._childKey === key) return;
    this._childKey = key;
    this._child = undefined;
    this._root.innerHTML = "";
    if (this._config.show_empty === false && !this._isEditMode()) {
      this.style.display = "none";
      return;
    }
    this.style.display = "";
    const card = document.createElement("ha-card");
    const div = document.createElement("div");
    div.style.padding = "16px";
    div.style.color = "var(--secondary-text-color)";
    div.textContent = this._config.empty_message || "Ingen entities matcher filteret.";
    card.appendChild(div);
    this._root.appendChild(card);
  }

  _isEditMode() {
    return Boolean(this.preview || this.editMode);
  }

  async _createChild(childConfig, key) {
    this.style.display = "";
    const helpers = await getHelpers();
    if (key !== this._childKey) return; // config ændret mens vi ventede
    const el = helpers.createCardElement(childConfig);
    el.hass = this._hass;
    el.addEventListener(
      "ll-rebuild",
      (ev) => {
        ev.stopPropagation();
        this._childKey = undefined;
        this._update();
      },
      { once: true }
    );
    this._child = el;
    this._root.innerHTML = "";
    this._root.appendChild(el);
  }
}

/* ------------------------------------------------------------------ */
/* Visuel editor                                                       */
/* ------------------------------------------------------------------ */

const LABELS = {
  domain: "Domain",
  entity_id: "Entity ID (mønster, fx sensor.*_temp eller /regex/)",
  name: "Navn (mønster)",
  area: "Område",
  floor: "Etage",
  device: "Enhed",
  label: "Label",
  supports: "Understøtter",
  state: "Tilstand (mønster, fx on)",
  attribute: "Attribut (fx supported_color_modes)",
  value: "Attributværdi (mønster – tom = attributten findes)",
  mode: "Visning",
  card_type: "Card-type",
  card: "Card-konfiguration (YAML)",
  card_param: "Felt der modtager entity-listen",
  layout: "Layout",
  columns: "Kolonner",
  square: "Kvadratiske celler",
  sort: "Sortering",
  sort_reverse: "Omvendt rækkefølge",
  limit: "Maks. antal (0 = alle)",
  show_hidden: "Medtag skjulte entities",
  show_empty: "Vis kortet når intet matcher",
  empty_message: "Tekst når intet matcher",
};

const HELPERS = {
  card:
    'Skabelon for kortet. I "Ét card pr. entity" sættes "entity" automatisk – eller brug "this.entity_id" hvor entity-id skal indsættes.',
  card_param: 'Normalt "entities". Kun relevant for "Ét samlet card".',
};

const DEFAULT_CARD = { each: "tile", list: "entities" };

const SUPPORTS_OPTIONS = [
  { value: "color", label: "Farve" },
  { value: "color_temp", label: "Farvetemperatur" },
  { value: "brightness", label: "Dæmpning" },
];

function ruleSchema(domains) {
  return [
    {
      name: "domain",
      selector: {
        select: { multiple: true, custom_value: true, mode: "dropdown", options: domains },
      },
    },
    { name: "entity_id", selector: { text: { multiple: true } } },
    { name: "name", selector: { text: { multiple: true } } },
    { name: "area", selector: { area: { multiple: true } } },
    { name: "floor", selector: { floor: { multiple: true } } },
    { name: "device", selector: { device: { multiple: true } } },
    { name: "label", selector: { label: { multiple: true } } },
    {
      name: "supports",
      selector: { select: { multiple: true, mode: "list", options: SUPPORTS_OPTIONS } },
    },
    {
      type: "expandable",
      name: "",
      title: "Avanceret: tilstand og attributter",
      schema: [
        { name: "state", selector: { text: { multiple: true } } },
        { name: "attribute", selector: { text: {} } },
        { name: "value", selector: { text: { multiple: true } } },
      ],
    },
  ];
}

function displaySchema(mode) {
  const schema = [
    {
      name: "mode",
      selector: {
        select: {
          mode: "list",
          options: [
            { value: "each", label: "Ét card pr. entity" },
            { value: "list", label: "Ét samlet card med alle entities" },
          ],
        },
      },
    },
  ];
  if (mode === "each") {
    schema.push({
      type: "grid",
      name: "",
      schema: [
        {
          name: "layout",
          selector: {
            select: {
              mode: "dropdown",
              options: [
                { value: "grid", label: "Grid" },
                { value: "vertical-stack", label: "Lodret" },
                { value: "horizontal-stack", label: "Vandret" },
              ],
            },
          },
        },
        { name: "columns", selector: { number: { min: 1, max: 12, mode: "box" } } },
      ],
    });
    schema.push({ name: "square", selector: { boolean: {} } });
  } else {
    schema.push({ name: "card_param", selector: { text: {} } });
  }
  return schema;
}

/** Fallback hvis HA's card-vælger ikke kan indlæses. */
const FALLBACK_CARD_SCHEMA = [
  { name: "card_type", selector: { text: {} } },
  { name: "card", selector: { object: {} } },
];

const OPTIONS_SCHEMA = [
  {
    type: "grid",
    name: "",
    schema: [
      {
        name: "sort",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "name", label: "Navn" },
              { value: "entity_id", label: "Entity ID" },
              { value: "area", label: "Område" },
              { value: "none", label: "Ingen" },
            ],
          },
        },
      },
      { name: "limit", selector: { number: { min: 0, mode: "box" } } },
    ],
  },
  { name: "sort_reverse", selector: { boolean: {} } },
  { name: "show_hidden", selector: { boolean: {} } },
  { name: "show_empty", selector: { boolean: {} } },
  { name: "empty_message", selector: { text: {} } },
];

const EDITOR_STYLE = `
  .section { margin-bottom: 24px; }
  .section h3 { margin: 0 0 8px; font-size: 16px; font-weight: 500; }
  .hint { color: var(--secondary-text-color); font-size: 13px; margin: 0 0 12px; }
  .rule {
    border: 1px solid var(--divider-color, #ddd);
    border-radius: 8px;
    padding: 8px 12px 12px;
    margin-bottom: 12px;
  }
  .rule-head, .card-head {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  .rule-head span { font-weight: 500; color: var(--secondary-text-color); }
  .card-head { margin-bottom: 8px; flex-wrap: wrap; }
  .card-head .name { font-weight: 500; }
  .card-head .actions { display: flex; gap: 4px; }
  button.link {
    background: none; border: none; cursor: pointer; padding: 6px 8px;
    color: var(--primary-color); font: inherit; font-weight: 500;
  }
  button.link[disabled] { color: var(--disabled-text-color, #999); cursor: default; }
  button.remove { color: var(--error-color, #db4437); }
  .count { color: var(--secondary-text-color); font-size: 13px; }
  .tabs {
    display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px;
  }
  .tabs button {
    border: 1px solid var(--divider-color, #ddd); border-radius: 16px;
    background: none; color: var(--primary-text-color); cursor: pointer;
    font: inherit; font-size: 13px; padding: 4px 12px;
  }
  .tabs button.active {
    background: var(--primary-color); border-color: var(--primary-color);
    color: var(--text-primary-color, #fff);
  }
  .tabs button.add { border-style: dashed; color: var(--primary-color); }
`;

/** Venter på at et HA-element er defineret og henter dets editor. */
async function loadConfigElementOf(helpers, config, tag) {
  helpers.createCardElement(config);
  await Promise.race([
    customElements.whenDefined(tag),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  const cls = customElements.get(tag);
  if (cls && cls.getConfigElement) await cls.getConfigElement();
}

/**
 * Tving HA til at lazy-loade ha-form, selectors, card-vælgeren og
 * card-editoren. Stack-kortets editor importerer de to sidstnævnte.
 */
let editorDepsPromise;
async function loadEditorDeps() {
  if (!editorDepsPromise) {
    editorDepsPromise = (async () => {
      let helpers;
      try {
        helpers = await getHelpers();
      } catch (err) {
        console.warn(`${CARD_TYPE}: kunne ikke loade card helpers`, err);
        return;
      }
      if (!customElements.get("ha-form") || !customElements.get("ha-selector")) {
        try {
          await loadConfigElementOf(helpers, { type: "entities", entities: [] }, "hui-entities-card");
        } catch (err) {
          console.warn(`${CARD_TYPE}: kunne ikke loade ha-form`, err);
        }
      }
      if (!customElements.get("hui-card-element-editor") || !customElements.get("hui-card-picker")) {
        try {
          await loadConfigElementOf(
            helpers,
            { type: "vertical-stack", cards: [] },
            "hui-vertical-stack-card"
          );
        } catch (err) {
          console.warn(`${CARD_TYPE}: kunne ikke loade card-editoren`, err);
        }
      }
    })();
  }
  return editorDepsPromise;
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const hasCardEditor = () =>
  Boolean(customElements.get("hui-card-element-editor") && customElements.get("hui-card-picker"));

function cardDisplayName(type) {
  if (!type) return "Intet card valgt";
  if (type.startsWith("custom:")) {
    const custom = (window.customCards || []).find((c) => `custom:${c.type}` === type);
    return custom && custom.name ? custom.name : type.slice(7);
  }
  return type
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const PICKER_HOST_TYPE = "entity-match-card-picker-host";

class PickerHost extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    const content = document.createElement("div");
    content.id = "content";
    content.appendChild(document.createElement("slot"));
    root.appendChild(content);
  }
}

class EntityMatchCardEditor extends HTMLElement {
  constructor() {
    super();
    this._root = this.attachShadow({ mode: "open" });
    this._forms = [];
    this._structureKey = undefined;
    this._picking = false;
    this._guiMode = true;
    this._guiModeAvailable = true;
    this._cardEditor = undefined;
    this._cardJson = undefined;
    this._cardTab = 0; // 0 = standard-card, n = variants[n - 1]
  }

  setConfig(config) {
    this._config = clone(config || {});
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    for (const f of this._forms) f.hass = hass;
    if (this._cardEditor) this._cardEditor.hass = hass;
    if (this._cardPicker) this._cardPicker.hass = hass;
    if (!this._domains) this._render(true);
    else this._updateCount();
  }

  set lovelace(lovelace) {
    this._lovelace = lovelace;
    if (this._cardEditor) this._cardEditor.lovelace = lovelace;
    if (this._cardPicker) this._cardPicker.lovelace = lovelace;
  }

  connectedCallback() {
    loadEditorDeps().then(() => {
      this._structureKey = undefined;
      this._render();
    });
  }

  _mode() {
    return this._config.mode || "each";
  }

  _rules(kind) {
    const filter = this._config.filter || {};
    return toList(filter[kind]);
  }

  _fire() {
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: this._config },
        bubbles: true,
        composed: true,
      })
    );
  }

  _setRules(kind, rules) {
    this._config = {
      ...this._config,
      filter: { ...(this._config.filter || {}), [kind]: rules },
    };
    this._fire();
    this._render();
  }

  _computeLabel = (schema) => LABELS[schema.name] || schema.name;
  _computeHelper = (schema) => HELPERS[schema.name];

  _makeForm(schema, data, onChange) {
    const form = document.createElement("ha-form");
    form.hass = this._hass;
    form.schema = schema;
    form.data = data;
    form.computeLabel = this._computeLabel;
    form.computeHelper = this._computeHelper;
    form.addEventListener("value-changed", (ev) => {
      ev.stopPropagation();
      onChange(ev.detail.value);
    });
    this._forms.push(form);
    return form;
  }

  _cleanRule(rule) {
    const out = {};
    for (const key of RULE_KEYS) {
      const list = toList(rule[key]).filter((v) => String(v).trim() !== "");
      if (list.length) out[key] = list;
    }
    const attribute = typeof rule.attribute === "string" ? rule.attribute.trim() : "";
    if (attribute) {
      out.attribute = attribute;
      const values = toList(rule.value).filter((v) => String(v).trim() !== "");
      if (values.length) out.value = values;
    }
    return out;
  }

  _displayData() {
    const c = this._config;
    return {
      mode: this._mode(),
      layout: c.layout || "grid",
      columns: c.columns,
      square: Boolean(c.square),
      card_param: c.card_param || "entities",
    };
  }

  _optionsData() {
    const c = this._config;
    return {
      sort: c.sort || "name",
      sort_reverse: Boolean(c.sort_reverse),
      limit: c.limit || 0,
      show_hidden: Boolean(c.show_hidden),
      show_empty: c.show_empty !== false,
      empty_message: c.empty_message || "",
    };
  }

  _onDisplayChanged(value) {
    const next = { ...this._config };
    const prevMode = this._mode();
    next.mode = value.mode;

    if (value.mode !== prevMode) {
      // Et card til den ene visning passer sjældent til den anden.
      next.card = { type: DEFAULT_CARD[value.mode] };
      delete next.variants;
      this._cardTab = 0;
    }

    if (value.mode === "each") {
      next.layout = value.layout || "grid";
      if (value.columns) next.columns = value.columns;
      else delete next.columns;
      if (value.square) next.square = true;
      else delete next.square;
      delete next.card_param;
    } else {
      delete next.layout;
      delete next.columns;
      delete next.square;
      if (value.card_param && value.card_param !== "entities") next.card_param = value.card_param;
      else delete next.card_param;
    }
    this._config = next;
    this._fire();
    this._render();
  }

  _onOptionsChanged(value) {
    const next = { ...this._config };
    const setOrDelete = (key, val, isDefault) => {
      if (isDefault) delete next[key];
      else next[key] = val;
    };
    setOrDelete("sort", value.sort, !value.sort || value.sort === "name");
    setOrDelete("sort_reverse", true, !value.sort_reverse);
    setOrDelete("limit", value.limit, !value.limit);
    setOrDelete("show_hidden", true, !value.show_hidden);
    setOrDelete("show_empty", false, value.show_empty !== false);
    setOrDelete("empty_message", value.empty_message, !value.empty_message);
    this._config = next;
    this._fire();
  }

  /* ---------------- Card-skabelon ---------------- */

  _matches() {
    return this._hass ? findEntities(this._hass, this._config, labelNames) : [];
  }

  _contexts() {
    return this._hass ? findEntityContexts(this._hass, this._config, labelNames) : [];
  }

  _variants() {
    return this._mode() === "each" ? toList(this._config.variants) : [];
  }

  _tab() {
    const tab = Math.min(this._cardTab, this._variants().length);
    return Math.max(0, tab);
  }

  /** Card-skabelonen for den valgte fane. */
  _tabCard() {
    const tab = this._tab();
    if (!tab) return this._config.card || {};
    return this._variants()[tab - 1].card || {};
  }

  /** Antal entities pr. fane: [standard, variant 1, ...]. */
  _tabCounts() {
    const counts = new Array(this._variants().length + 1).fill(0);
    for (const ctx of this._contexts()) {
      const variant = pickVariant(this._config, ctx);
      counts[variant ? this._variants().indexOf(variant) + 1 : 0] += 1;
    }
    return counts;
  }

  _setVariants(variants) {
    const next = { ...this._config };
    if (variants.length) next.variants = variants;
    else delete next.variants;
    this._config = next;
    this._fire();
  }

  _addVariant() {
    const variants = this._variants().slice();
    variants.push({ when: { supports: ["color"] }, card: clone(this._config.card || { type: "tile" }) });
    this._cardTab = variants.length;
    this._picking = false;
    this._setVariants(variants);
    this._render(true);
  }

  _removeVariant(index) {
    const variants = this._variants().slice();
    variants.splice(index, 1);
    this._cardTab = 0;
    this._picking = false;
    this._setVariants(variants);
    this._render(true);
  }

  _selectTab(tab) {
    if (tab === this._tab()) return;
    this._cardTab = tab;
    this._picking = false;
    this._render(true);
  }

  /**
   * Konfigurationen vist i card-editoren: skabelonen plus den første
   * matchende entity (ét card pr. entity) eller hele listen (samlet card),
   * så editoren og dens preview har noget at arbejde med.
   */
  _editorValue() {
    const tabCard = this._tabCard();
    const card = clone(tabCard.type ? tabCard : { type: DEFAULT_CARD[this._mode()] });
    const contexts = this._contexts();
    if (this._mode() === "list") {
      card[this._config.card_param || "entities"] = contexts.map((c) => c.entity_id);
    } else if (!JSON.stringify(card).includes(PLACEHOLDER) && contexts.length) {
      // Brug en entity der faktisk vises med dette card som eksempel.
      const tab = this._tab();
      const variants = this._variants();
      const sample =
        contexts.find((ctx) => {
          const variant = pickVariant(this._config, ctx);
          return tab ? variant === variants[tab - 1] : !variant;
        }) ||
        (tab ? contexts.find((ctx) => ruleMatches(variants[tab - 1].when, ctx)) : undefined) ||
        contexts[0];
      card.entity = sample.entity_id;
    }
    return card;
  }

  /** Fjerner det der blev tilføjet i _editorValue før det gemmes. */
  _stripEditorValue(card) {
    const out = { ...card };
    if (this._mode() === "list") {
      delete out[this._config.card_param || "entities"];
    } else if (!JSON.stringify(out).includes(PLACEHOLDER)) {
      delete out.entity;
    }
    return out;
  }

  _setCard(card) {
    const tab = this._tab();
    if (!tab) {
      this._config = { ...this._config, card };
    } else {
      const variants = this._variants().slice();
      variants[tab - 1] = { ...variants[tab - 1], card };
      this._config = { ...this._config, variants };
    }
    this._cardJson = JSON.stringify(card);
    this._fire();
  }

  _onCardPicked(config) {
    this._picking = false;
    this._setCard(this._stripEditorValue(config));
    // Lad card-vælgeren gøre sin opdatering færdig før den fjernes.
    setTimeout(() => this._render(true), 0);
  }

  _renderTabs(section) {
    const tabs = document.createElement("div");
    tabs.className = "tabs";
    const tab = this._tab();
    const names = ["Standard", ...this._variants().map((_, i) => `Variant ${i + 1}`)];
    names.forEach((name, i) => {
      const btn = document.createElement("button");
      btn.className = i === tab ? "tab active" : "tab";
      btn.dataset.name = name;
      btn.dataset.index = String(i);
      btn.textContent = name;
      btn.addEventListener("click", () => this._selectTab(i));
      tabs.appendChild(btn);
    });
    const add = document.createElement("button");
    add.className = "add";
    add.textContent = "+ Tilføj variant";
    add.addEventListener("click", () => this._addVariant());
    tabs.appendChild(add);
    section.appendChild(tabs);

    const hint = document.createElement("p");
    hint.className = "hint";
    if (!tab) {
      hint.textContent = this._variants().length
        ? "Standard-cardet bruges til de entities der ikke matcher nogen variant."
        : "Tilføj en variant for at vise nogle entities med et andet card – fx lys der understøtter farve.";
      section.appendChild(hint);
      return;
    }

    hint.textContent =
      "Entities der matcher betingelsen vises med variantens card. Den første variant der matcher bruges.";
    section.appendChild(hint);
    const index = tab - 1;
    const box = document.createElement("div");
    box.className = "rule";
    const head = document.createElement("div");
    head.className = "rule-head";
    const title = document.createElement("span");
    title.textContent = "Betingelse";
    const remove = document.createElement("button");
    remove.className = "link remove";
    remove.textContent = "Fjern variant";
    remove.addEventListener("click", () => this._removeVariant(index));
    head.append(title, remove);
    box.appendChild(head);
    const form = this._makeForm(
      ruleSchema(this._domains || []),
      this._variants()[index].when || {},
      (value) => {
        const variants = this._variants().slice();
        variants[index] = { ...variants[index], when: this._cleanRule(value) };
        this._setVariants(variants);
        this._updateCount();
      }
    );
    form.dataset.kind = "variant";
    form.dataset.index = String(index);
    box.appendChild(form);
    section.appendChild(box);
  }

  _renderCardSection(section) {
    if (this._mode() === "each") this._renderTabs(section);
    const card = this._tabCard();
    const head = document.createElement("div");
    head.className = "card-head";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = this._picking ? "Vælg card" : cardDisplayName(card.type);
    const actions = document.createElement("div");
    actions.className = "actions";
    head.append(name, actions);
    section.appendChild(head);

    if (!hasCardEditor()) {
      // Fallback: card-type og YAML via ha-form.
      const form = this._makeForm(
        FALLBACK_CARD_SCHEMA,
        { card_type: card.type || "", card },
        (value) => {
          let next = value.card && typeof value.card === "object" ? { ...value.card } : {};
          if (value.card_type && value.card_type !== card.type) next = { type: value.card_type };
          this._setCard(next);
        }
      );
      form.dataset.kind = "card";
      section.appendChild(form);
      return;
    }

    if (this._picking || !card.type) {
      if (card.type) {
        const cancel = document.createElement("button");
        cancel.className = "link";
        cancel.textContent = "Annullér";
        cancel.addEventListener("click", () => {
          this._picking = false;
          this._render(true);
        });
        actions.appendChild(cancel);
      }
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent =
        this._mode() === "each"
          ? "Vælg det card der skal vises for hver entity. Alle cards kan bruges – også custom cards fra HACS."
          : "Vælg det card der skal vise hele listen. Det skal være et card der tager en liste af entities.";
      section.appendChild(hint);
      const picker = document.createElement("hui-card-picker");
      picker.hass = this._hass;
      picker.lovelace = this._lovelace;
      picker.addEventListener("config-changed", (ev) => {
        ev.stopPropagation();
        if (ev.detail && ev.detail.config) this._onCardPicked(ev.detail.config);
      });
      this._cardPicker = picker;
      // hui-card-picker forventer en forælder med shadowRoot og #content.
      const host = document.createElement(PICKER_HOST_TYPE);
      host.appendChild(picker);
      section.appendChild(host);
      return;
    }

    const toggle = document.createElement("button");
    toggle.className = "link toggle-mode";
    const change = document.createElement("button");
    change.className = "link";
    change.textContent = "Skift card";
    change.addEventListener("click", () => {
      this._picking = true;
      this._render(true);
    });
    actions.append(toggle, change);

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      this._mode() === "each"
        ? "Editoren viser den første matchende entity som eksempel. Hvert card får automatisk sin egen entity."
        : "Editoren viser de matchende entities som eksempel. Listen indsættes automatisk.";
    section.appendChild(hint);

    this._guiMode = true;
    this._guiModeAvailable = true;
    const editor = document.createElement("hui-card-element-editor");
    editor.hass = this._hass;
    editor.lovelace = this._lovelace;
    editor.value = this._editorValue();
    this._cardJson = JSON.stringify(this._tabCard());
    editor.addEventListener("config-changed", (ev) => {
      ev.stopPropagation();
      const detail = ev.detail || {};
      if (detail.guiModeAvailable !== undefined) {
        this._guiModeAvailable = detail.guiModeAvailable;
        this._updateToggle();
      }
      if (!detail.config || detail.error) return;
      this._setCard(this._stripEditorValue(detail.config));
      this._updateCount();
      const name = this._root.querySelector(".card-head .name");
      if (name) name.textContent = cardDisplayName(this._tabCard().type);
    });
    editor.addEventListener("GUImode-changed", (ev) => {
      ev.stopPropagation();
      this._guiMode = ev.detail.guiMode;
      this._guiModeAvailable = ev.detail.guiModeAvailable;
      this._updateToggle();
    });
    toggle.addEventListener("click", () => {
      if (typeof editor.toggleMode === "function") editor.toggleMode();
    });
    this._cardEditor = editor;
    section.appendChild(editor);
    this._updateToggle();
  }

  _updateToggle() {
    const btn = this._root.querySelector("button.toggle-mode");
    if (!btn) return;
    btn.textContent = this._guiMode ? "Vis YAML" : "Vis visuel editor";
    btn.disabled = !this._guiMode && !this._guiModeAvailable;
  }

  _updateCount() {
    const el = this._root.querySelector(".count");
    if (!el || !this._hass) return;
    const n = this._matches().length;
    el.textContent = `${n} ${n === 1 ? "entity matcher" : "entities matcher"} filteret lige nu.`;
    const tabs = this._root.querySelectorAll(".tabs button.tab");
    if (tabs.length) {
      const counts = this._tabCounts();
      tabs.forEach((btn) => {
        btn.textContent = `${btn.dataset.name} (${counts[Number(btn.dataset.index)] || 0})`;
      });
    }
  }

  /* ---------------- Rendering ---------------- */

  _render(force) {
    if (!this._config) return;
    if (this._hass && !this._domains) {
      this._domains = [...new Set(Object.keys(this._hass.states).map((e) => e.split(".")[0]))].sort();
    }
    const structureKey = JSON.stringify([
      this._rules("include").length,
      this._rules("exclude").length,
      this._mode(),
      this._picking,
      this._variants().length,
      this._tab(),
      Boolean(this._tabCard().type),
      Boolean(this._domains),
      Boolean(customElements.get("ha-form")),
      hasCardEditor(),
    ]);

    // Opdatér kun data hvis strukturen er uændret – så bevares fokus i felter.
    if (!force && structureKey === this._structureKey && this._root.childElementCount) {
      this._root.querySelectorAll("ha-form").forEach((f) => {
        const kind = f.dataset.kind;
        if (kind === "display") f.data = this._displayData();
        else if (kind === "options") f.data = this._optionsData();
        else if (kind === "card") {
          const card = this._tabCard();
          f.data = { card_type: card.type || "", card };
        } else if (kind === "variant") {
          const variant = this._variants()[Number(f.dataset.index)];
          f.data = (variant && variant.when) || {};
        } else if (kind) f.data = this._rules(kind)[Number(f.dataset.index)] || {};
      });
      // Card ændret udefra (fx i dashboard-editorens YAML) – opdatér editoren.
      const cardJson = JSON.stringify(this._tabCard());
      if (this._cardEditor && cardJson !== this._cardJson) {
        this._cardJson = cardJson;
        this._cardEditor.value = this._editorValue();
        const name = this._root.querySelector(".card-head .name");
        if (name) name.textContent = cardDisplayName(this._tabCard().type);
      }
      this._updateCount();
      return;
    }
    this._structureKey = structureKey;
    this._forms = [];
    this._cardEditor = undefined;
    this._cardPicker = undefined;
    this._root.innerHTML = "";

    const style = document.createElement("style");
    style.textContent = EDITOR_STYLE;
    this._root.appendChild(style);

    if (!customElements.get("ha-form")) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "Indlæser editor …";
      this._root.appendChild(p);
      return;
    }

    const addSection = (title) => {
      const section = document.createElement("div");
      section.className = "section";
      const h = document.createElement("h3");
      h.textContent = title;
      section.appendChild(h);
      this._root.appendChild(section);
      return section;
    };

    // Filtre
    for (const kind of ["include", "exclude"]) {
      const section = addSection(kind === "include" ? "Inkludér" : "Ekskludér");
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent =
        kind === "include"
          ? "En entity medtages hvis den matcher mindst én regel. Alle udfyldte felter i en regel skal matche."
          : "Entities der matcher en af disse regler fjernes igen.";
      section.appendChild(hint);

      this._rules(kind).forEach((rule, index) => {
        const box = document.createElement("div");
        box.className = "rule";
        const head = document.createElement("div");
        head.className = "rule-head";
        const title = document.createElement("span");
        title.textContent = `Regel ${index + 1}`;
        const remove = document.createElement("button");
        remove.className = "link remove";
        remove.textContent = "Fjern";
        remove.addEventListener("click", () => {
          const next = this._rules(kind).slice();
          next.splice(index, 1);
          this._setRules(kind, next);
        });
        head.append(title, remove);
        box.appendChild(head);

        const form = this._makeForm(ruleSchema(this._domains || []), rule, (value) => {
          const next = this._rules(kind).slice();
          next[index] = this._cleanRule(value);
          this._config = {
            ...this._config,
            filter: { ...(this._config.filter || {}), [kind]: next },
          };
          this._fire();
          this._updateCount();
        });
        form.dataset.kind = kind;
        form.dataset.index = String(index);
        box.appendChild(form);
        section.appendChild(box);
      });

      const add = document.createElement("button");
      add.className = "link";
      add.textContent = kind === "include" ? "+ Tilføj inkludér-regel" : "+ Tilføj ekskludér-regel";
      add.addEventListener("click", () => this._setRules(kind, [...this._rules(kind), {}]));
      section.appendChild(add);

      if (kind === "include") {
        const count = document.createElement("p");
        count.className = "count";
        section.appendChild(count);
      }
    }

    // Visning
    const displayForm = this._makeForm(displaySchema(this._mode()), this._displayData(), (v) =>
      this._onDisplayChanged(v)
    );
    displayForm.dataset.kind = "display";
    addSection("Visning").appendChild(displayForm);

    // Card
    this._renderCardSection(addSection("Card"));

    // Øvrige indstillinger
    const optForm = this._makeForm(OPTIONS_SCHEMA, this._optionsData(), (v) =>
      this._onOptionsChanged(v)
    );
    optForm.dataset.kind = "options";
    addSection("Indstillinger").appendChild(optForm);

    this._updateCount();
  }
}

/* ------------------------------------------------------------------ */
/* Registrering                                                        */
/* ------------------------------------------------------------------ */

if (!customElements.get(CARD_TYPE)) customElements.define(CARD_TYPE, EntityMatchCard);
if (!customElements.get(EDITOR_TYPE)) customElements.define(EDITOR_TYPE, EntityMatchCardEditor);
if (!customElements.get(PICKER_HOST_TYPE)) customElements.define(PICKER_HOST_TYPE, PickerHost);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === CARD_TYPE)) {
  window.customCards.push({
    type: CARD_TYPE,
    name: "Entity Match Card",
    description: "Find entities med filtre og vis dem med et valgfrit card.",
    preview: false,
    documentationURL: "https://github.com/clausjuul/entity-match-card",
  });
}

console.info(
  `%c ENTITY-MATCH-CARD %c ${CARD_VERSION} `,
  "color: white; background: #03a9f4; font-weight: 700;",
  "color: #03a9f4; background: white; font-weight: 700;"
);
