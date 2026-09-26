"""
paths.py — BedDoc project paths, resolved from this file so the backend
works no matter which directory it is started from.
"""
from pathlib import Path

ROOT          = Path(__file__).resolve().parent.parent
CONFIG_DIR    = ROOT / "config"
MODELS_DIR    = ROOT / "models"
TEMPLATES_DIR = ROOT / "frontend" / "templates"
STATIC_DIR    = ROOT / "frontend" / "static"
