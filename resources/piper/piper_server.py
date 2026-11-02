#!/usr/bin/env python3
"""Local HTTP server around piper-tts.

Kanna starts this process once and reuses it for every Piper utterance, so the
ONNX model is loaded a single time instead of on every TTS call.
"""

import argparse
import io
import json
import sys
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from piper import PiperVoice, SynthesisConfig


def make_handler(voice):
    class Handler(BaseHTTPRequestHandler):
        server_version = "KannaPiper/1.0"

        def log_message(self, *args, **kwargs):
            # Keep stdout clean so Kanna can read the READY line.
            return

        def _send_json(self, status, payload):
            data = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path.rstrip("/") == "/health":
                self._send_json(200, {"ok": True})
            else:
                self._send_json(404, {"error": "not found"})

        def do_POST(self):
            if self.path.rstrip("/") not in ("/tts", "/synthesize"):
                self._send_json(404, {"error": "not found"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length > 0 else b"{}"
                payload = json.loads(raw.decode("utf-8"))
            except Exception as exc:
                self._send_json(400, {"error": f"bad request: {exc}"})
                return

            text = str(payload.get("text", "")).strip()
            if not text:
                self._send_json(400, {"error": "text required"})
                return

            try:
                speaker = payload.get("speaker", payload.get("speaker_id", 0))
                speaker_id = int(speaker) if speaker is not None and str(speaker).strip() != "" else 0
            except (TypeError, ValueError):
                speaker_id = 0

            try:
                buf = io.BytesIO()
                with wave.open(buf, "wb") as wav_file:
                    voice.synthesize_wav(
                        text,
                        wav_file,
                        syn_config=SynthesisConfig(speaker_id=speaker_id),
                        set_wav_format=True,
                    )
                data = buf.getvalue()
            except Exception as exc:
                self._send_json(500, {"error": f"synthesis failed: {exc}"})
                return

            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="Path to .onnx Piper model")
    parser.add_argument("--speaker", default="", help="Default speaker (optional)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0, help="0 lets the OS choose")
    args = parser.parse_args()

    # Model loading is the slow part; do it before binding/serving.
    voice = PiperVoice.load(args.model)

    handler = make_handler(voice)
    httpd = ThreadingHTTPServer((args.host, args.port), handler)
    actual_port = httpd.server_port
    print(f"READY http://{args.host}:{actual_port}", flush=True)
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR {exc}", file=sys.stderr, flush=True)
        raise