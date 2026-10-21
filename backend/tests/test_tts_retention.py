import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from bson import ObjectId
from pymongo import ReturnDocument

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import background


class InMemoryTTSCollection:
    def __init__(self):
        self.documents = []

    def insert_one(self, document):
        self.documents.append(copy.deepcopy(document))

    def find(self, query, projection=None):
        documents = [
            copy.deepcopy(document)
            for document in self.documents
            if document.get("created") == query.get("created")
            and isinstance(document.get("filepath"), str)
            and document.get("filepath")
        ]
        return InMemoryCursor(documents)

    def find_one_and_update(self, query, update, sort, return_document):
        eligible = [
            document for document in self.documents
            if document.get("created") == query.get("created")
            and document.get("attempts", 0) < 3
        ]
        eligible.sort(key=lambda document: document["_id"])
        if not eligible:
            return None
        document = eligible[0]
        previous = copy.deepcopy(document)
        document.update(copy.deepcopy(update["$set"]))
        for key, amount in update.get("$inc", {}).items():
            document[key] = document.get(key, 0) + amount
        return previous if return_document == ReturnDocument.BEFORE else copy.deepcopy(document)

    def update_one(self, query, update):
        document = next(
            (
                item for item in self.documents
                if all(item.get(key) == value for key, value in query.items())
            ),
            None,
        )
        if not document:
            return SimpleNamespace(matched_count=0, modified_count=0)
        document.update(copy.deepcopy(update.get("$set", {})))
        for key in update.get("$unset", {}):
            document.pop(key, None)
        return SimpleNamespace(matched_count=1, modified_count=1)

    def find_one(self, query):
        document = next(
            (item for item in self.documents if all(item.get(key) == value for key, value in query.items())),
            None,
        )
        return copy.deepcopy(document) if document else None


class InMemoryCursor(list):
    def sort(self, key, direction):
        return InMemoryCursor(sorted(self, key=lambda document: document[key], reverse=direction < 0))


class FakeTTS:
    def __init__(self, text, lang):
        self.text = text
        self.lang = lang

    def save(self, filepath):
        Path(filepath).write_bytes(f"{self.lang}:{self.text}".encode())


class TTSRetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.tts_folder = Path(self.temp_dir.name) / "public" / "sounds" / "tts"
        self.tts_folder.mkdir(parents=True)
        self.collection = InMemoryTTSCollection()
        self.socketio = Mock()
        self.collection_patch = patch.object(background, "colttsmeme", self.collection)
        self.generator_patch = patch.object(background, "gTTS", FakeTTS)
        self.collection_patch.start()
        self.generator_patch.start()
        self.addCleanup(self.collection_patch.stop)
        self.addCleanup(self.generator_patch.stop)
        self.message_ids = []

    def enqueue_message(self, number):
        message_id = ObjectId()
        self.message_ids.append(message_id)
        self.collection.insert_one({
            "_id": message_id,
            "created": "no",
            "done": False,
            "state": "accepted",
            "text": f"message {number}",
            "language": "en",
            "user": "retention-test",
        })
        return message_id

    def process_next(self):
        self.assertTrue(background.process_next_tts_message(self.tts_folder, self.socketio))

    def assert_retained_messages(self, expected_ids):
        files = sorted(self.tts_folder.glob("*_tts.mp3"))
        documents = sorted(
            (document for document in self.collection.documents if document.get("filepath")),
            key=lambda document: document["_id"],
        )
        self.assertEqual([path.name for path in files], [
            f"{message_id}_tts.mp3" for message_id in expected_ids
        ])
        self.assertEqual([document["_id"] for document in documents], expected_ids)
        self.assertTrue(all(document["created"] == "yes" for document in documents))

    def test_messages_six_and_seven_evict_oldest_audio_and_expire_records(self):
        for number in range(1, 6):
            self.enqueue_message(number)
            self.process_next()

        self.assert_retained_messages(self.message_ids[:5])
        self.assertEqual(len(self.collection.documents), 5)
        oldest_file = self.tts_folder / f"{self.message_ids[0]}_tts.mp3"
        os.utime(oldest_file, (oldest_file.stat().st_atime, oldest_file.stat().st_mtime + 3600))

        self.enqueue_message(6)
        self.process_next()
        self.assert_retained_messages(self.message_ids[1:6])
        self.assertTrue(self.collection.documents[0]["done"])
        self.assertNotIn("filepath", self.collection.documents[0])
        self.assertEqual(len(self.collection.documents), 6)

        self.enqueue_message(7)
        self.process_next()
        self.assert_retained_messages(self.message_ids[2:7])
        self.assertTrue(self.collection.documents[1]["done"])
        self.assertNotIn("filepath", self.collection.documents[1])
        self.assertEqual(len(self.collection.documents), 7)
        self.assertEqual(
            [event.args[1]["_id"] for event in self.socketio.emit.call_args_list],
            [str(message_id) for message_id in self.message_ids],
        )


if __name__ == "__main__":
    unittest.main()
