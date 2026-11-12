"""Phone speed test (step 2): the timing numbers an admin's iPhone measured, kept in one small JSON file.

Only numbers, booleans and short device strings are stored: never an image, never a card id. The file keeps the last
``KEEP`` runs; the body is limited in size, in the number of fields and in the length of every string.
"""

from __future__ import annotations

import json
import math
import os
import re
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path

from . import MATCHER_VERSION, config

FILE = "phone-speed.json"
KEEP = 50  # stored runs; Scanner lab lists the last 10
MAX_BODY_BYTES = 8192
MAX_TIMINGS = 80
MAX_DEVICE_FIELDS = 24
MAX_STRING = 200
NAME = re.compile(r"^[A-Za-z0-9_.\-]{1,48}$")
_lock = threading.Lock()


class SpeedRunError(ValueError):
    """The posted run is not a small set of numbers and device facts."""


def path(data_dir: Path | None = None) -> Path:
    return (data_dir or config.data_dir()) / FILE


def _number(value, where: str):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SpeedRunError(f"{where} must be a number")
    if not math.isfinite(value) or abs(value) > 1e9:
        raise SpeedRunError(f"{where} is out of range")
    return float(value) if isinstance(value, float) else int(value)


def clean(body) -> dict:
    """Validate one run and return what is stored. Raises SpeedRunError."""
    if not isinstance(body, dict):
        raise SpeedRunError("A JSON object is needed")
    timings, device = body.get("timings"), body.get("device")
    if not isinstance(timings, dict) or not timings:
        raise SpeedRunError("timings must be an object of numbers")
    if len(timings) > MAX_TIMINGS:
        raise SpeedRunError("Too many timings")
    out_timings = {}
    for key, value in timings.items():
        if not isinstance(key, str) or not NAME.match(key):
            raise SpeedRunError("Bad timing name")
        out_timings[key] = None if value is None else _number(value, key)  # null = the step did not run or failed
    device = device if device is not None else {}
    if not isinstance(device, dict) or len(device) > MAX_DEVICE_FIELDS:
        raise SpeedRunError("device must be a small object")
    out_device = {}
    for key, value in device.items():
        if not isinstance(key, str) or not NAME.match(key):
            raise SpeedRunError("Bad device field name")
        if value is None or isinstance(value, bool):
            out_device[key] = value
        elif isinstance(value, (int, float)):
            out_device[key] = _number(value, key)
        elif isinstance(value, str):
            if len(value) > MAX_STRING:
                raise SpeedRunError(f"{key} is too long")
            out_device[key] = value
        else:
            raise SpeedRunError(f"{key} must be a number, a boolean or a short text")
    unknown = set(body) - {"timings", "device"}
    if unknown:
        raise SpeedRunError("Unknown field")
    return {"timings": out_timings, "device": out_device}


def record(body, user: str, data_dir: Path | None = None, now: datetime | None = None) -> dict:
    run = clean(body)
    run["at"] = (now or datetime.now(timezone.utc)).replace(microsecond=0).isoformat()
    run["by"] = str(user)[:64]
    run["matcher_version"] = MATCHER_VERSION
    target = path(data_dir)
    with _lock:
        runs = _read(target)
        runs.append(run)
        runs = runs[-KEEP:]
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=".phone-speed-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(runs, handle)
            os.replace(tmp, target)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    return run


def _read(target: Path) -> list:
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def latest(count: int = 10, data_dir: Path | None = None) -> list[dict]:
    """The last ``count`` runs, newest first."""
    return list(reversed(_read(path(data_dir))[-count:]))
