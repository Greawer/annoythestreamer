from flask import render_template, request, jsonify, send_from_directory
from flask_socketio import SocketIO
from bson.json_util import dumps
from client import add_facememe, last_facememe, add_normalmeme, last_normalmeme, add_ttsmeme, col_ttsmeme, col_chat
from datetime import datetime, timezone
import os
import logging
from collections import deque

MAX_MESSAGES = 50
last_messages = deque(maxlen=MAX_MESSAGES)

msgs = list(col_chat.find().sort("timestamp", -1).limit(MAX_MESSAGES))
msgs.reverse()
for m in msgs:
    last_messages.append({"user": m["user"], "message": m["message"]})

online_users = set()

def register_routes(app, socketio: SocketIO):
    # --- HTML PAGES ---
    @app.route("/")
    def index():
        return render_template("AnnoyTheStreamer.html")

    @app.route("/FaceMeme")
    def facememe():
        return render_template("FaceMeme.html")

    @app.route("/NormalMeme")
    def normalmeme():
        return render_template("NormalMeme.html")

    @app.route("/TTSMeme")
    def ttsmeme():
        return render_template("TTSMeme.html")

    @app.route("/SoundMeme")
    def soundmeme():
        return render_template("SoundMeme.html")

    @app.route("/ChatCapture")
    def chatcapture():
        return render_template("ChatCapture.html")

    # --- MEME NEXT ROUTES ---
    @app.route("/facememe/next", methods=["PUT"])
    def facememe_next():
        meme = last_facememe()
        return jsonify(meme or {})

    @app.route("/normalmeme/next", methods=["PUT"])
    def normalmeme_next():
        meme = last_normalmeme()
        return jsonify(meme or {})

    @app.route("/ttsmeme/next")
    def tts_next():
        try:
            doc = col_ttsmeme.find_one({"created": "yes", "done": "no"}, sort=[("_id", 1)])
            if not doc:
                return jsonify({})

            return jsonify({
                "_id": str(doc["_id"]),
                "filepath": doc.get("filepath", ""),
                "text": doc.get("text", ""),
                "user": doc.get("user", "")
            })
        except Exception as e:
            logging.error(f"Error in /ttsmeme/next: {e}")
            return jsonify({})

    # --- POST FORM HANDLER ---
    @app.route("/handle_post", methods=["POST"])
    def handle_post():
        user = request.form.get("user", "")

        # FaceMeme
        top_text = request.form.get("top_text_facememe", "")
        bottom_text = request.form.get("bottom_text_facememe", "")
        if top_text or bottom_text:
            add_facememe({
                "user": user,
                "top_text": top_text,
                "bottom_text": bottom_text,
                "timestamp": datetime.now(timezone.utc),
                "done": "no",
            })

        # NormalMeme
        image = request.form.get("image_normalmeme", "")
        top_text_n = request.form.get("top_text_normalmeme", "")
        bottom_text_n = request.form.get("bottom_text_normalmeme", "")
        if image or top_text_n or bottom_text_n:
            add_normalmeme({
                "user": user,
                "image": image,
                "top_text": top_text_n,
                "bottom_text": bottom_text_n,
                "timestamp": datetime.now(timezone.utc),
                "done": "no",
            })

        # TTSMeme
        text_tts = request.form.get("text_ttsmeme", "")
        language = request.form.get("language", "en")
        if text_tts.strip():
            add_ttsmeme({
                "user": user,
                "text": text_tts,
                "language": language,
                "filepath": "",
                "timestamp": datetime.now(timezone.utc),
                "created": "no",
                "done": "no",
            })

        return jsonify({"status": "ok"})

    # --- CHAT HISTORY ---
    @app.route("/chat/history")
    def chat_history():
        return dumps(list(last_messages))

    # --- STATIC FILES & EMOJI ---
    @app.route('/static/img/<path:filename>')
    def serve_img(filename):
        return send_from_directory(os.path.join(app.root_path, 'static', 'img'), filename)

    @app.route("/emoji/<name>")
    def emoji(name):
        folder = os.path.join(app.root_path, "static", "img", "emoji")
        for ext in ["jpg", "png"]:
            path = os.path.join(folder, f"{name}.{ext}")
            if os.path.isfile(path):
                return jsonify({"url": f"/static/img/emoji/{name}.{ext}"})
        return jsonify({"url": None})

    @app.route("/emoji/list")
    def list_emojis():
        folder = os.path.join(app.root_path, "static", "img", "emoji")
        return jsonify([os.path.splitext(f)[0] for f in os.listdir(folder) if os.path.splitext(f)[1].lower() in [".jpg", ".png"]])

    # --- TTS DONE ---
    @app.route("/tts/done/<ttsmeme_id>", methods=["PUT"])
    def tts_done(ttsmeme_id):
        try:
            from bson import ObjectId
            oid = ObjectId(ttsmeme_id)
        except Exception:
            return jsonify({"status": "bad id"}), 400

        col_ttsmeme.update_one({"_id": oid}, {"$set": {"done": "yes"}})
        return jsonify({"status": "ok"})

    # --- SOUNDBOARD LIST ---
    @app.route("/soundboard/list")
    def soundboard_list():
        folder = os.path.join(app.root_path, "static", "sounds", "soundboard")
        files = [f for f in os.listdir(folder) if os.path.isfile(os.path.join(folder, f)) and f.lower().endswith((".mp3", ".wav", ".ogg"))]
        return jsonify(files)

    # --- SOCKET.IO EVENTS ---
    @socketio.on("play_sound")
    def handle_play_sound(data):
        socketio.emit("play_sound", data)

    @socketio.on("chat_message")
    def handle_chat_message(data):
        user = data.get("user", "Anonymous")
        message = data.get("message", "")
        if message.strip():
            msg_obj = {"user": user, "message": message, "timestamp": datetime.now(timezone.utc)}
            col_chat.insert_one(msg_obj)
            last_messages.append({"user": user, "message": message})
            socketio.emit("chat_message", {"user": user, "message": message})

    @socketio.on("connect")
    def handle_connect():
        username = request.args.get("username")
        if username:
            online_users.add(username)
            socketio.emit("update_users", list(online_users))

        last_msgs = list(col_chat.find().sort("timestamp", -1).limit(MAX_MESSAGES))
        last_msgs.reverse()
        socketio.emit("chat_history", [{"user": m["user"], "message": m["message"]} for m in last_msgs])

    @socketio.on("disconnect")
    def handle_disconnect():
        username = request.args.get("username")
        if username and username in online_users:
            online_users.remove(username)
            socketio.emit("update_users", list(online_users))


