# Wattson

A Home Assistant custom integration for **progressively mapping an electrical panel** — label each breaker, record notes, and track how confident you are about each circuit, all from a visual card that mirrors your real panel layout.

Built for the common situation where the printed panel directory is full, half the breakers just say "LIGHTS," and you want to figure out what everything does over time without paying an electrician up front.

![panel layout: two columns of breakers with status colors]

## What it does

- A Lovelace card draws your panel as two columns of numbered breakers (standard NEC odd-left / even-right numbering).
- Tap any breaker to set its **label, amperage, breaker type, area, status, and free-form notes**.
- Three-state **status** drives the color so progress is visible at a glance:
  - **Unknown** (grey, faded) — never touched
  - **Tentative** (amber) — a guess, or a vague inherited label you still need to verify
  - **Confirmed** (green) — you flipped it and checked
- Everything persists in Home Assistant's storage (survives restarts, included in backups). No YAML editing to add a note.
- The header shows a live count of confirmed / tentative / unmapped.

## Requirements

- Home Assistant 2024.7 or newer.
- A Lovelace dashboard in **storage (UI) mode** for automatic card registration. In YAML mode you add the resource manually (see below).

The card uses its own light "spec-sheet" palette by default rather than inheriting your Home Assistant theme - it's meant to be a visual statement, not blend in. (A future `theme: ha` option will let it follow your theme.)

## Install via HACS (custom repository)

1. HACS → ⋮ → **Custom repositories**.
2. URL: `https://github.com/jasonschulke/wattson`, category: **Integration**. Add.
3. Find **Wattson** in HACS, **Download**, then restart Home Assistant.
4. Settings → Devices & Services → **Add Integration** → **Wattson**.
5. Add the card to a dashboard: Edit dashboard → Add card → **Wattson** (or paste `type: custom:wattson-card`).

The integration serves its own card and tries to register it as a dashboard resource automatically. If the card doesn't appear (YAML-mode dashboards), add it manually under **Settings → Dashboards → ⋮ → Resources**:

- URL: `/wattson/wattson-card.js`
- Type: **JavaScript Module**

## Manual install (no HACS)

Copy `custom_components/wattson/` into your HA `config/custom_components/` directory, restart, then follow steps 4–5 above.

## Card configuration

```yaml
type: custom:wattson-card
pulse: true    # optional, default true. Set false for a steady (non-animated) glow.
bleed: false   # optional, default false. See "Full-screen blueprint" below.
```

That's it - there are no required options. Panel name, slot count (default 24), and column count are edited live from the gear icon on the card.

## Full-screen blueprint

By default the card draws its own self-contained blueprint inside a bordered box. A card can only paint its own bounds, so the area around it on the dashboard is whatever your theme's background is (usually flat grey).

To make the blueprint run edge to edge across the whole screen:

1. Put the card in a **Panel view** (Edit dashboard -> the view's settings -> View type: *Panel (1 card)*). The card then fills the entire view.
2. Set `bleed: true` on the card. This drops the card's own border, corners radius, and background fill so it becomes transparent and inherits the view background.
3. Give the view (or your theme) the blueprint background so it fills the screen. In a theme YAML:

```yaml
Blueprint:
  lovelace-background: "repeating-linear-gradient(0deg, rgba(74,91,216,.05) 0 1px, transparent 1px 13px), repeating-linear-gradient(90deg, rgba(74,91,216,.05) 0 1px, transparent 1px 13px), repeating-linear-gradient(0deg, rgba(74,91,216,.11) 0 1px, transparent 1px 65px), repeating-linear-gradient(90deg, rgba(74,91,216,.11) 0 1px, transparent 1px 65px), #eaeef9"
```

Select that theme (or apply the same `background` to the view) and the grid becomes continuous behind the card, with the breaker cells floating on it. With `bleed: false` the card stays a tidy standalone box on any dashboard.

## Live glow

Any breaker with at least one **linked entity or device that is currently on** glows amber, with a slow 3-second pulse. It reflects live state without rebuilding the card, so it won't disturb editing. "On" means an active state (`on`, `playing`, `open`, a running climate mode, `home`, etc.); measurement domains like `sensor` and `number` are ignored so they don't glow constantly. For a device link, the breaker glows if any of that device's entities is active.

On an always-on dashboard (e.g. a wall display) set `pulse: false` for a steady glow instead of the animation.

## Seed data

On first run, if storage is empty, the integration loads `custom_components/wattson/seed.json` as a starting point and then persists it (your later edits win). After that, your panel lives in Home Assistant's `.storage` and survives restarts **and HACS updates** — the seed file is only a first-run bootstrap.

This repo ships a generic `seed.example.json` showing the format. To preload your own panel, copy it to `seed.json` in the same folder and edit it (replace the placeholder entity/device/area IDs with ones from your HA). `seed.json` is git-ignored, so your real circuit layout never gets committed to the public repo. Most people skip the file entirely and just build the panel in the UI — the gear icon sets name/slots/columns, and breakers are labelled and linked directly on the card.

## Data model

One JSON document: a `panel` (name, slots, columns) and a `breakers` map keyed by slot number. Each breaker: `label`, `amps`, `breaker_type` (`single` / `double` / `tandem`), `area`, `status` (`unknown` / `guess` / `confirmed`), `notes`, `entities` (list of linked entity_ids), and `devices` (list of linked device_ids).

## Linking entities & devices to a breaker

Open any breaker and use the **Linked entities** / **Linked devices** searches to record what a circuit powers. Type to search your Home Assistant entities or devices, click to add a chip, the x removes it. A breaker with links shows a count badge; hover it to see the names.

## Mapping mode (guided circuit discovery)

Click **Map circuits** on the card to walk the panel breaker by breaker:

1. Target a breaker (it starts on the first unmapped one; tap any breaker to retarget).
2. **Arm & listen** - the integration starts watching Home Assistant's event bus.
3. Flip that breaker **off** at the panel and wait a few seconds.
4. **Capture** - everything that lost power is proposed. A mains-powered smart device that loses power goes `unavailable` (it drops off the network), which is the signal used; you confirm which proposals are real and they're linked to the breaker.
5. Flip the breaker back **on**, hit **Map & next**, and repeat.

Notes and caveats:
- Battery-powered sensors don't lose power, so they correctly won't appear.
- If a hub (Zigbee/Z-Wave coordinator, Hue bridge, etc.) is on the circuit you cut, all of its downstream devices will drop too - that's why discovery proposes candidates for you to confirm rather than auto-committing.
- Wi-Fi devices can take 30-120s to be marked `unavailable`; listening runs server-side until you capture, so wait before capturing and re-capture if needed.
- You can always skip mapping mode and edit links by hand.

## Roadmap / upgrade path

This is intentionally a **documentation tool** - breakers are records, not entities, so your entity registry stays clean while most circuits are still mystery boxes. Done so far: linking entities/devices (0.2.0), live glow (0.3.0), responsive layout + breaker switches (0.4.0), spec-sheet identity + guided mapping mode (0.5.0), linked-circuit inspector + pulse (0.6.0), Library sidebar with drag/tap-to-map + popover inspector + blueprint background (0.7.0). Natural next steps:

- Touch-native drag (current drag-drop is HTML5 DnD for desktop; touch uses tap-to-arm).
- An optional `theme: ha` mode to follow the Home Assistant theme instead of the built-in light spec-sheet palette.
- True-to-life rendering of 2-pole (240 V) breakers spanning two slots.

## Notes

- To appear in the HACS *default* store (not required for personal use or custom-repo installs) you'd also add brand assets to the home-assistant/brands repo and cut a tagged release.
- Licensed under the MIT License - see `LICENSE`.
