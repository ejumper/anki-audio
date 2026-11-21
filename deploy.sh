#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"

rsync -a --delete --exclude .git ./ ejumps@100.93.215.27:/opt/anki/app/
ssh ejumps@100.93.215.27 'cd /opt/anki && docker compose up -d --build web'
