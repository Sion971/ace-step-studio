"""Tests for the on-demand folders of the main repo (2B turbo DiT, 1.7B LM) in model_downloader."""

import importlib.util
import os
import sys
import tempfile
import types
import unittest
from fnmatch import fnmatch
from pathlib import Path

# Composition MESUREE du depot ACE-Step/Ace-Step1.5 (Go).
MAIN_REPO = {"acestep-v15-turbo": 4.46, "acestep-5Hz-lm-1.7B": 3.50, "Qwen3-Embedding-0.6B": 1.12, "vae": 0.31}


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "model_downloader_on_demand", os.path.join(os.path.dirname(__file__), "model_downloader.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _FakeHub:
    """Stand-in for huggingface_hub.snapshot_download that honours allow/ignore patterns."""

    def __init__(self):
        self.calls = []

    def install(self):
        hub = types.ModuleType("huggingface_hub")
        hub.snapshot_download = self.snapshot_download
        self._previous = sys.modules.get("huggingface_hub")
        sys.modules["huggingface_hub"] = hub

    def uninstall(self):
        if self._previous is None:
            sys.modules.pop("huggingface_hub", None)
        else:
            sys.modules["huggingface_hub"] = self._previous

    def snapshot_download(self, repo_id, local_dir, allow_patterns=None, ignore_patterns=None, **kwargs):
        self.calls.append({"repo": repo_id, "allow": allow_patterns, "ignore": ignore_patterns})
        local_dir = Path(local_dir)
        local_dir.mkdir(parents=True, exist_ok=True)
        if repo_id == "ACE-Step/Ace-Step1.5":
            for folder in MAIN_REPO:
                name = folder + "/model.safetensors"
                if allow_patterns and not any(fnmatch(name, p) for p in allow_patterns):
                    continue
                if ignore_patterns and any(fnmatch(name, p) for p in ignore_patterns):
                    continue
                (local_dir / folder).mkdir(parents=True, exist_ok=True)
                (local_dir / folder / "model.safetensors").write_text("x")
        else:
            (local_dir / "model.safetensors").write_text("x")
        return str(local_dir)


class TestOnDemandFolders(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_module()

    def setUp(self):
        self.hub = _FakeHub()
        self.hub.install()
        self.addCleanup(self.hub.uninstall)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ck = Path(self.tmp.name)
        # le reseau reel (test d'acces a Google) n'a pas sa place dans un test unitaire
        self.mod._can_access_google = lambda *a, **k: True
        self.mod._sync_model_code_files = lambda *a, **k: []

    def _main_calls(self):
        return [c for c in self.hub.calls if c["repo"] == "ACE-Step/Ace-Step1.5"]

    def test_main_components_exclude_the_lm(self):
        """The 0.6B LM has its own repo; the main bundle must not wait for it."""
        self.assertNotIn("acestep-5Hz-lm-0.6B", self.mod.MAIN_MODEL_COMPONENTS)
        self.assertEqual(set(self.mod.MAIN_MODEL_COMPONENTS), {"vae", "Qwen3-Embedding-0.6B"})

    def test_main_download_skips_dit_and_large_lm(self):
        ok, _ = self.mod.ensure_main_model(self.ck, prefer_source="huggingface")
        self.assertTrue(ok)
        present = sorted(p.name for p in self.ck.iterdir() if p.is_dir() and not p.name.startswith("."))
        self.assertEqual(present, ["Qwen3-Embedding-0.6B", "vae"])
        ignored = self._main_calls()[0]["ignore"]
        for folder in ("acestep-v15-turbo", "acestep-5Hz-lm-1.7B"):
            self.assertIn(f"{folder}/*", ignored)

    def test_main_model_is_complete_without_the_lm(self):
        """With the LM off, a second launch must not need the network."""
        self.mod.ensure_main_model(self.ck, prefer_source="huggingface")
        self.assertTrue(self.mod.check_main_model_exists(self.ck))
        self.hub.calls.clear()
        self.mod.ensure_main_model(self.ck, prefer_source="huggingface")
        self.assertEqual(self.hub.calls, [])

    def test_turbo_dit_is_downloaded_on_demand(self):
        """The 2B turbo DiT used to be silently missing: 'Main model is available' without weights."""
        self.mod.ensure_main_model(self.ck, prefer_source="huggingface")
        self.assertFalse(self.mod.check_model_exists("acestep-v15-turbo", self.ck))
        ok, msg = self.mod.ensure_dit_model("acestep-v15-turbo", self.ck, prefer_source="huggingface")
        self.assertTrue(ok, msg)
        self.assertTrue(self.mod.check_model_exists("acestep-v15-turbo", self.ck))
        last = self.hub.calls[-1]
        self.assertEqual(last["allow"], ["acestep-v15-turbo/*"])
        self.assertFalse((self.ck / "acestep-5Hz-lm-1.7B").exists(), "the 1.7B LM must stay out")

    def test_second_launch_with_turbo_needs_no_network(self):
        self.mod.ensure_main_model(self.ck, prefer_source="huggingface")
        self.mod.ensure_dit_model("acestep-v15-turbo", self.ck, prefer_source="huggingface")
        self.hub.calls.clear()
        self.assertTrue(self.mod.check_main_model_exists(self.ck))
        self.assertTrue(self.mod.check_model_exists("acestep-v15-turbo", self.ck))
        ok, _ = self.mod.ensure_dit_model("acestep-v15-turbo", self.ck, prefer_source="huggingface")
        self.assertTrue(ok)
        self.assertEqual(self.hub.calls, [])

    def test_large_lm_is_available_on_demand(self):
        ok, msg = self.mod.ensure_lm_model("acestep-5Hz-lm-1.7B", self.ck, prefer_source="huggingface")
        self.assertTrue(ok, msg)
        self.assertTrue(self.mod.check_model_exists("acestep-5Hz-lm-1.7B", self.ck))
        self.assertEqual(self.hub.calls[-1]["allow"], ["acestep-5Hz-lm-1.7B/*"])

    def test_subfolder_helper_rejects_unknown_folders(self):
        ok, _ = self.mod.download_main_subfolder("not-a-folder", self.ck)
        self.assertFalse(ok)
        self.assertEqual(self.hub.calls, [])

    def test_subfolder_download_failure_is_reported_not_raised(self):
        def boom(*a, **k):
            raise OSError("network down")
        sys.modules["huggingface_hub"].snapshot_download = boom
        ok, msg = self.mod.download_main_subfolder("acestep-v15-turbo", self.ck)
        self.assertFalse(ok)
        self.assertIn("network down", msg)


if __name__ == "__main__":
    unittest.main()
