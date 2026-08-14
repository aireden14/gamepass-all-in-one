#!/usr/bin/env python3
"""vibecod-relay — always-on cloud front door for the @Myvibecodbot Telegram bot.

Why this exists: the real bot (`tg-mac-agent`) lives on the user's Mac, so when
the Mac is off or asleep the bot is gone and Telegram messages get no reply at
all. This tiny relay owns the Telegram webhook (always online on Fly) and:

  * queues every incoming update durably (SQLite on a Fly volume);
  * hands the queue to the Mac, which long-polls `GET /pull` — that request is
    itself the "Mac is alive" signal;
  * when the Mac has not pulled recently, replies to the owner immediately with
    a polite "saved, will run when the Mac is back" note (throttled).

Telegram's 409 conflict is only about *receiving* updates, so the Mac keeps
sending its own replies straight to Telegram — the relay never touches outbound
traffic except for the offline courtesy note.
"""

import asyncio
import hashlib
import hmac
import json
import os
import sqlite3
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qsl

import aiohttp
from aiohttp import web

BOT_TOKEN = os.environ["BOT_TOKEN"]
PULL_SECRET = os.environ["PULL_SECRET"]
# setWebhook secret_token — Telegram echoes it back in a header, so random
# internet POSTs to the webhook path are rejected.
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", PULL_SECRET)
# Only the owner gets the polite offline auto-reply (0 = reply to anyone).
ALLOWED_ID = int(os.environ.get("ALLOWED_ID", "0") or "0")
DB_PATH = os.environ.get("RELAY_DB", "/data/relay.db")
PORT = int(os.environ.get("PORT", "8080"))
STATIC_DIR = Path(__file__).parent / "static"
# Снимок «живых сессий», отправленный с Мака, считается протухшим после этого.
SESSIONS_MAX_AGE = 3600.0
# initData из Telegram WebApp считаем валидным не дольше суток с auth_date.
INIT_DATA_MAX_AGE = 86400
COMMAND_LEASE_SECONDS = 180.0
COMMAND_RESULT_MAX_AGE = 7 * 86400.0

AGENT_COMMANDS = {"agent_message", "agent_stop", "agent_provider", "agent_new"}
TORRENT_COMMANDS = {
    "torrent_open", "torrent_pause", "torrent_seek", "torrent_volume",
    "torrent_fullscreen", "torrent_audio", "torrent_subs", "torrent_next",
    "torrent_prev", "torrent_close", "torrent_add", "torrent_play",
    "torrent_continue",
}

# Долгий poll: /pull держит соединение до этого времени, ожидая новых апдейтов.
LONGPOLL_SECONDS = 20.0
# Mac считается офлайн, если не тянул очередь дольше этого времени. ОБЯЗАТЕЛЬНО
# больше LONGPOLL_SECONDS: иначе пока мак висит на длинном poll'е, last_pull
# «стареет» и релай ложно считает живой мак офлайном (и шлёт зря извинение).
OFFLINE_AFTER = LONGPOLL_SECONDS + 15.0
# Не спамим вежливым автоответом чаще, чем раз в этот интервал.
NOTICE_THROTTLE = 45.0

OFFLINE_TEXT = (
    "😔 Сори, сервер на маке (ConteXt) сейчас недоступен — он выключен или спит.\n"
    "Я записал твоё сообщение и передам его боту сам, как только мак вернётся в сеть. "
    "Ничего повторять не нужно."
)


class Relay:
    def __init__(self, db_path: str = DB_PATH) -> None:
        self.db = sqlite3.connect(db_path)
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS updates ("
            " update_id INTEGER PRIMARY KEY,"
            " payload TEXT NOT NULL,"
            " created REAL NOT NULL)"
        )
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS web_commands ("
            " id TEXT PRIMARY KEY,"
            " user_id INTEGER NOT NULL,"
            " kind TEXT NOT NULL,"
            " payload TEXT NOT NULL,"
            " status TEXT NOT NULL,"
            " result TEXT,"
            " created REAL NOT NULL,"
            " updated REAL NOT NULL)"
        )
        self.db.execute(
            "CREATE INDEX IF NOT EXISTS web_commands_status_created "
            "ON web_commands(status, created)"
        )
        self.db.commit()
        self.last_pull = 0.0
        self.last_notice = 0.0
        # Пробуждает висящий /pull, как только приходит новый апдейт.
        self.new_update = asyncio.Event()
        # Живые сессии агентов, которые пушит Мак — не персистится,
        # это моментальный снимок, а не очередь.
        self.sessions: list[dict] = []
        self.torrent: dict = {"online": False, "players": [], "torrents": []}
        self.sessions_pushed_at = 0.0

    # ---- очередь ----

    def store(self, update: dict) -> None:
        update_id = int(update["update_id"])
        try:
            self.db.execute(
                "INSERT OR IGNORE INTO updates(update_id, payload, created) VALUES (?,?,?)",
                (update_id, json.dumps(update, ensure_ascii=False), time.time()),
            )
            self.db.commit()
        except sqlite3.Error:
            pass

    def pending(self, offset: int) -> list[dict]:
        cur = self.db.execute(
            "SELECT payload FROM updates WHERE update_id >= ? ORDER BY update_id LIMIT 100",
            (offset,),
        )
        return [json.loads(row[0]) for row in cur.fetchall()]

    def deliverable(self, offset: int) -> list[dict]:
        """Acknowledge old rows and return the next batch.

        Telegram update ids are normally monotonic, but they can be reset after
        a quiet period. More importantly, a synthetic smoke-test update must
        never be able to move the Mac cursor so far ahead that genuine updates
        get deleted forever. If the client cursor is beyond every queued id by
        more than the normal ``last_id + 1`` acknowledgement, return the queue
        intact. The Mac notices the lower ids and repairs its local cursor.
        """
        bounds = self.db.execute(
            "SELECT MIN(update_id), MAX(update_id) FROM updates"
        ).fetchone()
        minimum, maximum = bounds if bounds else (None, None)
        if maximum is not None and offset > maximum + 1:
            return self.pending(int(minimum))
        self.confirm(offset)
        return self.pending(offset)

    def confirm(self, offset: int) -> None:
        """Мак подтверждает обработку всего, что строго меньше offset."""
        if offset <= 0:
            return
        self.db.execute("DELETE FROM updates WHERE update_id < ?", (offset,))
        self.db.commit()

    # ---- durable Mini App command queue ----

    def enqueue_command(self, user_id: int, kind: str, payload: dict) -> dict:
        now = time.time()
        command_id = str(uuid.uuid4())
        self.db.execute(
            "INSERT INTO web_commands(id,user_id,kind,payload,status,result,created,updated) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (command_id, user_id, kind, json.dumps(payload, ensure_ascii=False),
             "queued", None, now, now),
        )
        self.db.execute("DELETE FROM web_commands WHERE updated < ?", (now - COMMAND_RESULT_MAX_AGE,))
        self.db.commit()
        return {"id": command_id, "kind": kind, "status": "queued", "created": now}

    def pull_commands(self, limit: int = 10) -> list[dict]:
        now = time.time()
        # A Mac crash after claiming a command must not leave it spinning forever.
        # Native agent commands are idempotent by command id; player controls from
        # the UI use desired values for stateful toggles.
        self.db.execute(
            "UPDATE web_commands SET status='queued', updated=? "
            "WHERE status='running' AND updated < ?",
            (now, now - COMMAND_LEASE_SECONDS),
        )
        rows = self.db.execute(
            "SELECT id,user_id,kind,payload,created FROM web_commands "
            "WHERE status='queued' ORDER BY created LIMIT ?", (limit,)
        ).fetchall()
        if rows:
            self.db.executemany(
                "UPDATE web_commands SET status='running', updated=? WHERE id=? AND status='queued'",
                [(now, row[0]) for row in rows],
            )
        self.db.commit()
        return [
            {"id": row[0], "user_id": row[1], "kind": row[2],
             "payload": json.loads(row[3]), "created": row[4]}
            for row in rows
        ]

    def finish_command(self, command_id: str, ok: bool, result: str) -> bool:
        cur = self.db.execute(
            "UPDATE web_commands SET status=?, result=?, updated=? WHERE id=?",
            ("done" if ok else "error", result[:8000], time.time(), command_id),
        )
        self.db.commit()
        return cur.rowcount > 0

    def command_status(self, command_id: str, user_id: int) -> dict | None:
        row = self.db.execute(
            "SELECT id,kind,status,result,created,updated FROM web_commands "
            "WHERE id=? AND user_id=?", (command_id, user_id),
        ).fetchone()
        if not row:
            return None
        return {"id": row[0], "kind": row[1], "status": row[2],
                "result": row[3], "created": row[4], "updated": row[5]}

    @property
    def mac_online(self) -> bool:
        return time.time() - self.last_pull < OFFLINE_AFTER


relay: Relay


# ---- Telegram outbound (только вежливый автоответ) ----

async def send_message(chat_id: int, text: str) -> None:
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    try:
        async with aiohttp.ClientSession() as session:
            await session.post(url, json={"chat_id": chat_id, "text": text},
                               timeout=aiohttp.ClientTimeout(total=10))
    except Exception:
        pass


def owner_chat(update: dict) -> int | None:
    """chat_id владельца из «человеческого» апдейта (не callback/inline)."""
    msg = update.get("message") or update.get("edited_message")
    if not msg:
        return None
    frm = msg.get("from") or {}
    if ALLOWED_ID and frm.get("id") != ALLOWED_ID:
        return None
    chat = msg.get("chat") or {}
    return chat.get("id")


# ---- Telegram WebApp initData ----

def validate_init_data(init_data: str) -> dict | None:
    """Проверяет подпись initData по документированной Telegram-схеме и
    возвращает распарсенные поля, либо None если подпись/владелец не сошлись."""
    if not init_data:
        return None
    pairs = dict(parse_qsl(init_data, strict_parsing=False))
    received_hash = pairs.pop("hash", None)
    if not received_hash:
        return None
    data_check_string = "\n".join(sorted(k + "=" + v for k, v in pairs.items()))
    secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
    computed_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(computed_hash, received_hash):
        return None
    auth_date = pairs.get("auth_date")
    if auth_date and time.time() - int(auth_date) > INIT_DATA_MAX_AGE:
        return None
    if ALLOWED_ID:
        try:
            user = json.loads(pairs.get("user", "{}"))
        except json.JSONDecodeError:
            return None
        if user.get("id") != ALLOWED_ID:
            return None
    return pairs


def webapp_user_id(request: web.Request) -> int | None:
    pairs = validate_init_data(request.headers.get("X-Telegram-Init-Data", ""))
    if not pairs:
        return None
    try:
        return int(json.loads(pairs.get("user", "{}"))["id"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None


def validate_web_command(kind: object, payload: object) -> tuple[dict | None, str | None]:
    """Strict allowlist: the public Mini App can request only known local
    actions. It can never pass a shell command or arbitrary tpctl arguments."""
    if not isinstance(kind, str) or kind not in AGENT_COMMANDS | TORRENT_COMMANDS:
        return None, "unknown command"
    if not isinstance(payload, dict):
        return None, "bad payload"

    def string(name: str, *, required: bool = True, maximum: int = 400) -> str | None:
        value = payload.get(name)
        if value is None and not required:
            return None
        if not isinstance(value, str):
            raise ValueError(name)
        value = value.strip()
        if (required and not value) or len(value) > maximum:
            raise ValueError(name)
        return value

    def with_player(clean: dict) -> dict:
        player = payload.get("player")
        if player is None:
            return clean
        if isinstance(player, bool) or not isinstance(player, int) or not 0 <= player <= 20:
            raise ValueError("player")
        return {"player": player, **clean}

    try:
        if kind == "agent_message":
            return {"session_id": string("session_id"),
                    "text": string("text", maximum=12_000)}, None
        if kind == "agent_stop":
            return {"session_id": string("session_id")}, None
        if kind == "agent_provider":
            provider = string("provider")
            if provider not in {"claude", "claude_den", "codex"}:
                raise ValueError("provider")
            model = string("model", required=False)
            if model not in {None, "default", "fable", "opus", "sonnet", "haiku"}:
                raise ValueError("model")
            clean = {"session_id": string("session_id"), "provider": provider}
            if model is not None:
                clean["model"] = model
            return clean, None
        if kind == "agent_new":
            return {}, None
        if kind == "torrent_open":
            return {}, None
        if kind == "torrent_pause":
            mode = string("mode")
            if mode not in {"on", "off"}:
                raise ValueError("mode")
            return with_player({"mode": mode}), None
        if kind == "torrent_seek":
            seconds = payload.get("seconds")
            if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not -3600 <= seconds <= 3600:
                raise ValueError("seconds")
            return with_player({"seconds": float(seconds)}), None
        if kind == "torrent_volume":
            value = payload.get("value")
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 100:
                raise ValueError("value")
            return with_player({"value": float(value)}), None
        if kind == "torrent_fullscreen":
            mode = string("mode")
            if mode not in {"on", "off", "toggle"}:
                raise ValueError("mode")
            return with_player({"mode": mode}), None
        if kind in {"torrent_audio"}:
            direction = string("direction")
            if direction not in {"next", "prev"}:
                raise ValueError("direction")
            return with_player({"direction": direction}), None
        if kind == "torrent_subs":
            mode = string("mode")
            if mode not in {"on", "off", "toggle", "next", "prev"}:
                raise ValueError("mode")
            return with_player({"mode": mode}), None
        if kind in {"torrent_next", "torrent_prev", "torrent_close"}:
            return with_player({}), None
        if kind == "torrent_add":
            magnet = string("magnet", maximum=8000)
            mode = string("mode", required=False) or "stream"
            if not magnet.lower().startswith("magnet:?xt=urn:btih:") or mode not in {"stream", "download"}:
                raise ValueError("magnet")
            return {"magnet": magnet, "mode": mode}, None
        if kind == "torrent_play":
            file_index = payload.get("file_index")
            if isinstance(file_index, bool) or not isinstance(file_index, int) or file_index < 0:
                raise ValueError("file_index")
            return {"torrent_id": string("torrent_id"), "file_index": file_index}, None
        if kind == "torrent_continue":
            return {"name": string("name", required=False, maximum=300)}, None
    except ValueError as exc:
        return None, f"invalid field: {exc}"
    return None, "unknown command"


# ---- HTTP ----

async def handle_webhook(request: web.Request) -> web.Response:
    if request.match_info.get("secret") != WEBHOOK_SECRET:
        return web.Response(status=403, text="forbidden")
    header = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
    if header is not None and header != WEBHOOK_SECRET:
        return web.Response(status=403, text="forbidden")
    try:
        update = await request.json()
    except Exception:
        return web.Response(status=400, text="bad json")
    if "update_id" not in update:
        return web.Response(text="ok")

    relay.store(update)
    relay.new_update.set()

    # Мак офлайн → сразу вежливо отвечаем владельцу (с троттлингом).
    if not relay.mac_online:
        chat_id = owner_chat(update)
        now = time.time()
        if chat_id is not None and now - relay.last_notice > NOTICE_THROTTLE:
            relay.last_notice = now
            asyncio.create_task(send_message(chat_id, OFFLINE_TEXT))
    return web.Response(text="ok")


async def handle_pull(request: web.Request) -> web.Response:
    # Секрет — в заголовке (не в query), чтобы не светиться в access-логах.
    if request.headers.get("X-Relay-Secret") != PULL_SECRET:
        return web.Response(status=403, text="forbidden")
    offset = int(request.query.get("offset", "0") or "0")
    relay.last_pull = time.time()
    updates = relay.deliverable(offset)
    if updates:
        return web.json_response(updates)

    # Долгий poll: ждём новый апдейт или таймаут, чтобы не долбить сервер.
    relay.new_update.clear()
    try:
        await asyncio.wait_for(relay.new_update.wait(), timeout=LONGPOLL_SECONDS)
    except asyncio.TimeoutError:
        pass
    relay.last_pull = time.time()
    return web.json_response(relay.deliverable(offset))


async def handle_health(request: web.Request) -> web.Response:
    return web.json_response({
        "ok": True,
        "mac_online": relay.mac_online,
        "seconds_since_pull": round(time.time() - relay.last_pull, 1) if relay.last_pull else None,
    })


async def handle_sessions_push(request: web.Request) -> web.Response:
    """Мак пушит сюда снимок живых сессий агента (см. push_sessions_loop
    в apps/tg-mac-agent/bot.py). Тот же секрет, что и у /pull."""
    if request.headers.get("X-Relay-Secret") != PULL_SECRET:
        return web.Response(status=403, text="forbidden")
    try:
        body = await request.json()
    except Exception:
        return web.Response(status=400, text="bad json")
    sessions = body.get("sessions")
    if not isinstance(sessions, list):
        return web.Response(status=400, text="bad payload")
    torrent = body.get("torrent")
    if torrent is not None and not isinstance(torrent, dict):
        return web.Response(status=400, text="bad torrent payload")
    relay.sessions = sessions
    if torrent is not None:
        relay.torrent = torrent
    relay.sessions_pushed_at = time.time()
    return web.Response(text="ok")


async def handle_sessions_get(request: web.Request) -> web.Response:
    """Отдаёт снимок сессий Mini App'у. Авторизация — подпись initData
    от самого Telegram, не отдельный секрет."""
    if webapp_user_id(request) is None:
        return web.Response(status=403, text="forbidden")
    if time.time() - relay.sessions_pushed_at > SESSIONS_MAX_AGE:
        return web.json_response({"sessions": [], "torrent": {"online": False, "players": [], "torrents": []},
                                  "mac_online": relay.mac_online})
    return web.json_response({"sessions": relay.sessions, "torrent": relay.torrent,
                              "mac_online": relay.mac_online})


async def handle_command_create(request: web.Request) -> web.Response:
    user_id = webapp_user_id(request)
    if user_id is None:
        return web.Response(status=403, text="forbidden")
    try:
        body = await request.json()
    except Exception:
        return web.Response(status=400, text="bad json")
    clean, error = validate_web_command(body.get("kind"), body.get("payload", {}))
    if error:
        return web.json_response({"error": error}, status=400)
    command = relay.enqueue_command(user_id, body["kind"], clean or {})
    return web.json_response(command, status=202)


async def handle_command_status(request: web.Request) -> web.Response:
    user_id = webapp_user_id(request)
    if user_id is None:
        return web.Response(status=403, text="forbidden")
    command = relay.command_status(request.match_info["command_id"], user_id)
    if command is None:
        return web.Response(status=404, text="not found")
    return web.json_response(command)


async def handle_commands_pull(request: web.Request) -> web.Response:
    if request.headers.get("X-Relay-Secret") != PULL_SECRET:
        return web.Response(status=403, text="forbidden")
    return web.json_response(relay.pull_commands())


async def handle_command_result(request: web.Request) -> web.Response:
    if request.headers.get("X-Relay-Secret") != PULL_SECRET:
        return web.Response(status=403, text="forbidden")
    try:
        body = await request.json()
    except Exception:
        return web.Response(status=400, text="bad json")
    command_id = body.get("id")
    ok = body.get("ok")
    result = body.get("result", "")
    if not isinstance(command_id, str) or not isinstance(ok, bool) or not isinstance(result, str):
        return web.Response(status=400, text="bad payload")
    if not relay.finish_command(command_id, ok, result):
        return web.Response(status=404, text="not found")
    return web.Response(text="ok")


async def handle_index(request: web.Request) -> web.Response:
    return web.FileResponse(STATIC_DIR / "index.html")


def main() -> None:
    global relay
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    relay = Relay()
    app = web.Application()
    app.router.add_post("/tg/{secret}", handle_webhook)
    app.router.add_get("/pull", handle_pull)
    app.router.add_get("/health", handle_health)
    app.router.add_post("/sessions", handle_sessions_push)
    app.router.add_get("/api/sessions", handle_sessions_get)
    app.router.add_post("/api/commands", handle_command_create)
    app.router.add_get("/api/commands/{command_id}", handle_command_status)
    app.router.add_get("/commands/pull", handle_commands_pull)
    app.router.add_post("/commands/result", handle_command_result)
    if STATIC_DIR.exists():
        app.router.add_get("/", handle_index)
        app.router.add_static("/assets", STATIC_DIR / "assets")
    web.run_app(app, host="0.0.0.0", port=PORT, print=None)


if __name__ == "__main__":
    main()
