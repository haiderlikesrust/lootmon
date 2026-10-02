#!/bin/sh
set -eu

data_directory="${GAME_DATA_DIR:-/app/.data}"
mkdir -p "$data_directory"
# The kernel owns this lock across Node's lifetime and releases it after a
# crash. Keep the inode in place: never unlink authority.flock during cleanup.
exec flock --exclusive --nonblock --conflict-exit-code 75 --no-fork \
  "$data_directory/authority.flock" \
  node --env-file-if-exists=.env server/index.mjs --authority-lock-held
