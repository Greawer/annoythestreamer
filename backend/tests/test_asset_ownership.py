import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from bson import ObjectId
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import routes
from backend.tests.permission_fixtures import configure_role_permissions


class MemoryCursor(list):
    def sort(self, key, direction=1):
        return MemoryCursor(sorted(self, key=lambda item: item.get(key), reverse=direction < 0))


class MemoryCollection:
    def __init__(self, documents=()):
        self.documents = [copy.deepcopy(document) for document in documents]

    @staticmethod
    def _matches(document, query):
        for key, value in query.items():
            actual = document.get(key)
            if isinstance(value, dict) and '$in' in value:
                if actual not in value['$in']:
                    return False
            elif actual != value:
                return False
        return True

    def find_one(self, query, *_args, **_kwargs):
        return next((item for item in self.documents if self._matches(item, query)), None)

    def find(self, query=None, *_args, **_kwargs):
        query = query or {}
        return MemoryCursor(
            item for item in self.documents if self._matches(item, query)
        )

    def insert_one(self, document):
        self.documents.append(copy.deepcopy(document))

    def update_one(self, query, update, upsert=False):
        match = next((item for item in self.documents if self._matches(item, query)), None)
        if match:
            for key, value in update.get('$set', {}).items():
                match[key] = copy.deepcopy(value)
            return SimpleNamespace(upserted_id=None)
        if upsert:
            document = copy.deepcopy(update.get('$setOnInsert', update.get('$set', {})))
            self.documents.append(document)
            return SimpleNamespace(upserted_id=document.get('_id'))
        return SimpleNamespace(upserted_id=None)


class EventRegistry:
    def __init__(self):
        self.handlers = {}
        self.emit = Mock()

    def on(self, event_name):
        def register(handler):
            self.handlers[event_name] = handler
            return handler
        return register


class AssetOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.user_id = ObjectId()
        self.admin_id = ObjectId()
        self.sound_id = ObjectId()
        self.other_sound_id = ObjectId()
        self.emoji_id = ObjectId()
        self.user = {
            '_id': self.user_id,
            'username': 'asset-user',
            'rank': 'User',
            'points': 100,
        }
        self.admin = {
            '_id': self.admin_id,
            'username': 'asset-admin',
            'rank': 'Admin',
            'points': 100,
        }
        self.sounds = MemoryCollection([
            {
                '_id': self.sound_id,
                'name': 'owned-sound',
                'pricing_name': 'owned-sound',
                'display_name': 'Owned Sound',
                'loudness': 0.5,
                'file': 'owned-sound.mp3',
            },
            {
                '_id': self.other_sound_id,
                'name': 'other-sound',
                'display_name': 'Other Sound',
                'loudness': 1.0,
                'file': 'other-sound.mp3',
            },
        ])
        self.emojis = MemoryCollection([
            {'_id': self.emoji_id, 'name': 'party', 'file': 'party.png'},
        ])
        self.ownership = MemoryCollection([
            {
                'user_id': self.user_id,
                'asset_type': 'sound',
                'asset_id': self.sound_id,
            },
            {
                'user_id': self.user_id,
                'asset_type': 'emoji',
                'asset_id': self.emoji_id,
            },
        ])
        self.users = Mock()
        self.users.find_one.side_effect = lambda query, *_args, **_kwargs: next(
            (
                account for account in (self.user, self.admin)
                if query.get('_id') == account['_id']
            ),
            None,
        )
        self.ranks = Mock()
        self.permissions = Mock()
        self.pricing = copy.deepcopy(routes.DEFAULT_POINT_PRICING)
        self.pricing['catalog']['sound']['items']['owned-sound'] = -1
        self.pricing['catalog']['emoji']['items']['party'] = 25
        self.app = Flask(__name__)
        self.app.secret_key = 'test-only-secret'
        self.client = self.app.test_client()
        self.chat = Mock()
        self.patches = [
            patch.object(routes, 'colusers', self.users),
            patch.object(routes, 'colranks', self.ranks),
            patch.object(routes, 'colpermissions', self.permissions),
            patch.object(routes, 'colsounds', self.sounds),
            patch.object(routes, 'colemojis', self.emojis),
            patch.object(routes, 'colassetownership', self.ownership),
            patch.object(routes, 'colchat', self.chat),
            patch.object(routes, 'load_point_pricing', side_effect=lambda: copy.deepcopy(self.pricing)),
        ]
        for active_patch in self.patches:
            active_patch.start()
        configure_role_permissions(routes, self.ranks, self.permissions)
        routes.registerroutes(self.app, None)
        self.addCleanup(self.stop_patches)

    def stop_patches(self):
        for active_patch in reversed(self.patches):
            active_patch.stop()

    def login_as(self, account):
        with self.client.session_transaction() as session:
            session['user_id'] = str(account['_id'])

    def test_user_asset_lists_are_owned_only_and_prices_use_c3(self):
        self.login_as(self.user)

        sounds = self.client.get('/soundboardlist')
        emojis = self.client.get('/usable-emojis')

        self.assertEqual(sounds.status_code, 200)
        self.assertEqual(
            [(item['asset_id'], item['price'], item['loudness']) for item in sounds.get_json()],
            [(str(self.sound_id), -1, 0.5)],
        )
        self.assertEqual(emojis.status_code, 200)
        self.assertEqual(
            [(item['asset_id'], item['name'], item['price']) for item in emojis.get_json()],
            [(str(self.emoji_id), 'party', 25)],
        )

    def test_admin_console_capability_lists_all_assets_even_without_ownership(self):
        self.login_as(self.admin)

        sounds = self.client.get('/soundboardlist')
        emojis = self.client.get('/usable-emojis')

        self.assertEqual(sounds.status_code, 200)
        self.assertEqual(len(sounds.get_json()), 2)
        self.assertIn(-1, [asset['price'] for asset in sounds.get_json()])
        self.assertEqual(emojis.status_code, 200)
        self.assertEqual(len(emojis.get_json()), 1)

    def test_missing_ownership_is_empty_and_requires_login(self):
        with self.client.session_transaction() as session:
            session['user_id'] = str(ObjectId())

        self.assertEqual(self.client.get('/soundboardlist').status_code, 401)

        self.login_as(self.user)
        self.ownership.documents.clear()
        self.assertEqual(self.client.get('/soundboardlist').get_json(), [])
        self.assertEqual(self.client.get('/usable-emojis').get_json(), [])

    def test_ownership_survives_asset_rename_by_stable_id(self):
        self.login_as(self.user)
        self.sounds.documents[0]['name'] = 'renamed-sound'
        self.sounds.documents[0]['display_name'] = 'Renamed Sound'
        self.pricing['catalog']['sound']['items']['owned-sound'] = 40

        response = self.client.get('/soundboardlist')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()[0]['asset_id'], str(self.sound_id))
        self.assertEqual(response.get_json()[0]['name'], 'renamed-sound')
        self.assertEqual(response.get_json()[0]['price'], 40)

    def test_public_chat_emoji_listing_is_independent_of_ownership(self):
        with tempfile.TemporaryDirectory() as directory:
            emoji_dir = Path(directory)
            (emoji_dir / 'party.png').write_bytes(b'image')
            with patch.object(routes, 'EMOJIDIR', str(emoji_dir)):
                response = self.client.get('/api/list-emojis')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), ['party'])

    def test_sound_socket_rejects_unowned_asset_before_charging(self):
        events = EventRegistry()
        routes.registersocketiohandlers(events)
        actions = Mock()
        with (
            patch.object(routes, 'socket_users', {
                'socket-id': {'user_id': str(self.user_id), 'username': self.user['username']},
            }),
            patch.object(routes, 'request', SimpleNamespace(sid='socket-id')),
            patch.object(routes, 'colsoundactions', actions),
        ):
            result = events.handlers['playsound']({
                'asset_id': str(self.other_sound_id),
                'request_id': '60ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a',
            })

        self.assertEqual(result['code'], 'asset_not_owned')
        self.assertEqual(self.user['points'], 100)
        actions.insert_one.assert_not_called()

    def test_owned_unowned_and_unknown_shortcodes_are_sent_with_rendering_metadata(self):
        events = EventRegistry()
        routes.registersocketiohandlers(events)
        routes.lastmessages.clear()
        self.addCleanup(routes.lastmessages.clear)
        with (
            patch.object(routes, 'socket_users', {
                'socket-id': {'user_id': str(self.user_id), 'username': self.user['username']},
            }),
            patch.object(routes, 'request', SimpleNamespace(sid='socket-id')),
        ):
            self.ownership.documents.clear()
            events.handlers['chat_message']({'message': 'Hello :party:'})
            self.chat.insert_one.assert_called_once()
            self.assertEqual(self.chat.insert_one.call_args.args[0]['message'], 'Hello :party:')
            self.assertEqual(self.chat.insert_one.call_args.args[0]['literal_emojis'], ['party'])
            self.assertEqual(
                events.emit.call_args.args[1]['literal_emojis'],
                ['party'],
            )

            self.ownership.documents.append({
                'user_id': self.user_id,
                'asset_type': 'emoji',
                'asset_id': self.emoji_id,
            })
            events.handlers['chat_message']({'message': 'Hello :party:'})
            events.handlers['chat_message']({'message': 'Literal :unknown:'})

        self.assertEqual(self.chat.insert_one.call_count, 3)
        self.assertEqual(self.chat.insert_one.call_args_list[1].args[0]['literal_emojis'], [])
        self.assertEqual(self.chat.insert_one.call_args_list[2].args[0]['message'], 'Literal :unknown:')
        self.assertEqual(self.chat.insert_one.call_args_list[2].args[0]['literal_emojis'], [])
        self.assertEqual(routes.lastmessages[-1]['message'], 'Literal :unknown:')
        self.assertEqual(
            [call.args[1] for call in events.emit.call_args_list if call.args[0] == 'chat_message'][-1]['literal_emojis'],
            [],
        )

    def test_client_cannot_forge_system_message_or_sender(self):
        events = EventRegistry()
        routes.registersocketiohandlers(events)
        routes.lastmessages.clear()
        self.addCleanup(routes.lastmessages.clear)
        with (
            patch.object(routes, 'socket_users', {
                'socket-id': {'user_id': str(self.user_id), 'username': self.user['username']},
            }),
            patch.object(routes, 'request', SimpleNamespace(sid='socket-id')),
        ):
            events.handlers['chat_message']({
                'user': 'forged-admin',
                'message': 'Forged system activity',
                'system': True,
                'actor': 'forged-admin',
                'rank_color': '#ff0000',
            })

        saved_message = self.chat.insert_one.call_args.args[0]
        self.assertEqual(saved_message['user'], self.user['username'])
        self.assertEqual(saved_message['message'], 'Forged system activity')
        self.assertNotIn('system', saved_message)
        self.assertNotIn('actor', saved_message)
        self.assertEqual(saved_message['rank'], self.user['rank'])
        self.assertNotEqual(saved_message['rank_color'], '#ff0000')
        emitted_message = next(
            call.args[1]
            for call in events.emit.call_args_list
            if call.args[0] == 'chat_message'
        )
        self.assertEqual(emitted_message['user'], self.user['username'])
        self.assertNotIn('system', emitted_message)
        self.assertNotIn('actor', emitted_message)

    def test_activity_actor_is_not_treated_as_a_chat_sender(self):
        routes.lastmessages.clear()
        self.addCleanup(routes.lastmessages.clear)
        socketio = Mock()

        self.assertTrue(routes.emit_chat_activity(
            socketio,
            'added a sound: demo.',
            actor=self.user['username'],
        ))

        saved_activity = self.chat.insert_one.call_args.args[0]
        self.assertTrue(saved_activity['system'])
        self.assertEqual(saved_activity['actor'], self.user['username'])
        self.assertNotIn('user', saved_activity)
        socketio.emit.assert_called_once_with(
            'chat_message',
            {
                'system': True,
                'actor': self.user['username'],
                'message': 'added a sound: demo.',
            },
        )
        self.assertNotIn('user', routes.lastmessages[-1])

    def test_chat_history_keeps_another_senders_emoji_rendering_metadata(self):
        routes.lastmessages.clear()
        self.addCleanup(routes.lastmessages.clear)
        routes.lastmessages.append({
            'user': 'asset-owner',
            'message': 'Hello :party:',
            'literal_emojis': [],
        })
        routes.lastmessages.append({
            'system': True,
            'actor': 'asset-owner',
            'message': 'added an emoji: party.',
        })
        with patch.object(routes, 'add_current_ranks', side_effect=lambda messages: messages):
            response = self.client.get('/chathistory')

        self.assertEqual(response.status_code, 200)
        history = json.loads(response.data)
        self.assertEqual(history[0]['message'], 'Hello :party:')
        self.assertEqual(history[0]['literal_emojis'], [])
        self.assertEqual(history[1]['system'], True)
        self.assertEqual(history[1]['actor'], 'asset-owner')
        self.assertNotIn('user', history[1])

    def test_unregistered_public_emoji_is_sent_as_literal_for_non_owner(self):
        events = EventRegistry()
        routes.registersocketiohandlers(events)
        routes.lastmessages.clear()
        self.addCleanup(routes.lastmessages.clear)
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / 'legacy.png').write_bytes(b'image')
            with (
                patch.object(routes, 'EMOJIDIR', directory),
                patch.object(routes, 'socket_users', {
                    'socket-id': {'user_id': str(self.user_id), 'username': self.user['username']},
                }),
                patch.object(routes, 'request', SimpleNamespace(sid='socket-id')),
            ):
                events.handlers['chat_message']({'message': 'Use :legacy:'})
                events.handlers['chat_message']({'message': 'Literal :unknown:'})

        self.assertEqual(self.chat.insert_one.call_count, 2)
        self.assertEqual(self.chat.insert_one.call_args_list[0].args[0]['message'], 'Use :legacy:')
        self.assertEqual(self.chat.insert_one.call_args_list[0].args[0]['literal_emojis'], ['legacy'])
        self.assertEqual(routes.lastmessages[-1]['message'], 'Literal :unknown:')


class LegacyAssetRegistrationTests(unittest.TestCase):
    def test_registration_is_idempotent_and_inherits_c3_default_without_item_exceptions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sound_dir = root / 'sounds'
            emoji_dir = root / 'emojis'
            sound_dir.mkdir()
            emoji_dir.mkdir()
            (sound_dir / 'sample.mp3').write_bytes(b'audio')
            (emoji_dir / 'sample.png').write_bytes(b'image')
            sounds = MemoryCollection()
            emojis = MemoryCollection()
            pricing = Mock()
            pricing.update_one.return_value = SimpleNamespace(upserted_id=ObjectId())
            patches = [
                patch.object(routes, 'SOUNDDIR', str(sound_dir)),
                patch.object(routes, 'EMOJIDIR', str(emoji_dir)),
                patch.object(routes, 'colsounds', sounds),
                patch.object(routes, 'colemojis', emojis),
                patch.object(routes, 'colpricing', pricing),
                patch.object(routes, 'load_point_pricing', return_value=copy.deepcopy(routes.DEFAULT_POINT_PRICING)),
                patch.object(routes, 'MutagenFile', return_value=None),
            ]
            for active_patch in patches:
                active_patch.start()
            try:
                self.assertEqual(routes.register_legacy_assets(), {'sound': 1, 'emoji': 1})
                sounds.documents[0]['name'] = 'renamed-sample'
                self.assertEqual(routes.register_legacy_assets(), {'sound': 0, 'emoji': 0})
            finally:
                for active_patch in reversed(patches):
                    active_patch.stop()

        sound = sounds.documents[0]
        emoji = emojis.documents[0]
        self.assertEqual(sound['name'], 'renamed-sample')
        self.assertEqual(sound['pricing_name'], 'sample')
        self.assertEqual(sound['display_name'], 'sample')
        self.assertEqual(sound['loudness'], 1.0)
        self.assertEqual(sound['file'], 'sample.mp3')
        self.assertEqual(sound['name'], 'renamed-sample')
        self.assertEqual(emoji['name'], 'sample')
        self.assertEqual(emoji['file'], 'sample.png')
        self.assertEqual(pricing.update_one.call_count, 2)
        for call in pricing.update_one.call_args_list:
            self.assertIn('$setOnInsert', call.args[1])
            self.assertNotIn('$set', call.args[1])
        self.assertEqual(
            routes.resolve_catalog_price('sound', 'sample', pricing=routes.DEFAULT_POINT_PRICING),
            100,
        )


if __name__ == '__main__':
    unittest.main()
