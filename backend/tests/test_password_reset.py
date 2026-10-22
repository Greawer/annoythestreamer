import copy
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from bson import ObjectId
from flask import Flask
from werkzeug.security import check_password_hash

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import routes
from backend.tests.permission_fixtures import configure_role_permissions


class PasswordResetTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.secret_key = "test-only-secret"
        routes.registerroutes(self.app, Mock())
        self.client = self.app.test_client()
        self.admin = {
            "_id": ObjectId(),
            "username": "reset-admin",
            "rank": "Admin",
            "points": 1000,
        }
        self.user = {
            "_id": ObjectId(),
            "username": "existing-user",
            "email": "existing@example.com",
            "rank": "User",
            "points": 375,
            "password_hash": "previous-password-hash",
            "registered_at": datetime.now(timezone.utc),
        }
        self.accounts = [self.admin, self.user]
        self.users = Mock()
        self.users.find_one.side_effect = self.find_user
        self.users.find.side_effect = self.find_users
        self.users.update_one.side_effect = self.update_user
        self.ranks = Mock()
        self.permissions = Mock()
        self.pricing = Mock()
        self.pricing.find_one.return_value = None
        self.chat = Mock()
        self.chat.count_documents.return_value = 0
        self.transactions = Mock()
        self.patches = [
            patch.object(routes, "colusers", self.users),
            patch.object(routes, "colranks", self.ranks),
            patch.object(routes, "colpermissions", self.permissions),
            patch.object(routes, "colpricing", self.pricing),
            patch.object(routes, "colchat", self.chat),
            patch.object(routes, "colpointtransactions", self.transactions),
        ]
        for active_patch in self.patches:
            active_patch.start()
        configure_role_permissions(routes, self.ranks, self.permissions)
        self.addCleanup(self.stop_patches)

    def stop_patches(self):
        for active_patch in reversed(self.patches):
            active_patch.stop()

    def find_user(self, query, *_args, **_kwargs):
        for account in self.accounts:
            if all(account.get(key) == value for key, value in query.items()):
                return copy.deepcopy(account)
        return None

    def find_users(self, query, *_args, **_kwargs):
        return [
            copy.deepcopy(account)
            for account in self.accounts
            if all(
                key in account if isinstance(value, dict) and value.get("$exists")
                else account.get(key) == value
                for key, value in query.items()
            )
        ]

    def update_user(self, query, update, **_kwargs):
        matches = [
            account for account in self.accounts
            if all(account.get(key) == value for key, value in query.items())
        ]
        if len(matches) != 1:
            return SimpleNamespace(matched_count=0, modified_count=0)
        account = matches[0]
        account.update(copy.deepcopy(update.get("$set", {})))
        for key in update.get("$unset", {}):
            account.pop(key, None)
        return SimpleNamespace(matched_count=1, modified_count=1)

    def login_as_admin(self):
        with self.client.session_transaction() as session:
            session["user_id"] = str(self.admin["_id"])
            session["admin_user_id"] = str(self.admin["_id"])

    def issue_reset_token(self):
        self.login_as_admin()
        with patch.object(routes.secrets, "token_urlsafe", return_value="admin-issued-one-time-code"):
            response = self.client.post(
                "/admin/users/existing-user/reset-password",
                json={},
            )
        self.assertEqual(response.status_code, 200)
        return response.get_json()["reset_token"]

    def test_admin_issues_one_time_token_for_existing_account(self):
        token = self.issue_reset_token()

        self.assertEqual(token, "admin-issued-one-time-code")
        self.assertIsNone(self.user["password_hash"])
        self.assertTrue(check_password_hash(self.user["password_reset_token_hash"], token))
        self.assertTrue(self.user["password_reset_token_lookup"])
        self.assertGreater(
            self.user["password_reset_token_expires_at"],
            datetime.now(timezone.utc),
        )
        self.users.insert_one.assert_not_called()

    def test_valid_token_updates_one_existing_account_without_registration_award(self):
        token = self.issue_reset_token()
        self.users.update_one.reset_mock(side_effect=False)
        self.users.update_one.side_effect = self.update_user
        with self.client.session_transaction() as session:
            session.clear()

        verification = self.client.post(
            "/auth/password-reset",
            json={
                "action": "verify",
                "reset_token": token,
            },
        )
        self.assertEqual(verification.status_code, 200)
        self.assertEqual(
            verification.get_json(),
            {
                "status": "verified",
                "username": "existing-user",
                "email": "existing@example.com",
            },
        )
        self.users.update_one.assert_not_called()

        response = self.client.post(
            "/auth/password-reset",
            json={
                "reset_token": token,
                "password": "replacement-password",
                "confirmation": "replacement-password",
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["username"], "existing-user")
        self.assertEqual(response.get_json()["points"], 375)
        self.assertTrue(check_password_hash(self.user["password_hash"], "replacement-password"))
        self.assertNotIn("password_reset_token_hash", self.user)
        self.assertNotIn("password_reset_token_lookup", self.user)
        self.assertNotIn("password_reset_token_expires_at", self.user)
        self.assertEqual(self.user["email"], "existing@example.com")
        self.assertEqual(self.user["points"], 375)
        self.assertEqual(
            [account["_id"] for account in self.accounts],
            [self.admin["_id"], self.user["_id"]],
        )
        self.users.insert_one.assert_not_called()
        self.transactions.update_one.assert_not_called()
        self.assertEqual(self.users.update_one.call_count, 1)
        reset_query = self.users.update_one.call_args.args[0]
        self.assertEqual(reset_query["_id"], self.user["_id"])
        self.assertIsNone(reset_query["password_hash"])
        retry = self.client.post(
            "/auth/password-reset",
            json={
                "reset_token": token,
                "password": "another-password",
                "confirmation": "another-password",
            },
        )
        self.assertEqual(retry.status_code, 401)
        self.assertEqual(self.users.update_one.call_count, 1)

    def test_token_alone_resets_legacy_token_without_username(self):
        token = self.issue_reset_token()
        self.user.pop("password_reset_token_lookup", None)
        self.users.update_one.reset_mock(side_effect=False)
        self.users.update_one.side_effect = self.update_user
        with self.client.session_transaction() as session:
            session.clear()

        response = self.client.post(
            "/auth/password-reset",
            json={
                "reset_token": token,
                "password": "replacement-password",
                "confirmation": "replacement-password",
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["username"], "existing-user")
        self.assertTrue(check_password_hash(self.user["password_hash"], "replacement-password"))
        self.assertNotIn("password_reset_token_hash", self.user)
        self.assertNotIn("password_reset_token_lookup", self.user)
        self.users.insert_one.assert_not_called()

    def test_missing_wrong_and_expired_tokens_cannot_reset_a_password(self):
        token = self.issue_reset_token()
        self.users.update_one.reset_mock(side_effect=False)
        self.users.update_one.side_effect = self.update_user
        with self.client.session_transaction() as session:
            session.clear()

        payload = {
            "username": "existing-user",
            "password": "replacement-password",
            "confirmation": "replacement-password",
        }
        responses = (
            self.client.post("/auth/password-reset", json=payload),
            self.client.post(
                "/auth/password-reset",
                json={**payload, "reset_token": "wrong-token"},
            ),
            self.client.post(
                "/auth/password-reset",
                json={
                    "action": "verify",
                    "reset_token": "wrong-token",
                },
            ),
        )
        self.assertEqual([response.status_code for response in responses], [401, 401, 401])
        self.assertEqual(self.users.update_one.call_count, 0)

        self.user["password_reset_token_expires_at"] = datetime.now(timezone.utc) - timedelta(minutes=1)
        expired = self.client.post(
            "/auth/password-reset",
            json={**payload, "reset_token": token},
        )

        self.assertEqual(expired.status_code, 401)
        self.assertEqual(self.users.update_one.call_count, 0)
        self.assertEqual(self.user["password_hash"], None)
        self.users.insert_one.assert_not_called()
        self.transactions.update_one.assert_not_called()

    def test_admin_reset_cannot_be_bypassed_through_registration(self):
        self.issue_reset_token()
        self.users.update_one.reset_mock(side_effect=False)
        self.users.update_one.side_effect = self.update_user
        with self.client.session_transaction() as session:
            session.clear()

        response = self.client.post(
            "/auth/login",
            json={
                "intent": "register",
                "username": "existing-user",
                "email": "attacker@example.com",
                "password": "replacement-password",
                "confirmation": "replacement-password",
            },
        )

        self.assertEqual(response.status_code, 401)
        self.assertIsNone(self.user["password_hash"])
        self.assertEqual(self.user["email"], "existing@example.com")
        self.assertEqual(self.users.update_one.call_count, 0)
        self.users.insert_one.assert_not_called()
        self.transactions.update_one.assert_not_called()


if __name__ == "__main__":
    unittest.main()
