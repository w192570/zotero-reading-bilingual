"""Read-only syntax, whitespace and XPI consistency checks. Python stdlib only.

Does not build, install, commit, push, alter preferences, or run behaviour tests.
JSON is written to stdout; callers may save it with their validation evidence.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def runtime_files(root):
    paths = [root / name for name in ("manifest.json", "bootstrap.js", "prefs.js")]
    paths.extend(path for path in (root / "content").rglob("*") if path.is_file())
    if not (root / "content").is_dir():
        raise ValueError("Missing content directory")
    files = {}
    for path in sorted(paths):
        if not path.is_file():
            raise ValueError(f"Missing runtime file: {path.name}")
        if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError(f"Runtime file points outside the source tree: {path.name}")
        files[path.relative_to(root).as_posix()] = path
    return files


def fingerprint(files):
    digest = hashlib.sha256()
    for name, path in sorted(files.items()):
        digest.update(name.encode("utf-8") + b"\0")
        digest.update(bytes.fromhex(sha256(path)))
    return digest.hexdigest()


def verify_archive(files, archive_path, version):
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("XPI contains duplicate entries")
        missing = sorted(set(files) - set(names))
        extra = sorted(set(names) - set(files))
        if missing or extra:
            raise ValueError(f"XPI file list differs: missing={missing}, extra={extra}")
        broken = archive.testzip()
        if broken:
            raise ValueError(f"XPI CRC check failed: {broken}")
        if json.loads(archive.read("manifest.json"))["version"] != version:
            raise ValueError("XPI manifest version differs from current source")
        for name, path in files.items():
            if archive.read(name) != path.read_bytes():
                raise ValueError(f"XPI is stale or different from source: {name}")
    return {
        "path": str(archive_path),
        "bytes": archive_path.stat().st_size,
        "sha256": sha256(archive_path),
        "runtime_files": len(files),
        "matches_current_source": True,
    }


def command(root, args):
    # Avoid optional Git index refreshes. This checker must not stage or edit.
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0")
    result = subprocess.run(args, cwd=root, env=env, capture_output=True,
                            encoding="utf-8", errors="replace", timeout=60)
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()
        raise ValueError(f"{' '.join(args)} failed: {detail[:1200]}")
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--xpi", type=Path, help="Verify this XPI against the current runtime source")
    parser.add_argument("--copy", type=Path, help="Verify a delivered copy has the same hash as --xpi")
    args = parser.parse_args()
    if args.copy and not args.xpi:
        parser.error("--copy requires --xpi")
    root = Path(__file__).resolve().parent.parent
    report = {
        "scope": "syntax_whitespace_and_artifact_consistency_only",
        "behaviour_tests": "NOT_RUN",
        "desktop_validation": "NOT_CHECKED",
        "root": str(root),
        "errors": [],
    }
    try:
        files = runtime_files(root)
        version = json.loads((root / "manifest.json").read_text(encoding="utf-8"))["version"]
        before = fingerprint(files)
        report.update(version=version, runtime_files=len(files), runtime_fingerprint=before)
        report["git"] = {
            "head": command(root, ["git", "rev-parse", "HEAD"]),
            "branch": command(root, ["git", "branch", "--show-current"]),
            "status": command(root, ["git", "status", "--short"]).splitlines(),
        }
        command(root, ["git", "diff", "--check"])
        command(root, ["git", "diff", "--cached", "--check"])
        if not shutil.which("node"):
            raise ValueError("Node.js is required for syntax checking")
        scripts = sorted({path for path in files.values() if path.suffix in (".js", ".mjs", ".cjs")}
                         | {path for path in (root / "tests").rglob("*.cjs") if path.is_file()})
        for path in scripts:
            command(root, ["node", "--check", str(path)])
        report["syntax_checked"] = len(scripts)
        if args.xpi:
            report["xpi"] = verify_archive(files, args.xpi.resolve(), version)
        if args.copy:
            delivered = args.copy.resolve()
            if sha256(delivered) != report["xpi"]["sha256"]:
                raise ValueError("Delivered copy differs from the verified XPI")
            report["copy"] = {"path": str(delivered), "sha256": sha256(delivered), "matches_xpi": True}
        if fingerprint(runtime_files(root)) != before:
            raise ValueError("Runtime source changed during verification; rerun after edits finish")
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        report["errors"].append(str(error))
    report["ok"] = not report["errors"]
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    sys.exit(main())
