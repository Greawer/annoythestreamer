from pymongo import MongoClient
from pymongo.errors import DuplicateKeyError
import logging
import uuid

logging.basicConfig(level=logging.INFO)

def get_database():
    try:
        CONNECTION_STRING = "mongodb://127.0.0.1:27017/"
        client = MongoClient(CONNECTION_STRING)
        db = client['annoythestreamer']
        return db
    except Exception as e:
        logging.error(f"client.py MongoDB connect FAILED: {e}")
        raise

# LAZY: Get fresh DB each time
def get_collections():
    dbname = get_database()
    colfacememe = dbname['facememe']
    colnormalmeme = dbname['normalmeme']
    colttsmeme = dbname['ttsmeme']
    colchat = dbname['chat']
    colusers = dbname['users']
    colranks = dbname['ranks']
    colpermissions = dbname['permissions']
    colsettings = dbname['settings']
    colpricing = dbname['pricing']
    colpointtransactions = dbname['point_transactions']
    colsoundactions = dbname['sound_actions']
    colsounds = dbname['sounds']
    colemojis = dbname['emojis']
    colthemes = dbname['themes']
    colassetownership = dbname['asset_ownership']
    colshoppurchases = dbname['shop_purchases']
    colsoundfavorites = dbname['sound_favorites']
    colbadges = dbname['badges']
    return (
        colfacememe,
        colnormalmeme,
        colttsmeme,
        colchat,
        colusers,
        colranks,
        colpermissions,
        colsettings,
        colpricing,
        colpointtransactions,
        colsoundactions,
        colsounds,
        colemojis,
        colthemes,
        colassetownership,
        colshoppurchases,
        colsoundfavorites,
        colbadges,
    )

# Global cache - refresh on demand
(
    colfacememe,
    colnormalmeme,
    colttsmeme,
    colchat,
    colusers,
    colranks,
    colpermissions,
    colsettings,
    colpricing,
    colpointtransactions,
    colsoundactions,
    colsounds,
    colemojis,
    colthemes,
    colassetownership,
    colshoppurchases,
    colsoundfavorites,
    colbadges,
) = get_collections()
colusers.create_index('username', unique=True)
colranks.create_index('rank', unique=True)
colpermissions.create_index('rank_id', unique=True)
colsounds.create_index('name', unique=True)
colsounds.create_index('file', unique=True)
colemojis.create_index('name', unique=True)
colemojis.create_index('file', unique=True)
colbadges.create_index('name_key', unique=True)
colbadges.create_index('file', unique=True)
colthemes.create_index('name_key', unique=True)
for asset_collection in (colsounds, colemojis):
    asset_collection.create_index(
        [('proposal_user_id', 1), ('proposal_request_id', 1)],
        unique=True,
        sparse=True,
    )
colassetownership.create_index(
    [('user_id', 1), ('asset_type', 1), ('asset_id', 1)],
    unique=True,
)
colshoppurchases.create_index(
    [('user_id', 1), ('asset_type', 1), ('asset_id', 1)],
    unique=True,
)
colsoundfavorites.create_index(
    [('user_id', 1), ('asset_id', 1)],
    unique=True,
)
colsoundfavorites.create_index(
    [('user_id', 1), ('created_at', 1), ('_id', 1)],
)
colshoppurchases.create_index(
    [('user_id', 1), ('request_id', 1)],
    unique=True,
    partialFilterExpression={'request_id': {'$type': 'string'}},
)
for action_collection in (colfacememe, colnormalmeme, colttsmeme, colsoundactions):
    action_collection.create_index(
        [('user_id', 1), ('request_id', 1)],
        unique=True,
        partialFilterExpression={'request_id': {'$type': 'string'}},
    )
colpointtransactions.create_index(
    [('user_id', 1), ('request_id', 1)],
    unique=True,
    partialFilterExpression={'request_id': {'$type': 'string'}},
)


def migrate_legacy_sound_actions():
    for action in colpointtransactions.find({
        'action_type': 'soundmeme',
        'file': {'$exists': True},
        'source_request_id': {'$exists': False},
    }):
        user_id = action.get('user_id')
        request_id = action.get('request_id')
        if user_id is None or not isinstance(request_id, str):
            logging.error("Skipping legacy sound action without user or request reference")
            continue

        try:
            existing = colsoundactions.find_one({
                'user_id': user_id,
                'request_id': request_id,
            })
            if not existing:
                try:
                    colsoundactions.insert_one(action)
                except DuplicateKeyError:
                    existing = colsoundactions.find_one({
                        'user_id': user_id,
                        'request_id': request_id,
                    })
                    if not existing:
                        raise

            cost = action.get('point_cost', 0)
            if action.get('charged') and cost:
                charge_id = str(uuid.uuid5(
                    uuid.NAMESPACE_URL,
                    f"paid-action:{user_id}:{request_id}",
                ))
                colpointtransactions.update_one(
                    {'user_id': user_id, 'request_id': charge_id},
                    {'$setOnInsert': {
                        'user_id': user_id,
                        'request_id': charge_id,
                        'action_type': 'soundmeme',
                        'amount': -cost,
                        'source_request_id': request_id,
                        'state': 'applied',
                        'timestamp': action.get('timestamp'),
                    }},
                    upsert=True,
                )
                refund_applied = (
                    action.get('refund_status') == 'refunded'
                    or colusers.find_one(
                        {'_id': user_id, 'refunded_action_ids': request_id},
                        {'_id': 1},
                    ) is not None
                )
                if refund_applied:
                    refund_id = str(uuid.uuid5(
                        uuid.NAMESPACE_URL,
                        f"paid-action-refund:{user_id}:{request_id}",
                    ))
                    colpointtransactions.update_one(
                        {'user_id': user_id, 'request_id': refund_id},
                        {'$setOnInsert': {
                            'user_id': user_id,
                            'request_id': refund_id,
                            'action_type': 'action_refund',
                            'amount': cost,
                            'source_request_id': request_id,
                            'state': 'applied',
                        }},
                        upsert=True,
                    )

            colpointtransactions.delete_one({
                '_id': action['_id'],
                'user_id': user_id,
                'request_id': request_id,
            })
        except Exception:
            logging.exception("Could not migrate a legacy sound action")


# Insert functions
def addfacememe(**kwargs):
    try:
        colfacememe.insert_one(kwargs)
    except Exception as e:
        logging.error(f"Error writing Face Meme: {e}")

def addnormalmeme(**kwargs):
    try:
        colnormalmeme.insert_one(kwargs)
    except Exception as e:
        logging.error(f"Error writing Normal Meme: {e}")

def addttsmeme(**kwargs):
    colttsmeme.insert_one(kwargs)

def lastfacememe():
    try:
        meme = colfacememe.find_one(
            {'done': False},
            {'_id': 1, 'user': 1, 'toptext': 1, 'bottomtext': 1, 'timestamp': 1},
            sort=[('_id', -1)],
        )
        if meme: meme['_id'] = str(meme['_id'])
        return meme
    except Exception as e:
        logging.error(f"Error fetching last facememe: {e}")
        return None

def lastnormalmeme():
    try:
        meme = colnormalmeme.find_one(
            {'done': False},
            {'_id': 1, 'user': 1, 'image': 1, 'toptext': 1, 'bottomtext': 1, 'timestamp': 1},
            sort=[('_id', -1)],
        )
        if meme: meme['_id'] = str(meme['_id'])
        return meme
    except Exception as e:
        logging.error(f"Error fetching last normalmeme: {e}")
        return None

def refresh_collections():
    global colfacememe, colnormalmeme, colttsmeme, colchat, colusers, colranks, colpermissions, colsettings, colpricing, colpointtransactions, colsoundactions, colsounds, colemojis, colthemes, colassetownership, colshoppurchases, colsoundfavorites
    (
        colfacememe,
        colnormalmeme,
        colttsmeme,
        colchat,
        colusers,
        colranks,
        colpermissions,
        colsettings,
        colpricing,
        colpointtransactions,
        colsoundactions,
        colsounds,
        colemojis,
        colthemes,
        colassetownership,
        colshoppurchases,
        colsoundfavorites,
    ) = get_collections()
    print("Collections refreshed")