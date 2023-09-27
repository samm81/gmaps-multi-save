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

bookmarklet-eater.js: node_modules gmaps-add.js from-eater.js
	mkdir build/

	$(TERSER) $(TERSER_FLAGS) > build/gmaps-add-compressed.js \
		gmaps-add.js \
		| sed 's/`/\\`/g' \
		| sed 's/\$$/\\$$/g'

	# might have to `sed 's/"/&quot;/g'` the `build/helper-compressed.js` in order to be able to put it inside an `<a href="...">` tag
	cat > build/from-eater-raw.js \
		<(echo '(() => {') \
		<(echo '  function preamble() {') \
		<(echo '    return `') \
		<(cat build/gmaps-add-compressed.js \
				| sed 's/`/\\`/g' \
				| sed 's/\$$/\\$$/g') \
		<(echo '`;') \
		<(echo '  }') \
		<(tail -n +6 from-eater.js) \
		<(echo '})();') \

	$(TERSER) $(TERSER_FLAGS) > build/from-eater-compressed.js \
		build/from-eater-raw.js

	cat > bookmarklet-eater.js \
		<(echo -n 'javascript:') \
		<(cat build/from-eater-compressed.js)

	rm -rf build/
