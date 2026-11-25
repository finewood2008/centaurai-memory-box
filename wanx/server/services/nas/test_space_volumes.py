import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import space_volumes as volumes


class SpaceVolumes(unittest.TestCase):
    def test_only_mounted_user_usb_volumes_are_listed(self):
        from pwd import getpwuid
        owner = getpwuid(os.getuid()).pw_name
        device = {"uuid": "usb-a", "name": "sda1", "maj:min": "8:1", "label": "测试硬盘",
                  "mountpoints": [f"/media/{owner}/测试硬盘"]}
        devices = [{"tran": "usb", "mountpoints": [], "children": [device]},
                   {"tran": "usb", "mountpoints": ["/"], "children": []},
                   {**device, "tran": "nvme"}, {**device, "tran": "usb", "mountpoints": []}]
        with patch.object(volumes.subprocess, "check_output", return_value=json.dumps({"blockdevices": devices})):
            self.assertEqual(volumes.handle("volumes", {}), [{"id": "usb-a@8-1", "name": "测试硬盘"}])

    def test_versioned_edit_and_conflict(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "记录.txt"
            path.write_bytes(b"\xef\xbb\xbfhello\r\n")
            args = {"volume": "usb", "path": path.name}
            with patch.object(volumes, "mounted_volumes", return_value={"usb": ("USB",root,path.stat().st_dev)}):
                opened = volumes.handle("text-open", args)
                self.assertEqual(opened["text"], "hello\n")
                save = dict(args, text="编辑成功\n", expected=opened["version"])
                self.assertTrue(volumes.handle("text-save", save)["saved"])
                self.assertEqual(path.read_bytes(), b"\xef\xbb\xbf" + "编辑成功\r\n".encode())
                with self.assertRaisesRegex(ValueError, "SPACE_VERSION_CONFLICT"):
                    volumes.handle("text-save", dict(save, text="stale"))
                self.assertEqual(volumes.handle("text-open", args)["text"], "编辑成功\n")
                invalid = Path(root) / "test.json"
                invalid.write_text("{}")
                ref = dict(args, path=invalid.name)
                version = volumes.handle("text-open", ref)["version"]
                with self.assertRaisesRegex(ValueError, "SPACE_TEXT_JSON_INVALID"):
                    volumes.handle("text-save", dict(ref, expected=version, text="{"))
                self.assertEqual(invalid.read_text(), "{}")
                self.assertFalse(any(Path(root).glob(".memobox-edit-*")))

    def test_browse_preview_and_removal(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / "目录 & 照片"
            folder.mkdir()
            (folder / "样本.txt").write_text("盒端测试", encoding="utf8")
            (folder / "link").symlink_to(Path(root).parent)
            devices = {"a": ("测试硬盘", root, os.stat(root).st_dev)}
            with patch.object(volumes, "mounted_volumes", return_value=devices):
                query = {"volume": "a", "path": folder.name}
                self.assertEqual([x["name"] for x in volumes.handle("folder", query)["items"]], ["样本.txt"])
                self.assertEqual(volumes.handle("preview", dict(query, path=folder.name + "/样本.txt"))["text"], "盒端测试")
                for path in ("..", folder.name + "/link"):
                    with self.assertRaises((OSError, ValueError)):
                        volumes.handle("folder", dict(query, path=path))
                devices.clear()
                with self.assertRaisesRegex(ValueError, "SPACE_VOLUME_OFFLINE"):
                    volumes.handle("folder", query)


if __name__ == "__main__":
    unittest.main()
