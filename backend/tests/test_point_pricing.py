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
                'sound': {'default': 100, 'categories': {}, 'items': {}},
            },
            'proposal_rewards': {
                'sound': {'default': 100000, 'items': {'test_sound': 25}},
                'emoji': {'default': 100000, 'items': {'test_emoji': 10}},
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
