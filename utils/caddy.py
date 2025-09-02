import subprocess
import logging

CADDY_PATH = r"C:\Program Files (x86)\Caddy\Caddy.exe" #Add path to Caddy.exe
CADDYFILE_PATH = r"C:\Program Files (x86)\Caddy\Caddyfile" #Add path to Caddyfile

def start_caddy():
    try:
        logging.warning("Starting Caddy...")
        process = subprocess.Popen(
            [CADDY_PATH, "run", "--config", CADDYFILE_PATH],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        return process
    except Exception as e:
        logging.error(f"Failed to start Caddy: {e}")
        return None

