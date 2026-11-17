#!/usr/bin/env python3
"""Check, apply or restore the agy Linux ARM64 256k-to-700k checkpoint patch."""

import argparse
import hashlib
import json
import mmap
import os
from pathlib import Path
import re
import shutil
import struct
import sys
import tempfile


DEFAULT = Path(shutil.which("agy") or Path.home() / ".local/bin/agy")
STATE = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "agy-700k"
FUNCTION = b"google3/third_party/jetski/cortex/utils/utils.GetCheckpointConfig\0"
FEATURE = "CASCADE_USE_EXPERIMENT_CHECKPOINTER"
OLD, NEW = 256000, 700000
DECODER = json.JSONDecoder()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def uint32(data, offset):
    return struct.unpack_from("<I", data, offset)[0]


class ELF:
    """Resolve file-backed addresses and the few relative relocations we need."""

    def __init__(self, data):
        self.data = data
        require(len(data) >= 64 and data[:7] == b"\x7fELF\x02\x01\x01",
                "Expected a little-endian ELF64 executable.")
        kind, machine = struct.unpack_from("<HH", data, 16)
        require(kind in (2, 3) and machine == 183, "Only Linux ARM64 ELF is supported.")
        ph, sh = struct.unpack_from("<QQ", data, 32)
        phsize, phcount, shsize, shcount, names = struct.unpack_from("<5H", data, 54)
        require(phsize == 56 and shsize == 64 and 0 < names < shcount,
                "Unsupported ELF header tables.")
        require(ph + phsize * phcount <= len(data) and sh + shsize * shcount <= len(data),
                "Truncated ELF header tables.")
        self.loads = []
        for i in range(phcount):
            typ, flags, offset, address, _, size, memsize, _ = struct.unpack_from(
                "<II6Q", data, ph + i * phsize)
            if typ == 1:
                require(size <= memsize and offset + size <= len(data), "Invalid ELF load segment.")
                self.loads.append((address, offset, size, flags))
        headers = [struct.unpack_from("<II4QII2Q", data, sh + i * shsize) for i in range(shcount)]
        name_header = headers[names]
        require(name_header[1] == 3 and name_header[4] + name_header[5] <= len(data),
                "Invalid ELF section names.")
        name_data = data[name_header[4]:name_header[4] + name_header[5]]
        self.sections = {}
        self.relas = []
        for h in headers:
            name, typ, flags, address, offset, size, _, _, _, entrysize = h
            require(name < len(name_data), "Invalid ELF section name offset.")
            end = name_data.find(b"\0", name)
            require(end >= 0, "Unterminated ELF section name.")
            key = name_data[name:end]
            require(typ == 8 or offset + size <= len(data), "Truncated ELF section.")
            if key in (b".text", b".go.module"):
                require(key not in self.sections and typ == 1, "Ambiguous ELF code/module section.")
                self.sections[key] = (address, offset, size, flags)
            if typ == 4:
                require(entrysize == 24 and size % 24 == 0, "Unsupported ELF RELA table.")
                self.relas.append((offset, size))
        require(b".text" in self.sections, "Cannot locate .text.")
        require(self.sections[b".text"][3] & 4, ".text is not executable.")

    def offset(self, address, size=1):
        matches = [off + address - va for va, off, length, _ in self.loads
                   if va <= address and address + size <= va + length]
        require(len(matches) == 1, "Address is not uniquely file-backed.")
        return matches[0]

    def address(self, offset):
        matches = [va + offset - off for va, off, size, _ in self.loads if off <= offset < off + size]
        require(len(matches) == 1, "File offset has no unique virtual address.")
        return matches[0]

    def pointers(self, addresses):
        values = {a: struct.unpack_from("<Q", self.data, self.offset(a, 8))[0] for a in addresses}
        seen = set()
        for offset, size in self.relas:
            for pos in range(offset, offset + size, 24):
                address, info, addend = struct.unpack_from("<QQq", self.data, pos)
                if address in values:
                    require(info == 1027 and address not in seen and addend >= 0,
                            "Unsupported or duplicate Go pointer relocation.")
                    values[address] = addend
                    seen.add(address)
        return values

    def text_start(self, header, table):
        header_va = self.address(header)
        slots = {header_va + 24}
        module = self.sections.get(b".go.module")
        if module:
            require(module[2] >= 0xC0, "Truncated Go moduledata.")
            # Go 1.20+ moduledata: pcHeader, ftab slice, text and etext.
            slots.update(module[0] + n for n in (0, 0x80, 0xB0, 0xB8))
        pointers = self.pointers(slots)
        text = pointers[header_va + 24]
        if module:
            address = module[0]
            require(pointers[address] == header_va and pointers[address + 0x80] == self.address(table),
                    "Go moduledata does not reference this function table.")
            module_text = pointers[address + 0xB0]
            require(text in (0, module_text), "Conflicting Go text bases.")
            text = module_text
            require(text < pointers[address + 0xB8], "Invalid Go text range.")
        va, offset, size, _ = self.sections[b".text"]
        require(va <= text < va + size and self.offset(text) == offset + text - va,
                "Cannot resolve Go runtime.text inside .text.")
        return text


def checkpoint_function(data):
    elf = ELF(data)
    section_va, section_offset, section_size, _ = elf.sections[b".text"]
    # Go 1.20+ arm64 pclntab. Entries are relative to runtime.text, which
    # need not equal the ELF .text start (the Google linker adds a preamble).
    ranges = []
    magic = re.escape(b"\xf1\xff\xff\xff\0\0\x04\x08")
    for hit in re.finditer(magic, data):
        h = hit.start()
        if h + 72 > len(data):
            continue
        count, _, _, names, cu, _, _, table = struct.unpack_from("<8Q", data, h + 8)
        if not (0 < count < 2000000 and 72 <= names < cu <= table
                and h + table + count * 8 + 4 <= len(data)):
            continue
        name = data.find(b"\0" + FUNCTION, h + names - 1, h + cu)
        if name < 0:
            continue
        nameoff = name + 1 - (h + names)
        t = h + table
        text = elf.text_start(h, t)
        for i in range(count):
            entry, desc, end = struct.unpack_from("<III", data, t + i * 8)
            if (t + desc + 8 <= len(data) and uint32(data, t + desc + 4) == nameoff
                    and uint32(data, t + desc) == entry and entry < end
                    and section_va <= text + entry < text + end <= section_va + section_size):
                start = elf.offset(text + entry, end - entry)
                require(start == section_offset + text + entry - section_va,
                        "Go function and .text mappings disagree.")
                ranges.append((start, start + end - entry))
    require(len(ranges) == 1, "Cannot uniquely resolve GetCheckpointConfig in the Go function table.")
    return ranges[0]


def cap_instructions(value):
    require(0 < value <= 0xFFFFFFFF, "Budget must fit uint32.")
    # movz x4, #low16; movk x4, #high16, lsl #16.
    return struct.pack("<II", 0xD2800004 | ((value & 0xFFFF) << 5),
                       0xF2A00004 | ((value >> 16) << 5))


def code_edits(data, source, dest):
    start, end = checkpoint_function(data)
    before, after = cap_instructions(source), cap_instructions(dest)
    matches = []
    for pos in range(start, end - 31, 4):
        words = struct.unpack_from("<8I", data, pos)
        # ldr w3,[sp,#a]; movz/movk x4,cap; cmp w3,w4;
        # movz/movk x4,cap; csel x3,x3,x4,cc; str w3,[sp,#b].
        if (words[0] & 0xFFC003FF == 0xB94003E3
                and data[pos + 4:pos + 12] == before and words[3] == 0x6B04007F
                and data[pos + 16:pos + 24] == before and words[6] == 0x9A843063
                and words[7] & 0xFFC003FF == 0xB90003E3):
            matches.append(pos)
    require(len(matches) == 1, f"Expected one verified {source:,} ARM64 clamp in GetCheckpointConfig.")
    pos = matches[0]
    return [(pos + 4, before, after, "GetCheckpointConfig comparison cap"),
            (pos + 16, before, after, "GetCheckpointConfig selected cap")]


def skip_space(text, pos):
    while pos < len(text) and text[pos].isspace():
        pos += 1
    return pos


def members(text, pos):
    """Yield top-level keys, decoded values and byte-aligned positions in an object."""
    require(text[pos] == "{", "Expected a JSON object.")
    pos = skip_space(text, pos + 1)
    seen = set()
    while text[pos] != "}":
        key, pos = DECODER.raw_decode(text, pos)
        require(isinstance(key, str) and key not in seen, "Ambiguous embedded JSON key.")
        seen.add(key)
        pos = skip_space(text, pos)
        require(text[pos] == ":", "Invalid embedded JSON key.")
        start = skip_space(text, pos + 1)
        value, end = DECODER.raw_decode(text, start)
        yield key, value, start, end
        pos = skip_space(text, end)
        if text[pos] == "}":
            break
        require(text[pos] == ",", "Invalid embedded JSON separator.")
        pos = skip_space(text, pos + 1)


def profile_edits(data, source, dest):
    marks = list(re.finditer(rb'"model_profiles"\s*:\s*(?=\{)', data))
    require(len(marks) == 1, "Cannot uniquely locate the embedded model_profiles object.")
    base = marks[0].end()
    # Latin-1 gives one character per byte even in localized prompt strings.
    text = data[base:base + 8 * 1024 * 1024].decode("latin1")
    edits = []
    for model, profile, prof_start, _ in members(text, 0):
        if not isinstance(profile, dict) or FEATURE not in profile:
            continue
        for key, value, start, end in members(text, prof_start):
            if key != FEATURE:
                continue
            settings = json.loads(value) if isinstance(value, str) else value
            require(isinstance(settings, dict), f"Unknown checkpoint configuration in {model}.")
            old = settings.get("max_token_limit")
            if old not in (source, str(source)):
                continue
            require(re.fullmatch(r"MODEL_[A-Z0-9_]+", model), "Unrecognized model profile name.")
            # Check the edited JSON semantically so a nested key or a number in a prompt
            # cannot be mistaken for the top-level max_token_limit.
            raw = text[start:end]
            replacement = str(dest)
            expected = dict(settings, max_token_limit=replacement if isinstance(old, str) else dest)
            candidates = []
            for hit in re.finditer(r"(?<!\d)" + str(source) + r"(?!\d)", raw):
                changed = json.loads(raw[:hit.start()] + replacement + raw[hit.end():])
                if isinstance(changed, str):
                    changed = json.loads(changed)
                if changed == expected:
                    candidates.append(base + start + hit.start())
            require(len(candidates) == 1, f"Cannot uniquely locate max_token_limit in {model}.")
            edits.append((candidates[0], str(source).encode(), replacement.encode(), model))
    require(edits, f"No matching {source:,} model overrides found. Inspect this build before patching.")
    return edits


def locate(data, source, dest):
    return code_edits(data, source, dest) + profile_edits(data, source, dest)


def file_hash(path):
    with path.open("rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
        return hashlib.sha256(data).hexdigest()


def receipt_path(state, patched):
    return state / (patched + ".json")


def record(state, original, patched, edits):
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    content = {"version": 1, "original": original, "patched": patched,
               "edits": [[p, a.hex(), b.hex(), label] for p, a, b, label in edits]}
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf8", dir=state, delete=False) as stream:
        json.dump(content, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
        tmp = Path(stream.name)
    try:
        os.replace(tmp, receipt_path(state, patched))
    finally:
        tmp.unlink(missing_ok=True)


def plan(data, digest, state):
    receipt = receipt_path(state, digest)
    if receipt.is_file():
        saved = json.loads(receipt.read_text(encoding="utf8"))
        require(saved["version"] == 1 and saved["patched"] == digest
                and re.fullmatch("[a-f0-9]{64}", saved["original"]),
                "Invalid rollback receipt.")
        edits = [(p, bytes.fromhex(b), bytes.fromhex(a), label) for p, a, b, label in saved["edits"]]
        require(edits, "Empty rollback receipt.")
        return NEW, edits, saved["original"]
    return OLD, locate(data, OLD, NEW), None


def backup(target, state, digest):
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    destination = state / (digest + ".original")
    if not destination.exists():
        with tempfile.NamedTemporaryFile(dir=state, delete=False) as stream:
            stage = Path(stream.name)
        try:
            shutil.copy2(target, stage)
            require(file_hash(stage) == digest, "Target changed during backup.")
            with stage.open("rb") as stream:
                os.fsync(stream.fileno())
            try:
                os.link(stage, destination)
            except FileExistsError:
                pass
        finally:
            stage.unlink(missing_ok=True)
    require(file_hash(destination) == digest, "Original backup hash mismatch.")
    print(f"Original backup: {destination}")


def run(target, action, state=STATE):
    target = target.expanduser().resolve(strict=True)
    state = state.expanduser().resolve()
    with target.open("rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
        original = hashlib.sha256(data).hexdigest()
        # Validate architecture even when a rollback receipt already exists.
        ELF(data)
        budget, edits, restore_hash = plan(data, original, state)
        end = 0
        for pos, before, after, label in sorted(edits):
            require(pos >= end and 0 < len(before) == len(after)
                    and pos + len(before) <= len(data) and data[pos:pos + len(before)] == before,
                    f"Unexpected bytes or overlapping edits at {pos:#x}.")
            end = pos + len(before)
            print(f"  {pos:#010x}  {label}")
    print(f"{target}\nLocal checkpoint budget: {budget:,}. SHA-256: {original}")
    if action == "check" or (action == "apply" and budget == NEW) or (action == "restore" and budget == OLD):
        return
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as stream:
        stage = Path(stream.name)
    try:
        shutil.copy2(target, stage)
        require(file_hash(stage) == original, "Target changed during staging.")
        with stage.open("r+b") as out:
            for pos, _, after, _ in edits:
                out.seek(pos)
                out.write(after)
            out.flush()
            os.fsync(out.fileno())
        result = file_hash(stage)
        if action == "restore":
            require(result == restore_hash, "Restoration failed original SHA-256 verification.")
        else:
            # Verify that both the instruction and profile edits can be located
            # in reverse before installing the result.
            with stage.open("rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
                reverse = locate(data, NEW, OLD)
                require(sorted(reverse) == sorted((p, b, a, label) for p, a, b, label in edits),
                        "Patched image failed reverse-location verification.")
            backup(target, state, original)
            record(state, original, result, edits)
        require(file_hash(target) == original, "Target changed before replacement.")
        os.replace(stage, target)
        require(file_hash(target) == result, "Installed hash changed after replacement.")
        print(f"{action} complete. SHA-256: {result}")
    finally:
        stage.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", nargs="?", default="check", choices=["check", "apply", "restore"])
    parser.add_argument("--file", type=Path, default=DEFAULT, help="Target a separate copy for testing.")
    parser.add_argument("--state-dir", type=Path, default=STATE,
                        help="Directory for original backups and SHA-256 rollback receipts.")
    args = parser.parse_args()
    try:
        run(args.file, args.action, args.state_dir)
    except (ValueError, OSError, struct.error, IndexError, TypeError, KeyError) as exc:
        sys.exit(f"Error: {exc}")
