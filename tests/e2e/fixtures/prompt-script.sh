#!/bin/bash
# Prints a prompt and blocks on read — detectable by prompt pattern + quiescence + wchan
printf "> "
read -r input
echo "Got: $input"
