set -e

REPO_ROOT="$(pwd)"

APPS_ROOT="${REPO_ROOT}/apps"
APPS_DEPLOY_DIR="${REPO_ROOT}/apps_deployment"

rm -rf "${APPS_DEPLOY_DIR}"
mkdir -p "${APPS_DEPLOY_DIR}"

for app in $(find "${APPS_ROOT}" -type d -depth 1); do
    cd apps/"$app"
    npm ci
    VITE_BASE_PATH=/$app/ npm run build
    cp -r dist "${APPS_DEPLOY_DIR}/${app}"
    cd -
done
