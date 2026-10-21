import copy
import sys
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from flask import Flask
from flask_socketio import SocketIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from bson import ObjectId
from pymongo.errors import DuplicateKeyError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import routes
from backend.tests.permission_fixtures import configure_role_permissions


class InMemoryUsers:
    def __init__(self, account):
        self.account = copy.deepcopy(account)
        self.lock = threading.Lock()

    def find_one(self, query):
        with self.lock:
            if query.get('_id') != self.account['_id']:
                return None
            return copy.deepcopy(self.account)

    def find_one_and_update(self, query, update, return_document=None):
        with self.lock:
            if query.get('_id') != self.account['_id']:
                return None
            if self.account.get('pending_point_operation'):
                return None
            cost = query['$expr']['$gte'][1]
            if self.account.get('points', 0) < cost:
                return None
            self.account['points'] = self.account.get('points', 0) + update['$inc']['points']
            self.account.update(update['$set'])
            return copy.deepcopy(self.account)

    def update_one(self, query, update):
        with self.lock:
            if query.get('_id') != self.account['_id']:
                return SimpleNamespace(matched_count=0, modified_count=0)
            if 'pending_point_operation' in query:
                if self.account.get('pending_point_operation') != query['pending_point_operation']:
                    return SimpleNamespace(matched_count=0, modified_count=0)
                self.account.pop('pending_point_operation', None)
                return SimpleNamespace(matched_count=1, modified_count=1)
            if isinstance(update, list):
                request_id = query['refunded_action_ids']['$ne']
                refunds = self.account.setdefault('refunded_action_ids', [])
                if request_id in refunds:
                    return SimpleNamespace(matched_count=0, modified_count=0)
                self.account['points'] += update[0]['$set']['points']['$add'][1]
                refunds.append(request_id)
                return SimpleNamespace(matched_count=1, modified_count=1)
            return SimpleNamespace(matched_count=0, modified_count=0)


class InMemoryActions:
    def __init__(self, fail_insert=False):
        self.documents = {}
        self.lock = threading.Lock()
        self.fail_insert = fail_insert

    @staticmethod
    def _key(query):
        return query['user_id'], query['request_id']

    def find_one(self, query):
        with self.lock:
            document = self.documents.get(self._key(query))
            return copy.deepcopy(document) if document else None

    def insert_one(self, document):
        if self.fail_insert:
            raise RuntimeError('simulated action queue failure')
        with self.lock:
            key = document['user_id'], document['request_id']
            if key in self.documents:
                raise DuplicateKeyError('duplicate request')
            self.documents[key] = copy.deepcopy(document)

    def update_one(self, query, update):
        with self.lock:
            key = self._key(query)
            document = self.documents.get(key)
            if not document:
                return SimpleNamespace(matched_count=0, modified_count=0)
            if query.get('state') and document.get('state') != query['state']:
                return SimpleNamespace(matched_count=0, modified_count=0)
            document.update(update['$set'])
            return SimpleNamespace(matched_count=1, modified_count=1)


class InMemoryTransactions:
    def __init__(self):
        self.documents = {}
        self.fail_update = False

    def find_one(self, query):
        return copy.deepcopy(self.documents.get((query['user_id'], query['request_id'])))

    def update_one(self, query, update, upsert=False):
        if self.fail_update:
            raise RuntimeError('simulated ledger write failure')
        key = query['user_id'], query['request_id']
        if key not in self.documents:
            self.documents[key] = copy.deepcopy(update['$setOnInsert'])
            return SimpleNamespace(matched_count=0, modified_count=1, upserted_id=key)
        return SimpleNamespace(matched_count=1, modified_count=0, upserted_id=None)


class EventSocketRecorder:
    def __init__(self):
        self.handlers = {}
        self.emit = Mock()

    def on(self, event_name):
        def register(handler):
            self.handlers[event_name] = handler
            return handler

        return register


class PaidActionAccountingTests(unittest.TestCase):
    def setUp(self):
        self.user_id = ObjectId()
        self.account = {
            '_id': self.user_id,
            'username': 'points-user',
            'rank': 'User',
            'points': 10,
        }
        self.users = InMemoryUsers(self.account)
        self.actions = InMemoryActions()
        self.transactions = InMemoryTransactions()
        self.ranks = Mock()
        self.permissions = Mock()
        self.pricing = Mock()
        self.pricing.find_one.return_value = None
        self.patch_users = patch.object(routes, 'colusers', self.users)
        self.patch_transactions = patch.object(routes, 'colpointtransactions', self.transactions)
        self.patch_ranks = patch.object(routes, 'colranks', self.ranks)
        self.patch_permissions = patch.object(routes, 'colpermissions', self.permissions)
        self.patch_pricing = patch.object(routes, 'colpricing', self.pricing)
        self.patch_users.start()
        self.patch_transactions.start()
        self.patch_ranks.start()
        self.patch_permissions.start()
        self.patch_pricing.start()
        configure_role_permissions(routes, self.ranks, self.permissions)
        self.addCleanup(self.patch_users.stop)
        self.addCleanup(self.patch_transactions.stop)
        self.addCleanup(self.patch_ranks.stop)
        self.addCleanup(self.patch_permissions.stop)
        self.addCleanup(self.patch_pricing.stop)

    @staticmethod
    def document(action_type='normalmeme'):
        return {
            'action_type': action_type,
            'user': 'server-verified-user',
            'done': True,
        }

    def accept(self, request_id, action_type='normalmeme', account=None):
        return routes.accept_paid_action(
            self.actions,
            account or self.account,
            request_id,
            self.document(action_type),
        )

    def test_duplicate_request_is_charged_once(self):
        request_id = '10ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a'

        first, first_status = self.accept(request_id)
        second, second_status = self.accept(request_id)

        self.assertEqual((first_status, second_status), (200, 200))
        self.assertEqual(self.users.account['points'], 5)
        self.assertTrue(second['duplicate'])
        self.assertEqual(len(self.actions.documents), 1)
        self.assertEqual(len(self.transactions.documents), 1)
        transaction = next(iter(self.transactions.documents.values()))
        self.assertEqual(transaction['user_id'], self.user_id)
        self.assertEqual(transaction['amount'], -5)

    def test_concurrent_requests_cannot_overdraw_the_balance(self):
        self.users.account['points'] = 5
        barrier = threading.Barrier(2)
        request_ids = (
            'a0ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a',
            'b0ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a',
        )

        def submit(request_id):
            barrier.wait()
            return self.accept(request_id)

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(submit, request_ids))

        self.assertEqual(sum(status == 200 for _, status in results), 1)
        self.assertIn(next(status for _, status in results if status != 200), (402, 409))
        self.assertEqual(self.users.account['points'], 0)
        self.assertGreaterEqual(self.users.account['points'], 0)

    def test_insufficient_balance_does_not_accept_or_charge_action(self):
        self.users.account['points'] = 4

        result, status = self.accept('20ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a')

        self.assertEqual(status, 402)
        self.assertIn('costs 5 points', result['message'])
        self.assertEqual(self.users.account['points'], 4)
        self.assertEqual(
            next(iter(self.actions.documents.values()))['state'],
            'rejected',
        )

    def test_queue_failure_happens_before_any_point_deduction(self):
        actions = InMemoryActions(fail_insert=True)

        with self.assertRaisesRegex(RuntimeError, 'simulated action queue failure'):
            routes.accept_paid_action(
                actions,
                self.account,
                '30ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a',
                self.document(),
            )

        self.assertEqual(self.users.account['points'], 10)
        self.assertNotIn('pending_point_operation', self.users.account)

    def test_admin_usage_is_free(self):
        admin = {**self.account, 'rank': 'Admin'}

        result, status = self.accept(
            '40ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a',
            action_type='tts',
            account=admin,
        )

        self.assertEqual(status, 200)
        self.assertFalse(result['charged'])
        self.assertEqual(self.users.account['points'], 10)
        self.assertEqual(
            next(iter(self.actions.documents.values()))['point_cost'],
            0,
        )

    def test_seeded_role_permissions_drive_panel_access_and_action_costs(self):
        admin = {**self.account, 'rank': 'Admin'}
        moderator = {**self.account, 'rank': 'Moderator'}
        vip = {**self.account, 'rank': 'VIP'}
        user = {**self.account, 'rank': 'User'}

        self.assertTrue(routes.has_permission(admin, 'panel_access'))
        self.assertTrue(routes.has_permission(admin, 'inspect_users'))
        self.assertTrue(routes.has_permission(moderator, 'panel_access'))
        self.assertTrue(routes.has_permission(moderator, 'inspect_users'))
        self.assertEqual(routes.public_usage_cost_fields(admin), {})
        self.assertEqual(routes.get_action_cost('normalmeme', admin), 0)
        self.assertEqual(routes.get_action_cost('normalmeme', vip), 3)
        self.assertEqual(routes.get_action_cost('normalmeme', user), 5)

    def test_vip_sound_action_uses_discounted_cost_once_across_retries(self):
        vip = {**self.account, 'rank': 'VIP'}
        request_id = 'c0ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a'

        first, first_status = self.accept(
            request_id,
            action_type='soundmeme',
            account=vip,
        )
        retry, retry_status = self.accept(
            request_id,
            action_type='soundmeme',
            account=vip,
        )

        self.assertEqual((first_status, retry_status), (200, 200))
        self.assertEqual(first['points'], 7)
        self.assertEqual(retry['points'], 7)
        self.assertTrue(retry['duplicate'])
        self.assertEqual(self.users.account['points'], 7)
        action = next(iter(self.actions.documents.values()))
        self.assertEqual(action['point_cost'], 3)
        self.assertTrue(action['charged'])
        self.assertEqual(
            [transaction['amount'] for transaction in self.transactions.documents.values()],
            [-3],
        )

    def test_failed_tts_refund_is_idempotent(self):
        request_id = '50ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a'
        action = {
            'user_id': self.user_id,
            'request_id': request_id,
            'point_cost': 5,
            'charged': True,
            'state': 'failed',
        }
        self.users.account['points'] = 5
        action_queue = InMemoryActions()
        action_queue.insert_one(action)
        self.transactions.fail_update = True
        with self.assertRaisesRegex(RuntimeError, 'simulated ledger write failure'):
            routes.refund_failed_action(action, action_queue)
        self.assertNotIn('refund_status', next(iter(action_queue.documents.values())))

        self.transactions.fail_update = False
        self.assertTrue(routes.refund_failed_action(action, action_queue))
        self.assertTrue(routes.refund_failed_action(action, action_queue))

        self.assertEqual(self.users.account['points'], 10)
        self.assertEqual(self.users.account['refunded_action_ids'], [request_id])
        self.assertEqual(
            next(iter(action_queue.documents.values()))['refund_status'],
            'refunded',
        )
        self.assertEqual(
            [transaction['amount'] for transaction in self.transactions.documents.values()],
            [5],
        )


class PaidActionRouteTests(unittest.TestCase):
    def setUp(self):
        self.user_id = ObjectId()
        self.account = {
            '_id': self.user_id,
            'username': 'verified-user',
            'rank': 'User',
            'points': 10,
        }
        self.users = InMemoryUsers(self.account)
        self.face_actions = InMemoryActions()
        self.normal_actions = InMemoryActions()
        self.tts_actions = InMemoryActions()
        self.sound_actions = InMemoryActions()
        self.transactions = InMemoryTransactions()
        self.pricing = Mock()
        self.pricing.find_one.return_value = None
        self.ranks = Mock()
        self.permissions = Mock()
        self.app = Flask(__name__)
        self.app.secret_key = 'test-only-secret'
        routes.registerroutes(self.app, None)
        self.client = self.app.test_client()
        self.patches = [
            patch.object(routes, 'colusers', self.users),
            patch.object(routes, 'colranks', self.ranks),
            patch.object(routes, 'colpermissions', self.permissions),
            patch.object(routes, 'colfacememe', self.face_actions),
            patch.object(routes, 'colnormalmeme', self.normal_actions),
            patch.object(routes, 'colttsmeme', self.tts_actions),
            patch.object(routes, 'colsoundactions', self.sound_actions),
            patch.object(routes, 'colpointtransactions', self.transactions),
            patch.object(routes, 'colpricing', self.pricing),
            patch.object(routes, 'colchat', SimpleNamespace(count_documents=lambda _query: 0)),
        ]
        for active_patch in self.patches:
            active_patch.start()
        configure_role_permissions(routes, self.ranks, self.permissions)
        self.addCleanup(self._stop_patches)
        with self.client.session_transaction() as session:
            session['user_id'] = str(self.user_id)

    def _stop_patches(self):
        for active_patch in reversed(self.patches):
            active_patch.stop()

    def test_form_uses_authenticated_username_not_submitted_username(self):
        response = self.client.post(
            '/handle_post',
            data={
                'request_id': '60ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a',
                'user': 'forged-user',
                'top_text_facememe': 'hello',
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['points'], 5)
        action = next(iter(self.face_actions.documents.values()))
        self.assertEqual(action['user'], 'verified-user')
        self.assertEqual(action['user_id'], self.user_id)

    def test_normalmeme_and_tts_retries_charge_five_points_once_each(self):
        normal_request = {
            'request_id': '90ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a',
            'image_normalmeme': 'https://example.test/meme.png',
        }
        first_normal = self.client.post('/handle_post', data=normal_request)
        duplicate_normal = self.client.post('/handle_post', data=normal_request)
        tts = self.client.post(
            '/handle_post',
            data={
                'request_id': 'a0ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a',
                'text_ttsmeme': 'hello',
                'language': 'en',
            },
        )

        self.assertEqual(first_normal.status_code, 200)
        self.assertEqual(first_normal.get_json()['points'], 5)
        self.assertTrue(duplicate_normal.get_json()['duplicate'])
        self.assertEqual(duplicate_normal.get_json()['points'], 5)
        self.assertEqual(tts.status_code, 200)
        self.assertEqual(tts.get_json()['points'], 0)
        self.assertEqual(self.users.account['points'], 0)
        self.assertEqual(len(self.normal_actions.documents), 1)
        self.assertEqual(len(self.tts_actions.documents), 1)
        self.assertEqual(
            [transaction['amount'] for transaction in self.transactions.documents.values()],
            [-5, -5],
        )

    def test_paid_form_requires_authenticated_session(self):
        with self.client.session_transaction() as session:
            session.clear()

        response = self.client.post(
            '/handle_post',
            data={
                'request_id': '70ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a',
                'top_text_facememe': 'hello',
            },
        )

        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.users.account['points'], 10)
        self.assertEqual(self.face_actions.documents, {})

    def test_sound_event_uses_authenticated_identity_and_charges_once(self):
        events = EventSocketRecorder()
        sound_actions = InMemoryActions()
        routes.registersocketiohandlers(events)
        with (
            patch.object(routes, 'colsoundactions', sound_actions),
            patch.object(routes, 'socket_users', {
                'socket-id': {'user_id': str(self.user_id), 'username': 'verified-user'},
            }),
            patch.object(routes, 'request', SimpleNamespace(sid='socket-id')),
            patch.object(routes.os.path, 'isfile', return_value=True),
        ):
            sound_request = {
                'file': 'sound-file',
                'request_id': '80ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a',
                'user': 'forged-user',
            }
            result = events.handlers['playsound'](sound_request)
            duplicate = events.handlers['playsound'](sound_request)

        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['points'], 5)
        self.assertTrue(duplicate['duplicate'])
        self.assertEqual(duplicate['points'], 5)
        self.assertEqual(self.users.account['points'], 5)
        self.assertEqual(
            [transaction['amount'] for transaction in routes.colpointtransactions.documents.values()],
            [-5],
        )
        action = next(iter(sound_actions.documents.values()))
        self.assertEqual(action['file'], 'sound-file.mp3')
        self.assertEqual(action['user_id'], self.user_id)
        events.emit.assert_any_call(
            'playsound',
            {'file': 'sound-file'},
            include_self=True,
        )
        self.assertEqual(
            sum(call.args[0] == 'playsound' for call in events.emit.call_args_list),
            1,
        )


class PaidSoundSocketTransportTests(unittest.TestCase):
    def test_authenticated_socket_acknowledges_charged_sound_once(self):
        user_id = ObjectId()
        users = InMemoryUsers({
            '_id': user_id,
            'username': 'verified-user',
            'rank': 'User',
            'points': 10,
        })
        actions = InMemoryActions()
        app = Flask(__name__)
        app.secret_key = 'test-only-secret'
        socketio = SocketIO(app, async_mode='threading')
        flask_client = app.test_client()
        with flask_client.session_transaction() as session:
            session['user_id'] = str(user_id)
        patches = [
            patch.object(routes, 'colusers', users),
            patch.object(routes, 'colsoundactions', actions),
            patch.object(routes, 'colpointtransactions', InMemoryTransactions()),
            patch.object(routes, 'colpricing', Mock(find_one=Mock(return_value=None))),
            patch.object(routes, 'colsettings', SimpleNamespace(find_one=lambda _query: None)),
            patch.object(routes, 'socket_users', {}),
            patch.object(routes, 'onlineusers', set()),
            patch.object(routes, 'get_online_user_ranks', return_value={}),
            patch.object(routes, 'add_current_ranks', return_value=[]),
            patch.object(routes.os.path, 'isfile', return_value=True),
        ]
        for active_patch in patches:
            active_patch.start()
        self.addCleanup(lambda: [active_patch.stop() for active_patch in reversed(patches)])
        routes.registersocketiohandlers(socketio)

        client = socketio.test_client(app, flask_test_client=flask_client)
        self.addCleanup(client.disconnect)
        request = {
            'file': 'sound-file',
            'request_id': 'b0ce68ad-d1f7-4d18-a9f4-7458a6d8ed4a',
        }
        first_ack = client.emit('playsound', request, callback=True)
        retry_ack = client.emit('playsound', request, callback=True)
        played_sounds = [
            event for event in client.get_received()
            if event['name'] == 'playsound'
        ]

        self.assertEqual(first_ack['status'], 'ok')
        self.assertEqual(first_ack['points'], 5)
        self.assertTrue(retry_ack['duplicate'])
        self.assertEqual(retry_ack['points'], 5)
        self.assertEqual(users.account['points'], 5)
        self.assertEqual(len(actions.documents), 1)
        self.assertEqual(len(played_sounds), 1)


if __name__ == '__main__':
    unittest.main()
