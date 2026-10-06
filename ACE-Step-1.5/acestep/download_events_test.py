"""Tests for download_events: the machine-readable download events the Studio reads on standard output."""

import contextlib
import importlib.util
import io
import json
import os
import socketserver
import sys
import tempfile
import threading
import time
import unittest
import http.server
from unittest import mock


def _load():
    spec = importlib.util.spec_from_file_location(
        "download_events_under_test", os.path.join(os.path.dirname(__file__), "download_events.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


events = _load()

try:
    from huggingface_hub.utils import tqdm as hf_bar

    _HAS_HF = isinstance(hf_bar, type)
except Exception:  # pragma: no cover - depends on the environment
    hf_bar = None
    _HAS_HF = False


def _capture(function, *args, **kwargs):
    """Run ``function`` and return (its result, the list of decoded events printed on stdout)."""
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        result = function(*args, **kwargs)
    decoded = []
    for line in buffer.getvalue().splitlines():
        if line.startswith(events.MARKER):
            decoded.append(json.loads(line[len(events.MARKER):]))
    return result, decoded


class EmitTests(unittest.TestCase):
    def test_silent_unless_the_studio_asks(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(events.ENV_FLAG, None)
            _, decoded = _capture(events.emit, "start", "main")
        self.assertEqual(decoded, [])

    def test_writes_one_marked_json_line(self):
        with mock.patch.dict(os.environ, {events.ENV_FLAG: "1"}):
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                events.emit("start", "acestep-v15-turbo", repo="ACE-Step/Ace-Step1.5", ignored=None)
        text = buffer.getvalue()
        self.assertEqual(text.count("\n"), 1)
        self.assertTrue(text.startswith(events.MARKER))
        payload = json.loads(text[len(events.MARKER):])
        self.assertEqual(payload["event"], "start")
        self.assertEqual(payload["component"], "acestep-v15-turbo")
        self.assertEqual(payload["repo"], "ACE-Step/Ace-Step1.5")
        self.assertNotIn("ignored", payload)
        self.assertIsInstance(payload["t"], float)

    def test_a_broken_stdout_never_raises(self):
        class Broken:
            def write(self, _):
                raise OSError("closed")

            def flush(self):
                raise OSError("closed")

        with mock.patch.dict(os.environ, {events.ENV_FLAG: "1"}), contextlib.redirect_stdout(Broken()):
            events.emit("start", "main")  # must not raise


class TrackedTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, {events.ENV_FLAG: "1"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_success_emits_start_then_end_and_returns_the_result(self):
        result, decoded = _capture(events.tracked, "main", lambda: (True, "ok"), repo="r")
        self.assertEqual(result, (True, "ok"))
        self.assertEqual([e["event"] for e in decoded], ["start", "end"])
        self.assertEqual(decoded[0]["repo"], "r")
        self.assertTrue(decoded[1]["ok"])
        self.assertNotIn("error", decoded[1])

    def test_a_failed_download_reports_its_message(self):
        _, decoded = _capture(events.tracked, "main", lambda: (False, "disk full"))
        self.assertFalse(decoded[-1]["ok"])
        self.assertEqual(decoded[-1]["error"], "disk full")

    def test_an_exception_is_reraised_after_the_end_event(self):
        buffer = io.StringIO()

        def boom():
            raise RuntimeError("network down")

        with contextlib.redirect_stdout(buffer), self.assertRaises(RuntimeError):
            events.tracked("main", boom)
        last = json.loads(buffer.getvalue().splitlines()[-1][len(events.MARKER):])
        self.assertEqual(last["event"], "end")
        self.assertFalse(last["ok"])
        self.assertIn("network down", last["error"])

    def test_a_plain_return_value_counts_as_success(self):
        result, decoded = _capture(events.tracked, "main", lambda: None)
        self.assertIsNone(result)
        self.assertTrue(decoded[-1]["ok"])


@unittest.skipUnless(_HAS_HF, "huggingface_hub is not installed")
class ByteObserverTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, {events.ENV_FLAG: "1"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_reports_the_cumulative_bytes_of_byte_bars(self):
        def download():
            with events.observe_bytes("acestep-v15-turbo", min_interval=0):
                bar = hf_bar(unit="B", total=100, desc="model.safetensors", unit_scale=True, disable=True)
                bar.update(40)
                bar.update(60)
                bar.close()

        _, decoded = _capture(download)
        byte_events = [e for e in decoded if e["event"] == "bytes"]
        self.assertGreaterEqual(len(byte_events), 3)
        # The first event comes with the bar itself: the total is announced before any byte has arrived, which
        # matters with Xet (nothing for several seconds, then bursts).
        self.assertEqual((byte_events[0]["done"], byte_events[0]["total"]), (0, 100))
        self.assertIn(40, [e["done"] for e in byte_events])
        self.assertEqual(byte_events[-1]["done"], 100)
        self.assertEqual(byte_events[-1]["total"], 100)
        self.assertTrue(all(e["component"] == "acestep-v15-turbo" for e in byte_events))
        cumulative = [e["done"] for e in byte_events]
        self.assertEqual(cumulative, sorted(cumulative))

    def test_sums_several_files_downloaded_in_parallel(self):
        def download():
            with events.observe_bytes("main", min_interval=0):
                first = hf_bar(unit="B", total=300, disable=True)
                second = hf_bar(unit="B", total=200, disable=True)
                first.update(100)
                second.update(50)
                first.close()
                second.close()

        _, decoded = _capture(download)
        last = [e for e in decoded if e["event"] == "bytes"][-1]
        self.assertEqual((last["done"], last["total"], last["files"]), (150, 500, 2))

    def test_ignores_bars_that_count_files_not_bytes(self):
        def download():
            with events.observe_bytes("main", min_interval=0):
                files = hf_bar(unit="it", total=14, disable=True)
                files.update(3)
                files.close()

        _, decoded = _capture(download)
        self.assertEqual([e for e in decoded if e["event"] == "bytes"], [])

    def test_throttles_bursts_but_always_reports_the_final_value(self):
        def download():
            with events.observe_bytes("main", min_interval=60):
                bar = hf_bar(unit="B", total=1000, disable=True)
                for _ in range(50):
                    bar.update(20)
                bar.close()

        _, decoded = _capture(download)
        byte_events = [e for e in decoded if e["event"] == "bytes"]
        self.assertLessEqual(len(byte_events), 3)
        self.assertEqual(byte_events[-1]["done"], 1000)

    def test_restores_the_progress_bar_class(self):
        before = (hf_bar.__init__, hf_bar.update, hf_bar.close)
        with events.observe_bytes("main"):
            during = (hf_bar.__init__, hf_bar.update, hf_bar.close)
        after = (hf_bar.__init__, hf_bar.update, hf_bar.close)
        self.assertNotEqual(before, during)
        self.assertEqual(before, after)

    def test_restores_the_class_even_when_the_download_fails(self):
        before = (hf_bar.__init__, hf_bar.update, hf_bar.close)
        with self.assertRaises(ValueError), events.observe_bytes("main"):
            raise ValueError("boom")
        self.assertEqual(before, (hf_bar.__init__, hf_bar.update, hf_bar.close))

    def test_nested_observers_do_not_wrap_twice(self):
        with events.observe_bytes("outer", min_interval=0):
            wrapped_once = hf_bar.update
            with events.observe_bytes("inner", min_interval=0):
                self.assertIs(hf_bar.update, wrapped_once)

    def test_is_inert_when_events_are_not_requested(self):
        os.environ.pop(events.ENV_FLAG, None)
        before = hf_bar.update
        with events.observe_bytes("main"):
            self.assertIs(hf_bar.update, before)

    def test_survives_a_missing_huggingface_hub(self):
        with mock.patch.dict(sys.modules, {"huggingface_hub.utils": None}):
            with events.observe_bytes("main"):
                pass  # must neither raise nor print


@unittest.skipUnless(_HAS_HF, "huggingface_hub is not installed")
class RealClassicDownloadTests(unittest.TestCase):
    """The observer seen through huggingface_hub's own classic download function and a real local HTTP server."""

    def test_follows_a_real_download_up_to_its_total(self):
        total, chunk = 45_000_000, 5_000_000

        class Slow(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                self.send_response(200)
                self.send_header("Content-Length", str(total))
                self.end_headers()
                sent = 0
                while sent < total:
                    self.wfile.write(b"x" * chunk)
                    self.wfile.flush()
                    sent += chunk
                    time.sleep(0.02)

            def log_message(self, *args):
                pass

        server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Slow)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        try:
            from huggingface_hub.file_download import http_get
        except Exception:  # pragma: no cover
            self.skipTest("http_get is not importable")
        url = f"http://127.0.0.1:{server.server_address[1]}/file"
        target = tempfile.NamedTemporaryFile(delete=False)
        self.addCleanup(lambda: os.unlink(target.name))

        def download():
            with mock.patch.dict(os.environ, {events.ENV_FLAG: "1"}):
                with events.observe_bytes("vae", min_interval=0):
                    http_get(url, target, expected_size=total, displayed_filename="vae/model.safetensors")

        try:
            _, decoded = _capture(download)
        except TypeError:  # pragma: no cover - another huggingface_hub signature
            self.skipTest("unexpected http_get signature")
        byte_events = [e for e in decoded if e["event"] == "bytes"]
        self.assertGreaterEqual(len(byte_events), 3)
        self.assertEqual(byte_events[-1]["done"], total)
        self.assertEqual(byte_events[-1]["total"], total)
        cumulative = [e["done"] for e in byte_events]
        self.assertEqual(cumulative, sorted(cumulative))


def _load_downloader():
    """The real downloader, loaded on its own (as ACE-Step's own downloader tests do)."""
    spec = importlib.util.spec_from_file_location(
        "model_downloader_with_events", os.path.join(os.path.dirname(__file__), "model_downloader.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


try:
    downloader = _load_downloader()
except Exception:  # pragma: no cover - loguru missing, or the downloader predates the events
    downloader = None


@unittest.skipUnless(downloader is not None and hasattr(downloader, "_events"), "the downloader does not use events")
@unittest.skipUnless(_HAS_HF, "huggingface_hub is not installed")
class DownloaderIntegrationTests(unittest.TestCase):
    """The real downloader functions, with a fake network, emit the events the Studio relies on."""

    def setUp(self):
        patcher = mock.patch.dict(os.environ, {events.ENV_FLAG: "1"})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.checkpoints = __import__("pathlib").Path(self.tmp.name)
        downloader._can_access_google = lambda *a, **k: True
        downloader._sync_model_code_files = lambda *a, **k: []

    def _fake_snapshot(self, folders):
        def snapshot_download(repo_id, local_dir, **kwargs):
            for folder in folders:
                (self.checkpoints / folder).mkdir(parents=True, exist_ok=True)
                (self.checkpoints / folder / "model.safetensors").write_text("x")
            return str(local_dir)

        return snapshot_download

    def _sequence(self, decoded):
        return [(e["event"], e["component"]) for e in decoded if e["event"] in ("start", "end")]

    def test_on_demand_folder_reports_start_and_end(self):
        import huggingface_hub

        with mock.patch.object(huggingface_hub, "snapshot_download", self._fake_snapshot(["acestep-v15-turbo"])):
            (ok, _), decoded = _capture(downloader.download_main_subfolder, "acestep-v15-turbo", self.checkpoints)
        self.assertTrue(ok)
        self.assertEqual(self._sequence(decoded), [("start", "acestep-v15-turbo"), ("end", "acestep-v15-turbo")])
        self.assertTrue([e for e in decoded if e["event"] == "end"][0]["ok"])
        self.assertEqual(decoded[0]["repo"], downloader.MAIN_MODEL_REPO)

    def test_a_failing_on_demand_folder_reports_the_error(self):
        import huggingface_hub

        def broken(*args, **kwargs):
            raise OSError("No space left on device")

        with mock.patch.object(huggingface_hub, "snapshot_download", broken):
            (ok, message), decoded = _capture(downloader.download_main_subfolder, "acestep-v15-turbo", self.checkpoints)
        self.assertFalse(ok)
        end = [e for e in decoded if e["event"] == "end"][0]
        self.assertFalse(end["ok"])
        self.assertIn("No space left", end["error"])

    def test_a_first_launch_reports_the_main_bundle_then_the_dit(self):
        import huggingface_hub

        def smart_download(repo, target, token=None, prefer_source=None):
            for folder in ("vae", "Qwen3-Embedding-0.6B"):
                (self.checkpoints / folder).mkdir(parents=True, exist_ok=True)
                (self.checkpoints / folder / "model.safetensors").write_text("x")
            return True, "ok"

        def first_launch():
            if not downloader.check_main_model_exists(self.checkpoints):
                downloader.ensure_main_model(self.checkpoints, prefer_source="huggingface")
            return downloader.ensure_dit_model("acestep-v15-turbo", self.checkpoints, prefer_source="huggingface")

        with mock.patch.object(downloader, "_smart_download", smart_download), \
                mock.patch.object(huggingface_hub, "snapshot_download", self._fake_snapshot(["acestep-v15-turbo"])):
            (ok, _), decoded = _capture(first_launch)
        self.assertTrue(ok)
        self.assertEqual(
            self._sequence(decoded),
            [("start", "main"), ("end", "main"), ("start", "acestep-v15-turbo"), ("end", "acestep-v15-turbo")],
        )

    def test_a_named_submodel_uses_its_own_name_as_component(self):
        def smart_download(repo, target, token=None, prefer_source=None):
            target.mkdir(parents=True, exist_ok=True)
            (target / "model.safetensors").write_text("x")
            return True, "ok"

        with mock.patch.object(downloader, "_smart_download", smart_download):
            (ok, _), decoded = _capture(downloader.download_submodel, "acestep-5Hz-lm-0.6B", self.checkpoints, prefer_source="huggingface")
        self.assertTrue(ok)
        self.assertEqual(self._sequence(decoded), [("start", "acestep-5Hz-lm-0.6B"), ("end", "acestep-5Hz-lm-0.6B")])

    def test_nothing_is_printed_when_the_studio_did_not_ask(self):
        import huggingface_hub

        os.environ.pop(events.ENV_FLAG, None)
        with mock.patch.object(huggingface_hub, "snapshot_download", self._fake_snapshot(["acestep-v15-turbo"])):
            (ok, _), decoded = _capture(downloader.download_main_subfolder, "acestep-v15-turbo", self.checkpoints)
        self.assertTrue(ok)
        self.assertEqual(decoded, [])


if __name__ == "__main__":
    unittest.main()
