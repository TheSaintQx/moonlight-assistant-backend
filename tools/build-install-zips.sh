#!/bin/sh
# Пересобрать установочные ZIP из папки work/ (те же файлы, что в work/).
# Запуск из корня распакованного архива:
#   sh tools/build-install-zips.sh
# Нужны только sh и zip. Секретов внутри нет.

set -e

cd "$(dirname "$0")/.."

mkdir -p .build/skill .build/vision .build/kb

cp work/skill/index.js .build/skill/
cp work/vision/index.js work/vision/moon-vision-core.js work/vision/VERSION .build/vision/
cp work/kb/index.js work/kb/VERSION .build/kb/

rm -f Moon-Skill-3.4.3-install.zip \
      Moon-Vision-4.1.14-install.zip \
      Moon-Knowledge-0.9.3-OPTIONAL.zip

( cd .build/skill  && zip -q -X ../../Moon-Skill-3.4.3-install.zip index.js )
( cd .build/vision && zip -q -X ../../Moon-Vision-4.1.14-install.zip index.js moon-vision-core.js VERSION )
( cd .build/kb     && zip -q -X ../../Moon-Knowledge-0.9.3-OPTIONAL.zip index.js VERSION )

rm -rf .build

echo "Готово:"
ls -l Moon-*.zip
