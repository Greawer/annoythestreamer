import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch

from bson import ObjectId
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import routes
from backend.tests.permission_fixtures import configure_role_permissions


class ModeratorPermissionTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.secret_key = "test-only-secret"
        routes.registerroutes(self.app, Mock())
        self.client = self.app.test_client()
        self.actor = {
            "_id": ObjectId(),
            "username": "staff-user",
            "rank": "Moderator",
            "points": 1000,
            "banned": False,
        }
        self.target = {
            "_id": ObjectId(),
            "username": "target-user",
            "rank": "User",
            "points": 1000,
            "banned": False,
        }
        self.users = Mock()
        self.ranks = Mock()
        self.permissions = Mock()
        self.settings = Mock()
        self.chat = Mock()
        self.chat.count_documents.return_value = 0
        self.users.find_one.side_effect = self._find_user
        self.users.find_one_and_update.side_effect = self._update_user
        self.patches = [
            patch.object(routes, "colusers", self.users),
            patch.object(routes, "colranks", self.ranks),
            patch.object(routes, "colpermissions", self.permissions),
            patch.object(routes, "colsettings", self.settings),
            patch.object(routes, "colchat", self.chat),
        ]
        for active_patch in self.patches:
            active_patch.start()
        self.roles, self.permissions_by_id = configure_role_permissions(
            routes,
            self.ranks,
            self.permissions,
        )
        self.addCleanup(self._stop_patches)
        with self.client.session_transaction() as session:
            session["user_id"] = str(self.actor["_id"])

    def _stop_patches(self):
        for active_patch in reversed(self.patches):
            active_patch.stop()

    def _find_user(self, query, *_args, **_kwargs):
        if query.get("_id") == self.actor["_id"]:
            return self.actor
        if query.get("username") == self.actor["username"]:
            return self.actor
        if query.get("username") == self.target["username"]:
            return self.target
        return None

    def _update_user(self, query, update, **_kwargs):
        if query.get("_id") != self.target["_id"] and query.get("username") != self.target["username"]:
            return None
        if "rank" in update.get("$set", {}):
            self.target["rank"] = update["$set"]["rank"]
        if "chat_timeout_until" in update.get("$set", {}):
            self.target["chat_timeout_until"] = update["$set"]["chat_timeout_until"]
        return self.target

    def test_moderator_can_inspect_users_and_manage_timeouts(self):
        staff_by_rank = {role["rank"]: role["staff"] for role in self.roles}
        self.assertEqual(
            staff_by_rank,
            {
                "Admin": True,
                "Moderator": True,
                "Mod": True,
                "VIP": False,
                "User": False,
                "Subscriber": False,
            },
        )
        self.assertTrue(routes.role_permissions(self.actor)["staff"])
        self.assertTrue(routes.has_permission(self.actor, "panel_access"))
        inspected = self.client.get("/admin/users/target-user")
        timed_out = self.client.post("/admin/users/target-user/timeout", json={"duration_seconds": 30})

        self.assertEqual(inspected.status_code, 200)
        self.assertEqual(inspected.get_json()["user"]["username"], "target-user")
        self.assertEqual(timed_out.status_code, 200)
        self.assertIsNotNone(timed_out.get_json()["user"]["chat_timeout_until"])

    def test_missing_or_invalid_permissions_fail_closed(self):
        self.permissions.find_one.side_effect = None
        self.permissions.find_one.return_value = {"capabilities": {}}

        self.assertFalse(routes.has_permission(self.actor, "panel_access"))
        self.assertFalse(routes.has_permission(self.actor, "manage_timeouts"))
        self.assertEqual(
            self.client.post(
                "/admin/users/target-user/timeout",
                json={"duration_seconds": 30},
            ).status_code,
            403,
        )

    def test_invalid_target_role_permissions_block_privileged_changes(self):
        actor_role = next(role for role in self.roles if role["rank"] == "Moderator")
        target_role = next(role for role in self.roles if role["rank"] == "User")
        actor_permissions = self.permissions_by_id[actor_role["_id"]]
        self.permissions.find_one.side_effect = lambda query: (
            {"capabilities": {}}
            if query.get("rank_id") == target_role["_id"]
            else actor_permissions
        )

        allowed, _role = routes.can_manage_target_role(
            self.actor,
            self.target,
            "timeout_staff_role_ids",
            "timeout_non_staff",
        )

        self.assertFalse(allowed)

    def test_moderator_can_grant_and_remove_vip_from_other_users(self):
        grant = self.client.post("/admin/users/target-user/rank", json={"rank": "VIP"})
        self.assertEqual(grant.status_code, 200)
        self.assertEqual(grant.get_json()["user"]["rank"], "VIP")

        remove = self.client.post("/admin/users/target-user/rank", json={"rank": "User"})
        self.assertEqual(remove.status_code, 200)
        self.assertEqual(remove.get_json()["user"]["rank"], "User")

    def test_moderator_can_assign_future_non_staff_ranks(self):
        self.ranks.find_one.side_effect = lambda query: {"rank": query["rank"]}

        response = self.client.post(
            "/admin/users/target-user/rank",
            json={"rank": "Subscriber"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["user"]["rank"], "Subscriber")

        changed_again = self.client.post(
            "/admin/users/target-user/rank",
            json={"rank": "User"},
        )
        self.assertEqual(changed_again.status_code, 200)
        self.assertEqual(changed_again.get_json()["user"]["rank"], "User")

    def test_moderator_cannot_escalate_ranks_or_modify_self_or_staff(self):
        for rank in ("Mod", "admin"):
            with self.subTest(rank=rank):
                response = self.client.post(
                    "/admin/users/target-user/rank",
                    json={"rank": rank},
                )
                self.assertIn(response.status_code, (400, 403))

        self.target["_id"] = self.actor["_id"]
        self.target["username"] = self.actor["username"]
        self.target["rank"] = self.actor["rank"]
        self.assertEqual(
            self.client.post(
                "/admin/users/staff-user/rank",
                json={"rank": "VIP"},
            ).status_code,
            403,
        )

        for protected_rank in ("Mod", "admin"):
            self.target["_id"] = ObjectId()
            self.target["username"] = "target-user"
            self.target["rank"] = protected_rank
            response = self.client.post(
                "/admin/users/target-user/rank",
                json={"rank": "User"},
            )
            self.assertEqual(response.status_code, 403)

        self.users.find_one_and_update.assert_not_called()

    def test_admin_rank_is_immutable_and_staff_ranks_cannot_be_assigned(self):
        self.actor["rank"] = "admin"
        with self.client.session_transaction() as session:
            session["admin_user_id"] = str(self.actor["_id"])

        for target_username, target_rank in (
            ("staff-user", "admin"),
            ("target-user", "admin"),
        ):
            self.target["username"] = target_username
            self.target["_id"] = self.actor["_id"] if target_username == "staff-user" else ObjectId()
            self.target["rank"] = target_rank
            with self.subTest(target=target_username):
                response = self.client.post(
                    f"/admin/users/{target_username}/rank",
                    json={"rank": "VIP"},
                )
                self.assertEqual(response.status_code, 403)

        self.target["username"] = "target-user"
        self.target["_id"] = ObjectId()
        self.target["rank"] = "User"
        for staff_rank in ("Mod", "admin"):
            with self.subTest(assign=staff_rank):
                response = self.client.post(
                    "/admin/users/target-user/rank",
                    json={"rank": staff_rank},
                )
                self.assertEqual(response.status_code, 400)

        self.users.find_one_and_update.assert_not_called()

    def test_admin_can_assign_non_staff_ranks_to_moderators_and_users(self):
        self.actor["rank"] = "admin"
        with self.client.session_transaction() as session:
            session["admin_user_id"] = str(self.actor["_id"])

        for current_rank, new_rank in (("Mod", "VIP"), ("User", "Subscriber")):
            self.target["rank"] = current_rank
            self.ranks.find_one.side_effect = lambda query: {"rank": query["rank"]}
            with self.subTest(current_rank=current_rank, new_rank=new_rank):
                response = self.client.post(
                    "/admin/users/target-user/rank",
                    json={"rank": new_rank},
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.get_json()["user"]["rank"], new_rank)

    def test_moderator_cannot_use_admin_only_actions(self):
        responses = (
            self.client.post("/admin/users/target-user/points", json={"amount": 1}),
            self.client.post("/admin/users/target-user/reset-password", json={}),
            self.client.post("/admin/streaming", json={"streaming": True}),
        )

        self.assertEqual([response.status_code for response in responses], [403, 403, 403])
        self.users.find_one_and_update.assert_not_called()
        self.users.update_one.assert_not_called()

    def test_moderator_cannot_timeout_staff_but_admin_can(self):
        existing_timeout = datetime.now(timezone.utc) + timedelta(minutes=5)
        for protected_rank in ("MOD", "admin"):
            self.target["rank"] = protected_rank
            self.target["chat_timeout_until"] = existing_timeout
            for body in ({"duration_seconds": 30}, {"clear": True}):
                with self.subTest(actor="Mod", target=protected_rank, body=body):
                    denied = self.client.post(
                        "/admin/users/target-user/timeout",
                        json=body,
                    )
                    self.assertEqual(denied.status_code, 403)
                    self.assertEqual(self.target["chat_timeout_until"], existing_timeout)
        self.users.find_one_and_update.assert_not_called()

        self.actor["rank"] = "admin"
        with self.client.session_transaction() as session:
            session["admin_user_id"] = str(self.actor["_id"])

        self.target["rank"] = "admin"
        self.target["chat_timeout_until"] = existing_timeout
        for body in ({"duration_seconds": 30}, {"clear": True}):
            with self.subTest(actor="admin", target="admin", body=body):
                denied = self.client.post(
                    "/admin/users/target-user/timeout",
                    json=body,
                )
                self.assertEqual(denied.status_code, 403)
                self.assertEqual(self.target["chat_timeout_until"], existing_timeout)
        self.users.find_one_and_update.assert_not_called()

        for allowed_rank in ("Moderator", "User"):
            self.target["rank"] = allowed_rank
            with self.subTest(actor="admin", target=allowed_rank):
                allowed = self.client.post(
                    "/admin/users/target-user/timeout",
                    json={"duration_seconds": 30},
                )
                self.assertEqual(allowed.status_code, 200)
                self.assertIsNotNone(allowed.get_json()["user"]["chat_timeout_until"])
                query = self.users.find_one_and_update.call_args.args[0]
                self.assertEqual(query, {"_id": self.target["_id"], "rank": allowed_rank})

    def test_ordinary_user_cannot_access_staff_endpoints(self):
        self.actor["rank"] = "User"
        responses = (
            self.client.get("/admin/users/target-user"),
            self.client.post("/admin/users/target-user/timeout", json={"duration_seconds": 30}),
            self.client.post("/admin/users/target-user/rank", json={"rank": "VIP"}),
            self.client.post("/admin/users/target-user/points", json={"amount": 1}),
            self.client.post("/admin/users/target-user/reset-password", json={}),
            self.client.post("/admin/streaming", json={"streaming": True}),
        )

        self.assertEqual([response.status_code for response in responses], [403] * len(responses))
        self.users.find_one_and_update.assert_not_called()
        self.users.update_one.assert_not_called()

    def test_ordinary_user_can_read_only_own_moderation_status(self):
        self.actor["rank"] = "User"

        own_response = self.client.get("/admin/users/staff-user")
        other_response = self.client.get("/admin/users/target-user")

        self.assertEqual(own_response.status_code, 200)
        self.assertEqual(own_response.get_json()["user"]["username"], "staff-user")
        self.assertEqual(other_response.status_code, 403)

    def test_admin_retains_rank_management_and_admin_only_access(self):
        self.actor["rank"] = "admin"
        with self.client.session_transaction() as session:
            session["admin_user_id"] = str(self.actor["_id"])
        self.users.find_one_and_update.side_effect = None
        self.target["rank"] = "User"
        self.users.find_one_and_update.return_value = {**self.target, "rank": "VIP"}

        rank_response = self.client.post(
            "/admin/users/target-user/rank",
            json={"rank": "VIP"},
        )
        points_response = self.client.post(
            "/admin/users/target-user/points",
            json={"amount": 1, "request_id": "01aefda6-6c0f-4d43-83e8-0e8c77ee4db5"},
        )
        self.users.update_one.return_value.matched_count = 1
        reset_response = self.client.post(
            "/admin/users/target-user/reset-password",
            json={},
        )
        self.settings.find_one_and_update.return_value = {"streaming": True}
        streaming_response = self.client.post(
            "/admin/streaming",
            json={"streaming": True},
        )

        self.assertEqual(rank_response.status_code, 200)
        self.assertEqual(rank_response.get_json()["user"]["rank"], "VIP")
        self.assertEqual(points_response.status_code, 200)
        self.assertEqual(reset_response.status_code, 200)
        self.assertEqual(streaming_response.status_code, 200)


if __name__ == "__main__":
    unittest.main()
