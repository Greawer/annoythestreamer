import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from bson import ObjectId
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import routes
from backend.tests.permission_fixtures import configure_role_permissions


class InMemoryPricing:
    def __init__(self):
        self.document = None

    def find_one(self, query):
        if self.document and self.document.get('_id') == query.get('_id'):
            return copy.deepcopy(self.document)
        return None

    def update_one(self, query, update, upsert=False):
        self.document = {
            '_id': query['_id'],
            **copy.deepcopy(update['$set']),
        }
        return Mock(matched_count=1, modified_count=1)


class PointPricingTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.secret_key = 'test-only-secret'
        self.socketio = Mock()
        routes.registerroutes(self.app, self.socketio)
        self.client = self.app.test_client()
        self.admin = {
            '_id': ObjectId(),
            'username': 'price-admin',
            'rank': 'Admin',
            'points': 1000,
        }
        self.user = {
            '_id': ObjectId(),
            'username': 'price-user',
            'rank': 'User',
            'points': 1000,
        }
        self.users = Mock()
        self.users.find_one.side_effect = self.find_user
        self.ranks = Mock()
        self.permissions = Mock()
        self.pricing = InMemoryPricing()
        self.patches = [
            patch.object(routes, 'colusers', self.users),
            patch.object(routes, 'colranks', self.ranks),
            patch.object(routes, 'colpermissions', self.permissions),
            patch.object(routes, 'colpricing', self.pricing),
        ]
        for active_patch in self.patches:
            active_patch.start()
        configure_role_permissions(routes, self.ranks, self.permissions)
        self.addCleanup(self.stop_patches)

    def stop_patches(self):
        for active_patch in reversed(self.patches):
            active_patch.stop()

    def find_user(self, query, *_args, **_kwargs):
        for account in (self.admin, self.user):
            if query.get('_id') == account['_id'] or query.get('username') == account['username']:
                return account
        return None

    @staticmethod
    def admin_payload():
        return {
            'send_your_chaos': {
                'normalmeme': 9,
                'facemememe': 8,
                'soundmeme': 7,
                'tts': 6,
            },
            'catalog': {
                'emoji': {
                    'default': 100,
                    'categories': {'rare': 250},
                    'items': {
                        'super_rare_golden_emoji': 10000,
                        'unavailable_emoji': -1,
                    },
                },
                'sound': {
                    'default': 100,
                    'categories': {},
                    'items': {},
                    'play_default': 10,
                    'play_items': {},
                },
            },
            'proposal_rewards': {
                'sound': {'default': 100000, 'exclusive': 100000, 'items': {'test_sound': 25}},
                'emoji': {'default': 100000, 'exclusive': 100000, 'items': {'test_emoji': 10}},
            },
            'asset_limits': {
                'emoji': {'max_px': 1024, 'max_px_admin': 2048},
                'sound': {'max_length': 3, 'max_length_admin': 10},
            },
        }

    def login_as(self, account):
        with self.client.session_transaction() as session:
            session['user_id'] = str(account['_id'])
            session['admin_user_id'] = str(account['_id'])

    def test_admin_can_save_prices_and_retrieve_them_from_database(self):
        self.login_as(self.admin)

        response = self.client.put(
            '/admin/pricing',
            json={'pricing': self.admin_payload()},
        )
        retrieved = self.client.get('/admin/pricing')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(retrieved.status_code, 200)
        self.assertEqual(retrieved.get_json()['pricing'], self.admin_payload())
        self.assertEqual(self.pricing.document['_id'], routes.POINT_PRICING_ID)
        self.assertEqual(self.pricing.document['pricing'], self.admin_payload())
        self.socketio.emit.assert_called_once_with('usage_costs_changed')

    def test_admin_play_prices_persist_separately_from_sound_purchase_prices(self):
        self.login_as(self.admin)
        payload = self.admin_payload()
        payload['catalog']['sound']['default'] = 125
        payload['catalog']['sound']['items']['sample_sound'] = 75
        payload['catalog']['sound']['play_default'] = 12
        payload['catalog']['sound']['play_items']['sample_sound'] = 4

        saved = self.client.put('/admin/pricing', json={'pricing': payload})
        retrieved = self.client.get('/admin/pricing')
        sound_pricing = retrieved.get_json()['pricing']['catalog']['sound']

        self.assertEqual(saved.status_code, 200)
        self.assertEqual(retrieved.status_code, 200)
        self.assertEqual(sound_pricing['default'], 125)
        self.assertEqual(sound_pricing['items']['sample_sound'], 75)
        self.assertEqual(sound_pricing['play_default'], 12)
        self.assertEqual(sound_pricing['play_items']['sample_sound'], 4)

    def test_legacy_pricing_receives_database_compatible_proposal_and_limit_defaults(self):
        legacy = self.admin_payload()
        del legacy['catalog']['sound']['play_default']
        del legacy['catalog']['sound']['play_items']
        for proposal_type in ('emoji', 'sound'):
            del legacy['proposal_rewards'][proposal_type]['exclusive']
        del legacy['asset_limits']

        normalized = routes.validate_point_pricing(legacy)

        self.assertEqual(normalized['proposal_rewards']['emoji']['exclusive'], 100000)
        self.assertEqual(normalized['proposal_rewards']['sound']['exclusive'], 100000)
        self.assertEqual(normalized['asset_limits']['emoji'], {'max_px': 1024, 'max_px_admin': 2048})
        self.assertEqual(normalized['asset_limits']['sound'], {'max_length': 3, 'max_length_admin': 10})
        self.assertEqual(normalized['catalog']['sound']['play_default'], 10)
        self.assertEqual(normalized['catalog']['sound']['play_items'], {})

    def test_sound_play_prices_fall_back_dynamically_and_do_not_change_purchase_price(self):
        pricing = routes.validate_point_pricing(self.admin_payload())
        sound = {'name': 'sample_sound', 'pricing_name': 'sample_sound'}

        self.assertEqual(routes.resolve_sound_play_price(sound, pricing), 10)
        pricing['catalog']['sound']['play_default'] = 12
        self.assertEqual(routes.resolve_sound_play_price(sound, pricing), 12)
        pricing['catalog']['sound']['play_items']['sample_sound'] = 7
        self.assertEqual(routes.resolve_sound_play_price(sound, pricing), 7)
        self.assertEqual(routes.resolve_catalog_asset_price('sound', sound, pricing), 100)

    def test_vip_discount_applies_to_default_and_exception_play_prices(self):
        pricing = routes.validate_point_pricing(self.admin_payload())
        pricing['catalog']['sound']['play_default'] = 11
        pricing['catalog']['sound']['play_items']['sample_sound'] = 7
        vip = {**self.user, 'rank': 'VIP'}
        sound = {'name': 'sample_sound', 'pricing_name': 'sample_sound'}

        self.assertEqual(routes.get_action_cost('soundmeme', vip, sound, pricing), 4)
        del pricing['catalog']['sound']['play_items']['sample_sound']
        self.assertEqual(routes.get_action_cost('soundmeme', vip, sound, pricing), 6)

    def test_invalid_sound_play_prices_are_rejected(self):
        for invalid in (-1, -2, 1.5, True, '5'):
            with self.subTest(default=invalid):
                payload = self.admin_payload()
                payload['catalog']['sound']['play_default'] = invalid
                with self.assertRaises(ValueError):
                    routes.validate_point_pricing(payload)
            with self.subTest(exception=invalid):
                payload = self.admin_payload()
                payload['catalog']['sound']['play_items']['invalid_sound'] = invalid
                with self.assertRaises(ValueError):
                    routes.validate_point_pricing(payload)

    def test_sound_price_exception_maps_save_and_rename_independently(self):
        pricing = self.admin_payload()
        pricing['catalog']['sound']['items']['sample_sound'] = 80
        pricing['catalog']['sound']['play_items']['sample_sound'] = 6
        self.pricing.document = {
            '_id': routes.POINT_PRICING_ID,
            'pricing': routes.validate_point_pricing(pricing),
        }

        routes.save_catalog_price_exception('sound', 'sample_sound', 'sample_sound', 90)
        saved = self.pricing.document['pricing']['catalog']['sound']
        self.assertEqual(saved['items']['sample_sound'], 90)
        self.assertEqual(saved['play_items']['sample_sound'], 6)

        routes.save_catalog_price_exception(
            'sound',
            'sample_sound',
            'renamed_sound',
            routes.ASSET_PRICE_UNCHANGED,
            routes.ASSET_PRICE_UNCHANGED,
        )
        saved = self.pricing.document['pricing']['catalog']['sound']
        self.assertNotIn('sample_sound', saved['items'])
        self.assertEqual(saved['items']['renamed_sound'], 90)
        self.assertNotIn('sample_sound', saved['play_items'])
        self.assertEqual(saved['play_items']['renamed_sound'], 6)

    def test_sound_filename_exceptions_resolve_for_shop_and_soundboard(self):
        payload = self.admin_payload()
        payload['catalog']['sound']['items']['21.mp3'] = 80
        payload['catalog']['sound']['play_items']['21.mp3'] = 6
        pricing = routes.validate_point_pricing(payload)
        sound = {
            '_id': ObjectId(),
            'name': 'internalname',
            'pricing_name': 'internalname',
            'display_name': 'Readable title',
            'file': '21.mp3',
        }

        self.assertEqual(routes.resolve_catalog_asset_price('sound', sound, pricing), 80)
        self.assertEqual(routes.serialize_asset(sound, 'sound', pricing)['price'], 80)
        self.assertEqual(routes.resolve_sound_play_price(sound, pricing), 6)
        self.assertEqual(routes.get_action_cost('soundmeme', self.user, sound, pricing), 6)

    def test_sound_filename_purchase_and_play_exceptions_rename_independently(self):
        payload = self.admin_payload()
        payload['catalog']['sound']['items']['21.mp3'] = 80
        payload['catalog']['sound']['play_items']['internalname'] = 6
        self.pricing.document = {
            '_id': routes.POINT_PRICING_ID,
            'pricing': routes.validate_point_pricing(payload),
        }

        routes.save_catalog_price_exception(
            'sound',
            '21.mp3',
            '22.mp3',
            routes.ASSET_PRICE_UNCHANGED,
            routes.ASSET_PRICE_UNCHANGED,
            'internalname',
            '22.mp3',
        )

        saved = self.pricing.document['pricing']['catalog']['sound']
        self.assertEqual(saved['items'], {'22.mp3': 80})
        self.assertEqual(saved['play_items'], {'22.mp3': 6})

    def test_invalid_asset_limits_are_rejected(self):
        for asset_type, field in (
            ('emoji', 'max_px'),
            ('emoji', 'max_px_admin'),
            ('sound', 'max_length'),
            ('sound', 'max_length_admin'),
        ):
            payload = self.admin_payload()
            payload['asset_limits'][asset_type][field] = 0
            with self.subTest(asset_type=asset_type, field=field):
                with self.assertRaises(ValueError):
                    routes.validate_point_pricing(payload)

    def test_minus_one_item_exception_persists_and_removal_restores_default(self):
        self.login_as(self.admin)
        payload = self.admin_payload()
        payload['catalog']['emoji']['items']['blocked_emoji'] = -1

        saved = self.client.put('/admin/pricing', json={'pricing': payload})

        self.assertEqual(saved.status_code, 200)
        self.assertEqual(
            routes.resolve_catalog_price('emoji', 'blocked_emoji', pricing=saved.get_json()['pricing']),
            -1,
        )

        del payload['catalog']['emoji']['items']['blocked_emoji']
        restored = self.client.put('/admin/pricing', json={'pricing': payload})

        self.assertEqual(restored.status_code, 200)
        self.assertEqual(
            routes.resolve_catalog_price('emoji', 'blocked_emoji', pricing=restored.get_json()['pricing']),
            payload['catalog']['emoji']['default'],
        )

    def test_existing_item_exception_can_be_edited_to_minus_one(self):
        self.login_as(self.admin)
        payload = self.admin_payload()
        payload['catalog']['emoji']['items']['editable_emoji'] = 25
        created = self.client.put('/admin/pricing', json={'pricing': payload})
        self.assertEqual(created.status_code, 200)

        payload['catalog']['emoji']['items']['editable_emoji'] = -1
        edited = self.client.put('/admin/pricing', json={'pricing': payload})

        self.assertEqual(edited.status_code, 200)
        self.assertEqual(
            edited.get_json()['pricing']['catalog']['emoji']['items']['editable_emoji'],
            -1,
        )
        self.assertEqual(
            routes.resolve_catalog_price('emoji', 'editable_emoji', pricing=edited.get_json()['pricing']),
            -1,
        )

    def test_only_c4_admin_console_permission_can_read_or_save_prices(self):
        self.login_as(self.user)

        read_response = self.client.get('/admin/pricing')
        save_response = self.client.put(
            '/admin/pricing',
            json={'pricing': self.admin_payload()},
        )

        self.assertEqual(read_response.status_code, 403)
        self.assertEqual(save_response.status_code, 403)
        self.assertIsNone(self.pricing.document)

        with self.client.session_transaction() as session:
            session.clear()
        self.assertEqual(self.client.get('/admin/pricing').status_code, 401)

    def test_invalid_prices_are_rejected_without_persisting(self):
        self.login_as(self.admin)
        invalid_values = (-2, 1.5, True, '5')
        for invalid_price in invalid_values:
            with self.subTest(price=invalid_price):
                payload = self.admin_payload()
                payload['send_your_chaos']['normalmeme'] = invalid_price
                response = self.client.put('/admin/pricing', json={'pricing': payload})
                self.assertEqual(response.status_code, 400)
                self.assertIsNone(self.pricing.document)

        for invalid_exception in (-2, 1.5, True, '5'):
            with self.subTest(exception_price=invalid_exception):
                payload = self.admin_payload()
                payload['catalog']['emoji']['items']['editable_emoji'] = invalid_exception
                response = self.client.put('/admin/pricing', json={'pricing': payload})
                self.assertEqual(response.status_code, 400)
                self.assertIsNone(self.pricing.document)

    def test_invalid_named_price_entries_are_rejected_without_persisting(self):
        self.login_as(self.admin)
        invalid_payloads = []
        dotted_category = self.admin_payload()
        dotted_category['catalog']['emoji']['categories'] = {'rare.item': 5}
        invalid_payloads.append(dotted_category)
        invalid_reward = self.admin_payload()
        invalid_reward['proposal_rewards']['sound']['items'] = {'sample': -2}
        invalid_payloads.append(invalid_reward)
        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                response = self.client.put('/admin/pricing', json={'pricing': payload})
                self.assertEqual(response.status_code, 400)
                self.assertIsNone(self.pricing.document)

    def test_named_prices_and_lower_test_rewards_resolve_from_saved_config(self):
        self.pricing.update_one(
            {'_id': routes.POINT_PRICING_ID},
            {'$set': {'pricing': routes.validate_point_pricing(self.admin_payload())}},
            upsert=True,
        )
        saved = routes.load_point_pricing()

        self.assertEqual(routes.get_action_cost('normalmeme', self.user), 9)
        self.assertEqual(
            routes.public_usage_cost_fields(self.user)['usage_costs']['normalmeme'],
            9,
        )
        self.assertEqual(routes.get_action_cost('normalmeme', {**self.user, 'rank': 'VIP'}), 5)
        self.assertEqual(routes.resolve_catalog_price('emoji', 'super_rare_golden_emoji', 'rare', saved), 10000)
        self.assertEqual(routes.resolve_catalog_price('emoji', 'ordinary_emoji', 'rare', saved), 250)
        self.assertEqual(routes.resolve_catalog_price('emoji', 'ordinary_emoji', 'common', saved), 100)
        unavailable = routes.resolve_catalog_price('emoji', 'unavailable_emoji', 'rare', saved)
        self.assertEqual(unavailable, -1)
        self.assertFalse(routes.is_price_available(unavailable))
        self.assertTrue(routes.is_price_available(0))
        self.assertEqual(routes.resolve_proposal_reward('sound', 'test_sound', saved), 25)
        self.assertEqual(routes.resolve_proposal_reward('emoji', 'test_emoji', saved), 10)
        self.assertEqual(routes.resolve_proposal_reward('emoji', 'new_emoji', saved), 100000)

    def test_unavailable_action_price_is_never_treated_as_free(self):
        self.pricing.document = {
            '_id': routes.POINT_PRICING_ID,
            'pricing': routes.validate_point_pricing({
                **self.admin_payload(),
                'send_your_chaos': {
                    **self.admin_payload()['send_your_chaos'],
                    'normalmeme': -1,
                },
            }),
        }
        queue = Mock()
        queue.find_one.return_value = None

        result, status = routes.accept_paid_action(
            queue,
            self.user,
            '10ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a',
            {'action_type': 'normalmeme', 'user': self.user['username']},
        )

        self.assertEqual(status, 403)
        self.assertEqual(result['code'], 'action_unavailable')
        self.assertEqual(routes.get_action_cost('normalmeme', self.user), -1)
        queue.insert_one.assert_not_called()
        self.users.find_one_and_update.assert_not_called()

    def test_c2_defaults_and_permission_based_free_discount_remain_unchanged(self):
        vip = {**self.user, 'rank': 'VIP'}

        self.assertEqual(routes.get_action_cost('normalmeme', self.user), 5)
        self.assertEqual(routes.get_action_cost('normalmeme', vip), 3)
        self.assertEqual(routes.get_action_cost('normalmeme', self.admin), 0)
        self.assertEqual(routes.public_usage_cost_fields(self.admin), {})

    def test_admin_free_action_stays_free_when_saved_price_is_unavailable(self):
        config = routes.validate_point_pricing({
            **self.admin_payload(),
            'send_your_chaos': {
                **self.admin_payload()['send_your_chaos'],
                'normalmeme': -1,
            },
        })
        self.pricing.document = {
            '_id': routes.POINT_PRICING_ID,
            'pricing': config,
        }

        self.assertEqual(routes.get_action_cost('normalmeme', self.admin), 0)


if __name__ == '__main__':
    unittest.main()
