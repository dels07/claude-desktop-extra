# Build every patches/*.nim into a same-named executable.
#
# Usage:
#   make -j$(nproc)      # parallel build (default target = all)
#   make clean           # remove binaries and nim caches
#
# Each binary is rebuilt when its .nim source is newer; make drives the
# dep tracking. The orchestrator (scripts/apply_patches.py) runs
# the compiled binaries for each patch.

NIM       ?= nim
NIMFLAGS  ?= c -d:release --opt:speed --mm:orc --hints:off

SRCS := $(wildcard *.nim)
BINS := $(SRCS:.nim=)

.PHONY: all clean
.DEFAULT_GOAL := all

all: $(BINS)

%: %.nim
	@echo "  NIM  $@"
	@$(NIM) $(NIMFLAGS) --nimcache:.nimcache/$* -o:$@ $< > /dev/null

# JS snippets shared between patches. Nim embeds them via staticRead,
# so a change to the .js forces a rebuild of the binary.
fix_computer_use_linux: \
  ../js/cu_linux_executor.js \
  ../js/cu_handler_injection.js \
  ../js/cu_mode_preamble.js \
  ../js/executor_linux.js

fix_cowork_font: ../js/fix_cowork_font.js

fix_epitaxy_autoscroll: ../js/fix_epitaxy_autoscroll.js

# Diff view modes: the main-process half embeds the injected page script AND the
# expand/collapse-all module, both via staticRead, so a change to any of them has
# to rebuild the binary. (This line was missing until 2026-08-01 - JS-only edits
# silently produced a stale binary.)
add_feature_diff_views: \
  ../js/diff_views_main.js \
  ../js/diff_views_page.js \
  ../js/diff_views_expand.js

add_feature_diff_views_bridge: ../js/diff_views_bridge.js

# Panel tabs: the main-process half embeds all four page modules via staticRead,
# so a change to any of them has to rebuild the binary.
add_feature_panel_tabs: \
  ../js/panel_tabs_main.js \
  ../js/panel_tabs_layout.js \
  ../js/panel_tabs_store.js \
  ../js/panel_tabs_harvest.js \
  ../js/panel_tabs_page.js

add_feature_panel_tabs_bridge: ../js/panel_tabs_bridge.js

# Theme patch embeds the spinner-reshape installer (swaps the loading-star SVG
# for the active theme's custom shape) and the bundled community + gaming palette
# collections via staticRead.
add_feature_custom_themes: \
  ../js/spinner_injector.js \
  ../js/community_themes.json \
  ../js/gaming_themes.json

# Theme picker embeds its page + preload via staticRead.
add_feature_theme_picker: ../js/theme_picker_page.html ../js/theme_picker_preload.js

# Extra settings area: main-process half embeds the injected page script and its
# stylesheet; the bridge half embeds the preload snippet.
add_feature_extra_settings: \
  ../js/extra_settings_main.js \
  ../js/extra_settings_page.js \
  ../js/extra_settings_page.css

add_feature_extra_settings_bridge: ../js/extra_settings_bridge.js

# The flag catalog the Extra settings page renders is parsed out of this file's
# .jsonc template at runtime.
add_growthbook_overrides: ../js/growthbook_overrides.js

clean:
	@rm -rf $(BINS) .nimcache
