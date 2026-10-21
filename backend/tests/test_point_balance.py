import sys
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch

from bson import ObjectId
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import routes
from backend.tests.permission_fixtures import configure_role_permissions


class AtomicStreamUser:
    def __init__(self, user_id):
        self.account = {
            "_id": user_id,
            "username": "online-user",
            "points": 0,
            "banned": False,
        }
        self.lock = threading.Lock()

    def find_one_and_update(self, _query, update, return_document=None):
        with self.lock:
            fields = update[0]["$set"]
            started_at = fields["last_stream_award_started_at"]
            interval = fields["last_stream_award_interval"]
            previous_started_at = self.account.get("last_stream_award_started_at")
            previous_interval = self.account.get("last_stream_award_interval", 0)
            if self.account["banned"]:
                return None
            if previous_started_at == started_at and previous_interval >= interval:
                return None
            if previous_started_at and previous_started_at > started_at:
                return None
            self.account["points"] += 100
            self.account["last_stream_award_started_at"] = started_at
            self.account["last_stream_award_interval"] = interval
            self.account["pending_point_transactions"] = [
                {
                    "request_id": f"stream:{started_at.isoformat()}:{interval}:online-user",
                    "action_type": "stream_award",
                    "amount": 100,
                    "balance_after": self.account["points"],
                }
            ]
            return dict(self.account)

    def update_one(self, query, update, **_kwargs):
        request_id = query["pending_point_transactions.request_id"]
        self.account["pending_point_transactions"] = [
            item
            for item in self.account["pending_point_transactions"]
            if item["request_id"] != request_id
        ]


class PointBalanceTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.secret_key = "test-only-secret"
        self.socketio = Mock()
        routes.registerroutes(self.app, self.socketio)
        self.client = self.app.test_client()
        self.users = Mock()
        self.ranks = Mock()
        self.permissions = Mock()
        self.pricing = Mock()
        self.pricing.find_one.return_value = None
        self.settings = Mock()
        self.chat = Mock()
        self.patches = [
            patch.object(routes, "colusers", self.users),
            patch.object(routes, "colranks", self.ranks),
            patch.object(routes, "colpermissions", self.permissions),
            patch.object(routes, "colpricing", self.pricing),
            patch.object(routes, "colsettings", self.settings),
            patch.object(routes, "colchat", self.chat),
            patch.object(routes, "colpointtransactions", Mock()),
        ]
        for active_patch in self.patches:
            active_patch.start()
        configure_role_permissions(routes, self.ranks, self.permissions)
        self.addCleanup(self._stop_patches)

    def _stop_patches(self):
        for active_patch in reversed(self.patches):
            active_patch.stop()

    def test_session_returns_current_server_balance(self):
        user_id = ObjectId()
        self.users.find_one.return_value = {
            "_id": user_id,
            "username": "balance-user",
            "rank": "User",
            "points": 1250,
            "email": "private@example.com",
        }
        with self.client.session_transaction() as session:
            session["user_id"] = str(user_id)

        response = self.client.get("/auth/session")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["authenticated"], True)
        self.assertEqual(response.get_json()["username"], "balance-user")
        self.assertEqual(response.get_json()["rank"], "User")
        self.assertEqual(response.get_json()["points"], 1250)
        self.assertEqual(response.get_json()["usage_costs"], routes.ACTION_COSTS)
        self.assertEqual(response.get_json()["permissions"]["staff"], False)
        self.assertNotIn("email", response.get_json())

    def test_admin_session_does_not_receive_usage_costs(self):
        user_id = ObjectId()
        self.users.find_one.return_value = {
            "_id": user_id,
            "username": "admin-user",
            "rank": "admin",
            "points": 1000,
        }
        with self.client.session_transaction() as session:
            session["user_id"] = str(user_id)

        response = self.client.get("/auth/session")

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("usage_costs", response.get_json())

    def test_stream_award_notifies_only_the_affected_user(self):
        user_id = ObjectId()
        account = {
            "_id": user_id,
            "username": "online-user",
            "points": 1100,
            "pending_point_transactions": [{
                "request_id": "stream:stream-started:1:online-user",
                "action_type": "stream_award",
                "amount": 100,
                "balance_after": 1100,
            }],
        }
        self.settings.find_one.return_value = {
            "_id": "stream_points",
            "streaming": True,
            "stream_started_at": datetime.now(timezone.utc) - timedelta(minutes=1),
        }
        self.users.find_one_and_update.return_value = account

        with (
            patch.object(routes, "onlineusers", {"online-user"}),
            patch.object(routes, "socket_users", {
                "own-socket": {"user_id": str(user_id), "username": "online-user"},
                "other-socket": {"user_id": str(ObjectId()), "username": "other-user"},
            }),
        ):
            awarded = routes.award_stream_points(self.socketio)

        self.assertEqual(awarded, 1)
        self.users.find_one_and_update.assert_called_once()
        transaction = routes.colpointtransactions.update_one.call_args
        self.assertEqual(transaction.args[0]["user_id"], user_id)
        self.assertEqual(transaction.args[1]["$setOnInsert"]["action_type"], "stream_award")
        self.assertEqual(transaction.args[1]["$setOnInsert"]["amount"], 100)
        self.assertEqual(transaction.args[1]["$setOnInsert"]["balance_after"], 1100)
        self.assertTrue(transaction.kwargs["upsert"])
        self.assertEqual(
            self.socketio.emit.call_args_list,
            [unittest.mock.call("points_changed", {"updated": True}, to="own-socket")],
        )

    def test_pending_point_transaction_remains_retryable_until_recorded(self):
        user_id = ObjectId()
        user = {
            "_id": user_id,
            "pending_point_transactions": [{
                "request_id": "admin-adjustment:retry",
                "action_type": "admin_adjustment",
                "amount": -25,
                "balance_after": 75,
            }],
        }
        routes.colpointtransactions.update_one.side_effect = [
            RuntimeError("temporary ledger failure"),
            Mock(),
        ]

        with self.assertRaisesRegex(RuntimeError, "temporary ledger failure"):
            routes.flush_pending_point_transactions(user)
        routes.colusers.update_one.assert_not_called()

        self.assertTrue(routes.flush_pending_point_transactions(user))
        transaction = routes.colpointtransactions.update_one.call_args
        self.assertEqual(transaction.args[1]["$setOnInsert"]["amount"], -25)
        self.assertEqual(transaction.args[1]["$setOnInsert"]["balance_after"], 75)
        routes.colusers.update_one.assert_called_once()

    def test_parallel_stream_awards_apply_one_interval_only_once(self):
        user_id = ObjectId()
        users = AtomicStreamUser(user_id)
        settings = Mock()
        settings.find_one.return_value = {
            "_id": "stream_points",
            "streaming": True,
            "stream_started_at": datetime.now(timezone.utc) - timedelta(minutes=2),
        }
        with (
            patch.object(routes, "colusers", users),
            patch.object(routes, "colsettings", settings),
            patch.object(routes, "onlineusers", {"online-user"}),
        ):
            with ThreadPoolExecutor(max_workers=2) as pool:
                awarded = list(pool.map(lambda _index: routes.award_stream_points(), range(2)))

        self.assertEqual(sum(awarded), 1)
        self.assertEqual(users.account["points"], 100)

    def test_admin_adjustment_notifies_the_target_account(self):
        user_id = ObjectId()
        target = {
            "_id": user_id,
            "username": "target-user",
            "rank": "User",
            "points": 0,
            "point_adjustment_ids": ["c2b0d440-bf4b-4fe5-a331-884ecfb448a6"],
            "point_adjustment_records": [{
                "request_id": "c2b0d440-bf4b-4fe5-a331-884ecfb448a6",
                "requested_amount": -500,
                "amount": -200,
                "balance_after": 0,
            }],
        }
        self.users.find_one.return_value = {"_id": user_id, "rank": "admin"}
        self.users.find_one_and_update.return_value = target
        self.chat.count_documents.return_value = 0
        with patch.object(routes, "socket_users", {
            "target-socket": {"user_id": str(user_id), "username": "target-user"},
            "unrelated-socket": {"user_id": str(ObjectId()), "username": "other-user"},
        }):
            with self.client.session_transaction() as session:
                session["user_id"] = str(user_id)
                session["admin_user_id"] = str(user_id)

            response = self.client.post(
                "/admin/users/target-user/points",
                json={"amount": -500, "request_id": "c2b0d440-bf4b-4fe5-a331-884ecfb448a6"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["user"]["points"], 0)
        transaction = routes.colpointtransactions.update_one.call_args
        self.assertEqual(transaction.args[1]["$setOnInsert"]["action_type"], "admin_adjustment")
        self.assertEqual(transaction.args[1]["$setOnInsert"]["amount"], -200)
        self.assertEqual(transaction.args[1]["$setOnInsert"]["requested_amount"], -500)
        self.assertEqual(transaction.args[1]["$setOnInsert"]["balance_after"], 0)
        adjustment_pipeline = self.users.find_one_and_update.call_args.args[1][0]["$set"]
        self.assertEqual(
            adjustment_pipeline["point_adjustment_records"]["$concatArrays"][1][0]["amount"],
            {
                "$let": {
                    "vars": {
                        "previous": {"$ifNull": ["$points", 0]},
                        "next": {"$max": [0, {"$add": [{"$ifNull": ["$points", 0]}, -500]}]},
                    },
                    "in": {"$subtract": ["$$next", "$$previous"]},
                },
            },
        )
        self.assertEqual(
            self.socketio.emit.call_args_list,
            [unittest.mock.call("points_changed", {"updated": True}, to="target-socket")],
        )

    def test_admin_adjustment_retry_does_not_notify_or_reapply(self):
        admin_id = ObjectId()
        target_id = ObjectId()
        request_id = "d2b0d440-bf4b-4fe5-a331-884ecfb448a6"
        admin = {"_id": admin_id, "username": "admin-user", "rank": "admin"}
        target = {
            "_id": target_id,
            "username": "target-user",
            "rank": "User",
            "points": 1500,
            "point_adjustment_ids": [request_id],
            "point_adjustment_records": [{
                "request_id": request_id,
                "requested_amount": 500,
                "amount": 500,
                "balance_after": 1500,
            }],
        }

        def find_user(query, *_args, **_kwargs):
            if query.get("username") == "target-user":
                return target
            if query.get("_id") == admin_id:
                return admin
            return None

        self.users.find_one.side_effect = find_user
        self.users.find_one_and_update.return_value = None
        self.chat.count_documents.return_value = 0
        with patch.object(routes, "socket_users", {}):
            with self.client.session_transaction() as session:
                session["user_id"] = str(admin_id)
                session["admin_user_id"] = str(admin_id)

            response = self.client.post(
                "/admin/users/target-user/points",
                json={"amount": 500, "request_id": request_id},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["user"]["points"], 1500)
        self.assertEqual(
            self.users.find_one_and_update.call_args.args[0]["point_adjustment_ids"],
            {"$ne": request_id},
        )
        self.socketio.emit.assert_not_called()

    def test_admin_point_credit_records_positive_actual_delta(self):
        admin_id = ObjectId()
        target_id = ObjectId()
        request_id = "e2b0d440-bf4b-4fe5-a331-884ecfb448a6"
        admin = {"_id": admin_id, "username": "admin-user", "rank": "admin"}
        target = {
            "_id": target_id,
            "username": "target-user",
            "rank": "User",
            "points": 1500,
            "point_adjustment_ids": [request_id],
            "point_adjustment_records": [{
                "request_id": request_id,
                "requested_amount": 500,
                "amount": 500,
                "balance_after": 1500,
            }],
        }
        self.users.find_one.side_effect = lambda query, *_args, **_kwargs: (
            admin if query.get("_id") == admin_id else target
        )
        self.users.find_one_and_update.return_value = target
        self.chat.count_documents.return_value = 0
        with self.client.session_transaction() as session:
            session["user_id"] = str(admin_id)
            session["admin_user_id"] = str(admin_id)

        response = self.client.post(
            "/admin/users/target-user/points",
            json={"amount": 500, "request_id": request_id},
        )

        self.assertEqual(response.status_code, 200)
        transaction = routes.colpointtransactions.update_one.call_args
        self.assertEqual(transaction.args[1]["$setOnInsert"]["amount"], 500)
        self.assertEqual(transaction.args[1]["$setOnInsert"]["balance_after"], 1500)


if __name__ == "__main__":
    unittest.main()
