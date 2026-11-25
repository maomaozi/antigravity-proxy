#!/usr/bin/env python3
"""Inspect, set (256k..1m), or restore the agy Linux ARM64 checkpoint budget."""

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


def checkpoint_function(data, function_name=FUNCTION):
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
        name = data.find(b"\0" + function_name, h + names - 1, h + cu)
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
    require(len(ranges) == 1, "Cannot uniquely resolve " + function_name.rstrip(b"\0").decode() + " in the Go function table.")
    return ranges[0]


def cap_instructions(value, register=4):
    require(0 < value <= 0xFFFFFFFF, "Budget must fit uint32.")
    require(0 <= register < 31, "Invalid ARM64 register.")
    # movz xN, #low16; movk xN, #high16, lsl #16.
    return struct.pack("<II", 0xD2800000 | register | ((value & 0xFFFF) << 5),
                       0xF2A00000 | register | ((value >> 16) << 5))


def clamp_value(data):
    start, end = checkpoint_function(data)
    matches = []
    for pos in range(start, end - 31, 4):
        words = struct.unpack_from("<8I", data, pos)
        # ldr w3,[sp,#a]; movz/movk x4,cap; cmp w3,w4;
        # movz/movk x4,cap; csel x3,x3,x4,cc; str w3,[sp,#b].
        if (words[0] & 0xFFC003FF == 0xB94003E3
                and words[1] & 0xFFE0001F == 0xD2800004
                and words[2] & 0xFFE0001F == 0xF2A00004
                and words[3] == 0x6B04007F
                and words[4:6] == words[1:3]
                and words[6] == 0x9A843063
                and words[7] & 0xFFC003FF == 0xB90003E3):
            value = ((words[1] >> 5) & 0xFFFF) | (((words[2] >> 5) & 0xFFFF) << 16)
            matches.append((pos, value))
    require(len(matches) == 1, "Expected one verified ARM64 clamp in GetCheckpointConfig.")
    pos, value = matches[0]
    require(0 < value < 0x80000000, "Invalid checkpoint budget.")
    return pos, value


def code_edits(data, source, dest):
    pos, value = clamp_value(data)
    require(value == source, f"Expected a {source:,} ARM64 clamp, found {value:,}.")
    before, after = cap_instructions(source), cap_instructions(dest)
    return [(pos + 4, before, after, "GetCheckpointConfig comparison cap"),
            (pos + 16, before, after, "GetCheckpointConfig selected cap")]


# This default-budget block precedes the model-window, output-reservation and
# summary-model checks. Set the target here after experiment configuration merging.
FINAL_FUNCTION = b"google3/third_party/jetski/cortex/utils/utils.ClampCheckpointConfigForModelInfo\0"
FINAL_ORIGINAL = struct.pack("<10I",
    0xB9400C45, 0x35000125, 0xB9801465, 0xD2938806, 0xEB0600BF,
    0x5400006C, 0xAA1F03E5, 0x14000002, 0xCB0600A5, 0xB9000C45)
FINAL_FOLLOWING = struct.pack("<10I",
    0xB9801465, 0x710000BF, 0x5400010D, 0xCB0400A6, 0xB9400C47,
    0x6B05009F, 0x9A8530C4, 0x6B07009F, 0x54000042, 0xB9000C44)


def final_budget_edit(data, budget=NEW):
    start, end = checkpoint_function(data, FINAL_FUNCTION)
    replacement = cap_instructions(budget, 5) + struct.pack("<8I", 0xB9000C45, *([0xD503201F] * 7))
    hits = []
    for pos in range(start + 8, end - len(FINAL_ORIGINAL) - len(FINAL_FOLLOWING) + 1, 4):
        block = data[pos:pos + 40]
        words = struct.unpack("<10I", block)
        patched = (words[0] & 0xFFE0001F == 0xD2800005
                   and words[1] & 0xFFE0001F == 0xF2A00005
                   and words[2:] == (0xB9000C45, *([0xD503201F] * 7)))
        if block != FINAL_ORIGINAL and not patched:
            continue
        if data[pos + 40:pos + 80] != FINAL_FOLLOWING:
            continue
        first, second = struct.unpack_from("<II", data, pos - 8)
        require(first & 0xFF00001F == 0xB4000002
                and second & 0xFF00001F == 0xB4000003,
                "Cannot verify checkpoint/model nil checks.")
        destinations = []
        for address, instruction in ((pos - 8, first), (pos - 4, second)):
            immediate = (instruction >> 5) & 0x7FFFF
            if immediate & 0x40000:
                immediate -= 0x80000
            destinations.append(address + immediate * 4)
        require(destinations[0] == destinations[1] and pos + 80 <= destinations[0] < end,
                "Unexpected nil-check branch destination.")
        hits.append((pos, block, replacement, "Final checkpoint budget after experiment merge"))
    require(len(hits) == 1, "Unsupported final ARM64 checkpoint clamp layout. No changes applied.")
    return hits[0]


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


def profile_configs(data):
    marks = list(re.finditer(rb'"model_profiles"\s*:\s*(?=\{)', data))
    require(len(marks) == 1, "Cannot uniquely locate the embedded model_profiles object.")
    base = marks[0].end()
    # Latin-1 gives one character per byte even in localized prompt strings.
    text = data[base:base + 8 * 1024 * 1024].decode("latin1")
    for model, profile, prof_start, _ in members(text, 0):
        if not isinstance(profile, dict) or FEATURE not in profile:
            continue
        for key, value, start, end in members(text, prof_start):
            if key != FEATURE:
                continue
            settings = json.loads(value) if isinstance(value, str) else value
            require(isinstance(settings, dict), f"Unknown checkpoint configuration in {model}.")
            require(re.fullmatch(r"MODEL_[A-Z0-9_]+", model), "Unrecognized model profile name.")
            yield model, settings, base + start, text[start:end]


def profile_edits(data, source, dest, required=True):
    edits = []
    for model, settings, offset, raw in profile_configs(data):
        old = settings.get("max_token_limit")
        if old not in (source, str(source)):
            continue
        # Check the edited JSON semantically so a nested key or a number in a prompt
        # cannot be mistaken for the top-level max_token_limit.
        replacement = str(dest)
        expected = dict(settings, max_token_limit=replacement if isinstance(old, str) else dest)
        candidates = []
        for hit in re.finditer(r"(?<!\d)" + str(source) + r"(?!\d)", raw):
            changed = json.loads(raw[:hit.start()] + replacement + raw[hit.end():])
            if isinstance(changed, str):
                changed = json.loads(changed)
            if changed == expected:
                candidates.append(offset + hit.start())
        require(len(candidates) == 1, f"Cannot uniquely locate max_token_limit in {model}.")
        edits.append((candidates[0], str(source).encode(), replacement.encode(), model))
    require(edits or not required, f"No matching {source:,} model overrides found. Inspect this build before patching.")
    return edits


def inspect_budget(target):
    """Read the installed limit independently of patch receipts or original hashes."""
    with target.open("rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
        pos, budget = clamp_value(data)
        profiles = {model: int(settings["max_token_limit"])
                    for model, settings, _, _ in profile_configs(data)
                    if settings.get("max_token_limit") is not None}
        try:
            final = final_budget_edit(data)[1]
            words = struct.unpack("<10I", final)
            final_budget = (((words[0] >> 5) & 0xFFFF) | (((words[1] >> 5) & 0xFFFF) << 16)
                            if final != FINAL_ORIGINAL else None)
            final_status = "installed" if final_budget is not None else "not-installed"
        except ValueError:
            final_budget, final_status = None, "unsupported"
        return {"status": "ok", "budget_tokens": budget, "final_budget_tokens": final_budget,
                "final_budget_status": final_status, "profile_budgets": profiles,
                "binary": str(target.resolve()), "sha256": hashlib.sha256(data).hexdigest(),
                "code_offsets": [pos + 4, pos + 16]}


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


def prior_patch(data, digest, state):
    receipt = receipt_path(state, digest)
    if not receipt.is_file():
        return digest, []
    saved = json.loads(receipt.read_text(encoding="utf8"))
    require(saved["version"] == 1 and saved["patched"] == digest
            and re.fullmatch("[a-f0-9]{64}", saved["original"]),
            "Invalid rollback receipt.")
    edits = [(p, bytes.fromhex(a), bytes.fromhex(b), label) for p, a, b, label in saved["edits"]]
    require(edits, "Empty rollback receipt.")
    verify_original(data, edits, saved["original"])
    return saved["original"], edits


def verify_original(data, edits, expected):
    """Validate cumulative edits by hashing the reconstructed original image."""
    sha = hashlib.sha256()
    end = 0
    for pos, before, after, _ in sorted(edits):
        require(pos >= end and 0 < len(before) == len(after)
                and pos + len(after) <= len(data) and data[pos:pos + len(after)] == after,
                "Rollback edits do not match the patched image.")
        sha.update(data[end:pos])
        sha.update(before)
        end = pos + len(after)
    sha.update(data[end:])
    require(sha.hexdigest() == expected, "Rollback edits failed original SHA-256 verification.")


def apply_edits(data, limit=NEW):
    _, budget = clamp_value(data)
    require(OLD <= budget <= 1000000, "Unsupported installed clamp value.")
    require(OLD <= limit <= 1000000, "Limit must be between 256,000 and 1,000,000 tokens.")
    edits = code_edits(data, budget, limit) if budget != limit else []
    final_edit = final_budget_edit(data, limit)
    if final_edit[1] != final_edit[2]:
        edits.append(final_edit)
    return budget, edits


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


def run(target, action, state=STATE, json_output=False, limit=NEW):
    target = target.expanduser().resolve(strict=True)
    state = state.expanduser().resolve()
    if action == "check":
        result = inspect_budget(target)
        if json_output:
            print(json.dumps(result))
        else:
            for pos in result["code_offsets"]:
                print(f"  {pos:#010x}  GetCheckpointConfig")
            print("Embedded model defaults (before final budget override):")
            for model, value in result["profile_budgets"].items():
                print(f"  {model}  {value:,}")
            print(f"{target}\nLocal checkpoint budget: {result['budget_tokens']:,}. SHA-256: {result['sha256']}")
            final = result["final_budget_tokens"]
            print(f"Final budget override: {final:,} tokens." if final is not None
                  else "Final budget override: " + result["final_budget_status"] + ".")
            if final is not None:
                print("This target is set after model/experiment configuration merging.")
                print("Actual request budgets remain subject to model-window and output-reservation limits.")
        return
    with target.open("rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
        original = hashlib.sha256(data).hexdigest()
        # Validate architecture even when a rollback receipt already exists.
        ELF(data)
        _, budget = clamp_value(data)
        restore_hash, previous_edits = prior_patch(data, original, state)
        if action == "apply":
            budget, edits = apply_edits(data, limit)
        else:
            require(previous_edits or budget == OLD, "No matching rollback receipt found.")
            edits = [(p, after, before, label) for p, before, after, label in previous_edits]
        end = 0
        for pos, before, after, label in sorted(edits):
            require(pos >= end and 0 < len(before) == len(after)
                    and pos + len(before) <= len(data) and data[pos:pos + len(before)] == before,
                    f"Unexpected bytes or overlapping edits at {pos:#x}.")
            end = pos + len(before)
            print(f"  {pos:#010x}  {label}")
    print(f"{target}\nLocal checkpoint budget: {budget:,}. SHA-256: {original}")
    if not edits:
        print("Already in the requested state.")
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
            combined = {p: (before, after, label) for p, before, after, label in previous_edits}
            for pos, before, after, label in edits:
                initial = combined[pos][0] if pos in combined else before
                combined[pos] = (initial, after, label)
            cumulative = [(p, *values) for p, values in sorted(combined.items())]
            with stage.open("rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
                require(not apply_edits(data, limit)[1], "Patched image still contains pending budget edits.")
                verify_original(data, cumulative, restore_hash)
            backup(target, state, original)
            record(state, restore_hash, result, cumulative)
        require(file_hash(target) == original, "Target changed before replacement.")
        os.replace(stage, target)
        require(file_hash(target) == result, "Installed hash changed after replacement.")
        print(f"{action} complete. SHA-256: {result}")
    finally:
        stage.unlink(missing_ok=True)


def parse_limit(value):
    text = value.strip().lower()
    if re.fullmatch(r"\d+k", text):
        tokens = int(text[:-1]) * 1000
    elif text == "1m":
        tokens = 1000000
    elif text.isdigit():
        tokens = int(text)
        if tokens <= 1000:
            tokens *= 1000
    else:
        raise argparse.ArgumentTypeError("Use a token count, 256k..1000k, or 1m.")
    if not OLD <= tokens <= 1000000:
        raise argparse.ArgumentTypeError("Limit must be between 256,000 and 1,000,000 tokens.")
    return tokens


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", nargs="?", default="check", choices=["check", "apply", "restore"])
    parser.add_argument("--file", type=Path, default=DEFAULT, help="Target a separate copy for testing.")
    parser.add_argument("--state-dir", type=Path, default=STATE,
                        help="Directory for original backups and SHA-256 rollback receipts.")
    parser.add_argument("--json", action="store_true", help="Machine-readable check output.")
    parser.add_argument("--limit", type=parse_limit, default=None,
                        help="Apply target, 256k..1m (default 700k). Plain 256..1000 means thousands.")
    args = parser.parse_args()
    if args.json and args.action != "check":
        parser.error("--json is only supported with check")
    if args.limit is not None and args.action != "apply":
        parser.error("--limit is only supported with apply")
    try:
        run(args.file, args.action, args.state_dir, args.json,
            args.limit if args.limit is not None else NEW)
    except (ValueError, OSError, struct.error, IndexError, TypeError, KeyError) as exc:
        if args.json:
            print(json.dumps({"status": "unavailable", "message": str(exc)}))
            sys.exit(1)
        sys.exit(f"Error: {exc}")
