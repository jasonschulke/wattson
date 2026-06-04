"""Persistent storage for Wattson.

A thin wrapper around Home Assistant's Store helper. Everything lives in one
JSON document under .storage/, so it survives restarts and is captured by
Home Assistant backups. No YAML editing required to add a label or a note.

On a fresh install (empty store) we look for a bundled seed.json and load it
as the starting point, then persist it so the user's edits stick. seed.json is
git-ignored; the repo ships seed.example.json as a template to copy.
"""
from __future__ import annotations

import copy
import json
import os
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DEFAULT_PANEL, STORAGE_KEY, STORAGE_VERSION

BREAKER_FIELDS = (
    "label",
    "number",
    "amps",
    "breaker_type",
    "area",
    "status",
    "notes",
    "entities",
    "devices",
    "areas",
)
PANEL_FIELDS = ("name", "slots", "columns")
SEED_FILENAME = "seed.json"


def _generic_default() -> dict[str, Any]:
    return {"panel": copy.deepcopy(DEFAULT_PANEL), "breakers": {}}


def _read_seed_file() -> dict[str, Any] | None:
    """Read the bundled seed file. Runs in the executor (blocking I/O)."""
    path = os.path.join(os.path.dirname(__file__), SEED_FILENAME)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


class PanelStore:
    """Owns the single Wattson document."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._data: dict[str, Any] = _generic_default()

    async def async_load(self) -> dict[str, Any]:
        stored = await self._store.async_load()
        if stored:
            self._data = self._merge(stored)
            return self._data
        seed = await self._hass.async_add_executor_job(_read_seed_file)
        if seed:
            self._data = self._merge(seed)
            await self._async_save()
        return self._data

    @staticmethod
    def _merge(src: dict[str, Any]) -> dict[str, Any]:
        data = _generic_default()
        panel = data["panel"]
        panel.update(src.get("panel") or {})
        data["panel"] = panel
        data["breakers"] = src.get("breakers") or {}
        return data

    @property
    def data(self) -> dict[str, Any]:
        return self._data

    async def _async_save(self) -> None:
        await self._store.async_save(self._data)

    async def async_set_panel(self, **fields: Any) -> dict[str, Any]:
        for key in PANEL_FIELDS:
            if fields.get(key) is not None:
                self._data["panel"][key] = fields[key]
        await self._async_save()
        return self._data

    async def async_save_breaker(self, slot: int, fields: dict[str, Any]) -> dict[str, Any]:
        breaker = self._data["breakers"].get(str(slot), {})
        for key in BREAKER_FIELDS:
            if key in fields:
                breaker[key] = fields[key]
        breaker["slot"] = slot
        self._data["breakers"][str(slot)] = breaker
        await self._async_save()
        return breaker

    async def async_clear_breaker(self, slot: int) -> None:
        self._data["breakers"].pop(str(slot), None)
        await self._async_save()
