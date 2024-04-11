# https://tech.davis-hansson.com/p/make/
SHELL := bash
.ONESHELL:
.SHELLFLAGS := -eu -o pipefail -c
.DELETE_ON_ERROR:
MAKEFLAGS += --warn-undefined-variables
MAKEFLAGS += --no-builtin-rules

TERSER := npx terser
TERSER_FLAGS := --compress ecma=2020

README_EATER_BOOKMARKLET_PLACEHOLDER := javascript: alert("eater-gmaps bookmarklet placeholder");

build: bookmarklet-eater.js readme.md csv-to-gmaps-paste-snippet.mjs
.PHONY: build

node_modules:
	npm install

clean:
	rm -f bookmarklet.js readme.md csv-to-gmaps-paste-snippet.mjs
	rm -rf build/
.PHONY: clean

build/gmaps-add.min.js:
	mkdir -p build/

	$(TERSER) \
		gmaps-add.js \
		$(TERSER_FLAGS) \
		-o $@ \
	| sed 's/`/\\`/g' \
	| sed 's/\$$/\\$$/g'

build/make-gmaps-paste-snippet-with-preamble.js: make-gmaps-paste-snippet.js build/gmaps-add.min.js
	cat > $@ \
		<(echo 'function preamble() {') \
		<(echo '  return `') \
		<(cat build/gmaps-add.min.js \
				| sed 's/`/\\`/g' \
				| sed 's/\$$/\\$$/g') \
		<(echo '`;') \
		<(echo '}') \
		<(tail -n +6 make-gmaps-paste-snippet.js)

bookmarklet-eater.js: node_modules from-eater.js build/make-gmaps-paste-snippet-with-preamble.js
	$(TERSER) \
		build/make-gmaps-paste-snippet-with-preamble.js \
		from-eater.js \
		$(TERSER_FLAGS) \
		-o build/from-eater.min.js

	cat > $@ \
		<(echo -n 'javascript:') \
		<(cat build/from-eater.min.js)

readme.md: bookmarklet-eater.js readme.tmpl.md
	echo -n "   " > build/bookmarklet-eater-padded.js
	cat bookmarklet-eater.js >> build/bookmarklet-eater-padded.js

	echo "<!-- DO NOT MODIFY THIS FILE DIRECTLY -->" > build/$@
	echo "<!-- instead modify readme.tmpl.md and run \`make readme.md\` -->" >> build/$@
	echo >> build/$@

	sed \
		-e '/$(README_EATER_BOOKMARKLET_PLACEHOLDER)/ r build/bookmarklet-eater-padded.js' \
		-e '/$(README_EATER_BOOKMARKLET_PLACEHOLDER)/ d' \
		readme.tmpl.md \
		>> build/$@

	mv build/$@ $@

data/michelin.csv:
	mkdir -p data/

	curl \
		'https://raw.githubusercontent.com/ngshiheng/michelin-my-maps/main/data/michelin_my_maps.csv' \
		> $@

csv-to-gmaps-paste-snippet.mjs: node_modules csv-to-gmaps-paste-snippet.partial.mjs build/make-gmaps-paste-snippet-with-preamble.js
	cat > $@ \
		<(cat build/make-gmaps-paste-snippet-with-preamble.js) \
		<(cat csv-to-gmaps-paste-snippet.partial.mjs)
