import eventlet
eventlet.monkey_patch()

from flask import Flask
from flask_cors import CORS
from flask_socketio import SocketIO
from routes import register_routes
from background import start_tts_worker
from utils.caddy import start_caddy
import logging

logging.basicConfig(level=logging.WARNING)
logging.getLogger("werkzeug").setLevel(logging.WARNING)
logging.getLogger("socketio").setLevel(logging.WARNING)
logging.getLogger("engineio").setLevel(logging.WARNING)

app = Flask(__name__, template_folder="templates")
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

# --- REGISTER ROUTES ---
register_routes(app, socketio)

# --- CADDY (OPTIONAL) ---
# if __name__ == "__main__":
#     caddy_proc = start_caddy()
#     start_tts_worker(socketio)
# 
#     try:
#         logging.warning("Starting ATS app on 0.0.0.0:80")
#         socketio.run(app, host="0.0.0.0", port=2137, debug=False)
#     finally:
#         logging.warning("Shutting down Caddy...")
#         if caddy_proc:
#             try:
#                 caddy_proc.terminate()
#             except Exception as e:
#                 logging.error(f"Error terminating Caddy: {e}")
# --- NO CADDY (DEFAULT) ---
if __name__ == '__main__':
    start_tts_worker(socketio)
    logging.warning('Starting ATS app on 0.0.0.0:80')
    socketio.run(app, host='0.0.0.0', port=80, debug=False)


