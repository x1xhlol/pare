#!/bin/bash
# Builds the test corpus used in RESEARCH.md under $PARE_RESEARCH/corpus (default ~/pare-research).
#
# Four 1080p50 Xiph sequences, 250 frames each, re-encoded the way a phone would store them (H.264 at 25 Mbps,
# no B-frames) so the test starts from the same kind of file people compress. ref/*.y4m are the decoded sources
# every encode is scored against. mix.mp4 joins the four into one 20-second clip with audio. bbb.mp4 (Big Buck
# Bunny, 30 s at 1080p30) and screen.mp4 (a scrolling screen recording) were added by hand; any clips work.
set -euo pipefail
root=${PARE_RESEARCH:-$HOME/pare-research}
ffmpeg=${FFMPEG:-ffmpeg}
mkdir -p "$root/corpus/ref" && cd "$root/corpus"

for f in old_town_cross park_joy in_to_tree ducks_take_off; do
  # The first 250 frames: a 4:2:0 1080p frame is 3,110,400 bytes plus a 6-byte header.
  curl -sS -r 0-$((250 * 3110406 + 200)) -o "${f}_1080p50.y4m" "https://media.xiph.org/video/derf/y4m/${f}_1080p50.y4m"
  short=${f%%_*}
  [ "$short" = old ] && short=town
  [ "$short" = in ] && short=tree
  "$ffmpeg" -hide_banner -loglevel error -y -i "${f}_1080p50.y4m" -frames:v 250 -c:v libx264 -preset superfast \
    -bf 0 -g 50 -b:v 25M -maxrate 30M -bufsize 30M -pix_fmt yuv420p "$short.mp4"
  "$ffmpeg" -hide_banner -loglevel error -y -i "$short.mp4" -pix_fmt yuv420p -strict -1 "ref/$short.y4m"
done

"$ffmpeg" -hide_banner -loglevel error -y -i ref/town.y4m -i ref/park.y4m -i ref/tree.y4m -i ref/ducks.y4m \
  -f lavfi -i "sine=frequency=440:duration=20" -filter_complex "[0:v][1:v][2:v][3:v]concat=n=4:v=1[v]" \
  -map "[v]" -map 4:a -c:v libx264 -preset superfast -bf 0 -g 50 -b:v 25M -maxrate 30M -bufsize 30M \
  -c:a aac -b:a 128k -shortest mix.mp4
ls -la
