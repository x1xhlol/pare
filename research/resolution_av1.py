"""resolution.py for SVT-AV1: at the size budget, AV1 (Pare's settings, native) at 1080p against 720p and 540p, each
scored against the 1080p source after scaling back up (bicubic).

    python3 research/resolution_av1.py [budget share, default 0.47]
"""
import json, os, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from evaluate import FFMPEG  # noqa: E402

ROOT = os.path.expanduser('~/pare-research')
SVT = f'{ROOT}/svt-av1/Bin/Release/SvtAv1EncApp'
CLIPS = {'jelly': '/tmp/pare/jelly.mp4', 'ducks': f'{ROOT}/corpus/ducks.mp4'}
HEIGHTS = [1080, 720, 540]
PARE = ['--preset', '8', '--use-fixed-qindex-offsets', '2', '--key-frame-qindex-offset', '24', '--enable-qm', '1',
        '--keyint', '10s', '--lp', '4']
CACHE = f'{ROOT}/bench/resolution_av1.jsonl'
cache = {}
if os.path.exists(CACHE):
    for line in open(CACHE):
        r = json.loads(line); cache[(r['clip'], r['height'], r['crf'])] = r


def encode(clip, height, crf):
    key = (clip, height, crf)
    if key in cache:
        return cache[key]
    src = CLIPS[clip]
    with tempfile.TemporaryDirectory() as tmp:
        out = f'{tmp}/o.ivf'
        scale = [] if height == 1080 else ['-vf', f'scale=-2:{height}:flags=bicubic']
        dec = subprocess.Popen([FFMPEG, '-loglevel', 'error', '-i', src, *scale, '-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe', '-'],
                               stdout=subprocess.PIPE)
        subprocess.run([SVT, '-i', 'stdin', '--crf', str(crf), *PARE, '-b', out], stdin=dec.stdout, check=True,
                       capture_output=True)
        dec.wait()
        log = f'{tmp}/vmaf.json'
        lavfi = ("[0:v]scale=1920:1080:flags=bicubic,format=yuv420p,settb=1,setpts=N[d];[1:v]format=yuv420p,settb=1,setpts=N[r];"
                 f"[d][r]libvmaf=model='version=vmaf_v0.6.1neg\\:name=neg':n_threads=2:log_fmt=json:log_path={log}")
        subprocess.run([FFMPEG, '-loglevel', 'error', '-i', out, '-i', src, '-lavfi', lavfi, '-f', 'null', '-'], check=True)
        frames = [f['metrics']['neg'] for f in json.load(open(log))['frames']]
        row = {'clip': clip, 'height': height, 'crf': crf, 'bytes': os.path.getsize(out),
               'vmaf_neg': sum(frames) / len(frames), 'worst': sorted(frames)[len(frames) // 100]}
    with open(CACHE, 'a') as f:
        f.write(json.dumps(row) + '\n')
    cache[key] = row
    return row


def at_budget(clip, height, budget):
    lo, hi, best = 20, 63, None
    for _ in range(6):
        crf = (lo + hi) // 2
        r = encode(clip, height, crf)
        if r['bytes'] > budget:
            lo = crf
        else:
            hi, best = crf, r
    return best or encode(clip, height, hi)


def main():
    share = float(sys.argv[1]) if len(sys.argv) > 1 else 0.47
    for clip in CLIPS:
        budget = share * os.path.getsize(CLIPS[clip])
        rows = [at_budget(clip, h, budget) for h in HEIGHTS]
        print(f'{clip:6s} ' + '  '.join(f'{h}p crf {r["crf"]}: {r["vmaf_neg"]:6.2f} ({r["worst"]:6.2f}) {r["bytes"] / 1e6:5.2f} MB'
                                       for h, r in zip(HEIGHTS, rows)))


if __name__ == '__main__':
    main()
