#!/usr/bin/env bash
# Simulates an AI agent: prints output, then blocks waiting for input
echo "Analyzing codebase..."
sleep 1
echo "Found 3 issues."
printf "> "   # prompt — no newline, cursor stays at end
read -r user_input
echo "User said: $user_input"
echo "Done."
