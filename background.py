import os
import time
import logging
from gtts import gTTS
from pymongo import ReturnDocument
from client import col_ttsmeme

def start_tts_worker(socketio, max_files_keep=25, poll_sleep=2.0):
    """
    Starts the TTS worker in a background task using SocketIO.
    Handles generating TTS files, updating MongoDB, pruning old files,
    and emitting events to all connected clients.
    """

    def worker():
        tts_folder = os.path.join(os.getcwd(), "static", "sounds", "tts")
        os.makedirs(tts_folder, exist_ok=True)

        while True:
            try:
                # Claim the next TTS task
                claimed = col_ttsmeme.find_one_and_update(
                    {"created": "no"},
                    {"$set": {"created": "in_progress"}},
                    sort=[("_id", 1)],
                    return_document=ReturnDocument.BEFORE,
                )

                if not claimed:
                    time.sleep(poll_sleep)
                    continue

                tts_id = str(claimed["_id"])
                text = claimed.get("text", "")
                language = claimed.get("language", "en")
                filepath = os.path.join(tts_folder, f"{tts_id}_tts.mp3")
                db_filepath = f"static/sounds/tts/{tts_id}_tts.mp3"

                try:
                    # Generate TTS
                    tts = gTTS(text=text, lang=language)
                    tts.save(filepath)

                    # Update DB to mark created
                    col_ttsmeme.update_one(
                        {"_id": claimed["_id"]},
                        {"$set": {"filepath": db_filepath, "created": "yes"}}
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
                    logging.error(f"TTS generation failed for ID {tts_id}: {e}")
                    col_ttsmeme.update_one(
                        {"_id": claimed["_id"]},
                        {"$set": {"created": "no"}}
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

