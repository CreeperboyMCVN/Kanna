#!/usr/bin/env python3
"""Local HTTP server around piper-tts.

Kanna starts this process once and reuses it for every Piper utterance, so the
ONNX model is loaded a single time instead of on every TTS call.
"""

import argparse
import io
import json
import os
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from piper import PiperVoice, SynthesisConfig


class _State:
    server = None


STATE = _State()


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
            route = self.path.split("?", 1)[0].rstrip("/")
            if route == "/shutdown":
                # Lets the app stop the server cleanly: the serving process
                # exits itself, so a PyInstaller onefile parent+child pair
                # never gets left behind by an external tree kill.
                self._send_json(200, {"ok": True})
                threading.Thread(target=STATE.server.shutdown, daemon=True).start()
                return
            if route not in ("/tts", "/synthesize"):
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


def _cuda_available() -> bool:
    """True when onnxruntime actually reports a working CUDA provider."""
    try:
        import onnxruntime as ort
        return "CUDAExecutionProvider" in ort.get_available_providers()
    except Exception:
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="Path to .onnx Piper model")
    parser.add_argument("--speaker", default="", help="Default speaker (optional)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0, help="0 lets the OS choose")
    parser.add_argument("--gpu", action="store_true",
                        help="Try CUDA for ONNX inference (needs piper-tts[onnx-cuda];"
                             " falls back to CPU automatically)")
    args = parser.parse_args()

    # Model loading is the slow part; do it before binding/serving.
    # ORT only prints a UserWarning when CUDA is missing and silently serves
    # CPU — detect that here so the log tells the truth instead of claiming
    # GPU acceleration that never happens.
    if args.gpu and _cuda_available():
        voice = PiperVoice.load(args.model, use_cuda=True)
        print("GPU on (cuda)", flush=True)
    else:
        if args.gpu:
            print(" Piper: GPU requested but CUDAExecutionProvider is not available;"
                  " using CPU.", file=sys.stderr, flush=True)
        voice = PiperVoice.load(args.model)

    handler = make_handler(voice)
    httpd = ThreadingHTTPServer((args.host, args.port), handler)
    STATE.server = httpd
    actual_port = httpd.server_port
    print(f"READY http://{args.host}:{actual_port}", flush=True)
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
        os._exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR {exc}", file=sys.stderr, flush=True)
        raise