"""The Wattson integration."""
from __future__ import annotations

import os

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from . import websocket_api
from .const import CARD_FILENAME, CARD_URL, DOMAIN, VERSION
from .store import PanelStore


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Wattson from a config entry."""
    store = PanelStore(hass)
    await store.async_load()

    domain_data = hass.data.setdefault(DOMAIN, {})
    domain_data["store"] = store

    # Serve the card, load it on the frontend, and register websocket
    # commands exactly once. add_extra_js_url makes the card load on every
    # dashboard automatically, in both storage and YAML modes and across HA
    # versions - no manual Lovelace "resource" entry required. The ?v= query
    # busts the browser cache whenever VERSION changes.
    if not domain_data.get("_setup_done"):
        await _async_register_card_path(hass)
        add_extra_js_url(hass, f"{CARD_URL}?v={VERSION}")
        websocket_api.async_register(hass)
        domain_data["_setup_done"] = True

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry.

    The static path, frontend module, and websocket commands are global and
    harmless to leave registered, so there is nothing per-entry to tear down.
    """
    sess = hass.data.get(DOMAIN, {}).get("discovery")
    if sess and sess.get("unsub"):
        sess["unsub"]()
        sess["unsub"] = None
    return True


async def _async_register_card_path(hass: HomeAssistant) -> None:
    """Make the card JS reachable over HTTP at CARD_URL."""
    card_path = os.path.join(os.path.dirname(__file__), CARD_FILENAME)
    await hass.http.async_register_static_paths(
        [StaticPathConfig(CARD_URL, card_path, False)]
    )
