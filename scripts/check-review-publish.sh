#!/usr/bin/env bash
set -euo pipefail

project_ref="lghsvxwuaebvotutyjtt"
api_keys="$(supabase projects api-keys --project-ref "$project_ref" -o json 2>/dev/null)"
service_key="$(jq -r '.[] | select(.name == "service_role" and .type == "legacy") | .api_key' <<<"$api_keys")"

auth_headers=(
  --header "Authorization: Bearer $service_key"
  --header "apikey: $service_key"
)

posts="$(curl --silent --show-error --fail-with-body \
  "${auth_headers[@]}" \
  "https://${project_ref}.supabase.co/rest/v1/posts?select=id,status,text,updated_at&order=updated_at.desc&limit=20")"

review_post_id="$(jq -r '[.[] | select(.text == "FablePeak Google OAuth verification demo — reviewer video")][0].id // empty' <<<"$posts")"

if [[ -z "$review_post_id" ]]; then
  echo '{"post":null,"target":null}'
  exit 0
fi

target="$(curl --silent --show-error --fail-with-body \
  "${auth_headers[@]}" \
  "https://${project_ref}.supabase.co/rest/v1/post_targets?select=platform,status,remote_id,remote_url,error,updated_at&post_id=eq.${review_post_id}&platform=eq.youtube")"

jq -n \
  --argjson post "$(jq --arg id "$review_post_id" '[.[] | select(.id == $id)][0]' <<<"$posts")" \
  --argjson target "$(jq '.[0] // null' <<<"$target")" \
  '{post:$post,target:$target}'
