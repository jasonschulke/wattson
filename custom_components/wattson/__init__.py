"""The Wattson integration."""
from __future__ import annotations

import logging
import os

from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from . import websocket_api
from .const import CARD_FILENAME, CARD_URL, DOMAIN, VERSION
from .store import PanelStore

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Wattson from a config entry."""
    store = PanelStore(hass)
    await store.async_load()

    domain_data = hass.data.setdefault(DOMAIN, {})
    domain_data["store"] = store

    # Serve the card and register websocket commands exactly once.
    if not domain_data.get("_setup_done"):
        await _async_register_card_path(hass)
        websocket_api.async_register(hass)
        domain_data["_setup_done"] = True

    # Best effort: add the card as a Lovelace resource (storage mode only).
    await _async_register_resource(hass)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry.

    The static path and websocket commands are global and harmless to leave
    registered, so there is nothing per-entry to tear down.
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


async def _async_register_resource(hass: HomeAssistant) -> None:
    """Try to auto-register the card as a Lovelace dashboard resource.

    Only possible in storage (UI) mode. In YAML mode the user adds the
    resource manually; see the README. Failures here never block setup.
    """
    try:
        lovelace = hass.data.get("lovelace")
        if lovelace is None:
            return
        mode = getattr(lovelace, "mode", None)
        resources = getattr(lovelace, "resources", None)
        if resources is None or mode != "storage":
            return
        if not getattr(resources, "loaded", True):
            await resources.async_load()
            resources.loaded = True
        for item in resources.async_items():
            if str(item.get("url", "")).split("?")[0] == CARD_URL:
                return
        await resources.async_create_item(
            {"res_type": "module", "url": f"{CARD_URL}?v={VERSION}"}
        )
        _LOGGER.info("Registered Wattson card as a Lovelace resource")
    except Exception as err:  # noqa: BLE001 - best effort only
        _LOGGER.warning(
            "Could not auto-register the Wattson card resource (%s). "
            "Add it manually under Settings > Dashboards > Resources: "
            "%s (type: JavaScript Module)",
            err,
            CARD_URL,
        )
