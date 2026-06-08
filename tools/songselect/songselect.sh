#!/bin/bash
# SongSelect Lead Sheet Fetcher - Shell Wrapper
# 
# Usage:
#   ./songselect.sh renew           # Update auth cookies (when they expire)
#   ./songselect.sh fetch "Song"    # Fetch a lead sheet
#   ./songselect.sh check           # Check if cookies are still valid

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

case "${1:-}" in
  renew)
    echo "🔑 SongSelect Cookie Renew"
    echo "   A browser will open. Log in to SongSelect."
    echo "   Your auth cookies will be saved automatically."
    echo ""
    cd "$SCRIPT_DIR"
    node renew-cookies.js
    ;;
  check)
    cd "$SCRIPT_DIR"
    node check-cookies.js
    ;;
  fetch)
    shift
    cd "$SCRIPT_DIR"
    
    # Default to headless for non-interactive use
    has_headless=false
    for arg in "$@"; do
      if [ "$arg" = "--headless" ] || [ "$arg" = "--download" ] || [ "$arg" = "-d" ]; then
        has_headless=true
        break
      fi
    done
    
    if ! $has_headless; then
      set -- "$@" --headless
    fi
    
    # Check cookies before fetching
    if [ -f "$SCRIPT_DIR/cookies.json" ]; then
      echo "✅ Cookies found. Fetching..."
    else
      echo "❌ No cookies found. Run: ./songselect.sh renew"
      exit 1
    fi
    
    node fetch-leadsheet.js "$@"
    ;;
  *)
    echo "SongSelect Lead Sheet Fetcher"
    echo ""
    echo "Commands:"
    echo "  ./songselect.sh renew         Update auth cookies"
    echo "  ./songselect.sh check         Verify cookies are valid"
    echo "  ./songselect.sh fetch \"Song\"  Fetch lead sheet"
    echo ""
    echo "Fetch options:"
    echo "  --download DIR    Save PDF to directory"
    echo "  --key KEY         Transpose to key (e.g., E, Ab)"
    echo "  --author NAME     Filter by author"
    echo "  --ccli NUMBER     Search by CCLI number"
    echo "  --orientation P   portrait or landscape"
    echo "  --papersize S     Letter or A4"
    echo ""
    ;;
esac
