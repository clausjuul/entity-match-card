# Entity Match Card

Et Lovelace-card der finder entities ud fra filtre og viser dem med et card du selv vælger – enten **ét card pr. entity** (fx `tile` i et grid) eller **ét samlet card** med hele listen (fx `entities`, `glance` eller `history-graph`).

Kortet har en visuel editor, så det kan sættes op direkte i dashboard-editoren.

## Installation

### HACS
1. HACS → menu (⋮) → **Custom repositories**
2. Repository: `https://github.com/clausjuul/entity-match-card`, type: **Dashboard**
3. Find **Entity Match Card** og installér. HACS tilføjer selv resource'en.

### Manuelt
1. Kopiér `dist/entity-match-card.js` til `/config/www/entity-match-card.js`
2. Indstillinger → Dashboards → ⋮ → **Resources** → tilføj `/local/entity-match-card.js` som *JavaScript module*

## Filtre

```yaml
filter:
  include:        # en entity medtages hvis den matcher MINDST ÉN regel
    - domain: light
      area: Køkken
    - entity_id: "sensor.*_temperature"
  exclude:        # entities der matcher en af disse fjernes igen
    - label: Ignorer
```

Alle udfyldte felter i en regel skal matche (AND). Hvert felt kan være én værdi eller en liste (OR).

| Felt | Matcher på |
|------|------------|
| `domain` | Domain, fx `light`, `sensor` |
| `entity_id` | Entity ID |
| `name` | Friendly name |
| `area` | Område (id eller navn). Arves fra enheden hvis entity'en ikke selv har et område |
| `floor` | Etage (id eller navn) via området |
| `device` | Enhed (id, navn eller eget navn) |
| `label` | Label (id eller navn) |

Værdier kan være:
- **eksakte** (uden forskel på store/små bogstaver): `light.kitchen`
- **wildcards** med `*` og `?`: `sensor.*_temperature`
- **regex** omgivet af `/`: `/^sensor\.(bad|køkken)_/i`

Skjulte entities udelades, medmindre `show_hidden: true`.

## Visning

### Ét card pr. entity (`mode: each`)

```yaml
type: custom:entity-match-card
filter:
  include:
    - domain: light
      floor: Stueetage
mode: each
card:
  type: tile
  features_position: inline
layout: grid        # grid | vertical-stack | horizontal-stack
columns: 3
```

`entity` sættes automatisk på hvert card. Skal entity-id'et bruges et andet sted, skriver du `this.entity_id` – så bliver det erstattet i hele card-konfigurationen (og `entity` sættes ikke automatisk):

```yaml
card:
  type: button
  entity: this.entity_id
  tap_action:
    action: perform-action
    perform_action: light.toggle
    target:
      entity_id: this.entity_id
```

### Ét samlet card (`mode: list`)

```yaml
type: custom:entity-match-card
filter:
  include:
    - entity_id: "sensor.*_temperature"
mode: list
card:
  type: history-graph
  title: Temperaturer
  hours_to_show: 24
```

Listen sættes ind i `entities`. Bruger kortet et andet felt, angiv det med `card_param`.

## Alle indstillinger

| Indstilling | Standard | Beskrivelse |
|-------------|----------|-------------|
| `filter.include` | – | Liste af regler (påkrævet for at noget vises) |
| `filter.exclude` | – | Liste af regler der fjerner entities |
| `mode` | `each` | `each` eller `list` |
| `card` | `tile` / `entities` | Card-skabelonen |
| `layout` | `grid` | Kun `each`: `grid`, `vertical-stack`, `horizontal-stack` |
| `columns` | auto | Kun `grid` |
| `square` | `false` | Kun `grid` |
| `card_param` | `entities` | Kun `list`: feltet der modtager listen |
| `sort` | `name` | `name`, `entity_id`, `area` eller `none` |
| `sort_reverse` | `false` | Omvendt rækkefølge |
| `limit` | `0` | Maks. antal entities (0 = alle) |
| `show_hidden` | `false` | Medtag skjulte entities |
| `show_empty` | `true` | `false` skjuler kortet når intet matcher |
| `empty_message` | – | Tekst når intet matcher |

## Ny version

1. Opdatér `CARD_VERSION` i `dist/entity-match-card.js`
2. Opret og push et tag med samme version, fx `git tag v0.2.0 && git push origin v0.2.0`
3. GitHub Actions laver en release med filen, og HACS tilbyder opdateringen
