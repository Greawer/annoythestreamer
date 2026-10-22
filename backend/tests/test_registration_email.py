import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from bson import ObjectId
from flask import Flask
from werkzeug.security import generate_password_hash

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import routes
from backend.tests.permission_fixtures import configure_role_permissions


class RegistrationEmailTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.secret_key = "test-only-secret"
        routes.registerroutes(self.app, None)
        self.client = self.app.test_client()
        self.users = Mock()
        self.ranks = Mock()
        self.permissions = Mock()
        self.pricing = Mock()
        self.pricing.find_one.return_value = None
        self.settings = Mock()
        self.settings.find_one.return_value = None
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
        self.roles, self.permissions_by_id = configure_role_permissions(
            routes,
            self.ranks,
            self.permissions,
        )
        self.addCleanup(self._stop_patches)

    def _stop_patches(self):
        for active_patch in reversed(self.patches):
            active_patch.stop()

    def _registration_payload(self, **overrides):
        payload = {
            "username": "new-user",
            "email": " Person+tag@Example.COM ",
            "password": "password123",
            "confirmation": "password123",
        }
        payload.update(overrides)
        return payload

    def test_registration_normalizes_and_stores_email(self):
        user_id = ObjectId()
        account = {"_id": user_id, "username": "new-user", "rank": "User", "points": 1000}
        self.users.find_one.side_effect = [None, account]
        self.users.insert_one.return_value = SimpleNamespace(inserted_id=user_id)
        self.ranks.find_one.return_value = {"rank": "User"}

        response = self.client.post("/auth/login", json=self._registration_payload())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.users.insert_one.call_args.args[0]["email"], "person+tag@example.com")
        self.assertEqual(
            response.get_json(),
            {
                "status": "ok",
                "username": "new-user",
                "rank": "User",
                "points": 1000,
                "permissions": routes.public_role_permissions({"rank": "User"}),
                "usage_costs": routes.ACTION_COSTS,
            },
        )
        transaction = routes.colpointtransactions.update_one.call_args
        self.assertEqual(transaction.args[0]["user_id"], user_id)
        self.assertEqual(transaction.args[1]["$setOnInsert"]["action_type"], "registration_award")
        self.assertEqual(transaction.args[1]["$setOnInsert"]["amount"], 1000)
        self.assertEqual(transaction.args[1]["$setOnInsert"]["balance_after"], 1000)
        self.assertTrue(transaction.kwargs["upsert"])

    def test_registration_rejects_invalid_email_without_writing(self):
        for email in ("", "not-an-email", "name@@example.com", ".name@example.com", "name@example..com"):
            with self.subTest(email=email):
                self.users.reset_mock()
                self.users.find_one.return_value = None
                response = self.client.post("/auth/login", json=self._registration_payload(email=email))
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.get_json()["message"], "Enter a valid email address")
                self.users.insert_one.assert_not_called()

    def test_registration_requires_email(self):
        self.users.find_one.return_value = None
        response = self.client.post("/auth/login", json=self._registration_payload(email=None))

        self.assertEqual(response.status_code, 400)
        self.users.insert_one.assert_not_called()

    def test_unknown_login_does_not_create_an_account(self):
        self.users.find_one.return_value = None

        response = self.client.post(
            "/auth/login",
            json={"username": "unknown-user", "password": "password123"},
        )

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.get_json()["message"], "Incorrect username or password")
        self.users.insert_one.assert_not_called()
        routes.colpointtransactions.update_one.assert_not_called()

    def test_empty_password_login_is_not_a_password_reset_or_registration(self):
        response = self.client.post(
            "/auth/login",
            json={"username": "existing-user", "password": ""},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["message"], "Enter a valid password")
        self.users.insert_one.assert_not_called()
        routes.colpointtransactions.update_one.assert_not_called()

    def test_registration_during_stream_waits_for_next_stream_interval(self):
        user_id = ObjectId()
        account = {"_id": user_id, "username": "new-user", "rank": "User", "points": 1000}
        started_at = datetime.now(timezone.utc) - timedelta(minutes=3)
        self.settings.find_one.return_value = {
            "_id": "stream_points",
            "streaming": True,
            "stream_started_at": started_at,
        }
        self.users.find_one.side_effect = [None, account]
        self.users.insert_one.return_value = SimpleNamespace(inserted_id=user_id)
        self.users.find_one_and_update.return_value = None
        self.ranks.find_one.return_value = {"rank": "User"}

        response = self.client.post("/auth/login", json=self._registration_payload())
        document = self.users.insert_one.call_args.args[0]

        self.assertEqual(response.status_code, 200)
        self.assertEqual(document["last_stream_award_started_at"], started_at)
        self.assertEqual(document["last_stream_award_interval"], 3)
        with patch.object(routes, "onlineusers", {"new-user"}):
            self.assertEqual(routes.award_stream_points(), 0)
        self.assertEqual(
            routes.colpointtransactions.update_one.call_args.args[1]["$setOnInsert"]["action_type"],
            "registration_award",
        )

    def test_existing_password_login_does_not_require_or_change_email(self):
        user_id = ObjectId()
        account = {
            "_id": user_id,
            "username": "existing-user",
            "password_hash": generate_password_hash("password123"),
            "rank": "User",
        }
        self.users.find_one.return_value = account

        response = self.client.post(
            "/auth/login",
            json={"username": "existing-user", "password": "password123"},
        )

        self.assertEqual(response.status_code, 200)
        self.users.insert_one.assert_not_called()
        self.users.update_one.assert_not_called()
        routes.colpointtransactions.update_one.assert_not_called()

    def test_passwordless_existing_account_receives_email_without_other_changes(self):
        user_id = ObjectId()
        account = {"_id": user_id, "username": "existing-user", "password_hash": None}
        self.users.find_one.return_value = account
        self.users.update_one.return_value.matched_count = 1
        self.ranks.find_one.return_value = {"rank": "User"}

        response = self.client.post(
            "/auth/login",
            json=self._registration_payload(username="existing-user"),
        )

        self.assertEqual(response.status_code, 200)
        update = self.users.update_one.call_args.args[1]["$set"]
        self.assertEqual(update["email"], "person+tag@example.com")
        self.assertIn("password_hash", update)
        self.assertEqual(set(update), {"email", "password_hash"})

    def test_user_api_responses_do_not_expose_email(self):
        user_id = ObjectId()
        account = {
            "_id": user_id,
            "username": "private-user",
            "email": "private@example.com",
            "rank": "User",
            "points": 1000,
            "banned": False,
        }
        admin_id = ObjectId()

        def find_user(query, *args, **kwargs):
            if query.get("rank") == "admin" or query.get("_id") == admin_id:
                return {"_id": admin_id, "username": "admin-user", "rank": "admin"}
            return account

        self.users.find_one.side_effect = find_user
        self.users.find.return_value = [account]
        user_role = next(role for role in self.roles if role["rank"] == "User")
        user_role["color"] = "#ffffff"
        self.chat.count_documents.return_value = 0
        with self.client.session_transaction() as session:
            session["user_id"] = str(admin_id)
            session["admin_user_id"] = str(admin_id)

        session_response = self.client.get("/auth/session")
        admin_user_response = self.client.get("/admin/users/private-user")
        with patch.object(routes, "onlineusers", {"private-user"}):
            online_user_response = routes.get_online_user_ranks()

        self.assertEqual(session_response.status_code, 200)
        self.assertNotIn("email", session_response.get_json())
        self.assertEqual(admin_user_response.status_code, 200)
        self.assertNotIn("email", admin_user_response.get_json()["user"])
        self.assertEqual(
            online_user_response["private-user"],
            {"rank": "User", "rank_color": "#ffffff"},
        )
        self.assertNotIn("email", online_user_response["private-user"])

    def test_user_inspection_requires_admin_session(self):
        user_id = ObjectId()
        self.users.find_one.return_value = {
            "_id": user_id,
            "username": "ordinary-user",
            "rank": "User",
        }
        with self.client.session_transaction() as session:
            session["user_id"] = str(user_id)

        response = self.client.get("/admin/users/private-user")

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json(), {"message": "Moderator or admin login required"})


if __name__ == "__main__":
    unittest.main()
