#!/bin/bash
# Loop: prompt → read → echo → prompt (for dedup reset testing)
while true; do
  printf "> "
  read -r input
  if [ -z "$input" ]; then
    continue
  fi
  echo "Got: $input"
done
