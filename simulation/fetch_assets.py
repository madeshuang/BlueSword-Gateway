"""Download only the official Genie G2 description/meshes, pinned to a commit."""
import concurrent.futures
import hashlib
import json
import urllib.request
from pathlib import Path

COMMIT = "6d5b2159806ae0e64b432b638e9ee288d8bddc8f"
REPO = "AgibotTech/genie_sim_robot_model"
DEST = Path(__file__).resolve().parent / "assets/agibot_g2"


def blob_hash(data):
    return hashlib.sha1(b"blob "+str(len(data)).encode()+b"\0"+data).hexdigest()


def main():
    url = f"https://api.github.com/repos/{REPO}/git/trees/{COMMIT}?recursive=1"
    with urllib.request.urlopen(url, timeout=30) as response:
        tree = json.load(response)
    files = [entry for entry in tree["tree"] if entry["type"] == "blob" and (
        entry["path"] in {"LICENSE", "THIRD_PARTY_NOTICES", "README.md"} or
        (entry["path"].startswith("robots/genie/g2/") and "/wuji/" not in entry["path"]))]

    def fetch(entry):
        path = DEST / entry["path"]
        if path.exists() and blob_hash(path.read_bytes()) == entry["sha"]:
            return
        with urllib.request.urlopen(f"https://raw.githubusercontent.com/{REPO}/{COMMIT}/"+entry["path"], timeout=90) as response:
            content = response.read()
        if blob_hash(content) != entry["sha"]:
            raise RuntimeError("Asset Git blob checksum mismatch: "+entry["path"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(fetch, files))
    (DEST / "SOURCE.json").write_text(json.dumps({"repository": "https://github.com/"+REPO,
        "commit": COMMIT, "license": "Apache-2.0; see THIRD_PARTY_NOTICES for bundled components",
        "files": len(files)}, indent=2)+"\n")
    print("Verified", len(files), "official G2 asset files at", COMMIT)


if __name__ == "__main__":
    main()
