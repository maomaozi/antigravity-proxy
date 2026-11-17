"""Run with AGY_PATCH_TEST_BINARY pointing to an unmodified ARM64 agy."""

import contextlib
import importlib.util
import io
import mmap
import os
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location(
    "agy_700k", Path(__file__).resolve().parents[2] / "scripts/agy_700k.py")
patcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(patcher)


class ProfileTests(unittest.TestCase):
    def test_only_top_level_checkpoint_budget_changes(self):
        image = (
            b'"model_profiles": {"MODEL_TEST": {'
            b'"CASCADE_USE_EXPERIMENT_CHECKPOINTER": '
            b'{"max_token_limit": "256000", "nested": {"max_token_limit": 256000}, '
            b'"prompt": "256000"}}}')
        edits = patcher.profile_edits(image, 256000, 700000)
        self.assertEqual(len(edits), 1)
        pos, before, after, _ = edits[0]
        result = image[:pos] + after + image[pos + len(before):]
        self.assertIn(b'"max_token_limit": "700000"', result)
        self.assertIn(b'"nested": {"max_token_limit": 256000}', result)
        self.assertIn(b'"prompt": "256000"', result)

    def test_duplicate_json_keys_are_rejected(self):
        image = b'"model_profiles": {"MODEL_TEST": {}, "MODEL_TEST": {}}'
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            patcher.profile_edits(image, 256000, 700000)


@unittest.skipUnless(os.environ.get("AGY_PATCH_TEST_BINARY"), "Set AGY_PATCH_TEST_BINARY for ELF integration tests")
class BinaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = Path(os.environ["AGY_PATCH_TEST_BINARY"])
        cls.digest = patcher.file_hash(cls.source)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agy-700k-test-")
        self.addCleanup(self.temp.cleanup)
        self.target = Path(self.temp.name) / "agy"
        self.state = Path(self.temp.name) / "state"
        shutil.copy2(self.source, self.target)

    def run_action(self, action):
        with contextlib.redirect_stdout(io.StringIO()):
            patcher.run(self.target, action, self.state)

    def test_full_round_trip_changes_only_planned_bytes(self):
        with self.source.open("rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
            start, end = patcher.checkpoint_function(data)
            self.assertGreater(end, start)
            edits = patcher.locate(data, 256000, 700000)
        self.run_action("check")
        self.assertFalse(self.state.exists())
        self.run_action("apply")
        changed = patcher.file_hash(self.target)
        self.assertNotEqual(changed, self.digest)
        self.assertEqual(self.source.stat().st_size, self.target.stat().st_size)
        self.assertEqual(self.source.stat().st_mode & 0o7777, self.target.stat().st_mode & 0o7777)
        self.assertEqual(patcher.file_hash(self.state / (self.digest + ".original")), self.digest)
        # Independently compare the entire image in bounded blocks.
        with self.source.open("rb") as original, self.target.open("rb") as result:
            offset = 0
            while block := original.read(1024 * 1024):
                expected = bytearray(block)
                for pos, before, after, _ in edits:
                    lo, hi = max(offset, pos), min(offset + len(block), pos + len(before))
                    if lo < hi:
                        expected[lo - offset:hi - offset] = after[lo - pos:hi - pos]
                self.assertEqual(result.read(len(block)), expected)
                offset += len(block)
        self.run_action("check")
        self.run_action("apply")
        self.assertEqual(patcher.file_hash(self.target), changed)
        if platform.machine() in ("aarch64", "arm64"):
            smoke = subprocess.run([str(self.target), "--version"], capture_output=True, text=True, timeout=15)
            self.assertEqual(smoke.returncode, 0, smoke.stderr)
            self.assertTrue(smoke.stdout.strip())
        self.run_action("restore")
        self.assertEqual(patcher.file_hash(self.target), self.digest)
        self.run_action("restore")
        self.assertEqual(patcher.file_hash(self.target), self.digest)

    def test_unrecognized_clamp_is_rejected_without_replacement(self):
        with self.target.open("rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
            pos = patcher.code_edits(data, 256000, 700000)[0][0]
        with self.target.open("r+b") as stream:
            stream.seek(pos + 8)  # The comparison instruction, not a constant.
            stream.write(struct.pack("<I", 0xD503201F))
        digest = patcher.file_hash(self.target)
        with self.assertRaisesRegex(ValueError, "verified.*clamp"):
            self.run_action("apply")
        self.assertEqual(patcher.file_hash(self.target), digest)
        self.assertFalse(self.state.exists())

    def test_other_architecture_is_rejected_without_replacement(self):
        with self.target.open("r+b") as stream:
            stream.seek(18)
            stream.write(struct.pack("<H", 62))  # EM_X86_64.
        digest = patcher.file_hash(self.target)
        with self.assertRaisesRegex(ValueError, "ARM64"):
            self.run_action("apply")
        self.assertEqual(patcher.file_hash(self.target), digest)
        self.assertFalse(self.state.exists())

    def test_corrupt_receipt_cannot_restore_arbitrary_bytes(self):
        self.run_action("apply")
        digest = patcher.file_hash(self.target)
        receipt = patcher.receipt_path(self.state, digest)
        saved = patcher.json.loads(receipt.read_text())
        saved["original"] = "0" * 64
        receipt.write_text(patcher.json.dumps(saved))
        with self.assertRaisesRegex(ValueError, "original SHA-256"):
            self.run_action("restore")
        self.assertEqual(patcher.file_hash(self.target), digest)


if __name__ == "__main__":
    unittest.main()
