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

cd apps
for app in $(find . -mindepth 1 -maxdepth 1 -type d); do
    cd "${app}"
    echo "Building ${app}"
    npm ci
    if [ "${app}" = "./backtest" ]; then
        npm run build:data
    fi
    VITE_BASE_PATH=/$app/ npm run build
    cp -r dist "${APPS_DEPLOY_DIR}/${app}"
    cd -
done
