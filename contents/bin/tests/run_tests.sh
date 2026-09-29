#!/bin/bash

# Runs the HID helper and GVariant parser test suites, and summarizes.
# Usage: ./run_tests.sh [suite.py ...]   (defaults to all suites, including the JS one)

cd "$(dirname "$(readlink -f "$0")")"

if [ "$#" -gt 0 ]; then
    suites=("$@")
else
    suites=(test_read_hid_devices.py)
fi

failed=0
for suite in "${suites[@]}"; do
    if output=$(python3 "$suite" 2>&1); then
        echo "PASS  $suite  |  $(echo "$output" | tail -1)"
    else
        echo "FAIL  $suite"
        echo "$output" | tail -30
        failed=1
    fi
done

# The GVariant parser suite runs under node and lives next to the module.
js_suite="../../ui/GVariant.test.cjs"
if [ "$#" -eq 0 ]; then
    if ! command -v node >/dev/null 2>&1; then
        echo "SKIP  $js_suite  |  node not found"
    elif output=$(node --test --test-reporter=tap "$js_suite" 2>&1); then
        echo "PASS  $js_suite  |  $(echo "$output" | grep -E '^# (pass|tests)' | tr '\n' ' ')"
    else
        echo "FAIL  $js_suite"
        echo "$output" | tail -30
        failed=1
    fi
fi

echo
if [ "$failed" -eq 0 ]; then
    echo "All test suites passed."
else
    echo "One or more test suites failed."
    exit 1
fi
