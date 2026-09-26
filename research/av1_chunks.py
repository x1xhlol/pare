"""What Pare's parallel chunks cost SVT-AV1, and what cheaper keyframes win back.

Encodes the first 192 frames of a corpus clip as back-to-back chunks of L frames with native SVT-AV1 (preset 8, one
thread, as in Pare), each chunk its own stream starting with a keyframe, joins them and scores the result with VMAF
NEG against the source. Reports BD-rate against one 192-frame encode (`lengths`), or of each switch against default
settings at the same chunk length (`keyframes`).

    python3 research/av1_chunks.py lengths|keyframes
"""
import json, os, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from evaluate import bd_rate, FFMPEG  # noqa: E402

ROOT = os.path.expanduser('~/pare-research')
SVT = f'{ROOT}/svt-av1/Bin/Release/SvtAv1EncApp'
REF = f'{ROOT}/corpus/ref'
WORK = '/tmp/chunklen'
T = 192
CRFS = [22, 30, 38]
CACHE = f'{ROOT}/av1/chunks.jsonl'
LENGTHS = [24, 31, 32, 33, 36, 40, 48, 49, 64, 65, 96, 192]
SWITCHES = {
    'default': [],
    'kf q-8': ['--use-fixed-qindex-offsets', '2', '--key-frame-qindex-offset', '-8'],
    'kf q+8': ['--use-fixed-qindex-offsets', '2', '--key-frame-qindex-offset', '8'],
    'kf q+16': ['--use-fixed-qindex-offsets', '2', '--key-frame-qindex-offset', '16'],
    'kf q+24': ['--use-fixed-qindex-offsets', '2', '--key-frame-qindex-offset', '24'],
    'kf q+40': ['--use-fixed-qindex-offsets', '2', '--key-frame-qindex-offset', '40'],
    'kf tf off': ['--enable-kf-tf', '0'],
    'startup mg 3': ['--startup-mg-size', '3'],
    'kf q+24, mg 3': ['--use-fixed-qindex-offsets', '2', '--key-frame-qindex-offset', '24', '--startup-mg-size', '3'],
}
cache = {}
if os.path.exists(CACHE):
    for line in open(CACHE):
        r = json.loads(line); cache[(r['clip'], r['L'], r['crf'], r['switch'])] = r


def head(clip):
    path = f'{WORK}/{clip}-{T}.y4m'
    if not os.path.exists(path):
        os.makedirs(WORK, exist_ok=True)
        subprocess.run([FFMPEG, '-loglevel', 'error', '-y', '-i', f'{REF}/{clip}.y4m', '-frames:v', str(T), path], check=True)
    return path


def run(job):
    clip, L, crf, switch = job
    if job in cache:
        return cache[job]
    ref = head(clip)
    with tempfile.TemporaryDirectory(dir=WORK) as tmp:
        total, parts = 0, []
        for start in range(0, T, L):
            out = f'{tmp}/c{start}.ivf'
            subprocess.run([SVT, '-i', ref, '--skip', str(start), '-n', str(min(L, T - start)), '--preset', '8',
                            '--crf', str(crf), '--lp', '1', *SWITCHES[switch], '-b', out], check=True, capture_output=True)
            total += os.path.getsize(out)
            parts.append(out)
        with open(f'{tmp}/list.txt', 'w') as f:
            f.write(''.join(f"file '{p}'\n" for p in parts))
        log = f'{tmp}/vmaf.json'
        lavfi = ("[0:v]settb=1,setpts=N[d];[1:v]settb=1,setpts=N[r];[d][r]libvmaf=model='version=vmaf_v0.6.1neg\\:name=vmaf_neg'"
                 f":n_threads=2:log_fmt=json:log_path={log}")
        subprocess.run([FFMPEG, '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', f'{tmp}/list.txt', '-i', ref,
                        '-lavfi', lavfi, '-f', 'null', '-'], check=True)
        data = json.load(open(log))
        row = {'clip': clip, 'L': L, 'crf': crf, 'switch': switch, 'bytes': total, 'frames': len(data['frames']),
               'vmaf_neg': data['pooled_metrics']['vmaf_neg']['mean']}
    with open(CACHE, 'a') as f:
        f.write(json.dumps(row) + '\n')
    cache[job] = row
    return row


def curve(clip, L, switch):
    return sorted([cache[(clip, L, q, switch)] for q in CRFS], key=lambda r: r['bytes'])


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'lengths'
    clips = ['town', 'park', 'bbb'] if mode == 'lengths' else ['town', 'park', 'bbb', 'tree']
    if mode == 'lengths':
        jobs = [(c, L, q, 'default') for c in clips for L in LENGTHS for q in CRFS]
    else:
        jobs = [(c, L, q, s) for L in (32, 96) for s in SWITCHES for c in clips for q in CRFS]
    for c in clips:
        head(c)
    with ThreadPoolExecutor(6) as pool:
        list(pool.map(run, jobs))
    if mode == 'lengths':
        print(f'{"L":>4s}  ' + '  '.join(f'{c:>8s}' for c in clips) + '   (BD-rate VMAF NEG vs one 192-frame chunk)')
        for L in LENGTHS:
            print(f'{L:4d}  ' + '  '.join(f'{bd_rate(curve(c, T, "default"), curve(c, L, "default"), "vmaf_neg"):+7.1f}%'
                                          for c in clips))
    else:
        for L in (32, 96):
            print(f'{"switch":14s}  ' + '  '.join(f'{c:>7s}' for c in clips) + f'   (BD-rate VMAF NEG vs default, {L}-frame chunks)')
            for s in SWITCHES:
                print(f'{s:14s}  ' + '  '.join(f'{bd_rate(curve(c, L, "default"), curve(c, L, s), "vmaf_neg"):+6.1f}%'
                                               for c in clips))


if __name__ == '__main__':
    main()
