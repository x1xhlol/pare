"""Whether SVT-AV1's own keyframe interval costs Pare's AV1 chunks.

SVT-AV1 puts a keyframe every ((fps + 32) / 32) * 32 * 5 frames by default (enc_handle.c, compute_default_intra_period):
160 at 24-30 fps, 320 at 50-60. Pare's chunks already start with a keyframe each, and on videos from about 43 s at
30 fps they run past 160 frames. Encodes the first 240 frames of each clip as one chunk (preset 8, one thread, at
30 fps, as a 30 fps source would be) with the default interval and with none inside the chunk (keyint -1), and
reports the BD-rate on VMAF NEG plus the size change at each rate factor.

    python3 research/av1_keyint.py
"""
import json, os, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from evaluate import bd_rate, FFMPEG  # noqa: E402

ROOT = os.path.expanduser('~/pare-research')
SVT = f'{ROOT}/svt-av1/Bin/Release/SvtAv1EncApp'
REF = f'{ROOT}/corpus/ref'
T = 240
CRFS = [22, 30, 38, 46]
CLIPS = ['bbb', 'screen', 'town', 'tree', 'park']
CACHE = f'{ROOT}/av1/keyint.jsonl'
PARE = ['--use-fixed-qindex-offsets', '2', '--key-frame-qindex-offset', '24', '--enable-qm', '1']
SWITCHES = {'default': [], 'keyint -1': ['--keyint', '-1']}
cache = {}
if os.path.exists(CACHE):
    for line in open(CACHE):
        r = json.loads(line); cache[(r['clip'], r['crf'], r['switch'])] = r


def run(job):
    clip, crf, switch = job
    if job in cache:
        return cache[job]
    ref = f'{REF}/{clip}.y4m'
    with tempfile.TemporaryDirectory() as tmp:
        out = f'{tmp}/c.ivf'
        subprocess.run([SVT, '-i', ref, '-n', str(T), '--fps-num', '30', '--fps-denom', '1', '--preset', '8',
                        '--crf', str(crf), '--lp', '1', *PARE, *SWITCHES[switch], '-b', out], check=True, capture_output=True)
        keys = subprocess.run([os.path.join(os.path.dirname(FFMPEG), 'ffprobe'), '-v', 'error', '-select_streams', 'v', '-show_entries',
                               'packet=flags', '-of', 'csv=p=0', out], capture_output=True, text=True).stdout.count('K')
        log = f'{tmp}/vmaf.json'
        lavfi = ("[0:v]settb=1,setpts=N[d];[1:v]trim=end_frame=240,settb=1,setpts=N[r];"
                 "[d][r]libvmaf=model='version=vmaf_v0.6.1neg\\:name=vmaf_neg'"
                 f":n_threads=2:log_fmt=json:log_path={log}")
        subprocess.run([FFMPEG, '-loglevel', 'error', '-i', out, '-i', ref, '-lavfi', lavfi, '-f', 'null', '-'], check=True)
        data = json.load(open(log))
        row = {'clip': clip, 'crf': crf, 'switch': switch, 'bytes': os.path.getsize(out), 'keyframes': keys,
               'frames': len(data['frames']), 'vmaf_neg': data['pooled_metrics']['vmaf_neg']['mean']}
    with open(CACHE, 'a') as f:
        f.write(json.dumps(row) + '\n')
    cache[job] = row
    return row


def main():
    jobs = [(c, q, s) for c in CLIPS for q in CRFS for s in SWITCHES]
    with ThreadPoolExecutor(4) as pool:
        list(pool.map(run, jobs))
    print(f'{"clip":8s} {"BD-rate":>8s}   keyframes   size change at CRF ' + ' '.join(f'{q:>6d}' for q in CRFS))
    for c in CLIPS:
        base = sorted([cache[(c, q, 'default')] for q in CRFS], key=lambda r: r['bytes'])
        test = sorted([cache[(c, q, 'keyint -1')] for q in CRFS], key=lambda r: r['bytes'])
        sizes = ' '.join(f'{100 * (cache[(c, q, "keyint -1")]["bytes"] / cache[(c, q, "default")]["bytes"] - 1):+5.1f}%' for q in CRFS)
        vm = ' '.join(f'{cache[(c, q, "keyint -1")]["vmaf_neg"] - cache[(c, q, "default")]["vmaf_neg"]:+5.2f}' for q in CRFS)
        print(f'{c:8s} {bd_rate(base, test, "vmaf_neg"):+7.2f}%   {cache[(c, 30, "default")]["keyframes"]} -> '
              f'{cache[(c, 30, "keyint -1")]["keyframes"]}      {sizes}   VMAF NEG {vm}')


if __name__ == '__main__':
    main()
