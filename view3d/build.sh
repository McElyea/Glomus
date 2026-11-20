#!/usr/bin/env bash
# Builds the 3D view's engine into game/3d/ with Strata's web kit, against a pinned Strata release.
# Needs emsdk 6.0.11 active (source emsdk_env.sh) and STRATA_KIT pointing at the kit's build-kit.sh
# (in the release tarball's kit/, or a Strata checkout's web/kit/). The same inputs build the same
# bytes, so the committed outputs can be rebuilt and diffed.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export KIT_SOURCE="$here/glomus3d.cpp"
export KIT_OUT="$here/../game/3d"
export KIT_NAME=glomus3d
export KIT_EXPORT_NAME=createGlomus3d
export KIT_EXPORTS=_g3_set_ground,_g3_set_water,_g3_set_marks,_g3_set_lines
export KIT_WORK="${KIT_WORK:-$here/.build}"
export STRATA_VERSION=0.9.0
export STRATA_SHA256=c0792999fb9718c37a38d0addf85334cbcd7c50fa0d4cc62f084c3b466969fc9
exec "${STRATA_KIT:?set STRATA_KIT to strata web/kit/build-kit.sh}"
