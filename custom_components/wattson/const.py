"""Constants for the Wattson integration."""
from __future__ import annotations

DOMAIN = "wattson"
VERSION = "0.13.0"

STORAGE_VERSION = 1
STORAGE_KEY = "wattson.data"

URL_BASE = "/wattson"
CARD_FILENAME = "wattson-card.js"
CARD_URL = f"{URL_BASE}/{CARD_FILENAME}"

DEFAULT_PANEL: dict = {
    "name": "Main Panel",
    "slots": 20,
    "columns": 2,
}
