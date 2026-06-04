"""Config flow for Wattson."""
from __future__ import annotations

from homeassistant.config_entries import ConfigFlow

from .const import DOMAIN


class WattsonConfigFlow(ConfigFlow, domain=DOMAIN):
    """Single-instance flow. There is nothing to configure up front."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        """Create the single config entry."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        return self.async_create_entry(title="Wattson", data={})
