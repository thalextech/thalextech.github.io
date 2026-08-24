#!/bin/sh

set -e

REPO_ROOT="$(pwd)"

APPS_ROOT="${REPO_ROOT}/apps"
APPS_DEPLOY_DIR="${REPO_ROOT}/apps_deployment"

rm -rf "${APPS_DEPLOY_DIR}"
mkdir -p "${APPS_DEPLOY_DIR}"

cd home
npm install
npm run generate
cp -r .output/public/* ${APPS_DEPLOY_DIR}/
cd -

for app_dir in "${APPS_ROOT}"/*; do
    [ -f "${app_dir}/package.json" ] || continue

    app_name="$(basename "${app_dir}")"
    echo "Building ${app_name}"
    (
        cd "${app_dir}"
        npm ci
        VITE_BASE_PATH="/${app_name}/" npm run build
    )
    cp -r "${app_dir}/dist" "${APPS_DEPLOY_DIR}/${app_name}"
done
