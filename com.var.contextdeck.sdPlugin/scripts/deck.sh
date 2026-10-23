#!/bin/bash
# ContextDeck CLI (installed to ~/.contextdeck/deck by the plugin; regenerated on every start)
#
#   deck status                          what the deck shows, levels, page, missing secrets
#   deck page next|prev|smart|sub|app|system
#   deck state agent.status=running      set state values (shown on keys / info keys)
#   deck flag recording=true             set context flags (switch layouts)
#   deck mode color                      switch mode of the current layout
#   deck layout <id> | auto              pin a layout / back to automatic
#   deck flash "Render done" [#22C55E] [key]
#   deck press 3                         press key 3 (0-7)
#   deck setup [--force|--update]        auto-configure the app/site in front
#   deck menus [bundleId]                the app's real menu items + shortcuts
#   deck llm | llm use <id>|default | llm test [id]
#   deck secret list                     secrets your layouts use, and which are missing
#   deck secret set NAME                 store a secret in the Keychain (hidden prompt)
#   deck secret rm NAME
#   deck reload

HOME_DIR="${CONTEXTDECK_HOME:-$HOME/.contextdeck}"
PORT="${CONTEXTDECK_PORT:-47811}"
TOKEN="$(cat "$HOME_DIR/token" 2>/dev/null)"

req() { # method path [json] [timeout]
	curl -s -m "${4:-5}" -X "$1" "http://127.0.0.1:$PORT$2" -H "authorization: Bearer $TOKEN" -H "content-type: application/json" ${3:+-d "$3"}
	echo
}
json_str() { local s="${1//\\/\\\\}"; s="${s//\"/\\\"}"; printf '"%s"' "$s"; }
pairs() {
	local out="" kv k v val
	for kv in "$@"; do
		k="${kv%%=*}"; v="${kv#*=}"
		if [[ "$v" =~ ^(true|false|null|-?[0-9]+(\.[0-9]+)?)$ ]]; then val="$v"; else val="$(json_str "$v")"; fi
		out="$out${out:+,}$(json_str "$k"):$val"
	done
	echo "{$out}"
}

case "$1" in
	status) req GET /status ;;
	page) req POST /page "{\"page\":$(json_str "${2:-next}")}" ;;
	state) shift; req POST /state "$(pairs "$@")" ;;
	flag|flags) shift; req POST /flags "$(pairs "$@")" ;;
	mode) req POST /mode "{\"mode\":$(json_str "$2")}" ;;
	layout) if [ "$2" = auto ]; then req POST /layout '{"id":null}'; else req POST /layout "{\"id\":$(json_str "$2")}"; fi ;;
	flash) req POST /flash "{\"text\":$(json_str "$2"),\"color\":$(json_str "${3:-#22C55E}"),\"key\":${4:-7},\"ms\":3000}" ;;
	press) req POST /press "{\"key\":${2:-0}}" ;;
	reload) req POST /reload ;;
	setup)
		f=false; u=false
		[ "$2" = --force ] && f=true
		[ "$2" = --update ] && u=true
		req POST /setup "{\"force\":$f,\"update\":$u}" 300 ;;
	menus) req GET "/menus${2:+?bundleId=$2}" "" 90 ;;
	llm)
		case "$2" in
			use) if [ "$3" = default ]; then req POST /llm/use '{"provider":null}'; else req POST /llm/use "{\"provider\":$(json_str "$3")}"; fi ;;
			test) req POST /llm/test "{\"provider\":$(json_str "${3:-}")}" "" 200 ;;
			*) req GET /llm ;;
		esac ;;
	secret|secrets)
		case "$2" in
			set)
				name="$3"
				if [[ ! "$name" =~ ^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$ ]]; then echo "Secret names are UPPER_SNAKE_CASE, e.g. GITHUB_TOKEN" >&2; exit 1; fi
				read -r -s -p "Value for $name (hidden): " value; echo
				[ -z "$value" ] && { echo "Nothing saved." >&2; exit 1; }
				esc() { local s="${1//\\/\\\\}"; printf '%s' "${s//\"/\\\"}"; }
				# security -i reads from stdin, so the value never shows up in the process list
				printf 'add-generic-password -U -s contextdeck -a "%s" -w "%s"\n' "$name" "$(esc "$value")" | /usr/bin/security -i >/dev/null && echo "Saved $name to the Keychain."
				req POST /secrets/refresh >/dev/null ;;
			rm|delete)
				/usr/bin/security delete-generic-password -s contextdeck -a "$3" >/dev/null 2>&1 && echo "Removed $3." || echo "$3 wasn't stored."
				req POST /secrets/refresh >/dev/null ;;
			*) req GET /secrets ;;
		esac ;;
	*) sed -n '4,19p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
