import argparse
import json
import os
from pathlib import Path
import tempfile
import unittest

import manage


class ToolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.common = {
            "root": self.root / "stage",
            "media_uid": os.geteuid(),
            "homeai_uid": os.geteuid(),
            "registry": self.root / "services.json",
            "media_port": 29094,
            "media_streaming": False,
            "homeai_port": 29095,
        }

    def call(self, command, **kw):
        args = argparse.Namespace(command=command, **{**self.common, **kw})
        return manage.registry(args)

    def test_stage_twice_and_tamper(self):
        args = argparse.Namespace(root=self.common["root"], repo=manage.REPO)
        first = manage.stage(args)
        self.assertEqual(first, manage.stage(args))
        staged = args.root / "releases" / first["release"] / "media/wanx_media/app.py"
        staged.write_text("changed")
        with self.assertRaisesRegex(ValueError, "source mismatch"):
            manage.stage(args)

    def test_registry_merge_remove_and_keys(self):
        path = self.common["registry"]
        original = {
            "schemaVersion": 1,
            "services": {"existing.notes": {"upstream": "http://127.0.0.1:39000"}},
        }
        path.write_text(json.dumps(original))
        path.chmod(0o600)
        self.call("register")
        expected = path.read_bytes()
        self.call("register")
        self.assertEqual(expected, path.read_bytes())
        merged = json.loads(expected)
        self.assertEqual(
            merged["services"]["existing.notes"], original["services"]["existing.notes"]
        )
        for name in ("wanx.media", "wanx.homeai"):
            key = Path(merged["services"][name]["servicePublicKeyFile"])
            self.assertEqual(key.stat().st_mode & 0o777, 0o600)
            self.assertEqual(len(key.read_bytes()), 32)
        self.call("unregister")
        self.call("unregister")
        self.assertEqual(json.loads(path.read_bytes()), original)

    def test_streaming_registration_is_limited_to_media_and_opt_in(self):
        path = self.common["registry"]
        self.call("register")
        default = json.loads(path.read_bytes())["services"]
        self.assertFalse(default["wanx.media"]["routes"][0]["websocket"])
        self.call("unregister")

        self.call("register", media_streaming=True)
        enabled = json.loads(path.read_bytes())["services"]
        self.assertTrue(enabled["wanx.media"]["routes"][0]["websocket"])
        self.assertFalse(enabled["wanx.homeai"]["routes"][0]["websocket"])
        self.call("unregister")

    def test_port_or_ownership_collision_preserved(self):
        path = self.common["registry"]
        self.call("register")
        initial = path.read_bytes()
        alt = {**self.common, "root": self.root / "other"}
        with self.assertRaisesRegex(ValueError, "another installation"):
            self.call("register", **alt)
        self.assertEqual(path.read_bytes(), initial)
        value = json.loads(initial)
        value["services"]["wanx.media"]["enabled"] = False
        path.write_bytes(manage.json_bytes(value))
        with self.assertRaisesRegex(ValueError, "outside"):
            self.call("unregister")
        self.assertIn("wanx.media", json.loads(path.read_bytes())["services"])
        with self.assertRaisesRegex(ValueError, "distinct"):
            manage.ports(argparse.Namespace(media_port=20000, homeai_port=20000))

    def test_model_integrity(self):
        folder = self.root / "model"
        folder.mkdir()
        (folder / "model.bin").write_bytes(b"test-fixture")
        opts = {
            "model_dir": folder,
            "manifest": self.root / "manifest.json",
            "engine": "asr",
            "source": "fixture",
            "license": "test-only",
            "revision": "synthetic-revision",
        }
        result = manage.model(argparse.Namespace(command="model-manifest", **opts))
        check = argparse.Namespace(
            command="model-verify", expected_sha256=result["manifestSha256"], **opts
        )
        self.assertTrue(manage.model(check)["verified"])
        (folder / "model.bin").write_bytes(b"altered")
        with self.assertRaisesRegex(ValueError, "approved manifest"):
            manage.model(check)


if __name__ == "__main__":
    unittest.main()
