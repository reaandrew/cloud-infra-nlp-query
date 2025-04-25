#! /usr/bin/env bash

output_dir="$1"

aws schemas list-schemas --registry-name aws.events | jq -r '.Schemas[] | .SchemaName' | \
	while read -r schema_name
	do
		aws schemas describe-schema --registry-name aws.events --schema-name "$schema_name" | jq '.Content | fromjson' > "$output_dir/$schema_name.json"
	done
