#!/usr/bin/env python3
"""Local Speech-to-Text server built on Vosk.

Kanna keeps a single process running and sends microphone audio to it as PCM
chunks, so the acoustic model is loaded only once.
"""

import argparse
import io
import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import vosk


class State:
    def __init__(self):
        self.model = None
        self.sessions = {}
        self.lock = threading.Lock()


STATE = State()


def make_handler():
    class Handler(BaseHTTPRequestHandler):
        server_version = "KannaSTT/1.0"

        def log_message(self, *args, **kwargs):
            return

        def _send_json(self, status, payload):
            data = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _body(self):
            length = int(self.headers.get("Content-Length", "0"))
            return self.rfile.read(length) if length > 0 else b""

        def _query(self):
            from urllib.parse import parse_qs, urlparse
            return parse_qs(urlparse(self.path).query)

        def do_GET(self):
            if self.path.rstrip("/") == "/health":
                self._send_json(200, {"ok": True})
            else:
                self._send_json(404, {"error": "not found"})

        def do_POST(self):
            route = self.path.split("?", 1)[0].rstrip("/")
            try:
                if route == "/start":
                    payload = json.loads(self._body() or b"{}")
                    sample_rate = float(payload.get("sampleRate", 16000))
                    session_id = uuid.uuid4().hex
                    recognizer = vosk.KaldiRecognizer(STATE.model, sample_rate)
                    with STATE.lock:
                        STATE.sessions[session_id] = recognizer
                    self._send_json(200, {"sessionId": session_id})
                    return

                if route == "/audio":
                    qs = self._query()
                    session_id = (qs.get("session") or [""])[0]
                    with STATE.lock:
                        recognizer = STATE.sessions.get(session_id)
                    if recognizer is None:
                        self._send_json(404, {"error": "session not found"})
                        return
                    pcm = self._body()
                    recognizer.AcceptWaveform(pcm)
                    partial = json.loads(recognizer.PartialResult())
                    self._send_json(200, {"partial": partial.get("partial", "")})
                    return

                if route == "/finish":
                    qs = self._query()
                    session_id = (qs.get("session") or [""])[0]
                    with STATE.lock:
                        recognizer = STATE.sessions.pop(session_id, None)
                    if recognizer is None:
                        self._send_json(404, {"error": "session not found"})
                        return
                    final = json.loads(recognizer.FinalResult())
                    self._send_json(200, {"text": final.get("text", "")})
                    return

                if route == "/cancel":
                    qs = self._query()
                    session_id = (qs.get("session") or [""])[0]
                    with STATE.lock:
                        STATE.sessions.pop(session_id, None)
                    self._send_json(200, {"ok": True})
                    return

                self._send_json(404, {"error": "not found"})
            except Exception as exc:
                self._send_json(500, {"error": str(exc)})

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="", help="Path to an unpacked Vosk model directory")
    parser.add_argument("--lang", default="en-us", help="Language used for auto-download")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()

    if args.model:
        STATE.model = vosk.Model(args.model)
    else:
        STATE.model = vosk.Model(model_name='vosk-model-small-en-us-0.15')

    handler = make_handler()
    httpd = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"READY http://{args.host}:{httpd.server_port}", flush=True)
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR {exc}", file=__import__("sys").stderr, flush=True)
        raise