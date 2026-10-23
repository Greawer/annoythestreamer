from flask import request, jsonify, send_from_directory, session
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
    colsounds,
    colemojis,
    colthemes,
    colassetownership,
    colshoppurchases,
    colsoundfavorites,
    colbadges,
    lastfacememe,
    lastnormalmeme,
)
from datetime import datetime, timedelta, timezone
import math
import os
import logging
import re
import uuid
import copy
import hashlib
import secrets
import tempfile
import ipaddress
import http.client
import io
import socket
import urllib.parse
from collections import deque
from mutagen import File as MutagenFile
from werkzeug.datastructures import FileStorage

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
MAX_THEME_BACKGROUND_BYTES = 50 * 1024 * 1024
MAX_THEME_BACKGROUND_REQUEST_BYTES = MAX_THEME_BACKGROUND_BYTES + 1024 * 1024
PASSWORD_RESET_TOKEN_TTL = timedelta(minutes=30)
STANDARD_THEME_ID = ObjectId('65f0a0000000000000000001')
DEFAULT_THEMES = (
    {
        '_id': STANDARD_THEME_ID,
        'name': 'Standard',
        'name_key': 'standard',
        'price': 0,
        'price_overridden': False,
        'primary_color': '#000000',
        'panel_color': '#171717',
        'accent_color': '#f9a8d4',
        'background_image_exists': False,
        'background_opacity': 0.0,
        'background_image_name': None,
        'is_standard': True,
    },
    {
        '_id': ObjectId('65f0a0000000000000000002'),
        'name': 'Ocean',
        'name_key': 'ocean',
        'price': 10_000,
        'price_overridden': False,
        'primary_color': '#38bdf8',
        'panel_color': '#0f172a',
        'accent_color': '#14b8a6',
        'background_image_exists': False,
        'background_opacity': 0.0,
        'background_image_name': None,
        'is_standard': False,
    },
    {
        '_id': ObjectId('65f0a0000000000000000003'),
        'name': 'Sunset',
        'name_key': 'sunset',
        'price': 10_000,
        'price_overridden': False,
        'primary_color': '#fb923c',
        'panel_color': '#1c1917',
        'accent_color': '#f43f5e',
        'background_image_exists': False,
        'background_opacity': 0.0,
        'background_image_name': None,
        'is_standard': False,
    },
)
ASSET_PRICE_UNCHANGED = object()
POINT_PRICING_ID = 'point_pricing'
DEFAULT_POINT_PRICING = {
    'send_your_chaos': dict(ACTION_COSTS),
    'catalog': {
        'emoji': {'default': 100, 'categories': {}, 'items': {}},
        'theme': {'default': 10_000, 'categories': {}, 'items': {}},
        'sound': {
            'default': 100,
            'categories': {},
            'items': {},
            'play_default': 10,
            'play_items': {},
        },
    },
    'proposal_rewards': {
        'sound': {'default': 100_000, 'exclusive': 100_000, 'items': {}},
        'emoji': {'default': 100_000, 'exclusive': 100_000, 'items': {}},
    },
    'asset_limits': {
        'emoji': {'max_px': 1024, 'max_px_admin': 2048},
        'sound': {'max_length': 3, 'max_length_admin': 10},
    },
}
lastmessages = deque(maxlen=MAX_MESSAGES)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.abspath(os.path.join(BASE_DIR, '..', 'public'))
SOUNDDIR = os.path.join(PUBLIC_DIR, 'sounds', 'soundboard')
EMOJIDIR = os.path.join(PUBLIC_DIR, 'img', 'emoji')
BADGEDIR = os.path.join(PUBLIC_DIR, 'img', 'badges')
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


def serialize_badge(badge):
    if not isinstance(badge, dict) or not isinstance(badge.get('file'), str):
        return None
    return {
        'asset_id': str(badge['_id']),
        'name': badge.get('name', ''),
        'file': badge['file'],
        'url': f"/static/img/badges/{badge['file']}",
    }


def user_badges(user):
    badge_ids = user.get('badges', [])
    if not isinstance(badge_ids, list):
        return []
    result = []
    for badge_id in badge_ids:
        try:
            badge_oid = badge_id if isinstance(badge_id, ObjectId) else ObjectId(str(badge_id))
        except Exception:
            continue
        badge = colbadges.find_one({'_id': badge_oid})
        serialized = serialize_badge(badge)
        if serialized:
            result.append(serialized)
    return result


def serialize_user_profile(user):
    profile = serialize_user(user)
    profile.update({
        'email': user.get('email') if isinstance(user.get('email'), str) else None,
        'badges': user_badges(user),
        'visible_badge_id': (
            str(user['visible_badge_id'])
            if user.get('visible_badge_id') is not None
            else None
        ),
    })
    return profile


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


def validate_price_map(value, label, allow_filename=False):
    if not isinstance(value, dict):
        raise ValueError(f'{label} must be an object')
    normalized = {}
    for raw_key, price in value.items():
        if (
            not isinstance(raw_key, str)
            or not raw_key.strip()
            or len(raw_key.strip()) > (120 if allow_filename else 80)
            or '$' in raw_key
            or ('.' in raw_key and not allow_filename)
            or (allow_filename and os.path.basename(raw_key) != raw_key)
            or any(ord(character) < 32 for character in raw_key)
        ):
            raise ValueError(f'{label} names must be 1 to 80 characters and cannot contain "." or "$"')
        key = raw_key.strip()
        if key in normalized:
            raise ValueError(f'{label} contains a duplicate name: {key}')
        normalized[key] = validate_price(price, f'{label} price for "{key}"')
    return normalized


def validate_play_price(value, label):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_POINT_PRICE:
        raise ValueError(f'{label} must be a whole number from 0 to {MAX_POINT_PRICE}')
    return value


def validate_play_price_map(value, label, allow_filename=False):
    if not isinstance(value, dict):
        raise ValueError(f'{label} must be an object')
    normalized = {}
    for raw_key, price in value.items():
        if (
            not isinstance(raw_key, str)
            or not raw_key.strip()
            or len(raw_key.strip()) > (120 if allow_filename else 80)
            or '$' in raw_key
            or ('.' in raw_key and not allow_filename)
            or (allow_filename and os.path.basename(raw_key) != raw_key)
            or any(ord(character) < 32 for character in raw_key)
        ):
            raise ValueError(f'{label} names must be 1 to 80 characters and cannot contain "." or "$"')
        key = raw_key.strip()
        if key in normalized:
            raise ValueError(f'{label} contains a duplicate name: {key}')
        normalized[key] = validate_play_price(price, f'{label} price for "{key}"')
    return normalized


def validate_point_pricing(value):
    if not isinstance(value, dict):
        raise ValueError('Pricing must be an object')
    required_sections = {'send_your_chaos', 'catalog', 'proposal_rewards'}
    if not required_sections.issubset(value) or set(value) - required_sections - {'asset_limits'}:
        raise ValueError('Pricing must include Send Your Chaos, catalog, and proposal reward settings')

    chaos = value['send_your_chaos']
    if not isinstance(chaos, dict) or set(chaos) != set(ACTION_COSTS):
        raise ValueError('Pricing must include all four Send Your Chaos actions')
    normalized_chaos = {
        action: validate_price(chaos[action], f'{action} price')
        for action in ACTION_COSTS
    }

    catalog = value['catalog']
    if not isinstance(catalog, dict) or set(catalog) != {'emoji', 'sound', 'theme'}:
        raise ValueError('Catalog pricing must include emoji, sound, and theme')
    normalized_catalog = {}
    for asset_type, asset_prices in catalog.items():
        required_fields = {'default', 'categories', 'items'}
        optional_fields = {'play_default', 'play_items'} if asset_type == 'sound' else set()
        if (
            not isinstance(asset_prices, dict)
            or not required_fields.issubset(asset_prices)
            or set(asset_prices) - required_fields - optional_fields
        ):
            raise ValueError(f'{asset_type} pricing must include default, categories, and items')
        normalized_catalog[asset_type] = {
            'default': validate_price(asset_prices['default'], f'{asset_type} default price'),
            'categories': validate_price_map(
                asset_prices['categories'],
                f'{asset_type} category',
            ),
            'items': validate_price_map(
                asset_prices['items'],
                f'{asset_type} item',
                allow_filename=asset_type == 'sound',
            ),
        }
        if asset_type == 'sound':
            normalized_catalog[asset_type].update({
                'play_default': validate_play_price(
                    asset_prices.get('play_default', 10),
                    'Soundboard default play price',
                ),
                'play_items': validate_play_price_map(
                    asset_prices.get('play_items', {}),
                    'Soundboard play exception',
                    allow_filename=True,
                ),
            })

    proposals = value['proposal_rewards']
    if not isinstance(proposals, dict) or set(proposals) != {'sound', 'emoji'}:
        raise ValueError('Proposal rewards must include sound and emoji')
    normalized_proposals = {}
    for proposal_type, rewards in proposals.items():
        if (
            not isinstance(rewards, dict)
            or not {'default', 'items'}.issubset(rewards)
            or set(rewards) - {'default', 'exclusive', 'items'}
        ):
            raise ValueError(f'{proposal_type} proposal prices must include default, exclusive, and items')
        normalized_proposals[proposal_type] = {
            'default': validate_price(rewards['default'], f'{proposal_type} proposal reward'),
            'exclusive': validate_price(
                rewards.get('exclusive', DEFAULT_POINT_PRICING['proposal_rewards'][proposal_type]['exclusive']),
                f'{proposal_type} exclusive submission price',
            ),
            'items': validate_price_map(
                rewards['items'],
                f'{proposal_type} proposal item',
            ),
        }

    limits = value.get('asset_limits', DEFAULT_POINT_PRICING['asset_limits'])
    if not isinstance(limits, dict) or set(limits) != {'emoji', 'sound'}:
        raise ValueError('Asset limits must include emoji and sound')
    normalized_limits = {}
    for asset_type, fields in {
        'emoji': ('max_px', 'max_px_admin'),
        'sound': ('max_length', 'max_length_admin'),
    }.items():
        values = limits[asset_type]
        if not isinstance(values, dict) or set(values) != set(fields):
            raise ValueError(f'{asset_type} upload limits are invalid')
        maximum = 8192 if asset_type == 'emoji' else 180
        normalized_limits[asset_type] = {}
        for field in fields:
            limit = values[field]
            if isinstance(limit, bool) or not isinstance(limit, int) or not 0 < limit <= maximum:
                raise ValueError(f'{asset_type} {field} must be a positive whole number no greater than {maximum}')
            normalized_limits[asset_type][field] = limit

    return {
        'send_your_chaos': normalized_chaos,
        'catalog': normalized_catalog,
        'proposal_rewards': normalized_proposals,
        'asset_limits': normalized_limits,
    }


def load_point_pricing():
    document = colpricing.find_one({'_id': POINT_PRICING_ID})
    if document is None:
        return copy.deepcopy(DEFAULT_POINT_PRICING)
    pricing = document.get('pricing')
    legacy_missing_theme = (
        isinstance(pricing, dict)
        and isinstance(pricing.get('catalog'), dict)
        and 'theme' not in pricing['catalog']
    )
    if legacy_missing_theme:
        pricing = copy.deepcopy(pricing)
        pricing.setdefault('catalog', {})['theme'] = copy.deepcopy(DEFAULT_POINT_PRICING['catalog']['theme'])
    try:
        normalized = validate_point_pricing(pricing)
    except ValueError as error:
        logger.error('Stored point pricing is invalid: %s', error)
        raise ValueError('Stored point pricing is invalid; an administrator must correct it') from error
    if isinstance(pricing, dict):
        if legacy_missing_theme:
            colpricing.update_one(
                {'_id': POINT_PRICING_ID, 'pricing.catalog.theme': {'$exists': False}},
                {'$set': {'pricing.catalog.theme': normalized['catalog']['theme']}},
            )
        if 'asset_limits' not in pricing:
            colpricing.update_one(
                {'_id': POINT_PRICING_ID, 'pricing.asset_limits': {'$exists': False}},
                {'$set': {'pricing.asset_limits': normalized['asset_limits']}},
            )
        sound_pricing = pricing.get('catalog', {}).get('sound', {})
        for field in ('play_default', 'play_items'):
            if field not in sound_pricing:
                colpricing.update_one(
                    {
                        '_id': POINT_PRICING_ID,
                        f'pricing.catalog.sound.{field}': {'$exists': False},
                    },
                    {'$set': {
                        f'pricing.catalog.sound.{field}': normalized['catalog']['sound'][field],
                    }},
                )
        for asset_type in ('emoji', 'sound'):
            if 'exclusive' not in pricing.get('proposal_rewards', {}).get(asset_type, {}):
                colpricing.update_one(
                    {
                        '_id': POINT_PRICING_ID,
                        f'pricing.proposal_rewards.{asset_type}.exclusive': {'$exists': False},
                    },
                    {'$set': {
                        f'pricing.proposal_rewards.{asset_type}.exclusive':
                            normalized['proposal_rewards'][asset_type]['exclusive'],
                    }},
                )
    return normalized


def sync_theme_price_fields(pricing):
    theme_prices = pricing['catalog']['theme']
    for theme in colthemes.find({}):
        if theme.get('is_standard') is True:
            price = 0
            overridden = False
        else:
            theme_id = str(theme['_id'])
            overridden = theme_id in theme_prices['items']
            price = theme_prices['items'].get(theme_id, theme_prices['default'])
        colthemes.update_one(
            {'_id': theme['_id']},
            {'$set': {'price': price, 'price_overridden': overridden}},
        )


def resolve_catalog_asset_price(asset_type, asset, pricing=None):
    if asset_type == 'theme' and asset.get('is_standard') is True:
        return 0
    if asset.get('exclusive') is True:
        return -1
    settings = pricing if pricing is not None else load_point_pricing()
    item_key = catalog_asset_exception_key(asset_type, asset, settings)
    if item_key is not None:
        return settings['catalog'][asset_type]['items'][item_key]
    return settings['catalog'][asset_type]['default']


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


def resolve_sound_play_price(asset, pricing):
    sound_pricing = pricing['catalog']['sound']
    item_key = catalog_asset_exception_key('sound', asset, pricing, 'play_items')
    return sound_pricing['play_items'][item_key] if item_key is not None else sound_pricing['play_default']


def catalog_asset_exception_key(asset_type, asset, pricing, map_name='items'):
    asset_pricing = pricing['catalog'][asset_type]
    candidates = []
    if asset_type == 'theme':
        candidates.append(str(asset['_id']))
    filename = asset.get('file')
    if asset_type == 'sound' and isinstance(filename, str):
        candidates.extend((filename, os.path.splitext(filename)[0]))
    candidates.extend((asset.get('pricing_name'), asset.get('name')))
    return next(
        (
            candidate
            for candidate in dict.fromkeys(candidates)
            if isinstance(candidate, str) and candidate in asset_pricing[map_name]
        ),
        None,
    )


def catalog_asset_exception_value(asset_type, asset, pricing, map_name='items'):
    key = catalog_asset_exception_key(asset_type, asset, pricing, map_name)
    return pricing['catalog'][asset_type][map_name].get(key) if key is not None else None


def catalog_asset_exception_target(asset_type, asset):
    if asset_type == 'sound':
        filename = asset.get('file')
        if isinstance(filename, str) and filename:
            return filename
    return asset.get('pricing_name', asset['name'])


def asset_collection(asset_type):
    if asset_type == 'sound':
        return colsounds
    if asset_type == 'emoji':
        return colemojis
    if asset_type == 'theme':
        return colthemes
    raise ValueError(f'Unsupported asset type: {asset_type}')


def normalize_asset_name(value):
    if not isinstance(value, str):
        raise ValueError('Asset name is required')
    name = re.sub(r'[^a-z0-9]', '', value.lower())
    if not name or len(name) > 80:
        raise ValueError('Asset name must contain 1 to 80 letters or numbers')
    return name


def normalize_theme_color(value, label):
    if not isinstance(value, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', value.strip()):
        raise ValueError(f'{label} must be a 6-digit hex color')
    return value.strip().lower()


def parse_asset_price(value):
    if value is None or value == '':
        return None
    if isinstance(value, str):
        if not re.fullmatch(r'-?\d+', value):
            raise ValueError('Price must be -1 or a non-negative whole number')
        value = int(value)
    return validate_price(value, 'Asset price')


def parse_play_price(value):
    if value is None or value == '':
        return None
    if isinstance(value, str):
        if not re.fullmatch(r'\d+', value):
            raise ValueError('Play price must be a non-negative whole number')
        value = int(value)
    return validate_play_price(value, 'Play price')


def inspect_emoji_file(
    path,
    max_file_size=16 * 1024 * 1024,
    max_file_size_message='Emoji files must be no larger than 16 MB',
):
    size = os.path.getsize(path)
    if max_file_size is not None and size > max_file_size:
        raise ValueError(max_file_size_message)
    with open(path, 'rb') as image:
        header = image.read(32)
        if header.startswith(b'\x89PNG\r\n\x1a\n') and len(header) >= 24:
            return 'png', int.from_bytes(header[16:20], 'big'), int.from_bytes(header[20:24], 'big')
        if header.startswith((b'GIF87a', b'GIF89a')) and len(header) >= 10:
            return 'gif', int.from_bytes(header[6:8], 'little'), int.from_bytes(header[8:10], 'little')
        if header.startswith(b'\xff\xd8'):
            image.seek(2)
            while True:
                marker_start = image.read(1)
                if not marker_start:
                    break
                if marker_start != b'\xff':
                    continue
                marker = image.read(1)
                while marker == b'\xff':
                    marker = image.read(1)
                if marker in {b'\xd8', b'\xd9', b'\x00'}:
                    continue
                length_bytes = image.read(2)
                if len(length_bytes) != 2:
                    break
                segment_length = int.from_bytes(length_bytes, 'big')
                if marker in {
                    b'\xc0', b'\xc1', b'\xc2', b'\xc3', b'\xc5', b'\xc6',
                    b'\xc7', b'\xc9', b'\xca', b'\xcb', b'\xcd', b'\xce', b'\xcf',
                }:
                    image.read(1)
                    dimensions = image.read(4)
                    if len(dimensions) == 4:
                        return 'jpg', int.from_bytes(dimensions[2:4], 'big'), int.from_bytes(dimensions[:2], 'big')
                    break
                if segment_length < 2:
                    break
                image.seek(segment_length - 2, os.SEEK_CUR)
    raise ValueError('Emoji must be a valid JPG, PNG, or GIF image')


def validate_uploaded_asset(
    upload,
    asset_type,
    directory,
    maximum=None,
    max_file_size=16 * 1024 * 1024,
    max_file_size_message='Emoji files must be no larger than 16 MB',
    dimension_label='Emoji',
):
    if not upload or not upload.filename:
        raise ValueError('Choose a file to upload')
    if maximum is None:
        maximum = 10 if asset_type == 'sound' else 2048
    os.makedirs(directory, exist_ok=True)
    with tempfile.NamedTemporaryFile(delete=False, dir=directory, prefix='.ats-upload-') as temporary:
        temporary_path = temporary.name
    try:
        upload.save(temporary_path)
        if asset_type == 'sound':
            if not upload.filename.lower().endswith('.mp3') or os.path.getsize(temporary_path) > 10 * 1024 * 1024:
                raise ValueError('Sound uploads must be MP3 files no larger than 10 MB')
            audio = MutagenFile(temporary_path)
            duration = getattr(getattr(audio, 'info', None), 'length', None)
            mime_types = getattr(audio, 'mime', []) if audio is not None else []
            if (
                audio is None
                or not isinstance(duration, (int, float))
                or duration <= 0
                or duration > maximum
                or not any(mime == 'audio/mpeg' for mime in mime_types)
            ):
                raise ValueError(f'Sound uploads must be valid MP3 audio no longer than {maximum} seconds')
            return temporary_path, 'mp3'

        extension, width, height = inspect_emoji_file(
            temporary_path,
            max_file_size,
            max_file_size_message,
        )
        if width <= 0 or height <= 0:
            raise ValueError('Image dimensions must be positive')
        if width > maximum or height > maximum:
            raise ValueError(f'{dimension_label} dimensions must not exceed {maximum} by {maximum} pixels')
        return temporary_path, extension
    except Exception:
        if os.path.exists(temporary_path):
            os.remove(temporary_path)
        raise


def connect_admin_asset_address(address_info, timeout, source_address, context, hostname):
    family, socket_type, protocol, _canonical_name, sockaddr = address_info
    asset_socket = socket.socket(family, socket_type, protocol)
    try:
        asset_socket.settimeout(timeout)
        if source_address:
            asset_socket.bind(source_address)
        asset_socket.connect(sockaddr)
        return context.wrap_socket(asset_socket, server_hostname=hostname)
    except OSError:
        asset_socket.close()
        raise


def fetch_admin_asset_url(source_url, asset_type, maximum_bytes=16 * 1024 * 1024):
    if not isinstance(source_url, str) or not source_url.strip():
        raise ValueError('Enter a valid HTTPS asset URL')
    try:
        parsed = urllib.parse.urlsplit(source_url.strip())
        port = parsed.port
    except ValueError as error:
        raise ValueError('Enter a valid HTTPS asset URL') from error
    if (
        parsed.scheme != 'https'
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or port not in (None, 443)
    ):
        raise ValueError('Asset URLs must use HTTPS without credentials or a custom port')
    try:
        resolved_addresses = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
    except (OSError, ValueError) as error:
        raise ValueError('The asset URL host could not be resolved') from error
    if not resolved_addresses or any(
        not ipaddress.ip_address(address[4][0]).is_global
        for address in resolved_addresses
    ):
        raise ValueError('Asset URLs must resolve only to public addresses')

    class PinnedHTTPSConnection(http.client.HTTPSConnection):
        def __init__(self, host, addresses):
            super().__init__(host, port=443, timeout=10)
            self.addresses = addresses

        def connect(self):
            last_error = None
            for address_info in self.addresses:
                try:
                    self.sock = connect_admin_asset_address(
                        address_info,
                        self.timeout,
                        self.source_address,
                        self._context,
                        self.host,
                    )
                    return
                except OSError as error:
                    last_error = error
            if last_error:
                raise last_error
            raise OSError('The asset URL host has no usable address')

    connection = PinnedHTTPSConnection(parsed.hostname, resolved_addresses)
    request_path = parsed.path or '/'
    if parsed.query:
        request_path = f'{request_path}?{parsed.query}'
    try:
        connection.request(
            'GET',
            request_path,
            headers={'User-Agent': 'AnnoyTheStreamer-AssetUpload/1.0'},
        )
        with connection.getresponse() as response:
            if response.status != 200:
                raise ValueError('The asset URL did not return a successful response')
            content = response.read(maximum_bytes + 1)
    except (http.client.HTTPException, TimeoutError, OSError) as error:
        raise ValueError('The asset URL could not be downloaded') from error
    finally:
        connection.close()
    if len(content) > maximum_bytes:
        raise ValueError(f'The asset URL file must be no larger than {maximum_bytes // (1024 * 1024)} MB')

    path_name = os.path.basename(parsed.path)
    if not path_name or '.' not in path_name:
        path_name = 'asset.mp3' if asset_type == 'sound' else 'asset'
    return FileStorage(stream=io.BytesIO(content), filename=path_name)


def save_catalog_price_exception(
    asset_type,
    old_name,
    new_name,
    price=ASSET_PRICE_UNCHANGED,
    play_price=ASSET_PRICE_UNCHANGED,
    old_play_name=ASSET_PRICE_UNCHANGED,
    new_play_name=ASSET_PRICE_UNCHANGED,
):
    pricing = load_point_pricing()
    items = pricing['catalog'][asset_type]['items']
    old_has_exception = old_name in items
    if old_name != new_name and new_name in items and (
        old_has_exception or price not in (None, ASSET_PRICE_UNCHANGED)
    ):
        raise ValueError('An unrelated price exception already uses the new asset name')
    old_price = items.get(old_name)
    if old_name != new_name:
        items.pop(old_name, None)
        if price is ASSET_PRICE_UNCHANGED and old_has_exception:
            items[new_name] = old_price
    if price is None:
        items.pop(new_name, None)
    elif price is not ASSET_PRICE_UNCHANGED:
        items[new_name] = price
    if asset_type == 'sound':
        play_items = pricing['catalog']['sound']['play_items']
        play_old_key = old_name if old_play_name is ASSET_PRICE_UNCHANGED else old_play_name
        play_new_key = new_name if new_play_name is ASSET_PRICE_UNCHANGED else new_play_name
        old_has_play_exception = play_old_key in play_items
        if play_old_key != play_new_key and play_new_key in play_items and (
            old_has_play_exception or play_price not in (None, ASSET_PRICE_UNCHANGED)
        ):
            raise ValueError('An unrelated play-price exception already uses the new sound filename')
        old_play_price = play_items.get(play_old_key)
        if play_old_key != play_new_key:
            play_items.pop(play_old_key, None)
            if play_price is ASSET_PRICE_UNCHANGED and old_has_play_exception:
                play_items[play_new_key] = old_play_price
        if play_price is None:
            play_items.pop(play_new_key, None)
        elif play_price is not ASSET_PRICE_UNCHANGED:
            play_items[play_new_key] = validate_play_price(play_price, 'Sound play price')
    elif play_price is not ASSET_PRICE_UNCHANGED:
        raise ValueError('Play-price exceptions are only supported for sounds')
    normalized = validate_point_pricing(pricing)
    colpricing.update_one(
        {'_id': POINT_PRICING_ID},
        {'$set': {
            'schema_version': 1,
            'pricing': normalized,
            'updated_at': datetime.now(timezone.utc),
        }},
        upsert=True,
    )
    return normalized


def can_use_asset(account, asset_type, asset):
    if not isinstance(account, dict) or not isinstance(asset, dict):
        return False
    if has_permission(account, 'admin_console'):
        return True
    return colassetownership.find_one({
        'user_id': account.get('_id'),
        'asset_type': asset_type,
        'asset_id': asset.get('_id'),
    }) is not None


def upload_limit(pricing, asset_type, is_admin):
    limits = pricing['asset_limits'][asset_type]
    if asset_type == 'emoji':
        return limits['max_px_admin' if is_admin else 'max_px']
    return limits['max_length_admin' if is_admin else 'max_length']


def legacy_emoji_exists(name):
    return any(
        os.path.isfile(os.path.join(EMOJIDIR, f'{name}{extension}'))
        for extension in ('.jpg', '.png', '.gif')
    )


def list_usable_assets(account, asset_type):
    collection = asset_collection(asset_type)
    if has_permission(account, 'admin_console'):
        return list(collection.find({}).sort('name', 1))
    owned_assets = colassetownership.find(
        {'user_id': account['_id'], 'asset_type': asset_type},
        {'asset_id': 1},
    )
    asset_ids = [record['asset_id'] for record in owned_assets if isinstance(record.get('asset_id'), ObjectId)]
    return list(collection.find({'_id': {'$in': asset_ids}}).sort('name', 1)) if asset_ids else []


def serialize_asset(asset, asset_type, pricing):
    name = asset['name']
    price = resolve_catalog_asset_price(asset_type, asset, pricing)
    if asset_type == 'theme':
        image_name = asset.get('background_image_name')
        return {
            'asset_id': str(asset['_id']),
            'name': name,
            'price': price,
            'owned': False,
            'primary_color': asset['primary_color'],
            'panel_color': asset.get('panel_color', '#171717'),
            'accent_color': asset['accent_color'],
            'background_image_exists': asset.get('background_image_exists') is True,
            'background_opacity': asset.get('background_opacity', 0),
            'background_image_name': image_name,
            'url': f"/img/backgrounds/{image_name}" if image_name else '',
            'is_standard': asset.get('is_standard') is True,
        }
    if asset_type == 'sound':
        filename = asset['file']
        return {
            'asset_id': str(asset['_id']),
            'name': name,
            'file': filename,
            'title': asset.get('display_name', name),
            'display_name': asset.get('display_name', name),
            'loudness': asset.get('loudness', 1.0),
            'price': price,
            'url': f"/static/sounds/soundboard/{filename}",
        }
    filename = asset['file']
    return {
        'asset_id': str(asset['_id']),
        'name': name,
        'file': filename,
        'price': price,
        'url': f"/img/emoji/{filename}",
    }


def register_legacy_assets():
    colpricing.update_one(
        {'_id': POINT_PRICING_ID},
        {'$setOnInsert': {
            'schema_version': 1,
            'pricing': copy.deepcopy(DEFAULT_POINT_PRICING),
        }},
        upsert=True,
    )
    load_point_pricing()
    registered = {'sound': 0, 'emoji': 0}

    def register(collection, asset_type, name, asset):
        try:
            validate_price_map({name: 0}, f'{asset_type} item')
        except ValueError:
            logger.error("Skipping legacy %s asset with unsupported name %r", asset_type, name)
            return
        if collection.find_one({'file': asset['file']}):
            return
        if collection.find_one({'name': name}):
            logger.error("Skipping duplicate %s asset name %r from %r", asset_type, name, asset['file'])
            return

        document = {
            '_id': ObjectId(),
            'name': name,
            'pricing_name': name,
            **asset,
        }
        try:
            result = collection.update_one(
                {'file': asset['file']},
                {'$setOnInsert': document},
                upsert=True,
            )
        except DuplicateKeyError:
            if not collection.find_one({'file': asset['file']}):
                raise
            return
        if result.upserted_id is None:
            return
        registered[asset_type] += 1

    if os.path.isdir(SOUNDDIR):
        for filename in sorted(os.listdir(SOUNDDIR)):
            if not filename.lower().endswith('.mp3'):
                continue
            if os.path.basename(filename) != filename:
                logger.error("Skipping unsafe sound filename %r", filename)
                continue
            name = os.path.splitext(filename)[0]
            display_name = name
            try:
                audio = MutagenFile(os.path.join(SOUNDDIR, filename), easy=True)
                if audio and audio.get('title'):
                    display_name = str(audio['title'][0]).strip() or name
            except Exception:
                logger.warning("Could not read title metadata for sound %s", filename, exc_info=True)
            register(colsounds, 'sound', name, {
                'display_name': display_name,
                'loudness': 1.0,
                'file': filename,
            })

    if os.path.isdir(EMOJIDIR):
        for filename in sorted(os.listdir(EMOJIDIR)):
            if not filename.lower().endswith(('.jpg', '.png', '.gif')):
                continue
            if os.path.basename(filename) != filename:
                logger.error("Skipping unsafe emoji filename %r", filename)
                continue
            name = os.path.splitext(filename)[0]
            register(colemojis, 'emoji', name, {'file': filename})

    return registered


def register_default_themes():
    for theme in DEFAULT_THEMES:
        colthemes.update_one(
            {'_id': theme['_id']},
            {'$setOnInsert': copy.deepcopy(theme)},
            upsert=True,
        )
        colthemes.update_one(
            {'_id': theme['_id']},
            {'$set': {
                'primary_color': theme['primary_color'],
                'panel_color': theme['panel_color'],
                'accent_color': theme['accent_color'],
            }},
        )
    sync_theme_price_fields(load_point_pricing())


def list_shop_assets(account):
    pricing = load_point_pricing()
    assets = {}
    status_order = {'available': 0, 'owned': 1, 'unavailable': 2}
    for asset_type in ('emoji', 'sound', 'theme'):
        collection = asset_collection(asset_type)
        owned_ids = {
            ownership['asset_id']
            for ownership in colassetownership.find(
                {'user_id': account['_id'], 'asset_type': asset_type},
                {'asset_id': 1},
            )
            if isinstance(ownership.get('asset_id'), ObjectId)
        }
        assets[asset_type] = []
        for asset in collection.find({}).sort('name', 1):
            if asset.get('proposal_state') == 'processing':
                continue
            item = serialize_asset(asset, asset_type, pricing)
            owned = (
                asset.get('is_standard') is True
                or asset['_id'] in owned_ids
                or has_permission(account, 'admin_console')
            )
            unavailable = item['price'] == -1 or asset.get('exclusive') is True
            if asset.get('exclusive') is True:
                item['price'] = -1
            item.update({
                'owned': owned,
                'status': 'owned' if owned else ('unavailable' if unavailable else 'available'),
            })
            assets[asset_type].append(item)
        assets[asset_type].sort(key=lambda item: (
            status_order[item['status']],
            item['name'].casefold(),
            item['name'],
        ))
    return assets


def ensure_asset_ownership(ownership):
    try:
        colassetownership.insert_one(dict(ownership))
    except DuplicateKeyError:
        if not colassetownership.find_one(ownership):
            raise


def broadcast_proposed_asset(asset_type, asset, socketio):
    if not socketio:
        return
    socketio.emit('asset_catalog_changed', {'asset_type': asset_type})
    if asset_type == 'emoji':
        emoji_name = asset['name']
        colchat.update_many(
            {'literal_emojis': emoji_name},
            {'$pull': {'literal_emojis': emoji_name}},
        )
        for message in lastmessages:
            if emoji_name in message.get('literal_emojis', []):
                message['literal_emojis'] = [
                    name for name in message['literal_emojis']
                    if name != emoji_name
                ]
        socketio.emit('chat_history', add_current_ranks(list(lastmessages)))


def purchase_catalog_asset(account, asset_type, asset_id, request_id, expected_price=None, socketio=None):
    if not isinstance(account, dict) or not isinstance(account.get('_id'), ObjectId):
        return {'status': 'error', 'message': 'Login required'}, 401
    if has_permission(account, 'admin_console'):
        return {'status': 'error', 'message': 'Admins already have access to all assets'}, 403
    if asset_type not in {'sound', 'emoji', 'theme'}:
        return {'status': 'error', 'message': 'Unsupported asset type'}, 400
    request_id = normalize_request_id(request_id)
    if not request_id:
        return {'status': 'error', 'message': 'A valid purchase request ID is required'}, 400
    if expected_price is not None and (
        isinstance(expected_price, bool)
        or not isinstance(expected_price, int)
        or expected_price < 0
    ):
        return {'status': 'error', 'message': 'Expected price must be a non-negative whole number'}, 400
    try:
        asset_id = ObjectId(asset_id)
    except Exception:
        return {'status': 'error', 'message': 'Asset not found'}, 404

    user_id = account['_id']
    identity = {'user_id': user_id, 'asset_type': asset_type, 'asset_id': asset_id}
    asset = asset_collection(asset_type).find_one({'_id': asset_id})
    if not asset:
        return {'status': 'error', 'message': 'Asset not found'}, 404

    request_purchase = colshoppurchases.find_one({
        'user_id': user_id,
        'request_id': request_id,
    })
    if request_purchase and (
        request_purchase.get('asset_type') != asset_type
        or request_purchase.get('asset_id') != asset_id
    ):
        return {
            'status': 'error',
            'code': 'request_id_conflict',
            'message': 'This request ID belongs to a different purchase.',
        }, 409

    purchase = request_purchase or colshoppurchases.find_one(identity)
    if colassetownership.find_one(identity):
        current_user = colusers.find_one({'_id': user_id}) or account
        if purchase and (
            purchase.get('state') in {'reserved', 'charging', 'debited'}
            or (
                purchase.get('state') == 'completed'
                and current_user.get('pending_point_operation') == f"shop-purchase:{purchase['_id']}"
            )
        ):
            return _finish_catalog_purchase(purchase, account, socketio)
        return {
            'status': 'ok',
            'owned': True,
            'duplicate': True,
            'points': current_user.get('points', 0),
        }, 200

    if purchase and purchase.get('state') == 'completed':
        return _finish_catalog_purchase(purchase, account, socketio)
    if purchase and purchase.get('state') in {'reserved', 'debited'}:
        return _finish_catalog_purchase(purchase, account, socketio)
    try:
        pricing = load_point_pricing()
        price = resolve_catalog_asset_price(asset_type, asset, pricing)
    except ValueError as error:
        return {'status': 'error', 'message': str(error)}, 503
    if price == -1:
        return {
            'status': 'error',
            'code': 'asset_unavailable',
            'message': 'This asset is currently unavailable for purchase.',
        }, 403
    if expected_price is not None and expected_price != price:
        return {
            'status': 'error',
            'code': 'price_changed',
            'price': price,
            'message': 'The price changed. Review the updated price before buying.',
        }, 409

    if purchase and purchase.get('state') == 'rejected':
        try:
            colshoppurchases.update_one(
                {'_id': purchase['_id'], 'state': 'rejected'},
                {'$set': {
                    'request_id': request_id,
                    'price': price,
                    'state': 'reserved',
                    'failure': None,
                    'updated_at': datetime.now(timezone.utc),
                }},
            )
        except DuplicateKeyError:
            return {
                'status': 'error',
                'code': 'request_id_conflict',
                'message': 'This request ID belongs to a different purchase.',
            }, 409
        purchase = colshoppurchases.find_one({'_id': purchase['_id']})
        if not purchase or purchase.get('request_id') != request_id:
            return {'status': 'error', 'message': 'Purchase could not be reserved'}, 503
    elif not purchase:
        purchase = {
            **identity,
            'request_id': request_id,
            'price': price,
            'state': 'reserved',
            'created_at': datetime.now(timezone.utc),
        }
        try:
            colshoppurchases.insert_one(purchase)
            purchase = colshoppurchases.find_one({
                'user_id': user_id,
                'request_id': request_id,
            })
        except DuplicateKeyError:
            request_purchase = colshoppurchases.find_one({
                'user_id': user_id,
                'request_id': request_id,
            })
            if request_purchase and (
                request_purchase.get('asset_type') != asset_type
                or request_purchase.get('asset_id') != asset_id
            ):
                return {
                    'status': 'error',
                    'code': 'request_id_conflict',
                    'message': 'This request ID belongs to a different purchase.',
                }, 409
            purchase = request_purchase or colshoppurchases.find_one(identity)
            if not purchase:
                raise

    if not purchase:
        return {'status': 'error', 'message': 'Purchase could not be reserved'}, 503
    return _finish_catalog_purchase(purchase, account, socketio)


def _finish_catalog_purchase(purchase, account, socketio=None):
    user_id = account['_id']
    purchase_id = str(purchase['_id'])
    operation_id = f'shop-purchase:{purchase_id}'
    price = purchase['price']
    if isinstance(price, bool) or not isinstance(price, int) or price < 0:
        logger.error("Invalid stored shop purchase price for purchase %s", purchase_id)
        return {'status': 'error', 'message': 'Purchase could not be confirmed'}, 503

    current_user = colusers.find_one({'_id': user_id})
    if not current_user:
        return {'status': 'error', 'message': 'Account could not be loaded'}, 401
    if purchase.get('state') == 'completed' and current_user.get('pending_point_operation') != operation_id:
        ensure_asset_ownership({
            'user_id': user_id,
            'asset_type': purchase['asset_type'],
            'asset_id': purchase['asset_id'],
        })
        return {
            'status': 'ok',
            'owned': True,
            'duplicate': True,
            'points': current_user.get('points', 0),
        }, 200

    debited_user = None
    if price:
        if purchase.get('state') == 'reserved':
            colshoppurchases.update_one(
                {'_id': purchase['_id'], 'state': 'reserved'},
                {'$set': {
                    'state': 'charging',
                    'updated_at': datetime.now(timezone.utc),
                }},
            )
            purchase = colshoppurchases.find_one({'_id': purchase['_id']}) or purchase
            current_user = colusers.find_one({'_id': user_id}) or current_user
            if purchase.get('state') == 'completed' and current_user.get('pending_point_operation') != operation_id:
                return {
                    'status': 'ok',
                    'owned': True,
                    'duplicate': True,
                    'points': current_user.get('points', 0),
                }, 200
        if purchase_id in current_user.get('shop_purchase_ids', []):
            debited_user = current_user
        else:
            if current_user.get('pending_point_operation'):
                return {
                    'status': 'error',
                    'message': 'A previous point action is still being processed. Retry this purchase in a moment.',
                    'points': current_user.get('points', 0),
                }, 409
            if purchase.get('state') == 'debited':
                logger.error("Shop purchase %s lost its pending point operation", purchase_id)
                return {'status': 'error', 'message': 'Purchase could not be confirmed'}, 503
            debited_user = colusers.find_one_and_update(
                {
                    '_id': user_id,
                    '$expr': {'$gte': [{'$ifNull': ['$points', 0]}, price]},
                    'shop_purchase_ids': {'$ne': purchase_id},
                    '$or': [
                        {'pending_point_operation': {'$exists': False}},
                        {'pending_point_operation': None},
                    ],
                },
                {
                    '$inc': {'points': -price},
                    '$set': {'pending_point_operation': operation_id},
                    '$addToSet': {'shop_purchase_ids': purchase_id},
                },
                return_document=ReturnDocument.AFTER,
            )
            if not debited_user:
                current_user = colusers.find_one({'_id': user_id})
                if not current_user:
                    return {'status': 'error', 'message': 'Account could not be loaded'}, 401
                if purchase_id in current_user.get('shop_purchase_ids', []):
                    debited_user = current_user
                elif current_user.get('pending_point_operation'):
                    return {
                        'status': 'error',
                        'message': 'A previous point action is still being processed. Retry this purchase in a moment.',
                        'points': current_user.get('points', 0),
                    }, 409
                else:
                    colshoppurchases.update_one(
                        {'_id': purchase['_id'], 'state': {'$in': ['reserved', 'charging']}},
                        {'$set': {
                            'state': 'rejected',
                            'failure': 'insufficient_points',
                            'updated_at': datetime.now(timezone.utc),
                        }},
                    )
                    balance = current_user.get('points', 0)
                    return {
                        'status': 'error',
                        'code': 'insufficient_points',
                        'message': f"This asset costs {price} points. You have {balance} points.",
                        'points': balance,
                    }, 402

        if purchase.get('state') in {'reserved', 'charging'}:
            balance_after = (
                debited_user.get('points', 0)
                if debited_user
                else current_user.get('points', 0)
            )
            colshoppurchases.update_one(
                {'_id': purchase['_id'], 'state': {'$in': ['reserved', 'charging']}},
                {'$set': {
                    'state': 'debited',
                    'balance_after': balance_after,
                    'updated_at': datetime.now(timezone.utc),
                }},
            )
            purchase = colshoppurchases.find_one({'_id': purchase['_id']}) or purchase

    ownership = {
        'user_id': user_id,
        'asset_type': purchase['asset_type'],
        'asset_id': purchase['asset_id'],
    }
    try:
        ensure_asset_ownership(ownership)
    except Exception:
        logger.exception("Could not grant asset ownership for shop purchase %s", purchase_id)
        return {'status': 'error', 'message': 'Purchase is being finalized; retry shortly.'}, 503

    colshoppurchases.update_one(
        {'_id': purchase['_id'], 'state': {'$in': ['reserved', 'debited', 'completed']}},
        {'$set': {
            'state': 'completed',
            'completed_at': datetime.now(timezone.utc),
            'updated_at': datetime.now(timezone.utc),
        }},
    )
    completed_purchase = colshoppurchases.find_one({'_id': purchase['_id']})
    if not completed_purchase or completed_purchase.get('state') != 'completed':
        logger.error("Could not finalize shop purchase %s", purchase_id)
        return {'status': 'error', 'message': 'Purchase is being finalized; retry shortly.'}, 503
    purchase = completed_purchase

    if price:
        try:
            record_point_transaction(
                user_id,
                str(uuid.uuid5(uuid.NAMESPACE_URL, f"shop-purchase:{purchase_id}")),
                'shop_purchase',
                -price,
                purchase.get('balance_after', current_user.get('points', 0) - price),
                asset_type=purchase['asset_type'],
                asset_id=str(purchase['asset_id']),
                purchase_id=purchase_id,
            )
        except Exception:
            logger.exception("Could not record point ledger entry for shop purchase %s", purchase_id)
            return {'status': 'error', 'message': 'Purchase is being finalized; retry shortly.'}, 503
        _clear_pending_point_operation(user_id, operation_id)

    current_user = colusers.find_one({'_id': user_id}) or current_user
    if debited_user and socketio:
        try:
            emit_points_changed(socketio, current_user)
        except Exception:
            logger.exception("Shop purchase point notification failed for %s", user_id)
    return {
        'status': 'ok',
        'owned': True,
        'duplicate': False,
        'points': current_user.get('points', 0),
    }, 200


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


def get_action_cost(action, account, sound_asset=None, pricing=None):
    profile = role_permissions(account)
    capabilities = profile.get('capabilities', {}) if profile else {}
    free_actions = capabilities.get('free_actions')
    if isinstance(free_actions, list) and action in free_actions:
        return 0
    settings = pricing if pricing is not None else load_point_pricing()
    cost = (
        resolve_sound_play_price(sound_asset, settings)
        if action == 'soundmeme' and sound_asset is not None
        else settings['send_your_chaos'][action]
    )
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


def accept_paid_action(
    action_collection,
    account,
    request_id,
    document,
    socketio=None,
    point_cost_override=None,
):
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
        cost = (
            point_cost_override
            if point_cost_override is not None
            else get_action_cost(document['action_type'], account)
        )
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
        cost = (
            point_cost_override
            if point_cost_override is not None
            else get_action_cost(existing['action_type'], account)
        )
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
    usernames = {
        message.get('user')
        for message in messages
        if message.get('system') is not True and message.get('user')
    }
    users = {
        user['username']: user
        for user in colusers.find(
            {'username': {'$in': list(usernames)}},
            {'username': 1, 'rank': 1, 'visible_badge_id': 1},
        )
    }
    rank_colors = {
        rank['rank'].casefold(): rank.get('color')
        for rank in colranks.find({}, {'rank': 1, 'color': 1})
    }
    enriched = []
    for message in messages:
        if message.get('system') is True:
            enriched.append({
                key: value
                for key, value in message.items()
                if key not in {'rank', 'rank_color'}
            })
            continue

        user = users.get(message.get('user'))
        rank = user.get('rank', 'User') if user else None
        badge = None
        if user and user.get('visible_badge_id') is not None:
            try:
                badge_id = user['visible_badge_id']
                badge_id = badge_id if isinstance(badge_id, ObjectId) else ObjectId(str(badge_id))
                badge = serialize_badge(colbadges.find_one({'_id': badge_id}))
            except Exception:
                badge = None
        enriched_message = {
            **message,
            'rank': rank,
            'rank_color': rank_colors.get(rank.casefold()) if rank else None,
        }
        if badge:
            enriched_message['badge'] = badge
        else:
            enriched_message.pop('badge', None)
        enriched.append(enriched_message)
    return enriched


def emit_chat_activity(socketio, message, actor=None):
    if not isinstance(message, str) or not message.strip():
        raise ValueError('Chat activity message must not be empty')
    if actor is not None and (not isinstance(actor, str) or not actor.strip()):
        raise ValueError('Chat activity actor must be a non-empty username')

    activity = {
        'system': True,
        'message': message.strip(),
        'timestamp': datetime.now(timezone.utc),
    }
    if actor is not None:
        activity['actor'] = actor

    try:
        colchat.insert_one(activity)
    except Exception:
        logger.exception('Could not persist chat activity')
        return False

    public_activity = {
        key: activity[key]
        for key in ('system', 'actor', 'message')
        if key in activity
    }
    lastmessages.append(public_activity)
    if socketio:
        try:
            socketio.emit('chat_message', public_activity)
        except Exception:
            logger.exception('Could not broadcast chat activity')
    return True


def moderation_activity_prefix(actor):
    if not isinstance(actor, dict) or has_permission(actor, 'admin_console'):
        return ''
    role = find_role(actor.get('rank'))
    if not role or role.get('staff') is not True:
        return ''
    username = actor.get('username')
    return f'{username} ' if isinstance(username, str) and username else ''


try:
    msgs = list(colchat.find().sort('timestamp', -1).limit(MAX_MESSAGES))
    msgs.reverse()
    for m in msgs:
        if m.get('system') is True:
            message = {'system': True, 'message': m['message']}
            if isinstance(m.get('actor'), str):
                message['actor'] = m['actor']
        else:
            message = {'user': m['user'], 'message': m['message']}
            for key in ('literal_emojis', 'rank', 'rank_color'):
                if key in m:
                    message[key] = m[key]
        lastmessages.append(message)
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
        asset_id = data.get('asset_id')
        sound_name = data.get('file')
        if not request_id:
            return {'status': 'error', 'message': 'A valid request ID is required'}
        if isinstance(asset_id, str) and ObjectId.is_valid(asset_id):
            asset = colsounds.find_one({'_id': ObjectId(asset_id)})
        else:
            if (
                not isinstance(sound_name, str)
                or not sound_name
                or os.path.basename(sound_name) != sound_name
            ):
                return {'status': 'error', 'message': 'Select a valid sound'}
            asset_name = os.path.splitext(sound_name)[0]
            asset = colsounds.find_one({'name': asset_name})
        if not asset:
            return {'status': 'error', 'message': 'Sound is no longer available'}
        if not can_use_asset(account, 'sound', asset):
            return {
                'status': 'error',
                'code': 'asset_not_owned',
                'message': 'You do not own this sound',
                'points': account.get('points', 0),
            }
        filename = asset.get('file')
        if (
            not isinstance(filename, str)
            or os.path.basename(filename) != filename
            or not filename.lower().endswith('.mp3')
        ):
            return {'status': 'error', 'message': 'This sound format is not supported'}
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
            point_cost_override=get_action_cost(
                'soundmeme',
                account,
                sound_asset=asset,
            ),
        )
        if status != 200 or result.get('duplicate'):
            return result
        try:
            socketio.emit(
                'playsound',
                {
                    'file': os.path.splitext(filename)[0],
                    'loudness': asset.get('loudness', 1.0),
                },
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
            literal_emojis = []
            for emoji_name in set(re.findall(r':(\w+):', message)):
                emoji = colemojis.find_one({'name': emoji_name})
                is_unregistered_asset = emoji is None and legacy_emoji_exists(emoji_name)
                if (
                    (emoji and not can_use_asset(account, 'emoji', emoji))
                    or (is_unregistered_asset and not has_permission(account, 'admin_console'))
                ):
                    literal_emojis.append(emoji_name)
            rank = account.get('rank', 'User')
            color = get_rank_color(rank)
            badge = None
            if account.get('visible_badge_id') is not None:
                try:
                    badge_id = account['visible_badge_id']
                    badge_id = badge_id if isinstance(badge_id, ObjectId) else ObjectId(str(badge_id))
                    badge = serialize_badge(colbadges.find_one({'_id': badge_id}))
                except Exception:
                    badge = None
            msgobj = {
                'user': user,
                'message': message,
                'literal_emojis': literal_emojis,
                'rank': rank,
                'rank_color': color,
                'timestamp': datetime.now(timezone.utc)
            }
            if badge:
                msgobj['badge'] = badge
            try:
                colchat.insert_one(msgobj)
                public_message = {
                    'user': user,
                    'message': message,
                    'literal_emojis': literal_emojis,
                    'rank': rank,
                    'rank_color': color,
                }
                if badge:
                    public_message['badge'] = badge
                lastmessages.append(public_message)
                socketio.emit('chat_message', {
                    'user': user,
                    'message': message,
                    'literal_emojis': literal_emojis,
                    'rank': rank,
                    'rank_color': color,
                    **({'badge': badge} if badge else {}),
                })
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
        was_streaming = bool(previous_state and previous_state.get('streaming') is True)
        if was_streaming != state['streaming']:
            emit_chat_activity(
                socketio,
                'Stream started.' if state['streaming'] else 'Stream finished.',
            )
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

    def complete_authentication(user):
        session.clear()
        session['user_id'] = str(user['_id'])
        permissions = public_role_permissions(user)
        capabilities = permissions.get('capabilities', {}) if permissions else {}
        if capabilities.get('panel_access') is True:
            session['admin_user_id'] = str(user['_id'])
        return {
            'status': 'ok',
            'username': user['username'],
            'rank': user.get('rank', 'User'),
            'points': user.get('points', 0),
            'permissions': permissions,
            **public_usage_cost_fields(user),
        }

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
        is_registration = (
            data.get('intent') == 'register'
            or ('email' in data and 'confirmation' in data)
        )
        if (
            user
            and user.get('password_reset_token_hash')
            and user.get('password_reset_token_type', 'password') == 'password'
            and not (
                user.get('password_reset_self_service') is True
                and user.get('password_hash')
            )
        ):
            return jsonify({'message': 'Incorrect username or password'}), 401
        if not is_registration and (not user or not user.get('password_hash')):
            return jsonify({'message': 'Incorrect username or password'}), 401
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
                stream_state = colsettings.find_one({'_id': 'stream_points'})
                started_at = stream_state.get('stream_started_at') if stream_state else None
                if stream_state and stream_state.get('streaming') is True and isinstance(started_at, datetime):
                    if started_at.tzinfo is None:
                        started_at = started_at.replace(tzinfo=timezone.utc)
                    interval = max(0, int((datetime.now(timezone.utc) - started_at).total_seconds() // 60))
                    document['last_stream_award_started_at'] = started_at
                    document['last_stream_award_interval'] = interval
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
        return jsonify(complete_authentication(user))

    @app.route('/auth/password-reset', methods=['POST'])
    def authpasswordreset():
        data = request.get_json(silent=True) or {}
        reset_token = data.get('reset_token')
        password = data.get('password')
        confirmation = data.get('confirmation')
        action = data.get('action')
        if action not in (None, 'verify'):
            return jsonify({'message': 'Invalid account recovery request'}), 400
        verification_only = action == 'verify'
        if not isinstance(reset_token, str) or not reset_token or len(reset_token) > 256:
            return jsonify({'message': 'Invalid or expired account recovery code'}), 401

        token_lookup = hashlib.sha256(reset_token.encode('utf-8')).hexdigest()
        user = colusers.find_one({'password_reset_token_lookup': token_lookup})
        if user is None:
            for candidate in colusers.find({
                'password_hash': None,
                'password_reset_token_hash': {'$exists': True},
            }):
                candidate_hash = candidate.get('password_reset_token_hash')
                if isinstance(candidate_hash, str) and check_password_hash(candidate_hash, reset_token):
                    user = candidate
                    break
        recovery_type = user.get('password_reset_token_type', 'password') if user else None
        token_hash = user.get('password_reset_token_hash') if user else None
        expires_at = user.get('password_reset_token_expires_at') if user else None
        self_service_reset = bool(
            user
            and user.get('password_reset_self_service') is True
            and user.get('password_hash')
        )
        if isinstance(expires_at, datetime) and expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if (
            not user
            or recovery_type not in ('password', 'email')
            or recovery_type == 'password'
            and bool(user.get('password_hash')) != self_service_reset
            or not isinstance(token_hash, str)
            or not isinstance(expires_at, datetime)
            or expires_at <= datetime.now(timezone.utc)
            or not check_password_hash(token_hash, reset_token)
        ):
            return jsonify({'message': 'Invalid or expired account recovery code'}), 401

        if verification_only:
            return jsonify({
                'status': 'verified',
                'username': user['username'],
                'recovery_type': recovery_type,
            })

        if recovery_type == 'password':
            if (
                not isinstance(password, str)
                or len(password) < 8
                or len(password) > 256
                or password != confirmation
                or 'email' in data
            ):
                return jsonify({'message': 'Enter matching passwords of at least 8 characters'}), 400
            update_fields = {'$set': {'password_hash': generate_password_hash(password)}}
        else:
            email = normalize_email(data.get('email'))
            if email is None or password is not None or confirmation is not None:
                return jsonify({'message': 'Enter a valid email address'}), 400
            existing_email = colusers.find_one({'email': email})
            if existing_email and existing_email.get('_id') != user['_id']:
                return jsonify({'message': 'That email address is already in use'}), 409
            update_fields = {'$set': {'email': email}}

        reset_query = {
            '_id': user['_id'],
            'password_reset_token_hash': token_hash,
            'password_reset_token_expires_at': user['password_reset_token_expires_at'],
        }
        if recovery_type == 'password':
            reset_query['password_hash'] = (
                user.get('password_hash')
                if self_service_reset
                else None
            )
        if 'password_reset_token_type' in user:
            reset_query['password_reset_token_type'] = recovery_type
        if user.get('password_reset_token_lookup'):
            reset_query['password_reset_token_lookup'] = token_lookup
        changed = colusers.update_one(
            reset_query,
            {
                **update_fields,
                '$unset': {
                    'password_reset_token_hash': '',
                    'password_reset_token_lookup': '',
                    'password_reset_token_expires_at': '',
                    'password_reset_token_type': '',
                    'password_reset_self_service': '',
                },
            },
        )
        if changed.matched_count != 1:
            return jsonify({'message': 'Invalid or expired account recovery code'}), 401

        session.clear()
        return jsonify({'status': 'updated'})

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
            sync_theme_price_fields(pricing)
        except Exception:
            logger.exception('Could not save point pricing')
            return jsonify({'message': 'Pricing could not be saved'}), 503
        if socketio:
            socketio.emit('usage_costs_changed')
        emit_chat_activity(socketio, 'Point Shop pricing was updated.')
        return jsonify({'pricing': pricing})

    @app.route('/admin/themes', methods=['GET', 'POST'])
    @require_login
    def adminthemes():
        if not get_admin_user('admin_console'):
            return jsonify({'message': 'Admin login required'}), 403
        try:
            pricing = load_point_pricing()
            if request.method == 'GET':
                themes = []
                for theme in colthemes.find({}).sort('name', 1):
                    item = serialize_asset(theme, 'theme', pricing)
                    item['price_overridden'] = (
                        str(theme['_id']) in pricing['catalog']['theme']['items']
                    )
                    themes.append(item)
                return jsonify({'themes': themes})

            if (
                request.content_length
                and request.content_length > MAX_THEME_BACKGROUND_REQUEST_BYTES
            ):
                return jsonify({'message': 'Theme backgrounds must be no larger than 50 MB'}), 413
            data = request.form
            name = data.get('name', '').strip()
            if not name or len(name) > 80 or any(ord(character) < 32 for character in name):
                raise ValueError('Theme name must be 1 to 80 characters')
            name_key = name.casefold()
            primary_color = normalize_theme_color(data.get('primary_color'), 'Background color')
            panel_color = normalize_theme_color(data.get('panel_color', '#171717'), 'Panel color')
            accent_color = normalize_theme_color(data.get('accent_color'), 'Accent color')
            upload = request.files.get('background')
            source_url = data.get('background_url', '').strip()
            if upload and source_url:
                raise ValueError('Choose a background file or enter a URL, not both')
            if source_url:
                upload = fetch_admin_asset_url(
                    source_url,
                    'emoji',
                    maximum_bytes=MAX_THEME_BACKGROUND_BYTES,
                )

            background_opacity = 0.0
            temporary_path = None
            destination = None
            background_name = None
            if upload:
                try:
                    background_opacity = float(data.get('background_opacity', ''))
                except (TypeError, ValueError) as error:
                    raise ValueError('Background opacity must be between 0 and 1') from error
                if not math.isfinite(background_opacity) or not 0 <= background_opacity <= 1:
                    raise ValueError('Background opacity must be between 0 and 1')

            price_override = parse_asset_price(data.get('price'))
            theme_id = ObjectId()
            if upload:
                background_directory = os.path.join(PUBLIC_DIR, 'img', 'backgrounds')
                temporary_path, extension = validate_uploaded_asset(
                    upload,
                    'emoji',
                    background_directory,
                    maximum=8192,
                    max_file_size=MAX_THEME_BACKGROUND_BYTES,
                    max_file_size_message='Theme backgrounds must be no larger than 50 MB',
                    dimension_label='Theme background',
                )
                background_name = f'{normalize_asset_name(name)}.{extension}'
                destination = os.path.join(background_directory, background_name)
                if colthemes.find_one({'background_image_name': background_name}):
                    return jsonify({'message': 'A background with this normalized theme name already exists'}), 409
                try:
                    os.link(temporary_path, destination)
                except FileExistsError as error:
                    return jsonify({'message': 'A background with this normalized theme name already exists'}), 409

            theme = {
                '_id': theme_id,
                'name': name,
                'name_key': name_key,
                'price': (
                    price_override
                    if price_override is not None
                    else pricing['catalog']['theme']['default']
                ),
                'price_overridden': price_override is not None,
                'primary_color': primary_color,
                'panel_color': panel_color,
                'accent_color': accent_color,
                'background_image_exists': background_name is not None,
                'background_opacity': background_opacity,
                'background_image_name': background_name,
                'is_standard': False,
                'created_at': datetime.now(timezone.utc),
            }
            try:
                colthemes.insert_one(theme)
                if price_override is not None:
                    pricing['catalog']['theme']['items'][str(theme_id)] = price_override
                    normalized_pricing = validate_point_pricing(pricing)
                    colpricing.update_one(
                        {'_id': POINT_PRICING_ID},
                        {'$set': {
                            'schema_version': 1,
                            'pricing': normalized_pricing,
                            'updated_at': datetime.now(timezone.utc),
                        }},
                        upsert=True,
                    )
                    sync_theme_price_fields(normalized_pricing)
            except DuplicateKeyError:
                colthemes.delete_one({'_id': theme_id})
                if destination and os.path.exists(destination):
                    os.remove(destination)
                return jsonify({'message': 'A theme with this name already exists'}), 409
            except Exception:
                colthemes.delete_one({'_id': theme_id})
                if destination and os.path.exists(destination):
                    os.remove(destination)
                raise

            if socketio:
                socketio.emit('usage_costs_changed')
                socketio.emit('asset_catalog_changed', {'asset_type': 'theme'})
            emit_chat_activity(socketio, f'Added theme: {name}.')
            return jsonify({
                'theme': serialize_asset(theme, 'theme', pricing),
                'price_overridden': price_override is not None,
            }), 201
        except ValueError as error:
            return jsonify({'message': str(error)}), 400
        except Exception:
            logger.exception('Could not administer themes')
            return jsonify({'message': 'Theme could not be saved'}), 503
        finally:
            if request.method == 'POST' and 'temporary_path' in locals() and temporary_path:
                if os.path.exists(temporary_path):
                    os.remove(temporary_path)

    @app.route('/admin/themes/<theme_id>', methods=['PATCH', 'DELETE'])
    @require_login
    def admintheme(theme_id):
        if not get_admin_user('admin_console'):
            return jsonify({'message': 'Admin login required'}), 403
        if not ObjectId.is_valid(theme_id):
            return jsonify({'message': 'Theme not found'}), 404

        theme_oid = ObjectId(theme_id)
        existing = colthemes.find_one({'_id': theme_oid})
        if not existing:
            return jsonify({'message': 'Theme not found'}), 404

        if request.method == 'DELETE':
            if existing.get('is_standard') is True:
                return jsonify({'message': 'The Standard theme cannot be removed'}), 400
            try:
                pricing = load_point_pricing()
                original_pricing = copy.deepcopy(pricing)
                pricing['catalog']['theme']['items'].pop(str(theme_oid), None)
                normalized_pricing = validate_point_pricing(pricing)
                background_name = existing.get('background_image_name')
                if background_name and os.path.basename(background_name) != background_name:
                    return jsonify({'message': 'Stored theme background metadata is invalid'}), 503
                background_path = (
                    os.path.join(PUBLIC_DIR, 'img', 'backgrounds', background_name)
                    if background_name
                    else None
                )
                staged_path = None
                if background_path and os.path.isfile(background_path):
                    staged_path = os.path.join(
                        os.path.dirname(background_path),
                        f'.ats-remove-{uuid.uuid4().hex}',
                    )
                    os.replace(background_path, staged_path)

                try:
                    colpricing.update_one(
                        {'_id': POINT_PRICING_ID},
                        {'$set': {
                            'schema_version': 1,
                            'pricing': normalized_pricing,
                            'updated_at': datetime.now(timezone.utc),
                        }},
                        upsert=True,
                    )
                    deleted = colthemes.delete_one({'_id': theme_oid})
                    if not getattr(deleted, 'deleted_count', 1):
                        raise RuntimeError('Theme could not be removed')
                except Exception:
                    colthemes.update_one(
                        {'_id': theme_oid},
                        {'$set': {key: value for key, value in existing.items() if key != '_id'}},
                        upsert=True,
                    )
                    colpricing.update_one(
                        {'_id': POINT_PRICING_ID},
                        {'$set': {
                            'schema_version': 1,
                            'pricing': original_pricing,
                            'updated_at': datetime.now(timezone.utc),
                        }},
                        upsert=True,
                    )
                    if staged_path and os.path.exists(staged_path):
                        os.replace(staged_path, background_path)
                    raise

                colassetownership.delete_many({
                    'asset_type': 'theme',
                    'asset_id': theme_oid,
                })
                colusers.update_many(
                    {'theme_id': str(theme_oid)},
                    {'$set': {'theme_id': str(STANDARD_THEME_ID)}},
                )
                if staged_path and os.path.exists(staged_path):
                    try:
                        os.remove(staged_path)
                    except OSError:
                        logger.warning("Could not remove deleted theme background %s", staged_path)
                sync_theme_price_fields(normalized_pricing)
                if socketio:
                    socketio.emit('usage_costs_changed')
                    socketio.emit('asset_catalog_changed', {'asset_type': 'theme'})
                emit_chat_activity(socketio, f"Removed theme: {existing.get('name', theme_id)}.")
                return jsonify({'status': 'ok'})
            except Exception:
                logger.exception("Could not remove theme %s", theme_id)
                return jsonify({'message': 'Theme could not be removed'}), 503

        temporary_path = None
        destination = None
        committed = False
        old_background_path = None
        background_changed = False
        created_destination = False
        backup_path = None
        try:
            if (
                request.content_length
                and request.content_length > MAX_THEME_BACKGROUND_REQUEST_BYTES
            ):
                return jsonify({'message': 'Theme backgrounds must be no larger than 50 MB'}), 413
            data = request.form
            name = data.get('name', '').strip()
            if not name or len(name) > 80 or any(ord(character) < 32 for character in name):
                raise ValueError('Theme name must be 1 to 80 characters')
            name_key = name.casefold()
            if colthemes.find_one({'name_key': name_key, '_id': {'$ne': theme_oid}}):
                return jsonify({'message': 'A theme with this name already exists'}), 409

            primary_color = normalize_theme_color(data.get('primary_color'), 'Background color')
            panel_color = normalize_theme_color(
                data.get('panel_color', existing.get('panel_color', '#171717')),
                'Panel color',
            )
            accent_color = normalize_theme_color(data.get('accent_color'), 'Accent color')
            upload = request.files.get('background')
            source_url = data.get('background_url', '').strip()
            remove_background = data.get('remove_background') == 'true'
            if upload and source_url:
                raise ValueError('Choose a background file or URL')
            if remove_background and (upload or source_url):
                raise ValueError('Choose a new background or remove the current one')
            if source_url:
                upload = fetch_admin_asset_url(
                    source_url,
                    'emoji',
                    maximum_bytes=MAX_THEME_BACKGROUND_BYTES,
                )

            background_name = existing.get('background_image_name')
            background_exists = existing.get('background_image_exists') is True
            opacity = existing.get('background_opacity', 0.0)
            old_name = existing.get('background_image_name')
            if old_name and os.path.basename(old_name) != old_name:
                raise ValueError('Stored theme background metadata is invalid')
            if old_name:
                old_background_path = os.path.join(PUBLIC_DIR, 'img', 'backgrounds', old_name)

            if upload:
                background_changed = True
                try:
                    opacity = float(data.get('background_opacity', ''))
                except (TypeError, ValueError) as error:
                    raise ValueError('Background opacity must be between 0 and 1') from error
                if not math.isfinite(opacity) or not 0 <= opacity <= 1:
                    raise ValueError('Background opacity must be between 0 and 1')
                background_directory = os.path.join(PUBLIC_DIR, 'img', 'backgrounds')
                temporary_path, extension = validate_uploaded_asset(
                    upload,
                    'emoji',
                    background_directory,
                    maximum=8192,
                    max_file_size=MAX_THEME_BACKGROUND_BYTES,
                    max_file_size_message='Theme backgrounds must be no larger than 50 MB',
                    dimension_label='Theme background',
                )
                background_name = f'{normalize_asset_name(name)}.{extension}'
                destination = os.path.join(background_directory, background_name)
                if colthemes.find_one({
                    'background_image_name': background_name,
                    '_id': {'$ne': theme_oid},
                }):
                    return jsonify({'message': 'A background with this normalized theme name already exists'}), 409
                if destination == old_background_path and os.path.isfile(old_background_path):
                    backup_path = os.path.join(
                        background_directory,
                        f'.ats-theme-backup-{uuid.uuid4().hex}',
                    )
                    os.link(old_background_path, backup_path)
                    os.replace(temporary_path, destination)
                    temporary_path = None
                else:
                    if os.path.exists(destination):
                        return jsonify({'message': 'A background with this normalized theme name already exists'}), 409
                    os.link(temporary_path, destination)
                    created_destination = True
                background_exists = True
            elif remove_background:
                background_changed = True
                background_name = None
                background_exists = False
                opacity = 0.0
            elif background_exists and 'background_opacity' in data:
                try:
                    opacity = float(data['background_opacity'])
                except (TypeError, ValueError) as error:
                    raise ValueError('Background opacity must be between 0 and 1') from error
                if not math.isfinite(opacity) or not 0 <= opacity <= 1:
                    raise ValueError('Background opacity must be between 0 and 1')

            if (
                background_exists
                and old_name
                and not upload
                and not remove_background
                and os.path.isfile(old_background_path)
            ):
                extension = os.path.splitext(old_name)[1].lower().lstrip('.')
                if extension not in {'jpg', 'png', 'gif'}:
                    raise ValueError('Stored theme background extension is invalid')
                normalized_name = f'{normalize_asset_name(name)}.{extension}'
                if normalized_name != old_name:
                    background_directory = os.path.join(PUBLIC_DIR, 'img', 'backgrounds')
                    destination = os.path.join(background_directory, normalized_name)
                    if colthemes.find_one({
                        'background_image_name': normalized_name,
                        '_id': {'$ne': theme_oid},
                    }):
                        return jsonify({'message': 'A background with this normalized theme name already exists'}), 409
                    if os.path.exists(destination):
                        return jsonify({'message': 'A background with this normalized theme name already exists'}), 409
                    os.link(old_background_path, destination)
                    created_destination = True
                    background_name = normalized_name
                    background_changed = True

            pricing = load_point_pricing()
            original_pricing = copy.deepcopy(pricing)
            price_override = parse_asset_price(data.get('price'))
            theme_prices = pricing['catalog']['theme']['items']
            if existing.get('is_standard') is True:
                theme_prices.pop(str(theme_oid), None)
                price = 0
                price_overridden = False
            else:
                if price_override is None:
                    theme_prices.pop(str(theme_oid), None)
                    price = pricing['catalog']['theme']['default']
                    price_overridden = False
                else:
                    theme_prices[str(theme_oid)] = price_override
                    price = price_override
                    price_overridden = True
            normalized_pricing = validate_point_pricing(pricing)
            updated_theme = {
                **existing,
                'name': name,
                'name_key': name_key,
                'price': price,
                'price_overridden': price_overridden,
                'primary_color': primary_color,
                'panel_color': panel_color,
                'accent_color': accent_color,
                'background_image_exists': background_exists,
                'background_opacity': opacity,
                'background_image_name': background_name,
                'updated_at': datetime.now(timezone.utc),
            }
            try:
                colthemes.update_one(
                    {'_id': theme_oid},
                    {'$set': {key: value for key, value in updated_theme.items() if key != '_id'}},
                )
                colpricing.update_one(
                    {'_id': POINT_PRICING_ID},
                    {'$set': {
                        'schema_version': 1,
                        'pricing': normalized_pricing,
                        'updated_at': datetime.now(timezone.utc),
                    }},
                    upsert=True,
                )
                sync_theme_price_fields(normalized_pricing)
            except DuplicateKeyError:
                return jsonify({'message': 'A theme with this name already exists'}), 409
            except Exception:
                colthemes.update_one(
                    {'_id': theme_oid},
                    {'$set': {key: value for key, value in existing.items() if key != '_id'}},
                )
                colpricing.update_one(
                    {'_id': POINT_PRICING_ID},
                    {'$set': {
                        'schema_version': 1,
                        'pricing': original_pricing,
                        'updated_at': datetime.now(timezone.utc),
                    }},
                    upsert=True,
                )
                raise

            committed = True
            if background_changed and old_background_path and os.path.isfile(old_background_path):
                if old_background_path != destination:
                    try:
                        os.remove(old_background_path)
                    except OSError:
                        logger.warning("Could not remove replaced theme background %s", old_background_path)
            if backup_path and os.path.exists(backup_path):
                try:
                    os.remove(backup_path)
                except OSError:
                    logger.warning("Could not remove replaced theme background backup %s", backup_path)
            if socketio:
                socketio.emit('usage_costs_changed')
                socketio.emit('asset_catalog_changed', {'asset_type': 'theme'})
            updated_theme['price'] = price
            emit_chat_activity(socketio, f"Updated theme: {name}.")
            return jsonify({
                'theme': serialize_asset(updated_theme, 'theme', normalized_pricing),
                'price_overridden': price_overridden,
            })
        except ValueError as error:
            return jsonify({'message': str(error)}), 400
        except Exception:
            logger.exception("Could not update theme %s", theme_id)
            return jsonify({'message': 'Theme could not be updated'}), 503
        finally:
            if temporary_path and os.path.exists(temporary_path):
                os.remove(temporary_path)
            if not committed and created_destination and destination and os.path.exists(destination):
                os.remove(destination)
            if not committed and backup_path and os.path.exists(backup_path) and old_background_path:
                os.replace(backup_path, old_background_path)

    @app.route('/admin/badges', methods=['GET', 'POST'])
    @require_login
    def adminbadges():
        if not get_admin_user('admin_console'):
            return jsonify({'message': 'Admin login required'}), 403
        if request.method == 'GET':
            return jsonify({
                'badges': [
                    serialize_badge(badge)
                    for badge in colbadges.find({}).sort('name', 1)
                ],
            })

        if request.content_length and request.content_length > 17 * 1024 * 1024:
            return jsonify({'message': 'Upload is too large'}), 413
        temporary_path = None
        destination = None
        created_destination = False
        try:
            data = request.form
            upload = request.files.get('file')
            source_url = data.get('source_url')
            if upload and source_url:
                raise ValueError('Choose a file or enter a URL, not both')
            if source_url:
                upload = fetch_admin_asset_url(source_url, 'emoji')
            display_name = data.get('name', '').strip()
            if not display_name or len(display_name) > 120:
                raise ValueError('Badge name must be 1 to 120 characters')
            name_key = normalize_asset_name(display_name)
            if colbadges.find_one({'name_key': name_key}):
                return jsonify({'message': 'A badge with this name already exists'}), 409
            temporary_path, extension = validate_uploaded_asset(
                upload,
                'emoji',
                BADGEDIR,
                maximum=2048,
                dimension_label='Badge',
            )
            filename = f'{name_key}.{extension}'
            destination = os.path.join(BADGEDIR, filename)
            try:
                os.link(temporary_path, destination)
                created_destination = True
            except FileExistsError:
                return jsonify({'message': 'A badge file with this normalized name already exists'}), 409
            badge = {
                '_id': ObjectId(),
                'name': display_name,
                'name_key': name_key,
                'file': filename,
                'created_at': datetime.now(timezone.utc),
            }
            colbadges.insert_one(badge)
            if socketio:
                socketio.emit('badge_catalog_changed')
            emit_chat_activity(socketio, f'Added badge: {display_name}.')
            return jsonify({'badge': serialize_badge(badge)}), 201
        except ValueError as error:
            return jsonify({'message': str(error)}), 400
        except DuplicateKeyError:
            return jsonify({'message': 'A badge with this name or file already exists'}), 409
        except Exception:
            logger.exception('Could not administer badges')
            return jsonify({'message': 'Badge could not be saved'}), 503
        finally:
            if temporary_path and os.path.exists(temporary_path):
                os.remove(temporary_path)
            if created_destination and destination and not colbadges.find_one({'file': os.path.basename(destination)}):
                if os.path.exists(destination):
                    os.remove(destination)

    @app.route('/admin/badges/<badge_id>', methods=['PATCH', 'DELETE'])
    @require_login
    def adminbadge(badge_id):
        if not get_admin_user('admin_console'):
            return jsonify({'message': 'Admin login required'}), 403
        if not ObjectId.is_valid(badge_id):
            return jsonify({'message': 'Badge not found'}), 404
        badge_oid = ObjectId(badge_id)
        badge = colbadges.find_one({'_id': badge_oid})
        if not badge:
            return jsonify({'message': 'Badge not found'}), 404
        filename = badge.get('file')
        if not isinstance(filename, str) or os.path.basename(filename) != filename:
            return jsonify({'message': 'Stored badge metadata is invalid'}), 503
        old_path = os.path.join(BADGEDIR, filename)

        if request.method == 'DELETE':
            affected_usernames = [
                user.get('username')
                for user in colusers.find({'badges': badge_oid}, {'username': 1})
                if isinstance(user.get('username'), str)
            ]
            colbadges.delete_one({'_id': badge_oid})
            colusers.update_many(
                {'badges': badge_oid},
                {'$pull': {'badges': badge_oid}},
            )
            colusers.update_many(
                {'visible_badge_id': str(badge_oid)},
                {'$unset': {'visible_badge_id': ''}},
            )
            if os.path.exists(old_path):
                os.remove(old_path)
            if socketio:
                socketio.emit('badge_catalog_changed')
                socketio.emit('badge_data_changed', {'usernames': affected_usernames})
                socketio.emit('chat_history', add_current_ranks(list(lastmessages)))
            emit_chat_activity(socketio, f"Removed badge: {badge.get('name', 'badge')}.")
            return jsonify({'status': 'ok'})

        data = request.form if request.mimetype == 'multipart/form-data' else (request.get_json(silent=True) or {})
        display_name = data.get('name', badge.get('name'))
        if not isinstance(display_name, str) or not display_name.strip() or len(display_name.strip()) > 120:
            return jsonify({'message': 'Badge name must be 1 to 120 characters'}), 400
        display_name = display_name.strip()
        try:
            name_key = normalize_asset_name(display_name)
        except ValueError as error:
            return jsonify({'message': str(error)}), 400
        duplicate = colbadges.find_one({'name_key': name_key})
        if duplicate and duplicate.get('_id') != badge_oid:
            return jsonify({'message': 'A badge with this name already exists'}), 409

        temporary_path = None
        destination = None
        backup_path = None
        created_destination = False
        committed = False
        try:
            upload = request.files.get('file')
            source_url = data.get('source_url')
            if upload and source_url:
                raise ValueError('Choose a file or enter a URL, not both')
            if source_url:
                upload = fetch_admin_asset_url(source_url, 'emoji')
            extension = os.path.splitext(filename)[1].lower().lstrip('.')
            if extension not in {'jpg', 'png', 'gif'}:
                raise ValueError('Stored badge image type is invalid')
            if upload:
                temporary_path, extension = validate_uploaded_asset(
                    upload,
                    'emoji',
                    BADGEDIR,
                    maximum=2048,
                    dimension_label='Badge',
                )
            new_filename = f'{name_key}.{extension}'
            destination = os.path.join(BADGEDIR, new_filename)
            if destination != old_path:
                if os.path.exists(destination):
                    return jsonify({'message': 'A badge file with this normalized name already exists'}), 409
                if temporary_path:
                    os.link(temporary_path, destination)
                else:
                    os.link(old_path, destination)
                created_destination = True
            elif temporary_path:
                backup_path = os.path.join(BADGEDIR, f'.ats-badge-backup-{uuid.uuid4().hex}')
                os.replace(old_path, backup_path)
                os.link(temporary_path, destination)
                created_destination = True

            update = colbadges.update_one(
                {'_id': badge_oid},
                {'$set': {'name': display_name, 'name_key': name_key, 'file': new_filename}},
            )
            if update.matched_count != 1:
                raise RuntimeError('Badge no longer exists')
            committed = True
            if destination != old_path and os.path.exists(old_path):
                os.remove(old_path)
            if backup_path and os.path.exists(backup_path):
                os.remove(backup_path)
            if socketio:
                socketio.emit('badge_catalog_changed')
                affected_usernames = [
                    user.get('username')
                    for user in colusers.find({'badges': badge_oid}, {'username': 1})
                    if isinstance(user.get('username'), str)
                ]
                socketio.emit('badge_data_changed', {'usernames': affected_usernames})
                socketio.emit('chat_history', add_current_ranks(list(lastmessages)))
            emit_chat_activity(socketio, f'Updated badge: {display_name}.')
            return jsonify({'badge': serialize_badge({
                **badge,
                'name': display_name,
                'name_key': name_key,
                'file': new_filename,
            })})
        except ValueError as error:
            return jsonify({'message': str(error)}), 400
        except DuplicateKeyError:
            return jsonify({'message': 'A badge with this name or file already exists'}), 409
        except Exception:
            logger.exception('Could not update badge %s', badge_id)
            return jsonify({'message': 'Badge could not be updated'}), 503
        finally:
            if temporary_path and os.path.exists(temporary_path):
                os.remove(temporary_path)
            if not committed:
                if created_destination and destination and os.path.exists(destination):
                    os.remove(destination)
                if backup_path and os.path.exists(backup_path):
                    os.replace(backup_path, old_path)
            elif backup_path and os.path.exists(backup_path):
                os.remove(backup_path)

    @app.route('/admin/badges/<badge_id>/grant-online', methods=['POST'])
    @require_login
    def admingrantbadgeonline(badge_id):
        if not get_admin_user('admin_console'):
            return jsonify({'message': 'Admin login required'}), 403
        if not ObjectId.is_valid(badge_id):
            return jsonify({'message': 'Badge not found'}), 404
        badge = colbadges.find_one({'_id': ObjectId(badge_id)})
        if not badge:
            return jsonify({'message': 'Badge not found'}), 404
        usernames = list(onlineusers)
        if usernames:
            result = colusers.update_many(
                {'username': {'$in': usernames}},
                {'$addToSet': {'badges': badge['_id']}},
            )
            granted_count = result.modified_count
            if granted_count:
                if socketio:
                    socketio.emit('badge_data_changed', {'usernames': usernames})
                emit_chat_activity(socketio, f"Granted badge {badge.get('name', '')} to all online users.")
        else:
            granted_count = 0
        return jsonify({'granted_count': granted_count})

    @app.route('/admin/assets/<asset_type>', methods=['GET', 'POST'])
    @require_login
    def adminassets(asset_type):
        if not get_admin_user('admin_console'):
            return jsonify({'message': 'Admin login required'}), 403
        if asset_type not in {'sound', 'emoji'}:
            return jsonify({'message': 'Unsupported asset type'}), 404
        collection = asset_collection(asset_type)
        try:
            pricing = load_point_pricing()
            if request.method == 'GET':
                assets = []
                for asset in collection.find({}).sort('name', 1):
                    item = serialize_asset(asset, asset_type, pricing)
                    item['default_price'] = pricing['catalog'][asset_type]['default']
                    item['price_exception'] = catalog_asset_exception_value(
                        asset_type,
                        asset,
                        pricing,
                    )
                    if asset_type == 'sound':
                        item['play_default_price'] = pricing['catalog']['sound']['play_default']
                        item['play_price_exception'] = catalog_asset_exception_value(
                            'sound',
                            asset,
                            pricing,
                            'play_items',
                        )
                    assets.append(item)
                return jsonify({
                    'assets': assets,
                    'default_price': pricing['catalog'][asset_type]['default'],
                })

            if request.content_length and request.content_length > 17 * 1024 * 1024:
                return jsonify({'message': 'Upload is too large'}), 413
            upload = request.files.get('file')
            data = request.get_json(silent=True) if request.is_json else request.form
            data = data if isinstance(data, dict) or hasattr(data, 'get') else {}
            source_url = data.get('source_url')
            if upload and source_url:
                raise ValueError('Choose a file or enter a URL, not both')
            if source_url:
                upload = fetch_admin_asset_url(source_url, asset_type)
            raw_name = data.get('display_name') if asset_type == 'sound' else data.get('name')
            name = normalize_asset_name(raw_name)
            display_name = raw_name.strip() if isinstance(raw_name, str) else ''
            if asset_type == 'sound' and (not display_name or len(display_name) > 120):
                raise ValueError('Sound display name must be 1 to 120 characters')
            loudness = 1.0
            if asset_type == 'sound':
                try:
                    raw_loudness = data.get('loudness', '')
                    if isinstance(raw_loudness, str):
                        raw_loudness = raw_loudness.strip() or '1'
                    loudness = float(raw_loudness or 1)
                except (TypeError, ValueError) as error:
                    raise ValueError('Loudness must be a number from 0 to 2') from error
                if not 0 <= loudness <= 2:
                    raise ValueError('Loudness must be a number from 0 to 2')
            price = parse_asset_price(data.get('price'))
            if collection.find_one({'name': name}):
                return jsonify({'message': 'An asset with this name already exists'}), 409

            directory = SOUNDDIR if asset_type == 'sound' else EMOJIDIR
            temp_path, extension = validate_uploaded_asset(
                upload,
                asset_type,
                directory,
                upload_limit(pricing, asset_type, True),
            )
            filename = f'{name}.{extension}'
            destination = os.path.join(directory, filename)
            try:
                os.link(temp_path, destination)
            except FileExistsError:
                return jsonify({'message': 'A file with this normalized name already exists'}), 409

            document = {
                '_id': ObjectId(),
                'name': name,
                'pricing_name': name,
                'file': filename,
                'created_at': datetime.now(timezone.utc),
            }
            if asset_type == 'sound':
                document.update({'display_name': display_name, 'loudness': loudness})
            try:
                collection.insert_one(document)
                price_key = filename if asset_type == 'sound' else name
                save_catalog_price_exception(asset_type, price_key, price_key, price)
            except Exception:
                collection.delete_one({'_id': document['_id']})
                if os.path.exists(destination):
                    os.remove(destination)
                raise
            if socketio:
                socketio.emit('usage_costs_changed')
                socketio.emit('asset_catalog_changed', {'asset_type': asset_type})
            label = document.get('display_name') or document.get('name')
            emit_chat_activity(socketio, f"Added {asset_type}: {label}.")
            return jsonify({'asset': serialize_asset(document, asset_type, load_point_pricing())}), 201
        except ValueError as error:
            return jsonify({'message': str(error)}), 400
        except Exception:
            logger.exception('Could not administer %s assets', asset_type)
            return jsonify({'message': 'Asset could not be saved'}), 503
        finally:
            if request.method == 'POST' and 'temp_path' in locals() and os.path.exists(temp_path):
                os.remove(temp_path)

    @app.route('/admin/assets/<asset_type>/<asset_id>', methods=['PATCH', 'DELETE'])
    @require_login
    def adminasset(asset_type, asset_id):
        if not get_admin_user('admin_console'):
            return jsonify({'message': 'Admin login required'}), 403
        if asset_type not in {'sound', 'emoji'} or not ObjectId.is_valid(asset_id):
            return jsonify({'message': 'Asset not found'}), 404
        collection = asset_collection(asset_type)
        asset_oid = ObjectId(asset_id)
        asset = collection.find_one({'_id': asset_oid})
        if not asset:
            return jsonify({'message': 'Asset not found'}), 404
        asset = copy.deepcopy(asset)
        old_name = asset.get('name')
        old_filename = asset.get('file')
        if (
            not isinstance(old_name, str)
            or not isinstance(old_filename, str)
            or os.path.basename(old_filename) != old_filename
        ):
            return jsonify({'message': 'Stored asset metadata is invalid'}), 503
        extension = os.path.splitext(old_filename)[1].lower()
        allowed_extensions = {'.mp3'} if asset_type == 'sound' else {'.jpg', '.png', '.gif'}
        if extension not in allowed_extensions:
            return jsonify({'message': 'Stored asset metadata is invalid'}), 503
        directory = SOUNDDIR if asset_type == 'sound' else EMOJIDIR
        old_path = os.path.join(directory, old_filename)
        staged_path = None
        new_path = None
        committed = False
        try:
            pricing = load_point_pricing()
            if request.method == 'DELETE':
                old_price_key = catalog_asset_exception_key(asset_type, asset, pricing)
                if old_price_key is None:
                    old_price_key = old_filename if asset_type == 'sound' else asset.get('pricing_name', old_name)
                old_play_price_key = (
                    catalog_asset_exception_key('sound', asset, pricing, 'play_items') or old_filename
                    if asset_type == 'sound'
                    else ASSET_PRICE_UNCHANGED
                )
                if os.path.exists(old_path):
                    staged_path = os.path.join(directory, f'.ats-remove-{uuid.uuid4().hex}')
                    os.replace(old_path, staged_path)
                result = collection.delete_one({'_id': asset_oid})
                if not getattr(result, 'deleted_count', 1):
                    if staged_path and os.path.exists(staged_path):
                        os.replace(staged_path, old_path)
                    return jsonify({'message': 'Asset could not be removed'}), 503
                try:
                    save_catalog_price_exception(
                        asset_type,
                        old_price_key,
                        old_price_key,
                        None,
                        None if asset_type == 'sound' else ASSET_PRICE_UNCHANGED,
                        old_play_price_key,
                        old_play_price_key,
                    )
                except Exception:
                    collection.insert_one(asset)
                    if staged_path and os.path.exists(staged_path):
                        os.replace(staged_path, old_path)
                    raise
                committed = True
                if staged_path and os.path.exists(staged_path):
                    try:
                        os.remove(staged_path)
                    except OSError:
                        logger.warning("Could not remove staged asset file %s", staged_path)
                if socketio:
                    socketio.emit('usage_costs_changed')
                    socketio.emit('asset_catalog_changed', {'asset_type': asset_type})
                if asset_type == 'emoji' and socketio:
                    socketio.emit('chat_history', add_current_ranks(list(lastmessages)))
                label = asset.get('display_name') or asset.get('name')
                emit_chat_activity(socketio, f"Removed {asset_type}: {label}.")
                return jsonify({'status': 'ok'})

            data = request.get_json(silent=True)
            if not isinstance(data, dict):
                return jsonify({'message': 'Request body must be an object'}), 400
            updated = {}
            new_name = old_name
            if asset_type == 'sound':
                if 'display_name' in data:
                    display_name = data['display_name'].strip() if isinstance(data['display_name'], str) else ''
                    if not display_name or len(display_name) > 120:
                        raise ValueError('Sound display name must be 1 to 120 characters')
                    new_name = normalize_asset_name(display_name)
                    updated['display_name'] = display_name
                if 'loudness' in data:
                    loudness = data['loudness']
                    if isinstance(loudness, bool) or not isinstance(loudness, (int, float)) or not 0 <= loudness <= 2:
                        raise ValueError('Loudness must be a number from 0 to 2')
                    updated['loudness'] = float(loudness)
            elif 'name' in data:
                new_name = normalize_asset_name(data['name'])
            price = parse_asset_price(data['price']) if 'price' in data else ASSET_PRICE_UNCHANGED
            play_price = (
                parse_play_price(data.get('play_price'))
                if 'play_price' in data and asset_type == 'sound'
                else ASSET_PRICE_UNCHANGED
            )
            old_price_key = catalog_asset_exception_key(asset_type, asset, pricing)
            if old_price_key is None:
                old_price_key = old_filename if asset_type == 'sound' else asset.get('pricing_name', old_name)
            old_play_price_key = None
            if asset_type == 'sound':
                old_play_price_key = catalog_asset_exception_key(
                    'sound',
                    asset,
                    pricing,
                    'play_items',
                ) or old_filename
            new_filename = f'{new_name}{os.path.splitext(old_filename)[1].lower()}'
            if collection.find_one({'name': new_name, '_id': {'$ne': asset_oid}}):
                return jsonify({'message': 'An asset with this name already exists'}), 409
            if new_filename != old_filename:
                new_path = os.path.join(directory, new_filename)
                if os.path.exists(new_path):
                    return jsonify({'message': 'A file with this normalized name already exists'}), 409
                if not os.path.isfile(old_path):
                    return jsonify({'message': 'Asset file is missing'}), 503
                staged_path = os.path.join(directory, f'.ats-rename-{uuid.uuid4().hex}')
                os.replace(old_path, staged_path)
                os.link(staged_path, new_path)
                updated['file'] = new_filename
            updated.update({
                'name': new_name,
                'pricing_name': new_name,
                'updated_at': datetime.now(timezone.utc),
            })
            collection.update_one({'_id': asset_oid}, {'$set': updated})
            try:
                save_catalog_price_exception(
                    asset_type,
                    old_price_key,
                    new_filename if asset_type == 'sound' else new_name,
                    price,
                    play_price,
                    old_play_price_key,
                    new_filename if asset_type == 'sound' else new_name,
                )
            except Exception:
                collection.update_one(
                    {'_id': asset_oid},
                    {'$set': {key: value for key, value in asset.items() if key != '_id'}},
                )
                raise
            committed = True
            if staged_path and os.path.exists(staged_path):
                try:
                    os.remove(staged_path)
                except OSError:
                    logger.warning("Could not remove staged asset file %s", staged_path)
            if asset_type == 'emoji' and new_name != old_name:
                old_shortcode = f':{old_name}:'
                new_shortcode = f':{new_name}:'
                for message in colchat.find({'message': {'$regex': re.escape(old_shortcode)}}):
                    updated_message = message.get('message', '').replace(old_shortcode, new_shortcode)
                    literals = message.get('literal_emojis', [])
                    updated_literals = [new_name if value == old_name else value for value in literals]
                    colchat.update_one(
                        {'_id': message['_id']},
                        {'$set': {'message': updated_message, 'literal_emojis': updated_literals}},
                    )
                for message in lastmessages:
                    if old_shortcode in message.get('message', ''):
                        message['message'] = message['message'].replace(old_shortcode, new_shortcode)
                    message['literal_emojis'] = [
                        new_name if value == old_name else value
                        for value in message.get('literal_emojis', [])
                    ]
                if socketio:
                    socketio.emit('asset_catalog_changed', {'asset_type': asset_type})
                    socketio.emit('chat_history', add_current_ranks(list(lastmessages)))
            if socketio:
                socketio.emit('usage_costs_changed')
            refreshed = collection.find_one({'_id': asset_oid})
            label = refreshed.get('display_name') or refreshed.get('name')
            emit_chat_activity(socketio, f"Updated {asset_type}: {label}.")
            return jsonify({'asset': serialize_asset(refreshed, asset_type, load_point_pricing())})
        except ValueError as error:
            if not committed and staged_path and os.path.exists(staged_path):
                if new_path and os.path.exists(new_path):
                    os.remove(new_path)
                if not os.path.exists(old_path):
                    os.replace(staged_path, old_path)
            return jsonify({'message': str(error)}), 400
        except Exception:
            logger.exception('Could not update %s asset %s', asset_type, asset_id)
            if not committed and staged_path and os.path.exists(staged_path):
                if new_path and os.path.exists(new_path):
                    os.remove(new_path)
                if not os.path.exists(old_path):
                    os.replace(staged_path, old_path)
            return jsonify({'message': 'Asset could not be updated'}), 503

    @app.route('/admin/logout', methods=['POST'])
    def adminlogout():
        session.clear()
        return jsonify({'status': 'ok'})

    @app.route('/account/profile')
    @require_login
    def accountprofile():
        user = get_session_user()
        if not user:
            return jsonify({'message': 'Login required'}), 401
        return jsonify({'user': serialize_user_profile(user)})

    @app.route('/account/profile/badge', methods=['PUT'])
    @require_login
    def accountprofilebadge():
        user = get_session_user()
        if not user:
            return jsonify({'message': 'Login required'}), 401
        data = request.get_json(silent=True) or {}
        badge_id = data.get('badge_id')
        if badge_id is None or badge_id == '':
            changed = colusers.update_one(
                {'_id': user['_id']},
                {'$unset': {'visible_badge_id': ''}},
            )
        else:
            if not isinstance(badge_id, str) or not ObjectId.is_valid(badge_id):
                return jsonify({'message': 'Select a badge you own'}), 400
            badge_oid = ObjectId(badge_id)
            owned_badges = user.get('badges', [])
            owned_ids = {str(item) for item in owned_badges} if isinstance(owned_badges, list) else set()
            if str(badge_oid) not in owned_ids or not colbadges.find_one({'_id': badge_oid}):
                return jsonify({'message': 'Select a badge you own'}), 403
            changed = colusers.update_one(
                {'_id': user['_id']},
                {'$set': {'visible_badge_id': str(badge_oid)}},
            )
        if changed.matched_count != 1:
            return jsonify({'message': 'Account could not be updated'}), 409
        updated_user = colusers.find_one({'_id': user['_id']})
        if socketio:
            socketio.emit('chat_history', add_current_ranks(list(lastmessages)))
        return jsonify({'user': serialize_user_profile(updated_user)})

    @app.route('/account/recovery', methods=['POST'])
    @require_login
    def accountrecovery():
        user = get_session_user()
        if not user:
            return jsonify({'message': 'Login required'}), 401
        data = request.get_json(silent=True) or {}
        recovery_type = data.get('recovery_type')
        if recovery_type not in ('password', 'email'):
            return jsonify({'message': 'Select password or email recovery'}), 400
        if recovery_type == 'email' and not user.get('password_hash'):
            return jsonify({'message': 'Recover your password before requesting an email reset code'}), 409
        pending_expiry = user.get('password_reset_token_expires_at')
        if isinstance(pending_expiry, datetime) and pending_expiry.tzinfo is None:
            pending_expiry = pending_expiry.replace(tzinfo=timezone.utc)
        if (
            user.get('password_reset_token_hash')
            and user.get('password_reset_token_type', 'password') != recovery_type
            and isinstance(pending_expiry, datetime)
            and pending_expiry > datetime.now(timezone.utc)
        ):
            return jsonify({'message': 'Complete or wait for the current recovery code to expire'}), 409

        reset_token = secrets.token_urlsafe(32)
        expires_at = datetime.now(timezone.utc) + PASSWORD_RESET_TOKEN_TTL
        fields = {
            'password_reset_token_hash': generate_password_hash(reset_token),
            'password_reset_token_lookup': hashlib.sha256(reset_token.encode('utf-8')).hexdigest(),
            'password_reset_token_expires_at': expires_at,
            'password_reset_token_type': recovery_type,
            'password_reset_self_service': recovery_type == 'password',
        }
        changed = colusers.update_one(
            {'_id': user['_id']},
            {'$set': fields},
        )
        if changed.matched_count != 1:
            return jsonify({'message': 'Account could not be updated'}), 409
        return jsonify({
            'reset_token': reset_token,
            'reset_token_expires_at': expires_at.isoformat(),
        })

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
        return jsonify({'user': serialize_user_profile(user)})

    @app.route('/admin/users/<username>/badges', methods=['POST', 'DELETE'])
    @require_login
    def admingrantbadge(username):
        if not get_admin_user('admin_console'):
            return jsonify({'message': 'Admin login required'}), 403
        data = request.get_json(silent=True) or {}
        badge_id = data.get('badge_id')
        if not isinstance(badge_id, str) or not ObjectId.is_valid(badge_id):
            return jsonify({'message': 'Select a badge'}), 400
        badge = colbadges.find_one({'_id': ObjectId(badge_id)})
        user = colusers.find_one({'username': username})
        if not badge or not user:
            return jsonify({'message': 'User or badge not found'}), 404
        if request.method == 'DELETE':
            result = colusers.update_one(
                {'_id': user['_id']},
                {'$pull': {'badges': {'$in': [badge['_id'], str(badge['_id'])]}}},
            )
            if result.modified_count:
                colusers.update_one(
                    {
                        '_id': user['_id'],
                        'visible_badge_id': {'$in': [str(badge['_id']), badge['_id']]},
                    },
                    {'$unset': {'visible_badge_id': ''}},
                )
                if socketio:
                    socketio.emit('badge_data_changed', {'usernames': [username]})
                emit_chat_activity(socketio, f"Removed badge {badge.get('name', '')} from {username}.")
            updated_user = colusers.find_one({'_id': user['_id']})
            return jsonify({
                'status': 'ok',
                'removed': bool(result.modified_count),
                'user': serialize_user_profile(updated_user),
            })

        result = colusers.update_one(
            {'_id': user['_id']},
            {'$addToSet': {'badges': badge['_id']}},
        )
        if result.modified_count:
            if socketio:
                socketio.emit('badge_data_changed', {'usernames': [username]})
            emit_chat_activity(socketio, f"Granted badge {badge.get('name', '')} to {username}.")
        return jsonify({'status': 'ok', 'granted': bool(result.modified_count)})

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
            applied_amount = adjustment.get('amount', amount) if adjustment else amount
            if isinstance(applied_amount, bool) or not isinstance(applied_amount, int):
                logger.error("Invalid applied point adjustment amount for %s", request_id)
                applied_amount = amount
            emit_chat_activity(socketio, f"{username} {applied_amount:+d}❖")
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
        timeout_message = (
            f"{moderation_activity_prefix(actor)}unbanned {username}."
            if data.get('clear') is True
            else f"{moderation_activity_prefix(actor)}banned {username} for {duration_seconds}s."
        )
        emit_chat_activity(socketio, timeout_message)
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
            return jsonify({'message': 'Select an available rank'}), 400
        destination_role = find_role(rank)
        if not destination_role or not isinstance(destination_role.get('staff'), bool):
            return jsonify({'message': 'Select an available rank'}), 400
        destination_permissions = colpermissions.find_one({'rank_id': destination_role['_id']})
        destination_capabilities = validated_role_capabilities(
            destination_role,
            destination_permissions,
        )
        if (
            destination_capabilities is None
            or destination_capabilities['rank_immutable']
        ):
            return jsonify({'message': 'Select an available rank'}), 400
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
        can_assign_destination = (
            actor_capabilities.get('assign_non_staff_rank') is True
            if destination_role['staff'] is False
            else str(destination_role['_id']) in permitted_role_ids(actor, 'edit_staff_role_ids')
        )
        if (
            not allowed
            or target['_id'] == actor['_id'] and actor_capabilities.get('edit_self') is not True
            or not can_assign_destination
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
        emit_chat_activity(
            socketio,
            f"{moderation_activity_prefix(actor)}changed {username}'s rank to {current_rank}.",
        )
        return jsonify({'user': serialize_user(user)})

    @app.route('/admin/users/<username>/reset-password', methods=['POST'])
    @require_login
    def adminresetpassword(username):
        if not get_admin_user('reset_password'):
            return jsonify({'message': 'Admin login required'}), 403
        reset_token = secrets.token_urlsafe(32)
        expires_at = datetime.now(timezone.utc) + PASSWORD_RESET_TOKEN_TTL
        result = colusers.update_one(
            {'username': username},
            {'$set': {
                'password_hash': None,
                'password_reset_token_hash': generate_password_hash(reset_token),
                'password_reset_token_lookup': hashlib.sha256(reset_token.encode('utf-8')).hexdigest(),
                'password_reset_token_expires_at': expires_at,
                'password_reset_token_type': 'password',
                'password_reset_self_service': False,
            }},
        )
        if result.matched_count == 0:
            return jsonify({'message': 'User not found'}), 404
        user = colusers.find_one({'username': username})
        return jsonify({
            'user': serialize_user(user),
            'reset_token': reset_token,
            'reset_token_expires_at': expires_at.isoformat(),
        })

    @app.route('/admin/users/<username>/reset-email', methods=['POST'])
    @require_login
    def adminresetemail(username):
        if not get_admin_user('reset_password'):
            return jsonify({'message': 'Admin login required'}), 403
        reset_token = secrets.token_urlsafe(32)
        expires_at = datetime.now(timezone.utc) + PASSWORD_RESET_TOKEN_TTL
        result = colusers.update_one(
            {'username': username},
            {'$set': {
                'password_reset_token_hash': generate_password_hash(reset_token),
                'password_reset_token_lookup': hashlib.sha256(reset_token.encode('utf-8')).hexdigest(),
                'password_reset_token_expires_at': expires_at,
                'password_reset_token_type': 'email',
                'password_reset_self_service': False,
            }},
        )
        if result.matched_count == 0:
            return jsonify({'message': 'User not found'}), 404
        user = colusers.find_one({'username': username})
        return jsonify({
            'user': serialize_user(user),
            'reset_token': reset_token,
            'reset_token_expires_at': expires_at.isoformat(),
        })

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

    # Preserve existing URLs while serving shared files from Next.js's public directory.
    @app.route('/static/<path:filename>')
    def servepublicasset(filename):
        return send_from_directory(PUBLIC_DIR, filename)

    @app.route('/emoji/<name>')
    def emojiname(name):
        for ext in ['.jpg', '.png', '.gif']:
            path = os.path.join(EMOJIDIR, f"{name}{ext}")
            if os.path.isfile(path):
                return jsonify({'url': f"/static/img/emoji/{name}{ext}"})
        return jsonify({'url': None})

    @app.route('/api/list-emojis')
    def listemojis():
        if os.path.exists(EMOJIDIR):
            emojis = [os.path.splitext(f)[0] for f in os.listdir(EMOJIDIR)
                      if os.path.splitext(f)[1].lower() in ['.jpg', '.png', '.gif']]
            return jsonify(emojis)
        return jsonify([])

    @app.route('/public-emojis')
    def publicemojis():
        if not os.path.isdir(EMOJIDIR):
            return jsonify([])
        filenames = {}
        for filename in sorted(os.listdir(EMOJIDIR)):
            name, extension = os.path.splitext(filename)
            if extension.lower() not in {'.jpg', '.png', '.gif'}:
                continue
            if name not in filenames or extension.lower() == '.jpg':
                filenames[name] = filename
        return jsonify([
            {
                'name': name,
                'url': f"/img/emoji/{filename}",
            }
            for name, filename in sorted(filenames.items())
        ])

    @app.route('/usable-emojis')
    @require_login
    def usableemojis():
        account = get_session_user()
        try:
            pricing = load_point_pricing()
            assets = list_usable_assets(account, 'emoji')
            return jsonify([serialize_asset(asset, 'emoji', pricing) for asset in assets])
        except ValueError as error:
            return jsonify({'message': str(error)}), 503
        except Exception:
            logger.exception("Could not load usable emojis for account %s", account.get('_id'))
            return jsonify({'message': 'Usable emojis could not be loaded'}), 503

    @app.route('/shop/catalog')
    @require_login
    def shopcatalog():
        account = get_session_user()
        try:
            pricing = load_point_pricing()
            catalog = list_shop_assets(account)
            catalog['proposal_prices'] = pricing['proposal_rewards']
            return jsonify(catalog)
        except ValueError as error:
            return jsonify({'message': str(error)}), 503
        except Exception:
            logger.exception("Could not load shop catalog for account %s", account.get('_id'))
            return jsonify({'message': 'Shop catalog could not be loaded'}), 503

    @app.route('/account/theme', methods=['GET', 'PUT'])
    @require_login
    def accounttheme():
        account = get_session_user()
        if not account:
            return jsonify({'message': 'Login required'}), 401
        try:
            themes = list_shop_assets(account)['theme']
            if request.method == 'GET':
                selected_theme_id = str(account.get('theme_id') or STANDARD_THEME_ID)
                selected = next(
                    (theme for theme in themes if theme['asset_id'] == selected_theme_id and theme['owned']),
                    None,
                )
                if not selected:
                    selected_theme_id = str(STANDARD_THEME_ID)
                return jsonify({
                    'themes': themes,
                    'selected_theme_id': selected_theme_id,
                })

            data = request.get_json(silent=True)
            theme_id = data.get('theme_id') if isinstance(data, dict) else None
            if not isinstance(theme_id, str) or not ObjectId.is_valid(theme_id):
                return jsonify({'message': 'Choose a valid theme'}), 400
            theme_object_id = ObjectId(theme_id)
            theme = colthemes.find_one({'_id': theme_object_id})
            if not theme:
                return jsonify({'message': 'Theme not found'}), 404
            if (
                theme.get('is_standard') is not True
                and not has_permission(account, 'admin_console')
                and not colassetownership.find_one({
                    'user_id': account['_id'],
                    'asset_type': 'theme',
                    'asset_id': theme_object_id,
                })
            ):
                return jsonify({'message': 'Purchase this theme before selecting it'}), 403
            colusers.update_one(
                {'_id': account['_id']},
                {'$set': {'theme_id': str(theme_object_id)}},
            )
            return jsonify({'selected_theme_id': str(theme_object_id)})
        except ValueError as error:
            return jsonify({'message': str(error)}), 503
        except Exception:
            logger.exception("Could not load or save theme preference for account %s", account.get('_id'))
            return jsonify({'message': 'Theme preference could not be saved'}), 503

    @app.route('/shop/purchase', methods=['POST'])
    @require_login
    def shoppurchase():
        account = get_session_user()
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({'status': 'error', 'message': 'Request body must be an object'}), 400
        if 'expected_price' not in data:
            return jsonify({'status': 'error', 'message': 'Expected price is required'}), 400
        try:
            result, status = purchase_catalog_asset(
                account,
                data.get('asset_type'),
                data.get('asset_id'),
                data.get('request_id'),
                data.get('expected_price'),
                socketio,
            )
        except Exception:
            logger.exception(
                "Shop purchase failed for account %s",
                account.get('_id') if isinstance(account, dict) else None,
            )
            return jsonify({
                'status': 'error',
                'message': 'Purchase could not be confirmed; retry it shortly.',
            }), 503
        if status == 200 and result.get('status') == 'ok' and data.get('asset_type') == 'emoji':
            try:
                asset_id = data.get('asset_id')
                emoji = colemojis.find_one({
                    '_id': ObjectId(asset_id),
                }) if isinstance(asset_id, str) and ObjectId.is_valid(asset_id) else None
                if emoji and isinstance(emoji.get('name'), str):
                    emoji_name = emoji['name']
                    colchat.update_many(
                        {'literal_emojis': emoji_name},
                        {'$pull': {'literal_emojis': emoji_name}},
                    )
                    for message in lastmessages:
                        if emoji_name in message.get('literal_emojis', []):
                            message['literal_emojis'] = [
                                name for name in message['literal_emojis']
                                if name != emoji_name
                            ]
                    socketio.emit('chat_history', add_current_ranks(list(lastmessages)))
            except Exception:
                logger.exception("Could not refresh chat rendering after emoji purchase")
                return jsonify({
                    'status': 'error',
                    'message': 'Purchase completed, but chat could not be refreshed. Reload the page.',
                }), 503
        return jsonify(result), status

    @app.route('/shop/propose', methods=['POST'])
    @require_login
    def shoppropose():
        account = get_session_user()
        if not isinstance(account, dict) or not isinstance(account.get('_id'), ObjectId):
            return jsonify({'status': 'error', 'message': 'Login required'}), 401
        if request.content_length and request.content_length > 17 * 1024 * 1024:
            return jsonify({'status': 'error', 'message': 'Upload is too large'}), 413

        data = request.form
        asset_type = data.get('asset_type')
        if asset_type not in {'emoji', 'sound'}:
            return jsonify({'status': 'error', 'message': 'Unsupported asset type'}), 400
        request_id = normalize_request_id(data.get('request_id'))
        if not request_id:
            return jsonify({'status': 'error', 'message': 'A valid request ID is required'}), 400

        user_id = account['_id']
        operation_id = f'asset-proposal:{asset_type}:{request_id}'
        transaction_id = operation_id
        collection = asset_collection(asset_type)
        ownership = {
            'user_id': user_id,
            'asset_type': asset_type,
        }
        existing = collection.find_one({
            'proposal_user_id': user_id,
            'proposal_request_id': request_id,
        })
        if existing and existing.get('proposal_state') in {'processing', 'complete'}:
            filename = existing.get('file')
            directory = SOUNDDIR if asset_type == 'sound' else EMOJIDIR
            if (
                not isinstance(filename, str)
                or os.path.basename(filename) != filename
                or not os.path.isfile(os.path.join(directory, filename))
            ):
                return jsonify({
                    'status': 'error',
                    'message': 'The submitted asset is still being processed. Contact an administrator if this persists.',
                }), 503
            ownership['asset_id'] = existing['_id']
            ensure_asset_ownership(ownership)
            if existing.get('proposal_state') != 'complete':
                collection.update_one(
                    {'_id': existing['_id'], 'proposal_state': 'processing'},
                    {'$set': {'proposal_state': 'complete'}},
                )
            record_point_transaction(
                user_id,
                transaction_id,
                f'{asset_type}_proposal',
                -existing['proposal_cost'],
                existing['proposal_balance_after'],
                asset_id=existing['_id'],
            )
            colusers.update_one(
                {'_id': user_id, 'pending_point_operation': operation_id},
                {'$unset': {'pending_point_operation': ''}},
            )
            current_user = colusers.find_one({'_id': user_id}) or account
            broadcast_proposed_asset(asset_type, existing, socketio)
            return jsonify({
                'status': 'ok',
                'duplicate': True,
                'points': current_user.get('points', 0),
            })
        if existing:
            return jsonify({
                'status': 'error',
                'message': 'This proposal is still being processed. Retry shortly.',
            }), 409

        temp_path = None
        destination = None
        asset = None
        ownership_added = False
        stored_file = False
        charged = False
        charged_here = False
        completed = False
        cost = 0
        balance_after = account.get('points', 0)

        def rollback_proposal():
            if completed:
                return
            if ownership_added:
                colassetownership.delete_one({
                    **ownership,
                    'asset_id': asset['_id'],
                })
            if asset:
                collection.delete_one({'_id': asset['_id']})
            if stored_file and destination and os.path.exists(destination):
                os.remove(destination)
            if charged_here:
                refund = colusers.update_one(
                    {'_id': user_id, 'pending_point_operation': operation_id},
                    {
                        '$inc': {'points': cost},
                        '$unset': {'pending_point_operation': ''},
                    },
                )
                if not getattr(refund, 'matched_count', 0):
                    logger.error(
                        'Could not roll back proposal debit for account %s, request %s',
                        user_id,
                        request_id,
                    )

        try:
            pricing = load_point_pricing()
            raw_name = data.get('display_name') if asset_type == 'sound' else data.get('name')
            name = normalize_asset_name(raw_name)
            display_name = raw_name.strip() if isinstance(raw_name, str) else ''
            if asset_type == 'sound' and (not display_name or len(display_name) > 120):
                raise ValueError('Sound display name must be 1 to 120 characters')
            loudness = 1.0
            if asset_type == 'sound':
                try:
                    raw_loudness = data.get('loudness', '').strip() or '1'
                    loudness = float(raw_loudness)
                except (AttributeError, TypeError, ValueError) as error:
                    raise ValueError('Loudness must be a number from 0 to 2') from error
                if not math.isfinite(loudness) or not 0 <= loudness <= 2:
                    raise ValueError('Loudness must be a number from 0 to 2')

            rewards = pricing['proposal_rewards'][asset_type]
            exclusive = data.get('exclusive') == 'true'
            cost = rewards['exclusive'] if exclusive else resolve_proposal_reward(
                asset_type,
                name,
                pricing,
            )
            if cost == -1:
                return jsonify({
                    'status': 'error',
                    'code': 'proposal_unavailable',
                    'message': 'This proposal type is currently unavailable.',
                }), 403

            if collection.find_one({'name': name}):
                return jsonify({
                    'status': 'error',
                    'code': 'duplicate_asset_name',
                    'message': 'An asset with this name already exists.',
                }), 409

            upload = request.files.get('file')
            source_url = data.get('source_url', '').strip()
            if upload and source_url:
                raise ValueError('Choose a file or enter a URL, not both')
            if source_url:
                upload = fetch_admin_asset_url(source_url, asset_type)
            directory = SOUNDDIR if asset_type == 'sound' else EMOJIDIR
            temp_path, extension = validate_uploaded_asset(
                upload,
                asset_type,
                directory,
                upload_limit(
                    pricing,
                    asset_type,
                    has_permission(account, 'admin_console'),
                ),
            )
            filename = f'{name}.{extension}'
            destination = os.path.join(directory, filename)
            current_user = colusers.find_one({'_id': user_id}) or account
            retrying_charged_proposal = (
                current_user.get('pending_point_operation') == operation_id
            )
            try:
                os.link(temp_path, destination)
            except FileExistsError:
                same_retry_file = False
                if retrying_charged_proposal and os.path.isfile(destination):
                    with open(temp_path, 'rb') as uploaded_file:
                        uploaded_digest = hashlib.sha256(uploaded_file.read()).digest()
                    with open(destination, 'rb') as stored_asset:
                        stored_digest = hashlib.sha256(stored_asset.read()).digest()
                    same_retry_file = uploaded_digest == stored_digest
                if not same_retry_file:
                    return jsonify({
                        'status': 'error',
                        'code': 'duplicate_asset_file',
                        'message': 'A file with this normalized name already exists.',
                    }), 409
            else:
                stored_file = True

            if cost:
                current_user = colusers.find_one({'_id': user_id}) or account
                if current_user.get('pending_point_operation') == operation_id:
                    debited_user = current_user
                    charged = True
                elif current_user.get('pending_point_operation'):
                    rollback_proposal()
                    return jsonify({
                        'status': 'error',
                        'message': 'A previous point action is still being processed. Retry shortly.',
                        'points': current_user.get('points', 0),
                    }), 409
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
                            '$set': {'pending_point_operation': operation_id},
                        },
                        return_document=ReturnDocument.AFTER,
                    )
                    charged_here = debited_user is not None
                if not debited_user:
                    current_user = colusers.find_one({'_id': user_id}) or account
                    if current_user.get('pending_point_operation') == operation_id:
                        debited_user = current_user
                        charged = True
                    elif current_user.get('points', 0) < cost:
                        rollback_proposal()
                        return jsonify({
                            'status': 'error',
                            'code': 'insufficient_points',
                            'message': f"This proposal costs {cost} points. You have {current_user.get('points', 0)} points.",
                            'points': current_user.get('points', 0),
                        }), 402
                    else:
                        rollback_proposal()
                        return jsonify({
                            'status': 'error',
                            'message': 'A previous point action is still being processed. Retry shortly.',
                            'points': current_user.get('points', 0),
                        }), 409
                charged = debited_user.get('pending_point_operation') == operation_id
                balance_after = debited_user.get('points', 0)

            asset = {
                '_id': ObjectId(),
                'name': name,
                'pricing_name': name,
                'file': filename,
                'exclusive': exclusive,
                'proposal_state': 'processing',
                'proposal_user_id': user_id,
                'proposal_request_id': request_id,
                'proposal_cost': cost,
                'proposal_balance_after': balance_after,
                'created_at': datetime.now(timezone.utc),
            }
            if asset_type == 'sound':
                asset.update({'display_name': display_name, 'loudness': loudness})
            collection.insert_one(asset)
            ownership['asset_id'] = asset['_id']
            ensure_asset_ownership(ownership)
            ownership_added = True
            result = collection.update_one(
                {'_id': asset['_id'], 'proposal_state': 'processing'},
                {'$set': {'proposal_state': 'complete'}},
            )
            if not getattr(result, 'matched_count', 0):
                raise RuntimeError('Proposal asset could not be finalized')
            asset['proposal_state'] = 'complete'
            completed = True
            record_point_transaction(
                user_id,
                transaction_id,
                f'{asset_type}_proposal',
                -cost,
                balance_after,
                asset_id=asset['_id'],
            )
            if charged:
                colusers.update_one(
                    {'_id': user_id, 'pending_point_operation': operation_id},
                    {'$unset': {'pending_point_operation': ''}},
                )
            current_user = colusers.find_one({'_id': user_id}) or account
            broadcast_proposed_asset(asset_type, asset, socketio)
            label = asset.get('display_name') or asset.get('name')
            article = 'an' if asset_type == 'emoji' else 'a'
            emit_chat_activity(
                socketio,
                f"added {article} {asset_type}: {label}.",
                actor=account['username'],
            )
            return jsonify({
                'status': 'ok',
                'points': current_user.get('points', balance_after),
                'asset': serialize_asset(asset, asset_type, pricing),
            }), 201
        except ValueError as error:
            rollback_proposal()
            return jsonify({'status': 'error', 'message': str(error)}), 400
        except Exception:
            rollback_proposal()
            logger.exception(
                'Could not submit %s proposal for account %s',
                asset_type,
                user_id,
            )
            return jsonify({
                'status': 'error',
                'message': 'Proposal could not be confirmed. Retry shortly.',
            }), 503
        finally:
            if temp_path and os.path.exists(temp_path):
                os.remove(temp_path)

    @app.route('/soundboardlist')
    @require_login
    def soundboardlist():
        account = get_session_user()
        try:
            pricing = load_point_pricing()
            assets = list_usable_assets(account, 'sound')
            favorite_documents = list(colsoundfavorites.find({'user_id': account['_id']}))
            def favorite_added_order(item):
                created_at = item.get('created_at')
                if not isinstance(created_at, datetime):
                    created_at = datetime.min.replace(tzinfo=timezone.utc)
                elif created_at.tzinfo is None:
                    created_at = created_at.replace(tzinfo=timezone.utc)
                else:
                    created_at = created_at.astimezone(timezone.utc)
                return created_at, str(item.get('_id', ''))

            favorite_documents.sort(key=favorite_added_order)
            favorite_order = {
                str(item['asset_id']): position
                for position, item in enumerate(favorite_documents)
            }
            assets.sort(key=lambda asset: (
                (0, favorite_order[str(asset['_id'])])
                if str(asset['_id']) in favorite_order
                else (
                    1,
                    str(asset.get('display_name') or asset['name']).casefold(),
                    asset['name'].casefold(),
                )
            ))
            result = []
            for asset in assets:
                item = serialize_asset(asset, 'sound', pricing)
                item['favorite'] = str(asset['_id']) in favorite_order
                item['play_cost'] = get_action_cost(
                    'soundmeme',
                    account,
                    sound_asset=asset,
                    pricing=pricing,
                )
                result.append(item)
            return jsonify(result)
        except ValueError as error:
            return jsonify({'message': str(error)}), 503
        except Exception:
            logger.exception("Could not load usable sounds for account %s", account.get('_id'))
            return jsonify({'message': 'Usable sounds could not be loaded'}), 503

    @app.route('/soundboard/favorites', methods=['POST'])
    @require_login
    def soundboardfavorites():
        account = get_session_user()
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({'message': 'Request body must be an object'}), 400
        asset_id = data.get('asset_id')
        favorite = data.get('favorite')
        if not isinstance(asset_id, str) or not ObjectId.is_valid(asset_id):
            return jsonify({'message': 'Select a valid sound'}), 400
        if not isinstance(favorite, bool):
            return jsonify({'message': 'Favorite must be true or false'}), 400
        try:
            asset = colsounds.find_one({'_id': ObjectId(asset_id)})
            if not asset:
                return jsonify({'message': 'Sound is no longer available'}), 404
            if not can_use_asset(account, 'sound', asset):
                return jsonify({'message': 'You do not own this sound'}), 403
            favorite_query = {'user_id': account['_id'], 'asset_id': asset['_id']}
            if favorite:
                try:
                    colsoundfavorites.insert_one({
                        **favorite_query,
                        'created_at': datetime.now(timezone.utc),
                    })
                except DuplicateKeyError:
                    pass
            else:
                colsoundfavorites.delete_one(favorite_query)
            return jsonify({'favorite': favorite})
        except Exception:
            logger.exception("Could not update sound favorite for account %s", account.get('_id'))
            return jsonify({'message': 'Sound favorite could not be updated'}), 503

    @app.route('/debug/routes')
    def debugroutes():
        return jsonify([f"{rule.rule} {rule.methods}" for rule in app.url_map.iter_rules()])