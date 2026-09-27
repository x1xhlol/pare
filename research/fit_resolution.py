"""Fitting under a size the source's resolution can't reach: which lower resolution looks best.

Each clip gets a budget SVT-AV1 can't meet at 1080p even at Pare's highest rate factor (55). At 720p, 480p and 360p
the rate factor that fills the budget is found by bisection (Pare's AV1 settings, native, preset 8), and each result
is scored with VMAF NEG against the 1080p source after scaling back up (bicubic). Pare's rule (x264.ts, fitSide)
picks the largest resolution predicted to fit 5 rate factor steps below the highest; this shows what that costs or
gains against the others.

    python3 research/fit_resolution.py
"""
import json, os, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from evaluate import FFMPEG  # noqa: E402

ROOT = os.path.expanduser('~/pare-research')
SVT = f'{ROOT}/svt-av1/Bin/Release/SvtAv1EncApp'
# Clip, and a budget in bytes out of reach at 1080p.
CLIPS = {'bbb': (f'{ROOT}/corpus/bbb.mp4', 1.0e6), 'town': (f'{ROOT}/corpus/town.mp4', 0.35e6),
         'park': (f'{ROOT}/corpus/park.mp4', 0.8e6), 'ducks': (f'{ROOT}/corpus/ducks.mp4', 0.6e6)}
HEIGHTS = [1080, 720, 480, 360]
PARE = ['--preset', '8', '--use-fixed-qindex-offsets', '2', '--key-frame-qindex-offset', '24', '--enable-qm', '1',
        '--keyint', '10s', '--lp', '2']
CACHE = f'{ROOT}/bench/fit_resolution.jsonl'
cache = {}
if os.path.exists(CACHE):
    for line in open(CACHE):
        r = json.loads(line); cache[(r['clip'], r['height'], r['crf'])] = r


def encode(clip, height, crf, score=False):
    key = (clip, height, crf)
    if key in cache and (not score or 'vmaf_neg' in cache[key]):
        return cache[key]
    src = CLIPS[clip][0]
    with tempfile.TemporaryDirectory() as tmp:
        out = f'{tmp}/o.ivf'
        scale = [] if height == 1080 else ['-vf', f'scale=-2:{height}:flags=bicubic']
        dec = subprocess.Popen([FFMPEG, '-loglevel', 'error', '-i', src, *scale, '-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe', '-'],
                               stdout=subprocess.PIPE)
        subprocess.run([SVT, '-i', 'stdin', '--crf', str(crf), *PARE, '-b', out], stdin=dec.stdout, check=True,
                       capture_output=True)
        dec.wait()
        row = {'clip': clip, 'height': height, 'crf': crf, 'bytes': os.path.getsize(out)}
        if score:
            log = f'{tmp}/vmaf.json'
            lavfi = ("[0:v]scale=1920:1080:flags=bicubic,format=yuv420p,settb=1,setpts=N[d];[1:v]format=yuv420p,settb=1,setpts=N[r];"
                     f"[d][r]libvmaf=model='version=vmaf_v0.6.1neg\\:name=neg':n_threads=2:log_fmt=json:log_path={log}")
            subprocess.run([FFMPEG, '-loglevel', 'error', '-i', out, '-i', src, '-lavfi', lavfi, '-f', 'null', '-'], check=True)
            frames = [f['metrics']['neg'] for f in json.load(open(log))['frames']]
            row.update(vmaf_neg=sum(frames) / len(frames), worst=sorted(frames)[len(frames) // 100])
    with open(CACHE, 'a') as f:
        f.write(json.dumps(row) + '\n')
    cache[key] = row
    return row


def at_budget(clip, height, budget):
    """The lowest rate factor up to 63 that fits, scored; or 63, scored, when none does."""
    lo, hi = 10, 63
    if encode(clip, height, hi)['bytes'] > budget:
        return encode(clip, height, hi, score=True)
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if encode(clip, height, mid)['bytes'] > budget:
            lo = mid
        else:
            hi = mid
    return encode(clip, height, hi, score=True)


def main():
    for clip, (_, budget) in CLIPS.items():
        rows = [at_budget(clip, h, budget) for h in HEIGHTS]
        print(f'{clip:6s} {budget / 1e6:4.2f} MB  ' + '  '.join(
            f'{h}p crf {r["crf"]:2d}: {r["vmaf_neg"]:6.2f} ({r["worst"]:6.2f}){" over" if r["bytes"] > budget else ""}'
            for h, r in zip(HEIGHTS, rows)), flush=True)


if __name__ == '__main__':
    main()
