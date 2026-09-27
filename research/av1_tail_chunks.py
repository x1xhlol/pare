"""Chunk keyframes at AV1's highest rate factors: how much a small budget loses to them.

Encodes Big Buck Bunny (300 frames) and town (250) as 1, 3 and 8 back-to-back chunks with Pare's AV1 settings
(native SVT-AV1, preset 8, each chunk its own encode starting on a keyframe), at CRF 56 and 61, joins them, scores VMAF
NEG against the source, and interpolates to the budget (log size against VMAF NEG).

    python3 research/av1_tail_chunks.py
"""
import os, subprocess, tempfile, json, math
ROOT = os.path.expanduser('~/pare-research')
FF = f'{ROOT}/ffmpeg-master-latest-linux64-gpl/bin/ffmpeg'
SVT = f'{ROOT}/svt-av1/Bin/Release/SvtAv1EncApp'
PARE = ['--preset', '8', '--use-fixed-qindex-offsets', '2', '--key-frame-qindex-offset', '24', '--enable-qm', '1', '--keyint', '-1', '--lp', '2']
def run(clip, frames, chunks, crf):
    ref = f'{ROOT}/corpus/ref/{clip}.y4m'
    bounds = [round(i * frames / chunks) for i in range(chunks + 1)]
    with tempfile.TemporaryDirectory() as tmp:
        total = 0
        parts = []
        for i, (s, e) in enumerate(zip(bounds, bounds[1:])):
            dec = subprocess.Popen([FF, '-v', 'error', '-i', ref, '-vf', f'trim=start_frame={s}:end_frame={e},setpts=N', '-f', 'yuv4mpegpipe', '-strict', '-1', '-'], stdout=subprocess.PIPE)
            out = f'{tmp}/c{i}.ivf'
            subprocess.run([SVT, '-i', 'stdin', '--crf', str(crf), *PARE, '-b', out], stdin=dec.stdout, check=True, capture_output=True)
            dec.wait(); total += os.path.getsize(out); parts.append(out)
        with open(f'{tmp}/list.txt', 'w') as f:
            for p in parts: f.write(f"file '{p}'\n")
        log = f'{tmp}/v.json'
        subprocess.run([FF, '-v', 'error', '-f', 'concat', '-safe', '0', '-i', f'{tmp}/list.txt', '-i', ref, '-lavfi',
            f"[0:v]settb=1,setpts=N[d];[1:v]trim=end_frame={frames},settb=1,setpts=N[r];[d][r]libvmaf=model='version=vmaf_v0.6.1neg\\:name=neg':n_threads=2:log_fmt=json:log_path={log}",
            '-f', 'null', '-'], check=True)
        v = json.load(open(log))['pooled_metrics']['neg']['mean']
        return total, v
for clip, frames, budget in [('bbb', 300, 0.95e6), ('town', 250, 0.33e6)]:
    for chunks in [1, 3, 8]:
        pts = [(crf, *run(clip, frames, chunks, crf)) for crf in (56, 61)]
        (c1, b1, v1), (c2, b2, v2) = pts
        t = (math.log(budget) - math.log(b1)) / (math.log(b2) - math.log(b1))
        print(f'{clip} {chunks} chunks: crf56 {b1/1e3:.0f}k {v1:.1f}, crf61 {b2/1e3:.0f}k {v2:.1f} -> at {budget/1e6} MB: crf {c1 + t*(c2-c1):.1f}, VMAF NEG {v1 + t*(v2-v1):.1f}', flush=True)
