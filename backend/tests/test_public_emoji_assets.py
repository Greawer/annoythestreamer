import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import routes


class PublicAssetRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__, static_folder=None)
        routes.registerroutes(self.app, None)
        self.client = self.app.test_client()
        self.public_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.public_dir.cleanup)
        self.emoji_path = Path(self.public_dir.name) / 'img' / 'emoji'
        self.emoji_path.mkdir(parents=True)
        (self.emoji_path / 'sample.png').write_bytes(b'png emoji')
        (self.emoji_path / 'sample.jpg').write_bytes(b'jpg emoji')
        (self.emoji_path / 'not-an-emoji.txt').write_text('ignored')
        self.emoji_dir_patch = patch.object(routes, 'EMOJIDIR', str(self.emoji_path))
        self.emoji_dir_patch.start()
        self.addCleanup(self.emoji_dir_patch.stop)
        self.public_dir_patch = patch.object(routes, 'PUBLIC_DIR', self.public_dir.name)
        self.public_dir_patch.start()
        self.addCleanup(self.public_dir_patch.stop)
        self.soundboard_path = Path(self.public_dir.name) / 'sounds' / 'soundboard'
        self.soundboard_path.mkdir(parents=True)

    def test_emoji_api_lists_and_resolves_public_assets(self):
        response = self.client.get('/api/list-emojis')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.get_json()), {'sample'})

        response = self.client.get('/emoji/sample')
        self.assertEqual(response.get_json(), {'url': '/static/img/emoji/sample.jpg'})

    def test_emoji_static_route_serves_shared_public_directory(self):
        with self.client.get('/static/img/emoji/sample.png') as response:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data, b'png emoji')

    def test_tts_playback_url_serves_generated_public_audio(self):
        tts_path = Path(self.public_dir.name) / 'sounds' / 'tts' / 'generated_tts.mp3'
        tts_path.parent.mkdir(parents=True)
        tts_path.write_bytes(b'generated audio')
        with self.client.get('/static/sounds/tts/generated_tts.mp3') as response:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data, b'generated audio')

    def test_soundboard_listing_and_static_route_use_public_directory(self):
        sound_path = self.soundboard_path / 'sample.mp3'
        sound_path.write_bytes(b'test audio')
        with patch.object(routes, 'SOUNDDIR', str(self.soundboard_path)):
            with self.client.get('/soundboardlist') as listing:
                self.assertEqual(
                    listing.get_json(),
                    [{
                        'file': 'sample.mp3',
                        'title': 'sample',
                        'url': '/static/sounds/soundboard/sample.mp3',
                    }],
                )

        with self.client.get('/static/sounds/soundboard/sample.mp3') as response:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data, b'test audio')

if __name__ == '__main__':
    unittest.main()
