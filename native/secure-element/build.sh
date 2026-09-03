#!/usr/bin/env bash
# Builds cbdc-se and se_tests into native/secure-element/build without needing
# make or ninja (handy on Windows with only MinGW g++). CI uses CMake instead.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
CC="${CC:-gcc}"
CXX="${CXX:-g++}"
EXE=""
# Static runtime: on Windows a dynamically linked libstdc++ can be shadowed by a
# different libstdc++-6.dll earlier on PATH (Git for Windows ships one), which
# crashes inside iostreams. A self-contained binary also copies anywhere.
LINK="-static-libstdc++ -static-libgcc"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) EXE=".exe"; LINK="-static";; esac

$CC -std=c99 -O2 -Wno-unused-variable -c third_party/tweetnacl/tweetnacl.c -o build/tweetnacl.o
$CXX -std=c++17 -O2 -Wall -Wextra -Ithird_party/tweetnacl -Isrc -c src/se.cpp -o build/se.o
$CXX -std=c++17 -O2 -Wall -Wextra -Isrc -c src/sha256.cpp -o build/sha256.o
$CXX -std=c++17 -O2 -Wall -Wextra -Isrc -c src/json.cpp -o build/json.o
$CXX -std=c++17 -O2 -Wall -Wextra -Isrc src/main.cpp build/se.o build/sha256.o build/json.o build/tweetnacl.o $LINK -o "build/cbdc-se$EXE"
$CXX -std=c++17 -O2 -Wall -Wextra -Isrc tests/se_tests.cpp build/se.o build/sha256.o build/json.o build/tweetnacl.o $LINK -o "build/se_tests$EXE"
echo "built build/cbdc-se$EXE and build/se_tests$EXE"
