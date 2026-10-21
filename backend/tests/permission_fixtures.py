from bson import ObjectId


def configure_role_permissions(routes, ranks, permissions):
    roles = [
        {"_id": ObjectId(), "rank": name, "color": "#ffffff"}
        for name in ("Admin", "Moderator", "Mod", "VIP", "User", "Subscriber")
    ]
    permissions_by_id = {}
    ranks.find.return_value = roles

    def find_role(query, *_args, **_kwargs):
        requested = query.get("rank")
        if isinstance(requested, str):
            return next(
                (role for role in roles if role["rank"].casefold() == requested.casefold()),
                None,
            )
        return None

    def update_role(query, update, **_kwargs):
        role = next((item for item in roles if item["_id"] == query.get("_id")), None)
        if role and "staff" in update.get("$set", {}):
            role["staff"] = update["$set"]["staff"]

    def find_permissions(query, *_args, **_kwargs):
        return permissions_by_id.get(query.get("rank_id"))

    def update_permissions(query, update, upsert=False, **_kwargs):
        rank_id = query.get("rank_id")
        if rank_id not in permissions_by_id:
            permissions_by_id[rank_id] = update["$setOnInsert"]

    ranks.find_one.side_effect = find_role
    ranks.update_one.side_effect = update_role
    permissions.find_one.side_effect = find_permissions
    permissions.update_one.side_effect = update_permissions
    routes.seed_role_permissions()
    return roles, permissions_by_id
