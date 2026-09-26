"""Whether a lower resolution looks better than the source's at the same file size (the per-title "convex hull").

At half the size, Pare's hardest clips score VMAF NEG 71-84 at their own resolution. Encoded smaller and scaled back
up on playback, the same bytes may look better. For each clip this finds, with Pare's x264 settings (ffmpeg's libx264),
the rate factor that hits the size budget at 1080p and at 720p (and 540p), then scores each against the 1080p source
with VMAF NEG after scaling it back up (bicubic, as a player would).

    python3 research/resolution.py [budget share of the source, default 0.47]
"""
import json, os, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from evaluate import FFMPEG  # noqa: E402

ROOT = os.path.expanduser('~/pare-research')
CLIPS = {'ducks': f'{ROOT}/corpus/ducks.mp4', 'park': f'{ROOT}/corpus/park.mp4', 'noisy': f'{ROOT}/corpus/noisy.mp4',
         'town': f'{ROOT}/corpus/town.mp4', 'jelly': '/tmp/pare/jelly.mp4', 'bbb': '/tmp/pare/bbb30.mp4'}
HEIGHTS = [1080, 720, 540]
PARE = 'preset=faster:weightp=2:me=dia:partitions=i8x8,i4x4:rc-lookahead=40'
CACHE = f'{ROOT}/bench/resolution.jsonl'
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
        out = f'{tmp}/o.mp4'
        scale = [] if height == 1080 else ['-vf', f'scale=-2:{height}:flags=bicubic']
        subprocess.run([FFMPEG, '-loglevel', 'error', '-y', '-i', src, *scale, '-an', '-c:v', 'libx264', '-crf', f'{crf:.2f}',
                        '-x264-params', PARE, '-threads', '2', out], check=True)
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
    """The rate factor landing on the budget (bisection on the real encode, to 0.25), and that encode."""
    lo, hi = 10.0, 45.0
    best = None
    for _ in range(7):
        crf = round((lo + hi) / 2 * 4) / 4
        r = encode(clip, height, crf)
        if r['bytes'] > budget:
            lo = crf
        else:
            hi, best = crf, r
    return best or encode(clip, height, hi)


def main():
    share = float(sys.argv[1]) if len(sys.argv) > 1 else 0.47
    def run(clip):
        budget = share * os.path.getsize(CLIPS[clip])
        return clip, [at_budget(clip, h, budget) for h in HEIGHTS]
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(run, CLIPS))
    print(f'{"clip":6s} ' + '  '.join(f'{h}p: crf, VMAF NEG (worst 1%)'.ljust(34) for h in HEIGHTS))
    for clip, rows in results:
        print(f'{clip:6s} ' + '  '.join(f'{r["crf"]:5.2f}, {r["vmaf_neg"]:6.2f} ({r["worst"]:6.2f}) {r["bytes"] / 1e6:5.2f} MB'.ljust(34) for r in rows))


if __name__ == '__main__':
    main()
