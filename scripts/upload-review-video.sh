#!/usr/bin/env bash
set -euo pipefail

project_ref="lghsvxwuaebvotutyjtt"
bucket="social-media"
object_path="3hijlvol/google-oauth-verification-demo-20260803-1445.mp4"
source_file="/tmp/fablepeak-google-oauth-verification-demo.mp4"

api_keys="$(supabase projects api-keys --project-ref "$project_ref" -o json 2>/dev/null)"
service_key="$(jq -r '.[] | select(.name == "service_role" and .type == "legacy") | .api_key' <<<"$api_keys")"

if [[ -z "$service_key" || "$service_key" == "null" ]]; then
  echo "Unable to resolve the Supabase service-role key" >&2
  exit 1
fi

response="$(curl --silent --show-error --fail-with-body \
  --request POST \
  --header "Authorization: Bearer $service_key" \
  --header "apikey: $service_key" \
  --header "Content-Type: video/mp4" \
  --header "x-upsert: false" \
  --data-binary "@$source_file" \
  "https://${project_ref}.supabase.co/storage/v1/object/${bucket}/${object_path}")"

jq -e '.Key or .key' >/dev/null <<<"$response"
echo "https://${project_ref}.supabase.co/storage/v1/object/public/${bucket}/${object_path}"
