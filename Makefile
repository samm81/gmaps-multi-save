# https://tech.davis-hansson.com/p/make/
SHELL := bash
.ONESHELL:
.SHELLFLAGS := -eu -o pipefail -c
.DELETE_ON_ERROR:
MAKEFLAGS += --warn-undefined-variables
MAKEFLAGS += --no-builtin-rules

TERSER := npx terser
TERSER_FLAGS := --compress ecma=2020

build: bookmarklet.js
.PHONY: build

node_modules:
	npm install

clean:
	rm -f bookmarklet.js
	rm -rf build/
.PHONY: clean

bookmarklet.js: node_modules bookmarklet-eater-gmaps-save-to-list.js bookmarklet-eater-gmaps-save-to-list-helper.js
	mkdir build/

	$(TERSER) $(TERSER_FLAGS) > build/helper-compressed.js \
		bookmarklet-eater-gmaps-save-to-list-helper.js \
		| sed 's/`/\\`/g' \
		| sed 's/\$$/\\$$/g'

	# might have to `sed 's/"/&quot;/g'` the `build/helper-compressed.js` in order to be able to put it inside an `<a href="...">` tag
	cat > build/raw.js \
		<(echo '(() => {') \
		<(echo '  function preamble() {') \
		<(echo '    return `') \
		<(cat build/helper-compressed.js \
				| sed 's/`/\\`/g' \
				| sed 's/\$$/\\$$/g') \
		<(echo '`;') \
		<(echo '  }') \
		<(tail -n +6 bookmarklet-eater-gmaps-save-to-list.js) \
		<(echo '})();') \

	$(TERSER) $(TERSER_FLAGS) > build/compressed.js \
		build/raw.js

	cat > bookmarklet.js \
		<(echo -n 'javascript: ') \
		<(cat build/compressed.js)

	rm -rf build/
