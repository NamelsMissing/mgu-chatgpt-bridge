#!/usr/bin/env python3
"""Sync native component payload and package the app, service, broker and sources."""
from pathlib import Path
import json, shutil, tarfile, zipfile, hashlib
ROOT=Path(__file__).resolve().parents[1]
DIST=ROOT/'dist'
DIST.mkdir(exist_ok=True)
native=ROOT/'native/chatgpt-bridge'
for directory,files in {'agent':['agent.js','executor.js','network-worker.js'],'shared':['protocol.js']}.items():
    (native/directory).mkdir(exist_ok=True)
    for file in files: shutil.copy2(ROOT/directory/file,native/directory/file)
shutil.copy2(ROOT/'agent/config.example.json',native/'config.example.json')
shutil.copy2(ROOT/'apps/mgu_chatgpt_bridge/QR-LICENSE',ROOT/'THIRD_PARTY_QR_LICENSE')
manifest=json.loads((native/'component.json').read_text())
for item in manifest['files']:
    f=native/item.get('from',item['path'])
    if not f.is_file(): raise RuntimeError(f'Missing component payload: {f}')
    f.chmod(int(item['mode'],8))
for f in [native/'mgu-chatgpt-bridge',ROOT/'tools/install-agent.sh']: f.chmod(0o755)
with tarfile.open(DIST/'mgu-chatgpt-bridge-service-0.1.0.tgz','w:gz') as t:
    for directory in ['agent','shared','native/chatgpt-bridge','tools']:
        for f in sorted((ROOT/directory).rglob('*')):
            if f.is_file() and '__pycache__' not in f.parts:t.add(f,arcname=str(f.relative_to(ROOT)))
    t.add(ROOT/'README.md',arcname='README.md')
archive=DIST/'MGU_ChatGPT_Bridge_v0.1.0.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
    for f in sorted(ROOT.rglob('*')):
        if not f.is_file():continue
        rel=f.relative_to(ROOT)
        if any(p in {'oap-sdk','.git','__pycache__','node_modules','data'} for p in rel.parts):continue
        if rel.parts[0]=='dist':continue
        z.write(f,'mgu-chatgpt-bridge/'+str(rel))
    for name in ['mgu_chatgpt_bridge@0.1.0.mgu','mgu_chatgpt_bridge@0.1.0.tgz','mgu-chatgpt-bridge-service-0.1.0.tgz']:
        f=DIST/name
        if not f.exists():raise RuntimeError('Build app first: '+name)
        z.write(f,'mgu-chatgpt-bridge/dist/'+name)
checks=[]
for f in sorted(DIST.iterdir()):
    if f.is_file() and f.name!='SHA256SUMS':checks.append(hashlib.sha256(f.read_bytes()).hexdigest()+'  '+f.name)
(DIST/'SHA256SUMS').write_text('\n'.join(checks)+'\n')
print(archive,archive.stat().st_size)
