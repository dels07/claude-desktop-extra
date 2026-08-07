#!/bin/bash
#
# Validate all patches against an extracted app.asar.contents directory
#
# This script tests each patch against target files WITHOUT modifying them,
# allowing you to verify patches will work before running a full build.
#
# Usage:
#   ./scripts/validate-patches.sh <app.asar.contents_path>
#   ./scripts/validate-patches.sh                         # Uses current dir
#
# Example workflow:
#   1. Download and extract Claude Desktop
#   2. Extract app.asar: asar extract app.asar app.asar.contents
#   3. Run: ./scripts/validate-patches.sh ./app.asar.contents
#
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PATCHES_DIR="$PROJECT_DIR/patches"

APP_CONTENTS="${1:-.}"

# Check if the directory looks like an app.asar.contents
if [ ! -d "$APP_CONTENTS/.vite" ]; then
    echo "Error: Invalid app.asar.contents directory"
    echo "Expected to find .vite/ directory in: $APP_CONTENTS"
    echo ""
    echo "Usage: $0 <path_to_app.asar.contents>"
    echo ""
    echo "Example:"
    echo "  asar extract app.asar app.asar.contents"
    echo "  $0 ./app.asar.contents"
    exit 1
fi

# Compile Nim patches first (required for validation)
echo "Compiling Nim patches..."
"$SCRIPT_DIR/compile-nim-patches.sh"

echo "==================================="
echo "  Patch Validation Report"
echo "==================================="
echo "App contents: $APP_CONTENTS"
echo ""

TOTAL=0
PASSED=0
FAILED=0
SKIPPED=0

# Patch sources live one level down, in the category subdirs (linux/, core/,
# community/). The */ glob picks up any category without needing edits here.
for patch_file in "$PATCHES_DIR"/*/*.nim "$PATCHES_DIR"/*/*.js; do
    [ -f "$patch_file" ] || continue

    TOTAL=$((TOTAL + 1))
    filename=$(basename "$patch_file")
    # Compiled binary sits next to its source, so derive it from the full path -
    # basename alone would drop the category subdir.
    nim_bin="${patch_file%.nim}"

    # Extract metadata
    target=$(grep -m1 '@patch-target:' "$patch_file" 2>/dev/null | sed 's/.*@patch-target:[[:space:]]*//' | tr -d '\r' || echo "")
    patch_type=$(grep -m1 '@patch-type:' "$patch_file" 2>/dev/null | sed 's/.*@patch-type:[[:space:]]*//' | tr -d '\r' || echo "")

    if [ -z "$target" ]; then
        echo "[$filename]"
        echo "  Status: SKIP (no @patch-target metadata)"
        SKIPPED=$((SKIPPED + 1))
        echo ""
        continue
    fi

    echo "[$filename]"
    echo "  Target: $target"
    echo "  Type: $patch_type"

    # Resolve the target path (handle glob patterns)
    if [[ "$target" == *"*"* ]]; then
        dir_part=$(dirname "$target")
        file_pattern=$(basename "$target")
        search_dir="$APP_CONTENTS/${dir_part#app.asar.contents/}"
        actual_target=$(find "$search_dir" -name "$file_pattern" 2>/dev/null | head -1)
    else
        actual_target="$APP_CONTENTS/${target#app.asar.contents/}"
    fi

    # For replace patches, target doesn't need to exist
    if [ "$patch_type" = "replace" ]; then
        echo "  Resolved: (will be created)"
        echo "  Status: PASS (file replacement)"
        PASSED=$((PASSED + 1))
        echo ""
        continue
    fi

    if [ "$patch_type" = "nim-dir" ]; then
        if [ -z "$actual_target" ] || [ ! -d "$actual_target" ]; then
            echo "  Status: FAIL (target directory not found)"
            FAILED=$((FAILED + 1))
            echo ""
            continue
        fi
    elif [ -z "$actual_target" ] || [ ! -f "$actual_target" ]; then
        echo "  Status: FAIL (target file not found)"
        FAILED=$((FAILED + 1))
        echo ""
        continue
    fi

    echo "  Resolved: $actual_target"

    # For Nim patches, run the compiled binary on a copy
    if [ "$patch_type" = "nim" ]; then
        if [ ! -x "$nim_bin" ]; then
            echo "  Status: FAIL (compiled binary not found: $nim_bin)"
            FAILED=$((FAILED + 1))
            echo ""
            continue
        fi

        tmp_file=$(mktemp)
        # Code-split bundles (v1.19367.0+): stage the stub + all content-hashed
        # sibling chunks as one concatenation, mirroring apply_patches.py, so
        # patch match counts see the whole logical bundle.
        target_dir=$(dirname "$actual_target")
        target_base=$(basename "$actual_target")
        target_stem="${target_base%.js}"
        if compgen -G "$target_dir/$target_stem.chunk-*.js" > /dev/null; then
            cat "$actual_target" > "$tmp_file"
            for chunk in "$target_dir/$target_stem".chunk-*.js; do
                printf '\n/*__CDB_SPLIT__%s__*/\n' "$(basename "$chunk")" >> "$tmp_file"
                cat "$chunk" >> "$tmp_file"
            done
        else
            cp "$actual_target" "$tmp_file"
        fi

        output=$("$nim_bin" "$tmp_file" 2>&1)
        result=$?
        echo "$output" | sed 's/^/  /'
        if [ $result -eq 0 ]; then
            echo "  Status: PASS"
            PASSED=$((PASSED + 1))
        else
            echo "  Status: FAIL"
            FAILED=$((FAILED + 1))
        fi

        rm -f "$tmp_file"
    elif [ "$patch_type" = "nim-dir" ]; then
        # nim-dir patches take a directory argument and locate their
        # content-hashed target file inside it (e.g. ion-dist SPA bundles)
        if [ ! -x "$nim_bin" ]; then
            echo "  Status: FAIL (compiled binary not found: $nim_bin)"
            FAILED=$((FAILED + 1))
            echo ""
            continue
        fi

        tmp_dir=$(mktemp -d)
        cp -r "$actual_target"/. "$tmp_dir"/

        output=$("$nim_bin" "$tmp_dir" 2>&1) && result=0 || result=$?
        echo "$output" | sed 's/^/  /'
        if [ $result -eq 0 ]; then
            echo "  Status: PASS"
            PASSED=$((PASSED + 1))
        else
            echo "  Status: FAIL"
            FAILED=$((FAILED + 1))
        fi

        rm -rf "$tmp_dir"
    else
        echo "  Status: SKIP (unknown type: $patch_type)"
        SKIPPED=$((SKIPPED + 1))
    fi

    echo ""
done

# The "Extra" settings area is injected into the REMOTE claude.ai Settings modal,
# so applying cleanly says nothing about it rendering correctly. The DOM suite
# runs its page half against fixtures in headless Chromium. Skipped rather than
# failed where no browser is installed - it needs no npm package, only a chrome.
echo "-----------------------------------"
echo "Extra settings DOM suite (headless Chromium)"
if command -v node >/dev/null 2>&1 && {
        command -v chromium >/dev/null 2>&1 ||
        command -v chromium-browser >/dev/null 2>&1 ||
        command -v google-chrome-stable >/dev/null 2>&1 ||
        command -v google-chrome >/dev/null 2>&1; }; then
    TOTAL=$((TOTAL + 1))
    # The NODE exit status decides, never the pipeline's: `node ... | sed`
    # reports sed's status, which is always 0.
    ES_LOG="$(mktemp)"
    if node "$(dirname "$0")/test-extra-settings-dom.mjs" >"$ES_LOG" 2>&1; then
        ES_RC=0
    else
        ES_RC=$?
    fi
    sed 's/^/  /' "$ES_LOG"
    rm -f "$ES_LOG"
    if [ "$ES_RC" -eq 0 ]; then
        echo "  Status: PASS"
        PASSED=$((PASSED + 1))
    else
        echo "  Status: FAIL"
        FAILED=$((FAILED + 1))
    fi
else
    echo "  Status: SKIP (no node and/or chromium on this machine)"
    SKIPPED=$((SKIPPED + 1))
fi
echo ""

# The expand/collapse-all button drives REMOTE epitaxy markup, so applying
# cleanly says nothing about it landing in the right place or respecting
# upstream's aria-expanded contract. Same headless-Chromium approach, no npm.
echo "-----------------------------------"
echo "Diff views expand/collapse-all DOM suite (headless Chromium)"
if command -v node >/dev/null 2>&1 && {
        command -v chromium >/dev/null 2>&1 ||
        command -v chromium-browser >/dev/null 2>&1 ||
        command -v google-chrome-stable >/dev/null 2>&1 ||
        command -v google-chrome >/dev/null 2>&1; }; then
    TOTAL=$((TOTAL + 1))
    # The NODE exit status decides, never the pipeline's. `node ... | sed` reports
    # sed's status, which is always 0, so this block used to print PASS even when
    # every assertion in the suite failed. Capture, print indented, then test the
    # SAVED status.
    DV_LOG="$(mktemp)"
    if node "$(dirname "$0")/test-diff-views-expand-dom.mjs" >"$DV_LOG" 2>&1; then
        DV_RC=0
    else
        DV_RC=$?
    fi
    sed 's/^/  /' "$DV_LOG"
    rm -f "$DV_LOG"
    if [ "$DV_RC" -eq 0 ]; then
        echo "  Status: PASS"
        PASSED=$((PASSED + 1))
    else
        echo "  Status: FAIL"
        FAILED=$((FAILED + 1))
    fi
else
    echo "  Status: SKIP (no node and/or chromium on this machine)"
    SKIPPED=$((SKIPPED + 1))
fi
echo ""

# A clean patch run says nothing about the panel tabs feature's LIVE behaviour:
# whether the layout math is right, whether the page half mounts/removes its bar
# from remote epitaxy DOM, or whether the main-process pref/IPC handlers behave.
# These suites run the real modules (layout unit tests, page DOM tests in
# headless Chromium, main-process pref/IPC tests with electron shimmed). Each
# one exits 3 to say "a tool I need is not installed" - that is a SKIP, not a
# FAIL.
echo "-----------------------------------"
echo "Panel tabs suites (node; DOM suite needs headless Chromium)"
if command -v node >/dev/null 2>&1; then
    for suite in test-panel-tabs-layout.mjs test-panel-tabs-dom.mjs test-panel-tabs-main.mjs; do
        TOTAL=$((TOTAL + 1))
        echo "  [$suite]"
        pt_out=$(node "$SCRIPT_DIR/$suite" 2>&1) && pt_rc=0 || pt_rc=$?
        echo "$pt_out" | sed 's/^/    /'
        case $pt_rc in
            0)
                echo "    Status: PASS"
                PASSED=$((PASSED + 1))
                ;;
            3)
                echo "    Status: SKIP (the suite reported a missing tool)"
                SKIPPED=$((SKIPPED + 1))
                ;;
            *)
                echo "    Status: FAIL"
                FAILED=$((FAILED + 1))
                ;;
        esac
    done
else
    echo "  Status: SKIP (no node on this machine)"
    TOTAL=$((TOTAL + 1))
    SKIPPED=$((SKIPPED + 1))
fi
echo ""

# A clean patch run says nothing about the theme engine's LIVE behaviour: whether a theme
# switch re-themes the spinner in every open window (it used to need a restart), whether
# a revert restores Claude's own glyph, or whether the picker groups gaming palettes by
# category, or whether the theme survives the scope upstream re-defines --bg-100 in.
# These suites run the REAL injected engine (electron shimmed) and the real picker page /
# injector / stylesheet in headless Chromium. Each one exits 3 to say "a tool I need is
# not installed" - that is a SKIP, not a FAIL.
# The Deployment panel writes the files the app's 1P/3P bootstrap reads. A green
# patch run proves nothing about WHICH file got written, so this suite runs the
# real handlers (electron shimmed) against a temporary profile.
echo "-----------------------------------"
echo "Deployment mode suite (node)"
if command -v node >/dev/null 2>&1; then
    TOTAL=$((TOTAL + 1))
    deploy_out=$(node "$SCRIPT_DIR/test-deployment-main.mjs" 2>&1) && deploy_rc=0 || deploy_rc=$?
    echo "$deploy_out" | sed 's/^/  /'
    case $deploy_rc in
        0)
            echo "  Status: PASS"
            PASSED=$((PASSED + 1))
            ;;
        3)
            echo "  Status: SKIP (the suite reported a missing tool)"
            SKIPPED=$((SKIPPED + 1))
            ;;
        *)
            echo "  Status: FAIL"
            FAILED=$((FAILED + 1))
            ;;
    esac
else
    echo "  Status: SKIP (no node on this machine)"
    TOTAL=$((TOTAL + 1))
    SKIPPED=$((SKIPPED + 1))
fi
echo ""

echo "-----------------------------------"
echo "Theme engine suites (node + headless Chromium)"
if command -v node >/dev/null 2>&1; then
    for suite in test-spinner-main.mjs test-spinner-dom.mjs test-picker-gaming.mjs test-theme-scope.mjs; do
        TOTAL=$((TOTAL + 1))
        echo "  [$suite]"
        suite_out=$(node "$SCRIPT_DIR/$suite" 2>&1) && suite_rc=0 || suite_rc=$?
        echo "$suite_out" | sed 's/^/    /'
        case $suite_rc in
            0)
                echo "    Status: PASS"
                PASSED=$((PASSED + 1))
                ;;
            3)
                echo "    Status: SKIP (the suite reported a missing tool)"
                SKIPPED=$((SKIPPED + 1))
                ;;
            *)
                echo "    Status: FAIL"
                FAILED=$((FAILED + 1))
                ;;
        esac
        echo ""
    done
else
    echo "  Status: SKIP (no node on this machine)"
    TOTAL=$((TOTAL + 4))
    SKIPPED=$((SKIPPED + 4))
    echo ""
fi

echo "==================================="
echo "  Summary"
echo "==================================="
echo "  Total:   $TOTAL"
echo "  Passed:  $PASSED"
echo "  Failed:  $FAILED"
echo "  Skipped: $SKIPPED"
echo "==================================="

if [ $FAILED -gt 0 ]; then
    echo ""
    echo "VALIDATION FAILED - $FAILED patch(es) did not match"
    echo "Please update the patches to match the new file structure."
    exit 1
fi

echo ""
echo "All patches validated successfully!"
exit 0
