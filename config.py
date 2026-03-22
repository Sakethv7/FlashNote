import os
import json
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(override=True)

APP_DIR = Path(__file__).parent

@dataclass
class Settings:
    anthropic_api_key: str = ""
    tavily_api_key: str = ""
    obsidian_vault_path: str = str(APP_DIR / "vault")
    watched_folder: str = str(APP_DIR / "screenshots")
    default_expansion_level: str = "detailed"
    port: int = 8765

CONFIG_PATH = APP_DIR / "config.json"

def load_settings() -> Settings:
    s = Settings()
    s.anthropic_api_key = os.getenv("ANTHROPIC_API_KEY", "")
    s.tavily_api_key = os.getenv("TAVILY_API_KEY", "")
    s.obsidian_vault_path = os.getenv("OBSIDIAN_VAULT_PATH", s.obsidian_vault_path)

    if CONFIG_PATH.exists():
        try:
            data = json.loads(CONFIG_PATH.read_text())
            if "watched_folder" in data:
                s.watched_folder = data["watched_folder"]
            if "default_expansion_level" in data:
                s.default_expansion_level = data["default_expansion_level"]
            if "obsidian_vault_path" in data:
                s.obsidian_vault_path = data["obsidian_vault_path"]
            if "port" in data:
                s.port = data["port"]
        except Exception:
            pass

    # Ensure directories exist
    Path(s.watched_folder).mkdir(parents=True, exist_ok=True)
    Path(s.obsidian_vault_path).mkdir(parents=True, exist_ok=True)

    return s

def save_settings(updates: dict) -> "Settings":
    data = {}
    if CONFIG_PATH.exists():
        try:
            data = json.loads(CONFIG_PATH.read_text())
        except Exception:
            pass
    data.update(updates)
    CONFIG_PATH.write_text(json.dumps(data, indent=2))
    new = load_settings()
    # Mutate the global settings object in-place so all modules see the change immediately
    global settings
    settings.obsidian_vault_path = new.obsidian_vault_path
    settings.watched_folder = new.watched_folder
    settings.default_expansion_level = new.default_expansion_level
    settings.port = new.port
    return new

settings = load_settings()

COURSES_PATH = APP_DIR / "courses.json"

@dataclass
class Course:
    id: str
    course_name: str
    folder_path: str
    expansion_level: str = "detailed"  # "brief" | "detailed" | "deep_dive"
    tags: list = field(default_factory=list)

def load_courses() -> list:
    if COURSES_PATH.exists():
        try:
            data = json.loads(COURSES_PATH.read_text())
            return [Course(**c) for c in data]
        except Exception:
            return []
    return []

def save_courses(courses: list):
    COURSES_PATH.write_text(json.dumps([c.__dict__ for c in courses], indent=2))

def get_course_by_id(course_id: str):
    for c in load_courses():
        if c.id == course_id:
            return c
    return None
