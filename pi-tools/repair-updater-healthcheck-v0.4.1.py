#!/usr/bin/env python3
"""One-time repair: give BMW AI Pi time to start before judging an update.
Only changes health() in the existing root-owned updater; secrets are untouched.
"""
import ast
import os
from pathlib import Path
import shutil
import stat
import tempfile
from datetime import datetime, timezone

TARGET = Path('/usr/local/libexec/bmw-ai-updater.py')
OLD = """    try:
        with urllib.request.urlopen('http://127.0.0.1:8790/health',timeout=5) as r:
            d=json.load(r)
        return d.get('ok') is True and d.get('version')==expected
    except Exception:
        return False"""
NEW = """    deadline=time.monotonic()+30
    while time.monotonic()<deadline:
        try:
            with urllib.request.urlopen('http://127.0.0.1:8790/health',timeout=3) as r:
                d=json.load(r)
            if d.get('ok') is True and d.get('version')==expected:
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False"""

def patch(path):
    if path.is_symlink() or not path.is_file():
        raise RuntimeError('Updater missing or symlink: ' + str(path))
    before = path.read_text('utf8')
    if NEW in before:
        print('Health-Check repair already installed; no changes needed')
        return False
    if before.count(OLD) != 1 or 'def health(expected):' not in before or 'import time' not in before:
        raise RuntimeError('Unexpected updater version. Refusing to patch automatically.')
    after = before.replace(OLD, NEW)
    ast.parse(after, filename=str(path))
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
    backup = path.with_name(path.name + '.before-health-fix-' + stamp + '.bak')
    shutil.copy2(path, backup)
    fd, temp = tempfile.mkstemp(prefix='.bmw-ai-health-', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf8') as f:
            f.write(after)
            f.flush()
            os.fsync(f.fileno())
        oldstat = path.stat()
        os.chmod(temp, stat.S_IMODE(oldstat.st_mode))
        os.chown(temp, oldstat.st_uid, oldstat.st_gid)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    print('Health-Check repair installed. The updater will now wait up to 30 seconds.')
    print('Original updater backup: ' + str(backup))
    return True

if __name__ == '__main__':
    if os.geteuid() != 0:
        raise SystemExit('Run with sudo, on the Raspberry Pi.')
    patch(TARGET)
