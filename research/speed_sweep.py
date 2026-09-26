"""Looks for x264 settings that are much faster than Pare's at nearly the same quality per byte.

Each configuration is swept over the corpus at CRF 16-24 with the native x264 build (one thread), scored with VMAF
NEG against the source, and compared with Pare's setting by BD-rate. Speed is CPU seconds per encode (user + system,
from /usr/bin/time), which holds up on a busy machine where wall time doesn't. Encodes are deleted once scored; the
metrics join results.jsonl under the same keys as evaluate.py.

    python3 research/speed_sweep.py [config ...]
"""
import json
import os
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

from evaluate import CACHE, CLIPS, REF, X264, _cache, _key, bd_rate, score

CRFS = [16, 20, 24]
PARE = ['--preset', 'faster', '--ref', '3', '--weightp', '2', '--rc-lookahead', '40']
CONFIGS = {
    'pare': PARE,
    'veryfast+opts': ['--preset', 'veryfast', '--ref', '3', '--weightp', '2', '--rc-lookahead', '40'],
    'subme3': [*PARE, '--subme', '3'],
    'subme2': [*PARE, '--subme', '2'],
    'me-dia': [*PARE, '--me', 'dia'],
    'trellis0': [*PARE, '--trellis', '0'],
    'ref2': ['--preset', 'faster', '--weightp', '2', '--rc-lookahead', '40'],
    'la20': ['--preset', 'faster', '--ref', '3', '--weightp', '2'],
    'part-i': [*PARE, '--partitions', 'i8x8,i4x4'],
    'bframes2': [*PARE, '--bframes', '2'],
    'b-adapt0': [*PARE, '--b-adapt', '0'],
    'subme3+part-i': [*PARE, '--subme', '3', '--partitions', 'i8x8,i4x4'],
    # Combinations of the ones that cost almost nothing.
    'dia+part-i': [*PARE, '--me', 'dia', '--partitions', 'i8x8,i4x4'],
    'dia+part-i+ref2': ['--preset', 'faster', '--weightp', '2', '--rc-lookahead', '40', '--me', 'dia',
                        '--partitions', 'i8x8,i4x4'],
}


def encode_and_score(clip, args):
    key = _key(clip, 'asm', [args, None])
    if key in _cache and 'cpu' in _cache[key]:
        return _cache[key]
    ref = f'{REF}/{clip}.y4m'
    with tempfile.TemporaryDirectory(dir='/tmp') as tmp:
        out = f'{tmp}/out.mkv'
        timing = subprocess.run(['/usr/bin/time', '-f', '%U %S', X264['asm'], '--threads', '1', '--quiet', *args,
                                 '-o', out, ref], check=True, capture_output=True, text=True).stderr.split()[-2:]
        size = os.path.getsize(out)
        metrics = score(out, ref, tmp)
    row = {'key': key, 'clip': clip, 'build': 'asm', 'args': args, 'filters': None, 'bytes': size,
           'cpu': float(timing[0]) + float(timing[1]), **metrics}
    with open(CACHE, 'a') as f:
        f.write(json.dumps(row) + '\n')
    _cache[key] = row
    return row


def sweep(args):
    jobs = [(clip, [*args, '--crf', str(crf)]) for clip in CLIPS for crf in CRFS]
    with ThreadPoolExecutor(5) as pool:
        return list(pool.map(lambda j: encode_and_score(*j), jobs))


def main():
    names = sys.argv[1:] or list(CONFIGS)
    base = sweep(CONFIGS['pare'])
    base_cpu = sum(r['cpu'] for r in base)
    by_clip = lambda rows, c: sorted([r for r in rows if r['clip'] == c], key=lambda r: r['bytes'])
    print(f'{"config":16s} {"CPU":>6s}  BD-rate VMAF NEG per clip ({", ".join(CLIPS)}) and mean', flush=True)
    for name in names:
        rows = sweep(CONFIGS[name])
        bd = [bd_rate(by_clip(base, c), by_clip(rows, c), 'vmaf_neg') for c in CLIPS]
        cpu = sum(r['cpu'] for r in rows) / base_cpu
        print(f'{name:16s} {cpu:6.2f}  ' + ' '.join(f'{b:+6.1f}' for b in bd) + f'  | {sum(bd) / len(bd):+6.1f}%',
              flush=True)


if __name__ == '__main__':
    main()
