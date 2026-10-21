#!/usr/bin/env python3
"""Inspect a world archive without extracting it or executing bundled content.

Supports vanilla 1.12 ZIP, EPK ver2 world1122, big-endian NBT and Anvil regions.
All archive members and region chunks are checked, including those not queried.
JSON reports data found in the file; it does not establish runtime export support.
"""

import argparse
from collections import Counter
import hashlib
import io
import json
import math
from pathlib import Path, PurePosixPath
import stat
import struct
import sys
import zipfile
import zlib

MAX_INPUT = 160 * 1024 * 1024
MAX_MEMBER = 64 * 1024 * 1024
MAX_TOTAL = 256 * 1024 * 1024
MAX_NBT = 16 * 1024 * 1024
MAX_MEMBERS = 8192
MAX_NODES = 1000000
MAX_DEPTH = 64


class InvalidExport(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise InvalidExport(message)


class Budget:
    def __init__(self):
        self.remaining = MAX_TOTAL


def inflate(data, mode, limit=MAX_NBT, budget=None):
    require(len(data) <= MAX_MEMBER, "Compressed member exceeds size limit")
    if budget:
        limit = min(limit, budget.remaining)
    decoder = zlib.decompressobj(mode)
    try:
        result = decoder.decompress(data, limit + 1)
        require(len(result) <= limit and not decoder.unconsumed_tail, "Decompressed data exceeds size limit")
        require(decoder.eof, "Truncated compressed stream")
        # Native filesystem files can retain zero-filled capacity after gzip's
        # CRC/ISIZE trailer. Accept padding only after a complete validated gzip
        # member; zlib streams and nonzero trailing bytes remain strict.
        require(not decoder.unused_data or mode == 31 and not any(decoder.unused_data), "Trailing compressed stream data")
        if budget:
            budget.remaining -= len(result)
        return result
    except zlib.error as error:
        raise InvalidExport("Invalid compressed stream: " + str(error)) from error


class Reader:
    def __init__(self, data):
        self.data, self.offset = data, 0

    def take(self, size):
        require(size >= 0 and self.offset + size <= len(self.data), "Truncated binary data")
        result = self.data[self.offset:self.offset + size]
        self.offset += size
        return result

    def number(self, kind):
        return struct.unpack('>' + kind, self.take(struct.calcsize('>' + kind)))[0]

    def text(self):
        raw = self.take(self.number('H'))
        try:
            # DataInput's modified UTF-8 uses C0 80 for NUL and may encode
            # UTF-16 surrogate code points independently.
            decoded = raw.replace(b'\xc0\x80', b'\0').decode('utf-8', 'surrogatepass')
            return decoded.encode('utf-16-be', 'surrogatepass').decode('utf-16-be', 'surrogatepass')
        except UnicodeDecodeError as error:
            raise InvalidExport("Invalid NBT string") from error


class NBT(Reader):
    def __init__(self, data):
        require(len(data) <= MAX_NBT, "NBT exceeds size limit")
        super().__init__(data)
        self.nodes = 0

    def payload(self, kind, depth=0):
        require(depth <= MAX_DEPTH, "NBT nesting exceeds depth limit")
        self.nodes += 1
        require(self.nodes <= MAX_NODES, "NBT exceeds node limit")
        if kind in range(1, 7):
            value = self.number({1: 'b', 2: 'h', 3: 'i', 4: 'q', 5: 'f', 6: 'd'}[kind])
            require(not isinstance(value, float) or math.isfinite(value), "Non-finite NBT number")
            return value
        if kind == 7:
            return self.take(self.number('i'))
        if kind == 8:
            return self.text()
        if kind == 9:
            element, count = self.number('B'), self.number('i')
            require(0 <= count <= MAX_NODES - self.nodes, "Invalid NBT list length")
            require(element in range(1, 13) or (element == 0 and count == 0), "Invalid NBT list type")
            return [self.payload(element, depth + 1) for _ in range(count)]
        if kind == 10:
            result = {}
            while True:
                element = self.number('B')
                if element == 0:
                    return result
                name = self.text()
                require(name not in result, "Duplicate NBT compound tag")
                result[name] = self.payload(element, depth + 1)
        if kind in (11, 12):
            count = self.number('i')
            require(0 <= count <= MAX_NODES - self.nodes, "Invalid NBT array length")
            self.nodes += count
            raw = self.take(count * (4 if kind == 11 else 8))
            return list(struct.unpack('>' + str(count) + ('i' if kind == 11 else 'q'), raw))
        raise InvalidExport("Unknown NBT tag type: " + str(kind))

    def root(self):
        require(self.number('B') == 10, "NBT root must be a named compound")
        name = self.text()
        result = self.payload(10)
        require(self.offset == len(self.data), "Trailing NBT data")
        return name, result


def read_nbt(data, budget=None):
    if data.startswith(b'\x1f\x8b'):
        data = inflate(data, 31, budget=budget)
    elif data and data[0] != 10:
        data = inflate(data, 15, budget=budget)
    return NBT(data).root()[1]


def safe_name(name, directory=False):
    require(name and '\\' not in name and ':' not in name and not any(ord(char) <= 0x1f or 0x7f <= ord(char) <= 0x9f for char in name), "Unsafe archive member path")
    logical = name[:-1] if directory and name.endswith('/') else name
    # Native Java normalization trims <= U+0020 at segment boundaries. Controls
    # above are already rejected; leading/trailing ASCII spaces can alias paths.
    require(not name.startswith('/') and all(part not in ('', '.', '..') and part == part.strip(' ') for part in logical.split('/')), "Unsafe archive member path")
    return name


def zip_members(data):
    members, total = {}, 0
    # Bound directory allocation before ZipFile constructs a ZipInfo per entry.
    # ZIP64 and split archives are unnecessary for these bounded world exports.
    end = data.rfind(b'PK\x05\x06', max(0, len(data) - 65557))
    require(end >= 0 and end + 22 <= len(data), "Invalid ZIP end record")
    _, disk, directory_disk, disk_count, count, size, offset, comment_size = struct.unpack('<4s4H2IH', data[end:end + 22])
    require(disk == directory_disk == 0 and disk_count == count and count < 65535, "Split/ZIP64 archives are not supported")
    require(count <= MAX_MEMBERS and end + 22 + comment_size == len(data), "Invalid ZIP member count/end record")
    require(offset + size == end, "Invalid ZIP directory bounds")
    cursor, observed = offset, 0
    while cursor < end:
        require(observed < MAX_MEMBERS and cursor + 46 <= end and data[cursor:cursor + 4] == b'PK\x01\x02', "Invalid ZIP directory entry")
        name_size, extra_size, entry_comment = struct.unpack('<3H', data[cursor + 28:cursor + 34])
        cursor += 46 + name_size + extra_size + entry_comment
        require(cursor <= end, "Truncated ZIP directory entry")
        observed += 1
    require(observed == count, "ZIP directory member count mismatch")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
            require(len(infos) <= MAX_MEMBERS, "Archive has too many members")
            seen = set()
            for info in infos:
                require(info.orig_filename == info.filename, "Unsafe archive member path")
                name = safe_name(info.filename, info.is_dir())
                canonical = name[:-1] if info.is_dir() else name
                require(canonical not in seen, "Duplicate archive member")
                seen.add(canonical)
                mode = info.external_attr >> 16
                require(not stat.S_ISLNK(mode), "Archive symlinks are not supported")
                require(not info.flag_bits & 1, "Encrypted archive members are not supported")
                require(info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "Unsupported ZIP compression")
                require(0 <= info.file_size <= MAX_MEMBER, "Archive member exceeds size limit")
                total += info.file_size
                require(total <= MAX_TOTAL, "Archive exceeds decompressed size limit")
                if not info.is_dir():
                    with archive.open(info) as stream:
                        content = stream.read(MAX_MEMBER + 1)
                    require(len(content) == info.file_size, "Archive member size mismatch")
                    members[name] = content
    except (zipfile.BadZipFile, RuntimeError, EOFError, zlib.error) as error:
        raise InvalidExport("Invalid ZIP archive: " + str(error)) from error
    return members


def epk_members(data, budget):
    # Framing traced from this bundle's C3W/DG7 EPK decoder; this is not ZIP.
    require(data.startswith(b'EAGPKG$$') and data.endswith(b':::YEE:>'), "Invalid EPK header/footer")
    reader = Reader(data[8:-8])

    def text8(stream):
        # Bundle GQG maps each byte directly to one Java character.
        return stream.take(stream.number('B')).decode('latin-1')

    version = text8(reader)
    require(version.startswith('ver2.'), "Unsupported EPK version")
    filename = text8(reader)
    try:
        comment = reader.take(reader.number('H')).decode('utf-8')
    except UnicodeDecodeError as error:
        raise InvalidExport("Invalid EPK comment") from error
    timestamp, count, compression = reader.number('q'), reader.number('I'), reader.take(1)
    require(count <= MAX_MEMBERS, "EPK has too many records")
    payload = reader.take(len(reader.data) - reader.offset)
    require(compression in (b'0', b'G', b'Z'), "Unsupported EPK compression")
    if compression != b'0':
        payload = inflate(payload, 31 if compression == b'G' else 15, MAX_TOTAL, budget)
    require(len(payload) <= MAX_TOTAL, "EPK exceeds decompressed size limit")
    stream, members, headers, total = Reader(payload), {}, {}, 0
    for _ in range(count):
        kind, name, size = stream.take(4), text8(stream), stream.number('I')
        require(size <= MAX_MEMBER + 5, "EPK member exceeds size limit")
        if kind == b'HEAD':
            require(name not in headers, "Duplicate EPK header")
            headers[name] = stream.take(size)
        elif kind == b'FILE':
            safe_name(name)
            require(name not in members, "Duplicate EPK file")
            require(size >= 5, "Invalid EPK FILE length")
            checksum = stream.number('I')
            content = stream.take(size - 5)
            require(stream.take(1) == b':', "Invalid EPK FILE terminator")
            require(zlib.crc32(content) & 0xffffffff == checksum, "EPK FILE CRC32 mismatch")
            total += len(content)
            require(total <= MAX_TOTAL, "EPK exceeds decompressed size limit")
            members[name] = content
        else:
            raise InvalidExport("Unsupported EPK record tag")
        require(stream.take(1) == b'>', "Invalid EPK record terminator")
    require(stream.take(4) == b'END$' and stream.offset == len(payload), "Invalid EPK record count/end marker")
    require(headers.get('file-type') == b'epk/world1122', "Expected EPK world1122 file-type header")
    return members, {'version': version, 'filename': filename, 'comment': comment, 'timestamp': timestamp, 'compression': compression.decode('ascii')}


def inventory(player):
    result = []
    for item in player.get('Inventory', []):
        require(isinstance(item, dict), "Invalid player inventory entry")
        entry = {key: item[key] for key in ('Slot', 'id', 'Count', 'Damage') if key in item}
        item_tag = item.get('tag', {})
        require(isinstance(item_tag, dict), "Invalid item tag compound")
        display = item_tag.get('display', {})
        if isinstance(display, dict) and 'Name' in display:
            entry['name'] = display['Name']
        result.append(entry)
    return result


def player_summary(player):
    require(isinstance(player, dict), "Invalid player compound")
    result = {key: player[key] for key in ('Pos', 'Rotation', 'Dimension', 'Health', 'foodLevel', 'playerGameType', 'SelectedItemSlot') if key in player}
    result['inventory'] = inventory(player)
    if 'abilities' in player:
        result['abilities'] = player['abilities']
    return result


def nibble(data, index):
    return (data[index // 2] >> (4 * (index % 2))) & 15


def chunk_summary(nbt, queries, blocks, entities, positions):
    level = nbt.get('Level', nbt)
    require(isinstance(level, dict), "Invalid chunk Level compound")
    x, z = level.get('xPos'), level.get('zPos')
    require(isinstance(x, int) and isinstance(z, int), "Chunk coordinates missing")
    require((x, z) not in positions, "Duplicate chunk coordinates")
    positions.add((x, z))
    sections = {}
    for section in level.get('Sections', []):
        require(isinstance(section, dict), "Invalid chunk section")
        y = section.get('Y')
        require(isinstance(y, int) and 0 <= y < 16 and y not in sections, "Invalid or duplicate section Y")
        data = section.get('Blocks')
        metadata = section.get('Data')
        add = section.get('Add')
        require(isinstance(data, bytes) and len(data) == 4096, "Expected 1.12 section Blocks byte array")
        require(isinstance(metadata, bytes) and len(metadata) == 2048, "Invalid section Data nibble array")
        require(add is None or isinstance(add, bytes) and len(add) == 2048, "Invalid section Add nibble array")
        sections[y] = section
        if add:
            blocks.update(str(block | (nibble(add, i) << 8)) for i, block in enumerate(data))
        else:
            blocks.update(str(block) for block in data)
    for entity in level.get('Entities', []):
        require(isinstance(entity, dict), "Invalid chunk entity")
        entities[str(entity.get('id', '<missing>'))] += 1
    for query in queries:
        qx, qy, qz = query['position']
        if qx // 16 != x or qz // 16 != z:
            continue
        require(0 <= qy <= 255, "Block query Y outside 1.12 world")
        section = sections.get(qy // 16)
        index = (qy % 16) * 256 + (qz % 16) * 16 + qx % 16
        query['block_id'] = 0 if section is None else section['Blocks'][index] | (nibble(section['Add'], index) << 8 if section.get('Add') else 0)
        query['metadata'] = 0 if section is None else nibble(section['Data'], index)
        query['chunk'] = [x, z]


def region_chunks(data, region_x, region_z, budget):
    require(len(data) >= 8192 and len(data) % 4096 == 0, "Invalid Anvil region size")
    occupied = {0, 1}
    for slot in range(1024):
        location = int.from_bytes(data[slot * 4:slot * 4 + 4], 'big')
        offset, count = location >> 8, location & 255
        if not location:
            continue
        require(offset >= 2 and count > 0 and (offset + count) * 4096 <= len(data), "Invalid Anvil sector location")
        sectors = set(range(offset, offset + count))
        require(not occupied.intersection(sectors), "Overlapping Anvil sectors")
        occupied.update(sectors)
        start = offset * 4096
        length = int.from_bytes(data[start:start + 4], 'big')
        require(2 <= length <= count * 4096 - 4, "Invalid Anvil chunk length")
        compression = data[start + 4]
        payload = data[start + 5:start + 4 + length]
        require(compression in (1, 2, 3), "Unsupported Anvil chunk compression")
        decoded = payload if compression == 3 else inflate(payload, 31 if compression == 1 else 15, budget=budget)
        nbt = NBT(decoded).root()[1]
        level = nbt.get('Level', nbt)
        require(isinstance(level, dict), "Invalid Anvil Level compound")
        require(level.get('xPos') == region_x * 32 + slot % 32 and level.get('zPos') == region_z * 32 + slot // 32, "Anvil chunk coordinate/header mismatch")
        yield nbt


def inspect(data, queries):
    require(len(data) <= MAX_INPUT, "Input exceeds size limit")
    budget = Budget()
    epk = None
    if data.startswith(b'PK'):
        members, archive_format = zip_members(data), 'vanilla-zip'
    elif data.startswith(b'EAGPKG$$'):
        members, epk = epk_members(data, budget)
        archive_format = 'epk-world1122'
    else:
        raise InvalidExport("Unsupported archive format")
    levels = [name for name in members if PurePosixPath(name).name == 'level.dat']
    require(len(levels) == 1, "Expected exactly one level.dat")
    level_path = levels[0]
    prefix = level_path[:-len('level.dat')]
    nbt = read_nbt(members[level_path], budget)
    validated_nbt, validated_regions = {level_path}, set()
    level = nbt.get('Data', nbt)
    require(isinstance(level, dict) and isinstance(level.get('LevelName'), str), "level.dat has no world name")
    world = {key: level[key] for key in ('LevelName', 'RandomSeed', 'GameType', 'SpawnX', 'SpawnY', 'SpawnZ', 'Time', 'DayTime', 'version', 'DataVersion') if key in level}
    if 'RandomSeed' in world:
        world['RandomSeedDecimal'] = str(world['RandomSeed'])
    result = {'format': archive_format, 'sha256': hashlib.sha256(data).hexdigest(), 'archive': {'members': len(members), 'uncompressed_bytes': sum(map(len, members.values()))}, 'level_dat': level_path, 'world': world, 'players': {}, 'dimensions': {}, 'block_queries': queries}
    # Hash original member bytes, never decoded/re-encoded NBT. This permits
    # an independent comparison against the source IndexedDB snapshot, including
    # opaque files and native gzip capacity padding.
    result['member_hashes'] = [{'path': name, 'bytes': len(members[name]), 'sha256': hashlib.sha256(members[name]).hexdigest()} for name in sorted(members)]
    if epk:
        result['archive']['epk'] = epk
    if 'Player' in level:
        result['players']['level.dat'] = player_summary(level['Player'])
    dimensions = {}
    for name, content in members.items():
        if not name.startswith(prefix):
            continue
        relative = name[len(prefix):]
        parts = PurePosixPath(relative).parts
        if len(parts) == 2 and parts[0] in ('playerdata', 'players') and parts[1].endswith('.dat'):
            result['players'][relative] = player_summary(read_nbt(content, budget))
            validated_nbt.add(name)
        if len(parts) >= 2 and parts[-2] == 'region' and parts[-1].endswith('.mca'):
            coords = parts[-1].split('.')
            require(len(coords) == 4 and coords[0] == 'r', "Invalid Anvil filename")
            try:
                rx, rz = int(coords[1]), int(coords[2])
            except ValueError as error:
                raise InvalidExport("Invalid Anvil region coordinates") from error
            dimension = '/'.join(parts[:-2]) or 'overworld'
            state = dimensions.setdefault(dimension, {'regions': 0, 'blocks': Counter(), 'entities': Counter(), 'positions': set()})
            state['regions'] += 1
            applicable = [q for q in queries if q['dimension'] == dimension]
            for chunk in region_chunks(content, rx, rz, budget):
                chunk_summary(chunk, applicable, state['blocks'], state['entities'], state['positions'])
            validated_regions.add(name)
        elif epk and len(parts) == 2 and parts[0] in ('level0', 'level-1', 'level1') and parts[1].endswith('.dat'):
            # Internal EPK chunks have NBT coordinates; filenames are not used
            # to infer positions and are not presented as vanilla regions.
            dimension = {'level0': 'overworld', 'level-1': 'DIM-1', 'level1': 'DIM1'}[parts[0]]
            state = dimensions.setdefault(dimension, {'regions': 0, 'blocks': Counter(), 'entities': Counter(), 'positions': set()})
            chunk_summary(read_nbt(content, budget), [q for q in queries if q['dimension'] == dimension], state['blocks'], state['entities'], state['positions'])
            validated_nbt.add(name)
    for name, content in members.items():
        # Preserve unrelated file types without interpreting them as NBT. Saved
        # level.dat_old and gzip .dat sidecars still receive full NBT validation.
        if name not in validated_nbt and content.startswith(b'\x1f\x8b') and name.endswith(('.dat', '.dat_old')):
            read_nbt(content, budget)
            validated_nbt.add(name)
    for dimension, state in dimensions.items():
        result['dimensions'][dimension] = {'regions': state['regions'], 'chunks': len(state['positions']), 'stored_section_block_counts': dict(sorted(state['blocks'].items(), key=lambda pair: int(pair[0]))), 'entity_counts': dict(sorted(state['entities'].items()))}
    other_members = sorted(set(members) - validated_nbt - validated_regions)
    result['validation'] = {'file_crcs': len(members), 'nbt_members': len(validated_nbt), 'anvil_regions': len(validated_regions), 'other_member_count': len(other_members), 'other_members_sample': other_members[:20]}
    return result


def block_query(value):
    try:
        dimension, position = value.split(':', 1) if ':' in value else ('overworld', value)
        xyz = [int(number) for number in position.split(',')]
        require(len(xyz) == 3 and 0 <= xyz[1] <= 255, "Expected X,Y,Z with Y in 0..255")
        return {'dimension': dimension, 'position': xyz, 'block_id': None, 'metadata': None}
    except ValueError as error:
        raise argparse.ArgumentTypeError("Expected [DIMENSION:]X,Y,Z") from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--block', action='append', default=[], type=block_query, help='Inspect [DIMENSION:]X,Y,Z; absent chunks return null, never assumed air')
    parser.add_argument('--expect-name')
    parser.add_argument('--expect-seed', type=int)
    parser.add_argument('--json-output', type=Path, help='Write JSON only to this explicit caller-selected file')
    args = parser.parse_args()
    try:
        require(args.archive.stat().st_size <= MAX_INPUT, "Input exceeds size limit")
        with args.archive.open('rb') as stream:
            result = inspect(stream.read(MAX_INPUT + 1), args.block)
        if args.expect_name is not None:
            require(result['world'].get('LevelName') == args.expect_name, "World name does not match expectation")
        if args.expect_seed is not None:
            require(result['world'].get('RandomSeed') == args.expect_seed, "World seed does not match expectation")
        text = json.dumps({'status': 'ok', **result}, sort_keys=True, allow_nan=False)
        if args.json_output:
            args.json_output.write_text(text + '\n', encoding='utf-8')
        print(text)
        return 0
    except (InvalidExport, OSError, UnicodeError, TypeError, KeyError, struct.error) as error:
        print(json.dumps({'status': 'error', 'error': str(error)}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
