# https://tech.davis-hansson.com/p/make/
SHELL := bash
.ONESHELL:
.SHELLFLAGS := -eu -o pipefail -c
.DELETE_ON_ERROR:
MAKEFLAGS += --warn-undefined-variables
MAKEFLAGS += --no-builtin-rules

build: readme.md
.PHONY: build

node_modules:
	npm install

clean:
	rm -f readme.md
	rm -rf build/
.PHONY: clean

readme.md: readme.tmpl.md
	temporary_file="$@.tmp"
	{
		echo "<!-- DO NOT MODIFY THIS FILE DIRECTLY -->"
		echo "<!-- instead modify readme.tmpl.md and run \`make readme.md\` -->"
		echo
		cat $<
	} > "$$temporary_file"
	mv "$$temporary_file" $@

data/michelin.csv:
	mkdir -p data/

	curl \
		'https://raw.githubusercontent.com/ngshiheng/michelin-my-maps/main/data/michelin_my_maps.csv' \
		> $@

build/michelin-regional.csv: data/michelin.csv node_modules michelin-to-csv.mjs
	mkdir -p build/
	node michelin-to-csv.mjs \
		-i data/michelin.csv \
		--split-regions \
		-o $@

build/michelin-regional-reversed.csv: build/michelin-regional.csv node_modules tools/michelin-regional-transform.mjs
	mkdir -p build/
	node tools/michelin-regional-transform.mjs \
		-i $< \
		--reverse \
		-o $@

build/michelin-regional--no-china.csv: build/michelin-regional.csv node_modules tools/michelin-regional-transform.mjs
	mkdir -p build/
	node tools/michelin-regional-transform.mjs \
		-i $< \
		--exclude-china \
		-o $@

build/michelin-regional--no-china--reversed.csv: build/michelin-regional--no-china.csv node_modules tools/michelin-regional-transform.mjs
	mkdir -p build/
	node tools/michelin-regional-transform.mjs \
		-i $< \
		--reverse \
		-o $@
