#!/bin/bash
# Show stats from all veil SQLite databases

set -e

echo "=== Veil Database Stats ==="
echo

# Find all veil databases
find_dbs() {
    find "${1:-.}" -name "context.db" -o -name "memory.db" 2>/dev/null | sort
}

# Project directory
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Check project .veil directory
if [ -d "$PROJECT_DIR/.veil" ]; then
    echo "Project: $PROJECT_DIR/.veil"
    echo "---"

    if [ -f "$PROJECT_DIR/.veil/context.db" ]; then
        echo "context.db:"
        echo "  items:           $(sqlite3 "$PROJECT_DIR/.veil/context.db" "SELECT COUNT(*) FROM items" 2>/dev/null || echo "N/A")"
        echo "  attempts:        $(sqlite3 "$PROJECT_DIR/.veil/context.db" "SELECT COUNT(*) FROM attempts" 2>/dev/null || echo "N/A")"
        echo "  eviction_log:    $(sqlite3 "$PROJECT_DIR/.veil/context.db" "SELECT COUNT(*) FROM eviction_log" 2>/dev/null || echo "N/A")"
        echo "  hydration_events: $(sqlite3 "$PROJECT_DIR/.veil/context.db" "SELECT COUNT(*) FROM hydration_events" 2>/dev/null || echo "N/A")"
        echo

        # Show recent items if any
        ITEM_COUNT=$(sqlite3 "$PROJECT_DIR/.veil/context.db" "SELECT COUNT(*) FROM items" 2>/dev/null || echo "0")
        if [ "$ITEM_COUNT" -gt 0 ]; then
            echo "  Recent items (last 5):"
            sqlite3 -column -header "$PROJECT_DIR/.veil/context.db" \
                "SELECT id, type, substr(content, 1, 50) as content_preview, tokens FROM items ORDER BY createdAt DESC LIMIT 5" 2>/dev/null || true
            echo
        fi
    fi

    if [ -f "$PROJECT_DIR/.veil/memory.db" ]; then
        echo "memory.db:"
        echo "  memory_events:   $(sqlite3 "$PROJECT_DIR/.veil/memory.db" "SELECT COUNT(*) FROM memory_events" 2>/dev/null || echo "N/A")"
        echo "  current_beliefs: $(sqlite3 "$PROJECT_DIR/.veil/memory.db" "SELECT COUNT(*) FROM current_beliefs" 2>/dev/null || echo "N/A")"
        echo "  memory_vectors:  $(sqlite3 "$PROJECT_DIR/.veil/memory.db" "SELECT COUNT(*) FROM memory_vectors" 2>/dev/null || echo "N/A")"
        echo
    fi
fi

# Check home directory .veil
if [ -d "$HOME/.veil" ]; then
    echo "Global: $HOME/.veil"
    echo "---"

    for db in "$HOME/.veil"/*.db; do
        [ -f "$db" ] || continue
        echo "$(basename "$db"):"
        sqlite3 "$db" ".tables" 2>/dev/null | tr ' ' '\n' | grep -v '^$' | while read table; do
            count=$(sqlite3 "$db" "SELECT COUNT(*) FROM \"$table\"" 2>/dev/null || echo "?")
            printf "  %-20s %s\n" "$table:" "$count"
        done
        echo
    done
fi

# Summary
echo "=== Summary ==="
total_items=$(sqlite3 "$PROJECT_DIR/.veil/context.db" "SELECT COUNT(*) FROM items" 2>/dev/null || echo "0")
total_events=$(sqlite3 "$PROJECT_DIR/.veil/memory.db" "SELECT COUNT(*) FROM memory_events" 2>/dev/null || echo "0")
echo "Total context items: $total_items"
echo "Total memory events: $total_events"

if [ "$total_items" -eq 0 ] && [ "$total_events" -eq 0 ]; then
    echo
    echo "No data captured yet. This could mean:"
    echo "  1. No Read/WebSearch/WebFetch tools were used"
    echo "  2. VeilHarness subscription isn't working"
    echo "  3. Running the installed version (not ./veil-test.sh)"
fi
