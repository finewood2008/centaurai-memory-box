import io
import os
import tempfile
import unittest
from pathlib import Path

import disk


class DiskOperations(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.root = os.open(self.path, os.O_DIRECTORY)
        self.addCleanup(os.close, self.root)

    def op(self, operation, **args):
        return disk.handle(self.root, "disk-" + operation, args)

    def test_traversal_links_and_stale_reference(self):
        for value in ("../other", "/etc", ".hidden"):
            with self.assertRaises(ValueError):
                self.op("list", parent=value)
        (self.path / "outside").symlink_to("/etc")
        with self.assertRaises(OSError):
            self.op("list", parent="outside")
        (self.path / "note.txt").write_text("abc")
        ref = self.op("list")["items"][0]
        (self.path / "note.txt").write_text("newer")
        with self.assertRaises(ValueError):
            self.op("rename", ref=ref, name="wrong.txt")

    def test_transfer_move_trash_restore(self):
        disk.receive(self.root, "", "记录.txt", io.BytesIO(b"original"), 8)
        with self.assertRaises(ValueError):
            disk.receive(self.root, "", "记录.txt", io.BytesIO(b"new"), 3)
        ref = self.op("list")["items"][0]
        self.op("rename", ref=ref, name="renamed.txt")
        ref = self.op("list")["items"][0]
        self.op("mkdir", name="目标")
        self.op("move", ref=ref, to="目标")
        ref = self.op("list", parent="目标")["items"][0]
        self.op("trash", ref=ref)
        receipt = self.op("trash-list")["items"][0]
        self.op("restore", id=receipt["id"])
        with disk.opened(self.root, ref) as (stream, size):
            self.assertEqual((stream.read(), size), (b"original", 8))
        self.assertEqual(self.op("trash-list")["items"], [])

    def test_incomplete_upload(self):
        with self.assertRaises(ValueError):
            disk.receive(self.root, "", "new.txt", io.BytesIO(b"x"), 4)
        self.assertFalse(list(self.path.iterdir()))


if __name__ == "__main__":
    unittest.main()
