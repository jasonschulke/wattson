"""WebSocket API for Wattson.

The card talks to the backend exclusively through these commands. Every write
persists immediately and returns the updated object so the frontend can refresh
without a second round-trip.
"""
from __future__ import annotations

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN
from .store import PanelStore


@callback
def async_register(hass: HomeAssistant) -> None:
    """Register all Wattson websocket commands."""
    websocket_api.async_register_command(hass, ws_get)
    websocket_api.async_register_command(hass, ws_set_panel)
    websocket_api.async_register_command(hass, ws_save_breaker)
    websocket_api.async_register_command(hass, ws_clear_breaker)
    websocket_api.async_register_command(hass, ws_discover_start)
    websocket_api.async_register_command(hass, ws_discover_capture)
    websocket_api.async_register_command(hass, ws_discover_cancel)


# Domains whose state is a measurement, not an on/off condition.
MEASUREMENT_DOMAINS = frozenset(
    {"sensor", "number", "input_number", "input_text", "input_datetime",
     "datetime", "weather", "update", "button", "input_button", "image"}
)
INACTIVE_STATES = frozenset(
    {"off", "unavailable", "unknown", "idle", "standby",
     "closed", "not_home", "disarmed", "docked", "paused"}
)


def _state_active(state) -> bool:
    if state is None:
        return False
    domain = state.entity_id.split(".")[0]
    if domain in MEASUREMENT_DOMAINS:
        return False
    return state.state not in INACTIVE_STATES


def _discovery(hass: HomeAssistant) -> dict:
    return hass.data[DOMAIN].setdefault(
        "discovery", {"slot": None, "dropped": set(), "unsub": None}
    )


def _stop_listening(sess: dict) -> None:
    if sess.get("unsub"):
        sess["unsub"]()
        sess["unsub"] = None


def _store(hass: HomeAssistant) -> PanelStore:
    return hass.data[DOMAIN]["store"]


@websocket_api.websocket_command({vol.Required("type"): "wattson/get"})
@websocket_api.async_response
async def ws_get(hass, connection, msg) -> None:
    """Return the entire panel document."""
    connection.send_result(msg["id"], _store(hass).data)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "wattson/set_panel",
        vol.Optional("name"): str,
        vol.Optional("slots"): vol.All(int, vol.Range(min=1, max=120)),
        vol.Optional("columns"): vol.All(int, vol.Range(min=1, max=4)),
    }
)
@websocket_api.async_response
async def ws_set_panel(hass, connection, msg) -> None:
    """Update panel-level settings (name / slot count / columns)."""
    fields = {k: v for k, v in msg.items() if k in ("name", "slots", "columns")}
    data = await _store(hass).async_set_panel(**fields)
    connection.send_result(msg["id"], data)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "wattson/save_breaker",
        vol.Required("slot"): vol.All(int, vol.Range(min=1, max=120)),
        vol.Optional("label"): str,
        vol.Optional("amps"): vol.Any(None, int),
        vol.Optional("breaker_type"): vol.In(["single", "double", "tandem"]),
        vol.Optional("area"): str,
        vol.Optional("status"): vol.In(["unknown", "guess", "confirmed"]),
        vol.Optional("notes"): str,
        vol.Optional("entities"): [str],
        vol.Optional("devices"): [str],
        vol.Optional("areas"): [str],
    }
)
@websocket_api.async_response
async def ws_save_breaker(hass, connection, msg) -> None:
    """Create or update a single breaker."""
    slot = msg["slot"]
    fields = {
        k: v
        for k, v in msg.items()
        if k in ("label", "amps", "breaker_type", "area", "status", "notes", "entities", "devices", "areas")
    }
    breaker = await _store(hass).async_save_breaker(slot, fields)
    connection.send_result(msg["id"], breaker)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "wattson/clear_breaker",
        vol.Required("slot"): vol.All(int, vol.Range(min=1, max=120)),
    }
)
@websocket_api.async_response
async def ws_clear_breaker(hass, connection, msg) -> None:
    """Reset a breaker back to unmapped."""
    await _store(hass).async_clear_breaker(msg["slot"])
    connection.send_result(msg["id"], {"slot": msg["slot"], "cleared": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "wattson/discover/start",
        vol.Required("slot"): vol.All(int, vol.Range(min=1, max=120)),
    }
)
@websocket_api.async_response
async def ws_discover_start(hass, connection, msg) -> None:
    """Arm listening: watch the event bus for circuits that lose power.

    The user flips the physical breaker OFF after this. Any entity that
    transitions from an active state to off/unavailable is recorded as a
    candidate for the given slot, until capture is called.
    """
    sess = _discovery(hass)
    _stop_listening(sess)
    sess["slot"] = msg["slot"]
    sess["dropped"] = set()

    @callback
    def _on_change(event) -> None:
        old = event.data.get("old_state")
        new = event.data.get("new_state")
        if _state_active(old) and not _state_active(new):
            sess["dropped"].add(event.data.get("entity_id"))

    sess["unsub"] = hass.bus.async_listen("state_changed", _on_change)
    connection.send_result(msg["id"], {"slot": msg["slot"], "listening": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "wattson/discover/capture",
        vol.Required("slot"): vol.All(int, vol.Range(min=1, max=120)),
    }
)
@websocket_api.async_response
async def ws_discover_capture(hass, connection, msg) -> None:
    """Stop listening and return everything that dropped, for the user to confirm."""
    sess = _discovery(hass)
    _stop_listening(sess)
    proposals = []
    for entity_id in sorted(sess["dropped"]):
        state = hass.states.get(entity_id)
        name = entity_id
        if state and state.attributes.get("friendly_name"):
            name = state.attributes["friendly_name"]
        proposals.append(
            {
                "entity_id": entity_id,
                "name": name,
                "domain": entity_id.split(".")[0],
                "state": state.state if state else "unavailable",
            }
        )
    connection.send_result(
        msg["id"], {"slot": sess.get("slot"), "proposals": proposals}
    )


@websocket_api.websocket_command(
    {vol.Required("type"): "wattson/discover/cancel"}
)
@websocket_api.async_response
async def ws_discover_cancel(hass, connection, msg) -> None:
    """End the discovery session."""
    sess = _discovery(hass)
    _stop_listening(sess)
    sess["slot"] = None
    sess["dropped"] = set()
    connection.send_result(msg["id"], {"cancelled": True})
