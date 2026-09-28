"""Under a tight Fit under size, does AV1 win by enough to choose it without testing? For each corpus clip, x264 with
Pare's settings at a rate factor past Auto's quick start (26 and 28 by default), then SVT-AV1 at preset 8 matched to
the same video size, both scored like research/score.py (VMAF NEG over every frame).

    python3 research/tight_fit.py [clip ...] >> tight_fit.jsonl        # CRFS=26,28 by default

Each line: clip, x264 rate factor, size, VMAF NEG of each encoder, and AV1's lead. Joined with the browser plan's slope
for the same clip, it sets the slope below which Auto can pick AV1 from H.264's first round.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from native_gap import BASE, Clip, WORK, X264, av1_search, run, scored, vbytes  # noqa: E402

CORPUS = os.path.expanduser(os.environ.get('CORPUS', '~/pare-research/corpus'))
CRFS = [float(c) for c in os.environ.get('CRFS', '26,28').split(',')]


def x264_at(clip, crf):
    out = f'{WORK}/{clip.name}-x264pare-crf{crf}.mp4'
    wall, cpu = run(BASE + ['-i', clip.src, '-an'] + X264['x264pare'] + ['-crf', str(crf), out])
    return {'path': out, 'bytes': vbytes(out), 'wall': wall, 'cpu': cpu}


def main():
    clips = sys.argv[1:] or ['bbb', 'town', 'tree', 'park', 'ducks', 'noisy', 'screen', 'mix']
    for name in clips:
        clip = Clip(f'{CORPUS}/{name}.mp4')
        for crf in CRFS:
            avc = scored(clip, x264_at(clip, crf))
            # SVT-AV1's rate factor for a size x264 reaches at `crf`: Pare's own guess, 1.88 x crf - 10.7.
            av1 = scored(clip, av1_search(clip, 8, avc['bytes'], 1.88 * crf - 10.7, f'tight{crf}'))
            print(json.dumps({'clip': name, 'x264_crf': crf, 'bytes': avc['bytes'], 'av1_bytes': av1['bytes'],
                              'av1_crf': av1.get('crf'), 'vmaf_neg': {'x264': avc['vmaf_neg'], 'av1': av1['vmaf_neg']},
                              'p1': {'x264': avc['vmaf_neg_p1'], 'av1': av1['vmaf_neg_p1']},
                              'lead': av1['vmaf_neg'] - avc['vmaf_neg']}), flush=True)


if __name__ == '__main__':
    main()
