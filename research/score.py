"""Scores research/benchmark.mjs outputs against their sources with native libvmaf: VMAF NEG (mean, 1st percentile,
worst frame), plain VMAF, SSIM and PSNR-Y over every frame, plus the size reduction and speed.

    node research/benchmark.mjs clip.mp4 ... > runs.jsonl
    python3 research/score.py runs.jsonl > scored.jsonl     # add --table for a Markdown table on stderr
"""
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.environ.get('PARE_RESEARCH', os.path.expanduser('~/pare-research'))
FFMPEG = os.environ.get('FFMPEG', f'{ROOT}/ffmpeg-master-latest-linux64-gpl/bin/ffmpeg')
FFPROBE = os.path.join(os.path.dirname(FFMPEG), 'ffprobe')


def frames_and_duration(path):
    out = subprocess.run([FFPROBE, '-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries',
                          'stream=nb_read_packets:format=duration', '-of', 'json', path], capture_output=True, text=True)
    info = json.loads(out.stdout)
    return int(info['streams'][0]['nb_read_packets']), float(info['format']['duration'])


def score(output, source):
    """Frame-by-frame metrics in display order; the output is scaled to the source's size if it was resized."""
    with tempfile.NamedTemporaryFile(suffix='.json') as log:
        graph = ("[1:v]settb=1,setpts=N,format=yuv420p[r];[0:v]settb=1,setpts=N,format=yuv420p[d0];"
                 "[d0][r]scale2ref=flags=bicubic[d][r2];"
                 "[d][r2]libvmaf=model='version=vmaf_v0.6.1neg\\:name=neg|version=vmaf_v0.6.1\\:name=vmaf'"
                 f":feature='name=psnr|name=float_ssim':n_threads={os.cpu_count()}:log_fmt=json:log_path={log.name}")
        subprocess.run([FFMPEG, '-loglevel', 'error', '-i', output, '-i', source, '-lavfi', graph, '-f', 'null', '-'],
                       check=True)
        data = json.load(open(log.name))
    neg = sorted(f['metrics']['neg'] for f in data['frames'])
    pooled = data['pooled_metrics']
    return {
        'frames': len(neg),
        'vmaf_neg': pooled['neg']['mean'],
        'vmaf_neg_p1': neg[max(0, int(len(neg) * 0.01) - 1)],
        'vmaf_neg_min': neg[0],
        'vmaf': pooled['vmaf']['mean'],
        'ssim': pooled['float_ssim']['mean'],
        'psnr_y': pooled['psnr_y']['mean'],
    }


def main():
    rows = []
    for line in open(sys.argv[1]):
        if not line.startswith('{'):
            continue
        run = json.loads(line)
        frames, duration = frames_and_duration(run['source'])
        row = {**run, **score(run['output'], run['source']), 'duration': duration,
               'reduction': 1 - run['bytes'] / run['original'], 'realtime': duration / run['seconds']}
        row.pop('log', None)
        rows.append(row)
        print(json.dumps(row), flush=True)
    if '--table' in sys.argv:
        print('| Video | Original | Pare | Time | VMAF NEG (1st pct, worst) | SSIM |', file=sys.stderr)
        print('| --- | --- | --- | --- | --- | --- |', file=sys.stderr)
        for r in rows:
            print(f"| {os.path.basename(r['source'])} | {r['original'] / 1e6:.1f} MB | {r['bytes'] / 1e6:.2f} MB "
                  f"({-100 * r['reduction']:.0f}%) | {r['seconds']:.1f} s ({r['realtime']:.2f}× real time) | "
                  f"{r['vmaf_neg']:.2f} ({r['vmaf_neg_p1']:.1f}, {r['vmaf_neg_min']:.1f}) | {r['ssim']:.4f} |",
                  file=sys.stderr)


if __name__ == '__main__':
    main()
