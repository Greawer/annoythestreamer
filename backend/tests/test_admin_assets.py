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
                if '$in' in value and actual not in value['$in']:
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

    def count_documents(self, query):
        return sum(1 for item in self.documents if self.matches(item, query))

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
            for key, value in update.get('$addToSet', {}).items():
                existing = document.setdefault(key, [])
                if value not in existing:
                    existing.append(copy.deepcopy(value))
            for key, value in update.get('$pull', {}).items():
                if isinstance(document.get(key), list):
                    if isinstance(value, dict) and '$in' in value:
                        document[key] = [item for item in document[key] if item not in value['$in']]
                    else:
                        document[key] = [item for item in document[key] if item != value]
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
                for key, value in update.get('$set', {}).items():
                    document[key] = copy.deepcopy(value)
                for key, value in update.get('$pull', {}).items():
                    if isinstance(document.get(key), list):
                        document[key] = [item for item in document[key] if item != value]
                for key, value in update.get('$addToSet', {}).items():
                    existing = document.setdefault(key, [])
                    if value not in existing:
                        existing.append(copy.deepcopy(value))
                for key in update.get('$unset', {}):
                    document.pop(key, None)
        return SimpleNamespace(matched_count=matched, modified_count=matched)

    def delete_many(self, query):
        matches = [item for item in self.documents if self.matches(item, query)]
        for item in matches:
            self.documents.remove(item)
        return SimpleNamespace(deleted_count=len(matches))


class AdminAssetTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.secret_key = 'test-only-secret'
        self.socketio = Mock()
        routes.registerroutes(self.app, self.socketio)
        self.client = self.app.test_client()
        self.admin = {'_id': ObjectId(), 'username': 'asset-admin', 'rank': 'Admin', 'points': 250_000, 'email': 'admin@example.com', 'password_hash': 'admin-hash'}
        self.user = {'_id': ObjectId(), 'username': 'asset-user', 'rank': 'User', 'points': 250_000, 'email': 'user@example.com', 'password_hash': 'user-hash'}
        self.users = MemoryCollection([self.admin, self.user])
        self.ranks = Mock()
        self.permissions = Mock()
        self.sounds = MemoryCollection()
        self.emojis = MemoryCollection()
        self.themes = MemoryCollection()
        self.ownership = MemoryCollection()
        self.point_transactions = MemoryCollection()
        self.shop_purchases = MemoryCollection()
        self.chat = MemoryCollection()
        self.badges = MemoryCollection()
        self.pricing = MemoryCollection([{
            '_id': routes.POINT_PRICING_ID,
            'schema_version': 1,
            'pricing': copy.deepcopy(routes.DEFAULT_POINT_PRICING),
        }])
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.public_dir = Path(self.temporary_directory.name) / 'public'
        self.sound_dir = Path(self.temporary_directory.name) / 'sounds'
        self.emoji_dir = Path(self.temporary_directory.name) / 'emojis'
        self.badge_dir = Path(self.temporary_directory.name) / 'badges'
        self.patches = [
            patch.object(routes, 'colusers', self.users),
            patch.object(routes, 'colranks', self.ranks),
            patch.object(routes, 'colpermissions', self.permissions),
            patch.object(routes, 'colsounds', self.sounds),
            patch.object(routes, 'colemojis', self.emojis),
            patch.object(routes, 'colbadges', self.badges),
            patch.object(routes, 'colthemes', self.themes),
            patch.object(routes, 'colassetownership', self.ownership),
            patch.object(routes, 'colpointtransactions', self.point_transactions),
            patch.object(routes, 'colshoppurchases', self.shop_purchases),
            patch.object(routes, 'colchat', self.chat),
            patch.object(routes, 'colpricing', self.pricing),
            patch.object(routes, 'PUBLIC_DIR', str(self.public_dir)),
            patch.object(routes, 'SOUNDDIR', str(self.sound_dir)),
            patch.object(routes, 'EMOJIDIR', str(self.emoji_dir)),
            patch.object(routes, 'BADGEDIR', str(self.badge_dir)),
            patch.object(routes, 'lastmessages', []),
            patch.object(routes, 'onlineusers', set()),
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
        activity = self.chat.documents[-1]
        self.assertTrue(activity['system'])
        self.assertNotIn('user', activity)
        self.assertEqual(activity['message'], 'Added emoji: partyemoji.')
        self.socketio.emit.assert_any_call(
            'chat_message',
            {'system': True, 'message': 'Added emoji: partyemoji.'},
        )
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
        self.assertEqual(
            next(
                message['message']
                for message in self.chat.documents
                if message.get('message', '').startswith('Hello ')
            ),
            'Hello :newparty:',
        )
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

    def create_badge(self, name='Community Badge'):
        return self.client.post(
            '/admin/badges',
            data={
                'name': name,
                'file': (io.BytesIO(self.png_bytes()), 'badge.png'),
            },
            content_type='multipart/form-data',
        )

    def test_badge_management_grants_and_visible_badge_are_admin_authorized(self):
        self.login_as(self.admin, admin_session=True)
        created = self.create_badge()
        self.assertEqual(created.status_code, 201)
        badge = created.get_json()['badge']
        self.assertEqual(badge['name'], 'Community Badge')
        self.assertEqual(badge['file'], 'communitybadge.png')
        self.assertTrue((self.badge_dir / 'communitybadge.png').is_file())
        badge_id = badge['asset_id']
        renamed = self.client.patch(f'/admin/badges/{badge_id}', json={'name': 'Community Icon'})
        self.assertEqual(renamed.status_code, 200)
        badge = renamed.get_json()['badge']
        self.assertEqual(badge['file'], 'communityicon.png')
        self.assertFalse((self.badge_dir / 'communitybadge.png').exists())
        self.assertTrue((self.badge_dir / 'communityicon.png').is_file())
        duplicate = self.create_badge('Community Icon')
        self.assertEqual(duplicate.status_code, 409)

        self.login_as(self.user, admin_session=True)
        self.assertEqual(self.client.get('/admin/badges').status_code, 403)
        denied = self.client.post(
            f"/admin/users/{self.user['username']}/badges",
            json={'badge_id': badge['asset_id']},
        )
        self.assertEqual(denied.status_code, 403)
        denied_removal = self.client.delete(
            f"/admin/users/{self.user['username']}/badges",
            json={'badge_id': badge['asset_id']},
        )
        self.assertEqual(denied_removal.status_code, 403)

        self.login_as(self.admin, admin_session=True)
        granted = self.client.post(
            f"/admin/users/{self.user['username']}/badges",
            json={'badge_id': badge['asset_id']},
        )
        self.assertEqual(granted.status_code, 200)
        self.assertEqual(
            self.users.find_one({'_id': self.user['_id']})['badges'],
            [ObjectId(badge['asset_id'])],
        )

        self.login_as(self.user)
        profile = self.client.get('/account/profile').get_json()['user']
        self.assertEqual(profile['email'], self.user['email'])
        self.assertEqual(profile['badges'][0]['asset_id'], badge['asset_id'])
        selected = self.client.put(
            '/account/profile/badge',
            json={'badge_id': badge['asset_id']},
        )
        self.assertEqual(selected.status_code, 200)
        self.assertEqual(selected.get_json()['user']['visible_badge_id'], badge['asset_id'])
        chat_message = routes.add_current_ranks([{'user': self.user['username'], 'message': 'Hello'}])[0]
        self.assertEqual(chat_message['badge']['asset_id'], badge['asset_id'])
        self.assertEqual(chat_message['badge']['name'], badge['name'])
        self.assertTrue(any(
            call.args[0] == 'chat_history'
            for call in self.socketio.emit.call_args_list
        ))

        self.login_as(self.admin, admin_session=True)
        removed_from_user = self.client.delete(
            f"/admin/users/{self.user['username']}/badges",
            json={'badge_id': badge['asset_id']},
        )
        self.assertEqual(removed_from_user.status_code, 200)
        self.assertTrue(removed_from_user.get_json()['removed'])
        updated_user = self.users.find_one({'_id': self.user['_id']})
        self.assertEqual(updated_user.get('badges'), [])
        self.assertNotIn('visible_badge_id', updated_user)

        granted_again = self.client.post(
            f"/admin/users/{self.user['username']}/badges",
            json={'badge_id': badge['asset_id']},
        )
        self.assertTrue(granted_again.get_json()['granted'])
        unrelated_visible_badge = str(ObjectId())
        self.users.update_one(
            {'_id': self.user['_id']},
            {'$set': {'visible_badge_id': unrelated_visible_badge}},
        )
        removed_with_other_badge_visible = self.client.delete(
            f"/admin/users/{self.user['username']}/badges",
            json={'badge_id': badge['asset_id']},
        )
        self.assertTrue(removed_with_other_badge_visible.get_json()['removed'])
        self.assertEqual(
            self.users.find_one({'_id': self.user['_id']})['visible_badge_id'],
            unrelated_visible_badge,
        )
        self.users.update_one(
            {'_id': self.user['_id']},
            {'$unset': {'visible_badge_id': ''}},
        )
        removed = self.client.delete(f"/admin/badges/{badge['asset_id']}")
        self.assertEqual(removed.status_code, 200)
        self.assertEqual(self.users.find_one({'_id': self.user['_id']}).get('badges'), [])
        self.assertNotIn('visible_badge_id', self.users.find_one({'_id': self.user['_id']}))
        self.assertFalse((self.badge_dir / 'communityicon.png').exists())

    def test_badge_can_be_granted_to_current_online_users_only(self):
        self.login_as(self.admin, admin_session=True)
        created = self.create_badge()
        badge_id = created.get_json()['badge']['asset_id']
        routes.onlineusers.add(self.user['username'])
        response = self.client.post(f'/admin/badges/{badge_id}/grant-online')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['granted_count'], 1)
        self.assertEqual(
            self.users.find_one({'_id': self.user['_id']})['badges'],
            [ObjectId(badge_id)],
        )

    def test_profile_private_data_and_self_service_recovery(self):
        self.login_as(self.user)
        own_profile = self.client.get('/admin/users/asset-user')
        self.assertEqual(own_profile.status_code, 200)
        self.assertEqual(own_profile.get_json()['user']['email'], self.user['email'])
        denied = self.client.get('/admin/users/asset-admin')
        self.assertEqual(denied.status_code, 403)
        self.login_as(self.admin, admin_session=True)
        inspected_profile = self.client.get('/admin/users/asset-user')
        self.assertEqual(inspected_profile.status_code, 200)
        self.assertEqual(inspected_profile.get_json()['user']['email'], self.user['email'])

        self.login_as(self.user)
        issued = self.client.post('/account/recovery', json={'recovery_type': 'password'})
        self.assertEqual(issued.status_code, 200)
        token = issued.get_json()['reset_token']
        self.assertEqual(self.users.find_one({'_id': self.user['_id']})['password_hash'], 'user-hash')
        self.assertEqual(self.client.get('/account/profile').status_code, 200)
        verified = self.client.post('/auth/password-reset', json={
            'reset_token': token,
            'action': 'verify',
        })
        self.assertEqual(verified.status_code, 200)
        self.assertEqual(verified.get_json()['recovery_type'], 'password')
        email_reset = self.client.post('/account/recovery', json={'recovery_type': 'email'})
        self.assertEqual(email_reset.status_code, 409)
        completed_password = self.client.post('/auth/password-reset', json={
            'reset_token': token,
            'password': 'new-password',
            'confirmation': 'new-password',
        })
        self.assertEqual(completed_password.status_code, 200)

        self.login_as(self.user)
        issued_email = self.client.post('/account/recovery', json={'recovery_type': 'email'})
        self.assertEqual(issued_email.status_code, 200)
        email_token = issued_email.get_json()['reset_token']
        completed_email = self.client.post('/auth/password-reset', json={
            'reset_token': email_token,
            'email': 'updated@example.com',
        })
        self.assertEqual(completed_email.status_code, 200)
        self.assertEqual(self.users.find_one({'_id': self.user['_id']})['email'], 'updated@example.com')

    def test_theme_creation_validates_background_and_uses_default_price(self):
        self.login_as(self.admin, admin_session=True)

        response = self.client.post(
            '/admin/themes',
            data={
                'name': 'Uploaded Theme',
                'primary_color': '#112233',
                'panel_color': '#223344',
                'accent_color': '#aabbcc',
                'background_opacity': '0.35',
                'background': (io.BytesIO(self.png_bytes()), 'background.png'),
            },
            content_type='multipart/form-data',
        )

        self.assertEqual(response.status_code, 201)
        result = response.get_json()['theme']
        theme = self.themes.find_one({'_id': ObjectId(result['asset_id'])})
        self.assertEqual(theme['price'], 10000)
        self.assertFalse(theme['price_overridden'])
        self.assertEqual(theme['primary_color'], '#112233')
        self.assertEqual(theme['panel_color'], '#223344')
        self.assertEqual(theme['accent_color'], '#aabbcc')
        self.assertEqual(result['panel_color'], '#223344')
        self.assertEqual(theme['background_opacity'], 0.35)
        self.assertTrue(theme['background_image_exists'])
        self.assertTrue((self.public_dir / 'img' / 'backgrounds' / theme['background_image_name']).is_file())
        self.assertEqual(theme['background_image_name'], 'uploadedtheme.png')
        self.assertEqual(result['url'], f"/img/backgrounds/{theme['background_image_name']}")
        self.assertEqual(self.chat.documents[-1]['message'], 'Added theme: Uploaded Theme.')
        self.assertTrue(self.chat.documents[-1]['system'])
        self.assertNotIn('user', self.chat.documents[-1])
        self.socketio.emit.assert_any_call(
            'asset_catalog_changed',
            {'asset_type': 'theme'},
        )
        self.socketio.emit.assert_any_call(
            'chat_message',
            {'system': True, 'message': 'Added theme: Uploaded Theme.'},
        )

    def test_theme_background_upload_accepts_17_mib_and_uses_normalized_name(self):
        self.login_as(self.admin, admin_session=True)
        image = self.png_bytes(4097, 4097) + (b'\x00' * (17 * 1024 * 1024))

        response = self.client.post(
            '/admin/themes',
            data={
                'name': 'X mas!',
                'primary_color': '#112233',
                'panel_color': '#223344',
                'accent_color': '#aabbcc',
                'background_opacity': '0.35',
                'background': (io.BytesIO(image), 'background.png'),
            },
            content_type='multipart/form-data',
        )

        self.assertEqual(response.status_code, 201)
        theme = self.themes.find_one({'_id': ObjectId(response.get_json()['theme']['asset_id'])})
        self.assertEqual(theme['background_image_name'], 'xmas.png')
        self.assertTrue((self.public_dir / 'img' / 'backgrounds' / 'xmas.png').is_file())

    def test_theme_background_upload_rejects_files_over_50_mib(self):
        self.login_as(self.admin, admin_session=True)
        image = self.png_bytes() + (b'\x00' * (50 * 1024 * 1024))

        response = self.client.post(
            '/admin/themes',
            data={
                'name': 'Oversized Theme',
                'primary_color': '#112233',
                'panel_color': '#223344',
                'accent_color': '#aabbcc',
                'background_opacity': '0.35',
                'background': (io.BytesIO(image), 'background.png'),
            },
            content_type='multipart/form-data',
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.get_json()['message'],
            'Theme backgrounds must be no larger than 50 MB',
        )
        self.assertEqual(self.themes.documents, [])

    def test_theme_background_upload_rejects_dimensions_over_8192_pixels(self):
        self.login_as(self.admin, admin_session=True)

        response = self.client.post(
            '/admin/themes',
            data={
                'name': 'Oversized Dimensions',
                'primary_color': '#112233',
                'panel_color': '#223344',
                'accent_color': '#aabbcc',
                'background_opacity': '0.35',
                'background': (io.BytesIO(self.png_bytes(8193, 1)), 'background.png'),
            },
            content_type='multipart/form-data',
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.get_json()['message'],
            'Theme background dimensions must not exceed 8192 by 8192 pixels',
        )
        self.assertEqual(self.themes.documents, [])

    def test_duplicate_normalized_theme_background_filename_is_rejected(self):
        self.login_as(self.admin, admin_session=True)

        first = self.client.post(
            '/admin/themes',
            data={
                'name': 'Gierek',
                'primary_color': '#112233',
                'panel_color': '#223344',
                'accent_color': '#aabbcc',
                'background_opacity': '0.35',
                'background': (io.BytesIO(self.png_bytes()), 'first.png'),
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(first.status_code, 201)
        first_theme_id = first.get_json()['theme']['asset_id']
        self.assertEqual(
            self.themes.find_one({'_id': ObjectId(first_theme_id)})['background_image_name'],
            'gierek.png',
        )

        duplicate = self.client.post(
            '/admin/themes',
            data={
                'name': 'GIEREK!',
                'primary_color': '#112233',
                'panel_color': '#223344',
                'accent_color': '#aabbcc',
                'background_opacity': '0.35',
                'background': (io.BytesIO(self.png_bytes()), 'second.png'),
            },
            content_type='multipart/form-data',
        )

        self.assertEqual(duplicate.status_code, 409)
        self.assertIn('normalized theme name', duplicate.get_json()['message'])
        self.assertEqual(len(self.themes.documents), 1)
        self.assertTrue((self.public_dir / 'img' / 'backgrounds' / 'gierek.png').is_file())

    def test_theme_rename_rejects_background_filename_used_by_another_theme(self):
        self.login_as(self.admin, admin_session=True)
        existing_background = self.client.post(
            '/admin/themes',
            data={
                'name': 'Gierek',
                'primary_color': '#112233',
                'panel_color': '#223344',
                'accent_color': '#aabbcc',
                'background_opacity': '0.35',
                'background': (io.BytesIO(self.png_bytes()), 'first.png'),
            },
            content_type='multipart/form-data',
        ).get_json()['theme']
        other_theme = self.client.post(
            '/admin/themes',
            data={
                'name': 'Other Theme',
                'primary_color': '#112233',
                'panel_color': '#223344',
                'accent_color': '#aabbcc',
                'background_opacity': '0.35',
                'background': (io.BytesIO(self.png_bytes()), 'second.png'),
            },
            content_type='multipart/form-data',
        ).get_json()['theme']
        other_theme_id = ObjectId(other_theme['asset_id'])

        response = self.client.patch(
            f"/admin/themes/{other_theme_id}",
            data={
                'name': 'GIEREK!',
                'primary_color': '#112233',
                'panel_color': '#223344',
                'accent_color': '#aabbcc',
            },
            content_type='multipart/form-data',
        )

        self.assertEqual(response.status_code, 409)
        self.assertIn('normalized theme name', response.get_json()['message'])
        self.assertEqual(
            self.themes.find_one({'_id': ObjectId(existing_background['asset_id'])})['background_image_name'],
            'gierek.png',
        )
        self.assertEqual(self.themes.find_one({'_id': other_theme_id})['name'], 'Other Theme')

    def test_theme_rename_renames_existing_background_file(self):
        self.login_as(self.admin, admin_session=True)
        created = self.client.post(
            '/admin/themes',
            data={
                'name': 'Old Name',
                'primary_color': '#112233',
                'panel_color': '#223344',
                'accent_color': '#aabbcc',
                'background_opacity': '0.35',
                'background': (io.BytesIO(self.png_bytes()), 'background.png'),
            },
            content_type='multipart/form-data',
        )
        theme = created.get_json()['theme']

        updated = self.client.patch(
            f"/admin/themes/{theme['asset_id']}",
            data={
                'name': 'New Name!',
                'primary_color': '#112233',
                'panel_color': '#223344',
                'accent_color': '#aabbcc',
            },
            content_type='multipart/form-data',
        )

        self.assertEqual(updated.status_code, 200)
        saved = self.themes.find_one({'_id': ObjectId(theme['asset_id'])})
        self.assertEqual(saved['background_image_name'], 'newname.png')
        self.assertFalse((self.public_dir / 'img' / 'backgrounds' / 'oldname.png').exists())
        self.assertTrue((self.public_dir / 'img' / 'backgrounds' / 'newname.png').is_file())

    def test_theme_price_override_is_saved_in_shared_catalog_pricing(self):
        self.login_as(self.admin, admin_session=True)

        response = self.client.post(
            '/admin/themes',
            data={
                'name': 'Priced Theme',
                'primary_color': '#112233',
                'panel_color': '#223344',
                'accent_color': '#aabbcc',
                'price': '2500',
            },
            content_type='multipart/form-data',
        )

        self.assertEqual(response.status_code, 201)
        theme_id = response.get_json()['theme']['asset_id']
        theme = self.themes.find_one({'_id': ObjectId(theme_id)})
        saved_pricing = self.pricing.find_one({'_id': routes.POINT_PRICING_ID})['pricing']
        self.assertEqual(saved_pricing['catalog']['theme']['items'][theme_id], 2500)
        self.assertEqual(theme['price'], 2500)
        self.assertTrue(theme['price_overridden'])

    def test_admin_can_search_and_edit_theme_fields_background_and_price(self):
        self.login_as(self.admin, admin_session=True)
        theme_id = ObjectId()
        self.themes.insert_one({
            '_id': theme_id,
            'name': 'Editable Theme',
            'name_key': 'editable theme',
            'price': 10000,
            'price_overridden': False,
            'primary_color': '#000000',
            'panel_color': '#171717',
            'accent_color': '#f9a8d4',
            'background_image_exists': False,
            'background_opacity': 0.0,
            'background_image_name': None,
            'is_standard': False,
        })

        updated = self.client.patch(
            f'/admin/themes/{theme_id}',
            data={
                'name': 'Updated Theme',
                'primary_color': '#111111',
                'panel_color': '#222222',
                'accent_color': '#f9a8d4',
                'price': '2500',
                'background_opacity': '0.4',
                'background': (io.BytesIO(self.png_bytes()), 'background.png'),
            },
            content_type='multipart/form-data',
        )
        updated_theme = self.themes.find_one({'_id': theme_id})
        background_path = self.public_dir / 'img' / 'backgrounds' / updated_theme['background_image_name']

        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated_theme['name'], 'Updated Theme')
        self.assertEqual(updated_theme['primary_color'], '#111111')
        self.assertEqual(updated_theme['panel_color'], '#222222')
        self.assertEqual(updated.get_json()['theme']['panel_color'], '#222222')
        self.assertEqual(updated_theme['price'], 2500)
        self.assertTrue(background_path.is_file())
        self.assertEqual(updated_theme['background_image_name'], 'updatedtheme.png')
        self.assertEqual(self.chat.documents[-1]['message'], 'Updated theme: Updated Theme.')
        self.assertNotIn('user', self.chat.documents[-1])
        self.socketio.emit.assert_any_call(
            'chat_message',
            {'system': True, 'message': 'Updated theme: Updated Theme.'},
        )
        self.assertEqual(
            self.pricing.find_one({'_id': routes.POINT_PRICING_ID})['pricing']['catalog']['theme']['items'][str(theme_id)],
            2500,
        )

        removed_background = self.client.patch(
            f'/admin/themes/{theme_id}',
            data={
                'name': 'Updated Theme',
                'primary_color': '#111111',
                'panel_color': '#222222',
                'accent_color': '#f9a8d4',
                'price': '',
                'background_opacity': '0.4',
                'remove_background': 'true',
            },
            content_type='multipart/form-data',
        )
        updated_theme = self.themes.find_one({'_id': theme_id})

        self.assertEqual(removed_background.status_code, 200)
        self.assertFalse(updated_theme['background_image_exists'])
        self.assertIsNone(updated_theme['background_image_name'])
        self.assertFalse(background_path.exists())
        self.assertNotIn(
            str(theme_id),
            self.pricing.find_one({'_id': routes.POINT_PRICING_ID})['pricing']['catalog']['theme']['items'],
        )

    def test_admin_can_remove_theme_and_clear_ownership_and_selected_theme(self):
        self.login_as(self.admin, admin_session=True)
        theme_id = ObjectId()
        background_directory = self.public_dir / 'img' / 'backgrounds'
        background_directory.mkdir(parents=True)
        background_path = background_directory / f'{theme_id}.png'
        background_path.write_bytes(self.png_bytes())
        theme = {
            '_id': theme_id,
            'name': 'Removable Theme',
            'name_key': 'removable theme',
            'price': 500,
            'price_overridden': True,
            'primary_color': '#111111',
            'panel_color': '#222222',
            'accent_color': '#f9a8d4',
            'background_image_exists': True,
            'background_opacity': 0.4,
            'background_image_name': background_path.name,
            'is_standard': False,
        }
        self.themes.insert_one(theme)
        pricing = copy.deepcopy(self.pricing.find_one({'_id': routes.POINT_PRICING_ID})['pricing'])
        pricing['catalog']['theme']['items'][str(theme_id)] = 500
        self.pricing.update_one(
            {'_id': routes.POINT_PRICING_ID},
            {'$set': {'pricing': pricing}},
        )
        self.ownership.insert_one({
            'user_id': self.user['_id'],
            'asset_type': 'theme',
            'asset_id': theme_id,
        })
        self.users.update_one({'_id': self.user['_id']}, {'$set': {'theme_id': str(theme_id)}})

        response = self.client.delete(f'/admin/themes/{theme_id}')

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(self.themes.find_one({'_id': theme_id}))
        self.assertEqual(self.ownership.documents, [])
        self.assertEqual(self.users.find_one({'_id': self.user['_id']})['theme_id'], str(routes.STANDARD_THEME_ID))
        self.assertFalse(background_path.exists())
        self.assertEqual(self.pricing.find_one({'_id': routes.POINT_PRICING_ID})['pricing']['catalog']['theme']['items'], {})
        self.assertEqual(self.chat.documents[-1]['message'], 'Removed theme: Removable Theme.')
        self.socketio.emit.assert_any_call('asset_catalog_changed', {'asset_type': 'theme'})

    def test_theme_creation_rejects_non_admin_invalid_images_and_private_urls(self):
        self.login_as(self.user, admin_session=True)
        base_form = {
            'name': 'Blocked Theme',
            'primary_color': '#112233',
            'accent_color': '#aabbcc',
        }
        denied_edit = self.client.patch(
            f"/admin/themes/{ObjectId()}",
            data=base_form,
            content_type='multipart/form-data',
        )
        denied_delete = self.client.delete(f"/admin/themes/{ObjectId()}")
        denied = self.client.post(
            '/admin/themes',
            data={**base_form, 'background': (io.BytesIO(self.png_bytes()), 'background.png')},
            content_type='multipart/form-data',
        )
        self.assertEqual(denied_edit.status_code, 403)
        self.assertEqual(denied_delete.status_code, 403)
        self.assertEqual(denied.status_code, 403)

        self.login_as(self.admin, admin_session=True)
        invalid_image = self.client.post(
            '/admin/themes',
            data={
                **base_form,
                'background_opacity': '0.5',
                'background': (io.BytesIO(b'not an image'), 'background.png'),
            },
            content_type='multipart/form-data',
        )
        invalid_opacity = self.client.post(
            '/admin/themes',
            data={
                **base_form,
                'name': 'Invalid Opacity Theme',
                'background_opacity': '1.2',
                'background': (io.BytesIO(self.png_bytes()), 'background.png'),
            },
            content_type='multipart/form-data',
        )
        private_url = self.client.post(
            '/admin/themes',
            data={
                **base_form,
                'name': 'Private URL Theme',
                'background_opacity': '0.5',
                'background_url': 'https://127.0.0.1/background.png',
            },
            content_type='multipart/form-data',
        )

        self.assertEqual(invalid_image.status_code, 400)
        self.assertEqual(invalid_opacity.status_code, 400)
        self.assertEqual(private_url.status_code, 400)
        self.assertEqual(self.themes.documents, [])

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

    def test_blank_managed_sound_prices_clear_exceptions_to_use_defaults(self):
        self.login_as(self.admin, admin_session=True)
        sound_id = ObjectId()
        self.sounds.insert_one({
            '_id': sound_id,
            'name': 'defaultsound',
            'pricing_name': 'defaultsound',
            'display_name': 'Defaultsound',
            'loudness': 1.0,
            'file': 'defaultsound.mp3',
        })
        pricing = self.pricing.documents[0]['pricing']
        pricing['catalog']['sound']['items']['defaultsound.mp3'] = 25
        pricing['catalog']['sound']['play_items']['defaultsound.mp3'] = 5

        response = self.client.patch(
            f'/admin/assets/sound/{sound_id}',
            json={
                'display_name': 'Defaultsound',
                'loudness': 1.0,
                'price': None,
                'play_price': None,
            },
        )

        self.assertEqual(response.status_code, 200)
        saved_pricing = routes.load_point_pricing()['catalog']['sound']
        self.assertNotIn('defaultsound.mp3', saved_pricing['items'])
        self.assertNotIn('defaultsound.mp3', saved_pricing['play_items'])

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
