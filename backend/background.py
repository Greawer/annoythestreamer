import os
import time
import logging
from pathlib import Path
from gtts import gTTS
from pymongo import ReturnDocument
from client import colttsmeme, colpointtransactions, colsoundactions
from routes import refund_failed_action

MAX_TTS_ATTEMPTS = 3

def start_tts_worker(socketio, max_files_keep=25, poll_sleep=2.0):
    """
    Starts the TTS worker in a background task using SocketIO.
    Handles generating TTS files, updating MongoDB, pruning old files,
    and emitting events to all connected clients.
    """

    def worker():
        tts_folder = Path(__file__).resolve().parent / "static" / "sounds" / "tts"
        os.makedirs(tts_folder, exist_ok=True)

        while True:
            try:
                pending_refund = colttsmeme.find_one({
                    "created": "failed",
                    "point_cost": {"$gt": 0},
                    "refund_status": {"$ne": "refunded"},
                })
                if pending_refund:
                    refund_failed_action(pending_refund, colttsmeme, socketio)
                pending_sound_refund = colsoundactions.find_one({
                    "state": "failed",
                    "point_cost": {"$gt": 0},
                    "refund_status": {"$ne": "refunded"},
                })
                if pending_sound_refund:
                    refund_failed_action(pending_sound_refund, colsoundactions, socketio)
                legacy_sound_refund = colpointtransactions.find_one({
                    "action_type": "soundmeme",
                    "file": {"$exists": True},
                    "state": "failed",
                    "point_cost": {"$gt": 0},
                    "refund_status": {"$ne": "refunded"},
                })
                if legacy_sound_refund:
                    refund_failed_action(legacy_sound_refund, colpointtransactions, socketio)

                # Claim the next TTS task
                claimed = colttsmeme.find_one_and_update(
                    {
                        "created": "no",
                        "$or": [
                            {"attempts": {"$exists": False}},
                            {"attempts": {"$lt": MAX_TTS_ATTEMPTS}},
                        ],
                    },
                    {"$set": {"created": "in_progress"}, "$inc": {"attempts": 1}},
                    sort=[("_id", 1)],
                    return_document=ReturnDocument.BEFORE,
                )

                if not claimed:
                    time.sleep(poll_sleep)
                    continue

                tts_id = str(claimed["_id"])
                attempt = claimed.get("attempts", 0) + 1
                text = claimed.get("text", "")
                language = claimed.get("language", "en")
                filepath = tts_folder / f"{tts_id}_tts.mp3"
                db_filepath = f"static/sounds/tts/{tts_id}_tts.mp3"

                try:
                    # Generate TTS
                    tts = gTTS(text=text, lang=language)
                    tts.save(str(filepath))

                    # Update DB to mark created
                    colttsmeme.update_one(
                        {"_id": claimed["_id"]},
                        {
                            "$set": {"filepath": db_filepath, "created": "yes"},
                            "$unset": {"last_error": ""},
                        }
                    )
                    logging.warning(f"TTS generated: {db_filepath}")

                    # Emit to all clients via SocketIO
                    socketio.emit(
                        "tts_generated",
                        {
                            "_id": tts_id,
                            "filepath": db_filepath,
                            "text": text,
                            "user": claimed.get("user", "")
                        },
                        namespace="/"
                    )

                except Exception as e:
                    terminal_failure = attempt >= MAX_TTS_ATTEMPTS
                    update = {
                        "$set": {
                            "created": "failed" if terminal_failure else "no",
                            "last_error": str(e),
                        }
                    }
                    if terminal_failure:
                        update["$set"]["done"] = True
                        update["$set"]["state"] = "failed"
                        if claimed.get("charged") and claimed.get("point_cost", 0):
                            update["$set"]["refund_status"] = "pending"
                    colttsmeme.update_one({"_id": claimed["_id"]}, update)
                    if terminal_failure and claimed.get("charged") and claimed.get("point_cost", 0):
                        failed_action = colttsmeme.find_one({"_id": claimed["_id"]})
                        if failed_action:
                            refund_failed_action(failed_action, colttsmeme, socketio)
                    logging.error(
                        "TTS generation %s for ID %s on attempt %s/%s: %s",
                        "abandoned" if terminal_failure else "failed",
                        tts_id,
                        attempt,
                        MAX_TTS_ATTEMPTS,
                        e,
                    )

                # --- Prune old TTS files ---
                try:
                    files = [os.path.join(tts_folder, f) for f in os.listdir(tts_folder) if f.endswith("_tts.mp3")]
                    if len(files) > max_files_keep:
                        files_sorted = sorted(files, key=os.path.getmtime)
                        to_delete = files_sorted[:len(files_sorted) - max_files_keep]
                        for fp in to_delete:
                            try:
                                os.remove(fp)
                                logging.warning(f"Deleted old TTS file: {fp}")
                            except Exception as e:
                                logging.error(f"Failed deleting {fp}: {e}")
                except Exception as e:
                    logging.error(f"Error pruning TTS folder: {e}")

            except Exception as e:
                logging.error(f"TTS worker loop failed: {e}")
                time.sleep(poll_sleep)

    # Start worker as a SocketIO background task (correct context for emit)
    socketio.start_background_task(worker)