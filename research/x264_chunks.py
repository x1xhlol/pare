"""x264 counterpart of av1_chunks.py: Pare's x264 settings on back-to-back chunks of length L (each an
IDR-started stream, joined), VMAF NEG against the source, BD-rate against default settings at the same L.

    python3 research/x264_chunks.py
"""
import json, os, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from evaluate import bd_rate, FFMPEG, X264  # noqa: E402

ROOT = os.path.expanduser('~/pare-research')
WORK = '/tmp/chunklen'
T = 192
CLIPS = ['town', 'park', 'bbb', 'tree']
CRFS = [18, 22, 26]
PARE = ['--preset', 'faster', '--weightp', '2', '--me', 'dia', '--partitions', 'i8x8,i4x4', '--rc-lookahead', '40']
OPTS = {
    'default': [],
    'ipratio 1.3': ['--ipratio', '1.3'],
    'ipratio 1.2': ['--ipratio', '1.2'],
    'ipratio 1.1': ['--ipratio', '1.1'],
}
LENGTHS = [32, 96, 192]
CACHE = f'{ROOT}/bench/x264_chunks.jsonl'
cache = {}
if os.path.exists(CACHE):
    for line in open(CACHE):
        r = json.loads(line); cache[(r['clip'], r['L'], r['crf'], r['opt'])] = r


def run(job):
    clip, L, crf, opt = job
    if job in cache:
        return cache[job]
    ref = f'{WORK}/{clip}-{T}.y4m'
    with tempfile.TemporaryDirectory(dir=WORK) as tmp:
        joined = f'{tmp}/all.264'
        total = 0
        for start in range(0, T, L):
            out = f'{tmp}/c{start}.264'
            subprocess.run([X264['asm'], '--threads', '1', '--quiet', *PARE, *OPTS[opt], '--crf', str(crf),
                            '--seek', str(start), '--frames', str(min(L, T - start)), '-o', out, ref],
                           check=True, capture_output=True)
            total += os.path.getsize(out)
            with open(joined, 'ab') as f:
                f.write(open(out, 'rb').read())
        log = f'{tmp}/vmaf.json'
        lavfi = ("[0:v]settb=1,setpts=N[d];[1:v]settb=1,setpts=N[r];[d][r]libvmaf=model='version=vmaf_v0.6.1neg\\:name=vmaf_neg'"
                 f":n_threads=2:log_fmt=json:log_path={log}")
        subprocess.run([FFMPEG, '-loglevel', 'error', '-f', 'h264', '-i', joined, '-i', ref, '-lavfi', lavfi,
                        '-f', 'null', '-'], check=True)
        data = json.load(open(log))
        row = {'clip': clip, 'L': L, 'crf': crf, 'opt': opt, 'bytes': total, 'frames': len(data['frames']),
               'vmaf_neg': data['pooled_metrics']['vmaf_neg']['mean']}
    with open(CACHE, 'a') as f:
        f.write(json.dumps(row) + '\n')
    cache[job] = row
    return row


def main():
    jobs = [(c, L, q, o) for L in LENGTHS for o in OPTS for c in CLIPS for q in CRFS if not (L == 192 and o != 'default')]
    with ThreadPoolExecutor(7) as pool:
        list(pool.map(run, jobs))
    for c in CLIPS:
        one = sorted([cache[(c, 192, q, 'default')] for q in CRFS], key=lambda r: r['bytes'])
        for L in (32, 96):
            base = sorted([cache[(c, L, q, 'default')] for q in CRFS], key=lambda r: r['bytes'])
            print(f'{c:6s} L={L:3d}: chunking {bd_rate(one, base, "vmaf_neg"):+6.1f}% vs one chunk; ' + ', '.join(
                f'{o} {bd_rate(base, sorted([cache[(c, L, q, o)] for q in CRFS], key=lambda r: r["bytes"]), "vmaf_neg"):+.1f}%'
                for o in OPTS if o != 'default'))


if __name__ == '__main__':
    main()
