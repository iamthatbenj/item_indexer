"""Test-only ZIP mutations. Never used by application generation or restoration."""
import hashlib
import json
import sys
import zipfile

source, target, mutation = sys.argv[1:]
with zipfile.ZipFile(source) as archive:
    entries = {name: archive.read(name) for name in archive.namelist()}
manifest = json.loads(entries["manifest.json"])
data = json.loads(entries["data.json"])
attachment = next(name for name in entries if name.endswith("/retained.jpg"))
if mutation == "missing":
    del entries[attachment]
elif mutation == "altered":
    entries[attachment] = entries[attachment][:-1] + bytes([entries[attachment][-1] ^ 1])
elif mutation == "dangling":
    data["items"][0]["current_keeper_id"] = "missing-person"
    data["items"][0]["current_keeper_version"] = 1
elif mutation == "history":
    data["items"][0]["version"] += 1
elif mutation == "permission":
    data["contributors"][0]["session_token"] = "NOT_A_PERMISSION"
elif mutation == "version":
    data["version"] = manifest["version"] = "99.0"
elif mutation == "path":
    entries["../outside"] = b"never extract"
elif mutation != "duplicate":
    raise ValueError("Unknown mutation")
if mutation in ("dangling", "history", "permission", "version"):
    entries["data.json"] = json.dumps(data).encode("utf-8")
    for entry in manifest["files"]:
        if entry["path"] == "data.json":
            entry["bytes"] = len(entries["data.json"])
            entry["sha256"] = hashlib.sha256(entries["data.json"]).hexdigest()
    entries["manifest.json"] = json.dumps(manifest).encode("utf-8")
with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for name, body in entries.items():
        archive.writestr(name, body)
    if mutation == "duplicate":
        archive.writestr("data.json", entries["data.json"])
