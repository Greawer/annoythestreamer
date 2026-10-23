import eventlet
eventlet.monkey_patch()

import os
import logging
import secrets
from flask import Flask
from flask_cors import CORS
from flask_socketio import SocketIO
from client import migrate_legacy_sound_actions
from routes import (
    registersocketiohandlers,
    registerroutes,
    register_legacy_assets,
    register_default_themes,
    seed_role_permissions,
    start_stream_points_worker,
)
from background import start_tts_worker

logging.basicConfig(level=logging.WARNING)
logging.getLogger("werkzeug").setLevel(logging.WARNING)
logging.getLogger("socketio").setLevel(logging.WARNING)
logging.getLogger("engineio").setLevel(logging.WARNING)

app = Flask(__name__, static_folder=None)
app.secret_key = os.getenv("ATS_SECRET_KEY") or secrets.token_hex(32)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.getenv("ATS_COOKIE_SECURE", "false").lower() == "true",
)
allowed_origins = os.getenv("ATS_ALLOWED_ORIGINS", "*")
allowed_origins = "*" if allowed_origins == "*" else [origin.strip() for origin in allowed_origins.split(",")]
CORS(app, origins=allowed_origins)
socketio = SocketIO(
    app,
    cors_allowed_origins=allowed_origins,
    async_mode="eventlet",
    ping_timeout=5,
    ping_interval=2,
    manage_session=False  # ADD THIS
)

registersocketiohandlers(socketio)
registerroutes(app, socketio)
seed_role_permissions()

if __name__ == "__main__":
    migrate_legacy_sound_actions()
    register_legacy_assets()
    register_default_themes()
    start_tts_worker(socketio)
    start_stream_points_worker(socketio)
    host = os.getenv("ATS_BACKEND_HOST", "127.0.0.1")
    port = int(os.getenv("ATS_BACKEND_PORT", "420"))
    logging.warning("Starting ATS backend on %s:%s", host, port)
    socketio.run(app, host=host, port=port, debug=False)