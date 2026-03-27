"""
Resolves app paths for both dev (running from source) and production (PyInstaller .app).

- DATA_DIR  : writable user data  → ~/Library/Application Support/FlashNote  (frozen)
                                   → project folder                            (dev)
- STATIC_DIR: read-only assets    → sys._MEIPASS/static                       (frozen)
                                   → project/static                            (dev)
"""
import sys
from pathlib import Path


def _data_dir() -> Path:
    if getattr(sys, "frozen", False):
        d = Path.home() / "Library" / "Application Support" / "FlashNote"
    else:
        d = Path(__file__).parent
    d.mkdir(parents=True, exist_ok=True)
    return d


def _static_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "static"
    return Path(__file__).parent / "static"


DATA_DIR = _data_dir()
STATIC_DIR = _static_dir()
