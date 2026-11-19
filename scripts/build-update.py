#!/usr/bin/env python3
"""Build signed macOS update artifacts locally. Does not publish a release."""
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
from datetime import datetime, timezone
from urllib.parse import quote

root = Path(__file__).resolve().parents[1]
config = json.loads((root / 'src-tauri/tauri.conf.json').read_text())
version = config['version']
key = Path(os.environ.get('ONCE_MORE_UPDATE_KEY', str(Path.home() / '.tauri/once-more-updater.key')))
if platform.system() != 'Darwin':
    raise SystemExit('This packaging script currently supports macOS only.')
if not key.is_file():
    raise SystemExit('Update signing key missing. Set ONCE_MORE_UPDATE_KEY to its local path.')
public = Path(str(key) + '.pub')
if not public.is_file() or public.read_text().strip() != config['plugins']['updater']['pubkey']:
    raise SystemExit('Signing key does not match the public key embedded in the app.')
env = os.environ.copy()
env['TAURI_SIGNING_PRIVATE_KEY'] = str(key)
env.setdefault('TAURI_SIGNING_PRIVATE_KEY_PASSWORD', '')
subprocess.run(['npm', 'run', 'tauri', '--', 'build', '--bundles', 'app', '--config', json.dumps({'bundle': {'createUpdaterArtifacts': True}})], cwd=root, env=env, check=True)
# Reject incomplete bundle signatures before preparing public release artifacts.
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(root / 'src-tauri/target/release/bundle/macos/Once More.app')], check=True)
arch = {'arm64': 'aarch64', 'x86_64': 'x86_64'}[platform.machine()]
source = root / 'src-tauri/target/release/bundle/macos/Once More.app.tar.gz'
output = root / 'output/updates' / version / arch
output.mkdir(parents=True, exist_ok=True)
name = f'Once-More-{version}-macos-{arch}.app.tar.gz'
shutil.copy2(source, output / name)
shutil.copy2(Path(str(source) + '.sig'), output / (name + '.sig'))
manifest = {'version': version, 'notes': f'Once More {version}', 'pub_date': datetime.now(timezone.utc).isoformat(), 'platforms': {f'darwin-{arch}': {'signature': (output / (name + '.sig')).read_text().strip(), 'url': f'https://github.com/ea5y/once-more/releases/download/v{quote(version)}/{quote(name)}'}}}
(output / 'latest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(f'Signed artifacts prepared in {output}; nothing published.')
