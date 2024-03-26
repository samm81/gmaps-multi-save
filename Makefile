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

build: bookmarklet-eater.js readme.md
.PHONY: build

node_modules:
	npm install

clean:
	rm -f bookmarklet.js
	rm -rf build/
	rm -rf data/
.PHONY: clean

build/gmaps-add.min.js:
	mkdir -p build/

	$(TERSER) \
		gmaps-add.js \
		$(TERSER_FLAGS) \
		-o build/gmaps-add.min.js \
	| sed 's/`/\\`/g' \
	| sed 's/\$$/\\$$/g'

build/make-gmaps-paste-snippet-with-preamble.js: make-gmaps-paste-snippet.js build/gmaps-add.min.js
	cat > build/make-gmaps-paste-snippet-with-preamble.js \
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

	cat > bookmarklet-eater.js \
		<(echo -n 'javascript:') \
		<(cat build/from-eater.min.js)

readme.md: bookmarklet-eater.js readme.tmpl.md
	echo -n "   " > build/bookmarklet-eater-padded.js
	cat bookmarklet-eater.js >> build/bookmarklet-eater-padded.js

	echo "<!-- DO NOT MODIFY THIS FILE DIRECTLY -->" > build/readme.md
	echo "<!-- instead modify readme.tmpl.md and run \`make readme.md\` -->" >> build/readme.md
	echo >> build/readme.md

	sed \
		-e '/$(README_EATER_BOOKMARKLET_PLACEHOLDER)/ r build/bookmarklet-eater-padded.js' \
		-e '/$(README_EATER_BOOKMARKLET_PLACEHOLDER)/ d' \
		readme.tmpl.md \
		>> build/readme.md

	mv build/readme.md readme.md

data/michelin.csv:
	mkdir -p data/

	curl \
		'https://raw.githubusercontent.com/ngshiheng/michelin-my-maps/main/data/michelin_my_maps.csv' \
		> 'data/michelin.csv'
