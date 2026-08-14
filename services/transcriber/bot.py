import os
import asyncio
import hashlib
import hmac
import base64
import json
import logging
import mimetypes
import re
import shutil
import sqlite3
import subprocess
import time
import traceback
import uuid
import zoneinfo
import zipfile
from datetime import datetime
from urllib.parse import urlparse, quote
from pathlib import Path
from contextlib import suppress
from xml.sax.saxutils import escape as xml_escape
from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import (
    CallbackQuery,
    FSInputFile,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    InlineQuery,
    InlineQueryResultArticle,
    InputRichMessage,
    InputTextMessageContent,
    Message,
    Update,
)
from groq import AsyncGroq
from dotenv import load_dotenv
from aiohttp import web

# Load environment variables from .env file
load_dotenv(dotenv_path=Path(__file__).with_name(".env"))

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")

if not TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN == "ВАШ_ТОКЕН_ОТ_BOTFATHER_ЗДЕСЬ":
    raise ValueError("Пожалуйста, укажите TELEGRAM_BOT_TOKEN в файле .env")
if not GROQ_API_KEY:
    raise ValueError("Пожалуйста, укажите GROQ_API_KEY в файле .env")

# Initialize logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")

# Initialize bot and dispatcher
bot = Bot(token=TELEGRAM_BOT_TOKEN)
dp = Dispatcher()

# Initialize Groq client
groq_client = AsyncGroq(api_key=GROQ_API_KEY)

TEMP_DIR = "temp"
os.makedirs(TEMP_DIR, exist_ok=True)
SAFE_MESSAGE_LIMIT = 3900
INLINE_DESCRIPTION_LIMIT = 120
INLINE_QUERY_LIMIT = 3500
WEBHOOK_BASE_URL = os.getenv("WEBHOOK_BASE_URL", "https://tg-transcriber-bot.fly.dev").rstrip("/")
WEBHOOK_SECRET = os.getenv("TELEGRAM_WEBHOOK_SECRET") or hashlib.sha256(TELEGRAM_BOT_TOKEN.encode()).hexdigest()
WEBHOOK_PATH = f"/telegram-webhook/{WEBHOOK_SECRET}"
WEBHOOK_URL = f"{WEBHOOK_BASE_URL}{WEBHOOK_PATH}"
APP_VERSION = "2026-07-06-hardening-v28"
FLY_APP_NAME = os.getenv("FLY_APP_NAME", "tg-transcriber-bot")
BOT_PROFILE_NAME = "Саммаризатор голосовых"
BOT_PROFILE_SHORT_DESCRIPTION = "Расшифровка голосовых, PDF из материалов и AI-кнопки."
BOT_PROFILE_DESCRIPTION = (
    "Отправь голосовое, аудио, видео, фото или текст. "
    "Бот предложит кнопки: расшифровать, сделать summary, оформить сообщение, "
    "собрать PDF max quality или подготовить промт для Codex. Автор: @denrech"
)
DEFAULT_MODE_ID = "summary"
MODE_CALLBACK_PREFIX = "mode:"
YOUTUBE_CALLBACK_PREFIX = "yt:"
TRANSCRIPT_ACTION_PREFIX = "tx:"
MATERIAL_ACTION_PREFIX = "mat:"
FEEDBACK_CALLBACK_PREFIX = "fb:"
SELF_CALLBACK_PREFIX = "self:"
V3_SUGGESTION_PREFIX = "v3s:"
YOUTUBE_MAX_DURATION_SECONDS = 20 * 60
YOUTUBE_PENDING_TTL_SECONDS = 30 * 60
MEDIA_BATCH_DELAY_SECONDS = 0.5
CONTENT_BATCH_DELAY_SECONDS = 2.0
TRANSCRIPT_ACTION_TTL_SECONDS = 60 * 60
MATERIAL_ACTION_TTL_SECONDS = 60 * 60
FEEDBACK_SESSION_TTL_SECONDS = 30 * 60
TELEGRAM_MAX_UPLOAD_BYTES = 49 * 1024 * 1024
TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
OCR_MAX_IMAGES_PER_ACTION = 10
DOC_EXPORT_TEXT_LIMIT = 120000
OCR_MAX_BASE64_CHARS = 4 * 1024 * 1024
OCR_VISION_MODEL = os.getenv("GROQ_VISION_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct")
YOUTUBE_URL_RE = re.compile(r"https?://[^\s<>()]+", re.IGNORECASE)
YOUTUBE_DEBUG_PREFIX = "/youtube-debug/"
DEBUG_STATUS_PREFIX = "/debug/status/"
YOUTUBE_CLIENT_FALLBACKS = (
    ("default", None),
    ("tv_simply", {"youtube": {"player_client": ["tv_simply"]}}),
    ("web_safari", {"youtube": {"player_client": ["web_safari"]}}),
    ("web_embedded", {"youtube": {"player_client": ["web_embedded"]}}),
    ("web_creator", {"youtube": {"player_client": ["web_creator"]}}),
    ("mweb", {"youtube": {"player_client": ["mweb"]}}),
    ("ios", {"youtube": {"player_client": ["ios"]}}),
    ("android", {"youtube": {"player_client": ["android"]}}),
    ("tv_downgraded", {"youtube": {"player_client": ["tv_downgraded"]}}),
)
YOUTUBE_JS_OPTIONS = {
    "remote_components": ["ejs:github"],
    "js_runtimes": {"node": {}, "deno": {}, "quickjs": {}, "bun": {}},
}
YOUTUBE_ERROR_LOG_PATH = Path(TEMP_DIR) / "youtube_errors.jsonl"
YOUTUBE_COOKIES_PATH = Path(TEMP_DIR) / "youtube_cookies.txt"
LEADS_CHAT_ID_PATH = Path(TEMP_DIR) / "leads_chat_id.txt"
PENDING_LEADS_PATH = Path(TEMP_DIR) / "pending_leads.jsonl"
STATE_DB_PATH = Path(os.getenv(
    "STATE_DB_PATH",
    "/data/bot_state.sqlite3" if Path("/data").exists() else str(Path(TEMP_DIR) / "bot_state.sqlite3"),
))
USER_FEATURE_FLAGS_PATH = Path(os.getenv("USER_FEATURE_FLAGS_PATH", str(Path(TEMP_DIR) / "user_feature_flags.json")))
PROFILE_NOTES_PATH = Path(os.getenv("PROFILE_NOTES_PATH", str(Path(TEMP_DIR) / "profile_notes.json")))
PROFILE_NOTES_SEED_PATH = Path(__file__).with_name("profile_notes_seed.json")
PDF_FONT_PATH = Path(__file__).with_name("assets") / "fonts" / "NotoSans-Regular.ttf"
YOUTUBE_COOKIES_TEXT = os.getenv("YOUTUBE_COOKIES_TEXT", "")
YOUTUBE_COOKIES_BASE64 = os.getenv("YOUTUBE_COOKIES_BASE64", "")
YOUTUBE_PROXY = os.getenv("YOUTUBE_PROXY", "")
LEADS_CHAT_ID = os.getenv("LEADS_CHAT_ID") or os.getenv("TELEGRAM_LEADS_CHAT_ID") or os.getenv("TELEGRAM_CHAT_ID")
LEAD_FORM_SECRET = os.getenv("LEAD_FORM_SECRET", "")
LEAD_ADMIN_USERNAMES = {
    username.strip().lstrip("@").lower()
    for username in os.getenv("LEAD_ADMIN_USERNAMES", "denrech").split(",")
    if username.strip()
}
YOUTUBE_ERROR_LIMIT = 20

# --- v3 "режим бога": opt-in, мощные функции только для одного Telegram user id ---
GOD_USER_ID = int(os.getenv("GOD_USER_ID", "0") or "0")
GOD_USERNAME = os.getenv("GOD_USERNAME", "denrech").strip().lstrip("@").lower()
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-opus-4-8").strip()
ANTHROPIC_EFFORT = os.getenv("ANTHROPIC_EFFORT", "high").strip()
V3_GROQ_MODEL = os.getenv("V3_GROQ_MODEL", "llama-3.3-70b-versatile").strip()
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "").strip()
GITHUB_REPO = os.getenv("GITHUB_REPO", "aireden14/tg-transcriber-bot").strip()
GIT_AUTHOR_NAME = os.getenv("GIT_AUTHOR_NAME", "tg-transcriber-bot")
GIT_AUTHOR_EMAIL = os.getenv("GIT_AUTHOR_EMAIL", "bot@users.noreply.github.com")
V3_AGENT_MAX_TURNS = int(os.getenv("V3_AGENT_MAX_TURNS", "12") or "12")
V3_AGENT_MAX_TOKENS = int(os.getenv("V3_AGENT_MAX_TOKENS", "12000") or "12000")
V3_BASH_TIMEOUT_SECONDS = int(os.getenv("V3_BASH_TIMEOUT_SECONDS", "60") or "60")
V3_TOOL_OUTPUT_LIMIT = 12000
V3_CONTEXT_LIMIT = 12000
V3_DIFF_PREVIEW_LIMIT = 6000
V3_SELF_SESSION_TTL_SECONDS = 30 * 60
V3_SANDBOX_ROOT = Path(TEMP_DIR) / "v3_sandbox"
V3_SELF_WORK_ROOT = Path(TEMP_DIR) / "v3_self_work"
V3_SUGGESTIONS_TTL_SECONDS = 60 * 60
V3_MAX_SUGGESTIONS = 4
V3_CONVO_TURNS = 6
V3_TZ = os.getenv("V3_TZ", "Asia/Almaty")
V3_REMINDER_PREFIX = "v3r:"
PROCESSED_UPDATE_TTL_SECONDS = 10 * 60
V3_REMINDERS_PATH = Path(os.getenv("V3_REMINDERS_PATH", str(Path(TEMP_DIR) / "v3_reminders.json")))
V3_MEMORY_PATH = Path(os.getenv("V3_MEMORY_PATH", str(Path(TEMP_DIR) / "v3_memory.jsonl")))
V3_MEMORY_MAX_LINES = 2000
V3_MEMORY_TOPK = 6
V3_TEXT_CONTENT_THRESHOLD = 400
V3_MAX_VISION_IMAGES = 4
V3_REMINDER_POLL_SECONDS = 30
user_modes: dict[int, str] = {}
pending_downloads: dict[str, dict] = {}
media_batches: dict[str, dict] = {}
media_batch_locks: dict[str, asyncio.Lock] = {}
content_batches: dict[str, dict] = {}
content_batch_locks: dict[str, asyncio.Lock] = {}
transcript_actions: dict[str, dict] = {}
material_actions: dict[str, dict] = {}
feedback_sessions: dict[int, dict] = {}
last_user_context: dict[int, str] = {}
self_edit_sessions: dict[str, dict] = {}
v3_suggestion_actions: dict[str, dict] = {}
v3_conversations: dict[int, list] = {}
last_user_images: dict[int, list] = {}
v3_reminders: list[dict] = []
processed_update_ids: dict[int, float] = {}

BASE_OUTPUT_RULES = """
Правила ответа:
- Пиши на русском языке.
- Пиши только plain text. Не используй Markdown, звездочки, жирный текст или декоративную разметку.
- Не начинай с мета-фраз вроде "Текст представляет собой", "В тексте говорится", "Говорящий сообщает".
- Не добавляй пустые разделы.
- Не выдумывай факты, которых нет в исходной расшифровке.
"""

MODES = {
    "summary": {
        "emoji": "🧠",
        "title": "Summary",
        "description": "Расшифровка + короткая суть",
        "aliases": ("sum", "summary", "саммари", "суть"),
        "show_transcript": True,
        "prompt": """
Сделай короткую полезную выжимку текста.
- Дай 2-5 коротких строк максимум.
- Если в исходном тексте прямо есть явные поручения или дела на будущее со словами вроде "нужно", "надо", "сделай", "проверь", "задача", добавь строку "Задачи:" и перечисли их коротко.
- Если явных задач нет, вообще не упоминай задачи.
- Не считай задачей сам факт, что человек что-то тестирует, смотрит, показывает или рассказывает.
- Даже если текст короткий, бытовой или тестовый, все равно дай очень короткую суть одной простой строкой.
- Не пиши "summary не требуется".
""",
    },
    "message": {
        "emoji": "✍️",
        "title": "Человеческое сообщение",
        "description": "Оформить как обычное сообщение",
        "aliases": ("message", "msg", "сообщение", "человек"),
        "show_transcript": False,
        "prompt": """
Преврати расшифровку в аккуратное Telegram-сообщение от первого лица, как будто человек сам нормально написал его руками.
- Не держись 1-в-1 за слова из расшифровки: это мог быть плохой speech-to-text.
- По контексту восстанови, что человек хотел сказать, и переформулируй естественно.
- Исправь вероятно неверно распознанные слова, если из контекста понятно, что имелось в виду.
- Немного сократи текст: убери "эээ", повторы, оговорки, мусорные слова и лишние заходы.
- Сохрани живой человеческий тон, основную мысль и важные детали.
- Не добавляй новые факты, цифры, обещания или детали, которых нет в исходном смысле.
- Не делай пост, список или summary.
- Верни только готовый текст сообщения.
""",
    },
    "post": {
        "emoji": "📢",
        "title": "Telegram-пост",
        "description": "Готовый пост для канала",
        "aliases": ("post", "пост", "channel", "канал"),
        "show_transcript": False,
        "prompt": """
Сделай из расшифровки готовый Telegram-пост для канала.
- Начни с цепляющего заголовка.
- Дальше дай основной текст в 2-5 коротких абзацах.
- В конце добавь короткий вывод или мягкий CTA, если он уместен.
- Убери воду, повторы и разговорный мусор.
""",
    },
    "tasks": {
        "emoji": "✅",
        "title": "Задачи",
        "description": "Вытащить дела и шаги",
        "aliases": ("tasks", "task", "задачи", "дела"),
        "show_transcript": False,
        "prompt": """
Вытащи из расшифровки задачи, поручения, дедлайны и следующие шаги.
- Если задачи есть, верни короткий список.
- Если задач нет, верни одну строку с сутью сообщения.
- Не добавляй пустые разделы и не пиши "задач нет".
""",
    },
    "meeting": {
        "emoji": "📋",
        "title": "Протокол встречи",
        "description": "Решения, задачи, спорные моменты",
        "aliases": ("meeting", "meet", "встреча", "созвон", "протокол"),
        "show_transcript": False,
        "prompt": """
Сделай краткий протокол встречи или созвона.
- Тема
- Ключевые решения
- Задачи
- Спорные моменты
- Что дальше
Показывай только разделы, где есть реальная информация.
""",
    },
    "client": {
        "emoji": "💬",
        "title": "Ответ клиенту",
        "description": "Вежливый готовый ответ",
        "aliases": ("client", "клиент", "ответ"),
        "show_transcript": False,
        "prompt": """
Преврати мысль из расшифровки в готовый ответ клиенту.
- Тон спокойный, вежливый, уверенный.
- Без грубости, хаоса и лишних оправданий.
- Если в исходнике есть конкретика, сохрани ее.
- Верни только текст ответа.
""",
    },
    "crm": {
        "emoji": "🧾",
        "title": "CRM-заметка",
        "description": "Структура по клиенту",
        "aliases": ("crm", "црм", "заметка", "клиентская"),
        "show_transcript": False,
        "prompt": """
Сделай CRM-заметку по клиенту.
- Клиент/контекст
- Что хочет
- Боль/потребность
- Важные детали
- Следующий шаг
Показывай только разделы, где есть информация.
""",
    },
    "reels": {
        "emoji": "🎬",
        "title": "Сценарий/Reels",
        "description": "Хук и структура видео",
        "aliases": ("reels", "reel", "сценарий", "рилс", "видео"),
        "show_transcript": False,
        "prompt": """
Преврати идею из расшифровки в короткий сценарий для Reels/Shorts.
- Хук
- Основная мысль
- Структура кадров или тезисов
- Финальная фраза
Пиши коротко и прикладно.
""",
    },
    "plan": {
        "emoji": "📌",
        "title": "План",
        "description": "Пошаговый план действий",
        "aliases": ("plan", "план", "шаги"),
        "show_transcript": False,
        "prompt": """
Сделай из расшифровки пошаговый план.
- Расставь действия в логичном порядке.
- Пиши короткими пунктами.
- Если идея сырая, сначала выдели цель, потом шаги.
""",
    },
    "clean": {
        "emoji": "🧹",
        "title": "Только чистый текст",
        "description": "Очищенная расшифровка без summary",
        "aliases": ("clean", "чистый", "текст", "расшифровка"),
        "show_transcript": False,
        "prompt": """
Очисти расшифровку в читаемый текст.
- Убери повторы, оговорки, слова-паразиты и явный мусор.
- Сохрани смысл и порядок мыслей.
- Не делай summary, пост, список задач или новый стиль.
- Верни только очищенный текст.
""",
    },
    "pdf_prompt": {
        "emoji": "📄",
        "title": "Промт для PDF",
        "description": "ТЗ на сборку аккуратного PDF",
        "aliases": ("pdf", "пдф", "pdf_prompt", "pdfprompt", "промтпдф"),
        "show_transcript": False,
        "prompt": """
Сделай из расшифровки промт/ТЗ для агента, который должен собрать аккуратный PDF-документ.
- Опиши цель PDF и для кого он нужен.
- Разложи содержание по логичным разделам и порядку страниц.
- Укажи, какие материалы, тексты, фото, таблицы или ссылки надо включить, если они упомянуты.
- Если данных не хватает, добавь раздел "Уточнить" с конкретными вопросами.
- Добавь критерии готовности: что должно быть в итоговом PDF и как проверить результат.
- Не выдумывай факты, которых нет в исходной расшифровке.
""",
    },
    "word_prompt": {
        "emoji": "📝",
        "title": "Промт для Word",
        "description": "ТЗ на сборку .docx",
        "aliases": ("word", "docx", "ворд", "док", "word_prompt", "wordprompt", "промтворд"),
        "show_transcript": False,
        "prompt": """
Сделай из расшифровки промт/ТЗ для агента, который должен собрать редактируемый Word-документ .docx.
- Опиши цель документа и ожидаемого читателя.
- Разложи содержание по заголовкам, подразделам и спискам.
- Укажи, какие исходные материалы надо сохранить, структурировать или перенести в документ.
- Если нужны таблицы, поля для заполнения, чек-листы или приложения — явно перечисли их.
- Если данных не хватает, добавь раздел "Уточнить" с конкретными вопросами.
- Добавь критерии готовности и проверки Word-файла.
- Не выдумывай факты, которых нет в исходной расшифровке.
""",
    },
}

MODE_ALIASES = {
    alias: mode_id
    for mode_id, mode in MODES.items()
    for alias in (mode_id, *mode["aliases"])
}

class UserVisibleError(Exception):
    """Error that can be safely shown to the Telegram user."""

def state_db_connect() -> sqlite3.Connection:
    STATE_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(STATE_DB_PATH), timeout=10)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=5000")
    connection.execute(
        "CREATE TABLE IF NOT EXISTS kv_state ("
        "key TEXT PRIMARY KEY, "
        "value TEXT NOT NULL, "
        "updated_at REAL NOT NULL"
        ")"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS queue_state ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "queue_name TEXT NOT NULL, "
        "payload TEXT NOT NULL, "
        "created_at REAL NOT NULL"
        ")"
    )
    connection.commit()
    return connection

def state_db_ok() -> bool:
    try:
        with state_db_connect():
            return True
    except Exception:
        logging.exception("State DB is not available")
        return False

def state_set_text(key: str, value: str) -> bool:
    try:
        with state_db_connect() as connection:
            connection.execute(
                "INSERT INTO kv_state(key, value, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                (key, value, time.time()),
            )
        return True
    except Exception:
        logging.exception("Failed to write state key: %s", key)
        return False

def state_get_text(key: str) -> str | None:
    try:
        with state_db_connect() as connection:
            row = connection.execute("SELECT value FROM kv_state WHERE key = ?", (key,)).fetchone()
    except Exception:
        logging.exception("Failed to read state key: %s", key)
        return None
    return str(row[0]) if row else None

def state_delete(key: str) -> None:
    try:
        with state_db_connect() as connection:
            connection.execute("DELETE FROM kv_state WHERE key = ?", (key,))
    except Exception:
        logging.exception("Failed to delete state key: %s", key)

def state_set_json(key: str, value) -> bool:
    return state_set_text(key, json.dumps(value, ensure_ascii=False))

def state_get_json(key: str, default=None):
    raw = state_get_text(key)
    if raw is None:
        return default
    try:
        return json.loads(raw)
    except Exception:
        logging.exception("Failed to decode state JSON key: %s", key)
        return default

def state_queue_append(queue_name: str, payload: dict) -> bool:
    try:
        with state_db_connect() as connection:
            connection.execute(
                "INSERT INTO queue_state(queue_name, payload, created_at) VALUES (?, ?, ?)",
                (queue_name, json.dumps(payload, ensure_ascii=False), time.time()),
            )
        return True
    except Exception:
        logging.exception("Failed to append state queue: %s", queue_name)
        return False

def state_queue_take(queue_name: str) -> list[dict]:
    try:
        with state_db_connect() as connection:
            rows = connection.execute(
                "SELECT id, payload FROM queue_state WHERE queue_name = ? ORDER BY id",
                (queue_name,),
            ).fetchall()
            if rows:
                ids = [str(row[0]) for row in rows]
                connection.execute(
                    f"DELETE FROM queue_state WHERE id IN ({','.join('?' for _ in ids)})",
                    ids,
                )
    except Exception:
        logging.exception("Failed to take state queue: %s", queue_name)
        return []

    payloads: list[dict] = []
    for _, raw_payload in rows:
        try:
            payload = json.loads(raw_payload)
        except Exception:
            continue
        if isinstance(payload, dict):
            payloads.append(payload)
    return payloads

def state_queue_count(queue_name: str) -> int:
    try:
        with state_db_connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) FROM queue_state WHERE queue_name = ?",
                (queue_name,),
            ).fetchone()
        return int(row[0]) if row else 0
    except Exception:
        logging.exception("Failed to count state queue: %s", queue_name)
        return 0

def state_keys_with_prefix(prefix: str) -> list[str]:
    try:
        with state_db_connect() as connection:
            rows = connection.execute(
                "SELECT key FROM kv_state WHERE key LIKE ?",
                (f"{prefix}%",),
            ).fetchall()
        return [str(row[0]) for row in rows]
    except Exception:
        logging.exception("Failed to list state prefix: %s", prefix)
        return []

def get_ffmpeg_path() -> str:
    """Return a usable ffmpeg executable path."""
    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg:
        return system_ffmpeg

    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as e:
        raise UserVisibleError(
            "ffmpeg не найден. Установите ffmpeg или добавьте imageio-ffmpeg в зависимости."
        ) from e

def get_ffprobe_path(ffmpeg_path: str | None = None) -> str | None:
    system_ffprobe = shutil.which("ffprobe")
    if system_ffprobe:
        return system_ffprobe
    if ffmpeg_path:
        sibling = Path(ffmpeg_path).with_name("ffprobe")
        if sibling.exists():
            return str(sibling)
    return None

async def ensure_media_has_audio_stream(input_path: str, ffmpeg_path: str) -> None:
    ffprobe_path = get_ffprobe_path(ffmpeg_path)
    if not ffprobe_path:
        return

    process = await asyncio.create_subprocess_exec(
        ffprobe_path,
        "-v",
        "error",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=index",
        "-of",
        "json",
        input_path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    if process.returncode != 0:
        logging.info("ffprobe could not inspect media: %s", stderr.decode(errors="ignore")[:500])
        return

    try:
        data = json.loads(stdout.decode(errors="ignore") or "{}")
    except Exception:
        return
    if not data.get("streams"):
        raise UserVisibleError(
            "❌ В этом видео нет аудиодорожки, поэтому транскрибировать нечего.\n\n"
            "Отправь видео со звуком или отдельно аудио/голосовое."
        )

def explain_groq_error(error: Exception, action: str) -> str:
    """Build a precise, user-safe Groq error message."""
    status_code = getattr(error, "status_code", None)
    error_text = str(error)

    if status_code == 401 or "invalid_api_key" in error_text.lower() or "invalid api key" in error_text.lower():
        return (
            f"❌ Groq отклонил запрос на {action}: неверный GROQ_API_KEY.\n\n"
            "Нужно заменить ключ в Fly secrets и в локальном .env, затем перезапустить сервис."
        )
    if status_code == 429 or "rate_limit" in error_text.lower():
        return f"❌ Groq временно ограничил запрос на {action}: превышен лимит API. Попробуй позже или проверь тариф/лимиты Groq."
    if status_code and 500 <= status_code < 600:
        return f"❌ Groq сейчас недоступен при операции: {action}. Это серверная ошибка Groq, стоит повторить чуть позже."
    if "unsupported" in error_text.lower() or "format" in error_text.lower():
        return f"❌ Groq не принял аудиофайл для {action}: неподдерживаемый формат после конвертации."

    logging.error("Unexpected Groq error during %s: %s", action, error)
    return f"❌ Groq вернул ошибку при операции: {action}. Подробности записаны в лог сервера."

def build_result_message(transcription: str, summary: str | None = None) -> str:
    """Build a Telegram-safe plain-text result."""
    message = f"📝 {transcription.strip()}"

    message += f"\n\n🧠 {summary.strip() if summary else 'Короткое сообщение.'}"

    return message

def build_transcript_message(transcriptions: list[str]) -> str:
    """Build the default transcript-only media response."""
    cleaned = [text.strip() for text in transcriptions if text.strip()]
    if not cleaned:
        return "📝 Расшифровка не получилась."
    if len(cleaned) == 1:
        return f"📝 {cleaned[0]}"
    lines = ["📝 Расшифровка:"]
    for index, transcription in enumerate(cleaned, start=1):
        lines.append(f"\n{index}. {transcription}")
    return "\n".join(lines)

def cleanup_transcript_actions() -> None:
    now = time.time()
    expired_ids = [
        action_id
        for action_id, item in transcript_actions.items()
        if now - item["created_at"] > TRANSCRIPT_ACTION_TTL_SECONDS
    ]
    for action_id in expired_ids:
        transcript_actions.pop(action_id, None)
        state_delete(f"transcript_action:{action_id}")

    for key in state_keys_with_prefix("transcript_action:"):
        action_id = key.split(":", 1)[1]
        if action_id in transcript_actions:
            continue
        item = state_get_json(key)
        if not isinstance(item, dict) or now - float(item.get("created_at") or 0) > TRANSCRIPT_ACTION_TTL_SECONDS:
            state_delete(key)

def persist_transcript_action(action_id: str, item: dict) -> None:
    state_set_json(f"transcript_action:{action_id}", item)

def load_transcript_action(action_id: str) -> dict | None:
    item = transcript_actions.get(action_id)
    if item:
        return item
    item = state_get_json(f"transcript_action:{action_id}")
    if not isinstance(item, dict):
        return None
    if time.time() - float(item.get("created_at") or 0) > TRANSCRIPT_ACTION_TTL_SECONDS:
        state_delete(f"transcript_action:{action_id}")
        return None
    transcript_actions[action_id] = item
    return item

def create_transcript_action_id(user_id: int, transcript: str) -> str:
    payload = f"{user_id}:{time.time()}:{hashlib.sha256(transcript.encode('utf-8')).hexdigest()}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:16]

def build_transcript_action_keyboard(action_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="🧠 Сделать summary",
                    callback_data=f"{TRANSCRIPT_ACTION_PREFIX}summary:{action_id}",
                )
            ],
            [
                InlineKeyboardButton(
                    text="✍️ Оформить сообщение",
                    callback_data=f"{TRANSCRIPT_ACTION_PREFIX}message:{action_id}",
                )
            ],
            [
                InlineKeyboardButton(
                    text="💻 Промт для Codex",
                    callback_data=f"{TRANSCRIPT_ACTION_PREFIX}codex:{action_id}",
                )
            ],
        ]
    )

def store_transcript_action(user_id: int | None, transcript: str) -> InlineKeyboardMarkup | None:
    if user_id is None or not transcript.strip():
        return None
    cleanup_transcript_actions()
    action_id = create_transcript_action_id(user_id, transcript)
    transcript_actions[action_id] = {
        "user_id": user_id,
        "transcript": transcript,
        "created_at": time.time(),
    }
    persist_transcript_action(action_id, transcript_actions[action_id])
    remember_context(user_id, transcript)
    return build_transcript_action_keyboard(action_id)

def load_user_feature_flags() -> dict[str, dict]:
    state_flags = state_get_json("user_feature_flags")
    if isinstance(state_flags, dict):
        raw = state_flags
    else:
        raw = None
    try:
        if raw is None:
            raw = json.loads(USER_FEATURE_FLAGS_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception:
        logging.exception("Failed to read user feature flags")
        return {}

    if not isinstance(raw, dict):
        return {}

    flags: dict[str, dict] = {}
    for user_id, value in raw.items():
        if isinstance(user_id, str) and isinstance(value, dict):
            flags[user_id] = {
                "ocr_enabled": bool(value.get("ocr_enabled")),
                "v3_enabled": bool(value.get("v3_enabled")),
            }
    return flags

def save_user_feature_flags(flags: dict[str, dict]) -> None:
    state_set_json("user_feature_flags", flags)
    USER_FEATURE_FLAGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    USER_FEATURE_FLAGS_PATH.write_text(
        json.dumps(flags, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

def is_ocr_enabled(user_id: int | None) -> bool:
    if user_id is None:
        return False
    flags = load_user_feature_flags()
    return bool(flags.get(str(user_id), {}).get("ocr_enabled"))

def set_ocr_enabled(user_id: int, enabled: bool) -> None:
    flags = load_user_feature_flags()
    user_flags = flags.setdefault(str(user_id), {})
    user_flags["ocr_enabled"] = enabled
    save_user_feature_flags(flags)

def ocr_help_text(enabled: bool = False) -> str:
    status = "включена" if enabled else "выключена"
    return (
        f"OCR-версия сейчас: {status}.\n\n"
        "Команды:\n"
        "/ocr_on — включить OCR для твоего аккаунта.\n"
        "/ocr_off — вернуться в обычный режим.\n"
        "/ocr_status — проверить статус.\n"
        "/ocr_help — показать эту подсказку.\n\n"
        "Что умеет OCR-версия:\n"
        "1. Читать текст со скринов, фото документов и картинок-файлов.\n"
        "2. Собирать основу из фото + текста + голосовых в одном порядке.\n"
        "3. Делать по этой основе summary, красивое сообщение или промт для Codex.\n\n"
        "Как лучше отправлять:\n"
        "- для максимального качества отправляй фото как файл/document;\n"
        "- PDF max quality не сжимается и не запускает OCR;\n"
        "- OCR может ошибаться на мутных фото, бликах и мелком тексте;\n"
        f"- за один OCR-запуск лучше не больше {OCR_MAX_IMAGES_PER_ACTION} фото."
    )

# ============================ v3 "режим бога" ============================
def is_v3_enabled(user_id: int | None) -> bool:
    if user_id is None:
        return False
    flags = load_user_feature_flags()
    return bool(flags.get(str(user_id), {}).get("v3_enabled"))

def set_v3_enabled(user_id: int, enabled: bool) -> None:
    flags = load_user_feature_flags()
    user_flags = flags.setdefault(str(user_id), {})
    user_flags["v3_enabled"] = enabled
    save_user_feature_flags(flags)

def v3_is_god_user(user) -> bool:
    """Жёсткий гейт мощных функций. Если задан GOD_USER_ID — сверяем только по нему
    (id нельзя подделать через Bot API). Иначе fallback на username."""
    if user is None:
        return False
    if GOD_USER_ID:
        return user.id == GOD_USER_ID
    username = (getattr(user, "username", "") or "").lower()
    return bool(GOD_USERNAME and username == GOD_USERNAME)

def remember_context(user_id: int | None, text: str) -> None:
    if user_id is None:
        return
    text = (text or "").strip()
    if not text:
        return
    last_user_context[user_id] = text[:V3_CONTEXT_LIMIT]

def get_context(user_id: int | None) -> str:
    if user_id is None:
        return ""
    return last_user_context.get(user_id, "")

def v3_help_text() -> str:
    brain = "Claude" if ANTHROPIC_API_KEY else "Groq (Claude подключится, когда добавишь ANTHROPIC_API_KEY)"
    agent_state = "доступен" if ANTHROPIC_API_KEY else "нужен ANTHROPIC_API_KEY в Fly secrets"
    push_state = "доступен" if GITHUB_TOKEN else "нужен GITHUB_TOKEN в Fly secrets"
    god = str(GOD_USER_ID) if GOD_USER_ID else f"@{GOD_USERNAME} (по username — надёжнее задать GOD_USER_ID)"
    return (
        "Режим v3 — права бога только для тебя.\n\n"
        f"Мозг сейчас: {brain}.\n"
        f"Доступ: {god}.\n\n"
        "Команды:\n"
        "/v3_on — включить режим.\n"
        "/v3_off — выключить.\n"
        "/v3_status — статус.\n"
        "/myid — узнать свой Telegram id (для GOD_USER_ID).\n\n"
        "/ask <вопрос> — спросить нейронку по последней расшифровке/материалам "
        "(или ответом на сообщение — по нему). Работает уже сейчас.\n"
        f"/agent <задача> — Claude-агент в песочнице (bash + файлы). Сейчас: {agent_state}.\n"
        f"/self <инструкция> — Claude правит СВОЙ код, показывает diff и по кнопке "
        f"пушит в main; для прод-выката нужен Fly deploy/CI. push: {push_state}.\n\n"
        "После аудио/текста/фото/PDF бот даёт кнопки: 🧠 Summary и ссылки в "
        "ChatGPT/Grok с уже готовым сообщением по этому тексту. "
        "Ответь реплаем на сообщение бота — это вопрос к ИИ. В v3 любой текст = команда над текущим контентом. "
        "Понимает картинки (зрение) и PDF.\n\n"
        "Файлы: /pdf, /word, /pdf_prompt, /word_prompt.\n"
        "Память (второй мозг): /recall <запрос>, /memory, /forget.\n"
        "Напоминания: /remind <когда что>, /reminders. Часовой пояс: " + V3_TZ + ".\n"
        "Память и напоминания живут в SQLite state DB; для переживания передеплоя на Fly подключи volume /data.\n\n"
        "Если v3 выключен — бот работает как обычно."
    )

async def _v3_messages_create(client, base_kwargs: dict):
    """messages.create с adaptive thinking + effort; мягко деградирует, если SDK/модель их не принимает."""
    try:
        return await client.messages.create(
            **base_kwargs,
            thinking={"type": "adaptive"},
            output_config={"effort": ANTHROPIC_EFFORT},
        )
    except TypeError:
        return await client.messages.create(**base_kwargs)
    except Exception as e:
        marker = str(e).lower()
        if "thinking" in marker or "output_config" in marker or "effort" in marker:
            return await client.messages.create(**base_kwargs)
        raise

def _v3_anthropic_text(message) -> str:
    return "".join(b.text for b in message.content if getattr(b, "type", "") == "text").strip()

async def v3_anthropic_answer(question: str, context: str) -> str:
    from anthropic import AsyncAnthropic
    client = AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
    system = (
        "Ты — ассистент внутри Telegram-бота саммаризатора. Отвечай по-русски, "
        "кратко и по делу, plain text без Markdown."
    )
    user = question if not context else (
        f"Контекст (последняя расшифровка/материалы):\n{context[:V3_CONTEXT_LIMIT]}\n\nВопрос: {question}"
    )
    message = await _v3_messages_create(client, {
        "model": ANTHROPIC_MODEL,
        "max_tokens": 4000,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    })
    return _v3_anthropic_text(message)

async def v3_groq_answer(question: str, context: str) -> str:
    system = (
        "Ты — ассистент внутри Telegram-бота саммаризатора. Отвечай по-русски, "
        "кратко и по делу, plain text без Markdown."
    )
    user = question if not context else (
        f"Контекст (последняя расшифровка/материалы):\n{context[:V3_CONTEXT_LIMIT]}\n\nВопрос: {question}"
    )
    chat = await groq_client.chat.completions.create(
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        model=V3_GROQ_MODEL,
        temperature=0.3,
        max_tokens=1500,
    )
    return (chat.choices[0].message.content or "").strip()

async def v3_answer(question: str, context: str) -> str:
    if ANTHROPIC_API_KEY:
        try:
            return await v3_anthropic_answer(question, context)
        except Exception:
            logging.exception("v3 Anthropic answer failed, falling back to Groq")
    return await v3_groq_answer(question, context)

def v3_remember_turn(user_id: int, question: str, answer: str) -> None:
    history = v3_conversations.setdefault(user_id, [])
    history.append({"q": question[:1500], "a": answer[:2500]})
    if len(history) > V3_CONVO_TURNS:
        del history[: len(history) - V3_CONVO_TURNS]

def v3_conversation_context(user_id: int) -> str:
    history = v3_conversations.get(user_id) or []
    if not history:
        return ""
    lines = []
    for turn in history[-V3_CONVO_TURNS:]:
        lines.append(f"Пользователь: {turn['q']}")
        lines.append(f"Ты: {turn['a']}")
    return "Недавний диалог:\n" + "\n".join(lines)

async def v3_chat_answer(user_id: int, question: str, extra_context: str = "") -> str:
    parts = []
    convo = v3_conversation_context(user_id)
    if convo:
        parts.append(convo)
    mem = v3_memory_context(user_id, question)
    if mem:
        parts.append(mem)
    base = (extra_context or get_context(user_id) or "").strip()
    if base:
        parts.append("Материалы (расшифровка/контекст):\n" + base[:V3_CONTEXT_LIMIT])
    context = "\n\n".join(parts)
    answer = await v3_answer(question, context)
    v3_remember_turn(user_id, question, answer)
    v3_memory_add(user_id, "qa", f"Вопрос: {question}\nОтвет: {answer}")
    return answer

V3_SUMMARY_PROMPT = (
    "Сделай качественное summary этого аудио на русском, plain text без Markdown. "
    "Сначала 1-2 строки сути, затем ключевые пункты буллетами '- '. "
    "Если есть договорённости или решения — добавь их отдельно. "
    "Если есть конкретные задачи или поручения — добавь строку 'Задачи:' и перечисли их. "
    "Сохрани важные имена, числа, даты и суммы. Пиши только то, что реально есть в аудио, без выдумок."
)

V3_DEFAULT_SUGGESTIONS = [
    {"label": "✅ Задачи списком", "prompt": "Выпиши из аудио конкретные задачи и дела списком. Если задач нет — так и напиши."},
    {"label": "✍️ Черновик ответа", "prompt": "Напиши от первого лица черновик ответа/сообщения по сути этого аудио."},
    {"label": "🔑 Ключевые факты", "prompt": "Выпиши ключевые факты, имена, числа и даты из аудио списком."},
]

def _v3_parse_suggestions(text: str) -> list[dict]:
    raw = (text or "").strip()
    if "```" in raw:
        segments = raw.split("```")
        if len(segments) >= 3:
            raw = segments[1]
        if raw[:4].lower() == "json":
            raw = raw[4:]
        raw = raw.strip()
    start = raw.find("[")
    end = raw.rfind("]")
    if start != -1 and end != -1 and end > start:
        raw = raw[start:end + 1]
    try:
        data = json.loads(raw)
    except Exception:
        return list(V3_DEFAULT_SUGGESTIONS)
    out: list[dict] = []
    if isinstance(data, list):
        for item in data:
            if not isinstance(item, dict):
                continue
            label = str(item.get("label") or item.get("title") or "").strip()
            prompt = str(item.get("prompt") or item.get("action") or "").strip()
            if label and prompt:
                out.append({"label": label[:28], "prompt": prompt[:600]})
            if len(out) >= V3_MAX_SUGGESTIONS:
                break
    return out or list(V3_DEFAULT_SUGGESTIONS)

async def v3_generate_suggestions(transcript: str) -> list[dict]:
    instruction = (
        f"Прочитай расшифровку аудио и предложи до {V3_MAX_SUGGESTIONS} самых полезных "
        "действий по этому содержанию (например: написать ответ собеседнику, собрать чеклист "
        "задач, развернуть в план, выписать ключевые факты и цифры, найти решение). "
        "Не предлагай обычное summary или «краткую суть» — для этого есть отдельная кнопка. "
        "Подбирай под реальное содержание, не шаблонно. Верни ТОЛЬКО JSON-массив объектов вида "
        '{"label": "короткая надпись с эмодзи до 28 символов", "prompt": "что именно сделать с расшифровкой"}. '
        "Без пояснений и без Markdown — только JSON."
    )
    try:
        text = await v3_answer(instruction, transcript)
        return _v3_parse_suggestions(text)
    except Exception:
        logging.exception("v3 suggestions generation failed")
        return list(V3_DEFAULT_SUGGESTIONS)

def cleanup_v3_suggestions() -> None:
    now = time.time()
    for action_id in list(v3_suggestion_actions.keys()):
        item = v3_suggestion_actions.get(action_id) or {}
        if now - item.get("created_at", 0) > V3_SUGGESTIONS_TTL_SECONDS:
            v3_suggestion_actions.pop(action_id, None)

def store_v3_suggestions(user_id: int, transcript: str, suggestions: list[dict], images: list | None = None) -> str:
    cleanup_v3_suggestions()
    action_id = create_transcript_action_id(user_id, transcript)
    v3_suggestion_actions[action_id] = {
        "user_id": user_id,
        "transcript": transcript,
        "suggestions": suggestions,
        "images": list(images or []),
        "created_at": time.time(),
    }
    return action_id

def build_v3_suggestion_keyboard(action_id: str, suggestions: list[dict]) -> InlineKeyboardMarkup:
    rows = [[InlineKeyboardButton(text="🧠 Summary", callback_data=f"{V3_SUGGESTION_PREFIX}sum:{action_id}")]]
    rows += [
        [InlineKeyboardButton(text=s["label"][:30], callback_data=f"{V3_SUGGESTION_PREFIX}i{idx}:{action_id}")]
        for idx, s in enumerate(suggestions)
    ]
    rows.append([
        InlineKeyboardButton(text="💬 Спросить своё", callback_data=f"{V3_SUGGESTION_PREFIX}ask:{action_id}"),
        InlineKeyboardButton(text="🔁 Ещё идеи", callback_data=f"{V3_SUGGESTION_PREFIX}more:{action_id}"),
    ])
    return InlineKeyboardMarkup(inline_keyboard=rows)

def build_v3_followup_keyboard(action_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="🔁 Ещё идеи", callback_data=f"{V3_SUGGESTION_PREFIX}more:{action_id}"),
        InlineKeyboardButton(text="💬 Уточнить", callback_data=f"{V3_SUGGESTION_PREFIX}ask:{action_id}"),
    ]])

# ---- кнопки-ссылки в внешние ИИ (для v1 и v3) ----
AI_TARGETS = [
    ("⚪ ChatGPT", "https://chatgpt.com/?q={q}"),
    ("🚀 Grok", "https://grok.com/?q={q}"),
]
AI_LINK_URL_MAX = 4000

def ai_deeplink(url_template: str, text: str) -> str:
    body = " ".join((text or "").split())
    prefix = "Текст:\n"
    suffix = (
        "\n\nПредложи вопросы, которые стоит задать по этому тексту. "
        "Если ниже есть мой вопрос — ответь на него.\nМой вопрос: "
    )
    truncated = False
    while True:
        prompt = f"{prefix}{body}{'…' if truncated else ''}{suffix}"
        url = url_template.format(q=quote(prompt, safe=""))
        if len(url) <= AI_LINK_URL_MAX or len(body) <= 40:
            return url
        body = body[: int(len(body) * 0.8)]
        truncated = True

def build_ai_links_rows(text: str) -> list:
    if not (text or "").strip():
        return []
    buttons = [InlineKeyboardButton(text=label, url=ai_deeplink(tmpl, text)) for label, tmpl in AI_TARGETS]
    return [buttons[i:i + 2] for i in range(0, len(buttons), 2)]

def build_content_keyboard(user_id: int | None, text: str, base_markup: InlineKeyboardMarkup | None = None, images: list | None = None) -> InlineKeyboardMarkup | None:
    ai_rows = build_ai_links_rows(text)
    if is_v3_enabled(user_id):
        rows = []
        if (text or "").strip():
            action_id = store_v3_suggestions(user_id, text, [], images=images)
            rows.append([InlineKeyboardButton(text="🧠 Summary", callback_data=f"{V3_SUGGESTION_PREFIX}sum:{action_id}")])
        rows += ai_rows
        return InlineKeyboardMarkup(inline_keyboard=rows) if rows else None
    base_rows = list(base_markup.inline_keyboard) if base_markup else []
    summary_rows = [
        row for row in base_rows
        if any("summary" in (getattr(b, "callback_data", "") or "") for b in row)
    ]
    rows = summary_rows + ai_rows
    return InlineKeyboardMarkup(inline_keyboard=rows) if rows else None

async def offer_v3_suggestions(anchor_msg: Message, user_id: int, transcript: str) -> None:
    if not transcript.strip():
        return
    hint = await anchor_msg.answer("⏳ Подбираю идеи по аудио...")
    suggestions = await v3_generate_suggestions(transcript)
    action_id = store_v3_suggestions(user_id, transcript, suggestions)
    keyboard = build_v3_suggestion_keyboard(action_id, suggestions)
    v3_memory_add(user_id, "audio", transcript)
    with suppress(Exception):
        await hint.edit_text("🤖 Идеи по этому аудио (v3):", reply_markup=keyboard)

# ---- v3 второй мозг (память) ----
def v3_memory_add(user_id: int, kind: str, text: str) -> None:
    text = (text or "").strip()
    if not user_id or not text:
        return
    entry = {"user_id": user_id, "ts": time.time(), "kind": kind, "text": text[:4000]}
    try:
        V3_MEMORY_PATH.parent.mkdir(parents=True, exist_ok=True)
        with V3_MEMORY_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        _v3_memory_rotate()
    except Exception:
        logging.exception("v3 memory add failed")

def _v3_memory_rotate() -> None:
    try:
        lines = V3_MEMORY_PATH.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return
    except Exception:
        logging.exception("v3 memory rotate failed")
        return
    if len(lines) > V3_MEMORY_MAX_LINES:
        with suppress(Exception):
            V3_MEMORY_PATH.write_text("\n".join(lines[-V3_MEMORY_MAX_LINES:]) + "\n", encoding="utf-8")

def _v3_memory_load(user_id: int) -> list[dict]:
    try:
        lines = V3_MEMORY_PATH.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return []
    except Exception:
        return []
    out = []
    for line in lines:
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if isinstance(entry, dict) and entry.get("user_id") == user_id:
            out.append(entry)
    return out

def v3_memory_search(user_id: int, query: str, k: int = V3_MEMORY_TOPK) -> list[dict]:
    entries = _v3_memory_load(user_id)
    if not entries:
        return []
    q_words = {w for w in re.findall(r"\w+", (query or "").lower()) if len(w) > 2}
    scored = []
    total = len(entries)
    for i, entry in enumerate(entries):
        words = set(re.findall(r"\w+", entry.get("text", "").lower()))
        overlap = len(q_words & words)
        recency = i / max(total, 1)
        if overlap > 0 or not q_words:
            scored.append((overlap + recency * 0.5, entry))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [e for _, e in scored[:k]]

def v3_memory_context(user_id: int, query: str) -> str:
    hits = v3_memory_search(user_id, query)
    if not hits:
        return ""
    lines = []
    for entry in hits:
        when = datetime.fromtimestamp(entry.get("ts", 0)).strftime("%Y-%m-%d %H:%M")
        lines.append(f"[{when}] {entry.get('text', '')[:500]}")
    return "Из памяти (что присылал раньше):\n" + "\n".join(lines)

def v3_memory_clear(user_id: int) -> int:
    try:
        lines = V3_MEMORY_PATH.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return 0
    except Exception:
        return 0
    kept, removed = [], 0
    for line in lines:
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if isinstance(entry, dict) and entry.get("user_id") == user_id:
            removed += 1
        else:
            kept.append(line)
    with suppress(Exception):
        V3_MEMORY_PATH.write_text(("\n".join(kept) + "\n") if kept else "", encoding="utf-8")
    return removed

# ---- v3 зрение (картинки) ----
async def v3_vision_answer(image_urls: list, question: str, text_context: str = "") -> str:
    images = [u for u in (image_urls or []) if u][:V3_MAX_VISION_IMAGES]
    if not images:
        return await v3_answer(question, text_context)
    if ANTHROPIC_API_KEY:
        try:
            return await _v3_vision_anthropic(images, question, text_context)
        except Exception:
            logging.exception("v3 vision (anthropic) failed, fallback to groq")
    return await _v3_vision_groq(images, question, text_context)

async def _v3_vision_anthropic(images: list, question: str, text_context: str) -> str:
    from anthropic import AsyncAnthropic
    client = AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
    content = []
    for url in images:
        if url.startswith("data:") and ";base64," in url:
            header, b64 = url.split(";base64,", 1)
            media_type = header[len("data:"):] or "image/jpeg"
            content.append({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}})
    q = question if not text_context else f"{question}\n\nКонтекст:\n{text_context[:V3_CONTEXT_LIMIT]}"
    content.append({"type": "text", "text": q})
    message = await _v3_messages_create(client, {
        "model": ANTHROPIC_MODEL,
        "max_tokens": 4000,
        "system": "Ты — ассистент. Отвечай по-русски, кратко и по делу, plain text без Markdown.",
        "messages": [{"role": "user", "content": content}],
    })
    return _v3_anthropic_text(message)

async def _v3_vision_groq(images: list, question: str, text_context: str) -> str:
    q = question if not text_context else f"{question}\n\nКонтекст:\n{text_context[:V3_CONTEXT_LIMIT]}"
    content = [{"type": "text", "text": q}]
    for url in images:
        content.append({"type": "image_url", "image_url": {"url": url}})
    chat = await groq_client.chat.completions.create(
        messages=[{"role": "user", "content": content}],
        model=OCR_VISION_MODEL,
        temperature=0.3,
        max_tokens=1500,
    )
    return (chat.choices[0].message.content or "").strip()

# ---- v3 адаптивные действия по материалам/тексту/PDF ----
async def v3_collect_image_urls(items: list[dict], user_id: int) -> list:
    urls = []
    workdir = Path(TEMP_DIR) / f"v3img_{user_id}_{uuid.uuid4().hex[:8]}"
    workdir.mkdir(parents=True, exist_ok=True)
    try:
        idx = 0
        for item in items:
            if item.get("type") != "image":
                continue
            idx += 1
            if idx > V3_MAX_VISION_IMAGES:
                break
            try:
                path = await download_image_file_id(item["file_id"], item["file_ext"], workdir, idx)
                prepared = prepare_image_for_ocr(path, workdir)
                urls.append(image_data_url(prepared))
            except Exception:
                logging.exception("v3 image prep failed")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    return urls

async def v3_offer_for_material(anchor_msg: Message, user_id: int, items: list[dict]) -> None:
    hint = await anchor_msg.answer("⏳ Разбираю материалы...")
    text = ""
    try:
        text = await collect_material_text(items, hint, ocr_enabled=True, ocr_cache={})
    except Exception:
        logging.exception("v3 collect_material_text failed")
    images = await v3_collect_image_urls(items, user_id)
    last_user_images[user_id] = images
    if text.strip():
        remember_context(user_id, text)
        v3_memory_add(user_id, "material", text)
    basis = text.strip() or "Материал без распознанного текста."
    keyboard = build_content_keyboard(user_id, basis, None, images=images)
    with suppress(Exception):
        await hint.edit_text("🤖 Открыть в ИИ или сделать summary:", reply_markup=keyboard)

async def v3_offer_for_text(message: Message, user_id: int, text: str) -> None:
    keyboard = build_content_keyboard(user_id, text, None)
    with suppress(Exception):
        await message.answer("🤖 Открыть в ИИ или сделать summary:", reply_markup=keyboard)

def _v3_is_pdf(document) -> bool:
    if not document:
        return False
    if (getattr(document, "mime_type", "") or "").lower() == "application/pdf":
        return True
    return (getattr(document, "file_name", "") or "").lower().endswith(".pdf")

def _v3_pdf_text(path: Path, max_chars: int = 12000) -> str:
    from pypdf import PdfReader
    reader = PdfReader(str(path))
    parts = []
    for page in reader.pages:
        parts.append(page.extract_text() or "")
        if sum(len(p) for p in parts) > max_chars:
            break
    return "\n".join(parts)[:max_chars]

async def v3_handle_pdf(message: Message) -> None:
    document = message.document
    if document.file_size and document.file_size > TELEGRAM_MAX_DOWNLOAD_BYTES:
        await message.answer("❌ PDF слишком большой (лимит ~20 МБ).")
        return
    status = await message.answer("⏳ Читаю PDF...")
    workdir = Path(TEMP_DIR) / f"v3pdf_{message.from_user.id}_{uuid.uuid4().hex[:8]}"
    workdir.mkdir(parents=True, exist_ok=True)
    text = ""
    try:
        file = await bot.get_file(document.file_id)
        path = workdir / "doc.pdf"
        await bot.download_file(file.file_path, destination=path)
        text = _v3_pdf_text(path)
    except Exception as e:
        logging.exception("v3 pdf read failed")
        await status.edit_text(f"❌ Не смог прочитать PDF: {type(e).__name__}")
        shutil.rmtree(workdir, ignore_errors=True)
        return
    shutil.rmtree(workdir, ignore_errors=True)
    if not text.strip():
        await status.edit_text("В PDF не нашёл текста (возможно, это скан без распознавания).")
        return
    uid = message.from_user.id
    remember_context(uid, text)
    last_user_images.pop(uid, None)
    v3_memory_add(uid, "pdf", text)
    keyboard = build_content_keyboard(uid, text, None)
    with suppress(Exception):
        await status.edit_text("🤖 Открыть в ИИ или сделать summary:", reply_markup=keyboard)

async def v3_handle_text(message: Message) -> None:
    uid = message.from_user.id
    text = (message.text or "").strip()
    if not text:
        return
    if re.match(r"(?i)^(напомни|напоминание|remind|reminder)\b", text):
        await v3_create_reminder_from_text(message, text)
        return
    if len(text) > V3_TEXT_CONTENT_THRESHOLD or text.count("\n") >= 4:
        remember_context(uid, text)
        last_user_images.pop(uid, None)
        v3_memory_add(uid, "text", text)
        await v3_offer_for_text(message, uid, text)
        return
    status = await message.answer("🧠 думаю...")
    try:
        images = last_user_images.get(uid) or []
        if images:
            answer = await v3_vision_answer(images, text, get_context(uid))
            v3_remember_turn(uid, text, answer)
            v3_memory_add(uid, "qa", f"Вопрос: {text}\nОтвет: {answer}")
        else:
            answer = await v3_chat_answer(uid, text)
    except Exception as e:
        logging.exception("v3 text command failed")
        answer = f"❌ Ошибка: {type(e).__name__}: {e}"
    with suppress(Exception):
        await status.delete()
    for chunk in split_text(answer or "(пусто)"):
        await message.answer(chunk)

# ---- v3 напоминания ----
def v3_now() -> datetime:
    return datetime.now(zoneinfo.ZoneInfo(V3_TZ))

def v3_load_reminders() -> None:
    global v3_reminders
    state_reminders = state_get_json("v3_reminders")
    if isinstance(state_reminders, list):
        v3_reminders = [r for r in state_reminders if isinstance(r, dict)]
        return
    try:
        data = json.loads(V3_REMINDERS_PATH.read_text(encoding="utf-8"))
        v3_reminders = [r for r in data if isinstance(r, dict)] if isinstance(data, list) else []
    except FileNotFoundError:
        v3_reminders = []
    except Exception:
        logging.exception("v3 reminders load failed")
        v3_reminders = []

def v3_save_reminders() -> None:
    state_set_json("v3_reminders", v3_reminders)
    try:
        V3_REMINDERS_PATH.parent.mkdir(parents=True, exist_ok=True)
        V3_REMINDERS_PATH.write_text(json.dumps(v3_reminders, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        logging.exception("v3 reminders save failed")

def _v3_extract_json_obj(text: str):
    raw = (text or "").strip()
    if "```" in raw:
        segments = raw.split("```")
        if len(segments) >= 3:
            raw = segments[1]
        if raw[:4].lower() == "json":
            raw = raw[4:]
        raw = raw.strip()
    start = raw.find("{")
    end = raw.rfind("}")
    if start != -1 and end != -1 and end > start:
        raw = raw[start:end + 1]
    try:
        return json.loads(raw)
    except Exception:
        return None

async def v3_parse_reminder(text: str) -> dict | None:
    now = v3_now()
    instruction = (
        f"Сейчас {now.strftime('%Y-%m-%d %H:%M')} ({V3_TZ}). Пользователь просит напоминание. "
        'Верни ТОЛЬКО JSON {"datetime":"YYYY-MM-DD HH:MM","text":"о чём напомнить"} в этом часовом поясе. '
        'Если время не указано или непонятно — верни {"error":"no_time"}. Без пояснений и Markdown.'
    )
    try:
        raw = await v3_answer(instruction, text)
    except Exception:
        logging.exception("v3 reminder parse failed")
        return None
    data = _v3_extract_json_obj(raw)
    if not data or not data.get("datetime"):
        return None
    try:
        naive = datetime.strptime(str(data["datetime"]), "%Y-%m-%d %H:%M")
        due = naive.replace(tzinfo=zoneinfo.ZoneInfo(V3_TZ))
    except Exception:
        return None
    return {
        "due_iso": due.isoformat(),
        "text": (str(data.get("text") or text)).strip()[:500],
        "due_human": due.strftime("%d.%m %H:%M"),
    }

def v3_add_reminder(user_id: int, due_iso: str, text: str) -> str:
    rid = uuid.uuid4().hex[:8]
    v3_reminders.append({"id": rid, "user_id": user_id, "due_iso": due_iso, "text": text, "created_at": time.time()})
    v3_save_reminders()
    return rid

def _v3_reminder_due(reminder: dict, now: datetime) -> bool:
    try:
        return datetime.fromisoformat(reminder["due_iso"]) <= now
    except Exception:
        return False

async def v3_reminder_loop() -> None:
    while True:
        try:
            await asyncio.sleep(V3_REMINDER_POLL_SECONDS)
            now = v3_now()
            due = [r for r in v3_reminders if _v3_reminder_due(r, now)]
            for reminder in due:
                with suppress(Exception):
                    await bot.send_message(reminder["user_id"], f"⏰ Напоминание: {reminder.get('text', '')}")
                with suppress(ValueError):
                    v3_reminders.remove(reminder)
            if due:
                v3_save_reminders()
        except asyncio.CancelledError:
            return
        except Exception:
            logging.exception("v3 reminder loop error")

async def v3_create_reminder_from_text(message: Message, text: str) -> None:
    status = await message.answer("⏳ Ставлю напоминание...")
    parsed = await v3_parse_reminder(text)
    if not parsed:
        await status.edit_text("Не понял время. Пример: «напомни завтра в 10 позвонить врачу».")
        return
    v3_add_reminder(message.from_user.id, parsed["due_iso"], parsed["text"])
    await status.edit_text(f"⏰ Напомню {parsed['due_human']}: {parsed['text']}")

V3_AGENT_TOOLS = [
    {
        "name": "bash",
        "description": "Выполнить bash-команду в рабочей папке песочницы и вернуть stdout+stderr.",
        "input_schema": {
            "type": "object",
            "properties": {"command": {"type": "string", "description": "Команда bash"}},
            "required": ["command"],
        },
    },
    {
        "name": "read_file",
        "description": "Прочитать текстовый UTF-8 файл по пути относительно рабочей папки.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Создать или перезаписать текстовый UTF-8 файл по пути относительно рабочей папки.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
        },
    },
    {
        "name": "list_dir",
        "description": "Показать содержимое папки относительно рабочей папки.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": [],
        },
    },
]

def _v3_resolve(workdir: Path, rel: str) -> Path:
    base = workdir.resolve()
    target = (base / (rel or ".")).resolve()
    if target != base and base not in target.parents:
        raise ValueError("путь выходит за пределы песочницы")
    return target

def _v3_exec_tool(name: str, tool_input: dict, workdir: Path) -> str:
    try:
        if name == "bash":
            command = str((tool_input or {}).get("command", "")).strip()
            if not command:
                return "[error] пустая команда"
            result = subprocess.run(
                command, shell=True, cwd=str(workdir),
                capture_output=True, text=True, timeout=V3_BASH_TIMEOUT_SECONDS,
            )
            body = result.stdout or ""
            if result.stderr:
                body += f"\n[stderr]\n{result.stderr}"
            return f"[exit {result.returncode}]\n{body}"[:V3_TOOL_OUTPUT_LIMIT]
        if name == "read_file":
            target = _v3_resolve(workdir, str((tool_input or {}).get("path", "")))
            return target.read_text(encoding="utf-8", errors="replace")[:V3_TOOL_OUTPUT_LIMIT]
        if name == "write_file":
            target = _v3_resolve(workdir, str((tool_input or {}).get("path", "")))
            content = str((tool_input or {}).get("content", ""))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            return f"записано: {target.relative_to(workdir.resolve())} ({len(content)} символов)"
        if name == "list_dir":
            target = _v3_resolve(workdir, str((tool_input or {}).get("path", ".")))
            entries = sorted(os.listdir(target))
            return ("\n".join(entries) or "(пусто)")[:V3_TOOL_OUTPUT_LIMIT]
        return f"[error] неизвестный инструмент {name}"
    except subprocess.TimeoutExpired:
        return f"[timeout] команда не завершилась за {V3_BASH_TIMEOUT_SECONDS}с"
    except Exception as e:
        return f"[error] {type(e).__name__}: {e}"

async def run_v3_agent(task: str, workdir: Path, system: str, max_turns: int = V3_AGENT_MAX_TURNS, progress=None) -> dict:
    from anthropic import AsyncAnthropic
    client = AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
    messages = [{"role": "user", "content": task}]
    transcript: list[tuple] = []
    final_text = ""
    used_turns = 0
    for turn in range(max_turns):
        used_turns = turn + 1
        response = await _v3_messages_create(client, {
            "model": ANTHROPIC_MODEL,
            "max_tokens": V3_AGENT_MAX_TOKENS,
            "system": system,
            "tools": V3_AGENT_TOOLS,
            "messages": messages,
        })
        messages.append({"role": "assistant", "content": response.content})
        text_parts = [b.text for b in response.content if getattr(b, "type", "") == "text"]
        if text_parts:
            final_text = "\n".join(part for part in text_parts if part).strip()
        tool_uses = [b for b in response.content if getattr(b, "type", "") == "tool_use"]
        if response.stop_reason != "tool_use" or not tool_uses:
            break
        results = []
        for tu in tool_uses:
            output = await asyncio.to_thread(_v3_exec_tool, tu.name, dict(tu.input or {}), workdir)
            transcript.append((tu.name, tu.input, output))
            if progress is not None:
                with suppress(Exception):
                    await progress(tu.name, tu.input, output)
            results.append({"type": "tool_result", "tool_use_id": tu.id, "content": output or "(нет вывода)"})
        messages.append({"role": "user", "content": results})
    return {"text": final_text, "transcript": transcript, "turns": used_turns}

def _v3_tool_preview(tool_input) -> str:
    data = tool_input or {}
    if isinstance(data, dict):
        snippet = data.get("command") or data.get("path") or json.dumps(data, ensure_ascii=False)
    else:
        snippet = str(data)
    return " ".join(str(snippet).split())[:90]

def _v3_git_remote_url(with_token: bool = False) -> str:
    if with_token and GITHUB_TOKEN:
        return f"https://x-access-token:{GITHUB_TOKEN}@github.com/{GITHUB_REPO}.git"
    return f"https://github.com/{GITHUB_REPO}.git"

def v3_clone_repo() -> Path:
    V3_SELF_WORK_ROOT.mkdir(parents=True, exist_ok=True)
    workdir = V3_SELF_WORK_ROOT / uuid.uuid4().hex
    url = _v3_git_remote_url(with_token=bool(GITHUB_TOKEN))
    subprocess.run(
        ["git", "clone", "--depth", "1", url, str(workdir)],
        check=True, capture_output=True, text=True, timeout=180,
    )
    subprocess.run(["git", "-C", str(workdir), "config", "user.name", GIT_AUTHOR_NAME], check=True, capture_output=True, text=True)
    subprocess.run(["git", "-C", str(workdir), "config", "user.email", GIT_AUTHOR_EMAIL], check=True, capture_output=True, text=True)
    return workdir

def v3_git_diff(workdir: Path) -> str:
    stat = subprocess.run(
        ["git", "-C", str(workdir), "diff", "--stat"],
        capture_output=True, text=True, timeout=30,
    ).stdout or ""
    full = subprocess.run(
        ["git", "-C", str(workdir), "diff"],
        capture_output=True, text=True, timeout=30,
    ).stdout or ""
    return (stat + "\n" + full).strip()

def v3_push_self(workdir: Path, commit_message: str) -> str:
    subprocess.run(["git", "-C", str(workdir), "remote", "set-url", "origin", _v3_git_remote_url(with_token=True)], check=True, capture_output=True, text=True)
    subprocess.run(["git", "-C", str(workdir), "add", "-A"], check=True, capture_output=True, text=True)
    subprocess.run(["git", "-C", str(workdir), "commit", "-m", commit_message], check=True, capture_output=True, text=True)
    result = subprocess.run(
        ["git", "-C", str(workdir), "push", "origin", "HEAD:main"],
        check=True, capture_output=True, text=True, timeout=120,
    )
    return ((result.stdout or "") + (result.stderr or "")).strip() or "pushed"

def cleanup_self_edit_sessions() -> None:
    now = time.time()
    for sid in list(self_edit_sessions.keys()):
        session = self_edit_sessions.get(sid) or {}
        if now - session.get("created_at", 0) > V3_SELF_SESSION_TTL_SECONDS:
            with suppress(Exception):
                shutil.rmtree(session.get("workdir", ""), ignore_errors=True)
            self_edit_sessions.pop(sid, None)
# ========================== /v3 "режим бога" ==========================

def clean_material_text_value(value: object, limit: int = 6000) -> str:
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = [" ".join(line.split()) for line in text.splitlines()]
    cleaned = "\n".join(line for line in lines if line).strip()
    return cleaned[:limit]

def cleanup_material_actions() -> None:
    now = time.time()
    expired_ids = [
        action_id
        for action_id, item in material_actions.items()
        if now - item["created_at"] > MATERIAL_ACTION_TTL_SECONDS
    ]
    for action_id in expired_ids:
        material_actions.pop(action_id, None)
        state_delete(f"material_action:{action_id}")

    for key in state_keys_with_prefix("material_action:"):
        action_id = key.split(":", 1)[1]
        if action_id in material_actions:
            continue
        item = state_get_json(key)
        if not isinstance(item, dict) or now - float(item.get("created_at") or 0) > MATERIAL_ACTION_TTL_SECONDS:
            state_delete(key)

def persist_material_action(action_id: str, item: dict) -> None:
    state_set_json(f"material_action:{action_id}", item)

def load_material_action(action_id: str) -> dict | None:
    item = material_actions.get(action_id)
    if item:
        return item
    item = state_get_json(f"material_action:{action_id}")
    if not isinstance(item, dict):
        return None
    if time.time() - float(item.get("created_at") or 0) > MATERIAL_ACTION_TTL_SECONDS:
        state_delete(f"material_action:{action_id}")
        return None
    material_actions[action_id] = item
    return item

def create_material_action_id(user_id: int, items: list[dict]) -> str:
    payload = json.dumps(items, ensure_ascii=False, sort_keys=True)
    seed = f"{user_id}:{time.time()}:{hashlib.sha256(payload.encode('utf-8')).hexdigest()}".encode("utf-8")
    return hashlib.sha256(seed).hexdigest()[:16]

def material_items_from_messages(messages: list[Message]) -> list[dict]:
    items: list[dict] = []
    for message in messages:
        plain_text = get_message_plain_text(message)
        caption = get_message_caption(message)

        if plain_text:
            items.append({"type": "text", "text": plain_text})

        if is_image_message(message):
            image_info = get_image_file_id_and_ext(message)
            if image_info:
                file_id, file_ext = image_info
                items.append(
                    {
                        "type": "image",
                        "file_id": file_id,
                        "file_ext": file_ext,
                        "caption": caption,
                    }
                )
            continue

        if is_audio_media_message(message):
            media_info = get_media_file_id_and_ext(message)
            if media_info:
                file_id, file_ext = media_info
                items.append(
                    {
                        "type": "audio",
                        "file_id": file_id,
                        "file_ext": file_ext,
                        "caption": caption,
                    }
                )

    return items

def count_material_items(items: list[dict]) -> dict[str, int]:
    counts = {"images": 0, "audio": 0, "text": 0}
    for item in items:
        item_type = item.get("type")
        if item_type == "image":
            counts["images"] += 1
            if clean_material_text_value(item.get("caption"), 3000):
                counts["text"] += 1
        elif item_type == "audio":
            counts["audio"] += 1
            if clean_material_text_value(item.get("caption"), 3000):
                counts["text"] += 1
        elif item_type == "text":
            counts["text"] += 1
    return counts

def format_material_counts(items: list[dict]) -> str:
    counts = count_material_items(items)
    return f"фото {counts['images']}, аудио {counts['audio']}, текст {counts['text']}"

def has_transformable_material_text(items: list[dict], ocr_enabled: bool = False) -> bool:
    for item in items:
        if item.get("type") == "text" and clean_material_text_value(item.get("text"), 3000):
            return True
        if item.get("type") in {"image", "audio"} and clean_material_text_value(item.get("caption"), 3000):
            return True
        if item.get("type") == "audio":
            return True
        if ocr_enabled and item.get("type") == "image":
            return True
    return False

def build_material_action_keyboard(action_id: str, ocr_enabled: bool = False) -> InlineKeyboardMarkup:
    text_button_label = "📝 Собрать текст + OCR" if ocr_enabled else "📝 Расшифровать / собрать текст"
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="📄 Сделать PDF max quality",
                    callback_data=f"{MATERIAL_ACTION_PREFIX}pdf:{action_id}",
                )
            ],
            [
                InlineKeyboardButton(
                    text=text_button_label,
                    callback_data=f"{MATERIAL_ACTION_PREFIX}text:{action_id}",
                )
            ],
            [
                InlineKeyboardButton(
                    text="📄 Текст в PDF",
                    callback_data=f"{MATERIAL_ACTION_PREFIX}text_pdf:{action_id}",
                )
            ],
            [
                InlineKeyboardButton(
                    text="📝 Word (.docx)",
                    callback_data=f"{MATERIAL_ACTION_PREFIX}word:{action_id}",
                )
            ],
            [
                InlineKeyboardButton(
                    text="🧠 Сделать summary",
                    callback_data=f"{MATERIAL_ACTION_PREFIX}summary:{action_id}",
                )
            ],
            [
                InlineKeyboardButton(
                    text="✍️ Оформить сообщение",
                    callback_data=f"{MATERIAL_ACTION_PREFIX}message:{action_id}",
                )
            ],
            [
                InlineKeyboardButton(
                    text="💻 Промт для Codex",
                    callback_data=f"{MATERIAL_ACTION_PREFIX}codex:{action_id}",
                )
            ],
            [
                InlineKeyboardButton(
                    text="❌ Отменить",
                    callback_data=f"{MATERIAL_ACTION_PREFIX}cancel:{action_id}",
                )
            ],
        ]
    )

def store_material_action(
    user_id: int | None,
    chat_id: int | str,
    items: list[dict],
    ocr_enabled: bool = False,
) -> tuple[str, InlineKeyboardMarkup] | None:
    if user_id is None or not items:
        return None
    cleanup_material_actions()
    action_id = create_material_action_id(user_id, items)
    material_actions[action_id] = {
        "user_id": user_id,
        "chat_id": str(chat_id),
        "items": items,
        "ocr_enabled": ocr_enabled,
        "ocr_cache": {},
        "created_at": time.time(),
    }
    persist_material_action(action_id, material_actions[action_id])
    remember_context(
        user_id,
        "\n".join(str(it.get("text", "")) for it in items if isinstance(it, dict) and it.get("text")),
    )
    return action_id, build_material_action_keyboard(action_id, ocr_enabled)

def cleanup_feedback_sessions() -> None:
    now = time.time()
    expired_ids = [
        user_id
        for user_id, item in feedback_sessions.items()
        if now - item["created_at"] > FEEDBACK_SESSION_TTL_SECONDS
    ]
    for user_id in expired_ids:
        feedback_sessions.pop(user_id, None)

def build_start_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="💬 Оставить обратную связь",
                    callback_data=f"{FEEDBACK_CALLBACK_PREFIX}start",
                )
            ]
        ]
    )

def start_feedback_session(user_id: int) -> None:
    cleanup_feedback_sessions()
    feedback_sessions[user_id] = {"created_at": time.time()}

def has_active_feedback_session(user_id: int) -> bool:
    cleanup_feedback_sessions()
    return user_id in feedback_sessions

def clean_lead_value(value: object, limit: int = 600) -> str:
    cleaned = " ".join(str(value or "").split())
    return cleaned[:limit]

def get_leads_chat_id() -> str:
    if LEADS_CHAT_ID:
        return str(LEADS_CHAT_ID)
    state_chat_id = state_get_text("leads_chat_id")
    if state_chat_id:
        return state_chat_id.strip()
    try:
        return LEADS_CHAT_ID_PATH.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""
    except Exception:
        logging.exception("Failed to read leads chat id")
        return ""

def save_leads_chat_id(chat_id: int | str) -> None:
    state_set_text("leads_chat_id", str(chat_id).strip())
    LEADS_CHAT_ID_PATH.write_text(str(chat_id).strip(), encoding="utf-8")

def append_pending_lead(payload: dict) -> None:
    if state_queue_append("pending_leads", payload):
        return
    with PENDING_LEADS_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")

def take_pending_leads() -> list[dict]:
    leads = state_queue_take("pending_leads")
    if PENDING_LEADS_PATH.exists():
        for line in PENDING_LEADS_PATH.read_text(encoding="utf-8").splitlines():
            try:
                payload = json.loads(line)
            except Exception:
                continue
            if isinstance(payload, dict):
                leads.append(payload)
        PENDING_LEADS_PATH.unlink(missing_ok=True)
    return leads

def pending_leads_count() -> int:
    count = state_queue_count("pending_leads")
    if PENDING_LEADS_PATH.exists():
        count += sum(1 for line in PENDING_LEADS_PATH.read_text(encoding="utf-8").splitlines() if line.strip())
    return count

async def flush_pending_leads(chat_id: int | str) -> int:
    sent_count = 0
    unsent: list[dict] = []
    for payload in take_pending_leads():
        try:
            await bot.send_message(
                chat_id=chat_id,
                text=format_lead_message(payload),
                disable_web_page_preview=True,
            )
            sent_count += 1
        except Exception:
            logging.exception("Failed to flush pending lead")
            unsent.append(payload)

    for payload in unsent:
        append_pending_lead(payload)
    return sent_count

def is_lead_admin(message: Message) -> bool:
    if not LEAD_ADMIN_USERNAMES:
        return True
    username = (message.from_user.username if message.from_user else "") or ""
    return username.lower() in LEAD_ADMIN_USERNAMES

def whatsapp_link_from_phone(phone: str) -> str:
    digits = re.sub(r"\D", "", phone)
    if len(digits) == 10:
        digits = f"7{digits}"
    elif len(digits) == 11 and digits.startswith("8"):
        digits = f"7{digits[1:]}"
    if len(digits) < 10:
        return ""
    return f"https://wa.me/{digits}"

def format_lead_message(payload: dict) -> str:
    site = clean_lead_value(payload.get("site") or "site", 80)
    title = clean_lead_value(payload.get("title") or "Новая заявка", 100)
    name = clean_lead_value(payload.get("name"), 120)
    phone = clean_lead_value(payload.get("phone") or payload.get("whatsapp"), 80)
    message = clean_lead_value(payload.get("message") or payload.get("comment") or payload.get("problem"), 1200)
    page = clean_lead_value(payload.get("page"), 300)
    attribution = clean_lead_value(payload.get("attribution"), 500)
    fields = payload.get("fields") if isinstance(payload.get("fields"), dict) else {}

    lines = [f"Новая заявка: {title}", "", f"Сайт: {site}"]
    if name:
        lines.append(f"Имя: {name}")
    if phone:
        lines.append(f"Телефон: {phone}")
        whatsapp_link = whatsapp_link_from_phone(phone)
        if whatsapp_link:
            lines.append(f"WhatsApp: {whatsapp_link}")
    if message:
        lines.extend(["", f"Сообщение: {message}"])

    for key, value in fields.items():
        cleaned_key = clean_lead_value(key, 60)
        cleaned_value = clean_lead_value(value, 240)
        if cleaned_key and cleaned_value:
            lines.append(f"{cleaned_key}: {cleaned_value}")

    if page:
        lines.extend(["", f"Страница: {page}"])
    if attribution:
        lines.append(f"Источник: {attribution}")

    return "\n".join(lines)

async def send_feedback_to_admin(message: Message) -> bool:
    feedback_text = clean_lead_value(message.text, 3000)
    if not feedback_text:
        raise UserVisibleError("❌ Не вижу текста обратной связи. Напиши одним сообщением, что улучшить.")

    user = message.from_user
    username = f"@{user.username}" if user and user.username else ""
    user_name = clean_lead_value(user.full_name if user else "", 120)
    payload = {
        "site": "tg-transcriber-bot",
        "title": "Обратная связь по боту",
        "name": user_name,
        "message": feedback_text,
        "fields": {
            "Telegram": username or "без username",
            "User ID": str(user.id) if user else "",
            "Chat ID": str(message.chat.id),
            "Кому": "@denrech",
        },
        "page": "Telegram bot",
    }

    leads_chat_id = get_leads_chat_id()
    if not leads_chat_id:
        append_pending_lead(payload)
        logging.warning("Feedback queued because leads chat id is missing")
        return False

    try:
        await bot.send_message(
            chat_id=leads_chat_id,
            text=format_lead_message(payload),
            disable_web_page_preview=True,
        )
        return True
    except Exception:
        logging.exception("Failed to send feedback")
        append_pending_lead(payload)
        return False

def validate_lead_payload(payload: dict) -> str | None:
    phone = clean_lead_value(payload.get("phone") or payload.get("whatsapp"), 80)
    message = clean_lead_value(payload.get("message") or payload.get("comment") or payload.get("problem"), 1200)
    if phone.replace(" ", "").replace("-", "").replace("(", "").replace(")", "").replace("+", "").isdigit():
        if len(re.sub(r"\D", "", phone)) >= 7:
            return None
    if message:
        return None
    return "lead_requires_phone_or_message"

def profile_note_key(message: Message) -> str | None:
    if not message.from_user:
        return None
    username = (message.from_user.username or "").strip().lower()
    if username:
        return f"@{username}"
    return f"id:{message.from_user.id}"

def read_profile_notes_file(path: Path) -> dict[str, list[dict]]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception:
        logging.exception("Failed to read profile notes file: %s", path)
        return {}

    if not isinstance(raw, dict):
        return {}

    notes: dict[str, list[dict]] = {}
    for key, value in raw.items():
        if not isinstance(key, str) or not isinstance(value, list):
            continue
        cleaned_notes: list[dict] = []
        for item in value:
            if isinstance(item, str):
                text = clean_lead_value(item, 3000)
                if text:
                    cleaned_notes.append({"text": text, "created_at": ""})
            elif isinstance(item, dict):
                text = clean_lead_value(item.get("text"), 3000)
                if text:
                    cleaned_notes.append({
                        "text": text,
                        "created_at": clean_lead_value(item.get("created_at"), 60),
                    })
        if cleaned_notes:
            notes[key.lower()] = cleaned_notes
    return notes

def load_profile_notes() -> dict[str, list[dict]]:
    notes = read_profile_notes_file(PROFILE_NOTES_SEED_PATH)
    runtime_notes = read_profile_notes_file(PROFILE_NOTES_PATH)
    state_notes = state_get_json("profile_notes", {})
    if isinstance(state_notes, dict):
        runtime_notes.update(state_notes)
    for key, items in runtime_notes.items():
        existing_texts = {item["text"] for item in notes.get(key, [])}
        notes.setdefault(key, [])
        for item in items:
            if item["text"] not in existing_texts:
                notes[key].append(item)
                existing_texts.add(item["text"])
    return notes

def save_profile_notes(notes: dict[str, list[dict]]) -> None:
    state_set_json("profile_notes", notes)
    PROFILE_NOTES_PATH.parent.mkdir(parents=True, exist_ok=True)
    PROFILE_NOTES_PATH.write_text(
        json.dumps(notes, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

def add_profile_note(key: str, text: str) -> int:
    notes = load_profile_notes()
    note = {
        "text": clean_lead_value(text, 3000),
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
    }
    notes.setdefault(key, []).append(note)
    save_profile_notes(notes)
    return len(notes[key])

def clear_profile_notes(key: str) -> None:
    notes = load_profile_notes()
    notes[key] = []
    save_profile_notes(notes)

def format_profile_notes_pages(key: str, notes: list[dict]) -> list[str]:
    if not notes:
        return [(
            "Заметок пока нет.\n"
            "Чтобы сохранить заметку, отправь:\n"
            "/keep текст заметки"
        )]

    pages: list[str] = []
    lines = [f"Заметки профиля {key}: всего {len(notes)}"]
    for index, note in enumerate(notes, start=1):
        created_at = clean_lead_value(note.get("created_at"), 60)
        suffix = f" ({created_at})" if created_at else ""
        line = f"{index}. {note['text']}{suffix}"
        candidate = "\n".join([*lines, line])
        if len(candidate) > SAFE_MESSAGE_LIMIT and len(lines) > 1:
            pages.append("\n".join(lines))
            lines = [f"Заметки профиля {key} (продолжение):", line]
        else:
            lines.append(line)
    if lines:
        pages.append("\n".join(lines))
    return pages

def format_profile_notes(key: str, notes: list[dict]) -> str:
    return format_profile_notes_pages(key, notes)[0]

def has_explicit_task_request(text: str) -> bool:
    """Detect whether the original text really contains an explicit task/request."""
    lowered = text.lower()
    task_markers = (
        "надо",
        "нужно",
        "необходимо",
        "следует",
        "задача",
        "задачи",
        "сделай",
        "сделайте",
        "проверь",
        "проверьте",
        "исправь",
        "исправьте",
        "добавь",
        "добавьте",
        "запусти",
        "запустите",
        "отправь",
        "отправьте",
        "подготовь",
        "подготовьте",
    )
    return any(marker in lowered for marker in task_markers)

def clean_summary(summary: str, source_text: str = "") -> str:
    """Remove low-value boilerplate the model may still produce."""
    cleaned_lines = []
    allow_task_line = has_explicit_task_request(source_text)

    for line in summary.splitlines():
        stripped = line.strip().strip("*")
        lowered = stripped.lower()

        if not stripped:
            continue
        if lowered.startswith("задачи:") and not allow_task_line:
            continue
        if lowered.startswith("задачи:") and any(word in lowered for word in ("нет", "отсутств", "не указ")):
            continue
        if lowered in {"задач нет", "нет задач", "summary не требуется"}:
            continue

        cleaned_lines.append(stripped)

    cleaned_summary = "\n".join(cleaned_lines).strip()
    if cleaned_summary:
        return cleaned_summary

    fallback = " ".join(source_text.split()).strip()
    if not fallback:
        return "Короткое сообщение."
    return fallback[:160].rstrip()

def clean_generated_text(text: str, source_text: str = "") -> str:
    """Clean generic mode output while preserving useful structure."""
    cleaned_lines = []
    for line in text.splitlines():
        stripped = line.strip().strip("*")
        if stripped:
            cleaned_lines.append(stripped)

    cleaned_text = "\n".join(cleaned_lines).strip()
    if cleaned_text:
        return cleaned_text

    fallback = " ".join(source_text.split()).strip()
    return fallback or "Короткое сообщение."

def split_text(text: str, limit: int = SAFE_MESSAGE_LIMIT) -> list[str]:
    """Split long Telegram messages without breaking words when possible."""
    chunks = []
    remaining = text

    while len(remaining) > limit:
        split_at = remaining.rfind("\n", 0, limit)
        if split_at < limit // 2:
            split_at = remaining.rfind(" ", 0, limit)
        if split_at < limit // 2:
            split_at = limit

        chunks.append(remaining[:split_at].strip())
        remaining = remaining[split_at:].strip()

    if remaining:
        chunks.append(remaining)

    return chunks

async def deliver_result(status_msg: Message, text: str, reply_markup: InlineKeyboardMarkup | None = None) -> None:
    """Deliver an AI-generated result via Rich Message (Bot API 10.1) with real markdown
    rendering, collapsing the status line to a short checkmark. Falls back to the old
    plain-text chunked edit+answer if the rich call fails for any reason — this
    feature is new, never let it take the whole result down with it."""
    if not text.strip():
        await status_msg.edit_text("❌ Не получилось отправить результат.")
        return
    try:
        await bot.send_rich_message(
            status_msg.chat.id,
            InputRichMessage(markdown=text[:32000]),
            reply_markup=reply_markup,
        )
        with suppress(Exception):
            await status_msg.edit_text("✅ Готово")
        return
    except Exception:
        logging.exception("send_rich_message failed, falling back to plain chunks")

    chunks = split_text(text)
    if not chunks:
        await status_msg.edit_text("❌ Не получилось отправить результат.")
        return
    if len(chunks) == 1:
        await status_msg.edit_text(chunks[0], reply_markup=reply_markup)
        return
    await status_msg.edit_text(chunks[0])
    for index, chunk in enumerate(chunks[1:], start=1):
        await status_msg.answer(
            chunk,
            reply_markup=reply_markup if index == len(chunks) - 1 else None,
        )

def shorten(text: str, limit: int) -> str:
    """Shorten text for Telegram inline result previews."""
    stripped = " ".join(text.split())
    if len(stripped) <= limit:
        return stripped
    return f"{stripped[:limit - 1].rstrip()}…"

def inline_result_id(text: str) -> str:
    """Build a stable Telegram-safe inline result id."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]

def is_youtube_url(url: str) -> bool:
    host = urlparse(url).netloc.lower().removeprefix("www.")
    return host in {
        "youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "youtu.be",
    }

def extract_youtube_url(text: str | None) -> str | None:
    if not text:
        return None
    for match in YOUTUBE_URL_RE.finditer(text):
        url = match.group(0).rstrip(".,!?)\"]'")
        if is_youtube_url(url):
            return url
    return None

def media_batch_key(message: Message) -> str:
    user_id = message.from_user.id if message.from_user else 0
    return f"{message.chat.id}:{user_id}"

def get_media_batch_lock(key: str) -> asyncio.Lock:
    lock = media_batch_locks.get(key)
    if not lock:
        lock = asyncio.Lock()
        media_batch_locks[key] = lock
    return lock

def get_content_batch_lock(key: str) -> asyncio.Lock:
    lock = content_batch_locks.get(key)
    if not lock:
        lock = asyncio.Lock()
        content_batch_locks[key] = lock
    return lock

IMAGE_DOCUMENT_EXTENSIONS = {".jpg", ".jpeg", ".png", ".heic", ".heif"}
IMAGE_DOCUMENT_MIME_TYPES = {"image/jpeg", "image/png", "image/heic", "image/heif"}
MEDIA_DOCUMENT_EXTENSIONS = {
    ".aac",
    ".flac",
    ".m4a",
    ".m4v",
    ".mkv",
    ".mov",
    ".mpeg",
    ".mpg",
    ".mp3",
    ".mp4",
    ".oga",
    ".ogg",
    ".opus",
    ".wav",
    ".webm",
    ".3gp",
    ".3gpp",
}
MEDIA_MIME_EXTENSION_MAP = {
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/m4a": ".m4a",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/ogg": ".ogg",
    "audio/opus": ".opus",
    "audio/wav": ".wav",
    "audio/wave": ".wav",
    "audio/webm": ".webm",
    "audio/x-m4a": ".m4a",
    "audio/x-wav": ".wav",
    "video/3gpp": ".3gp",
    "video/mp4": ".mp4",
    "video/mpeg": ".mpeg",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-m4v": ".m4v",
    "video/x-matroska": ".mkv",
}

def is_audio_media_message(message: Message) -> bool:
    return bool(message.voice or message.audio or message.video_note or message.video or is_media_document_message(message))

def is_image_document_message(message: Message) -> bool:
    document = message.document
    if not document:
        return False
    mime_type = (document.mime_type or "").lower()
    file_ext = Path(document.file_name or "").suffix.lower()
    return mime_type in IMAGE_DOCUMENT_MIME_TYPES or file_ext in IMAGE_DOCUMENT_EXTENSIONS

def is_media_document_message(message: Message) -> bool:
    document = message.document
    if not document:
        return False
    mime_type = (document.mime_type or "").lower()
    file_ext = Path(document.file_name or "").suffix.lower()
    return mime_type.startswith(("audio/", "video/")) or file_ext in MEDIA_DOCUMENT_EXTENSIONS

def media_extension_from_name_or_mime(
    file_name: str | None,
    mime_type: str | None,
    default_ext: str,
) -> str:
    file_ext = Path(file_name or "").suffix.lower()
    if file_ext in MEDIA_DOCUMENT_EXTENSIONS:
        return file_ext

    mime_type = (mime_type or "").lower()
    mapped_ext = MEDIA_MIME_EXTENSION_MAP.get(mime_type)
    if mapped_ext:
        return mapped_ext

    guessed_ext = mimetypes.guess_extension(mime_type or "")
    if guessed_ext:
        guessed_ext = guessed_ext.lower()
        if guessed_ext in MEDIA_DOCUMENT_EXTENSIONS:
            return guessed_ext

    return default_ext

def is_image_message(message: Message) -> bool:
    return bool(message.photo or is_image_document_message(message))

def get_message_plain_text(message: Message) -> str:
    return (message.text or "").strip()

def get_message_caption(message: Message) -> str:
    return (message.caption or "").strip()

def count_content_messages(messages: list[Message]) -> dict[str, int]:
    counts = {"images": 0, "audio": 0, "text": 0}
    for item in messages:
        if is_image_message(item):
            counts["images"] += 1
        if is_audio_media_message(item):
            counts["audio"] += 1
        if get_message_plain_text(item):
            counts["text"] += 1
        if get_message_caption(item):
            counts["text"] += 1
    return counts

def build_content_batch_status(messages: list[Message]) -> str:
    counts = count_content_messages(messages)
    if not should_build_pdf_for_batch(messages):
        return (
            "⏳ Собрал аудио: "
            f"{counts['audio']}. Начну расшифровку через {CONTENT_BATCH_DELAY_SECONDS:g} сек."
        )
    return (
        "⏳ Собрал материалы: "
        f"фото {counts['images']}, аудио {counts['audio']}, текст {counts['text']}. "
        f"Предложу действия через {CONTENT_BATCH_DELAY_SECONDS:g} сек."
    )

def should_build_pdf_for_batch(messages: list[Message]) -> bool:
    return any(is_image_message(item) or get_message_plain_text(item) or get_message_caption(item) for item in messages)

def get_media_file_id_and_ext(message: Message) -> tuple[str, str] | None:
    if message.voice:
        return message.voice.file_id, ".ogg"
    if message.audio:
        return message.audio.file_id, media_extension_from_name_or_mime(
            getattr(message.audio, "file_name", None),
            getattr(message.audio, "mime_type", None),
            ".mp3",
        )
    if message.video_note:
        return message.video_note.file_id, ".mp4"
    if message.video:
        return message.video.file_id, media_extension_from_name_or_mime(
            getattr(message.video, "file_name", None),
            getattr(message.video, "mime_type", None),
            ".mp4",
        )
    if is_media_document_message(message) and message.document:
        mime_type = (message.document.mime_type or "").lower()
        default_ext = ".mp4" if mime_type.startswith("video/") else ".mp3"
        file_ext = media_extension_from_name_or_mime(message.document.file_name, mime_type, default_ext)
        return message.document.file_id, file_ext
    return None

def format_size_mb(size_bytes: int | float) -> str:
    size_mb = size_bytes / 1024 / 1024
    if size_mb >= 10:
        return f"{size_mb:.0f} МБ"
    return f"{size_mb:.1f} МБ"

def get_image_file_id_and_ext(message: Message) -> tuple[str, str] | None:
    if message.photo:
        return message.photo[-1].file_id, ".jpg"
    if is_image_document_message(message) and message.document:
        file_name = message.document.file_name or ""
        file_ext = Path(file_name).suffix.lower()
        if file_ext not in IMAGE_DOCUMENT_EXTENSIONS:
            mime_type = (message.document.mime_type or "").lower()
            file_ext = {
                "image/jpeg": ".jpg",
                "image/png": ".png",
                "image/heic": ".heic",
                "image/heif": ".heif",
            }.get(mime_type, ".jpg")
        return message.document.file_id, file_ext
    return None

def cleanup_pending_downloads() -> None:
    now = time.time()
    expired_ids = [
        download_id
        for download_id, item in pending_downloads.items()
        if now - item["created_at"] > YOUTUBE_PENDING_TTL_SECONDS
    ]
    for download_id in expired_ids:
        pending_downloads.pop(download_id, None)

def create_download_id(user_id: int, url: str) -> str:
    payload = f"{user_id}:{url}:{time.time()}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:16]

def build_youtube_keyboard(download_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="🎧 MP3",
                    callback_data=f"{YOUTUBE_CALLBACK_PREFIX}mp3:{download_id}",
                ),
                InlineKeyboardButton(
                    text="🎬 MP4",
                    callback_data=f"{YOUTUBE_CALLBACK_PREFIX}mp4:{download_id}",
                ),
            ]
        ]
    )

def safe_filename_part(value: str, fallback: str = "youtube") -> str:
    cleaned = re.sub(r"[^\w\s.-]+", "", value, flags=re.UNICODE).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned[:80] or fallback

def compact_error_text(error: BaseException, limit: int = 500) -> str:
    parts = [str(error)]
    cause = getattr(error, "__cause__", None)
    if cause:
        parts.append(f"cause={type(cause).__name__}: {cause}")
    text = " | ".join(part for part in parts if part)
    text = " ".join(text.split())
    return text[:limit]

def youtube_error_id() -> str:
    return hashlib.sha256(f"{time.time()}:{os.urandom(8).hex()}".encode()).hexdigest()[:10]

def record_youtube_error(
    *,
    user_id: int | None,
    url: str,
    file_format: str | None,
    stage: str,
    error: BaseException,
) -> str:
    error_id = youtube_error_id()
    cause = getattr(error, "__cause__", None) or error
    record = {
        "id": error_id,
        "created_at": int(time.time()),
        "user_id": user_id,
        "url": url,
        "format": file_format,
        "stage": stage,
        "error_type": type(cause).__name__,
        "message": compact_error_text(error),
        "trace_tail": traceback.format_exception_only(type(cause), cause)[-1].strip()[:500],
    }
    logging.error("YouTube error %s: %s", error_id, record)
    try:
        with YOUTUBE_ERROR_LOG_PATH.open("a", encoding="utf-8") as file:
            file.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as log_error:
        logging.warning("Failed to write YouTube error log: %s", type(log_error).__name__)
    return error_id

def read_youtube_errors(user_id: int, limit: int = 5) -> list[dict]:
    if not YOUTUBE_ERROR_LOG_PATH.exists():
        return []

    records: list[dict] = []
    try:
        with YOUTUBE_ERROR_LOG_PATH.open("r", encoding="utf-8") as file:
            for line in file:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if record.get("user_id") == user_id:
                    records.append(record)
    except Exception as read_error:
        logging.warning("Failed to read YouTube error log: %s", type(read_error).__name__)
        return []
    return records[-limit:]

def format_youtube_error_record(record: dict) -> str:
    created_at = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(record.get("created_at", 0)))
    return (
        f"ID: {record.get('id')}\n"
        f"Время: {created_at}\n"
        f"Формат: {record.get('format') or '-'}\n"
        f"Стадия: {record.get('stage')}\n"
        f"Ошибка: {record.get('error_type')}\n"
        f"Ссылка: {record.get('url')}\n"
        f"Причина: {record.get('message')}"
    )

def get_youtube_cookies_path() -> str | None:
    cookies_text = YOUTUBE_COOKIES_TEXT.strip()
    if not cookies_text and YOUTUBE_COOKIES_BASE64.strip():
        try:
            cookies_text = base64.b64decode(YOUTUBE_COOKIES_BASE64).decode("utf-8").strip()
        except Exception as e:
            logging.warning("Failed to decode YOUTUBE_COOKIES_BASE64: %s", type(e).__name__)
            return None

    if not cookies_text:
        return None

    try:
        YOUTUBE_COOKIES_PATH.write_text(cookies_text + "\n", encoding="utf-8")
        YOUTUBE_COOKIES_PATH.chmod(0o600)
        return str(YOUTUBE_COOKIES_PATH)
    except Exception as e:
        logging.warning("Failed to write YouTube cookies file: %s", type(e).__name__)
        return None

def apply_youtube_access_options(options: dict) -> dict:
    options = dict(options)
    cookies_path = get_youtube_cookies_path()
    if cookies_path:
        options["cookiefile"] = cookies_path
    if YOUTUBE_PROXY.strip():
        options["proxy"] = YOUTUBE_PROXY.strip()
    return options

def youtube_access_status_text() -> str:
    cookies_configured = bool(YOUTUBE_COOKIES_TEXT.strip() or YOUTUBE_COOKIES_BASE64.strip())
    proxy_configured = bool(YOUTUBE_PROXY.strip())
    return (
        f"Cookies: {'да' if cookies_configured else 'нет'}\n"
        f"Proxy: {'да' if proxy_configured else 'нет'}"
    )

def get_mode(mode_id: str) -> dict:
    return MODES.get(mode_id, MODES[DEFAULT_MODE_ID])

def resolve_mode_id(value: str | None) -> str | None:
    if not value:
        return None
    return MODE_ALIASES.get(value.strip().lower())

def get_user_mode_id(user_id: int | None) -> str:
    if user_id is None:
        return DEFAULT_MODE_ID
    return user_modes.get(user_id, DEFAULT_MODE_ID)

def get_message_mode_id(message: Message) -> str:
    if message.chat.type != "private":
        return DEFAULT_MODE_ID
    return get_user_mode_id(message.from_user.id if message.from_user else None)

def mode_button_text(mode_id: str) -> str:
    mode = get_mode(mode_id)
    return f"{mode['emoji']} {mode['title']}"

def build_mode_keyboard() -> InlineKeyboardMarkup:
    buttons = [
        InlineKeyboardButton(
            text=mode_button_text(mode_id),
            callback_data=f"{MODE_CALLBACK_PREFIX}{mode_id}",
        )
        for mode_id in MODES
    ]
    rows = [buttons[index:index + 2] for index in range(0, len(buttons), 2)]
    return InlineKeyboardMarkup(inline_keyboard=rows)

def build_modes_text(current_mode_id: str) -> str:
    lines = ["Выбери режим обработки голосовых:", ""]
    for mode_id, mode in MODES.items():
        marker = "•" if mode_id == current_mode_id else "-"
        lines.append(f"{marker} {mode['emoji']} {mode['title']} — {mode['description']}")
    lines.append("")
    lines.append("Быстрое переключение: /mode post, /mode client, /mode clean, /mode pdf, /mode word")
    return "\n".join(lines)

def command_text_or_last_context(message: Message, command: CommandObject) -> str:
    args = (command.args or "").strip()
    if args:
        if message.from_user:
            remember_context(message.from_user.id, args)
        return args
    return get_context(message.from_user.id if message.from_user else None)

async def export_context_command(message: Message, command: CommandObject, file_format: str) -> None:
    if not message.from_user:
        await message.answer("Не удалось определить пользователя.")
        return
    text = command_text_or_last_context(message, command)
    if not text.strip():
        await message.answer(
            f"Нет текста для файла. Отправь голосовое/материалы или напиши /{file_format} текст."
        )
        return
    status = await message.answer("⏳ Готовлю файл...")
    try:
        await send_text_export(status, text, "docx" if file_format in {"word", "docx"} else "pdf", message.from_user.id)
    except UserVisibleError as e:
        await status.edit_text(str(e))
    except Exception as e:
        logging.exception("Export command error")
        await status.edit_text(f"❌ Непредвиденная ошибка при создании файла: {type(e).__name__}.")

async def prompt_context_command(message: Message, command: CommandObject, action_type: str) -> None:
    if not message.from_user:
        await message.answer("Не удалось определить пользователя.")
        return
    text = command_text_or_last_context(message, command)
    if not text.strip():
        await message.answer("Нет текста для промта. Отправь голосовое/материалы или добавь текст после команды.")
        return
    status = await message.answer("⏳ Готовлю промт...")
    try:
        result = await transform_transcript_action(text, action_type)
        chunks = split_text(result)
        if not chunks:
            await status.edit_text("❌ Не получилось отправить промт.")
            return
        await status.edit_text(chunks[0])
        for chunk in chunks[1:]:
            await status.answer(chunk)
    except UserVisibleError as e:
        await status.edit_text(str(e))
    except Exception as e:
        logging.exception("Prompt command error")
        await status.edit_text(f"❌ Непредвиденная ошибка при создании промта: {type(e).__name__}.")

async def set_user_mode(message: Message, mode_id: str) -> None:
    if message.chat.type != "private":
        await message.answer("В группах пока всегда работает режим 🧠 Summary. Режимы переключаются в личке.")
        return
    if not message.from_user:
        await message.answer("Не удалось определить пользователя.")
        return

    user_modes[message.from_user.id] = mode_id
    mode = get_mode(mode_id)
    await message.answer(f"Режим выбран: {mode['emoji']} {mode['title']}")

@dp.message(CommandStart())
async def command_start_handler(message: Message) -> None:
    """
    This handler receives messages with `/start` command
    """
    welcome_text = (
        f"Привет! Я {BOT_PROFILE_NAME}.\n\n"
        "Что умею:\n"
        "1. Расшифровывать голосовые, аудио, видео и кружки.\n"
        "2. Собирать фото, текст и голосовые в PDF max quality, текстовый PDF или Word.\n"
        "3. После материалов показывать кнопки: расшифровать, summary, оформить сообщение или сделать промт для Codex.\n"
        "4. Команды: /pdf, /word, /pdf_prompt, /word_prompt, /mode pdf, /mode word.\n"
        "5. Принимать обратную связь и отправлять её автору @denrech.\n\n"
        "Автор: @denrech\n\n"
        "Просто отправь материалы в личку, а я сам предложу варианты действий.\n"
        "Экспериментальная OCR-версия для фото и скринов: /ocr_help"
    )
    await message.answer(welcome_text, reply_markup=build_start_keyboard())

@dp.message(Command("mode"))
async def mode_handler(message: Message, command: CommandObject) -> None:
    if message.chat.type != "private" and not command.args:
        await message.answer("В группах пока всегда работает режим 🧠 Summary. Режимы переключаются в личке.")
        return

    requested_mode_id = resolve_mode_id(command.args)
    if requested_mode_id:
        await set_user_mode(message, requested_mode_id)
        return
    if command.args:
        await message.answer("Не нашёл такой режим. Вот доступные варианты:")

    current_mode_id = get_message_mode_id(message)
    await message.answer(build_modes_text(current_mode_id), reply_markup=build_mode_keyboard())

@dp.message(Command("current"))
async def current_mode_handler(message: Message) -> None:
    mode_id = get_message_mode_id(message)
    mode = get_mode(mode_id)
    if message.chat.type != "private":
        await message.answer("Текущий режим в группе: 🧠 Summary")
        return
    await message.answer(f"Текущий режим: {mode['emoji']} {mode['title']}\n{mode['description']}")

@dp.message(Command("version"))
async def version_handler(message: Message) -> None:
    await message.answer(
        f"Версия бота: {APP_VERSION}\n"
        f"Fly app: {FLY_APP_NAME}\n"
        f"Webhook host: {urlparse(WEBHOOK_BASE_URL).netloc}\n"
        f"State DB: {STATE_DB_PATH}\n"
        f"{youtube_access_status_text()}"
    )

@dp.message(Command("pdf"))
async def pdf_command_handler(message: Message, command: CommandObject) -> None:
    await export_context_command(message, command, "pdf")

@dp.message(Command("word", "docx"))
async def word_command_handler(message: Message, command: CommandObject) -> None:
    await export_context_command(message, command, "word")

@dp.message(Command("pdf_prompt", "pdfprompt"))
async def pdf_prompt_command_handler(message: Message, command: CommandObject) -> None:
    await prompt_context_command(message, command, "pdf_prompt")

@dp.message(Command("word_prompt", "wordprompt"))
async def word_prompt_command_handler(message: Message, command: CommandObject) -> None:
    await prompt_context_command(message, command, "word_prompt")

@dp.message(Command("chat_id"))
async def chat_id_handler(message: Message) -> None:
    await message.answer(f"chat_id: {message.chat.id}")

@dp.message(Command("feedback"))
async def feedback_command_handler(message: Message) -> None:
    if message.chat.type != "private" or not message.from_user:
        await message.answer("Обратную связь лучше отправить мне в личку.")
        return
    start_feedback_session(message.from_user.id)
    await message.answer("Напиши обратную связь одним сообщением. Я перешлю её @denrech.")

@dp.message(Command("ocr_on"))
async def ocr_on_handler(message: Message) -> None:
    if message.chat.type != "private" or not message.from_user:
        await message.answer("OCR-версия включается только в личке, чтобы не смешивать участников.")
        return
    set_ocr_enabled(message.from_user.id, True)
    await message.answer(
        "OCR-версия включена для твоего аккаунта.\n\n"
        f"{ocr_help_text(enabled=True)}"
    )

@dp.message(Command("ocr_off"))
async def ocr_off_handler(message: Message) -> None:
    if message.chat.type != "private" or not message.from_user:
        await message.answer("OCR-версия управляется только в личке.")
        return
    set_ocr_enabled(message.from_user.id, False)
    await message.answer("OCR-версия выключена. Старый режим снова работает как обычно.")

@dp.message(Command("ocr_status"))
async def ocr_status_handler(message: Message) -> None:
    if message.chat.type != "private" or not message.from_user:
        await message.answer("В группах OCR-режим не включается.")
        return
    enabled = is_ocr_enabled(message.from_user.id)
    await message.answer(f"OCR-версия: {'включена' if enabled else 'выключена'}.\n\nПодсказка: /ocr_help")

@dp.message(Command("ocr_help"))
async def ocr_help_handler(message: Message) -> None:
    enabled = is_ocr_enabled(message.from_user.id if message.from_user else None)
    await message.answer(ocr_help_text(enabled=enabled))

def _v3_guard(message: Message) -> bool:
    return bool(message.chat.type == "private" and message.from_user and v3_is_god_user(message.from_user))

@dp.message(Command("myid"))
async def myid_handler(message: Message) -> None:
    user = message.from_user
    if not user:
        await message.answer("Не вижу отправителя.")
        return
    lines = [f"Твой Telegram id: {user.id}"]
    if user.username:
        lines.append(f"username: @{user.username}")
    lines.append(f"Чтобы закрепить права бога, задай в Fly secrets: GOD_USER_ID={user.id}")
    await message.answer("\n".join(lines))

@dp.message(Command("v3_on"))
async def v3_on_handler(message: Message) -> None:
    if not _v3_guard(message):
        await message.answer("Режим v3 доступен только владельцу в личке.")
        return
    set_v3_enabled(message.from_user.id, True)
    await message.answer("Режим v3 включён (права бога).\n\n" + v3_help_text())

@dp.message(Command("v3_off"))
async def v3_off_handler(message: Message) -> None:
    if not _v3_guard(message):
        await message.answer("Режим v3 доступен только владельцу в личке.")
        return
    set_v3_enabled(message.from_user.id, False)
    await message.answer("Режим v3 выключен. Бот снова работает как обычно.")

@dp.message(Command("v3_status"))
async def v3_status_handler(message: Message) -> None:
    if not _v3_guard(message):
        await message.answer("Режим v3 доступен только владельцу в личке.")
        return
    enabled = is_v3_enabled(message.from_user.id)
    await message.answer(f"Режим v3: {'включён' if enabled else 'выключен'}.\n\nПодсказка: /v3_help")

@dp.message(Command("v3_help"))
async def v3_help_handler(message: Message) -> None:
    if not _v3_guard(message):
        await message.answer("Режим v3 доступен только владельцу в личке.")
        return
    await message.answer(v3_help_text())

@dp.message(Command("ask"))
async def v3_ask_handler(message: Message, command: CommandObject) -> None:
    if not _v3_guard(message):
        await message.answer(f"Команда доступна только владельцу (@{GOD_USERNAME or 'denrech'}).")
        return
    if not is_v3_enabled(message.from_user.id):
        await message.answer("Сначала включи режим: /v3_on")
        return
    question = (command.args or "").strip()
    if not question:
        await message.answer("Использование: /ask <вопрос>. Можно ответом на сообщение — тогда контекст возьму из него.")
        return
    context = ""
    if message.reply_to_message:
        context = (
            get_message_plain_text(message.reply_to_message)
            or (message.reply_to_message.caption or "")
        ).strip()
    if not context:
        context = get_context(message.from_user.id)
    status = await message.answer("🧠 думаю...")
    try:
        answer = await v3_chat_answer(message.from_user.id, question, extra_context=context)
    except Exception as e:
        logging.exception("v3 ask failed")
        answer = f"❌ Ошибка: {type(e).__name__}: {e}"
    with suppress(Exception):
        await status.delete()
    for chunk in split_text(answer or "(пустой ответ)"):
        await message.answer(chunk)

@dp.message(Command("agent"))
async def v3_agent_handler(message: Message, command: CommandObject) -> None:
    if not _v3_guard(message):
        await message.answer("Команда доступна только владельцу.")
        return
    if not is_v3_enabled(message.from_user.id):
        await message.answer("Сначала включи режим: /v3_on")
        return
    if not ANTHROPIC_API_KEY:
        await message.answer("Для /agent нужен ANTHROPIC_API_KEY в Fly secrets. Пока доступен /ask на Groq.")
        return
    task = (command.args or "").strip()
    if not task:
        await message.answer("Использование: /agent <задача>")
        return
    workdir = V3_SANDBOX_ROOT / uuid.uuid4().hex
    workdir.mkdir(parents=True, exist_ok=True)
    context = get_context(message.from_user.id)
    if context:
        with suppress(Exception):
            (workdir / "context.txt").write_text(context, encoding="utf-8")
    status = await message.answer("🤖 Claude-агент работает в песочнице...")
    log_lines: list[str] = []

    async def progress(name, tool_input, output):
        log_lines.append(f"🔧 {name}: {_v3_tool_preview(tool_input)}")
        text = "🤖 Агент работает:\n" + "\n".join(log_lines[-15:])
        with suppress(Exception):
            await status.edit_text(text[:3900])

    system = (
        "Ты — Claude Code внутри изолированной песочницы. У тебя есть инструменты "
        "bash, read_file, write_file, list_dir в рабочей папке. Выполни задачу пользователя. "
        "Если есть файл context.txt — это последняя расшифровка/материалы пользователя. "
        "В конце дай краткий понятный отчёт по-русски."
    )
    task_full = task if not context else task + "\n\n(В рабочей папке есть context.txt с последними материалами.)"
    try:
        result = await run_v3_agent(task_full, workdir, system, progress=progress)
        final = result.get("text") or "(агент не дал текстового ответа)"
        final = f"{final}\n\n— шагов: {result.get('turns')}, вызовов инструментов: {len(result.get('transcript') or [])}"
        for chunk in split_text(final):
            await message.answer(chunk)
    except Exception as e:
        logging.exception("v3 agent failed")
        await message.answer(f"❌ Агент упал: {type(e).__name__}: {e}")
    finally:
        with suppress(Exception):
            shutil.rmtree(workdir, ignore_errors=True)

@dp.message(Command("self"))
async def v3_self_handler(message: Message, command: CommandObject) -> None:
    if not _v3_guard(message):
        await message.answer("Команда доступна только владельцу.")
        return
    if not is_v3_enabled(message.from_user.id):
        await message.answer("Сначала включи режим: /v3_on")
        return
    if not ANTHROPIC_API_KEY:
        await message.answer("Для /self нужен ANTHROPIC_API_KEY в Fly secrets.")
        return
    instruction = (command.args or "").strip()
    if not instruction:
        await message.answer("Использование: /self <что изменить в коде бота>")
        return
    cleanup_self_edit_sessions()
    status = await message.answer("🧬 Клонирую репозиторий и запускаю Claude над своим кодом...")
    try:
        workdir = await asyncio.to_thread(v3_clone_repo)
    except Exception as e:
        logging.exception("v3 self clone failed")
        await message.answer(f"❌ Не смог клонировать репозиторий: {type(e).__name__}: {e}")
        return
    log_lines: list[str] = []

    async def progress(name, tool_input, output):
        log_lines.append(f"🔧 {name}: {_v3_tool_preview(tool_input)}")
        text = "🧬 Claude правит код:\n" + "\n".join(log_lines[-15:])
        with suppress(Exception):
            await status.edit_text(text[:3900])

    system = (
        "Ты — Claude Code. В рабочей папке — исходный код этого Telegram-бота (Python, основной файл bot.py). "
        "Внеси изменения строго по задаче владельца. ЗАПРЕЩЕНО трогать секреты и .env, печатать токены. "
        "После правок ОБЯЗАТЕЛЬНО проверь синтаксис командой bash: python3 -m py_compile bot.py. "
        "Не делай git commit/push сам — это сделает владелец после подтверждения. "
        "В конце кратко перечисли, что изменил."
    )
    try:
        result = await run_v3_agent(instruction, workdir, system, progress=progress)
    except Exception as e:
        logging.exception("v3 self agent failed")
        with suppress(Exception):
            shutil.rmtree(workdir, ignore_errors=True)
        await message.answer(f"❌ Claude упал: {type(e).__name__}: {e}")
        return
    diff = await asyncio.to_thread(v3_git_diff, workdir)
    if not diff.strip():
        with suppress(Exception):
            shutil.rmtree(workdir, ignore_errors=True)
        await message.answer("Claude не внёс изменений в код.")
        return
    sid = uuid.uuid4().hex[:12]
    self_edit_sessions[sid] = {
        "workdir": str(workdir),
        "instruction": instruction,
        "user_id": message.from_user.id,
        "report": result.get("text") or "",
        "created_at": time.time(),
    }
    report = result.get("text") or "(без отчёта)"
    await message.answer("📝 Отчёт Claude:\n" + report[:1500])
    diff_text = diff[:V3_DIFF_PREVIEW_LIMIT]
    if len(diff) > V3_DIFF_PREVIEW_LIMIT:
        diff_text += "\n... (diff обрезан)"
    for chunk in split_text("diff:\n" + diff_text):
        await message.answer(chunk)
    keyboard = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="✅ Запушить и задеплоить", callback_data=f"{SELF_CALLBACK_PREFIX}push:{sid}"),
        InlineKeyboardButton(text="❌ Отмена", callback_data=f"{SELF_CALLBACK_PREFIX}cancel:{sid}"),
    ]])
    push_note = "" if GITHUB_TOKEN else "\n\n⚠️ GITHUB_TOKEN не задан — push не сработает. Добавь его в Fly secrets."
    await message.answer("Запушить изменения в main? Прод-выкат делается через Fly deploy/CI." + push_note, reply_markup=keyboard)

@dp.callback_query(F.data.startswith(SELF_CALLBACK_PREFIX))
async def v3_self_callback(callback: CallbackQuery) -> None:
    if not callback.from_user or not v3_is_god_user(callback.from_user):
        await callback.answer("Нет прав.", show_alert=True)
        return
    payload = (callback.data or "")[len(SELF_CALLBACK_PREFIX):]
    action, _, sid = payload.partition(":")
    session = self_edit_sessions.get(sid)
    if not session:
        with suppress(Exception):
            await callback.message.edit_text("Сессия правки истекла или уже обработана.")
        await callback.answer()
        return
    workdir = Path(session.get("workdir", ""))
    if action == "cancel":
        with suppress(Exception):
            shutil.rmtree(workdir, ignore_errors=True)
        self_edit_sessions.pop(sid, None)
        with suppress(Exception):
            await callback.message.edit_text("Отменено. Изменения не запушены.")
        await callback.answer("Отменено")
        return
    if action == "push":
        if not GITHUB_TOKEN:
            await callback.answer("Нет GITHUB_TOKEN в env.", show_alert=True)
            return
        await callback.answer("Пушу...")
        commit_message = "v3 self-edit: " + (session.get("instruction") or "")[:60]
        try:
            output = await asyncio.to_thread(v3_push_self, workdir, commit_message)
            text = "✅ Запушено в main. Для прод-выката нужен Fly deploy/CI.\n" + output[:1500]
        except subprocess.CalledProcessError as e:
            text = f"❌ git упал: {(e.stderr or e.stdout or str(e))[:1500]}"
        except Exception as e:
            logging.exception("v3 self push failed")
            text = f"❌ push не удался: {type(e).__name__}: {e}"
        finally:
            with suppress(Exception):
                shutil.rmtree(workdir, ignore_errors=True)
            self_edit_sessions.pop(sid, None)
        with suppress(Exception):
            await callback.message.edit_text(text)
        return
    await callback.answer()

@dp.callback_query(F.data.startswith(V3_SUGGESTION_PREFIX))
async def v3_suggestion_callback(callback: CallbackQuery) -> None:
    if not callback.data or not callback.from_user or not v3_is_god_user(callback.from_user):
        await callback.answer("Недоступно", show_alert=True)
        return
    payload = callback.data[len(V3_SUGGESTION_PREFIX):]
    kind, _, action_id = payload.partition(":")
    cleanup_v3_suggestions()
    item = v3_suggestion_actions.get(action_id)
    if not item:
        await callback.answer("Идеи устарели, отправь аудио заново.", show_alert=True)
        return
    if item["user_id"] != callback.from_user.id:
        await callback.answer("Эта кнопка не для тебя", show_alert=True)
        return
    if not isinstance(callback.message, Message):
        await callback.answer("Не удалось обработать", show_alert=True)
        return
    transcript = item.get("transcript", "")
    suggestions = item.get("suggestions") or []

    if kind == "ask":
        await callback.answer()
        await callback.message.answer("Ответь на это сообщение своим вопросом по аудио 👇")
        return

    if kind == "more":
        await callback.answer("Обновляю идеи...")
        new_suggestions = await v3_generate_suggestions(transcript)
        item["suggestions"] = new_suggestions
        item["created_at"] = time.time()
        with suppress(Exception):
            await callback.message.edit_reply_markup(
                reply_markup=build_v3_suggestion_keyboard(action_id, new_suggestions)
            )
        return

    if kind == "sum" or kind.startswith("i"):
        if kind == "sum":
            prompt = V3_SUMMARY_PROMPT
        else:
            try:
                prompt = suggestions[int(kind[1:])]["prompt"]
            except (ValueError, IndexError, KeyError, TypeError):
                await callback.answer("Не нашёл подсказку", show_alert=True)
                return
        await callback.answer("Готовлю...")
        status = await callback.message.answer("⏳ Делаю...")
        try:
            images = item.get("images") or []
            if images:
                result = await v3_vision_answer(images, prompt, transcript)
            else:
                result = await v3_chat_answer(callback.from_user.id, prompt, extra_context=transcript)
        except Exception as e:
            logging.exception("v3 suggestion run failed")
            result = f"❌ Ошибка: {type(e).__name__}: {e}"
        chunks = split_text(result or "(пусто)")
        followup = build_v3_followup_keyboard(action_id)
        with suppress(Exception):
            await status.delete()
        for i, chunk in enumerate(chunks):
            await callback.message.answer(
                chunk,
                reply_markup=followup if i == len(chunks) - 1 else None,
            )
        return

    await callback.answer()

@dp.message(Command("remind"))
async def v3_remind_handler(message: Message, command: CommandObject) -> None:
    if not _v3_guard(message):
        await message.answer("Команда доступна только владельцу.")
        return
    if not is_v3_enabled(message.from_user.id):
        await message.answer("Сначала включи режим: /v3_on")
        return
    text = (command.args or "").strip()
    if not text:
        await message.answer("Использование: /remind завтра в 10 позвонить врачу")
        return
    await v3_create_reminder_from_text(message, text)

@dp.message(Command("reminders"))
async def v3_reminders_handler(message: Message) -> None:
    if not _v3_guard(message):
        await message.answer("Команда доступна только владельцу.")
        return
    mine = sorted(
        (r for r in v3_reminders if r.get("user_id") == message.from_user.id),
        key=lambda r: r.get("due_iso", ""),
    )
    if not mine:
        await message.answer("Активных напоминаний нет. Поставить: /remind …")
        return
    lines, rows = [], []
    for r in mine:
        try:
            human = datetime.fromisoformat(r["due_iso"]).strftime("%d.%m %H:%M")
        except Exception:
            human = r.get("due_iso", "?")
        lines.append(f"• {human} — {r.get('text', '')}")
        rows.append([InlineKeyboardButton(
            text=f"🗑 {human} {r.get('text', '')[:16]}",
            callback_data=f"{V3_REMINDER_PREFIX}del:{r['id']}",
        )])
    await message.answer("Напоминания:\n" + "\n".join(lines), reply_markup=InlineKeyboardMarkup(inline_keyboard=rows))

@dp.callback_query(F.data.startswith(V3_REMINDER_PREFIX))
async def v3_reminder_callback(callback: CallbackQuery) -> None:
    if not callback.from_user or not v3_is_god_user(callback.from_user):
        await callback.answer("Нет прав", show_alert=True)
        return
    payload = (callback.data or "")[len(V3_REMINDER_PREFIX):]
    action, _, rid = payload.partition(":")
    if action == "del":
        before = len(v3_reminders)
        v3_reminders[:] = [
            r for r in v3_reminders
            if not (r.get("id") == rid and r.get("user_id") == callback.from_user.id)
        ]
        if len(v3_reminders) != before:
            v3_save_reminders()
            await callback.answer("Удалено")
            with suppress(Exception):
                await callback.message.edit_text("Напоминание удалено.")
        else:
            await callback.answer("Не найдено")
        return
    await callback.answer()

@dp.message(Command("recall"))
async def v3_recall_handler(message: Message, command: CommandObject) -> None:
    if not _v3_guard(message):
        await message.answer("Команда доступна только владельцу.")
        return
    if not is_v3_enabled(message.from_user.id):
        await message.answer("Сначала включи режим: /v3_on")
        return
    query = (command.args or "").strip()
    if not query:
        await message.answer("Использование: /recall <что вспомнить>")
        return
    status = await message.answer("🧠 ищу в памяти...")
    try:
        answer = await v3_chat_answer(message.from_user.id, "Используя мою память, ответь: " + query)
    except Exception as e:
        logging.exception("v3 recall failed")
        answer = f"❌ Ошибка: {type(e).__name__}: {e}"
    with suppress(Exception):
        await status.delete()
    for chunk in split_text(answer or "(пусто)"):
        await message.answer(chunk)

@dp.message(Command("memory"))
async def v3_memory_stats_handler(message: Message) -> None:
    if not _v3_guard(message):
        await message.answer("Команда доступна только владельцу.")
        return
    count = len(_v3_memory_load(message.from_user.id))
    await message.answer(f"В памяти записей: {count}.\nНайти: /recall <запрос>\nОчистить: /forget")

@dp.message(Command("forget"))
async def v3_forget_handler(message: Message) -> None:
    if not _v3_guard(message):
        await message.answer("Команда доступна только владельцу.")
        return
    removed = v3_memory_clear(message.from_user.id)
    v3_conversations.pop(message.from_user.id, None)
    await message.answer(f"Память очищена: удалил {removed} записей.")

@dp.message(Command("set_leads_chat"))
async def set_leads_chat_handler(message: Message) -> None:
    if not is_lead_admin(message):
        await message.answer("Эта команда доступна только администратору заявок.")
        return
    save_leads_chat_id(message.chat.id)
    flushed_count = await flush_pending_leads(message.chat.id)
    await message.answer(
        "Готово. Заявки с сайтов будут приходить в этот чат.\n"
        f"chat_id: {message.chat.id}\n"
        f"Выгружено заявок из очереди: {flushed_count}"
    )

@dp.message(Command("leads_chat"))
async def leads_chat_handler(message: Message) -> None:
    if not is_lead_admin(message):
        await message.answer("Эта команда доступна только администратору заявок.")
        return
    leads_chat_id = get_leads_chat_id()
    if not leads_chat_id:
        await message.answer(
            "Чат для заявок ещё не задан. Напиши /set_leads_chat в нужном чате.\n"
            f"Заявок в очереди: {pending_leads_count()}"
        )
        return
    source = "env" if LEADS_CHAT_ID else "runtime"
    await message.answer(
        f"Чат для заявок: {leads_chat_id}\n"
        f"Источник: {source}\n"
        f"Заявок в очереди: {pending_leads_count()}"
    )

@dp.message(Command("keep"))
async def keep_handler(message: Message, command: CommandObject) -> None:
    key = profile_note_key(message)
    if not key:
        await message.answer("Не удалось определить профиль Telegram для заметок.")
        return

    args = (command.args or "").strip()
    if not args or args.lower() in {"list", "show", "all", "все"}:
        notes = load_profile_notes().get(key, [])
        for page in format_profile_notes_pages(key, notes):
            await message.answer(page)
        return

    if args.lower() in {"clear", "reset"}:
        clear_profile_notes(key)
        await message.answer(f"Заметки профиля {key} очищены.")
        return

    count = add_profile_note(key, args)
    await message.answer(f"Сохранил заметку #{count} для профиля {key}.")

@dp.message(Command("yt_errors"))
async def youtube_errors_handler(message: Message) -> None:
    if message.chat.type != "private" or not message.from_user:
        return

    records = read_youtube_errors(message.from_user.id, limit=5)
    if not records:
        await message.answer("Ошибок YouTube для тебя пока не записано.")
        return

    chunks = ["Последние ошибки YouTube:"]
    for record in records:
        chunks.append(format_youtube_error_record(record))
    await message.answer("\n\n".join(chunks))

@dp.callback_query(F.data.startswith(MODE_CALLBACK_PREFIX))
async def mode_callback_handler(callback: CallbackQuery) -> None:
    mode_id = callback.data.removeprefix(MODE_CALLBACK_PREFIX) if callback.data else DEFAULT_MODE_ID
    if mode_id not in MODES:
        await callback.answer("Неизвестный режим", show_alert=True)
        return
    if callback.message and callback.message.chat.type != "private":
        await callback.answer("В группах пока работает только Summary", show_alert=True)
        return
    if not callback.from_user:
        await callback.answer("Не удалось определить пользователя", show_alert=True)
        return

    user_modes[callback.from_user.id] = mode_id
    mode = get_mode(mode_id)
    await callback.answer(f"Выбран: {mode['title']}")
    if callback.message:
        await callback.message.edit_text(
            f"Режим выбран: {mode['emoji']} {mode['title']}\n{mode['description']}"
        )

@dp.callback_query(F.data.startswith(TRANSCRIPT_ACTION_PREFIX))
async def transcript_action_callback_handler(callback: CallbackQuery) -> None:
    if not callback.data or not callback.from_user:
        await callback.answer("Не удалось обработать кнопку", show_alert=True)
        return

    parts = callback.data.split(":")
    if len(parts) != 3:
        await callback.answer("Неверная кнопка", show_alert=True)
        return

    _, action_type, action_id = parts
    if action_type not in {"summary", "message", "codex"}:
        await callback.answer("Неизвестное действие", show_alert=True)
        return

    cleanup_transcript_actions()
    action_item = load_transcript_action(action_id)
    if not action_item:
        await callback.answer("Расшифровка устарела. Отправь аудио ещё раз.", show_alert=True)
        return
    if action_item["user_id"] != callback.from_user.id:
        await callback.answer("Эта кнопка не для тебя", show_alert=True)
        return
    if not isinstance(callback.message, Message):
        await callback.answer("Не удалось отправить результат", show_alert=True)
        return

    await callback.answer("Готовлю результат")
    status_msg = await callback.message.answer("⏳ Обрабатываю расшифровку...")
    try:
        result = await transform_transcript_action(action_item["transcript"], action_type)
        await deliver_result(status_msg, result)
    except UserVisibleError as e:
        await status_msg.edit_text(str(e))
    except Exception as e:
        logging.exception("Transcript action error")
        await status_msg.edit_text(f"❌ Непредвиденная ошибка при обработке расшифровки: {type(e).__name__}.")

@dp.callback_query(F.data.startswith(FEEDBACK_CALLBACK_PREFIX))
async def feedback_callback_handler(callback: CallbackQuery) -> None:
    if not callback.from_user:
        await callback.answer("Не удалось определить пользователя", show_alert=True)
        return
    if callback.data != f"{FEEDBACK_CALLBACK_PREFIX}start":
        await callback.answer("Неизвестная кнопка", show_alert=True)
        return
    start_feedback_session(callback.from_user.id)
    await callback.answer("Жду сообщение")
    if isinstance(callback.message, Message):
        await callback.message.answer("Напиши обратную связь одним сообщением. Я перешлю её @denrech.")

@dp.callback_query(F.data.startswith(MATERIAL_ACTION_PREFIX))
async def material_action_callback_handler(callback: CallbackQuery) -> None:
    if not callback.data or not callback.from_user:
        await callback.answer("Не удалось обработать кнопку", show_alert=True)
        return

    parts = callback.data.split(":")
    if len(parts) != 3:
        await callback.answer("Неверная кнопка", show_alert=True)
        return

    _, action_type, action_id = parts
    if action_type not in {"pdf", "text", "text_pdf", "word", "summary", "message", "codex", "cancel"}:
        await callback.answer("Неизвестное действие", show_alert=True)
        return

    cleanup_material_actions()
    action_item = load_material_action(action_id)
    if not action_item:
        await callback.answer("Материалы устарели, отправь их заново.", show_alert=True)
        return
    if action_item["user_id"] != callback.from_user.id:
        await callback.answer("Эта кнопка не для тебя", show_alert=True)
        return
    if not isinstance(callback.message, Message):
        await callback.answer("Не удалось отправить результат", show_alert=True)
        return

    if action_type == "cancel":
        material_actions.pop(action_id, None)
        state_delete(f"material_action:{action_id}")
        await callback.answer("Отменено")
        await callback.message.edit_text("Отменил обработку материалов.", reply_markup=None)
        return

    items = action_item.get("items") or []
    if not items:
        await callback.answer("Материалы устарели, отправь их заново.", show_alert=True)
        return
    ocr_enabled = bool(action_item.get("ocr_enabled"))
    ocr_cache = action_item.setdefault("ocr_cache", {})

    await callback.answer("Запускаю обработку")
    status_msg = await callback.message.answer("⏳ Обрабатываю материалы...")

    try:
        if action_type == "pdf":
            await process_materials_pdf_items(items, status_msg, callback.from_user.id)
            return

        if action_type in {"text_pdf", "word", "summary", "message", "codex"} and not has_transformable_material_text(items, ocr_enabled=ocr_enabled):
            await status_msg.edit_text("❌ В материалах только фото без текста. Для этого действия нужен текст, подпись или голосовое.")
            return

        text_basis = await collect_material_text(
            items,
            status_msg,
            ocr_enabled=ocr_enabled,
            ocr_cache=ocr_cache,
        )
        persist_material_action(action_id, action_item)
        if not text_basis.strip():
            await status_msg.edit_text("❌ Не получилось собрать текст из материалов.")
            return
        remember_context(callback.from_user.id, text_basis)

        if action_type == "text_pdf":
            await send_text_export(status_msg, text_basis, "pdf", callback.from_user.id, title="Материалы")
            return

        if action_type == "word":
            await send_text_export(status_msg, text_basis, "docx", callback.from_user.id, title="Материалы")
            return

        if action_type == "text":
            result = f"📝 {text_basis}"
            reply_markup = store_transcript_action(callback.from_user.id, text_basis)
        else:
            result = await transform_transcript_action(text_basis, action_type)
            reply_markup = None

        await deliver_result(status_msg, result, reply_markup=reply_markup)
    except UserVisibleError as e:
        await status_msg.edit_text(str(e))
    except Exception as e:
        logging.exception("Material action error")
        await status_msg.edit_text(f"❌ Непредвиденная ошибка при обработке материалов: {type(e).__name__}.")

@dp.message(F.text)
async def youtube_link_handler(message: Message) -> None:
    if message.chat.type != "private" or not message.from_user:
        return
    if message.text and message.text.startswith("/"):
        return

    if has_active_feedback_session(message.from_user.id):
        feedback_sessions.pop(message.from_user.id, None)
        try:
            delivered = await send_feedback_to_admin(message)
        except UserVisibleError as e:
            await message.answer(str(e))
            return
        if delivered:
            await message.answer("Спасибо! Обратная связь отправлена @denrech.")
        else:
            await message.answer("Спасибо! Обратная связь сохранена и уйдёт @denrech, когда чат заявок будет доступен.")
        return

    uid = message.from_user.id
    reply = message.reply_to_message
    if (
        reply is not None
        and reply.from_user is not None
        and reply.from_user.is_bot
        and message.text
        and is_v3_enabled(uid)
        and v3_is_god_user(message.from_user)
    ):
        question = message.text.strip()
        if question:
            extra = (get_message_plain_text(reply) or (reply.caption or "")).strip()
            status = await message.answer("🧠 думаю...")
            try:
                answer = await v3_chat_answer(uid, question, extra_context=extra)
            except Exception as e:
                logging.exception("v3 reply-chat failed")
                answer = f"❌ Ошибка: {type(e).__name__}: {e}"
            with suppress(Exception):
                await status.delete()
            for chunk in split_text(answer or "(пустой ответ)"):
                await message.answer(chunk)
            return

    youtube_url = extract_youtube_url(message.text)
    if not youtube_url:
        if is_v3_enabled(uid) and v3_is_god_user(message.from_user):
            await v3_handle_text(message)
            return
        await queue_private_content_message(message)
        return

    cleanup_pending_downloads()
    download_id = create_download_id(message.from_user.id, youtube_url)
    pending_downloads[download_id] = {
        "url": youtube_url,
        "user_id": message.from_user.id,
        "created_at": time.time(),
    }
    await message.answer(
        "Что скачать?\n\nСкачивай только личный или разрешённый контент.",
        reply_markup=build_youtube_keyboard(download_id),
    )

@dp.callback_query(F.data.startswith(YOUTUBE_CALLBACK_PREFIX))
async def youtube_download_callback_handler(callback: CallbackQuery) -> None:
    if not callback.data or not isinstance(callback.message, Message):
        await callback.answer("Не удалось обработать кнопку", show_alert=True)
        return

    parts = callback.data.split(":")
    if len(parts) != 3:
        await callback.answer("Неверная кнопка", show_alert=True)
        return

    _, file_format, download_id = parts
    if file_format not in {"mp3", "mp4"}:
        await callback.answer("Неизвестный формат", show_alert=True)
        return

    cleanup_pending_downloads()
    pending_item = pending_downloads.get(download_id)
    if not pending_item:
        await callback.answer("Ссылка устарела. Отправь её ещё раз.", show_alert=True)
        return
    if pending_item["user_id"] != callback.from_user.id:
        await callback.answer("Эта кнопка не для тебя", show_alert=True)
        return

    await callback.answer("Начинаю скачивание")
    status_msg = callback.message
    workdir = Path(TEMP_DIR) / f"youtube_{download_id}"
    workdir.mkdir(parents=True, exist_ok=True)
    youtube_url = pending_item["url"]
    stage = "start"

    try:
        stage = "info"
        await status_msg.edit_text("⏳ Проверяю видео...")
        info = await get_youtube_info(youtube_url)
        validate_youtube_duration(info)

        stage = "download"
        format_label = "MP3" if file_format == "mp3" else "MP4"
        await status_msg.edit_text(f"⏳ Скачиваю {format_label}...")
        file_path, download_info = await download_youtube_file(youtube_url, file_format, workdir)
        validate_upload_size(file_path)

        stage = "send"
        await status_msg.edit_text("⏳ Отправляю файл...")
        await send_youtube_file(status_msg, file_path, download_info or info, file_format)
        await status_msg.delete()
        pending_downloads.pop(download_id, None)
    except UserVisibleError as e:
        error_id = record_youtube_error(
            user_id=callback.from_user.id,
            url=youtube_url,
            file_format=file_format,
            stage=stage,
            error=e,
        )
        await status_msg.edit_text(f"{e}\n\nID ошибки: {error_id}\nДетали: /yt_errors")
    except Exception as e:
        error_id = record_youtube_error(
            user_id=callback.from_user.id,
            url=youtube_url,
            file_format=file_format,
            stage=stage,
            error=e,
        )
        logging.exception("Unexpected YouTube download error")
        await status_msg.edit_text(f"❌ Непредвиденная ошибка при скачивании.\n\nID ошибки: {error_id}\nДетали: /yt_errors")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

@dp.inline_query()
async def inline_summary_handler(inline_query: InlineQuery) -> None:
    """
    Handles Telegram inline mode: @bot text -> summary article.
    """
    query_text = inline_query.query.strip()

    if not query_text:
        result = InlineQueryResultArticle(
            id="inline-help",
            title="Напиши текст после @dentrans",
            description="Я сделаю короткое summary прямо в этом чате.",
            input_message_content=InputTextMessageContent(
                message_text="🧠 Напиши текст после @dentrans, и я сделаю короткое summary."
            ),
        )
        await inline_query.answer([result], cache_time=1, is_personal=True)
        return

    if len(query_text) > INLINE_QUERY_LIMIT:
        query_text = query_text[:INLINE_QUERY_LIMIT].rstrip()

    try:
        summary = await summarize_text(query_text)
        if not summary:
            summary = "Короткое сообщение."
        message_text = f"🧠 {summary}"
        result = InlineQueryResultArticle(
            id=inline_result_id(query_text),
            title="🧠 Отправить summary",
            description=shorten(summary, INLINE_DESCRIPTION_LIMIT),
            input_message_content=InputTextMessageContent(message_text=message_text),
        )
    except UserVisibleError as e:
        result = InlineQueryResultArticle(
            id=inline_result_id(str(e)),
            title="Не удалось сделать summary",
            description=shorten(str(e), INLINE_DESCRIPTION_LIMIT),
            input_message_content=InputTextMessageContent(message_text=str(e)),
        )

    await inline_query.answer([result], cache_time=1, is_personal=True)

async def transcribe_audio(file_path: str) -> str:
    """Transcribes audio using Groq Whisper model."""
    with open(file_path, "rb") as file:
        try:
            transcription = await groq_client.audio.transcriptions.create(
                file=(os.path.basename(file_path), file.read()),
                model="whisper-large-v3",
                response_format="text",
            )
        except Exception as e:
            logging.error("Transcription error: %s", e)
            raise UserVisibleError(explain_groq_error(e, "транскрибацию")) from e

    if not transcription or not transcription.strip():
        raise UserVisibleError(
            "❌ Groq обработал файл, но не нашел речи. Попробуй голосовое громче или без сильного шума."
        )

    return transcription

async def convert_to_whisper_mp3(input_path: str) -> str:
    """Extracts/normalizes Telegram media to MP3 before sending it to Whisper."""
    output_path = f"{os.path.splitext(input_path)[0]}_whisper.mp3"
    ffmpeg_path = get_ffmpeg_path()
    await ensure_media_has_audio_stream(input_path, ffmpeg_path)

    process = await asyncio.create_subprocess_exec(
        ffmpeg_path,
        "-y",
        "-i",
        input_path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "64k",
        output_path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()

    if process.returncode != 0:
        logging.error(
            "ffmpeg conversion failed: stdout=%s stderr=%s",
            stdout.decode(errors="ignore"),
            stderr.decode(errors="ignore"),
        )
        raise UserVisibleError(
            "❌ Не удалось извлечь аудио из файла. Telegram прислал медиа без аудиодорожки или файл поврежден."
        )

    return output_path

def get_youtube_info_sync(url: str) -> dict:
    base_options = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "noprogress": True,
        "retries": 3,
        "fragment_retries": 3,
        "socket_timeout": 20,
        **YOUTUBE_JS_OPTIONS,
    }
    return extract_youtube_with_fallbacks(url, base_options, download=False)

def find_downloaded_file(workdir: Path, extensions: tuple[str, ...]) -> Path:
    candidates = [
        path
        for path in workdir.iterdir()
        if path.is_file() and path.suffix.lower().lstrip(".") in extensions
    ]
    if not candidates:
        raise UserVisibleError("❌ Не нашёл скачанный файл после обработки.")
    return max(candidates, key=lambda path: path.stat().st_mtime)

def download_youtube_file_sync(url: str, file_format: str, workdir: Path) -> tuple[Path, dict]:
    ffmpeg_path = get_ffmpeg_path()
    ffmpeg_location = str(Path(ffmpeg_path).parent)
    output_template = str(workdir / "%(title).200B.%(ext)s")
    base_options = {
        "outtmpl": output_template,
        "noplaylist": True,
        "restrictfilenames": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "retries": 3,
        "fragment_retries": 3,
        "socket_timeout": 20,
        "ffmpeg_location": ffmpeg_location,
        **YOUTUBE_JS_OPTIONS,
    }

    if file_format == "mp3":
        format_options = {
            "format": "bestaudio/best",
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "192",
                }
            ],
        }
        extensions = ("mp3",)
    else:
        format_options = {
            "format": "bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/best[ext=mp4]/best",
            "merge_output_format": "mp4",
        }
        extensions = ("mp4",)

    options = {**base_options, **format_options}
    info = extract_youtube_with_fallbacks(url, options, download=True)

    return find_downloaded_file(workdir, extensions), info

def extract_youtube_with_fallbacks(url: str, options: dict, download: bool) -> dict:
    from yt_dlp import YoutubeDL

    register_ytdlp_jsc_plugin()
    options = apply_youtube_access_options(options)
    attempts = [
        (name, {**options, "extractor_args": extractor_args} if extractor_args else options)
        for name, extractor_args in YOUTUBE_CLIENT_FALLBACKS
    ]
    last_error: Exception | None = None

    for attempt_name, attempt_options in attempts:
        try:
            with YoutubeDL(attempt_options) as ydl:
                return ydl.extract_info(url, download=download)
        except Exception as e:
            last_error = e
            logging.warning("yt-dlp %s attempt failed: %s", attempt_name, type(e).__name__)

    if last_error:
        raise last_error
    raise UserVisibleError("❌ Не удалось обработать YouTube-ссылку.")

def register_ytdlp_jsc_plugin() -> None:
    try:
        import ytdlp_jsc.yt_dlp_plugins.extractor.ytdlp_jsc_plugin  # noqa: F401
    except Exception as e:
        logging.info("ytdlp-jsc plugin is not available: %s", type(e).__name__)

async def get_youtube_info(url: str) -> dict:
    try:
        return await asyncio.to_thread(get_youtube_info_sync, url)
    except UserVisibleError:
        raise
    except Exception as e:
        logging.error("YouTube info error: %s", type(e).__name__)
        raise UserVisibleError("❌ Не удалось проверить видео. Возможно, оно недоступно или YouTube заблокировал скачивание.") from e

async def download_youtube_file(url: str, file_format: str, workdir: Path) -> tuple[Path, dict]:
    try:
        return await asyncio.to_thread(download_youtube_file_sync, url, file_format, workdir)
    except UserVisibleError:
        raise
    except Exception as e:
        logging.error("YouTube download error: %s", type(e).__name__)
        raise UserVisibleError("❌ Не удалось скачать файл через YouTube/yt-dlp.") from e

def validate_youtube_duration(info: dict) -> None:
    duration = info.get("duration")
    if duration and duration > YOUTUBE_MAX_DURATION_SECONDS:
        minutes = round(duration / 60)
        raise UserVisibleError(f"❌ Видео слишком длинное: примерно {minutes} мин. Лимит — 20 минут.")

def validate_upload_size(file_path: Path) -> None:
    file_size = file_path.stat().st_size
    if file_size > TELEGRAM_MAX_UPLOAD_BYTES:
        size_mb = round(file_size / 1024 / 1024, 1)
        raise UserVisibleError(f"❌ Файл получился слишком большой: {size_mb} МБ. Лимит для отправки — около 49 МБ.")

async def send_youtube_file(message: Message, file_path: Path, info: dict, file_format: str) -> None:
    title = safe_filename_part(info.get("title") or "YouTube")
    input_file = FSInputFile(file_path, filename=f"{title}.{file_path.suffix.lstrip('.')}")

    if file_format == "mp3":
        await message.answer_audio(input_file, title=title)
    else:
        try:
            await message.answer_video(input_file, caption=title)
        except Exception:
            await message.answer_document(input_file, caption=title)

async def summarize_text(text: str) -> str:
    """Summarizes text using Groq Llama 3 model."""
    prompt = f"""
Сделай короткую полезную выжимку текста на русском языке.

Правила:
- Пиши только plain text. Не используй Markdown, звездочки, жирный текст, заголовки с разметкой или декоративные символы.
- Дай 2-5 коротких строк максимум.
- Не добавляй пустые разделы.
- Не начинай с мета-фраз вроде "Текст представляет собой", "В тексте говорится", "Говорящий сообщает".
- Не пиши фразы вроде "главная тема отсутствует" или "задач нет".
- Если в исходном тексте прямо есть явные поручения или дела на будущее со словами вроде "нужно", "надо", "сделай", "проверь", "задача", добавь строку "Задачи:" и перечисли их коротко.
- Если явных задач нет, вообще не упоминай задачи.
- Не считай задачей сам факт, что человек что-то тестирует, смотрит, показывает или рассказывает.
- Даже если текст короткий, бытовой или тестовый, все равно дай очень короткую суть одной простой строкой.
- Не пиши "summary не требуется".

Текст для анализа:
{text}
"""
    try:
        chat_completion = await groq_client.chat.completions.create(
            messages=[
                {
                    "role": "system",
                    "content": "Ты делаешь короткие plain-text выжимки без Markdown и не выдумываешь структуру там, где смысла мало."
                },
                {
                    "role": "user",
                    "content": prompt,
                }
            ],
            model="llama-3.3-70b-versatile",
            temperature=0.2,
            max_tokens=350,
        )
        return clean_summary(chat_completion.choices[0].message.content, text)
    except Exception as e:
        logging.error("Summarization error: %s", e)
        raise UserVisibleError(explain_groq_error(e, "создание summary")) from e

async def summarize_transcript_precisely(text: str) -> str:
    """Summarize a transcript action with stricter factual grounding."""
    prompt = f"""
Сделай точное summary расшифровки голосового сообщения на русском языке.

Главное правило: пересказывай только то, что прямо есть в расшифровке. Ничего не додумывай.

Правила:
- Пиши plain text без Markdown, звездочек и декоративных символов.
- Дай 2-4 содержательные строки. Можно чуть длиннее, если иначе теряется смысл.
- Сохраняй конкретику: кто что сделает, зачем, где, когда и почему — только если это сказано.
- Если расшифровка пронумерована как несколько аудио, учти все части и сохрани порядок смысла.
- Не превращай фразу в задачу, если человек просто объясняет ситуацию или намерение.
- Не обобщай до бессмысленной фразы вроде "создать эскиз и отправить", если в тексте есть важный контекст.
- Если есть явное следующее действие, можно написать строку "Дальше: ...".
- Если есть важная причина/ограничение, можно написать строку "Важно: ...".
- Не добавляй задачи, дедлайны, имена, выводы или детали, которых нет в тексте.
- Не пиши "задач нет", "summary не требуется" или мета-комментарии о тексте.

Расшифровка:
{text}
"""
    try:
        chat_completion = await groq_client.chat.completions.create(
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Ты делаешь фактологически точные summary голосовых. "
                        "Твоя главная задача — сохранить смысл и нюансы, не выдумывая ничего сверх расшифровки."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            model="llama-3.3-70b-versatile",
            temperature=0.1,
            max_tokens=500,
        )
        return clean_generated_text(chat_completion.choices[0].message.content, text)
    except Exception as e:
        logging.error("Precise summarization error: %s", e)
        raise UserVisibleError(explain_groq_error(e, "точное summary")) from e

async def transform_text(text: str, mode_id: str) -> str:
    """Transforms text according to the selected bot mode."""
    mode = get_mode(mode_id)
    if mode_id == DEFAULT_MODE_ID:
        return await summarize_text(text)

    prompt = f"""
{BASE_OUTPUT_RULES}

Режим: {mode['emoji']} {mode['title']}
Задача режима:
{mode['prompt']}

Исходная расшифровка:
{text}
"""
    try:
        chat_completion = await groq_client.chat.completions.create(
            messages=[
                {
                    "role": "system",
                    "content": "Ты преобразуешь расшифровки голосовых сообщений в готовый полезный текст строго по выбранному режиму.",
                },
                {
                    "role": "user",
                    "content": prompt,
                },
            ],
            model="llama-3.3-70b-versatile",
            temperature=0.25,
            max_tokens=900,
        )
        return clean_generated_text(chat_completion.choices[0].message.content, text)
    except Exception as e:
        logging.error("Mode transformation error: %s", e)
        raise UserVisibleError(explain_groq_error(e, f"режим {mode['title']}")) from e

async def transform_transcript_action(text: str, action_type: str) -> str:
    if action_type == "summary":
        return f"🧠 {await summarize_transcript_precisely(text)}"

    if action_type == "message":
        prompt = f"""
Преобразуй расшифровку голосового сообщения в готовое человеческое сообщение на русском языке.

Правила:
- Пиши только итоговое сообщение, без объяснений и Markdown.
- Сохрани смысл, намерение, тон и важные детали автора.
- Убери мусор устной речи: повторы, оговорки, паразитные слова, сбивчивые заходы.
- Исправь очевидные ошибки распознавания, если контекст однозначный.
- Не добавляй факты, обещания, сроки, имена, цифры или выводы, которых нет в расшифровке.
- Если расшифровка состоит из нескольких пронумерованных частей, объедини их в одно связное сообщение, сохранив порядок.
- Сделай текст естественным для Telegram: ясным, живым, без канцелярита.

Расшифровка:
{text}
"""
        system_message = "Ты редактор устных заметок: превращаешь speech-to-text в живой, точный Telegram-текст без выдумывания."
        action_name = "оформление сообщения"
        max_tokens = 1000
    elif action_type == "codex":
        prompt = f"""
Преврати расшифровку в подробный промт/ТЗ для Codex на русском языке.

Задача:
- Сделай промт, который можно сразу отправить Codex для реализации.
- Извлеки цель, контекст, ожидаемое поведение, ограничения, edge cases и критерии приёмки.
- Если в речи упомянуты файлы, папки, сервисы, команды, ошибки или окружение — явно сохрани их.
- Если данных не хватает, не выдумывай: добавь короткий раздел "Уточнить" с конкретными вопросами.
- Пиши структурно, но без декоративного Markdown: только понятные заголовки и списки.
- Формулируй требования как действия для агента: что проверить, что изменить, как протестировать.
- Добавь раздел "Проверка", где перечисли команды/сценарии, которые агент должен выполнить, если они следуют из контекста.

Расшифровка:
{text}
"""
        system_message = "Ты сильный технический постановщик задач для Codex: делаешь ясные, полные, проверяемые промты без фантазий."
        action_name = "создание промта для Codex"
        max_tokens = 1600
    elif action_type == "pdf_prompt":
        prompt = f"""
Преврати исходный текст в подробный промт/ТЗ для агента, который должен собрать аккуратный PDF-документ.

Задача:
- Сформулируй цель PDF и ожидаемый результат.
- Разложи содержание по разделам и логичному порядку страниц.
- Укажи, какие тексты, фото, таблицы, ссылки, подписи или приложения нужно включить, если они есть в исходнике.
- Если данных не хватает, добавь раздел "Уточнить" с конкретными вопросами.
- Добавь раздел "Проверка": что должно быть в готовом PDF и как понять, что он собран правильно.
- Не выдумывай факты, которых нет в исходном тексте.

Исходный текст:
{text}
"""
        system_message = "Ты постановщик задач для сборки PDF-документов: пишешь ясное ТЗ без фантазий."
        action_name = "создание промта для PDF"
        max_tokens = 1400
    elif action_type == "word_prompt":
        prompt = f"""
Преврати исходный текст в подробный промт/ТЗ для агента, который должен собрать редактируемый Word-файл .docx.

Задача:
- Сформулируй цель Word-документа и ожидаемый результат.
- Разложи содержание по заголовкам, подразделам, спискам и таблицам, если они уместны.
- Укажи, какие исходные материалы нужно перенести, очистить, структурировать или оставить дословно.
- Если данных не хватает, добавь раздел "Уточнить" с конкретными вопросами.
- Добавь раздел "Проверка": что должно быть в готовом .docx и как понять, что он собран правильно.
- Не выдумывай факты, которых нет в исходном тексте.

Исходный текст:
{text}
"""
        system_message = "Ты постановщик задач для сборки Word-документов: пишешь ясное ТЗ для редактируемого .docx."
        action_name = "создание промта для Word"
        max_tokens = 1400
    else:
        raise UserVisibleError("❌ Неизвестное действие для расшифровки.")

    try:
        chat_completion = await groq_client.chat.completions.create(
            messages=[
                {"role": "system", "content": system_message},
                {"role": "user", "content": prompt},
            ],
            model="llama-3.3-70b-versatile",
            temperature=0.25,
            max_tokens=max_tokens,
        )
        result = clean_generated_text(chat_completion.choices[0].message.content, text)
        if action_type == "message":
            return f"✍️ {result}"
        if action_type == "pdf_prompt":
            return f"📄 {result}"
        if action_type == "word_prompt":
            return f"📝 {result}"
        return f"💻 {result}"
    except Exception as e:
        logging.error("Transcript action error: %s", e)
        raise UserVisibleError(explain_groq_error(e, action_name)) from e

def build_mode_result_message(transcription: str, result: str, mode_id: str) -> str:
    mode = get_mode(mode_id)
    if mode["show_transcript"]:
        return build_result_message(transcription, result)
    return f"{mode['emoji']} {result.strip() if result else 'Короткое сообщение.'}"

def ensure_pdf_font_registered() -> str:
    if not PDF_FONT_PATH.exists():
        raise UserVisibleError("❌ Не найден шрифт для PDF. Нужно добавить assets/fonts/NotoSans-Regular.ttf.")

    try:
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
    except Exception as e:
        raise UserVisibleError("❌ Не установлены PDF-зависимости reportlab. Проверь requirements.txt.") from e

    font_name = "NotoSans"
    registered_fonts = set(pdfmetrics.getRegisteredFontNames())
    if font_name not in registered_fonts:
        pdfmetrics.registerFont(TTFont(font_name, str(PDF_FONT_PATH)))
    return font_name

def create_text_pdf(text: str, output_path: Path, title: str = "Текст") -> Path:
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.utils import simpleSplit
        from reportlab.pdfgen import canvas
    except Exception as e:
        raise UserVisibleError("❌ Не установлены PDF-зависимости reportlab. Проверь requirements.txt.") from e

    font_name = ensure_pdf_font_registered()
    page_width, page_height = A4
    margin = 48
    title_size = 16
    body_size = 12
    line_height = 17
    text_width = page_width - margin * 2

    c = canvas.Canvas(str(output_path), pagesize=A4)

    def begin_page() -> float:
        y_pos = page_height - margin
        c.setFont(font_name, title_size)
        c.drawString(margin, y_pos, title)
        y_pos -= 28
        c.setFont(font_name, body_size)
        return y_pos

    y = begin_page()
    paragraphs = text.splitlines() or [text]
    for paragraph in paragraphs:
        if not paragraph.strip():
            y -= line_height
            continue
        lines = simpleSplit(paragraph, font_name, body_size, text_width) or [paragraph]
        for line in lines:
            if y < margin:
                c.showPage()
                y = begin_page()
            c.drawString(margin, y, line)
            y -= line_height
        y -= 4

    c.save()
    return output_path

def normalize_export_text(text: str) -> str:
    cleaned = (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if len(cleaned) <= DOC_EXPORT_TEXT_LIMIT:
        return cleaned
    return (
        cleaned[:DOC_EXPORT_TEXT_LIMIT].rstrip()
        + "\n\n[Текст обрезан: документ получился слишком длинным для одного экспорта.]"
    )

def xml_safe_text(text: str) -> str:
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text or "")

def docx_paragraph_xml(text: str, bold: bool = False) -> str:
    text = xml_safe_text(text)
    if text == "":
        return "<w:p/>"
    run_props = "<w:rPr><w:b/></w:rPr>" if bold else ""
    return (
        "<w:p><w:r>"
        f"{run_props}<w:t xml:space=\"preserve\">{xml_escape(text)}</w:t>"
        "</w:r></w:p>"
    )

def create_text_docx(text: str, output_path: Path, title: str = "Текст") -> Path:
    body_parts = [docx_paragraph_xml(title, bold=True), "<w:p/>"]
    for line in (text.splitlines() or [text]):
        body_parts.append(docx_paragraph_xml(line))

    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body>"
        + "".join(body_parts)
        + (
            "<w:sectPr>"
            '<w:pgSz w:w="11906" w:h="16838"/>'
            '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" '
            'w:header="708" w:footer="708" w:gutter="0"/>'
            "</w:sectPr>"
        )
        + "</w:body></w:document>"
    )

    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="word/document.xml"/>'
        "</Relationships>"
    )

    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as docx:
        docx.writestr("[Content_Types].xml", content_types)
        docx.writestr("_rels/.rels", rels)
        docx.writestr("word/document.xml", document_xml)
    return output_path

async def send_text_export(
    status_msg: Message,
    text: str,
    file_format: str,
    owner_user_id: int | None,
    title: str = "Текст",
) -> None:
    body = normalize_export_text(text)
    if not body:
        await status_msg.edit_text("❌ Нет текста для файла.")
        return

    file_format = file_format.lower()
    if file_format not in {"pdf", "docx"}:
        await status_msg.edit_text("❌ Неизвестный формат файла.")
        return

    label = "PDF" if file_format == "pdf" else "Word"
    workdir = Path(TEMP_DIR) / f"export_{file_format}_{owner_user_id or 0}_{int(time.time())}_{uuid.uuid4().hex[:8]}"
    workdir.mkdir(parents=True, exist_ok=True)
    try:
        safe_title = safe_filename_part(title, fallback="text")
        output_path = workdir / f"{safe_title}_{time.strftime('%Y%m%d_%H%M%S')}.{file_format}"
        await status_msg.edit_text(f"⏳ Собираю {label}...")
        if file_format == "pdf":
            create_text_pdf(body, output_path, title=title)
        else:
            create_text_docx(body, output_path, title=title)

        validate_upload_size(output_path)
        await status_msg.edit_text(f"⏳ Отправляю {label}...")
        await status_msg.answer_document(
            FSInputFile(output_path, filename=output_path.name),
            caption=f"{label} с текстом готов.",
        )
        await status_msg.edit_text(f"✅ {label} готов. Отправил файлом ниже.")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

def flatten_png_alpha(image_path: Path, output_path: Path) -> Path:
    from PIL import Image

    with Image.open(image_path) as image:
        if image.mode not in ("RGBA", "LA") and "transparency" not in image.info:
            return image_path
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        background.alpha_composite(rgba)
        background.convert("RGB").save(output_path, "PNG")
    return output_path

def prepare_image_for_pdf(image_path: Path, workdir: Path) -> Path:
    file_ext = image_path.suffix.lower()
    if file_ext in {".heic", ".heif"}:
        try:
            from PIL import Image, ImageOps
            from pillow_heif import register_heif_opener
        except Exception as e:
            raise UserVisibleError("❌ Не установлена поддержка HEIC/HEIF. Проверь зависимость pillow-heif.") from e

        register_heif_opener()
        output_path = workdir / f"{image_path.stem}_heic.png"
        try:
            with Image.open(image_path) as image:
                image = ImageOps.exif_transpose(image)
                if image.mode not in ("RGB", "RGBA"):
                    image = image.convert("RGB")
                image.save(output_path, "PNG")
        except Exception as e:
            raise UserVisibleError("❌ Не удалось прочитать HEIC/HEIF фото. Попробуй отправить его как JPG или PNG.") from e
        return output_path

    if file_ext == ".png":
        return flatten_png_alpha(image_path, workdir / f"{image_path.stem}_flat.png")

    return image_path

def create_image_pdf(image_path: Path, output_path: Path, workdir: Path) -> Path:
    try:
        import img2pdf
    except Exception as e:
        raise UserVisibleError("❌ Не установлена PDF-зависимость img2pdf. Проверь requirements.txt.") from e

    prepared_image_path = prepare_image_for_pdf(image_path, workdir)
    try:
        try:
            rotation = getattr(img2pdf.Rotation, "ifvalid")
            pdf_bytes = img2pdf.convert(str(prepared_image_path), rotation=rotation)
        except (AttributeError, TypeError):
            pdf_bytes = img2pdf.convert(str(prepared_image_path))
        output_path.write_bytes(pdf_bytes)
    except Exception as e:
        raise UserVisibleError("❌ Не удалось добавить изображение в PDF. Попробуй отправить его в JPG или PNG.") from e
    return output_path

def image_mime_type(file_ext: str) -> str:
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
    }.get(file_ext.lower(), "image/jpeg")

def encoded_base64_length(path: Path) -> int:
    size = path.stat().st_size
    return ((size + 2) // 3) * 4

def ocr_cache_key(item: dict) -> str:
    return f"{item.get('file_id')}:{item.get('file_ext')}"

def create_ocr_jpeg_copy(image_path: Path, output_path: Path, max_side: int, quality: int) -> Path:
    try:
        from PIL import Image, ImageOps
        from pillow_heif import register_heif_opener
    except Exception as e:
        raise UserVisibleError("❌ Не установлена поддержка изображений для OCR. Проверь Pillow и pillow-heif.") from e

    try:
        register_heif_opener()
        with Image.open(image_path) as image:
            image = ImageOps.exif_transpose(image)
            if image.mode != "RGB":
                image = image.convert("RGB")
            image.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
            image.save(output_path, "JPEG", quality=quality, optimize=True)
    except Exception as e:
        raise UserVisibleError("❌ Не удалось подготовить изображение для OCR. Попробуй отправить JPG или PNG.") from e

    return output_path

def prepare_image_for_ocr(image_path: Path, workdir: Path) -> Path:
    file_ext = image_path.suffix.lower()
    if file_ext in {".jpg", ".jpeg", ".png"} and encoded_base64_length(image_path) <= OCR_MAX_BASE64_CHARS:
        return image_path

    attempts = (
        (2400, 90),
        (2000, 86),
        (1600, 82),
        (1200, 80),
    )
    for max_side, quality in attempts:
        output_path = workdir / f"{image_path.stem}_ocr_{max_side}_{quality}.jpg"
        create_ocr_jpeg_copy(image_path, output_path, max_side=max_side, quality=quality)
        if encoded_base64_length(output_path) <= OCR_MAX_BASE64_CHARS:
            return output_path

    raise UserVisibleError("❌ Изображение слишком большое для OCR. Отправь меньше фото или более лёгкий файл.")

def image_data_url(image_path: Path) -> str:
    encoded = base64.b64encode(image_path.read_bytes()).decode("utf-8")
    if len(encoded) > OCR_MAX_BASE64_CHARS:
        raise UserVisibleError("❌ Изображение слишком большое для OCR после подготовки.")
    return f"data:{image_mime_type(image_path.suffix)};base64,{encoded}"

def clean_ocr_text(text: str | None) -> str:
    cleaned_lines = []
    for line in (text or "").replace("```", "").splitlines():
        stripped = line.strip().strip("*")
        if stripped:
            cleaned_lines.append(stripped)
    cleaned = "\n".join(cleaned_lines).strip()
    lowered = cleaned.lower()
    no_text_markers = (
        "текст_не_распознан",
        "текст не распознан",
        "текста нет",
        "нет текста",
        "no text",
        "no readable text",
    )
    if not cleaned or any(marker in lowered for marker in no_text_markers):
        return ""
    return cleaned

async def ocr_image_path(image_path: Path) -> str:
    prompt = """
Распознай весь видимый текст на изображении.

Правила:
- Верни только распознанный текст, без описания картинки и без Markdown.
- Сохраняй исходный язык текста.
- Сохраняй важные переносы строк, номера, суммы, даты, имена, телефоны и ссылки.
- Не додумывай текст, которого не видно.
- Если читаемого текста нет, верни ровно: ТЕКСТ_НЕ_РАСПОЗНАН
"""
    try:
        chat_completion = await groq_client.chat.completions.create(
            messages=[
                {
                    "role": "system",
                    "content": "Ты OCR-модуль. Твоя задача — извлечь видимый текст с изображения без пересказа и фантазий.",
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {"url": image_data_url(image_path)},
                        },
                    ],
                },
            ],
            model=OCR_VISION_MODEL,
            temperature=0,
            max_completion_tokens=1800,
        )
        return clean_ocr_text(chat_completion.choices[0].message.content)
    except UserVisibleError:
        raise
    except Exception as e:
        logging.warning("Groq OCR error: %s", type(e).__name__)
        raise UserVisibleError(explain_groq_error(e, "OCR изображения")) from e

async def ocr_image_item(
    item: dict,
    image_index: int,
    ocr_cache: dict[str, dict],
    status_msg: Message | None = None,
) -> str:
    cache_key = ocr_cache_key(item)
    cached = ocr_cache.get(cache_key)
    if cached:
        if cached.get("ok"):
            return clean_material_text_value(cached.get("text"), 12000)
        raise UserVisibleError(f"❌ {cached.get('error') or 'OCR не сработал.'}")

    workdir = Path(TEMP_DIR) / f"ocr_{int(time.time())}_{uuid.uuid4().hex[:8]}"
    workdir.mkdir(parents=True, exist_ok=True)
    try:
        if status_msg:
            await status_msg.edit_text(f"⏳ OCR: скачиваю фото {image_index}...")
        image_path = await download_image_file_id(item["file_id"], item["file_ext"], workdir, image_index)
        prepared_path = prepare_image_for_ocr(image_path, workdir)
        if status_msg:
            await status_msg.edit_text(f"⏳ OCR: читаю фото {image_index}...")
        text = await ocr_image_path(prepared_path)
        ocr_cache[cache_key] = {"ok": True, "text": text}
        return text
    except UserVisibleError as e:
        error_text = clean_lead_value(str(e).removeprefix("❌ ").strip(), 240)
        ocr_cache[cache_key] = {"ok": False, "error": error_text}
        raise
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

def merge_pdf_parts(pdf_parts: list[Path], output_path: Path) -> Path:
    try:
        from pypdf import PdfReader, PdfWriter
    except Exception as e:
        raise UserVisibleError("❌ Не установлена PDF-зависимость pypdf. Проверь requirements.txt.") from e

    writer = PdfWriter()
    for part_path in pdf_parts:
        reader = PdfReader(str(part_path))
        for page in reader.pages:
            writer.add_page(page)
    with output_path.open("wb") as f:
        writer.write(f)
    return output_path

async def download_image_file_id(file_id: str, file_ext: str, workdir: Path, index: int) -> Path:
    file = await bot.get_file(file_id)
    if file.file_size and file.file_size > TELEGRAM_MAX_DOWNLOAD_BYTES:
        raise UserVisibleError("❌ Изображение слишком большое. Отправьте меньше фото или разбейте материалы на несколько пачек.")

    image_path = workdir / f"image_{index:03d}{file_ext}"
    try:
        await bot.download_file(file.file_path, destination=image_path)
    except Exception as e:
        logging.error("Telegram image download error: %s", e)
        raise UserVisibleError("❌ Не удалось скачать изображение из Telegram. Попробуй отправить его ещё раз.") from e
    return image_path

async def download_image_message(message: Message, workdir: Path, index: int) -> Path:
    image_info = get_image_file_id_and_ext(message)
    if not image_info:
        raise UserVisibleError("❌ Не нашёл изображение в сообщении.")

    file_id, file_ext = image_info
    return await download_image_file_id(file_id, file_ext, workdir, index)

def create_pdf_error_page(workdir: Path, index: int, error_text: str) -> Path:
    return create_text_pdf(error_text, workdir / f"error_{index:03d}.pdf", title="Ошибка обработки")

async def process_materials_pdf_items(items: list[dict], status_msg: Message, owner_user_id: int | None) -> None:
    workdir = Path(TEMP_DIR) / f"materials_{owner_user_id or 0}_{int(time.time())}_{uuid.uuid4().hex[:8]}"
    workdir.mkdir(parents=True, exist_ok=True)
    pdf_parts: list[Path] = []
    text_index = 0
    image_index = 0
    audio_index = 0
    total = len(items)

    try:
        for index, item in enumerate(items, start=1):
            try:
                item_type = item.get("type")

                if item_type == "text":
                    text = clean_material_text_value(item.get("text"), 6000)
                    text_index += 1
                    await status_msg.edit_text(f"⏳ Добавляю текст {text_index} в PDF...")
                    pdf_parts.append(
                        create_text_pdf(
                            text,
                            workdir / f"text_{index:03d}_{text_index:03d}.pdf",
                            title=f"Текст {text_index}",
                        )
                    )

                if item_type == "image":
                    image_index += 1
                    await status_msg.edit_text(f"⏳ Скачиваю фото {image_index}...")
                    image_path = await download_image_file_id(item["file_id"], item["file_ext"], workdir, image_index)
                    await status_msg.edit_text(f"⏳ Добавляю фото {image_index} в PDF...")
                    pdf_parts.append(create_image_pdf(image_path, workdir / f"image_{index:03d}_{image_index:03d}.pdf", workdir))

                    caption = clean_material_text_value(item.get("caption"), 6000)
                    if caption:
                        text_index += 1
                        pdf_parts.append(
                            create_text_pdf(
                                caption,
                                workdir / f"caption_{index:03d}_{text_index:03d}.pdf",
                                title=f"Подпись к фото {image_index}",
                            )
                        )

                if item_type == "audio":
                    audio_index += 1
                    caption = clean_material_text_value(item.get("caption"), 6000)
                    if caption:
                        text_index += 1
                        pdf_parts.append(
                            create_text_pdf(
                                caption,
                                workdir / f"media_caption_{index:03d}_{text_index:03d}.pdf",
                                title=f"Комментарий к аудио {audio_index}",
                            )
                        )
                    await status_msg.edit_text(f"⏳ Транскрибирую аудио {audio_index}...")
                    transcription = await transcribe_media_file_id(item["file_id"], item["file_ext"])
                    pdf_parts.append(
                        create_text_pdf(
                            transcription,
                            workdir / f"audio_{index:03d}_{audio_index:03d}.pdf",
                            title=f"Расшифровка аудио {audio_index}",
                        )
                    )
            except UserVisibleError as e:
                if total == 1:
                    await status_msg.edit_text(str(e))
                    return
                pdf_parts.append(create_pdf_error_page(workdir, index, str(e).removeprefix("❌ ").strip()))
            except Exception as e:
                logging.exception("Failed to add material to PDF")
                if total == 1:
                    await status_msg.edit_text(f"❌ Непредвиденная ошибка при сборке PDF: {type(e).__name__}. Подробности записаны в лог сервера.")
                    return
                pdf_parts.append(create_pdf_error_page(workdir, index, f"Не удалось обработать материал {index}: {type(e).__name__}"))

        if not pdf_parts:
            await status_msg.edit_text("❌ Не нашёл материалов для PDF.")
            return

        await status_msg.edit_text("⏳ Собираю PDF...")
        output_pdf = workdir / f"materials_{time.strftime('%Y%m%d_%H%M%S')}.pdf"
        merge_pdf_parts(pdf_parts, output_pdf)

        if output_pdf.stat().st_size > TELEGRAM_MAX_UPLOAD_BYTES:
            await status_msg.edit_text("❌ PDF получился слишком большой. Отправьте меньше фото или разбейте материалы на несколько пачек.")
            return

        await status_msg.edit_text("⏳ Отправляю PDF...")
        await status_msg.answer_document(
            FSInputFile(output_pdf),
            caption="PDF с материалами готов.",
        )
        await status_msg.edit_text("✅ PDF готов. Отправил файлом ниже.")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

async def process_materials_pdf_batch(messages: list[Message], status_msg: Message, owner_user_id: int | None) -> None:
    await process_materials_pdf_items(material_items_from_messages(messages), status_msg, owner_user_id)

async def collect_material_text(
    items: list[dict],
    status_msg: Message | None = None,
    ocr_enabled: bool = False,
    ocr_cache: dict[str, dict] | None = None,
) -> str:
    lines: list[str] = []
    text_index = 0
    image_index = 0
    audio_index = 0
    audio_total = sum(1 for item in items if item.get("type") == "audio")
    image_total = sum(1 for item in items if item.get("type") == "image")
    ocr_cache = ocr_cache if ocr_cache is not None else {}

    if ocr_enabled and image_total > OCR_MAX_IMAGES_PER_ACTION:
        raise UserVisibleError(
            f"❌ Для OCR максимум {OCR_MAX_IMAGES_PER_ACTION} фото за раз. "
            "Разбей материалы на несколько пачек или сделай PDF без OCR."
        )

    for item in items:
        item_type = item.get("type")
        if item_type == "text":
            text_index += 1
            text = clean_material_text_value(item.get("text"), 6000)
            if text:
                title = f"Текст {text_index}:" if len(items) > 1 else ""
                lines.append(f"{title}\n{text}".strip())

        elif item_type == "image":
            image_index += 1
            caption = clean_material_text_value(item.get("caption"), 6000)
            if not ocr_enabled:
                lines.append(f"[Фото {image_index}]")
            if caption:
                lines.append(f"Подпись к фото {image_index}:\n{caption}")
            if ocr_enabled:
                try:
                    ocr_text = await ocr_image_item(item, image_index, ocr_cache, status_msg)
                except UserVisibleError as e:
                    error_text = clean_lead_value(str(e).removeprefix("❌ ").strip(), 180)
                    lines.append(f"Фото {image_index}: OCR не сработал ({error_text})")
                else:
                    if ocr_text:
                        lines.append(f"OCR фото {image_index}:\n{ocr_text}")
                    else:
                        lines.append(f"Фото {image_index}: текст не распознан")

        elif item_type == "audio":
            audio_index += 1
            caption = clean_material_text_value(item.get("caption"), 6000)
            if caption:
                lines.append(f"Комментарий к аудио {audio_index}:\n{caption}")
            if status_msg:
                await status_msg.edit_text(f"⏳ Транскрибирую аудио {audio_index}/{audio_total}...")
            transcription = await transcribe_media_file_id(item["file_id"], item["file_ext"])
            if audio_total == 1 and len(items) == 1:
                lines.append(transcription)
            else:
                lines.append(f"Аудио {audio_index}:\n{transcription}")

    return "\n\n".join(line for line in lines if line.strip()).strip()

@dp.message(F.voice | F.audio | F.video_note | F.video)
async def handle_media_messages(message: Message):
    """
    Handles voice, audio, video, and video_note messages.
    """
    if message.chat.type == "private" and message.from_user:
        await queue_private_content_message(message)
        return

    status_msg = await message.answer("⏳ Обрабатываю аудио...")
    await process_media_batch([message], status_msg, message.from_user.id if message.from_user else None)

@dp.message(F.photo | F.document)
async def handle_image_messages(message: Message):
    if message.chat.type != "private" or not message.from_user:
        return
    if (message.document and _v3_is_pdf(message.document)
            and is_v3_enabled(message.from_user.id) and v3_is_god_user(message.from_user)):
        await v3_handle_pdf(message)
        return
    if is_media_document_message(message):
        await queue_private_content_message(message)
        return
    if not is_image_message(message):
        return
    await queue_private_content_message(message)

async def queue_private_content_message(message: Message) -> None:
    key = media_batch_key(message)
    lock = get_content_batch_lock(key)
    should_create_status = False
    status_msg: Message | None = None
    messages: list[Message] = []

    async with lock:
        batch = content_batches.get(key)
        if not batch:
            batch = {
                "messages": [],
                "status_msg": None,
                "task": None,
                "user_id": message.from_user.id,
            }
            content_batches[key] = batch
            should_create_status = True

        batch["messages"].append(message)
        messages = list(batch["messages"])
        status_msg = batch.get("status_msg")

        task = batch.get("task")
        if task:
            task.cancel()
        if status_msg is not None:
            batch["task"] = asyncio.create_task(flush_content_batch_after_delay(key))

    if should_create_status:
        status_msg = await message.answer("⏳ Собираю материалы...")
        async with lock:
            current_batch = content_batches.get(key)
            if current_batch and current_batch.get("status_msg") is None:
                current_batch["status_msg"] = status_msg
                messages = list(current_batch["messages"])
                task = current_batch.get("task")
                if task:
                    task.cancel()
                current_batch["task"] = asyncio.create_task(flush_content_batch_after_delay(key))

    if status_msg:
        with suppress(Exception):
            await status_msg.edit_text(build_content_batch_status(messages))

async def flush_content_batch_after_delay(key: str) -> None:
    try:
        await asyncio.sleep(CONTENT_BATCH_DELAY_SECONDS)
        lock = get_content_batch_lock(key)
        async with lock:
            batch = content_batches.pop(key, None)
        if not batch:
            return
        status_msg = batch.get("status_msg")
        if status_msg is None:
            first_message = batch["messages"][0]
            status_msg = await first_message.answer("⏳ Обрабатываю материалы...")
        if not should_build_pdf_for_batch(batch["messages"]):
            await process_media_batch(batch["messages"], status_msg, batch.get("user_id"))
            return
        items = material_items_from_messages(batch["messages"])
        ocr_enabled = is_ocr_enabled(batch.get("user_id"))
        stored_action = store_material_action(
            batch.get("user_id"),
            status_msg.chat.id,
            items,
            ocr_enabled=ocr_enabled,
        )
        if not stored_action:
            await status_msg.edit_text("❌ Не нашёл материалов для обработки.")
            return
        action_id, reply_markup = stored_action
        header = "OCR-версия включена. Что сделать с материалами?" if ocr_enabled else "Что сделать с материалами?"
        await status_msg.edit_text(
            f"{header}\n\n"
            f"Собрал: {format_material_counts(items)}.\n"
            "Кнопки активны 60 минут.",
            reply_markup=reply_markup,
        )
        if is_v3_enabled(batch.get("user_id")):
            with suppress(Exception):
                await v3_offer_for_material(status_msg, batch.get("user_id"), items)
    except asyncio.CancelledError:
        return
    except Exception:
        logging.exception("Failed to flush content batch")
    finally:
        if key not in content_batches:
            content_batch_locks.pop(key, None)

async def process_media_batch(messages: list[Message], status_msg: Message, owner_user_id: int | None) -> None:
    transcriptions: list[str] = []
    successful_transcriptions: list[str] = []
    total = len(messages)

    for index, media_message in enumerate(messages, start=1):
        try:
            if total > 1:
                await status_msg.edit_text(f"⏳ Транскрибирую аудио {index}/{total}...")
            transcription = await transcribe_media_message(media_message, status_msg if total == 1 else None)
            transcriptions.append(transcription)
            successful_transcriptions.append(transcription)
        except UserVisibleError as e:
            if total == 1:
                await status_msg.edit_text(str(e))
                return
            transcriptions.append(f"❌ Не удалось обработать: {str(e).removeprefix('❌ ').strip()}")
        except Exception as e:
            logging.exception("Error handling media item")
            if total == 1:
                await status_msg.edit_text(f"❌ Непредвиденная ошибка при обработке файла: {type(e).__name__}. Подробности записаны в лог сервера.")
                return
            transcriptions.append(f"❌ Не удалось обработать: {type(e).__name__}")

    result_message = build_transcript_message(transcriptions)
    action_text = build_transcript_message(successful_transcriptions) if successful_transcriptions else ""
    base_markup = store_transcript_action(owner_user_id, action_text)
    if is_v3_enabled(owner_user_id):
        last_user_images.pop(owner_user_id, None)
        if action_text.strip():
            v3_memory_add(owner_user_id, "audio", action_text)
    reply_markup = build_content_keyboard(owner_user_id, action_text, base_markup)
    chunks = split_text(result_message)

    if not chunks:
        await status_msg.edit_text("❌ Расшифровка не получилась.")
        return

    if len(chunks) == 1:
        await status_msg.edit_text(chunks[0], reply_markup=reply_markup)
    else:
        await status_msg.edit_text(chunks[0])
        for index, chunk in enumerate(chunks[1:], start=1):
            await status_msg.answer(
                chunk,
                reply_markup=reply_markup if index == len(chunks) - 1 else None,
            )

async def transcribe_media_file_id(file_id: str, file_ext: str, status_msg: Message | None = None) -> str:
    file_path = None
    whisper_file_path = None
    try:
        file = await bot.get_file(file_id)
        if file.file_size and file.file_size > TELEGRAM_MAX_DOWNLOAD_BYTES:
            raise UserVisibleError(
                "❌ Файл слишком большой для скачивания через Telegram Bot API.\n\n"
                f"Размер файла: {format_size_mb(file.file_size)}.\n"
                f"Текущий лимит скачивания для бота: {format_size_mb(TELEGRAM_MAX_DOWNLOAD_BYTES)}.\n\n"
                "Отправь файл короче/легче, сожми видео или отправь только аудио/голосовое."
            )

        safe_id = hashlib.sha256(f"{file_id}:{time.time()}".encode("utf-8")).hexdigest()[:16]
        file_path = os.path.join(TEMP_DIR, f"{safe_id}{file_ext}")
        
        try:
            if status_msg:
                await status_msg.edit_text("⏳ Скачиваю файл...")
            await bot.download_file(file.file_path, destination=file_path)
        except Exception as e:
            logging.error("Telegram download error: %s", e)
            raise UserVisibleError("❌ Не удалось скачать файл из Telegram. Попробуй отправить его еще раз.") from e
        
        if status_msg:
            await status_msg.edit_text("⏳ Подготавливаю аудио...")
        whisper_file_path = await convert_to_whisper_mp3(file_path)

        if status_msg:
            await status_msg.edit_text("⏳ Транскрибирую аудио через Groq Whisper...")
        return await transcribe_audio(whisper_file_path)
    finally:
        if file_path and os.path.exists(file_path):
            os.remove(file_path)
        if whisper_file_path and os.path.exists(whisper_file_path):
            os.remove(whisper_file_path)

async def transcribe_media_message(message: Message, status_msg: Message | None = None) -> str:
    media_info = get_media_file_id_and_ext(message)
    if not media_info:
        raise UserVisibleError("❌ Не нашёл аудио или видео в сообщении.")
    file_id, file_ext = media_info
    return await transcribe_media_file_id(file_id, file_ext, status_msg)

async def health_handler(request):
    cookies_configured = bool(YOUTUBE_COOKIES_TEXT.strip() or YOUTUBE_COOKIES_BASE64.strip())
    proxy_configured = bool(YOUTUBE_PROXY.strip())
    return web.Response(
        text=(
            f"Bot is running! {APP_VERSION}\n"
            f"youtube_cookies={'yes' if cookies_configured else 'no'}\n"
            f"youtube_proxy={'yes' if proxy_configured else 'no'}"
        )
    )

async def debug_status_handler(request: web.Request):
    secret = request.match_info.get("secret", "")
    if not hmac.compare_digest(secret, WEBHOOK_SECRET):
        return web.json_response({"ok": False, "error": "forbidden"}, status=403)

    cookies_configured = bool(YOUTUBE_COOKIES_TEXT.strip() or YOUTUBE_COOKIES_BASE64.strip())
    proxy_configured = bool(YOUTUBE_PROXY.strip())
    state_ok = state_db_ok()
    state_size = STATE_DB_PATH.stat().st_size if STATE_DB_PATH.exists() else 0
    return web.json_response(
        {
            "ok": True,
            "version": APP_VERSION,
            "fly_app": FLY_APP_NAME,
            "webhook_base_host": urlparse(WEBHOOK_BASE_URL).netloc,
            "webhook_path_configured": bool(WEBHOOK_PATH),
            "state": {
                "db_path": str(STATE_DB_PATH),
                "db_ok": state_ok,
                "db_size_bytes": state_size,
                "pending_leads": pending_leads_count(),
                "transcript_actions_memory": len(transcript_actions),
                "material_actions_memory": len(material_actions),
                "processed_updates_memory": len(processed_update_ids),
                "content_batches_memory": len(content_batches),
            },
            "config": {
                "groq_api_key": bool(GROQ_API_KEY),
                "telegram_bot_token": bool(TELEGRAM_BOT_TOKEN),
                "lead_form_secret": bool(LEAD_FORM_SECRET),
                "leads_chat_id": bool(get_leads_chat_id()),
                "youtube_cookies": cookies_configured,
                "youtube_proxy": proxy_configured,
                "anthropic_api_key": bool(ANTHROPIC_API_KEY),
                "github_token": bool(GITHUB_TOKEN),
            },
            "limits": {
                "telegram_download_mb": round(TELEGRAM_MAX_DOWNLOAD_BYTES / 1024 / 1024, 1),
                "telegram_upload_mb": round(TELEGRAM_MAX_UPLOAD_BYTES / 1024 / 1024, 1),
                "ocr_images_per_action": OCR_MAX_IMAGES_PER_ACTION,
            },
        }
    )

async def youtube_debug_handler(request: web.Request):
    secret = request.match_info.get("secret", "")
    if not hmac.compare_digest(secret, WEBHOOK_SECRET):
        return web.json_response({"ok": False, "error": "forbidden"}, status=403)

    url = request.query.get("url", "").strip()
    file_format = request.query.get("format", "mp3").strip().lower()
    should_download = request.query.get("download", "1") != "0"
    if not url or not is_youtube_url(url):
        return web.json_response({"ok": False, "error": "bad_youtube_url"}, status=400)
    if file_format not in {"mp3", "mp4"}:
        return web.json_response({"ok": False, "error": "bad_format"}, status=400)

    workdir = Path(TEMP_DIR) / f"youtube_debug_{youtube_error_id()}"
    workdir.mkdir(parents=True, exist_ok=True)
    stage = "info"
    try:
        info = await get_youtube_info(url)
        validate_youtube_duration(info)
        result = {
            "ok": True,
            "version": APP_VERSION,
            "cookies": bool(YOUTUBE_COOKIES_TEXT.strip() or YOUTUBE_COOKIES_BASE64.strip()),
            "proxy": bool(YOUTUBE_PROXY.strip()),
            "id": info.get("id"),
            "title": info.get("title"),
            "duration": info.get("duration"),
        }
        if should_download:
            stage = "download"
            file_path, download_info = await download_youtube_file(url, file_format, workdir)
            validate_upload_size(file_path)
            result.update(
                {
                    "download_ok": True,
                    "format": file_format,
                    "file_size": file_path.stat().st_size,
                    "format_id": download_info.get("format_id"),
                    "ext": file_path.suffix.lstrip("."),
                }
            )
        return web.json_response(result)
    except Exception as e:
        error_id = record_youtube_error(
            user_id=None,
            url=url,
            file_format=file_format,
            stage=stage,
            error=e,
        )
        return web.json_response(
            {
                "ok": False,
                "version": APP_VERSION,
                "cookies": bool(YOUTUBE_COOKIES_TEXT.strip() or YOUTUBE_COOKIES_BASE64.strip()),
                "proxy": bool(YOUTUBE_PROXY.strip()),
                "stage": stage,
                "error_id": error_id,
                "error_type": type(getattr(e, "__cause__", None) or e).__name__,
                "message": compact_error_text(e),
            },
            status=500,
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

async def lead_handler(request: web.Request):
    if request.method == "OPTIONS":
        return web.Response(status=204)

    if LEAD_FORM_SECRET:
        secret_header = request.headers.get("X-Lead-Secret", "")
        if not hmac.compare_digest(secret_header, LEAD_FORM_SECRET):
            return web.json_response({"ok": False, "error": "forbidden"}, status=403)

    leads_chat_id = get_leads_chat_id()
    if not leads_chat_id:
        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid_json"}, status=400)

        if not isinstance(payload, dict):
            return web.json_response({"ok": False, "error": "invalid_payload"}, status=400)

        validation_error = validate_lead_payload(payload)
        if validation_error:
            return web.json_response({"ok": False, "error": validation_error}, status=400)

        append_pending_lead(payload)
        logging.warning("Lead queued because leads chat id is missing")
        return web.json_response({"ok": True, "queued": True, "reason": "leads_chat_id_missing"})

    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid_json"}, status=400)

    if not isinstance(payload, dict):
        return web.json_response({"ok": False, "error": "invalid_payload"}, status=400)

    validation_error = validate_lead_payload(payload)
    if validation_error:
        return web.json_response({"ok": False, "error": validation_error}, status=400)

    try:
        await bot.send_message(
            chat_id=leads_chat_id,
            text=format_lead_message(payload),
            disable_web_page_preview=True,
        )
    except Exception as e:
        logging.exception("Failed to send lead")
        return web.json_response({"ok": False, "error": type(e).__name__}, status=502)

    return web.json_response({"ok": True})

def accept_update_once(update_id: int | None) -> bool:
    if update_id is None:
        return True
    now = time.time()
    expired_ids = [
        stored_update_id
        for stored_update_id, stored_at in processed_update_ids.items()
        if now - stored_at > PROCESSED_UPDATE_TTL_SECONDS
    ]
    for stored_update_id in expired_ids:
        processed_update_ids.pop(stored_update_id, None)
    if update_id in processed_update_ids:
        return False
    processed_update_ids[update_id] = now
    return True

async def telegram_webhook_handler(request: web.Request):
    secret_header = request.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
    if not hmac.compare_digest(secret_header, WEBHOOK_SECRET):
        return web.Response(status=403, text="Forbidden")

    try:
        update_data = await request.json()
        update_id = update_data.get("update_id") if isinstance(update_data, dict) else None
        if not accept_update_once(update_id):
            logging.info("Duplicate Telegram update ignored: %s", update_id)
            return web.Response(text="OK")
        update = Update.model_validate(update_data, context={"bot": bot})
        asyncio.create_task(process_webhook_update(update))
    except Exception:
        logging.exception("Failed to accept Telegram webhook update")

    return web.Response(text="OK")

async def process_webhook_update(update: Update):
    try:
        await dp.feed_update(bot, update)
    except Exception:
        logging.exception("Failed to process Telegram webhook update")

async def sync_bot_profile() -> None:
    try:
        await bot.set_my_name(name=BOT_PROFILE_NAME)
        await bot.set_my_short_description(short_description=BOT_PROFILE_SHORT_DESCRIPTION)
        await bot.set_my_description(description=BOT_PROFILE_DESCRIPTION)
        logging.info("Telegram bot profile synced")
    except Exception:
        logging.exception("Failed to sync Telegram bot profile")

async def on_startup(app: web.Application):
    state_db_ok()
    v3_load_reminders()
    app["v3_reminder_task"] = asyncio.create_task(v3_reminder_loop())
    await sync_bot_profile()
    await bot.set_webhook(
        WEBHOOK_URL,
        secret_token=WEBHOOK_SECRET,
        allowed_updates=dp.resolve_used_update_types(),
        drop_pending_updates=False,
    )
    logging.info("Telegram webhook set: %s", WEBHOOK_URL)

async def on_shutdown(app: web.Application):
    await bot.session.close()

def main() -> None:
    app = web.Application()
    app.router.add_get("/", health_handler)
    app.router.add_get(f"{DEBUG_STATUS_PREFIX}{{secret}}", debug_status_handler)
    app.router.add_get(f"{YOUTUBE_DEBUG_PREFIX}{{secret}}", youtube_debug_handler)
    app.router.add_post("/lead", lead_handler)
    app.router.add_options("/lead", lead_handler)
    app.router.add_post(WEBHOOK_PATH, telegram_webhook_handler)
    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)

    port = int(os.environ.get("PORT", 10000))
    logging.info("Starting webhook server on port %s", port)
    web.run_app(app, host="0.0.0.0", port=port)

if __name__ == "__main__":
    main()
