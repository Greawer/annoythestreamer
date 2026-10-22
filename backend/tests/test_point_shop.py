import copy
import sys
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from bson import ObjectId
from flask import Flask
from pymongo.errors import DuplicateKeyError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import routes
from backend.tests.permission_fixtures import configure_role_permissions


class MemoryCollection:
    def __init__(self, documents=()):
        self.documents = [copy.deepcopy(document) for document in documents]
        self.lock = threading.Lock()

    @staticmethod
    def matches(document, query):
        for key, expected in query.items():
            actual = document.get(key)
            if isinstance(expected, dict):
                if '$in' in expected and actual not in expected['$in']:
                    return False
                if '$exists' in expected and (key in document) != expected['$exists']:
                    return False
                if '$ne' in expected and actual == expected['$ne']:
                    return False
            elif actual != expected:
                return False
        return True

    def find_one(self, query, *_args, **_kwargs):
        with self.lock:
            result = next((item for item in self.documents if self.matches(item, query)), None)
            return copy.deepcopy(result) if result else None

    def find(self, query=None, *_args, **_kwargs):
        with self.lock:
            return MemoryCursor(
                copy.deepcopy(item)
                for item in self.documents
                if self.matches(item, query or {})
            )

    def insert_one(self, document):
        with self.lock:
            new_document = copy.deepcopy(document)
            new_document.setdefault('_id', ObjectId())
            if any(
                item.get('user_id') == new_document.get('user_id')
                and item.get('asset_type') == new_document.get('asset_type')
                and item.get('asset_id') == new_document.get('asset_id')
                for item in self.documents
            ):
                raise DuplicateKeyError('duplicate ownership')
            self.documents.append(new_document)
            document.setdefault('_id', new_document['_id'])

    def update_one(self, query, update, **_kwargs):
        with self.lock:
            item = next((value for value in self.documents if self.matches(value, query)), None)
            if not item:
                return SimpleNamespace(matched_count=0, modified_count=0)
            item.update(copy.deepcopy(update.get('$set', {})))
            for key in update.get('$unset', {}):
                item.pop(key, None)
            return SimpleNamespace(matched_count=1, modified_count=1)

    def find_one_and_update(self, query, update, **_kwargs):
        with self.lock:
            item = next((value for value in self.documents if value.get('_id') == query.get('_id')), None)
            if not item or item.get('pending_point_operation') is not None:
                return None
            cost = query['$expr']['$gte'][1]
            if item.get('points', 0) < cost:
                return None
            item['points'] = item.get('points', 0) + update['$inc']['points']
            item.update(copy.deepcopy(update['$set']))
            item.setdefault('shop_purchase_ids', [])
            for value in update.get('$addToSet', {}).values():
                if value not in item['shop_purchase_ids']:
                    item['shop_purchase_ids'].append(value)
            return copy.deepcopy(item)


class MemoryAssetCollection(MemoryCollection):
    pass


class MemoryCursor(list):
    def sort(self, key, direction=1):
        return MemoryCursor(sorted(
            self,
            key=lambda item: item.get(key),
            reverse=direction < 0,
        ))


class MemoryShopPurchases(MemoryCollection):
    def insert_one(self, document):
        with self.lock:
            if any(
                item.get('user_id') == document.get('user_id')
                and item.get('asset_type') == document.get('asset_type')
                and item.get('asset_id') == document.get('asset_id')
                for item in self.documents
            ) or any(
                item.get('user_id') == document.get('user_id')
                and item.get('request_id') == document.get('request_id')
                for item in self.documents
            ):
                raise DuplicateKeyError('duplicate purchase')
            document.setdefault('_id', ObjectId())
            self.documents.append(copy.deepcopy(document))

    def update_one(self, query, update, **_kwargs):
        with self.lock:
            item = next((value for value in self.documents if self.matches(value, query)), None)
            if not item:
                return SimpleNamespace(matched_count=0, modified_count=0)
            item.update(copy.deepcopy(update.get('$set', {})))
            return SimpleNamespace(matched_count=1, modified_count=1)


class MemorySoundFavorites(MemoryCollection):
    def insert_one(self, document):
        with self.lock:
            if any(
                item.get('user_id') == document.get('user_id')
                and item.get('asset_id') == document.get('asset_id')
                for item in self.documents
            ):
                raise DuplicateKeyError('duplicate sound favorite')
            new_document = copy.deepcopy(document)
            new_document.setdefault('_id', ObjectId())
            self.documents.append(new_document)

    def delete_one(self, query):
        with self.lock:
            item = next((value for value in self.documents if self.matches(value, query)), None)
            if item is None:
                return SimpleNamespace(deleted_count=0)
            self.documents.remove(item)
            return SimpleNamespace(deleted_count=1)


class MemoryUsers(MemoryCollection):
    def update_one(self, query, update, **kwargs):
        result = super().update_one(query, update, **kwargs)
        if result.matched_count and 'pending_point_operation' in update.get('$unset', {}):
            with self.lock:
                user = next((item for item in self.documents if item.get('_id') == query['_id']), None)
                if user and user.get('pending_point_operation') == query.get('pending_point_operation'):
                    user.pop('pending_point_operation', None)
        return result


class MemoryTransactions:
    def __init__(self):
        self.documents = {}
        self.fail_next = False

    def update_one(self, query, update, upsert=False):
        if self.fail_next:
            self.fail_next = False
            raise RuntimeError('simulated point ledger failure')
        key = (query['user_id'], query['request_id'])
        self.documents.setdefault(key, copy.deepcopy(update['$setOnInsert']))
        return SimpleNamespace(matched_count=1, modified_count=0, upserted_id=None)


class PointShopTests(unittest.TestCase):
    def setUp(self):
        self.user_id = ObjectId()
        self.sound_id = ObjectId()
        self.other_sound_id = ObjectId()
        self.emoji_id = ObjectId()
        self.user = {
            '_id': self.user_id,
            'username': 'shop-user',
            'rank': 'User',
            'points': 250,
        }
        self.users = MemoryUsers([self.user])
        self.sounds = MemoryAssetCollection([
            {'_id': self.sound_id, 'name': 'sound', 'pricing_name': 'sound', 'file': 'sound.mp3'},
            {'_id': self.other_sound_id, 'name': 'unavailable', 'pricing_name': 'unavailable', 'file': 'unavailable.mp3'},
        ])
        self.emojis = MemoryAssetCollection([
            {'_id': self.emoji_id, 'name': 'party', 'pricing_name': 'party', 'file': 'party.png'},
        ])
        self.ownership = MemoryCollection()
        self.purchases = MemoryShopPurchases()
        self.favorites = MemorySoundFavorites()
        self.transactions = MemoryTransactions()
        self.pricing = copy.deepcopy(routes.DEFAULT_POINT_PRICING)
        self.pricing['catalog']['sound']['items']['unavailable'] = -1
        self.pricing['catalog']['emoji']['items']['party'] = 35
        self.ranks = Mock()
        self.permissions = Mock()
        self.patches = [
            patch.object(routes, 'colusers', self.users),
            patch.object(routes, 'colsounds', self.sounds),
            patch.object(routes, 'colemojis', self.emojis),
            patch.object(routes, 'colassetownership', self.ownership),
            patch.object(routes, 'colshoppurchases', self.purchases),
            patch.object(routes, 'colsoundfavorites', self.favorites),
            patch.object(routes, 'colpointtransactions', self.transactions),
            patch.object(routes, 'colranks', self.ranks),
            patch.object(routes, 'colpermissions', self.permissions),
            patch.object(routes, 'load_point_pricing', side_effect=lambda: copy.deepcopy(self.pricing)),
        ]
        for active_patch in self.patches:
            active_patch.start()
        configure_role_permissions(routes, self.ranks, self.permissions)
        self.app = Flask(__name__)
        self.app.secret_key = 'test-only-secret'
        routes.registerroutes(self.app, None)
        self.client = self.app.test_client()
        self.addCleanup(self.stop_patches)

    def stop_patches(self):
        for active_patch in reversed(self.patches):
            active_patch.stop()

    def buy(
        self,
        asset_type='sound',
        asset_id=None,
        request_id='10ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a',
        expected_price=None,
    ):
        return routes.purchase_catalog_asset(
            self.user,
            asset_type,
            str(asset_id or self.sound_id),
            request_id,
            expected_price,
        )

    def test_catalog_uses_defaults_and_marks_unavailable_exceptions(self):
        catalog = routes.list_shop_assets(self.user)

        sound_by_name = {asset['name']: asset for asset in catalog['sound']}
        self.assertEqual(sound_by_name['sound']['price'], 100)
        self.assertEqual(sound_by_name['sound']['status'], 'available')
        self.assertEqual(sound_by_name['unavailable']['price'], -1)
        self.assertEqual(sound_by_name['unavailable']['status'], 'unavailable')
        self.assertEqual(catalog['emoji'][0]['price'], 35)

    def test_catalog_groups_purchasable_owned_then_unavailable_alphabetically(self):
        available_sound_id = ObjectId()
        owned_sound_id = ObjectId()
        available_emoji_id = ObjectId()
        unavailable_emoji_id = ObjectId()
        self.sounds.documents.extend([
            {'_id': available_sound_id, 'name': 'a-available', 'pricing_name': 'a-available', 'file': 'a.mp3'},
            {'_id': owned_sound_id, 'name': 'z-owned', 'pricing_name': 'z-owned', 'file': 'z.mp3'},
        ])
        self.emojis.documents.extend([
            {'_id': available_emoji_id, 'name': 'a-available', 'pricing_name': 'a-available', 'file': 'a.png'},
            {'_id': unavailable_emoji_id, 'name': 'z-unavailable', 'pricing_name': 'z-unavailable', 'file': 'z.png'},
        ])
        self.pricing['catalog']['emoji']['items']['z-unavailable'] = -1
        self.ownership.insert_one({
            'user_id': self.user_id,
            'asset_type': 'sound',
            'asset_id': self.sound_id,
        })
        self.ownership.insert_one({
            'user_id': self.user_id,
            'asset_type': 'sound',
            'asset_id': owned_sound_id,
        })
        self.ownership.insert_one({
            'user_id': self.user_id,
            'asset_type': 'emoji',
            'asset_id': self.emoji_id,
        })

        catalog = routes.list_shop_assets(self.user)

        self.assertEqual(
            [asset['name'] for asset in catalog['sound']],
            ['a-available', 'sound', 'z-owned', 'unavailable'],
        )
        self.assertEqual(
            [asset['status'] for asset in catalog['sound']],
            ['available', 'owned', 'owned', 'unavailable'],
        )
        self.assertEqual(
            [asset['name'] for asset in catalog['emoji']],
            ['a-available', 'party', 'z-unavailable'],
        )
        self.assertEqual(
            [asset['status'] for asset in catalog['emoji']],
            ['available', 'owned', 'unavailable'],
        )

    def test_purchase_debits_once_and_grants_stable_id_ownership(self):
        first, first_status = self.buy()
        second, second_status = self.buy()

        self.assertEqual((first_status, second_status), (200, 200))
        self.assertEqual(first['points'], 150)
        self.assertTrue(second['duplicate'])
        self.assertEqual(self.users.find_one({'_id': self.user_id})['points'], 150)
        self.assertEqual(len(self.ownership.documents), 1)
        self.assertEqual(self.ownership.documents[0]['asset_id'], self.sound_id)
        self.assertEqual(len(self.transactions.documents), 1)
        transaction = next(iter(self.transactions.documents.values()))
        self.assertEqual(transaction['action_type'], 'shop_purchase')
        self.assertEqual(transaction['amount'], -100)
        catalog = routes.list_shop_assets(self.user)
        self.assertEqual(
            next(asset for asset in catalog['sound'] if asset['asset_id'] == str(self.sound_id))['status'],
            'owned',
        )

    def test_concurrent_purchase_requests_for_same_asset_charge_once(self):
        request_ids = (
            '50ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a',
            '60ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a',
        )
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(
                lambda request_id: self.buy(request_id=request_id),
                request_ids,
            ))

        self.assertEqual([status for _, status in results], [200, 200])
        self.assertEqual(self.users.find_one({'_id': self.user_id})['points'], 150)
        self.assertEqual(len(self.ownership.documents), 1)
        self.assertEqual(len(self.transactions.documents), 1)

    def test_zero_price_is_free_but_minus_one_is_unavailable(self):
        self.pricing['catalog']['emoji']['items']['party'] = 0
        free, free_status = self.buy('emoji', self.emoji_id)
        unavailable, unavailable_status = self.buy(
            'sound',
            self.other_sound_id,
            request_id='30ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a',
        )

        self.assertEqual(free_status, 200)
        self.assertEqual(free['points'], 250)
        self.assertEqual(unavailable_status, 403)
        self.assertEqual(unavailable['code'], 'asset_unavailable')
        self.assertEqual(self.users.find_one({'_id': self.user_id})['points'], 250)
        self.assertEqual(len(self.ownership.documents), 1)
        self.assertEqual(self.transactions.documents, {})

    def test_minus_one_exception_is_unavailable_to_buy_but_admin_can_still_use_asset(self):
        self.pricing['catalog']['emoji']['items']['party'] = -1

        catalog = routes.list_shop_assets(self.user)
        unavailable = next(asset for asset in catalog['emoji'] if asset['name'] == 'party')
        purchase, status = self.buy('emoji', self.emoji_id)

        self.assertEqual(unavailable['status'], 'unavailable')
        self.assertEqual(unavailable['price'], -1)
        self.assertEqual(status, 403)
        self.assertEqual(purchase['code'], 'asset_unavailable')
        admin = {'_id': ObjectId(), 'rank': 'Admin'}
        with patch.object(routes, 'has_permission', return_value=True):
            usable_emojis = routes.list_usable_assets(admin, 'emoji')
        self.assertEqual([asset['name'] for asset in usable_emojis], ['party'])

    def test_stale_displayed_price_is_rejected_before_charging(self):
        response, status = self.buy(expected_price=99)

        self.assertEqual(status, 409)
        self.assertEqual(response['code'], 'price_changed')
        self.assertEqual(response['price'], 100)
        self.assertEqual(self.users.find_one({'_id': self.user_id})['points'], 250)
        self.assertEqual(self.ownership.documents, [])

    def test_minus_one_default_is_unavailable(self):
        self.pricing['catalog']['sound']['default'] = -1

        response, status = self.buy(expected_price=100)

        self.assertEqual(status, 403)
        self.assertEqual(response['code'], 'asset_unavailable')
        self.assertEqual(self.users.find_one({'_id': self.user_id})['points'], 250)
        self.assertEqual(self.ownership.documents, [])

    def test_insufficient_balance_can_be_retried_after_balance_changes(self):
        self.users.documents[0]['points'] = 50
        response, status = self.buy()
        self.assertEqual(status, 402)
        self.assertEqual(response['code'], 'insufficient_points')
        self.assertEqual(self.ownership.documents, [])

        self.users.documents[0]['points'] = 150
        retried, retry_status = self.buy(request_id='20ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a')

        self.assertEqual(retry_status, 200)
        self.assertEqual(retried['points'], 50)
        self.assertEqual(len(self.ownership.documents), 1)

    def test_request_id_cannot_be_reused_for_a_different_asset(self):
        self.buy()
        conflict, status = self.buy(
            asset_id=self.other_sound_id,
            request_id='10ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a',
        )

        self.assertEqual(status, 409)
        self.assertEqual(conflict['code'], 'request_id_conflict')
        self.assertEqual(self.users.find_one({'_id': self.user_id})['points'], 150)

    def test_retry_completes_pending_ledger_without_second_debit(self):
        self.transactions.fail_next = True
        first, first_status = self.buy()
        retry, retry_status = self.buy()

        self.assertEqual(first_status, 503)
        self.assertEqual(retry_status, 200)
        self.assertEqual(retry['points'], 150)
        self.assertEqual(self.users.find_one({'_id': self.user_id})['points'], 150)
        self.assertEqual(len(self.transactions.documents), 1)
        self.assertNotIn('pending_point_operation', self.users.find_one({'_id': self.user_id}))

    def test_admin_capability_blocks_shop_purchase(self):
        with patch.object(routes, 'has_permission', return_value=True):
            result, status = self.buy()

        self.assertEqual(status, 403)
        self.assertEqual(self.users.find_one({'_id': self.user_id})['points'], 250)
        self.assertEqual(self.ownership.documents, [])

    def test_shop_routes_use_authenticated_account_and_return_catalog(self):
        self.assertEqual(self.client.get('/shop/catalog').status_code, 401)
        with self.client.session_transaction() as session:
            session['user_id'] = str(self.user_id)

        catalog = self.client.get('/shop/catalog')
        response = self.client.post('/shop/purchase', json={
            'asset_type': 'sound',
            'asset_id': str(self.sound_id),
            'request_id': '40ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a',
            'expected_price': 100,
            'username': 'not-the-session-user',
            'user_id': str(ObjectId()),
        })

        self.assertEqual(catalog.status_code, 200)
        self.assertEqual(len(catalog.get_json()['sound']), 2)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.ownership.documents[0]['user_id'], self.user_id)
        self.assertEqual(self.users.find_one({'_id': self.user_id})['points'], 150)

    def test_soundboard_lists_favorites_oldest_first_then_other_sounds_alphabetically(self):
        alpha_id = ObjectId()
        zulu_id = ObjectId()
        self.sounds.documents.extend([
            {'_id': alpha_id, 'name': 'alpha', 'file': 'alpha.mp3'},
            {'_id': zulu_id, 'name': 'zulu', 'file': 'zulu.mp3'},
        ])
        for asset_id in (self.sound_id, self.other_sound_id, alpha_id, zulu_id):
            self.ownership.insert_one({
                'user_id': self.user_id,
                'asset_type': 'sound',
                'asset_id': asset_id,
            })
        added_at = datetime.now(timezone.utc)
        self.favorites.insert_one({
            'user_id': self.user_id,
            'asset_id': self.other_sound_id,
            'created_at': added_at,
        })
        self.favorites.insert_one({
            'user_id': self.user_id,
            'asset_id': self.sound_id,
            'created_at': added_at - timedelta(minutes=1),
        })
        self.favorites.insert_one({
            'user_id': ObjectId(),
            'asset_id': zulu_id,
            'created_at': added_at - timedelta(days=1),
        })
        with self.client.session_transaction() as session:
            session['user_id'] = str(self.user_id)

        response = self.client.get('/soundboardlist')

        self.assertEqual(response.status_code, 200)
        result = response.get_json()
        self.assertEqual(
            [asset['name'] for asset in result],
            ['sound', 'unavailable', 'alpha', 'zulu'],
        )
        self.assertEqual([asset['favorite'] for asset in result], [True, True, False, False])
        self.assertEqual([asset['play_cost'] for asset in result], [10, 10, 10, 10])

    def test_favorite_endpoint_requires_login_and_owned_sound_then_persists_toggle(self):
        self.assertEqual(
            self.client.post('/soundboard/favorites', json={
                'asset_id': str(self.sound_id),
                'favorite': True,
            }).status_code,
            401,
        )
        with self.client.session_transaction() as session:
            session['user_id'] = str(self.user_id)

        denied = self.client.post('/soundboard/favorites', json={
            'asset_id': str(self.sound_id),
            'favorite': True,
        })
        self.assertEqual(denied.status_code, 403)
        self.ownership.insert_one({
            'user_id': self.user_id,
            'asset_type': 'sound',
            'asset_id': self.sound_id,
        })

        added = self.client.post('/soundboard/favorites', json={
            'asset_id': str(self.sound_id),
            'favorite': True,
        })
        removed = self.client.post('/soundboard/favorites', json={
            'asset_id': str(self.sound_id),
            'favorite': False,
        })

        self.assertEqual(added.get_json()['favorite'], True)
        self.assertEqual(removed.get_json()['favorite'], False)
        self.assertEqual(self.favorites.documents, [])


if __name__ == '__main__':
    unittest.main()
