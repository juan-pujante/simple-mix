#!/usr/bin/env bash

# Builds a static libmp3lame into $LAME_PREFIX. Any extra arguments are passed
# straight to LAME's configure, which is how callers supply the per-target
# toolchain settings (e.g. --host, CC=..., CFLAGS=...).

set -eu

cd $(dirname $0)
BASE_DIR=$(pwd)

source common.sh

: ${LAME_PREFIX?}

if [ ! -e $LAME_TARBALL ]
then
	curl -s -L -o $LAME_TARBALL $LAME_TARBALL_URL
fi

BUILD_DIR=$(mktemp -d -p $(pwd) lame.XXXXXXXX)
trap 'rm -rf $BUILD_DIR' EXIT

cd $BUILD_DIR
tar --strip-components=1 -xf $BASE_DIR/$LAME_TARBALL

case "$(uname -s)" in
    MINGW*|MSYS*)
        # Avoid embedding Git for Windows' unquoted path with spaces in
        # Autotools-generated Makefiles and libtool scripts.
        export SHELL=/usr/bin/bash
        export CONFIG_SHELL=/usr/bin/bash
        ;;
esac

./configure \
    --prefix=$LAME_PREFIX \
    --enable-static \
    --disable-shared \
    --disable-frontend \
    --disable-gtktest \
    "$@"

make
make install
