import base64
import binascii
import hashlib
import http.client
import ipaddress
import io
import os
import re
import socket
import threading
import urllib.parse
import uuid
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps


MAX_NORMALMEME_IMAGE_BYTES = 16 * 1024 * 1024
MAX_NORMALMEME_IMAGE_PIXELS = 40_000_000
_UUID_FILENAME = re.compile(r'^[0-9a-f]{32}\.jpg$')
_DATA_URI = re.compile(
    r'^data:image/(?:jpeg|png|gif|webp|bmp);base64,([A-Za-z0-9+/]*={0,2})$',
    re.IGNORECASE,
)
_ACTIVE_FILES_LOCK = threading.Lock()


class PreparedNormalMemeImage:
    def __init__(self, jpeg_bytes, active_url):
        self.jpeg_bytes = jpeg_bytes
        self.active_url = active_url


def normalmeme_image_digest(image):
    value = image if isinstance(image, str) else ''
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def _request_id_hex(request_id):
    try:
        parsed = uuid.UUID(request_id)
    except (AttributeError, TypeError, ValueError) as error:
        raise ValueError('A valid Normalmeme request ID is required') from error
    if str(parsed) != request_id:
        raise ValueError('A valid Normalmeme request ID is required')
    return parsed.hex


def _read_image_source(image, public_dir):
    if not isinstance(image, str):
        raise ValueError('Choose a valid image or image URL')
    if len(image) > (MAX_NORMALMEME_IMAGE_BYTES * 4 // 3) + 4096:
        raise ValueError('Images must be no larger than 16 MB')

    data_match = _DATA_URI.fullmatch(image)
    if data_match:
        try:
            content = base64.b64decode(data_match.group(1), validate=True)
        except (binascii.Error, ValueError) as error:
            raise ValueError('The selected image is not valid base64 data') from error
        if len(content) > MAX_NORMALMEME_IMAGE_BYTES:
            raise ValueError('Images must be no larger than 16 MB')
        return content

    parsed = urllib.parse.urlsplit(image)
    if parsed.scheme.lower() in {'http', 'https'}:
        return _download_public_image(image)
    if parsed.scheme or parsed.netloc or not parsed.path.startswith(('/img/', '/static/')):
        raise ValueError('Choose a valid image or image URL')

    relative_path = urllib.parse.unquote(parsed.path).lstrip('/')
    if relative_path.startswith('static/'):
        relative_path = relative_path[len('static/'):]
    public_root = Path(public_dir).resolve()
    source_path = public_root / relative_path
    try:
        resolved_path = source_path.resolve(strict=True)
        try:
            common_path = os.path.commonpath((str(public_root), str(resolved_path)))
        except ValueError as error:
            raise ValueError('The image path is not available') from error
        if common_path != str(public_root):
            raise ValueError('The image path is not available')
        if not resolved_path.is_file() or resolved_path.stat().st_size > MAX_NORMALMEME_IMAGE_BYTES:
            raise ValueError('Images must be valid files no larger than 16 MB')
        return resolved_path.read_bytes()
    except (OSError, ValueError) as error:
        if isinstance(error, ValueError) and (
            str(error) == 'The image path is not available'
            or isinstance(error.__cause__, ValueError)
        ):
            raise
        raise ValueError('The local image could not be read') from error


def _download_public_image(source_url):
    for _ in range(6):
        try:
            parsed = urllib.parse.urlsplit(source_url)
            port = parsed.port
        except ValueError as error:
            raise ValueError('Enter a valid image URL') from error
        scheme = parsed.scheme.lower()
        default_port = 443 if scheme == 'https' else 80
        if (
            scheme not in {'http', 'https'}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or port not in (None, default_port)
        ):
            raise ValueError('Image URLs must use HTTP or HTTPS without credentials or a custom port')

        try:
            addresses = socket.getaddrinfo(parsed.hostname, default_port, type=socket.SOCK_STREAM)
        except (OSError, ValueError) as error:
            raise ValueError('The image URL host could not be resolved') from error
        if not addresses or any(
            not ipaddress.ip_address(address[4][0]).is_global
            for address in addresses
        ):
            raise ValueError('Image URLs must resolve only to public addresses')

        def connect(connection, secure):
            last_error = None
            for family, socket_type, protocol, _, address in addresses:
                image_socket = socket.socket(family, socket_type, protocol)
                try:
                    image_socket.settimeout(10)
                    image_socket.connect(address)
                    if secure:
                        image_socket = connection._context.wrap_socket(
                            image_socket,
                            server_hostname=parsed.hostname,
                        )
                    connection.sock = image_socket
                    return
                except OSError as error:
                    image_socket.close()
                    last_error = error
            if last_error:
                raise last_error
            raise OSError('The image URL host has no usable address')

        if scheme == 'https':
            class PinnedHTTPSConnection(http.client.HTTPSConnection):
                def connect(self):
                    connect(self, True)

            connection = PinnedHTTPSConnection(parsed.hostname, port=default_port, timeout=10)
        else:
            class PinnedHTTPConnection(http.client.HTTPConnection):
                def connect(self):
                    connect(self, False)

            connection = PinnedHTTPConnection(parsed.hostname, port=default_port, timeout=10)

        request_path = parsed.path or '/'
        if parsed.query:
            request_path = f'{request_path}?{parsed.query}'
        redirected_url = None
        try:
            connection.request(
                'GET',
                request_path,
                headers={'User-Agent': 'AnnoyTheStreamer-Normalmeme/1.0'},
            )
            with connection.getresponse() as response:
                if response.status in {301, 302, 303, 307, 308}:
                    location = response.getheader('Location')
                    if not location:
                        raise ValueError('The image URL returned an invalid redirect')
                    redirected_url = urllib.parse.urljoin(source_url, location)
                elif response.status != 200:
                    raise ValueError('The image URL did not return a successful response')
                else:
                    content = response.read(MAX_NORMALMEME_IMAGE_BYTES + 1)
        except (http.client.HTTPException, TimeoutError, OSError) as error:
            raise ValueError('The image URL could not be downloaded') from error
        finally:
            connection.close()
        if redirected_url:
            source_url = redirected_url
            continue
        if len(content) > MAX_NORMALMEME_IMAGE_BYTES:
            raise ValueError('Images must be no larger than 16 MB')
        return content
    raise ValueError('The image URL redirected too many times')


def _encode_jpeg(content):
    try:
        with Image.open(io.BytesIO(content)) as image:
            if image.format not in {'JPEG', 'PNG', 'GIF', 'WEBP', 'BMP'}:
                raise ValueError('Choose a JPEG, PNG, GIF, WebP, or BMP image')
            image = ImageOps.exif_transpose(image)
            width, height = image.size
            if width <= 0 or height <= 0 or width * height > MAX_NORMALMEME_IMAGE_PIXELS:
                raise ValueError('The image dimensions are too large')
            image.seek(0)
            image.load()
            rgba = image.convert('RGBA').resize(
                (400, 300),
                Image.Resampling.LANCZOS,
            )
    except (OSError, Image.DecompressionBombError) as error:
        raise ValueError('The selected file is not a valid supported image') from error

    background = Image.new('RGBA', (400, 300), (0, 0, 0, 255))
    background.alpha_composite(rgba)
    output = io.BytesIO()
    background.convert('RGB').save(output, format='JPEG', quality=90)
    return output.getvalue()


def _empty_meme_jpeg():
    image = Image.new('RGB', (400, 300))
    draw = ImageDraw.Draw(image)
    for y in range(300):
        shade = 51 + (51 * y // 299)
        draw.line((0, y, 399, y), fill=(shade, shade, shade))
    output = io.BytesIO()
    image.save(output, format='JPEG', quality=90)
    return output.getvalue()


def prepare_normalmeme_image(image, request_id, public_dir):
    filename = f'{_request_id_hex(request_id)}.jpg'
    if image:
        jpeg_bytes = _encode_jpeg(_read_image_source(image, public_dir))
        active_url = f'/img/meme/normalmeme/{filename}'
    else:
        jpeg_bytes = _empty_meme_jpeg()
        active_url = None
    return PreparedNormalMemeImage(jpeg_bytes, active_url)


def _ensure_directory(path):
    path = Path(path).absolute()
    path.mkdir(parents=True, exist_ok=True)
    if path.resolve() != path:
        raise ValueError('The Normalmeme storage directory must not be a symbolic link')
    return path


def _create_managed_file(path, content):
    created = False
    try:
        with path.open('xb') as output:
            created = True
            output.write(content)
        return True
    except FileExistsError:
        if path.is_symlink() or not path.is_file() or path.read_bytes() != content:
            raise ValueError('A Normalmeme storage file already exists')
        return False
    except OSError as error:
        if created:
            try:
                path.unlink()
            except FileNotFoundError:
                pass
            except OSError as cleanup_error:
                raise ValueError(
                    'A partial Normalmeme image could not be removed'
                ) from cleanup_error
        raise ValueError('Normalmeme image could not be stored') from error


def create_active_normalmeme_image(prepared, request_id, public_dir):
    if prepared.active_url is None:
        return False
    filename = f'{_request_id_hex(request_id)}.jpg'
    active_dir = _ensure_directory(Path(public_dir) / 'img' / 'meme' / 'normalmeme')
    created = _create_managed_file(active_dir / filename, prepared.jpeg_bytes)
    return created


def archive_normalmeme_image(prepared, request_id, archive_dir):
    filename = f'{_request_id_hex(request_id)}.jpg'
    archive_dir = _ensure_directory(Path(archive_dir))
    return _create_managed_file(archive_dir / filename, prepared.jpeg_bytes)


def normalmeme_archive_exists(request_id, archive_dir):
    filename = f'{_request_id_hex(request_id)}.jpg'
    archive_dir = Path(archive_dir).absolute()
    if archive_dir.resolve() != archive_dir:
        raise ValueError('The Normalmeme archive directory must not be a symbolic link')
    path = archive_dir / filename
    if path.is_symlink():
        raise ValueError('A Normalmeme archive path is not a regular file')
    return path.is_file()


def remove_active_normalmeme_image(request_id, public_dir):
    filename = f'{_request_id_hex(request_id)}.jpg'
    active_dir = Path(public_dir).absolute() / 'img' / 'meme' / 'normalmeme'
    if active_dir.resolve() != active_dir:
        raise ValueError('The Normalmeme storage directory must not be a symbolic link')
    path = active_dir / filename
    if path.is_symlink():
        raise ValueError('A Normalmeme active path is not a regular file')
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def prune_active_normalmeme_images(public_dir, keep_request_id=None):
    active_dir = Path(public_dir).absolute() / 'img' / 'meme' / 'normalmeme'
    if not active_dir.exists():
        return
    if active_dir.resolve() != active_dir:
        raise ValueError('The Normalmeme storage directory must not be a symbolic link')
    keep_filename = (
        f'{_request_id_hex(keep_request_id)}.jpg'
        if keep_request_id is not None
        else None
    )
    with _ACTIVE_FILES_LOCK:
        for path in active_dir.iterdir():
            if not _UUID_FILENAME.fullmatch(path.name) or path.name == keep_filename:
                continue
            if path.is_symlink():
                raise ValueError('A Normalmeme active path is not a regular file')
            if path.is_file():
                path.unlink()


def is_managed_active_normalmeme_image(image, request_id):
    return image == f'/img/meme/normalmeme/{_request_id_hex(request_id)}.jpg'
