import copy
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from bson import ObjectId

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import client


class InMemoryCollection:
    def __init__(self, documents=()):
        self.documents = [copy.deepcopy(document) for document in documents]

    def find(self, query):
        return [
            copy.deepcopy(document)
            for document in self.documents
            if document.get('action_type') == query.get('action_type')
            and 'file' in document
            and 'source_request_id' not in document
        ]

    def find_one(self, query):
        return next(
            (
                copy.deepcopy(document)
                for document in self.documents
                if document.get('user_id') == query.get('user_id')
                and document.get('request_id') == query.get('request_id')
            ),
            None,
        )

    def insert_one(self, document):
        self.documents.append(copy.deepcopy(document))

    def update_one(self, query, update, upsert=False):
        if self.find_one(query):
            return SimpleNamespace(matched_count=1, modified_count=0)
        self.documents.append(copy.deepcopy(update['$setOnInsert']))
        return SimpleNamespace(matched_count=0, modified_count=1)

    def delete_one(self, query):
        self.documents = [
            document for document in self.documents
            if document.get('_id') != query.get('_id')
        ]


class PointTransactionMigrationTests(unittest.TestCase):
    def test_migrates_sound_queue_and_records_signed_charge_and_refund_once(self):
        user_id = ObjectId()
        action = {
            '_id': ObjectId(),
            'user_id': user_id,
            'request_id': 'legacy-sound-request',
            'action_type': 'soundmeme',
            'file': 'sound.mp3',
            'point_cost': 3,
            'charged': True,
            'refund_status': 'refunded',
        }
        legacy_transactions = InMemoryCollection([action])
        sound_actions = InMemoryCollection()

        with (
            patch.object(client, 'colpointtransactions', legacy_transactions),
            patch.object(client, 'colsoundactions', sound_actions),
        ):
            client.migrate_legacy_sound_actions()
            client.migrate_legacy_sound_actions()

        self.assertEqual(legacy_transactions.documents[0]['amount'], -3)
        self.assertEqual(legacy_transactions.documents[1]['amount'], 3)
        self.assertEqual(
            [entry['user_id'] for entry in legacy_transactions.documents],
            [user_id, user_id],
        )
        self.assertEqual(len(sound_actions.documents), 1)
        self.assertEqual(sound_actions.documents[0]['request_id'], action['request_id'])


if __name__ == '__main__':
    unittest.main()
