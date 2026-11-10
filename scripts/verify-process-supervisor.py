"""Exercise the actual desktop executable's helper without launching its UI."""
import json, os, signal, subprocess, sys, time
from pathlib import Path
exe = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).resolve().parents[1] / 'src-tauri/target/debug/once-more')
flag = '--once-more-processing-child'
def gone(pid):
    try: os.kill(pid, 0); return False
    except ProcessLookupError: return True
# Normal EOF: same route used by the application's graceful exit cleanup.
p = subprocess.Popen([exe, flag, '/bin/sh', '-c', 'echo $$; exec /bin/sleep 30'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
worker = int(p.stdout.readline())
p.stdin.close()
assert p.wait(timeout=5) != 0
assert gone(worker), 'worker survived pipe EOF'
# A separate parent owns the pipe. SIGKILL cannot run any cleanup in that parent.
parent_code = '''import subprocess,sys,json,time
p=subprocess.Popen([sys.argv[1],sys.argv[2],'/bin/sh','-c','echo $$; exec /bin/sleep 30'],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
print(json.dumps([p.pid,int(p.stdout.readline())]),flush=True)
time.sleep(30)
'''
parent = subprocess.Popen([sys.executable, '-c', parent_code, exe, flag], stdout=subprocess.PIPE)
supervisor, worker = json.loads(parent.stdout.readline())
parent.kill(); parent.wait(timeout=5)
limit = time.monotonic() + 5
while time.monotonic() < limit and not (gone(worker) and gone(supervisor)): time.sleep(.05)
assert gone(worker), 'worker survived parent SIGKILL'
assert gone(supervisor), 'supervisor did not exit'
# Exit codes and both output streams survive the extra process boundary.
# Do not close the lifetime pipe before a short command completes.
p = subprocess.Popen([exe, flag, '/bin/sh', '-c', 'printf hello; printf problem >&2; exit 7'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
assert p.wait(timeout=5) == 7
assert p.stdout.read() == b'hello' and p.stderr.read() == b'problem'
p.stdin.close()
print('PASS: EOF cleanup, parent SIGKILL cleanup, output and exit status')
