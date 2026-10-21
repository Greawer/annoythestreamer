from flask import render_template, request, jsonify, send_from_directory, session
from functools import wraps
from flask_socketio import SocketIO
from bson.json_util import dumps
from bson import ObjectId
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError
from werkzeug.security import check_password_hash, generate_password_hash
from client import (
    colfacememe,
    colnormalmeme,
    colpointtransactions,
    colsoundactions,
    colttsmeme,
    colchat,
    colusers,
    colranks,
    colpermissions,
    colsettings,
    colpricing,
    lastfacememe,
    lastnormalmeme,
)
from datetime import datetime, timedelta, timezone
import os
import logging
import re
import uuid
import copy
from collections import deque
from mutagen import File as MutagenFile

logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger(__name__)

MAX_MESSAGES = 50
ACTION_COSTS = {
    'normalmeme': 5,
    'facemememe': 5,
    'soundmeme': 5,
    'tts': 5,
}
MAX_POINT_PRICE = 9_007_199_254_740_991
POINT_PRICING_ID = 'point_pricing'
DEFAULT_POINT_PRICING = {
    'send_your_chaos': dict(ACTION_COSTS),
    'catalog': {
        'emoji': {'default': 100, 'categories': {}, 'items': {}},
        'sound': {'default': 100, 'categories': {}, 'items': {}},
    },
    'proposal_rewards': {
        'sound': {'default': 100_000, 'items': {}},
        'emoji': {'default': 100_000, 'items': {}},
    },
}
lastmessages = deque(maxlen=MAX_MESSAGES)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SOUNDDIR = os.path.join(BASE_DIR, 'static', 'sounds', 'soundboard')
onlineusers = set()  # GLOBAL FIXED
socket_users = {}  # sid -> {'user_id': str, 'username': str}, verified at connect


def normalize_email(value):
    if not isinstance(value, str):
        return None

    email = value.strip()
    if len(email) > 254 or email.count('@') != 1:
        return None

    local, domain = email.split('@')
    local_atom = r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+"
    if (
        len(local) > 64
        or not re.fullmatch(rf"{local_atom}(?:\.{local_atom})*", local)
        or not domain
    ):
        return None

    domain_label = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    if not all(re.fullmatch(domain_label, label) for label in domain.split('.')):
        return None
    if '.' not in domain:
        return None

    return email.lower()


def serialize_user(user):
    registered_at = user.get('registered_at')
    timeout_until = active_chat_timeout_until(user)
    role = find_role(user.get('rank'))
    permission_document = colpermissions.find_one({'rank_id': role['_id']}) if role else None
    capabilities = permission_document.get('capabilities', {}) if isinstance(permission_document, dict) else {}
    permissions_valid = role_permissions(user) is not None
    return {
        'username': user.get('username', ''),
        'rank': user.get('rank', 'user'),
        'rank_id': str(role['_id']) if role else None,
        'staff': role.get('staff') if role and isinstance(role.get('staff'), bool) else None,
        'rank_immutable': not permissions_valid or capabilities.get('rank_immutable') is not False,
        'points': user.get('points', 0),
        'banned': user.get('banned', False),
        'chat_timeout_until': timeout_until.isoformat() if timeout_until else None,
        'registered_at': registered_at.isoformat() if hasattr(registered_at, 'isoformat') else registered_at,
        'message_count': colchat.count_documents({'user': user.get('username', '')}),
    }


def active_chat_timeout_until(user, now=None):
    timeout_until = user.get('chat_timeout_until')
    if not isinstance(timeout_until, datetime):
        return None
    if timeout_until.tzinfo is None:
        timeout_until = timeout_until.replace(tzinfo=timezone.utc)
    current_time = now or datetime.now(timezone.utc)
    if current_time.tzinfo is None:
        current_time = current_time.replace(tzinfo=timezone.utc)
    return timeout_until if timeout_until > current_time else None


# Pre-load chat history on startup
def require_login(handler):
    @wraps(handler)
    def wrapped(*args, **kwargs):
        user_id = session.get('user_id')
        if not user_id:
            return jsonify({'message': 'Login required'}), 401
        try:
            user = colusers.find_one({'_id': ObjectId(user_id)})
        except Exception:
            user = None
        if not user:
            session.clear()
            return jsonify({'message': 'Login required'}), 401
        return handler(*args, **kwargs)
    return wrapped


def get_admin_user(capability='admin_console'):
    admin_id = session.get('admin_user_id')
    if not admin_id:
        return None
    try:
        user = colusers.find_one({'_id': ObjectId(admin_id)})
        return user if has_permission(user, capability) else None
    except Exception:
        return None


def get_session_user():
    user_id = session.get('user_id')
    if not user_id:
        return None
    try:
        return colusers.find_one({'_id': ObjectId(user_id)})
    except Exception:
        return None


def get_moderation_user():
    user = get_session_user()
    return user if has_permission(user, 'panel_access') else None


def emit_points_changed(socketio, user):
    if not socketio or not user:
        return

    user_id = str(user['_id'])
    for sid, identity in tuple(socket_users.items()):
        if identity.get('user_id') == user_id:
            socketio.emit('points_changed', {'updated': True}, to=sid)


def normalize_request_id(value):
    if not isinstance(value, str):
        return None
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError):
        return None


def _clear_pending_point_operation(user_id, request_id):
    colusers.update_one(
        {'_id': user_id, 'pending_point_operation': request_id},
        {'$unset': {'pending_point_operation': ''}},
    )


def find_role(rank_name):
    if not isinstance(rank_name, str):
        return None
    return next(
        (
            role for role in colranks.find({}, {'rank': 1, 'color': 1, 'staff': 1})
            if isinstance(role.get('rank'), str) and role['rank'].casefold() == rank_name.casefold()
        ),
        None,
    )


def validated_role_capabilities(role, document):
    capabilities = document.get('capabilities') if isinstance(document, dict) else None
    if not isinstance(capabilities, dict) or not isinstance(role.get('staff'), bool):
        return None
    boolean_capabilities = (
        'view_ranks', 'panel_access', 'admin_console', 'inspect_users',
        'manage_timeouts', 'timeout_non_staff', 'manage_ranks',
        'assign_non_staff_rank', 'edit_non_staff_rank', 'edit_self',
        'rank_immutable', 'adjust_points', 'reset_password', 'stream_control',
    )
    if any(not isinstance(capabilities.get(name), bool) for name in boolean_capabilities):
        return None
    for name in ('timeout_staff_role_ids', 'edit_staff_role_ids'):
        values = capabilities.get(name)
        if not isinstance(values, list) or any(not isinstance(value, ObjectId) for value in values):
            return None
    free_actions = capabilities.get('free_actions')
    discount = capabilities.get('discount_percent')
    if (
        not isinstance(free_actions, list)
        or any(not isinstance(action, str) or action not in ACTION_COSTS for action in free_actions)
        or isinstance(discount, bool)
        or not isinstance(discount, int)
        or discount < 0
        or discount > 100
    ):
        return None
    return capabilities


def role_permissions(account):
    role = find_role(account.get('rank')) if isinstance(account, dict) else None
    if not role or not isinstance(role.get('_id'), ObjectId):
        return None
    document = colpermissions.find_one({'rank_id': role['_id']})
    capabilities = validated_role_capabilities(role, document)
    if capabilities is None:
        return None
    return {
        'rank_id': str(role['_id']),
        'staff': role.get('staff') is True,
        'capabilities': capabilities,
    }


def has_permission(account, capability):
    profile = role_permissions(account)
    capabilities = profile.get('capabilities') if profile else None
    return isinstance(capabilities, dict) and capabilities.get(capability) is True


def permitted_role_ids(account, capability):
    profile = role_permissions(account)
    values = profile.get('capabilities', {}).get(capability) if profile else None
    if not isinstance(values, list) or any(not isinstance(value, ObjectId) for value in values):
        return set()
    return {str(value) for value in values}


def validate_price(value, label):
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < -1
        or value > MAX_POINT_PRICE
    ):
        raise ValueError(f'{label} must be -1 or a whole number from 0 to {MAX_POINT_PRICE}')
    return value


def validate_price_map(value, label):
    if not isinstance(value, dict):
        raise ValueError(f'{label} must be an object')
    normalized = {}
    for raw_key, price in value.items():
        if (
            not isinstance(raw_key, str)
            or not raw_key.strip()
            or len(raw_key.strip()) > 80
            or any(character in raw_key for character in ('.', '$'))
            or any(ord(character) < 32 for character in raw_key)
        ):
            raise ValueError(f'{label} names must be 1 to 80 characters and cannot contain "." or "$"')
        key = raw_key.strip()
        if key in normalized:
            raise ValueError(f'{label} contains a duplicate name: {key}')
        normalized[key] = validate_price(price, f'{label} price for "{key}"')
    return normalized


def validate_point_pricing(value):
    if not isinstance(value, dict):
        raise ValueError('Pricing must be an object')
    if set(value) != {'send_your_chaos', 'catalog', 'proposal_rewards'}:
        raise ValueError('Pricing must include Send Your Chaos, catalog, and proposal reward settings')

    chaos = value['send_your_chaos']
    if not isinstance(chaos, dict) or set(chaos) != set(ACTION_COSTS):
        raise ValueError('Pricing must include all four Send Your Chaos actions')
    normalized_chaos = {
        action: validate_price(chaos[action], f'{action} price')
        for action in ACTION_COSTS
    }

    catalog = value['catalog']
    if not isinstance(catalog, dict) or set(catalog) != {'emoji', 'sound'}:
        raise ValueError('Catalog pricing must include emoji and sound')
    normalized_catalog = {}
    for asset_type, asset_prices in catalog.items():
        if not isinstance(asset_prices, dict) or set(asset_prices) != {'default', 'categories', 'items'}:
            raise ValueError(f'{asset_type} pricing must include default, categories, and items')
        normalized_catalog[asset_type] = {
            'default': validate_price(asset_prices['default'], f'{asset_type} default price'),
            'categories': validate_price_map(
                asset_prices['categories'],
                f'{asset_type} category',
            ),
            'items': validate_price_map(asset_prices['items'], f'{asset_type} item'),
        }

    proposals = value['proposal_rewards']
    if not isinstance(proposals, dict) or set(proposals) != {'sound', 'emoji'}:
        raise ValueError('Proposal rewards must include sound and emoji')
    normalized_proposals = {}
    for proposal_type, rewards in proposals.items():
        if not isinstance(rewards, dict) or set(rewards) != {'default', 'items'}:
            raise ValueError(f'{proposal_type} proposal rewards must include default and items')
        normalized_proposals[proposal_type] = {
            'default': validate_price(rewards['default'], f'{proposal_type} proposal reward'),
            'items': validate_price_map(
                rewards['items'],
                f'{proposal_type} proposal item',
            ),
        }

    return {
        'send_your_chaos': normalized_chaos,
        'catalog': normalized_catalog,
        'proposal_rewards': normalized_proposals,
    }


def load_point_pricing():
    document = colpricing.find_one({'_id': POINT_PRICING_ID})
    if document is None:
        return copy.deepcopy(DEFAULT_POINT_PRICING)
    pricing = document.get('pricing')
    try:
        return validate_point_pricing(pricing)
    except ValueError as error:
        logger.error('Stored point pricing is invalid: %s', error)
        raise ValueError('Stored point pricing is invalid; an administrator must correct it') from error


def resolve_catalog_price(asset_type, item_id=None, category=None, pricing=None):
    settings = pricing if pricing is not None else load_point_pricing()
    catalog = settings['catalog'].get(asset_type)
    if catalog is None:
        raise ValueError(f'Unsupported catalog asset type: {asset_type}')
    if item_id is not None and item_id in catalog['items']:
        return catalog['items'][item_id]
    if category is not None and category in catalog['categories']:
        return catalog['categories'][category]
    return catalog['default']


def resolve_proposal_reward(proposal_type, item_id=None, pricing=None):
    settings = pricing if pricing is not None else load_point_pricing()
    rewards = settings['proposal_rewards'].get(proposal_type)
    if rewards is None:
        raise ValueError(f'Unsupported proposal type: {proposal_type}')
    return rewards['items'].get(item_id, rewards['default'])


def is_price_available(price):
    return isinstance(price, int) and not isinstance(price, bool) and price >= 0


def can_manage_target_role(actor, target, capability, non_staff_capability):
    target_role = find_role(target.get('rank')) if isinstance(target, dict) else None
    if not target_role or not isinstance(target_role.get('_id'), ObjectId):
        return False, None
    target_permissions = colpermissions.find_one({'rank_id': target_role['_id']})
    target_caps = validated_role_capabilities(target_role, target_permissions)
    if target_caps is None or target_caps['rank_immutable']:
        return False, target_role
    if target_role.get('staff') is True:
        allowed = str(target_role['_id']) in permitted_role_ids(actor, capability)
    elif target_role.get('staff') is False:
        allowed = has_permission(actor, non_staff_capability)
    else:
        allowed = False
    return allowed, target_role


def seed_role_permissions():
    roles = list(colranks.find({}, {'rank': 1, 'staff': 1}))
    role_ids_by_kind = {
        kind: [
            role['_id']
            for role in roles
            if isinstance(role.get('rank'), str) and role['rank'].casefold() in names
        ]
        for kind, names in {
            'admin': {'admin'},
            'moderator': {'mod', 'moderator'},
            'vip': {'vip'},
            'user': {'user'},
        }.items()
    }
    for role in roles:
        if not isinstance(role.get('_id'), ObjectId) or not isinstance(role.get('rank'), str):
            continue
        role_name = role['rank'].casefold()
        is_admin_role = role_name == 'admin'
        is_moderator_role = role_name in {'mod', 'moderator'}
        is_vip_role = role_name == 'vip'
        if 'staff' not in role:
            colranks.update_one(
                {'_id': role['_id'], 'staff': {'$exists': False}},
                {'$set': {'staff': is_admin_role or is_moderator_role}},
            )

        capabilities = {
            'view_ranks': True,
            'panel_access': is_admin_role or is_moderator_role,
            'admin_console': is_admin_role,
            'inspect_users': is_admin_role or is_moderator_role,
            'manage_timeouts': is_admin_role or is_moderator_role,
            'timeout_non_staff': is_admin_role or is_moderator_role,
            'timeout_staff_role_ids': role_ids_by_kind['moderator'] if is_admin_role else [],
            'manage_ranks': is_admin_role or is_moderator_role,
            'assign_non_staff_rank': is_admin_role or is_moderator_role,
            'edit_non_staff_rank': is_admin_role or is_moderator_role,
            'edit_staff_role_ids': role_ids_by_kind['moderator'] if is_admin_role else [],
            'edit_self': False,
            'rank_immutable': is_admin_role,
            'adjust_points': is_admin_role,
            'reset_password': is_admin_role,
            'stream_control': is_admin_role,
            'free_actions': list(ACTION_COSTS) if is_admin_role else [],
            'discount_percent': 50 if is_vip_role else 0,
        }
        colpermissions.update_one(
            {'rank_id': role['_id']},
            {'$setOnInsert': {
                'rank_id': role['_id'],
                'capabilities': capabilities,
                'schema_version': 1,
            }},
            upsert=True,
        )


def public_role_permissions(account):
    profile = role_permissions(account)
    if not profile:
        return None
    capabilities = dict(profile['capabilities'])
    for name in ('timeout_staff_role_ids', 'edit_staff_role_ids'):
        values = capabilities.get(name)
        capabilities[name] = (
            [str(value) for value in values]
            if isinstance(values, list) and all(isinstance(value, ObjectId) for value in values)
            else []
        )
    return {**profile, 'capabilities': capabilities}


def role_rank_is_immutable(role):
    permission = colpermissions.find_one({'rank_id': role['_id']})
    capabilities = validated_role_capabilities(role, permission)
    return capabilities is None or capabilities['rank_immutable']


def flush_pending_point_transactions(user):
    pending = user.get('pending_point_transactions', [])
    if not isinstance(pending, list):
        raise ValueError("Invalid pending point transaction journal")
    for transaction in pending:
        if not isinstance(transaction, dict):
            raise ValueError("Invalid pending point transaction")
        details = {
            key: value
            for key, value in transaction.items()
            if key not in {'request_id', 'action_type', 'amount', 'balance_after'}
        }
        record_point_transaction(
            user['_id'],
            transaction['request_id'],
            transaction['action_type'],
            transaction['amount'],
            transaction['balance_after'],
            **details,
        )
        colusers.update_one(
            {'_id': user['_id'], 'pending_point_transactions.request_id': transaction['request_id']},
            {'$pull': {'pending_point_transactions': {'request_id': transaction['request_id']}}},
        )
    return True


def flush_all_pending_point_transactions():
    for user in colusers.find(
        {'pending_point_transactions.0': {'$exists': True}},
        {'_id': 1, 'pending_point_transactions': 1},
    ):
        try:
            flush_pending_point_transactions(user)
        except Exception:
            logger.exception("Pending point transaction flush failed for user %s", user.get('_id'))


def get_action_cost(action, account):
    profile = role_permissions(account)
    capabilities = profile.get('capabilities', {}) if profile else {}
    free_actions = capabilities.get('free_actions')
    if isinstance(free_actions, list) and action in free_actions:
        return 0
    cost = load_point_pricing()['send_your_chaos'][action]
    if cost == -1:
        return -1
    discount = capabilities.get('discount_percent', 0)
    if isinstance(discount, int) and not isinstance(discount, bool) and 0 < discount <= 100:
        return (cost * (100 - discount) + 99) // 100
    return cost


def public_usage_cost_fields(account):
    if has_permission(account, 'admin_console'):
        return {}
    return {'usage_costs': {action: get_action_cost(action, account) for action in ACTION_COSTS}}


def record_point_transaction(user_id, request_id, action_type, amount, balance_after, **details):
    colpointtransactions.update_one(
        {'user_id': user_id, 'request_id': request_id},
        {
            '$setOnInsert': {
                'user_id': user_id,
                'request_id': request_id,
                'action_type': action_type,
                'amount': amount,
                'balance_after': balance_after,
                'state': 'applied',
                'timestamp': datetime.now(timezone.utc),
                **details,
            },
        },
        upsert=True,
    )


def accept_paid_action(action_collection, account, request_id, document, socketio=None):
    user_id = account['_id']
    existing = action_collection.find_one({'user_id': user_id, 'request_id': request_id})
    if existing and any(
        existing.get(key) != value
        for key, value in document.items()
        if key not in {'timestamp', 'created', 'done'}
    ):
        return {
            'status': 'error',
            'code': 'request_id_conflict',
            'message': 'This request ID belongs to a different action. Retry the action.',
        }, 409
    if existing and existing.get('state') in {'failed', 'refunded'}:
        return {
            'status': 'error',
            'code': 'action_failed',
            'message': 'The previous action failed. Retry it to submit a new request.',
        }, 409
    if existing and existing.get('state') == 'rejected':
        current_user = colusers.find_one({'_id': user_id}) or account
        balance = current_user.get('points', 0)
        cost = existing.get('point_cost', 0)
        if existing.get('rejection_reason') == 'unavailable' or cost == -1:
            return {
                'status': 'error',
                'code': 'action_unavailable',
                'message': 'This action is currently unavailable.',
                'points': balance,
            }, 403
        return {
            'status': 'error',
            'code': 'insufficient_points',
            'message': f"This action costs {cost} points. You have {balance} points.",
            'points': balance,
        }, 402
    if existing and existing.get('state') == 'accepted':
        current_user = colusers.find_one({'_id': user_id}) or account
        if existing.get('charged') and existing.get('point_cost', 0):
            record_point_transaction(
                user_id,
                str(uuid.uuid5(uuid.NAMESPACE_URL, f"paid-action:{user_id}:{request_id}")),
                existing['action_type'],
                -existing['point_cost'],
                existing.get('balance_after', current_user.get('points', 0)),
                source_request_id=request_id,
            )
        _clear_pending_point_operation(user_id, request_id)
        return {
            'status': 'ok',
            'points': current_user.get('points', 0),
            'charged': bool(existing.get('charged')),
            'duplicate': True,
        }, 200

    if existing is None:
        cost = get_action_cost(document['action_type'], account)
        if cost == -1:
            current_user = colusers.find_one({'_id': user_id}) or account
            return {
                'status': 'error',
                'code': 'action_unavailable',
                'message': 'This action is currently unavailable.',
                'points': current_user.get('points', 0),
            }, 403
        action_document = {
            **document,
            'user_id': user_id,
            'request_id': request_id,
            'state': 'reserved',
            'point_cost': cost,
            'charged': False,
            'done': True,
        }
        try:
            action_collection.insert_one(action_document)
            existing = action_document
        except DuplicateKeyError:
            existing = action_collection.find_one({'user_id': user_id, 'request_id': request_id})
            if existing is None:
                raise

    cost = existing.get('point_cost')
    if cost is None:
        cost = get_action_cost(existing['action_type'], account)
    if cost == -1:
        current_user = colusers.find_one({'_id': user_id}) or account
        action_collection.update_one(
            {'user_id': user_id, 'request_id': request_id, 'state': 'reserved'},
            {'$set': {
                'state': 'rejected',
                'rejection_reason': 'unavailable',
                'done': True,
            }},
        )
        return {
            'status': 'error',
            'code': 'action_unavailable',
            'message': 'This action is currently unavailable.',
            'points': current_user.get('points', 0),
        }, 403
    charged = bool(existing.get('charged'))
    debited_user = None
    if cost and not charged:
        current_user = colusers.find_one({'_id': user_id})
        if not current_user:
            return {'status': 'error', 'message': 'Account could not be loaded'}, 401
        if current_user.get('pending_point_operation') == request_id:
            charged = True
        elif current_user.get('pending_point_operation'):
            return {
                'status': 'error',
                'message': 'A previous point action is still being processed. Retry this action in a moment.',
                'points': current_user.get('points', 0),
            }, 409
        else:
            debited_user = colusers.find_one_and_update(
                {
                    '_id': user_id,
                    '$expr': {'$gte': [{'$ifNull': ['$points', 0]}, cost]},
                    '$or': [
                        {'pending_point_operation': {'$exists': False}},
                        {'pending_point_operation': None},
                    ],
                },
                {
                    '$inc': {'points': -cost},
                    '$set': {'pending_point_operation': request_id},
                },
                return_document=ReturnDocument.AFTER,
            )
            if debited_user:
                charged = True
            else:
                current_user = colusers.find_one({'_id': user_id})
                if not current_user:
                    return {'status': 'error', 'message': 'Account could not be loaded'}, 401
                if current_user.get('pending_point_operation'):
                    return {
                        'status': 'error',
                        'message': 'A previous point action is still being processed. Retry this action in a moment.',
                        'points': current_user.get('points', 0),
                    }, 409
                balance = current_user.get('points', 0)
                action_collection.update_one(
                    {'user_id': user_id, 'request_id': request_id, 'state': 'reserved'},
                    {'$set': {'state': 'rejected', 'done': True}},
                )
                return {
                    'status': 'error',
                    'code': 'insufficient_points',
                    'message': f"This action costs {cost} points. You have {balance} points.",
                    'points': balance,
                }, 402

    accepted_fields = {'state': 'accepted', 'charged': charged, 'done': False}
    current_user = colusers.find_one({'_id': user_id}) or account
    if charged and cost:
        accepted_fields['balance_after'] = (
            debited_user.get('points', 0)
            if debited_user
            else current_user.get('points', 0)
        )
    if existing.get('action_type') == 'tts':
        accepted_fields['created'] = 'no'
    result = action_collection.update_one(
        {'user_id': user_id, 'request_id': request_id, 'state': 'reserved'},
        {'$set': accepted_fields},
    )
    accepted = action_collection.find_one({'user_id': user_id, 'request_id': request_id})
    if not accepted or accepted.get('state') != 'accepted':
        logger.error("Could not finalize accepted action %s for user %s", request_id, user_id)
        return {'status': 'error', 'message': 'Action could not be confirmed. Retry the request.'}, 503
    current_user = colusers.find_one({'_id': user_id}) or account
    if charged and cost:
        record_point_transaction(
            user_id,
            str(uuid.uuid5(uuid.NAMESPACE_URL, f"paid-action:{user_id}:{request_id}")),
            accepted['action_type'],
            -cost,
            accepted.get('balance_after', current_user.get('points', 0)),
            source_request_id=request_id,
        )
    if cost:
        _clear_pending_point_operation(user_id, request_id)
    if result.matched_count and cost and socketio:
        try:
            emit_points_changed(socketio, current_user)
        except Exception:
            logger.exception("Point balance notification failed for %s", user_id)
    return {
        'status': 'ok',
        'points': current_user.get('points', 0),
        'charged': charged,
        'duplicate': False,
    }, 200


def refund_failed_action(action, action_collection, socketio=None):
    cost = action.get('point_cost', 0)
    user_id = action.get('user_id')
    request_id = action.get('request_id')
    if not action.get('charged') or not cost or not user_id or not request_id:
        return True

    result = colusers.update_one(
        {'_id': user_id, 'refunded_action_ids': {'$ne': request_id}},
        [{
            '$set': {
                'points': {'$add': [{'$ifNull': ['$points', 0]}, cost]},
                'refunded_action_ids': {
                    '$concatArrays': [{'$ifNull': ['$refunded_action_ids', []]}, [request_id]],
                },
            },
        }],
    )
    user = colusers.find_one({'_id': user_id})
    if not user or request_id not in user.get('refunded_action_ids', []):
        logger.error("Could not refund failed action %s for user %s", request_id, user_id)
        return False

    cost = action.get('point_cost', 0)
    if action.get('charged') and cost:
        record_point_transaction(
            user_id,
            str(uuid.uuid5(uuid.NAMESPACE_URL, f"paid-action-refund:{user_id}:{request_id}")),
            'action_refund',
            cost,
            user.get('points', 0),
            source_request_id=request_id,
        )
    action_collection.update_one(
        {'user_id': user_id, 'request_id': request_id},
        {'$set': {'refund_status': 'refunded'}},
    )
    if result.modified_count and socketio:
        try:
            emit_points_changed(socketio, user)
        except Exception:
            logger.exception("Refund balance notification failed for %s", user_id)
    return True


def get_rank_color(rank):
    rank_key = rank.casefold()
    return next(
        (
            item.get('color')
            for item in colranks.find({}, {'rank': 1, 'color': 1})
            if item.get('rank', '').casefold() == rank_key
        ),
        None,
    )


def get_online_user_ranks():
    users = colusers.find(
        {'username': {'$in': list(onlineusers)}},
        {'username': 1, 'rank': 1},
    )
    rank_colors = {
        item['rank'].casefold(): item.get('color')
        for item in colranks.find({}, {'rank': 1, 'color': 1})
    }
    return {
        user['username']: {
            'rank': user.get('rank', 'User'),
            'rank_color': rank_colors.get(user.get('rank', 'User').casefold()),
        }
        for user in users
    }


def add_current_ranks(messages):
    usernames = {message.get('user') for message in messages if message.get('user')}
    ranks = {
        user['username']: user.get('rank', 'User')
        for user in colusers.find(
            {'username': {'$in': list(usernames)}},
            {'username': 1, 'rank': 1},
        )
    }
    rank_colors = {
        rank['rank'].casefold(): rank.get('color')
        for rank in colranks.find({}, {'rank': 1, 'color': 1})
    }
    return [
        {
            **message,
            'rank': ranks.get(message.get('user')),
            'rank_color': rank_colors.get(ranks[message['user']].casefold()) if message.get('user') in ranks else None,
        }
        for message in messages
    ]


try:
    msgs = list(colchat.find().sort('timestamp', -1).limit(MAX_MESSAGES))
    msgs.reverse()
    for m in msgs:
        lastmessages.append({'user': m['user'], 'message': m['message']})
except Exception as e:
    logger.error(f"Failed to load chat history: {e}")

def registersocketiohandlers(socketio: SocketIO):
    @socketio.on('playsound')
    def handleplaysound(data):
        identity = socket_users.get(request.sid)
        if not identity or not isinstance(data, dict):
            return {'status': 'error', 'message': 'Login required'}
        try:
            account = colusers.find_one({'_id': ObjectId(identity['user_id'])})
        except Exception:
            account = None
        if not account:
            return {'status': 'error', 'message': 'Login required'}

        request_id = normalize_request_id(data.get('request_id'))
        sound_name = data.get('file')
        if not request_id:
            return {'status': 'error', 'message': 'A valid request ID is required'}
        if not isinstance(sound_name, str) or not sound_name or os.path.basename(sound_name) != sound_name:
            return {'status': 'error', 'message': 'Select a valid sound'}
        if sound_name.lower().endswith('.mp3'):
            filename = sound_name
        elif os.path.splitext(sound_name)[1]:
            return {'status': 'error', 'message': 'This sound format is not supported'}
        else:
            filename = f'{sound_name}.mp3'
        if not os.path.isfile(os.path.join(SOUNDDIR, filename)):
            return {'status': 'error', 'message': 'Sound is no longer available'}

        action_collection = colsoundactions
        legacy_action = colpointtransactions.find_one({
            'user_id': account['_id'],
            'request_id': request_id,
            'action_type': 'soundmeme',
            'file': {'$exists': True},
        })
        if legacy_action:
            action_collection = colpointtransactions

        result, status = accept_paid_action(
            action_collection,
            account,
            request_id,
            {
                'action_type': 'soundmeme',
                'file': filename,
                'timestamp': datetime.now(timezone.utc),
            },
            socketio,
        )
        if status != 200 or result.get('duplicate'):
            return result
        try:
            socketio.emit(
                'playsound',
                {'file': os.path.splitext(filename)[0]},
                include_self=True,
            )
        except Exception:
            logger.exception("Sound action broadcast failed for request %s", request_id)
            action_collection.update_one(
                {'user_id': account['_id'], 'request_id': request_id},
                {'$set': {'state': 'failed', 'refund_status': 'pending'}},
            )
            action = action_collection.find_one({
                'user_id': account['_id'],
                'request_id': request_id,
            })
            refunded = False
            if action:
                refunded = refund_failed_action(action, action_collection, socketio)
            current_user = colusers.find_one({'_id': account['_id']}) or account
            return {
                'status': 'error',
                'code': 'action_failed',
                'message': (
                    'Sound could not be sent; points were refunded.'
                    if refunded
                    else 'Sound could not be sent; the refund is being retried.'
                ),
                'points': current_user.get('points', 0),
            }
        return result

    @socketio.on('chat_message')
    def handlechatmessage(data):
        identity = socket_users.get(request.sid)
        if not identity or not isinstance(data, dict):
            return
        try:
            account = colusers.find_one({'_id': ObjectId(identity['user_id'])})
        except Exception:
            account = None
        if not account:
            return
        user = account['username']
        message = data.get('message', '')
        message = message.strip() if isinstance(message, str) else ''
        if message:
            if active_chat_timeout_until(account):
                logger.info("Blocked chat message from timed-out user %s", user)
                return
            rank = account.get('rank', 'User')
            color = get_rank_color(rank)
            msgobj = {
                'user': user,
                'message': message,
                'rank': rank,
                'rank_color': color,
                'timestamp': datetime.now(timezone.utc)
            }
            try:
                colchat.insert_one(msgobj)
                lastmessages.append({'user': user, 'message': message, 'rank': rank, 'rank_color': color})
                socketio.emit('chat_message', {'user': user, 'message': message, 'rank': rank, 'rank_color': color})
            except Exception as e:
                logger.error(f"Chat save failed: {e}")

    @socketio.on('connect')
    def handleconnect():
        account = get_session_user()
        if account:
            socket_users[request.sid] = {'user_id': str(account['_id']), 'username': account['username']}
            onlineusers.add(account['username'])
            emit_points_changed(socketio, account)
        socketio.emit('update_users', list(onlineusers), include_self=False)
        socketio.emit('online_user_ranks', get_online_user_ranks())
        try:
            socketio.emit('chat_history', add_current_ranks(list(lastmessages)), to=request.sid)
            state = colsettings.find_one({'_id': 'stream_points'})
            socketio.emit('streaming_status', {'streaming': bool(state and state.get('streaming'))}, to=request.sid)
        except Exception as e:
            logger.error(f"History send failed: {e}")

    @socketio.on('disconnect')
    def handledisconnect():
        identity = socket_users.pop(request.sid, None)
        if identity and not any(i['username'] == identity['username'] for i in socket_users.values()):
            onlineusers.discard(identity['username'])
        socketio.emit('update_users', list(onlineusers))
        socketio.emit('online_user_ranks', get_online_user_ranks())

    @socketio.on('getusers')
    def handlegetusers():
        socketio.emit('update_users', list(onlineusers), to=request.sid)
        socketio.emit('online_user_ranks', get_online_user_ranks(), to=request.sid)


def award_stream_points(socketio=None):
    state = colsettings.find_one({'_id': 'stream_points'})
    if not state or state.get('streaming') is not True:
        return 0
    now = datetime.now(timezone.utc)
    started_at = state.get('stream_started_at')
    if not isinstance(started_at, datetime):
        return 0
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=timezone.utc)
    interval = int((now - started_at).total_seconds() // 60)
    if interval <= 0:
        return 0

    awarded = 0
    for username in tuple(onlineusers):
        user = colusers.find_one_and_update(
            {
                'username': username,
                'banned': {'$ne': True},
                '$or': [
                    {'chat_timeout_until': {'$exists': False}},
                    {'chat_timeout_until': {'$lte': now}},
                ],
                '$and': [{
                    '$or': [
                        {'last_stream_award_started_at': {'$exists': False}},
                        {'last_stream_award_started_at': {'$lt': started_at}},
                        {
                            '$and': [
                                {'last_stream_award_started_at': started_at},
                                {
                                    '$or': [
                                        {'last_stream_award_interval': {'$exists': False}},
                                        {'last_stream_award_interval': {'$lt': interval}},
                                    ],
                                },
                            ],
                        },
                    ],
                }],
            },
            [{
                '$set': {
                    'points': {'$add': [{'$ifNull': ['$points', 0]}, 100]},
                    'last_stream_award_started_at': started_at,
                    'last_stream_award_interval': interval,
                    'pending_point_transactions': {
                        '$concatArrays': [
                            {'$ifNull': ['$pending_point_transactions', []]},
                            [{
                                'request_id': f"stream:{started_at.isoformat()}:{interval}:{username}",
                                'action_type': 'stream_award',
                                'amount': 100,
                                'balance_after': {'$add': [{'$ifNull': ['$points', 0]}, 100]},
                                'stream_started_at': started_at,
                                'stream_interval': interval,
                                'timestamp': now,
                            }],
                        ],
                    },
                },
            }],
            return_document=ReturnDocument.AFTER,
        )
        if user:
            awarded += 1
            try:
                flush_pending_point_transactions(user)
            except Exception:
                logger.exception(
                    "Stream award transaction remains pending for user %s and interval %s",
                    user['_id'],
                    interval,
                )
            emit_points_changed(socketio, user)
    return awarded


def start_stream_points_worker(socketio: SocketIO):
    def worker():
        while True:
            socketio.sleep(1)
            try:
                flush_all_pending_point_transactions()
                state = colsettings.find_one({'_id': 'stream_points'})
                if not state or state.get('streaming') is not True:
                    continue
                started_at = state.get('stream_started_at')
                if not isinstance(started_at, datetime):
                    started_at = datetime.now(timezone.utc)
                    state = colsettings.find_one_and_update(
                        {
                            '_id': 'stream_points',
                            'streaming': True,
                            'stream_started_at': {'$exists': False},
                        },
                        {'$set': {'stream_started_at': started_at}},
                        return_document=ReturnDocument.AFTER,
                    ) or state
                    started_at = state.get('stream_started_at', started_at)
                if started_at.tzinfo is None:
                    started_at = started_at.replace(tzinfo=timezone.utc)
                interval = int((datetime.now(timezone.utc) - started_at).total_seconds() // 60)
                if interval > 0:
                    awarded = award_stream_points(socketio)
                    logger.info("Stream minute %s awarded 100 points to %s active users", interval, awarded)
            except Exception as e:
                logger.error("Stream point worker failed: %s", e)

    socketio.start_background_task(worker)


def registerroutes(app, socketio: SocketIO):
    @app.route('/admin/streaming', methods=['GET', 'POST'])
    def streamingstatus():
        if request.method == 'GET':
            state = colsettings.find_one_and_update(
                {'_id': 'stream_points'},
                {'$setOnInsert': {'streaming': False}},
                upsert=True,
                return_document=ReturnDocument.AFTER,
            )
            return jsonify({'streaming': state.get('streaming') is True})
        if request.method == 'POST' and not get_admin_user('stream_control'):
            return jsonify({'message': 'Admin login required'}), 403

        data = request.get_json(silent=True) or {}
        streaming = data.get('streaming')
        if not isinstance(streaming, bool):
            return jsonify({'message': 'Streaming must be true or false'}), 400
        previous_state = colsettings.find_one({'_id': 'stream_points'})
        changes = {'streaming': streaming}
        if streaming and not (previous_state and previous_state.get('streaming', False)):
            changes['stream_started_at'] = datetime.now(timezone.utc)
        elif not streaming:
            colsettings.update_one(
                {'_id': 'stream_points'},
                {'$unset': {'stream_started_at': ''}},
            )
        state = colsettings.find_one_and_update(
            {'_id': 'stream_points'},
            {'$set': changes},
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
        if socketio:
            socketio.emit('streaming_status', {'streaming': state['streaming']})
        return jsonify({'streaming': state['streaming']})

    @app.route('/auth/lookup', methods=['POST'])
    def authlookup():
        data = request.get_json(silent=True) or {}
        username = data.get('username')
        if not isinstance(username, str) or not username.strip() or len(username.strip()) > 64:
            return jsonify({'message': 'Enter a valid username'}), 400
        user = colusers.find_one({'username': username.strip()}, {'password_hash': 1})
        return jsonify({
            'exists': user is not None,
            'requires_password_creation': not user or not user.get('password_hash'),
        })

    @app.route('/auth/login', methods=['POST'])
    def authlogin():
        data = request.get_json(silent=True) or {}
        username = data.get('username')
        password = data.get('password')
        confirmation = data.get('confirmation')
        if not isinstance(username, str) or not username.strip() or len(username.strip()) > 64:
            return jsonify({'message': 'Enter a valid username'}), 400
        if not isinstance(password, str) or not password or len(password) > 256:
            return jsonify({'message': 'Enter a valid password'}), 400
        username = username.strip()
        user = colusers.find_one({'username': username})
        created_account = False
        if not user or not user.get('password_hash'):
            if password != confirmation:
                return jsonify({'message': 'Passwords do not match'}), 400
            if len(password) < 8:
                return jsonify({'message': 'Password must be at least 8 characters'}), 400
            email = normalize_email(data.get('email'))
            if not email:
                return jsonify({'message': 'Enter a valid email address'}), 400
            if not colranks.find_one({'rank': 'User'}):
                return jsonify({'message': 'Default User rank is not configured'}), 503
            if not user:
                document = {
                    'username': username,
                    'email': email,
                    'password_hash': generate_password_hash(password),
                    'rank': 'User',
                    'points': 1000,
                    'banned': False,
                    'registered_at': datetime.now(timezone.utc),
                }
                try:
                    inserted = colusers.insert_one(document)
                    user = colusers.find_one({'_id': inserted.inserted_id})
                    created_account = True
                except DuplicateKeyError:
                    return jsonify({'message': 'Account already exists; sign in instead'}), 409
            else:
                changed = colusers.update_one(
                    {'_id': user['_id'], '$or': [{'password_hash': None}, {'password_hash': {'$exists': False}}]},
                    {'$set': {'password_hash': generate_password_hash(password), 'email': email}},
                )
                if changed.matched_count == 0:
                    return jsonify({'message': 'Password was changed; try logging in again'}), 409
                user = colusers.find_one({'_id': user['_id']})
        elif not check_password_hash(user['password_hash'], password):
            return jsonify({'message': 'Incorrect password'}), 401

        if not user:
            return jsonify({'message': 'Account could not be loaded'}), 409
        if created_account:
            transaction_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"registration:{user['_id']}"))
            record_point_transaction(
                user['_id'],
                transaction_id,
                'registration_award',
                user.get('points', 0),
                user.get('points', 0),
            )
        session.clear()
        session['user_id'] = str(user['_id'])
        permissions = public_role_permissions(user)
        capabilities = permissions.get('capabilities', {}) if permissions else {}
        if capabilities.get('panel_access') is True:
            session['admin_user_id'] = str(user['_id'])
        response = {
            'status': 'ok',
            'username': username,
            'rank': user.get('rank', 'User'),
            'points': user.get('points', 0),
            'permissions': permissions,
            **public_usage_cost_fields(user),
        }
        return jsonify(response)

    @app.route('/auth/session')
    def authsession():
        user_id = session.get('user_id')
        try:
            user = colusers.find_one({'_id': ObjectId(user_id)}) if user_id else None
        except Exception:
            user = None
        if not user:
            session.clear()
            return jsonify({'authenticated': False})
        response = {
            'authenticated': True,
            'username': user['username'],
            'rank': user.get('rank', 'User'),
            'points': user.get('points', 0),
            'permissions': public_role_permissions(user),
            **public_usage_cost_fields(user),
        }
        return jsonify(response)

    @app.route('/auth/logout', methods=['POST'])
    def authlogout():
        session.clear()
        return jsonify({'status': 'ok'})

    @app.route('/admin/ranks')
    def adminranks():
        ranks = colranks.find({}, {'rank': 1, 'color': 1, 'staff': 1}).sort('_id', 1)
        return jsonify({
            'ranks': [{
                'id': str(rank['_id']),
                'rank': rank['rank'],
                'color': rank.get('color'),
                'staff': rank.get('staff') if isinstance(rank.get('staff'), bool) else None,
                'rank_immutable': role_rank_is_immutable(rank),
            } for rank in ranks],
        })

    @app.route('/admin/check', methods=['POST'])
    def checkadminrank():
        data = request.get_json(silent=True) or {}
        username = str(data.get('username', '')).strip()
        user = colusers.find_one({'username': username}) if username else None
        return jsonify({'requires_password': has_permission(user, 'admin_console')})

    @app.route('/admin/login', methods=['POST'])
    def adminlogin():
        data = request.get_json(silent=True) or {}
        username = str(data.get('username', '')).strip()
        password = data.get('password')
        user = colusers.find_one({'username': username}) if username and isinstance(password, str) else None
        password_hash = user.get('password_hash') if user else None
        if not user or not has_permission(user, 'admin_console') or not password_hash or not check_password_hash(password_hash, password):
            return jsonify({'message': 'Invalid admin credentials'}), 401
        session.clear()
        session['user_id'] = str(user['_id'])
        session['admin_user_id'] = str(user['_id'])
        return jsonify({
            'status': 'ok',
            'username': username,
            'rank': user.get('rank', 'User'),
            'permissions': public_role_permissions(user),
            **public_usage_cost_fields(user),
        })

    @app.route('/admin/session')
    def adminsession():
        admin_id = session.get('admin_user_id')
        if not admin_id:
            return jsonify({'authenticated': False})
        try:
            admin = colusers.find_one({'_id': ObjectId(admin_id)})
        except Exception:
            admin = None
        if not has_permission(admin, 'admin_console'):
            session.clear()
            return jsonify({'authenticated': False})
        return jsonify({
            'authenticated': True,
            'username': admin['username'],
            'rank': admin.get('rank', 'User'),
            'permissions': public_role_permissions(admin),
            **public_usage_cost_fields(admin),
        })

    @app.route('/admin/pricing', methods=['GET', 'PUT'])
    @require_login
    def adminpricing():
        if not get_admin_user('admin_console'):
            return jsonify({'message': 'Admin login required'}), 403
        if request.method == 'GET':
            try:
                return jsonify({'pricing': load_point_pricing()})
            except ValueError as error:
                return jsonify({'message': str(error)}), 503

        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({'message': 'Request body must be an object'}), 400
        try:
            pricing = validate_point_pricing(data.get('pricing'))
        except ValueError as error:
            return jsonify({'message': str(error)}), 400
        try:
            colpricing.update_one(
                {'_id': POINT_PRICING_ID},
                {'$set': {
                    'schema_version': 1,
                    'pricing': pricing,
                    'updated_at': datetime.now(timezone.utc),
                }},
                upsert=True,
            )
        except Exception:
            logger.exception('Could not save point pricing')
            return jsonify({'message': 'Pricing could not be saved'}), 503
        if socketio:
            socketio.emit('usage_costs_changed')
        return jsonify({'pricing': pricing})

    @app.route('/admin/logout', methods=['POST'])
    def adminlogout():
        session.clear()
        return jsonify({'status': 'ok'})

    @app.route('/admin/users/<username>')
    @require_login
    def admingetuser(username):
        session_user = get_session_user()
        if not has_permission(session_user, 'inspect_users') and (
            not session_user or session_user.get('username') != username
        ):
            return jsonify({'message': 'Moderator or admin login required'}), 403
        user = colusers.find_one({'username': username})
        if not user:
            return jsonify({'message': 'User not found'}), 404
        return jsonify({'user': serialize_user(user)})

    @app.route('/admin/users/<username>/points', methods=['POST'])
    @require_login
    def adminadjustpoints(username):
        if not get_admin_user('adjust_points'):
            return jsonify({'message': 'Admin login required'}), 403
        data = request.get_json(silent=True) or {}
        amount = data.get('amount')
        if isinstance(amount, bool) or not isinstance(amount, int):
            return jsonify({'message': 'Point adjustment must be an integer'}), 400
        request_id = normalize_request_id(data.get('request_id'))
        if not request_id:
            return jsonify({'message': 'A valid request ID is required'}), 400
        timestamp = datetime.now(timezone.utc)
        next_balance = {'$max': [0, {'$add': [{'$ifNull': ['$points', 0]}, amount]}]}
        actual_delta = {
            '$let': {
                'vars': {
                    'previous': {'$ifNull': ['$points', 0]},
                    'next': next_balance,
                },
                'in': {'$subtract': ['$$next', '$$previous']},
            },
        }
        adjustment_record = {
            'request_id': request_id,
            'requested_amount': amount,
            'amount': actual_delta,
            'balance_after': next_balance,
            'timestamp': timestamp,
        }
        user = colusers.find_one_and_update(
            {'username': username, 'point_adjustment_ids': {'$ne': request_id}},
            [{
                '$set': {
                    'points': next_balance,
                    'point_adjustment_ids': {
                        '$concatArrays': [{'$ifNull': ['$point_adjustment_ids', []]}, [request_id]],
                    },
                    'point_adjustment_records': {
                        '$concatArrays': [
                            {'$ifNull': ['$point_adjustment_records', []]},
                            [adjustment_record],
                        ],
                    },
                    'pending_point_transactions': {
                        '$concatArrays': [
                            {'$ifNull': ['$pending_point_transactions', []]},
                            [{
                                'request_id': request_id,
                                'action_type': 'admin_adjustment',
                                'amount': actual_delta,
                                'balance_after': next_balance,
                                'requested_amount': amount,
                                'actor_user_id': ObjectId(session['user_id']),
                                'timestamp': timestamp,
                            }],
                        ],
                    },
                },
            }],
            return_document=ReturnDocument.AFTER,
        )
        applied = user is not None
        if not user:
            user = colusers.find_one({'username': username})
            if not user:
                return jsonify({'message': 'User not found'}), 404
            if request_id not in user.get('point_adjustment_ids', []):
                return jsonify({'message': 'Point adjustment could not be applied'}), 409
        adjustment = next(
            (
                item for item in user.get('point_adjustment_records', [])
                if item.get('request_id') == request_id
            ),
            None,
        )
        if adjustment:
            try:
                if user.get('pending_point_transactions'):
                    flush_pending_point_transactions(user)
                else:
                    record_point_transaction(
                        user['_id'],
                        request_id,
                        'admin_adjustment',
                        adjustment['amount'],
                        adjustment['balance_after'],
                        requested_amount=adjustment['requested_amount'],
                        actor_user_id=ObjectId(session['user_id']),
                        timestamp=adjustment.get('timestamp', timestamp),
                    )
            except Exception:
                logger.exception("Admin point adjustment transaction remains pending for %s", request_id)
                return jsonify({
                    'message': 'Balance changed, but its transaction record is pending. Retry this request.',
                    'user': serialize_user(user),
                }), 503
        if applied:
            emit_points_changed(socketio, user)
        return jsonify({'user': serialize_user(user)})

    @app.route('/admin/users/<username>/timeout', methods=['POST'])
    @require_login
    def adminchat_timeout(username):
        actor = get_session_user()
        if not has_permission(actor, 'manage_timeouts'):
            return jsonify({'message': 'Moderator or admin login required'}), 403

        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({'message': 'Request body must be an object'}), 400
        if 'clear' in data and data['clear'] is not True:
            return jsonify({'message': 'Clear must be true'}), 400
        if data.get('clear') is True:
            update = {'$unset': {'chat_timeout_until': ''}}
        else:
            duration_seconds = data.get('duration_seconds')
            if (
                isinstance(duration_seconds, bool)
                or not isinstance(duration_seconds, int)
                or duration_seconds <= 0
            ):
                return jsonify({'message': 'Duration must be a positive whole number of seconds'}), 400
            now = datetime.now(timezone.utc)
            try:
                timeout_until = now + timedelta(seconds=duration_seconds)
            except OverflowError:
                return jsonify({'message': 'Duration is too large'}), 400
            update = {'$set': {'chat_timeout_until': timeout_until}}

        target = colusers.find_one({'username': username}, {'_id': 1, 'rank': 1})
        if not target:
            return jsonify({'message': 'User not found'}), 404
        allowed, target_role = can_manage_target_role(
            actor,
            target,
            'timeout_staff_role_ids',
            'timeout_non_staff',
        )
        if not allowed:
            return jsonify({'message': 'You cannot timeout this staff rank'}), 403

        user = colusers.find_one_and_update(
            {'_id': target['_id'], 'rank': target.get('rank')},
            update,
            return_document=ReturnDocument.AFTER,
        )
        if not user:
            return jsonify({'message': 'User rank changed; reload and try again'}), 409
        return jsonify({'user': serialize_user(user)})

    @app.route('/admin/users/<username>/rank', methods=['POST'])
    @require_login
    def adminchangerank(username):
        actor = get_session_user()
        if not has_permission(actor, 'manage_ranks'):
            return jsonify({'message': 'Moderator or admin login required'}), 403
        data = request.get_json(silent=True) or {}
        rank = data.get('rank')
        if not isinstance(rank, str):
            return jsonify({'message': 'Select an available non-staff rank'}), 400
        destination_role = find_role(rank)
        if not destination_role or destination_role.get('staff') is not False:
            return jsonify({'message': 'Select an available non-staff rank'}), 400
        target = colusers.find_one({'username': username}, {'_id': 1, 'rank': 1})
        if not target:
            return jsonify({'message': 'User not found'}), 404
        allowed, target_role = can_manage_target_role(
            actor,
            target,
            'edit_staff_role_ids',
            'edit_non_staff_rank',
        )
        actor_profile = role_permissions(actor)
        actor_capabilities = actor_profile.get('capabilities', {}) if actor_profile else {}
        if (
            not allowed
            or target['_id'] == actor['_id'] and actor_capabilities.get('edit_self') is not True
            or actor_capabilities.get('assign_non_staff_rank') is not True
        ):
            return jsonify({'message': 'You cannot modify this user rank'}), 403

        user = colusers.find_one_and_update(
            {'_id': target['_id'], 'rank': target.get('rank')},
            {'$set': {'rank': rank}},
            return_document=ReturnDocument.AFTER,
        )
        if not user:
            return jsonify({'message': 'User rank changed; reload and try again'}), 409
        current_rank = user.get('rank', 'User')
        color = get_rank_color(current_rank)
        socketio.emit('rank_changed', {
            'username': user['username'],
            'rank': current_rank,
            'rank_color': color,
            'permissions': public_role_permissions(user),
            **public_usage_cost_fields(user),
        })
        return jsonify({'user': serialize_user(user)})

    @app.route('/admin/users/<username>/reset-password', methods=['POST'])
    @require_login
    def adminresetpassword(username):
        if not get_admin_user('reset_password'):
            return jsonify({'message': 'Admin login required'}), 403
        result = colusers.update_one({'username': username}, {'$set': {'password_hash': None}})
        if result.matched_count == 0:
            return jsonify({'message': 'User not found'}), 404
        user = colusers.find_one({'username': username})
        return jsonify({'user': serialize_user(user)})

    # HTML PAGES
    @app.route('/')
    def index():
        return render_template('AnnoyTheStreamer.html')

    @app.route('/FaceMeme')
    def facememe():
        return render_template('FaceMeme.html')

    @app.route('/NormalMeme')
    def normalmeme():
        return render_template('NormalMeme.html')

    @app.route('/TTSMeme')
    def ttsmeme():
        return render_template('TTSMeme.html')

    @app.route('/SoundMeme')
    def soundmeme():
        return render_template('SoundMeme.html')

    @app.route('/chatcapture')  # FIXED ROUTE NAME
    def chatcapture():
        return render_template('ChatCapture.html')

    # MEME NEXT ROUTES
    @app.route('/facememe/next', methods=['GET', 'POST', 'OPTIONS', 'PUT'])
    def facememenext():
        try:
            meme = lastfacememe()
            return jsonify(meme or {})
        except Exception as e:
            logger.error(f"/facememe/next error: {e}")
            return jsonify({})

    @app.route('/normalmeme/next', methods=['GET', 'POST', 'OPTIONS', 'PUT'])
    def normalmemenext():
        try:
            meme = lastnormalmeme()
            return jsonify(meme or {})
        except Exception as e:
            logger.error(f"/normalmeme/next error: {e}")
            return jsonify({})

    @app.route('/ttsmeme/next')
    def ttsmemenext():
        try:
            doc = colttsmeme.find_one({'created': 'yes', 'done': {'$ne': True}}, sort=[('_id', 1)])
            if not doc:
                return jsonify({})
            return jsonify({
                'id': str(doc['_id']),
                'filepath': f"/{doc.get('filepath', '').lstrip('/')}",
                'text': doc.get('text', ''),
                'user': doc.get('user', '')
            })
        except Exception as e:
            logger.error(f"/ttsmeme/next error: {e}")
            return jsonify({})

    # POST FORM HANDLER
    @app.route('/handle_post', methods=['POST'])
    @require_login
    def handlepost():
        account = get_session_user()
        if not account:
            return jsonify({'message': 'Login required'}), 401

        toptext = request.form.get('top_text_facememe')
        bottomtext = request.form.get('bottom_text_facememe')
        image = request.form.get('image_normalmeme')
        toptextn = request.form.get('top_text_normalmeme')
        bottomtextn = request.form.get('bottom_text_normalmeme')
        raw_tts = request.form.get('text_ttsmeme')

        actions = []
        if toptext or bottomtext:
            actions.append((
                colfacememe,
                'facemememe',
                {
                    'user': account['username'],
                    'toptext': toptext,
                    'bottomtext': bottomtext,
                    'timestamp': datetime.now(timezone.utc),
                },
            ))
        if image or toptextn or bottomtextn:
            actions.append((
                colnormalmeme,
                'normalmeme',
                {
                    'user': account['username'],
                    'image': image,
                    'toptext': toptextn,
                    'bottomtext': bottomtextn,
                    'timestamp': datetime.now(timezone.utc),
                },
            ))
        if raw_tts and raw_tts.strip():
            actions.append((
                colttsmeme,
                'tts',
                {
                    'action_type': 'tts',
                    'user': account['username'],
                    'text': raw_tts.strip(),
                    'language': request.form.get('language', 'en'),
                    'filepath': '',
                    'timestamp': datetime.now(timezone.utc),
                    'created': 'reserved',
                },
            ))

        if not actions:
            return jsonify({'status': 'ok', 'points': account.get('points', 0)})
        if len(actions) != 1:
            return jsonify({'message': 'Submit one paid action at a time'}), 400
        request_id = normalize_request_id(request.form.get('request_id'))
        if not request_id:
            return jsonify({'message': 'A valid request ID is required'}), 400

        action_collection, action_type, document = actions[0]
        if action_type != 'tts':
            document['action_type'] = action_type
        try:
            result, status = accept_paid_action(
                action_collection,
                account,
                request_id,
                document,
                socketio,
            )
        except Exception:
            logger.exception("Could not accept %s request %s", action_type, request_id)
            return jsonify({
                'status': 'error',
                'message': 'Action could not be confirmed. Retry the same request or check your balance.',
            }), 503
        if status != 200:
            return jsonify(result), status
        return jsonify(result)

    @app.route('/chathistory')
    def chathistory():
        try:
            return dumps(add_current_ranks(list(lastmessages)))
        except Exception as e:
            logger.error(f"/chathistory error: {e}")
            return dumps([])

    @app.route('/tts/done/<ttsmemeid>', methods=['PUT'])
    def ttsdonettsmemeid(ttsmemeid):
        try:
            oid = ObjectId(ttsmemeid)
            colttsmeme.update_one({'_id': oid}, {'$set': {'done': True}})
            return jsonify({'status': 'ok'})
        except Exception as e:
            logger.error(f"/tts done error: {e}")
            return jsonify({'status': 'bad id'}), 400

    # STATIC FILES
    @app.route('/static/img/<path:filename>')
    def serveimg(filename):
        return send_from_directory(os.path.join(BASE_DIR, 'static', 'img'), filename)

    @app.route('/static/sounds/tts/<path:filename>')
    def servetts(filename):
        return send_from_directory(os.path.join(BASE_DIR, 'static', 'sounds', 'tts'), filename)

    @app.route('/static/sounds/soundboard/<path:filename>')
    def servesoundboard(filename):
        return send_from_directory(SOUNDDIR, filename)

    @app.route('/emoji/<name>')
    def emojiname(name):
        folder = os.path.join(BASE_DIR, 'static', 'img', 'emoji')
        for ext in ['.jpg', '.png']:
            path = os.path.join(folder, f"{name}{ext}")
            if os.path.isfile(path):
                return jsonify({'url': f"/static/img/emoji/{name}{ext}"})
        return jsonify({'url': None})

    @app.route('/api/list-emojis')
    def listemojis():
        folder = os.path.join(BASE_DIR, 'static', 'img', 'emoji')
        if os.path.exists(folder):
            emojis = [os.path.splitext(f)[0] for f in os.listdir(folder)
                      if os.path.splitext(f)[1].lower() in ['.jpg', '.png']]
            return jsonify(emojis)
        return jsonify([])

    @app.route('/soundboardlist')
    def soundboardlist():
        sounds = []
        if os.path.exists(SOUNDDIR):
            for filename in os.listdir(SOUNDDIR):
                if not filename.lower().endswith(('.mp3', '.m4a', '.wav')):
                    continue
                filepath = os.path.join(SOUNDDIR, filename)
                title = os.path.splitext(filename)[0]
                try:
                    audio = MutagenFile(filepath, easy=True)
                    if audio:
                        title = audio.get('title', [title])[0]
                except:
                    pass
                sounds.append({
                    'file': filename,
                    'title': title,
                    'url': f"/static/sounds/soundboard/{filename}"
                })
        return jsonify(sounds)

    @app.route('/debug/routes')
    def debugroutes():
        return jsonify([f"{rule.rule} {rule.methods}" for rule in app.url_map.iter_rules()])