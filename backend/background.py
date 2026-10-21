import os
import time
import logging
from pathlib import Path
from gtts import gTTS
from pymongo import ReturnDocument
from client import colttsmeme, colpointtransactions, colsoundactions
from routes import refund_failed_action

MAX_TTS_ATTEMPTS = 3
MAX_TTS_MESSAGES = 5


def prune_tts_messages(tts_folder):
    collection = colttsmeme
    tts_folder = Path(tts_folder)
    documents = list(collection.find(
        {
            "created": "yes",
            "filepath": {"$type": "string", "$ne": ""},
        },
        {"_id": 1, "filepath": 1},
    ).sort("_id", 1))

    retained = []
    referenced_files = set()
    for document in documents:
        expected_filename = f"{document['_id']}_tts.mp3"
        if Path(document["filepath"].replace("\\", "/")).name != expected_filename:
            logging.error("Unexpected TTS filepath for message %s", document["_id"])
            continue

        filepath = tts_folder / expected_filename
        referenced_files.add(expected_filename)
        if filepath.is_file():
            retained.append((document, filepath))
        else:
            collection.update_one(
                {
                    "_id": document["_id"],
                    "created": "yes",
                    "filepath": document["filepath"],
                },
                {"$set": {"done": True}, "$unset": {"filepath": ""}},
            )

    for document, filepath in retained[:-MAX_TTS_MESSAGES]:
        try:
            filepath.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            logging.exception("Failed deleting old TTS file: %s", filepath)
            continue

        collection.update_one(
            {
                "_id": document["_id"],
                "created": "yes",
                "filepath": document["filepath"],
            },
            {"$set": {"done": True}, "$unset": {"filepath": ""}},
        )
        logging.warning("Deleted old TTS file: %s", filepath)

    for filepath in tts_folder.glob("*_tts.mp3"):
        if filepath.name not in referenced_files:
            try:
                filepath.unlink()
            except OSError:
                logging.exception("Failed deleting unreferenced TTS file: %s", filepath)

    remaining_files = list(tts_folder.glob("*_tts.mp3"))
    if len(remaining_files) > MAX_TTS_MESSAGES:
        raise RuntimeError(
            f"TTS retention left {len(remaining_files)} files; "
            f"maximum is {MAX_TTS_MESSAGES}"
        )


def process_next_tts_message(tts_folder, socketio):
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
        return False

    tts_id = str(claimed["_id"])
    attempt = claimed.get("attempts", 0) + 1
    text = claimed.get("text", "")
    language = claimed.get("language", "en")
    filepath = Path(tts_folder) / f"{tts_id}_tts.mp3"
    db_filepath = f"static/sounds/tts/{tts_id}_tts.mp3"

    try:
        tts = gTTS(text=text, lang=language)
        tts.save(str(filepath))
        colttsmeme.update_one(
            {"_id": claimed["_id"]},
            {
                "$set": {"filepath": db_filepath, "created": "yes"},
                "$unset": {"last_error": ""},
            },
        )
        logging.warning("TTS generated: %s", db_filepath)
        socketio.emit(
            "tts_generated",
            {
                "_id": tts_id,
                "filepath": db_filepath,
                "text": text,
                "user": claimed.get("user", ""),
            },
            namespace="/",
        )
    except Exception as error:
        terminal_failure = attempt >= MAX_TTS_ATTEMPTS
        update = {
            "$set": {
                "created": "failed" if terminal_failure else "no",
                "last_error": str(error),
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
            error,
        )

    try:
        prune_tts_messages(tts_folder)
    except Exception:
        logging.exception("Could not enforce TTS retention")
    return True


def start_tts_worker(socketio, poll_sleep=2.0):
    """
    Starts the TTS worker in a background task using SocketIO.
    Handles generating TTS files, updating MongoDB, pruning old files,
    and emitting events to all connected clients.
    """

    def worker():
        tts_folder = Path(__file__).resolve().parent.parent / "public" / "sounds" / "tts"
        os.makedirs(tts_folder, exist_ok=True)
        logging.warning("TTS worker started; output directory: %s", tts_folder)

        try:
            prune_tts_messages(tts_folder)
        except Exception:
            logging.exception("Could not enforce TTS retention at startup")

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

                if not process_next_tts_message(tts_folder, socketio):
                    time.sleep(poll_sleep)
                    continue

            except Exception as e:
                logging.error(f"TTS worker loop failed: {e}")
                time.sleep(poll_sleep)

    # Start worker as a SocketIO background task (correct context for emit)
    socketio.start_background_task(worker)