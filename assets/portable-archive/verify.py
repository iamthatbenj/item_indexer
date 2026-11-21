#!/usr/bin/env python3
"""Verify format-1.0 through format-1.3 archives offline, without extracting or executing ZIP members.
Integrity is relative to the manifest, not a signature or proof of historical truth.
Use a trusted copy of this program for archives of uncertain provenance.
"""
import hashlib
import json
import os
import re
import stat
import sys
import zipfile

FORMAT = "family-belongings"
VERSIONS = ("1.0", "1.1", "1.2", "1.3")
HEX = re.compile(r"[0-9a-f]{64}\Z")
# ECMAScript TrimString (WhiteSpace and LineTerminator), not Python's default.
LABEL_TRIM = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680" + "".join(map(chr, range(0x2000, 0x200b))) + "\u2028\u2029\u202f\u205f\u3000\ufeff"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON key")
        result[key] = value
    return result


def json_bytes(raw):
    return json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Invalid JSON number")))


def indexed(rows):
    require(isinstance(rows, list), "Expected record array")
    result = {}
    for row in rows:
        require(isinstance(row, dict) and isinstance(row.get("id"), str) and row["id"], "Invalid record identity")
        require(row["id"] not in result, "Duplicate record identity")
        result[row["id"]] = row
    return result


def relationships(data, files):
    root = {"format", "version", "snapshot", "collection", "contributors", "items", "people", "stories", "photos", "item_revisions", "person_revisions", "story_revisions"}
    merged = data.get("version") == "1.3"
    labelled = merged or data.get("version") == "1.2"
    if labelled or data.get("version") == "1.1":
        root.add("origins")
    if labelled:
        root.update(("categories", "locations"))
    require(set(data) == root and data["format"] == FORMAT and data["version"] in VERSIONS, "Unsupported data format/version/fields")
    snapshot = data["snapshot"]
    require(set(snapshot) == {"id", "captured_at", "source_collection_id", "generated_by"}, "Invalid snapshot")
    require(set(data["collection"]) == {"id", "name", "created_at"} and data["collection"]["id"] == snapshot["source_collection_id"], "Invalid collection namespace")
    fields = {
        "contributors": "id email",
        "items": "id name description status version created_by created_at last_edited_by updated_at current_keeper_id current_keeper_version",
        "people": "id name note version created_by created_at last_edited_by updated_at",
        "stories": "id item_id storyteller_id storyteller_version text version recorded_by recorded_at last_edited_by updated_at",
        "photos": "id item_id width height photo_bytes sha256 created_at created_by removed_at removed_by retained_file thumbnail_file",
        "item_revisions": "id item_id version name description status edited_by edited_at current_keeper_id current_keeper_version",
        "person_revisions": "id person_id version name note edited_by edited_at",
        "story_revisions": "id story_id version text storyteller_id storyteller_version recorded_by recorded_at edited_by edited_at",
    }
    if labelled:
        label_fields = "id name merged_into_id" if merged else "id name"
        fields.update(categories=label_fields, locations=label_fields)
        for group in ("items", "item_revisions"):
            fields[group] += " category_id location_id"
    maps = {}
    for group, names in fields.items():
        maps[group] = indexed(data[group])
        require(all(set(row) == set(names.split()) for row in data[group]), "Unsupported record fields")
    require(sum(len(data[key]) for key in fields if key != "contributors") <= 10000, "Too many records")
    require(len(data["items"]) <= 200 and len(data["people"]) <= 2000 and len(data["stories"]) <= 1000 and len(data["contributors"]) <= (201 if data["version"] != "1.0" else 200), "Record limits exceeded")

    def ref(value, group, nullable=False):
        require(nullable and value is None or isinstance(value, str) and value in maps[group], "Dangling record/credit reference")

    ref(snapshot["generated_by"], "contributors")
    if labelled or data["version"] == "1.1":
        maps["collection"] = indexed([data["collection"]])
        origins = data["origins"]
        require(isinstance(origins, list) and len(origins) <= 10202, "Invalid origin count")
        seen = set()
        for row in origins:
            require(isinstance(row, dict) and set(row) == {"record_type", "record_id", "source_collection_id", "source_record_id"}, "Unsupported origin fields")
            require(all(isinstance(v, str) and v and len(v.encode('utf-16-le')) <= 512 and not re.search(r'[\x00-\x1f]', v) for v in row.values()), "Invalid origin identity")
            group, record = row["record_type"], row["record_id"]
            require(group in maps and record in maps[group] and (group, record) not in seen, "Invalid origin reference")
            seen.add((group, record))
        require(labelled and not origins or ("collection", data["collection"]["id"]) in seen, "Missing collection origin")
    if labelled:
        from unicodedata import normalize
        for group in ("categories", "locations"):
            names = set()
            for row in data[group]:
                name = row["name"]
                require(isinstance(name, str) and 0 < len(name.encode("utf-16-le")) <= 200 and name == normalize("NFC", name.strip(LABEL_TRIM)) and not re.search(r"[\x00-\x1f\x7f]", name), "Invalid label name")
                key = normalize("NFC", name.lower())
                require(key not in names, "Duplicate label name")
                names.add(key)
                if merged:
                    target = row["merged_into_id"]
                    ref(target, group, True)
                    require(target is None or maps[group][target]["merged_into_id"] is None, "Merge destination is not active")
        for row in data["items"] + data["item_revisions"]:
            ref(row["category_id"], "categories", True)
            ref(row["location_id"], "locations", True)
        if merged:
            for row in data["items"]:
                for key, group in (("category_id", "categories"), ("location_id", "locations")):
                    require(row[key] is None or maps[group][row[key]]["merged_into_id"] is None, "Current item uses a retired label")
    versions = set()
    for p in data["people"]:
        versions.add((p["id"], p["version"]))
    for p in data["person_revisions"]:
        versions.add((p["person_id"], p["version"]))

    def person(pid, version, nullable=False):
        if nullable and pid is None and version is None:
            return
        ref(pid, "people")
        require(type(version) is int and (pid, version) in versions, "Missing historical person version")

    credited = set()
    for group, rows in ((key, data[key]) for key in fields):
        for row in rows:
            for key in ("created_by", "last_edited_by", "recorded_by", "edited_by", "removed_by"):
                if key in row:
                    ref(row[key], "contributors", key == "removed_by" or group == "items" and key == "last_edited_by")
                    if row[key] is not None:
                        credited.add(row[key])
            if "current_keeper_id" in row:
                person(row["current_keeper_id"], row["current_keeper_version"], True)
            if "storyteller_id" in row:
                person(row["storyteller_id"], row["storyteller_version"])
            if "item_id" in row:
                ref(row["item_id"], "items")
            if "status" in row:
                require(row["status"] == ("complete" if row["name"] and row["description"] else "draft"), "Incorrect item status")
            if group == "items":
                require((row["last_edited_by"] is None) == (row["updated_at"] is None) and (row["last_edited_by"] is not None or row["version"] == 1), "Invalid legacy item credit")
    for current, revision, parent in (("items", "item_revisions", "item_id"), ("people", "person_revisions", "person_id"), ("stories", "story_revisions", "story_id")):
        for rev in data[revision]:
            ref(rev[parent], current)
        for row in data[current]:
            require(type(row["version"]) is int and 1 <= row["version"] <= 10001, "Invalid version")
            prior = [r["version"] for r in data[revision] if r[parent] == row["id"]]
            require(all(type(v) is int for v in prior) and sorted(prior) == list(range(1, row["version"])), "Missing/duplicate history version")
    for rev in data["story_revisions"]:
        row = maps["stories"][rev["story_id"]]
        require(all(row[key] == rev[key] for key in ("storyteller_id", "storyteller_version", "recorded_by", "recorded_at")), "Immutable story attribution changed")
    referenced = set()
    require(len(credited) <= 200 and (len(data["contributors"]) <= 200 or len(credited) == 200 and snapshot["generated_by"] not in credited), "Contributor limit exceeded")
    active_items = set()
    active_photos = 0
    for photo in data["photos"]:
        require(bool(HEX.fullmatch(photo["sha256"])) and type(photo["photo_bytes"]) is int and photo["photo_bytes"] > 0, "Invalid retained photo metadata")
        require(all(type(photo[key]) is int and 1 <= photo[key] <= 3200 for key in ("width", "height")), "Invalid retained dimensions")
        if photo["removed_at"] is not None:
            require(photo["removed_by"] is not None and photo["retained_file"] is None and photo["thumbnail_file"] is None, "Removed binary was resurrected")
            continue
        require(photo["removed_by"] is None, "Invalid removal metadata")
        active_items.add(photo["item_id"])
        active_photos += 1
        for key in ("retained_file", "thumbnail_file"):
            entry = photo[key]
            require(isinstance(entry, dict) and set(entry) == {"path", "bytes", "sha256"}, "Missing file descriptor")
            path = entry["path"]
            require(re.fullmatch(r"attachments/[0-9]{6}/(retained|thumbnail)\.jpg", path) is not None, "Invalid attachment path")
            require(path not in referenced and path in files and entry == files[path], "File relationship/manifest mismatch")
            require(path.endswith("/retained.jpg" if key == "retained_file" else "/thumbnail.jpg"), "Incorrect file kind")
            referenced.add(path)
        require(photo["retained_file"]["bytes"] == photo["photo_bytes"] and photo["retained_file"]["sha256"] == photo["sha256"], "Retained file does not match saved metadata")
    require(active_photos <= 500 and active_items == set(maps["items"]), "Required photo missing/over limit")
    require(set(files) == referenced | {"data.json", "FORMAT.md", "verify.py"}, "Unrelated/unused attachment")


def verify(path):
    require(os.path.getsize(path) <= 256 * 1024 * 1024, "ZIP exceeds pilot size")
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        require(len(infos) <= 1004 and len({i.filename for i in infos}) == len(infos), "Too many/duplicate ZIP names")
        require(sum(i.file_size for i in infos) <= 272 * 1024 * 1024, "Expanded ZIP exceeds limit")
        for info in infos:
            name = info.filename
            require(name and not name.startswith("/") and "\\" not in name and ":" not in name and all(p not in ("", ".", "..") for p in name.split("/")), "Unsafe ZIP path")
            require(not stat.S_ISLNK(info.external_attr >> 16) and not info.is_dir() and not info.flag_bits & 1 and info.compress_type in (0, 8), "Unsupported ZIP entry")
        require(archive.getinfo("manifest.json").file_size <= 512 * 1024, "Manifest too large")
        manifest = json_bytes(archive.read("manifest.json"))
        require(set(manifest) == {"format", "version", "snapshot", "files"} and manifest["format"] == FORMAT and manifest["version"] in VERSIONS, "Unsupported manifest")
        files = {}
        for entry in manifest["files"]:
            require(set(entry) == {"path", "bytes", "sha256"} and isinstance(entry["path"], str), "Invalid manifest entry")
            require(entry["path"] not in files and type(entry["bytes"]) is int and 0 < entry["bytes"] <= 20 * 1024 * 1024 and HEX.fullmatch(entry["sha256"]), "Duplicate/invalid manifest entry")
            files[entry["path"]] = entry
        require(set(archive.namelist()) == set(files) | {"manifest.json"}, "Missing/extra ZIP file")
        for path, entry in files.items():
            require(archive.getinfo(path).file_size == entry["bytes"], "File byte count mismatch")
            digest = hashlib.sha256()
            with archive.open(path) as member:
                while True:
                    chunk = member.read(65536)
                    if not chunk:
                        break
                    digest.update(chunk)
            require(digest.hexdigest() == entry["sha256"], "File checksum mismatch")
        require(files["data.json"]["bytes"] <= 8 * 1024 * 1024, "Structured data too large")
        data = json_bytes(archive.read("data.json"))
        require(data["snapshot"] == manifest["snapshot"] and data["version"] == manifest["version"], "Snapshot or version mismatch")
        relationships(data, files)
        return {"valid": True, "version": data["version"], "items": len(data["items"]), "photos": len(data["photos"]), "stories": len(data["stories"]), "files": len(files)}


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 2, "Usage: python3 verify.py family-archive.zip")
        print(json.dumps(verify(sys.argv[1])))
    except Exception as error:
        print("Archive verification failed: " + str(error), file=sys.stderr)
        sys.exit(1)
