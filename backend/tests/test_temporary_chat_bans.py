import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from bson import ObjectId
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import routes
from backend.tests.permission_fixtures import configure_role_permissions


class SocketEventRegistry:
    def __init__(self):
        self.handlers = {}
        self.emit = Mock()

    def on(self, event):
        def register(handler):
            self.handlers[event] = handler
            return handler

        return register


class TemporaryChatBanTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.secret_key = "test-only-secret"
        self.socketio = Mock()
        routes.registerroutes(self.app, self.socketio)
        self.client = self.app.test_client()
        self.users = Mock()
        self.ranks = Mock()
        self.permissions = Mock()
        self.chat = Mock()
        self.chat.count_documents.return_value = 0
        self.patches = [
            patch.object(routes, "colusers", self.users),
            patch.object(routes, "colranks", self.ranks),
            patch.object(routes, "colpermissions", self.permissions),
            patch.object(routes, "colchat", self.chat),
        ]
        for active_patch in self.patches:
            active_patch.start()
        configure_role_permissions(routes, self.ranks, self.permissions)
        self.addCleanup(self._stop_patches)

    def _stop_patches(self):
        for active_patch in reversed(self.patches):
            active_patch.stop()

    def _login(self, rank):
        user_id = ObjectId()
        account = {
            "_id": user_id,
            "username": "staff-user",
            "rank": rank,
            "points": 1000,
            "banned": False,
        }
        self.users.find_one.return_value = account
        with self.client.session_transaction() as session:
            session["user_id"] = str(user_id)
        return account

    def test_staff_can_set_timeout_in_seconds(self):
        actor = self._login("MOD")
        started_at = datetime.now(timezone.utc)
        updated_user = {
            "_id": ObjectId(),
            "username": "target-user",
            "rank": "User",
            "points": 1000,
            "banned": False,
        }
        self.users.find_one.side_effect = lambda query, *_args, **_kwargs: (
            actor if query.get("_id") == actor["_id"] else
            updated_user if query.get("username") == "target-user" else None
        )

        def update_user(_query, update, return_document):
            updated_user["chat_timeout_until"] = update["$set"]["chat_timeout_until"]
            return updated_user

        self.users.find_one_and_update.side_effect = update_user

        response = self.client.post(
            "/admin/users/target-user/timeout",
            json={"duration_seconds": 30},
        )

        self.assertEqual(response.status_code, 200)
        update = self.users.find_one_and_update.call_args.args[1]
        self.assertEqual(set(update), {"$set"})
        timeout_until = update["$set"]["chat_timeout_until"]
        self.assertGreaterEqual(timeout_until, started_at + timedelta(seconds=30))
        activity = self.chat.insert_one.call_args.args[0]
        self.assertTrue(activity['system'])
        self.assertNotIn('user', activity)
        self.assertEqual(activity['message'], 'staff-user banned target-user for 30s.')
        self.socketio.emit.assert_any_call(
            'chat_message',
            {'system': True, 'message': 'staff-user banned target-user for 30s.'},
        )
        self.assertLess(timeout_until, started_at + timedelta(seconds=31))
        self.assertEqual(
            response.get_json()["user"]["chat_timeout_until"],
            timeout_until.isoformat(),
        )

    def test_staff_can_remove_timeout_early(self):
        actor = self._login("admin")
        target = {
            "_id": ObjectId(),
            "username": "target-user",
            "rank": "User",
            "points": 1000,
            "banned": False,
        }
        self.users.find_one.side_effect = lambda query, *_args, **_kwargs: (
            actor if query.get("_id") == actor["_id"] else
            target if query.get("username") == "target-user" else None
        )
        self.users.find_one_and_update.return_value = target

        response = self.client.post(
            "/admin/users/target-user/timeout",
            json={"clear": True},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            self.users.find_one_and_update.call_args.args[1],
            {"$unset": {"chat_timeout_until": ""}},
        )
        self.assertIsNone(response.get_json()["user"]["chat_timeout_until"])
        activity = self.chat.insert_one.call_args.args[0]
        self.assertEqual(activity['message'], 'unbanned target-user.')
        self.socketio.emit.assert_any_call(
            'chat_message',
            {'system': True, 'message': 'unbanned target-user.'},
        )

    def test_legacy_permanent_ban_route_is_retired(self):
        self._login("admin")

        response = self.client.post(
            "/admin/users/target-user/ban",
            json={"banned": True},
        )

        self.assertEqual(response.status_code, 404)
        self.users.find_one_and_update.assert_not_called()

    def test_non_staff_cannot_set_timeout(self):
        self._login("User")

        timeout_response = self.client.post(
            "/admin/users/target-user/timeout",
            json={"duration_seconds": 30},
        )

        self.assertEqual(timeout_response.status_code, 403)
        self.users.find_one_and_update.assert_not_called()

    def test_non_admin_cannot_grant_themselves_moderator_rank(self):
        self._login("User")

        response = self.client.post(
            "/admin/users/staff-user/rank",
            json={"rank": "Mod"},
        )

        self.assertEqual(response.status_code, 403)
        self.users.find_one_and_update.assert_not_called()

    def test_timeout_requires_positive_integer_seconds(self):
        self._login("Mod")

        for duration in (True, 0, -1, 1.5, "30"):
            with self.subTest(duration=duration):
                response = self.client.post(
                    "/admin/users/target-user/timeout",
                    json={"duration_seconds": duration},
                )
                self.assertEqual(response.status_code, 400)

        self.assertEqual(
            self.client.post(
                "/admin/users/target-user/timeout",
                json=[30],
            ).status_code,
            400,
        )
        self.assertEqual(
            self.client.post(
                "/admin/users/target-user/timeout",
                json={"clear": False},
            ).status_code,
            400,
        )
        self.users.find_one_and_update.assert_not_called()

    def test_timeout_blocks_chat_but_expired_timeout_does_not(self):
        events = SocketEventRegistry()
        routes.registersocketiohandlers(events)
        now = datetime.now(timezone.utc)

        for timeout_until, legacy_banned, should_send in (
            (now + timedelta(seconds=30), False, False),
            (now - timedelta(seconds=1), False, True),
            (None, True, True),
        ):
            with self.subTest(timeout_until=timeout_until, legacy_banned=legacy_banned):
                self.chat.reset_mock()
                self.chat.count_documents.return_value = 0
                account = {
                    "_id": ObjectId(),
                    "username": "chat-user",
                    "rank": "User",
                    "banned": legacy_banned,
                }
                if timeout_until:
                    account["chat_timeout_until"] = timeout_until
                self.users.find_one.return_value = account
                with (
                    patch.object(routes, "socket_users", {
                        "socket-id": {
                            "user_id": str(account["_id"]),
                            "username": account["username"],
                        },
                    }),
                    patch.object(routes, "request", SimpleNamespace(sid="socket-id")),
                    patch.object(routes, "colranks") as ranks,
                ):
                    ranks.find.return_value = []
                    events.handlers["chat_message"]({"message": "hello"})

                self.assertEqual(self.chat.insert_one.called, should_send)

    def test_stream_points_query_excludes_timed_out_users_only(self):
        settings = Mock()
        settings.find_one.return_value = {
            "_id": "stream_points",
            "streaming": True,
            "stream_started_at": datetime.now(timezone.utc) - timedelta(minutes=1),
        }
        self.users.find_one_and_update.return_value = None
        with (
            patch.object(routes, "colsettings", settings),
            patch.object(routes, "onlineusers", {"online-user"}),
        ):
            self.assertEqual(routes.award_stream_points(), 0)

        query = self.users.find_one_and_update.call_args.args[0]
        self.assertEqual(query["banned"], {"$ne": True})
        self.assertEqual(query["$or"][0], {"chat_timeout_until": {"$exists": False}})
        self.assertIn("$lte", query["$or"][1]["chat_timeout_until"])


if __name__ == "__main__":
    unittest.main()
