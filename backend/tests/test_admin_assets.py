import copy
import io
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from bson import ObjectId
from flask import Flask
from werkzeug.datastructures import FileStorage

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import routes
from backend.tests.permission_fixtures import configure_role_permissions


class MemoryCursor(list):
    def sort(self, key, direction=1):
        return MemoryCursor(sorted(self, key=lambda item: item.get(key), reverse=direction < 0))


class MemoryCollection:
    def __init__(self, documents=()):
        self.documents = [copy.deepcopy(item) for item in documents]

    @staticmethod
    def matches(document, query):
        for key, value in query.items():
            if key == '$or':
                if not any(MemoryCollection.matches(document, clause) for clause in value):
                    return False
                continue
            if key == '$expr':
                required = value['$gte'][1]
                balance = document.get('points', 0)
                if balance < required:
                    return False
                continue
            actual = document.get(key)
            if isinstance(value, dict):
                if '$ne' in value and actual == value['$ne']:
                    return False
                if '$regex' in value and not __import__('re').search(value['$regex'], actual or ''):
                    return False
                if '$exists' in value and ((key in document) != value['$exists']):
                    return False
            elif isinstance(actual, list):
                if value not in actual:
                    return False
            elif actual != value:
                return False
        return True

    def find_one(self, query, *_args, **_kwargs):
        return next((item for item in self.documents if self.matches(item, query)), None)

    def find(self, query=None, *_args, **_kwargs):
        query = query or {}
        return MemoryCursor(item for item in self.documents if self.matches(item, query))

    def insert_one(self, document):
        self.documents.append(copy.deepcopy(document))
        return SimpleNamespace(inserted_id=document.get('_id'))

    def update_one(self, query, update, upsert=False, **_kwargs):
        document = self.find_one(query)
        inserted = document is None
        if document is None and upsert:
            document = {
                key: value
                for key, value in query.items()
                if not key.startswith('$') and not isinstance(value, dict)
            }
            self.documents.append(document)
        if document is None:
            return SimpleNamespace(matched_count=0, modified_count=0)
        if document:
            document.update(copy.deepcopy(update.get('$set', {})))
            if inserted and '$setOnInsert' in update:
                document.update(copy.deepcopy(update['$setOnInsert']))
            for key, value in update.get('$inc', {}).items():
                document[key] = document.get(key, 0) + value
            for key in update.get('$unset', {}):
                document.pop(key, None)
        return SimpleNamespace(matched_count=1, modified_count=1)

    def find_one_and_update(self, query, update, **_kwargs):
        document = self.find_one(query)
        if document is None:
            return None
        self.update_one(query, update)
        return copy.deepcopy(document)

    def delete_one(self, query):
        document = self.find_one(query)
        if document:
            self.documents.remove(document)
        return SimpleNamespace(deleted_count=1 if document else 0)

    def update_many(self, query, update):
        matched = 0
        for document in self.documents:
            if self.matches(document, query):
                matched += 1
                for key, value in update.get('$pull', {}).items():
                    if isinstance(document.get(key), list):
                        document[key] = [item for item in document[key] if item != value]
        return SimpleNamespace(matched_count=matched, modified_count=matched)


class AdminAssetTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.secret_key = 'test-only-secret'
        self.socketio = Mock()
        routes.registerroutes(self.app, self.socketio)
        self.client = self.app.test_client()
        self.admin = {'_id': ObjectId(), 'username': 'asset-admin', 'rank': 'Admin', 'points': 250_000}
        self.user = {'_id': ObjectId(), 'username': 'asset-user', 'rank': 'User', 'points': 250_000}
        self.users = MemoryCollection([self.admin, self.user])
        self.ranks = Mock()
        self.permissions = Mock()
        self.sounds = MemoryCollection()
        self.emojis = MemoryCollection()
        self.ownership = MemoryCollection()
        self.point_transactions = MemoryCollection()
        self.shop_purchases = MemoryCollection()
        self.chat = MemoryCollection()
        self.pricing = MemoryCollection([{
            '_id': routes.POINT_PRICING_ID,
            'schema_version': 1,
            'pricing': copy.deepcopy(routes.DEFAULT_POINT_PRICING),
        }])
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.sound_dir = Path(self.temporary_directory.name) / 'sounds'
        self.emoji_dir = Path(self.temporary_directory.name) / 'emojis'
        self.patches = [
            patch.object(routes, 'colusers', self.users),
            patch.object(routes, 'colranks', self.ranks),
            patch.object(routes, 'colpermissions', self.permissions),
            patch.object(routes, 'colsounds', self.sounds),
            patch.object(routes, 'colemojis', self.emojis),
            patch.object(routes, 'colassetownership', self.ownership),
            patch.object(routes, 'colpointtransactions', self.point_transactions),
            patch.object(routes, 'colshoppurchases', self.shop_purchases),
            patch.object(routes, 'colchat', self.chat),
            patch.object(routes, 'colpricing', self.pricing),
            patch.object(routes, 'SOUNDDIR', str(self.sound_dir)),
            patch.object(routes, 'EMOJIDIR', str(self.emoji_dir)),
            patch.object(routes, 'lastmessages', []),
        ]
        for active_patch in self.patches:
            active_patch.start()
        configure_role_permissions(routes, self.ranks, self.permissions)
        self.addCleanup(self.stop_patches)

    def stop_patches(self):
        for active_patch in reversed(self.patches):
            active_patch.stop()
        self.temporary_directory.cleanup()

    def login_as(self, user, admin_session=False):
        with self.client.session_transaction() as session:
            session['user_id'] = str(user['_id'])
            if admin_session:
                session['admin_user_id'] = str(user['_id'])

    @staticmethod
    def png_bytes(width=1, height=1):
        return (
            b'\x89PNG\r\n\x1a\n'
            + b'\x00\x00\x00\rIHDR'
            + width.to_bytes(4, 'big')
            + height.to_bytes(4, 'big')
        )

    def test_admin_upload_rename_and_remove_emoji_preserves_stable_identity_and_pricing(self):
        self.login_as(self.admin, admin_session=True)
        response = self.client.post(
            '/admin/assets/emoji',
            data={
                'name': 'Party Emoji!',
                'price': '-1',
                'file': (io.BytesIO(self.png_bytes()), 'party.png'),
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(response.status_code, 201)
        asset_listing = self.client.get('/admin/assets/emoji')
        self.assertEqual(asset_listing.get_json()['default_price'], 100)
        self.assertEqual(asset_listing.get_json()['assets'][0]['price_exception'], -1)
        self.socketio.emit.assert_any_call('asset_catalog_changed', {'asset_type': 'emoji'})
        asset_id = response.get_json()['asset']['asset_id']
        stored = self.emojis.find_one({'_id': ObjectId(asset_id)})
        self.assertEqual(stored['name'], 'partyemoji')
        self.assertTrue((self.emoji_dir / 'partyemoji.png').is_file())
        self.assertEqual(
            self.pricing.find_one({'_id': routes.POINT_PRICING_ID})['pricing']['catalog']['emoji']['items']['partyemoji'],
            -1,
        )

        self.ownership.insert_one({
            'user_id': self.user['_id'],
            'asset_type': 'emoji',
            'asset_id': ObjectId(asset_id),
        })
        self.chat.insert_one({
            '_id': ObjectId(),
            'message': 'Hello :partyemoji:',
            'literal_emojis': [],
        })
        renamed = self.client.patch(
            f'/admin/assets/emoji/{asset_id}',
            json={'name': 'New Party', 'price': -1},
        )
        self.assertEqual(renamed.status_code, 200)
        updated = self.emojis.find_one({'_id': ObjectId(asset_id)})
        self.assertEqual(updated['name'], 'newparty')
        self.assertEqual(updated['file'], 'newparty.png')
        self.assertEqual(updated['_id'], ObjectId(asset_id))
        self.assertEqual(self.ownership.documents[0]['asset_id'], updated['_id'])
        self.assertFalse((self.emoji_dir / 'partyemoji.png').exists())
        self.assertTrue((self.emoji_dir / 'newparty.png').is_file())
        self.assertEqual(self.chat.documents[0]['message'], 'Hello :newparty:')
        self.assertEqual(
            self.pricing.find_one({'_id': routes.POINT_PRICING_ID})['pricing']['catalog']['emoji']['items']['newparty'],
            -1,
        )
        self.assertEqual(routes.list_shop_assets(self.user)['emoji'][0]['status'], 'owned')

        removed = self.client.delete(f'/admin/assets/emoji/{asset_id}')
        self.assertEqual(removed.status_code, 200)
        self.assertIsNone(self.emojis.find_one({'_id': ObjectId(asset_id)}))
        self.assertFalse((self.emoji_dir / 'newparty.png').exists())
        self.assertNotIn('newparty', self.pricing.find_one({'_id': routes.POINT_PRICING_ID})['pricing']['catalog']['emoji']['items'])

    def test_non_admin_cannot_manage_assets_and_invalid_uploads_are_rejected(self):
        self.login_as(self.user, admin_session=True)
        denied = self.client.get('/admin/assets/emoji')
        self.assertEqual(denied.status_code, 403)
        denied_upload = self.client.post(
            '/admin/assets/emoji',
            data={'name': 'blocked', 'file': (io.BytesIO(self.png_bytes()), 'blocked.png')},
            content_type='multipart/form-data',
        )
        self.assertEqual(denied_upload.status_code, 403)

        self.login_as(self.admin, admin_session=True)
        invalid_dimensions = self.client.post(
            '/admin/assets/emoji',
            data={
                'name': 'Too Large',
                'file': (io.BytesIO(self.png_bytes(2049, 1)), 'large.png'),
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(invalid_dimensions.status_code, 400)
        self.assertEqual(self.emojis.documents, [])

    def test_duplicate_normalized_emoji_names_are_rejected(self):
        self.login_as(self.admin, admin_session=True)
        first = self.client.post(
            '/admin/assets/emoji',
            data={
                'name': 'Party',
                'file': (io.BytesIO(self.png_bytes()), 'party.png'),
            },
            content_type='multipart/form-data',
        )
        duplicate = self.client.post(
            '/admin/assets/emoji',
            data={
                'name': 'P-a-r-t-y',
                'file': (
                    io.BytesIO(b'GIF89a' + (1).to_bytes(2, 'little') + (1).to_bytes(2, 'little')),
                    'party.gif',
                ),
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(first.status_code, 201)
        self.assertEqual(duplicate.status_code, 409)
        self.assertEqual(len(self.emojis.documents), 1)

    def test_sound_upload_rejects_overlong_audio(self):
        self.login_as(self.admin, admin_session=True)
        fake_audio = SimpleNamespace(info=SimpleNamespace(length=10.1), mime=['audio/mpeg'])
        with patch.object(routes, 'MutagenFile', return_value=fake_audio):
            response = self.client.post(
                '/admin/assets/sound',
                data={
                    'display_name': 'Too Long',
                    'loudness': '1',
                    'file': (io.BytesIO(b'fake mp3'), 'sound.mp3'),
                },
                content_type='multipart/form-data',
            )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.sounds.documents, [])

    def test_sound_upload_accepts_falsey_mutagen_audio_with_valid_mp3_metadata(self):
        class ParsedMP3:
            info = SimpleNamespace(length=1.968)
            mime = ['audio/mp3', 'audio/mpeg']

            def __bool__(self):
                return False

        upload = FileStorage(stream=io.BytesIO(b'valid MP3 fixture'), filename='sound.mp3')
        with patch.object(routes, 'MutagenFile', return_value=ParsedMP3()):
            temporary_path, extension = routes.validate_uploaded_asset(
                upload,
                'sound',
                str(self.sound_dir),
            )
        try:
            self.assertEqual(extension, 'mp3')
            self.assertTrue(Path(temporary_path).is_file())
        finally:
            Path(temporary_path).unlink(missing_ok=True)

    def test_sound_upload_defaults_empty_loudness_and_accepts_two_times_gain(self):
        self.login_as(self.admin, admin_session=True)
        valid_audio = SimpleNamespace(info=SimpleNamespace(length=4.5), mime=['audio/mpeg'])
        with patch.object(routes, 'MutagenFile', return_value=valid_audio):
            response = self.client.post(
                '/admin/assets/sound',
                data={
                    'display_name': 'Default Sound',
                    'loudness': '',
                    'file': (io.BytesIO(b'fake mp3'), 'sound.mp3'),
                },
                content_type='multipart/form-data',
            )
        self.assertEqual(response.status_code, 201)
        asset_id = response.get_json()['asset']['asset_id']
        self.assertEqual(self.sounds.find_one({'_id': ObjectId(asset_id)})['loudness'], 1.0)

        updated = self.client.patch(
            f'/admin/assets/sound/{asset_id}',
            json={'loudness': 2},
        )
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(self.sounds.find_one({'_id': ObjectId(asset_id)})['loudness'], 2.0)

    def test_sound_rename_preserves_identity_and_updates_obs_playback_loudness(self):
        self.login_as(self.admin, admin_session=True)
        valid_audio = SimpleNamespace(info=SimpleNamespace(length=4.5), mime=['audio/mpeg'])
        with patch.object(routes, 'MutagenFile', return_value=valid_audio):
            response = self.client.post(
                '/admin/assets/sound',
                data={
                    'display_name': 'Funny Sound!',
                    'loudness': '0.5',
                    'price': '15',
                    'file': (io.BytesIO(b'fake mp3'), 'uploaded.mp3'),
                },
                content_type='multipart/form-data',
            )
        self.assertEqual(response.status_code, 201)
        asset_id = response.get_json()['asset']['asset_id']
        play_price_updated = self.client.patch(
            f'/admin/assets/sound/{asset_id}',
            json={'play_price': 4},
        )
        self.assertEqual(play_price_updated.status_code, 200)
        self.assertEqual(
            self.pricing.find_one({'_id': routes.POINT_PRICING_ID})['pricing']['catalog']['sound']['items']['funnysound.mp3'],
            15,
        )
        self.assertEqual(
            self.pricing.find_one({'_id': routes.POINT_PRICING_ID})['pricing']['catalog']['sound']['play_items']['funnysound.mp3'],
            4,
        )
        renamed = self.client.patch(
            f'/admin/assets/sound/{asset_id}',
            json={'display_name': 'New Sound', 'loudness': 0.25},
        )
        self.assertEqual(renamed.status_code, 200)
        asset = self.sounds.find_one({'_id': ObjectId(asset_id)})
        self.assertEqual(asset['name'], 'newsound')
        self.assertEqual(asset['file'], 'newsound.mp3')
        self.assertEqual(asset['loudness'], 0.25)
        self.assertEqual(asset['_id'], ObjectId(asset_id))
        self.assertTrue((self.sound_dir / 'newsound.mp3').is_file())
        self.assertEqual(
            self.pricing.find_one({'_id': routes.POINT_PRICING_ID})['pricing']['catalog']['sound']['items']['newsound.mp3'],
            15,
        )
        self.assertEqual(
            self.pricing.find_one({'_id': routes.POINT_PRICING_ID})['pricing']['catalog']['sound']['play_items']['newsound.mp3'],
            4,
        )
        listed = self.client.get('/admin/assets/sound').get_json()['assets'][0]
        self.assertEqual(listed['price_exception'], 15)
        self.assertEqual(listed['play_price_exception'], 4)

        class EventRegistry:
            def __init__(self):
                self.handlers = {}
                self.emit = Mock()

            def on(self, name):
                return lambda handler: self.handlers.setdefault(name, handler)

        events = EventRegistry()
        routes.registersocketiohandlers(events)
        with (
            patch.object(routes, 'socket_users', {
                'socket-id': {'user_id': str(self.user['_id']), 'username': self.user['username']},
            }),
            patch.object(routes, 'request', SimpleNamespace(sid='socket-id')),
            patch.object(routes, 'can_use_asset', return_value=True),
            patch.object(routes, 'colpointtransactions', Mock(find_one=Mock(return_value=None))),
            patch.object(routes, 'colsoundactions', Mock()),
            patch.object(routes, 'accept_paid_action', return_value=({'status': 'ok'}, 200)),
            patch.object(routes.os.path, 'isfile', return_value=True),
        ):
            events.handlers['playsound']({
                'asset_id': asset_id,
                'request_id': '60ce68ad-d1f7-4d18-a9f4-745a8d6d9c02',
            })
        events.emit.assert_called_with(
            'playsound',
            {'file': 'newsound', 'loudness': 0.25},
            include_self=True,
        )

    def test_animated_gif_emoji_upload_is_supported(self):
        self.login_as(self.admin, admin_session=True)
        gif = b'GIF89a' + (32).to_bytes(2, 'little') + (48).to_bytes(2, 'little')
        response = self.client.post(
            '/admin/assets/emoji',
            data={
                'name': 'Animated Emote',
                'file': (io.BytesIO(gif), 'animated.gif'),
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(response.status_code, 201)
        asset = self.emojis.find_one({'name': 'animatedemote'})
        self.assertEqual(asset['file'], 'animatedemote.gif')
        self.assertNotIn('shop_available', asset)
        self.assertEqual(routes.list_shop_assets(self.user)['emoji'][0]['status'], 'available')
        self.assertTrue((self.emoji_dir / 'animatedemote.gif').is_file())

    def test_admin_can_upload_asset_from_https_url(self):
        self.login_as(self.admin, admin_session=True)
        with patch.object(
            routes,
            'fetch_admin_asset_url',
            return_value=FileStorage(
                stream=io.BytesIO(self.png_bytes()),
                filename='remote.png',
            ),
        ) as fetch_asset:
            response = self.client.post(
                '/admin/assets/emoji',
                data={
                    'name': 'Remote Emote',
                    'source_url': 'https://assets.example/emote.png',
                },
                content_type='multipart/form-data',
            )
        self.assertEqual(response.status_code, 201)
        fetch_asset.assert_called_once_with('https://assets.example/emote.png', 'emoji')
        self.assertTrue((self.emoji_dir / 'remoteemote.png').is_file())

    def test_asset_url_rejects_private_hosts(self):
        with patch.object(
            routes.socket,
            'getaddrinfo',
            return_value=[(None, None, None, None, ('127.0.0.1', 443))],
        ):
            with self.assertRaisesRegex(ValueError, 'public addresses'):
                routes.fetch_admin_asset_url('https://assets.example/emote.png', 'emoji')

    def test_asset_url_connection_supports_ipv6_address_tuples(self):
        address_info = (
            routes.socket.AF_INET6,
            routes.socket.SOCK_STREAM,
            6,
            '',
            ('2001:4860:4860::8888', 443, 0, 0),
        )
        asset_socket = Mock()
        ssl_context = Mock()
        ssl_context.wrap_socket.return_value = 'wrapped socket'
        with patch.object(routes.socket, 'socket', return_value=asset_socket) as create_socket:
            wrapped_socket = routes.connect_admin_asset_address(
                address_info,
                10,
                None,
                ssl_context,
                'assets.example',
            )

        create_socket.assert_called_once_with(
            routes.socket.AF_INET6,
            routes.socket.SOCK_STREAM,
            6,
        )
        asset_socket.connect.assert_called_once_with(address_info[4])
        self.assertEqual(wrapped_socket, 'wrapped socket')

    def test_asset_with_minus_one_price_cannot_be_purchased(self):
        asset_id = ObjectId()
        self.emojis.insert_one({
            '_id': asset_id,
            'name': 'hidden',
            'pricing_name': 'hidden',
            'file': 'hidden.png',
        })
        pricing = copy.deepcopy(routes.DEFAULT_POINT_PRICING)
        pricing['catalog']['emoji']['items']['hidden'] = -1
        self.pricing.update_one(
            {'_id': routes.POINT_PRICING_ID},
            {'$set': {'pricing': pricing}},
        )
        with patch.object(routes, 'colshoppurchases', MemoryCollection()):
            _result, status = routes.purchase_catalog_asset(
                self.user,
                'emoji',
                str(asset_id),
                '80ce68ad-d1f7-4d18-a9f4-745a8d6d9c77',
            )
        self.assertEqual(status, 403)

    def test_proposal_uses_configured_fee_and_grants_stable_id_ownership(self):
        self.login_as(self.user)
        pricing = copy.deepcopy(routes.DEFAULT_POINT_PRICING)
        pricing['proposal_rewards']['emoji']['default'] = 40
        self.pricing.update_one(
            {'_id': routes.POINT_PRICING_ID},
            {'$set': {'pricing': pricing}},
        )
        chat_message = {
            '_id': ObjectId(),
            'message': 'Check :useremoji:',
            'literal_emojis': ['useremoji'],
        }
        self.chat.insert_one(chat_message)
        routes.lastmessages.append(copy.deepcopy(chat_message))
        response = self.client.post(
            '/shop/propose',
            data={
                'asset_type': 'emoji',
                'request_id': '60ce68ad-d1f7-4d18-a9f4-745a8d6d9c03',
                'name': 'User Emoji',
                'exclusive': 'false',
                'file': (io.BytesIO(self.png_bytes()), 'emoji.png'),
            },
            content_type='multipart/form-data',
        )

        self.assertEqual(response.status_code, 201)
        result = response.get_json()
        asset_id = ObjectId(result['asset']['asset_id'])
        asset = self.emojis.find_one({'_id': asset_id})
        self.assertEqual(asset['proposal_state'], 'complete')
        self.assertEqual(asset['proposal_cost'], 40)
        self.assertEqual(self.users.find_one({'_id': self.user['_id']})['points'], 249_960)
        self.assertEqual(
            self.ownership.find_one({
                'user_id': self.user['_id'],
                'asset_type': 'emoji',
                'asset_id': asset_id,
            })['asset_id'],
            asset_id,
        )
        self.assertEqual(routes.list_shop_assets(self.user)['emoji'][0]['status'], 'owned')
        self.assertEqual(len(self.point_transactions.documents), 1)
        self.socketio.emit.assert_any_call('asset_catalog_changed', {'asset_type': 'emoji'})
        self.assertEqual(self.chat.documents[0]['literal_emojis'], [])
        self.assertEqual(routes.lastmessages[0]['literal_emojis'], [])
        self.socketio.emit.assert_any_call(
            'chat_history',
            [{'message': 'Check :useremoji:', 'literal_emojis': [], 'rank': None, 'rank_color': None, '_id': chat_message['_id']}],
        )

    def test_exclusive_proposal_is_unavailable_to_other_buyers(self):
        self.login_as(self.user)
        pricing = copy.deepcopy(routes.DEFAULT_POINT_PRICING)
        pricing['proposal_rewards']['emoji']['exclusive'] = 75
        self.pricing.update_one(
            {'_id': routes.POINT_PRICING_ID},
            {'$set': {'pricing': pricing}},
        )
        response = self.client.post(
            '/shop/propose',
            data={
                'asset_type': 'emoji',
                'request_id': '60ce68ad-d1f7-4d18-a9f4-745a8d6d9c04',
                'name': 'Exclusive Emoji',
                'exclusive': 'true',
                'file': (io.BytesIO(self.png_bytes()), 'emoji.png'),
            },
            content_type='multipart/form-data',
        )

        self.assertEqual(response.status_code, 201)
        asset = self.emojis.find_one({'name': 'exclusiveemoji'})
        self.assertEqual(asset['proposal_cost'], 75)
        self.assertTrue(asset['exclusive'])
        shop_item = routes.list_shop_assets(self.user)['emoji'][0]
        self.assertEqual(shop_item['status'], 'owned')
        self.assertEqual(shop_item['price'], -1)

        other_user = {'_id': ObjectId(), 'username': 'other-user', 'rank': 'User', 'points': 1000}
        self.users.insert_one(other_user)
        other_item = routes.list_shop_assets(other_user)['emoji'][0]
        self.assertEqual(other_item['status'], 'unavailable')
        self.assertEqual(other_item['price'], -1)
        with patch.object(routes, 'colshoppurchases', MemoryCollection()):
            _result, status = routes.purchase_catalog_asset(
                other_user,
                'emoji',
                str(asset['_id']),
                '60ce68ad-d1f7-4d18-a9f4-745a8d6d9c05',
            )
        self.assertEqual(status, 403)
        self.assertEqual(self.users.find_one({'_id': other_user['_id']})['points'], 1000)

    def test_invalid_proposal_file_fails_before_asset_ownership_or_debit(self):
        self.login_as(self.user)
        response = self.client.post(
            '/shop/propose',
            data={
                'asset_type': 'emoji',
                'request_id': '60ce68ad-d1f7-4d18-a9f4-745a8d6d9c06',
                'name': 'Invalid Emoji',
                'exclusive': 'false',
                'file': (io.BytesIO(b'not an image'), 'invalid.jpg'),
            },
            content_type='multipart/form-data',
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.emojis.documents, [])
        self.assertEqual(self.ownership.documents, [])
        self.assertEqual(self.point_transactions.documents, [])
        self.assertEqual(self.users.find_one({'_id': self.user['_id']})['points'], 250_000)
        self.assertEqual(list(self.emoji_dir.glob('invalidemoji.*')), [])

    def test_proposal_database_failure_removes_stored_file_and_refunds_points(self):
        self.login_as(self.user)
        with patch.object(self.emojis, 'insert_one', side_effect=RuntimeError('simulated database failure')):
            response = self.client.post(
                '/shop/propose',
                data={
                    'asset_type': 'emoji',
                    'request_id': '60ce68ad-d1f7-4d18-a9f4-745a8d6d9c08',
                    'name': 'Broken Proposal',
                    'exclusive': 'false',
                    'file': (io.BytesIO(self.png_bytes()), 'emoji.png'),
                },
                content_type='multipart/form-data',
            )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.emojis.documents, [])
        self.assertEqual(self.ownership.documents, [])
        self.assertEqual(self.users.find_one({'_id': self.user['_id']})['points'], 250_000)
        self.assertNotIn('pending_point_operation', self.users.find_one({'_id': self.user['_id']}))
        self.assertEqual(list(self.emoji_dir.glob('brokenproposal.*')), [])

    def test_configured_upload_limits_apply_to_proposals_and_admin_uploads(self):
        pricing = copy.deepcopy(routes.DEFAULT_POINT_PRICING)
        pricing['asset_limits']['emoji']['max_px'] = 1
        pricing['asset_limits']['emoji']['max_px_admin'] = 1
        self.pricing.update_one(
            {'_id': routes.POINT_PRICING_ID},
            {'$set': {'pricing': pricing}},
        )
        self.login_as(self.user)
        proposal = self.client.post(
            '/shop/propose',
            data={
                'asset_type': 'emoji',
                'request_id': '60ce68ad-d1f7-4d18-a9f4-745a8d6d9c07',
                'name': 'Too Big',
                'exclusive': 'false',
                'file': (io.BytesIO(self.png_bytes(2, 1)), 'large.png'),
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(proposal.status_code, 400)
        self.assertEqual(self.emojis.documents, [])
        self.assertEqual(self.users.find_one({'_id': self.user['_id']})['points'], 250_000)

        self.login_as(self.admin, admin_session=True)
        admin_upload = self.client.post(
            '/admin/assets/emoji',
            data={
                'name': 'Too Big Admin',
                'file': (io.BytesIO(self.png_bytes(2, 1)), 'large.png'),
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(admin_upload.status_code, 400)
        self.assertEqual(self.emojis.documents, [])

    def test_configured_sound_limits_apply_to_proposal_and_admin_uploads(self):
        pricing = copy.deepcopy(routes.DEFAULT_POINT_PRICING)
        pricing['asset_limits']['sound']['max_length'] = 2
        pricing['asset_limits']['sound']['max_length_admin'] = 2
        self.pricing.update_one(
            {'_id': routes.POINT_PRICING_ID},
            {'$set': {'pricing': pricing}},
        )
        long_audio = SimpleNamespace(info=SimpleNamespace(length=2.1), mime=['audio/mpeg'])
        self.login_as(self.user)
        with patch.object(routes, 'MutagenFile', return_value=long_audio):
            proposal = self.client.post(
                '/shop/propose',
                data={
                    'asset_type': 'sound',
                    'request_id': '60ce68ad-d1f7-4d18-a9f4-745a8d6d9c09',
                    'display_name': 'Too Long',
                    'exclusive': 'false',
                    'file': (io.BytesIO(b'fake mp3'), 'sound.mp3'),
                },
                content_type='multipart/form-data',
            )
        self.assertEqual(proposal.status_code, 400)
        self.assertEqual(self.sounds.documents, [])
        self.assertEqual(self.users.find_one({'_id': self.user['_id']})['points'], 250_000)

        self.login_as(self.admin, admin_session=True)
        with patch.object(routes, 'MutagenFile', return_value=long_audio):
            admin_upload = self.client.post(
                '/admin/assets/sound',
                data={
                    'display_name': 'Too Long',
                    'file': (io.BytesIO(b'fake mp3'), 'sound.mp3'),
                },
                content_type='multipart/form-data',
            )
        self.assertEqual(admin_upload.status_code, 400)
        self.assertEqual(self.sounds.documents, [])


if __name__ == '__main__':
    unittest.main()
