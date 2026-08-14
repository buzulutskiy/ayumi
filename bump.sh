#!/bin/sh
# Поднимает номер версии сразу в двух местах: без этого проверка обновления молчит.
n=$(( $(sed -n 's/.*"Аюми \([0-9]*\)".*/\1/p' version.json) + 1 ))
printf '{ "version": "Аюми %s" }\n' "$n" > version.json
sed -i '' "s/const APP_VERSION='Аюми [0-9]*'/const APP_VERSION='Аюми $n'/" index.html
echo "Аюми $n"
